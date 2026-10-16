/**
 * `MetricsSampler` 的确定性仿真（规格 §10 `metricsSampler.test.ts` 那一行）。
 *
 * 全部时间都由**注入时钟**驱动：没有 `await sleep`，也没有真实定时器。
 * 这里用"假数据源 + 真 SQLite（`:memory:`）+ 真仓储 + 真采样器"跑完整链路：
 * 什么时候写库、写几行、缺测算成什么，都是被测代码的真实行为。
 *
 * 覆盖的判据：
 * ① 24h 窗口内每条序列恰好 1440 条 minute 桶；
 * ② 30d 窗口内 720 条 hour 桶（用 3600s tick 跑 30 天，避免几十万次 tick）；
 * ③ **库写次数与 tick 数不成正比**：同样 30 小时，tick 密度提高 6 倍，写事务数完全相同；
 *    并且整点那一 tick 恰好 2 次批量写（分钟 flush + 小时 rollup）；
 * ④ 采集中断 10 分钟 → 该段**没有行**（gap），不是 0；
 * ⑤ 单飞：重入 tick 返回 `skipped`；
 * ⑥ 单 tick 耗时上界（31 条序列的假数据源 < 50ms），且同一分钟内不写库；
 * ⑦ 重启（新建 sampler 复用同一 db）后历史仍在、停机期间的整点能被补上；
 * ⑧ `storage()` 的 §1.1 预算（基准 36 序列/分钟、32MB 上限、不随运行时长增长）。
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { initDatabase, type Db } from '../src/db/database.js';
import { createSilentLogger } from '../src/logger.js';
import { hourStart } from '../src/modules/metrics/buckets.js';
import { MetricsSampler } from '../src/modules/metrics/sampler.js';
import { BackgroundScheduler } from '../src/modules/metrics/scheduler.js';
import { metricByKey, type MetricDefinition, type MetricsServiceRegistrySource } from '../src/modules/metrics/types.js';
import type { SystemSnapshot } from '../src/modules/system/types.js';
import type { ServiceListResponse, ServiceView } from '../src/modules/services/types.js';
import type { ContainerListResult, ContainerSummary } from '../src/modules/docker/types.js';
import { makeContainer, makeContainerList } from './support/serviceFixtures.js';

const logger = createSilentLogger();
const START = hourStart(1_700_000_000); // 固定在整点，便于数整点
const HOUR = 3600;
const DAY = 86_400;

/** 指标定义（目录里必须有；测试里拿不到时直接报错，而不是静默用假对象）。 */
function metric(key: string): MetricDefinition {
  const found = metricByKey(key);
  if (!found) throw new Error(`目录里没有 ${key}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * 假数据源（真实拓扑形状，不碰 Docker / /proc / 网络）
 * ------------------------------------------------------------------ */

interface WorldState {
  /** false = 采集不到任何读数（模拟数据源不可用） */
  collect: boolean;
  cpuPercent: number;
  memoryPercent: number;
  memoryUsedBytes: number;
  diskPercent: number;
  diskUsedBytes: number;
  containerCpu: number;
  containerMemory: number;
}

function buildSnapshot(state: WorldState, disks: number): SystemSnapshot {
  return {
    generatedAt: new Date(0).toISOString(),
    host: {
      hostname: 'nas',
      platform: 'linux',
      kernel: '6.1.0',
      arch: 'x64',
      cpuModel: 'test',
      cpuCores: 4,
      uptimeSec: 1000,
      bootedAt: new Date(0).toISOString(),
      osLabel: 'Linux',
      hostIsLinux: true,
    },
    cpu: { percent: state.collect ? state.cpuPercent : null, perCore: [], loadAvg: [0, 0, 0] },
    memory: {
      usedBytes: state.memoryUsedBytes,
      totalBytes: 17_179_869_184,
      availableBytes: 8_589_934_592,
      percent: state.collect ? state.memoryPercent : null,
      cachedBytes: 0,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
    },
    disks: Array.from({ length: disks }, (_unused, index) => ({
      mount: `${String.fromCharCode(67 + index)}:`,
      label: String.fromCharCode(67 + index),
      fsType: 'ext4',
      usedBytes: state.collect ? state.diskUsedBytes : null,
      totalBytes: 1_000_204_886_016,
      availableBytes: 100_020_488_601,
      percent: state.collect ? state.diskPercent : null,
      error: null,
    })),
    gpu: null,
    sources: {
      cpu: { available: true, mode: 'host-proc', detail: null },
      memory: { available: true, mode: 'host-proc', detail: null },
      disk: { available: true, mode: 'statfs', detail: null },
      gpu: { available: false, mode: 'none', detail: null },
    },
  };
}

/** 容器夹具：所有容器都带 stats（"取不到统计"由数据源不可用分支覆盖）。 */
function containerItems(state: WorldState, count: number): ContainerSummary[] {
  return Array.from({ length: count }, (_unused, index) =>
    makeContainer({
      id: `c-${index}-aaaaaaaaaaaa`,
      name: `svc-${index}`,
      composeProject: 'homeport',
      composeService: `svc-${index}`,
      stats: state.collect
        ? {
            cpuPercent: state.containerCpu + index,
            memUsedBytes: state.containerMemory + index * 1024,
            memLimitBytes: 1_073_741_824,
            memPercent: null,
            netRxBytes: null,
            netTxBytes: null,
            blockReadBytes: null,
            blockWriteBytes: null,
            pids: null,
            collectedAt: new Date(0).toISOString(),
          }
        : null,
    }),
  );
}

function serviceList(count: number): ServiceListResponse {
  const items = Array.from({ length: count }, (_unused, index) => {
    return {
      id: `svc-${index}`,
      sourceRef: `docker:homeport/svc-${index}`,
      displayName: `服务 ${index}`,
      visibility: 'visible',
    } as unknown as ServiceView;
  });
  return {
    items,
    total: items.length,
    categories: [],
    discovery: {
      dockerAvailable: true,
      serveAvailable: true,
      serveDetail: null,
      discoveredAt: new Date(0).toISOString(),
      notes: [],
    },
    generatedAt: new Date(0).toISOString(),
  };
}

/* ------------------------------------------------------------------ *
 * 写库探针（数"真正执行的事务"，不是 mock 生产代码）
 * ------------------------------------------------------------------ */

interface WriteSpy {
  db: Db;
  totals: () => { insertTx: number; deleteTx: number; otherTx: number };
  reset: () => void;
}

/**
 * 包一层 Proxy 统计写事务。
 *
 * 为什么必须数事务而不仅是 SQL 文本：仓储只 `prepare` 一次然后反复 `run`，
 * 所以"写了几次库"只能用 `run()`/事务的**调用次数**回答。
 * 事务分类按"这次事务里执行了 INSERT 还是 DELETE"判定。
 */
function spyOnWrites(real: Db): WriteSpy {
  let insertTx = 0;
  let deleteTx = 0;
  let otherTx = 0;
  let insertStatements = 0;
  let deleteStatements = 0;

  const raw = real as unknown as Record<string, unknown>;
  const proxy = new Proxy(raw, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql: string) => {
          const statement = (target['prepare'] as (text: string) => Record<string, unknown>).call(real, sql);
          const isInsert = /^\s*insert\s+into\s+metric_buckets/i.test(sql);
          const isDelete = /^\s*delete\s+from\s+metric_buckets/i.test(sql);
          return new Proxy(statement, {
            get(stmtTarget, stmtProperty) {
              if (stmtProperty === 'run') {
                return (...args: unknown[]) => {
                  if (isInsert) insertStatements += 1;
                  if (isDelete) deleteStatements += 1;
                  return (stmtTarget['run'] as (...values: unknown[]) => unknown).apply(stmtTarget, args);
                };
              }
              const value = stmtTarget[String(stmtProperty)];
              return typeof value === 'function'
                ? (value as (...args: unknown[]) => unknown).bind(stmtTarget)
                : value;
            },
          });
        };
      }
      if (property === 'transaction') {
        return (fn: (...args: unknown[]) => unknown) => {
          const tx = (target['transaction'] as (inner: unknown) => (...args: unknown[]) => unknown).call(real, fn);
          return (...args: unknown[]) => {
            const beforeInsert = insertStatements;
            const beforeDelete = deleteStatements;
            const result = tx(...args);
            if (insertStatements > beforeInsert) insertTx += 1;
            else if (deleteStatements > beforeDelete) deleteTx += 1;
            else otherTx += 1;
            return result;
          };
        };
      }
      const value = target[String(property)];
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(real) : value;
    },
  }) as unknown as Db;

  return {
    db: proxy,
    totals: () => ({ insertTx, deleteTx, otherTx }),
    reset: () => {
      insertTx = 0;
      deleteTx = 0;
      otherTx = 0;
    },
  };
}

/* ------------------------------------------------------------------ *
 * 世界（假数据源 + 真 db + 真采样器）
 * ------------------------------------------------------------------ */

function testConfig(overrides: Partial<PortalConfig['metrics']> = {}): PortalConfig {
  const base = loadConfig({ env: 'test', logLevel: 'error' });
  // 嵌套对象整体覆盖（loadConfig 语义），因此这里显式给全字段
  return {
    ...base,
    metrics: {
      sampleIntervalSec: overrides.sampleIntervalSec ?? 30,
      minuteRetentionHours: overrides.minuteRetentionHours ?? 24,
      hourRetentionDays: overrides.hourRetentionDays ?? 30,
      containerLimit: overrides.containerLimit ?? 10,
    },
  };
}

interface World {
  db: Db;
  sampler: MetricsSampler;
  spy: WriteSpy;
  state: WorldState;
  tick: (now: number) => Promise<Awaited<ReturnType<MetricsSampler['tick']>>>;
  run: (from: number, to: number, stepSec: number) => Promise<void>;
  scalar: (sql: string, ...params: Array<string | number>) => number;
  close: () => void;
}

function makeWorld(
  options: {
    sampleIntervalSec?: number;
    containerLimit?: number;
    minuteRetentionHours?: number;
    disks?: number;
    containers?: number;
    services?: number;
    db?: Db;
  } = {},
): World {
  const config = testConfig({
    sampleIntervalSec: options.sampleIntervalSec ?? 30,
    containerLimit: options.containerLimit ?? 10,
    minuteRetentionHours: options.minuteRetentionHours ?? 24,
  });
  const owned = options.db === undefined;
  const rawDb = options.db ?? initDatabase({ file: ':memory:', logger }).db;
  const spy = spyOnWrites(rawDb);
  const state: WorldState = {
    collect: true,
    cpuPercent: 12.5,
    memoryPercent: 40.5,
    memoryUsedBytes: 8_589_934_592,
    diskPercent: 55.5,
    diskUsedBytes: 500_000_000_000,
    containerCpu: 3.5,
    containerMemory: 104_857_600,
  };
  const disks = options.disks ?? 1;
  const containers = options.containers ?? 2;
  const services = options.services ?? 2;
  let clockAt = START;

  const sampler = new MetricsSampler({
    db: spy.db,
    config,
    logger,
    system: { snapshot: async () => buildSnapshot(state, disks) },
    containers: {
      list: async (): Promise<ContainerListResult> =>
        makeContainerList(containerItems(state, containers), state.collect ? {} : { dockerAvailable: false }),
    },
    registry: {
      list: async (): Promise<ServiceListResponse> => serviceList(services),
    } satisfies MetricsServiceRegistrySource,
    health: {
      // 数据源不可用时"不知道" → unknown（不计样本），而不是记 0
      state: (sourceRef: string) =>
        state.collect
          ? { verdict: sourceRef.includes('svc-1') ? ('down' as const) : ('healthy' as const) }
          : { verdict: 'unknown' as const },
    },
    clock: () => clockAt,
    intervalSec: () => config.metrics.sampleIntervalSec,
  });

  const scalar = (sql: string, ...params: Array<string | number>): number => {
    const row = rawDb.prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? -1;
  };

  return {
    db: rawDb,
    sampler,
    spy,
    state,
    tick: (now: number) => {
      clockAt = now;
      return sampler.tick(now);
    },
    run: async (from: number, to: number, stepSec: number) => {
      for (let now = from; now <= to; now += stepSec) {
        clockAt = now;
        await sampler.tick(now);
      }
    },
    scalar,
    close: () => {
      if (owned) rawDb.close();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

describe('MetricsSampler · 一昼夜仿真（30s tick 跑 30 小时）', () => {
  it('24h 窗口内每条序列恰好 1440 条 minute 桶，且缺口为 0', async () => {
    const world = makeWorld({ sampleIntervalSec: 30, disks: 1, containers: 2, services: 2 });
    try {
      // 序列数 = host 3 + 磁盘 2×1 + 容器 2×2 + 服务 1×2 = 11
      await world.run(START, START + 30 * HOUR, 30);

      expect(world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'minute'")).toBe(
        11 * 1440,
      );
      expect(
        world.scalar(
          "SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'minute' AND metric = 'host.cpu.percent' AND target = 'host'",
        ),
      ).toBe(1440);
      // 30 小时里已结束的整点 = 30 个 → 每小时 11 条 hour 行
      expect(world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'hour'")).toBe(11 * 30);

      const view = world.sampler.history({
        metric: metric('host.cpu.percent'),
        target: 'host',
        targetLabel: '宿主',
        range: '24h',
      });
      expect(view.points).toHaveLength(1440);
      expect(view.gaps).toEqual({ missingBuckets: 0, partialBuckets: 0 });
      expect(view.summary.count).toBe(1440);
      expect(view.points[0]?.samples).toBe(2); // 30s 采样 → 每分钟 2 个样本
      expect(view.points[0]?.expected).toBe(2);
      expect(view.points[0]?.partial).toBe(false);
      expect(view.summary.min).toBe(12.5);
      expect(view.summary.max).toBe(12.5);
      expect(view.summary.avg).toBe(12.5);
    } finally {
      world.close();
    }
  });

  it('库写次数与 tick 数不成正比：tick 密度提高 6 倍，写事务数完全相同', async () => {
    const fast = makeWorld({ sampleIntervalSec: 30 });
    const dense = makeWorld({ sampleIntervalSec: 5 });
    try {
      await fast.run(START, START + 30 * HOUR, 30); // 3601 tick
      await dense.run(START, START + 30 * HOUR, 5); // 21601 tick（6 倍）

      const fastTx = fast.spy.totals();
      const denseTx = dense.spy.totals();
      expect(denseTx).toEqual(fastTx);

      const minutes = (30 * HOUR) / 60; // 1800 个分钟边界
      const hours = 30; // 30 个整点
      // 分钟落库：每个分钟边界 1 次（= 每分钟至多 1 次写事务，与 tick 数无关）
      expect(fastTx.insertTx - hours).toBe(minutes);
      expect((fastTx.insertTx - hours) / minutes).toBe(1);
      // 整点滚动：每个整点 1 次
      expect(fastTx.insertTx - minutes).toBe(hours);
      // 保留清理：启动一次 + 每个整点一次（一次事务含两个分辨率的 DELETE）
      expect(fastTx.deleteTx).toBe(hours + 1);
      expect(fastTx.insertTx + fastTx.deleteTx).toBe(1861);
      // 3601 与 21601 个 tick 的写事务数都是 1861：证明写库次数不随 tick 数增长
      expect(fastTx.insertTx + fastTx.deleteTx).toBe(denseTx.insertTx + denseTx.deleteTx);
      expect(1861).toBeLessThan(3601); // 比 tick 少的写事务（120 tick/小时只写 ~62 次）
      expect(1861).toBeLessThan(21601 / 10); // 6 倍 tick 密度下仍是同一批写事务
    } finally {
      fast.close();
      dense.close();
    }
  });

  it('整点那一 tick 恰好 2 次批量写（分钟 flush + 小时 rollup）', async () => {
    const world = makeWorld({ sampleIntervalSec: 30, services: 1, containers: 1 });
    try {
      const boundary = START + HOUR;
      await world.tick(boundary - 30); // 往上一分钟的累加器里放样本
      world.spy.reset();

      const result = await world.tick(boundary); // 整点 tick

      const totals = world.spy.totals();
      expect(totals.insertTx).toBe(2); // 恰好两次：一次分钟 flush + 一次整点 rollup
      expect(totals.deleteTx).toBe(1); // 整点同时做一次保留清理
      expect(result.bucketsFlushed).toBe(8); // host 3 + 磁盘 2 + 容器 2 + 服务 1
      // 本次 flush 落下了上一分钟，于是"上一个整点"第一次变得可聚合（8 条序列各 1 行）
      expect(result.hoursRolledUp).toBe(8);
      expect(result.pruned).toBe(0); // 没有过期行
    } finally {
      world.close();
    }
  });

  it('采集中断 10 分钟 → 该段没有行（gap），而不是 0', async () => {
    const world = makeWorld({ sampleIntervalSec: 30, services: 1, containers: 1 });
    try {
      // 正常跑 2 分钟（tick 落在 START / +30 / +60 / +90 / +120 的分钟桶里）
      await world.run(START, START + 120, 30);
      const resume = START + 120 + 600;
      const result = await world.tick(resume);

      // 恢复这一 tick 先把上一分钟（START+120）落库：它只有 1 个样本 < expected 2 → partial
      expect(result.bucketsFlushed).toBe(8);
      expect(
        world.scalar(
          "SELECT COUNT(*) AS n FROM metric_buckets WHERE bucket_at = ? AND samples = 1",
          START + 120,
        ),
      ).toBe(8);
      // gaps = 8 个 partial 桶 + 中间 9 个完全没有样本的整分钟
      expect(result.gaps).toBe(8 + 9);

      // 中断区间（不含两端）没有任何行
      expect(
        world.scalar(
          "SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'minute' AND bucket_at > ? AND bucket_at < ?",
          START + 120,
          resume,
        ),
      ).toBe(0);
      // 当前分钟尚未结束 → 还没落库
      expect(
        world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'minute' AND bucket_at = ?", resume),
      ).toBe(0);
      // 恢复后继续写
      await world.tick(resume + 60);
      expect(
        world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'minute' AND bucket_at = ?", resume),
      ).toBe(8);
      // 全库没有任何 value = 0 的行（缺测不会写成 0）
      expect(world.scalar('SELECT COUNT(*) AS n FROM metric_buckets WHERE value = 0')).toBe(0);
    } finally {
      world.close();
    }
  });

  it('30 天整点仿真：30d 窗口内 720 条 hour 桶，缺分钟的整点标 partial', async () => {
    const world = makeWorld({ disks: 1, containers: 2, services: 2 });
    try {
      // 3600s 一 tick 跑 30 天：每小时 1 个样本 → 每个整点都有 minute 行（samples = 1）
      await world.run(START, START + 30 * DAY, HOUR);

      expect(
        world.scalar(
          "SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'hour' AND metric = 'host.cpu.percent' AND target = 'host'",
        ),
      ).toBe(720);
      expect(world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'hour'")).toBe(11 * 720);
      expect(
        world.scalar(
          "SELECT samples AS n FROM metric_buckets WHERE resolution = 'hour' AND metric = 'host.cpu.percent' AND bucket_at = ?",
          START,
        ),
      ).toBe(1);

      const view = world.sampler.history({
        metric: metric('host.cpu.percent'),
        target: 'host',
        targetLabel: '宿主',
        range: '30d',
      });
      expect(view.resolution).toBe('hour');
      expect(view.points).toHaveLength(720);
      expect(view.gaps.missingBuckets).toBe(0);
      expect(view.gaps.partialBuckets).toBe(720); // 每小时只有 1 个分钟样本 < 60
      expect(view.points[0]?.expected).toBe(60);
      expect(view.points[0]?.partial).toBe(true);
    } finally {
      world.close();
    }
  });

  it('单 tick 耗时上界：31 条序列的假数据源下 < 50ms，且同一分钟内不写库', async () => {
    const world = makeWorld({ disks: 3, containers: 8, services: 6, containerLimit: 10 });
    try {
      const first = await world.tick(START);
      expect(first.collected).toBe(31); // host 3 + 磁盘 6 + 容器 16 + 服务 6
      world.spy.reset();

      const startedAt = performance.now();
      const second = await world.tick(START + 30); // 同一分钟内：无 flush、无 rollup、无 prune
      const elapsed = performance.now() - startedAt;

      expect(second.collected).toBe(31);
      expect(second.bucketsFlushed).toBe(0);
      expect(second.hoursRolledUp).toBe(0);
      expect(world.spy.totals()).toEqual({ insertTx: 0, deleteTx: 0, otherTx: 0 });
      expect(elapsed).toBeLessThan(50);
    } finally {
      world.close();
    }
  });

  it('重启（新建 sampler 复用同一 db）后历史仍在，且停机期间的整点能被补上', async () => {
    const world = makeWorld({ sampleIntervalSec: 30 });
    const db = world.db;
    try {
      await world.run(START, START + 2 * HOUR, 30);
      const minuteRows = world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'minute'");
      expect(minuteRows).toBe(11 * 120);

      // 模拟"旧进程没来得及滚动就挂了"：把 hour 行全删掉，minute 行留着
      db.prepare("DELETE FROM metric_buckets WHERE resolution = 'hour'").run();
      expect(world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'hour'")).toBe(0);

      // 两小时后台启（新 sampler，同一 db）：第一次 tick 必须补齐这两个整点
      const restartedAt = START + 4 * HOUR;
      const restarted = new MetricsSampler({
        db,
        config: testConfig({ sampleIntervalSec: 30 }),
        logger,
        system: { snapshot: async () => buildSnapshot(world.state, 1) },
        containers: { list: async () => makeContainerList(containerItems(world.state, 2)) },
        registry: { list: async () => serviceList(2) },
        health: { state: () => ({ verdict: 'healthy' as const }) },
        clock: () => restartedAt,
        intervalSec: () => 30,
      });
      const result = await restarted.tick(restartedAt);

      expect(result.hoursRolledUp).toBe(11 * 2); // 两个整点 × 11 条序列
      expect(world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'hour'")).toBe(11 * 2);
      // minute 行不因重启而减少（保留窗口内），本次 tick 才开始新的累加
      expect(world.scalar("SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = 'minute'")).toBe(minuteRows);

      const view = restarted.history({
        metric: metric('host.cpu.percent'),
        target: 'host',
        targetLabel: '宿主',
        range: '24h',
      });
      expect(view.points).toHaveLength(120); // 重启前那 2 小时的分钟数据仍在
      expect(view.summary.count).toBe(120);
      expect(view.gaps.missingBuckets).toBe(1440 - 120);
    } finally {
      world.close();
    }
  });

  it('storage() 报出 §1.1 的预算，并标明是估算', async () => {
    const world = makeWorld({});
    try {
      const empty = world.sampler.storage();
      expect(empty.budget.basis).toBe('baseline');
      expect(empty.budget.seriesPerMinute).toBe(36); // host 3 + 磁盘 6 + 容器 20 + 服务 7
      expect(empty.budget.minuteRowsPerDay).toBe(51_840);
      expect(empty.budget.hourRowsPerDay).toBe(864);
      expect(empty.budget.minuteSteadyRows).toBe(51_840); // 保留窗口封顶 → 不随运行时长增长
      expect(empty.budget.hourSteadyRows).toBe(25_920);
      expect(empty.budget.bytesPerRow).toBe(200);
      expect(empty.budget.steadyLimitBytes).toBe(32 * 1024 * 1024);
      expect(empty.budget.withinBudget).toBe(true);
      expect(empty.budget.note).toContain('估算');
      expect(empty.rows).toEqual({ minute: 0, hour: 0, total: 0 });
      expect(empty.size.pageCount).toBeGreaterThan(0);
      expect(empty.size.pageSize).toBeGreaterThan(0);
      expect(empty.retention.minuteHours).toBe(24);
      expect(empty.retention.hourDays).toBe(30);
      expect(empty.lastTick).toBeNull();

      await world.run(START, START + 2 * 60, 30); // tick 在 START/+30/+60/+90/+120
      const busy = world.sampler.storage();
      expect(busy.budget.basis).toBe('observed');
      expect(busy.budget.seriesPerMinute).toBe(11);
      // 跨过两个分钟边界各落一次库：2 个整分钟 × 11 条序列 = 22 行 minute
      expect(busy.rows.minute).toBe(22);
      expect(busy.rows.hour).toBe(0);
      // 最新的一行是刚结束的那一分钟（START+60），当前分钟（START+120）还在内存里
      expect(busy.bounds.minute.newestAt).toBe(new Date((START + 60) * 1000).toISOString());
      expect(busy.lastTick?.bucketsFlushed).toBe(11);
    } finally {
      world.close();
    }
  });
});

describe('BackgroundScheduler · 单飞与失败隔离', () => {
  const tickResult = {
    at: new Date(0).toISOString(),
    collected: 0,
    samplesWritten: 0,
    bucketsFlushed: 0,
    hoursRolledUp: 0,
    pruned: 0,
    gaps: 0,
    errors: [],
  };
  const healthResult = { at: new Date(0).toISOString(), evaluated: 0, probed: 0, skippedForConcurrency: 0, failures: 0 };
  const alertResult = { at: new Date(0).toISOString(), evaluated: 0, opened: 0, reopened: 0, resolved: 0, suppressed: 0 };

  it('上一轮未结束时重入返回 skipped（不排队、不并发）', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let metricsCalls = 0;
    const scheduler = new BackgroundScheduler({
      health: { tick: async () => healthResult },
      metrics: {
        tick: async () => {
          metricsCalls += 1;
          await gate;
          return tickResult;
        },
      },
      alerts: { tick: async () => alertResult },
      logger,
    });

    const first = scheduler.tickOnce(1000);
    const second = await scheduler.tickOnce(1001);
    expect(second.skipped).toBe(true);
    expect(second.metrics).toBeNull();
    expect(second.durationMs).toBe(0);

    release();
    const done = await first;
    expect(done.skipped).toBe(false);
    expect(done.metrics).toEqual(tickResult);
    expect(metricsCalls).toBe(1);
    expect(scheduler.lastSummary()).toEqual(done);
  });

  it('任一步抛错只记在 error 里，其余步骤照跑；running 与 stop() 可控', async () => {
    const called: string[] = [];
    const scheduler = new BackgroundScheduler({
      health: {
        tick: async () => {
          called.push('health');
          throw new Error('探测超时');
        },
      },
      metrics: {
        tick: async () => {
          called.push('metrics');
          return tickResult;
        },
      },
      alerts: {
        tick: async () => {
          called.push('alerts');
          return alertResult;
        },
      },
      logger,
      clock: () => 5000,
      intervalMs: () => 60_000,
    });

    const summary = await scheduler.tickOnce();
    expect(called).toEqual(['health', 'metrics', 'alerts']); // 顺序固定，且失败不中断
    expect(summary.health).toBeNull();
    expect(summary.metrics).toEqual(tickResult);
    expect(summary.error).toContain('health: 探测超时');
    expect(summary.at).toBe(new Date(5000 * 1000).toISOString());

    expect(scheduler.running).toBe(false);
    scheduler.start();
    expect(scheduler.running).toBe(true);
    scheduler.stop();
    expect(scheduler.running).toBe(false);
    expect(scheduler.lastSummary()).not.toBeNull();
  });
});