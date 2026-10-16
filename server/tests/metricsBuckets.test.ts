/**
 * 桶聚合与仓储的不变量（规格 §10 `metricsBuckets.test.ts` 那一行）。
 *
 * 这里测的是"历史数据的语义本身"：
 * - 桶内 mean/min/max/samples/expected 的定义；
 * - 同一桶幂等重写（`UNIQUE (resolution, metric, target, bucket_at)`）；
 * - **整分钟没有样本 → 不写行**（缺测不是 0）；
 * - `samples < expected` → partial；
 * - 整点从 minute 行加权聚合（重启后能补、缺 minute 的整点不写行）；
 * - 保留清理按两个分辨率分别生效（边界含等号）。
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { initDatabase, type Db } from '../src/db/database.js';
import { createSilentLogger } from '../src/logger.js';
import {
  HOUR_EXPECTED_MINUTE_ROWS,
  MetricBucketsRepository,
  accumulatorKey,
  accumulatorToRow,
  addSample,
  alignTo,
  expectedSamples,
  hourAggregateToRow,
  hourStart,
  hourValue,
  isPartial,
  minuteStart,
  takeEnded,
  type BucketAccumulator,
  type BucketWriteInput,
} from '../src/modules/metrics/buckets.js';
import { MetricsSampler } from '../src/modules/metrics/sampler.js';
import { collectContainerSamples } from '../src/modules/metrics/collector.js';
import type { SystemSnapshot } from '../src/modules/system/types.js';
import type { MetricsServiceRegistrySource } from '../src/modules/metrics/types.js';
import type { ContainerStatsView, ContainerSummary } from '../src/modules/docker/types.js';
import { makeContainer, makeContainerList } from './support/serviceFixtures.js';

const logger = createSilentLogger();
const START = hourStart(1_700_000_000);
const HOUR = 3600;

function openDb(): Db {
  return initDatabase({ file: ':memory:', logger }).db;
}

function testConfig(overrides: Partial<PortalConfig['metrics']> = {}): PortalConfig {
  const base = loadConfig({ env: 'test', logLevel: 'error' });
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

/** 只含宿主指标的快照（5 条序列：cpu%、内存%、内存字节、磁盘%、磁盘字节）。 */
function hostSnapshot(cpuPercent = 12.5): SystemSnapshot {
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
    cpu: { percent: cpuPercent, perCore: [], loadAvg: [0, 0, 0] },
    memory: {
      usedBytes: 8_589_934_592,
      totalBytes: 17_179_869_184,
      availableBytes: 8_589_934_592,
      percent: 40.5,
      cachedBytes: 0,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
    },
    disks: [
      {
        mount: 'C:',
        label: 'C',
        fsType: 'ext4',
        usedBytes: 500_000_000_000,
        totalBytes: 1_000_204_886_016,
        availableBytes: 100_020_488_601,
        percent: 55.5,
        error: null,
      },
    ],
    gpu: null,
    sources: {
      cpu: { available: true, mode: 'host-proc', detail: null },
      memory: { available: true, mode: 'host-proc', detail: null },
      disk: { available: true, mode: 'statfs', detail: null },
      gpu: { available: false, mode: 'none', detail: null },
    },
  };
}

/**
 * 迷你世界：只有宿主数据源（5 条序列），采样间隔可调。
 *
 * `setFailing(true)` 让数据源**直接抛错**（不是返回 null）——这是"这一分钟
 * 一个样本都拿不到"的真实成因，也避免在测试里造出生产不可能出现的 null 字段。
 */
function makeHostSampler(
  db: Db,
  options: {
    sampleIntervalSec?: number;
    minuteRetentionHours?: number;
    hourRetentionDays?: number;
    containers?: ContainerSummary[];
  } = {},
): { sampler: MetricsSampler; setFailing: (value: boolean) => void } {
  const config = testConfig(options);
  let failing = false;
  const emptyServices = {
    items: [],
    total: 0,
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
  const sampler = new MetricsSampler({
    db,
    config,
    logger,
    system: {
      snapshot: async () => {
        if (failing) throw new Error('宿主 /proc 不可读');
        return hostSnapshot();
      },
    },
    containers: { list: async () => makeContainerList(options.containers ?? []) },
    registry: { list: async () => emptyServices } satisfies MetricsServiceRegistrySource,
    health: { state: () => ({ verdict: 'unknown' as const }) },
    clock: () => START,
    intervalSec: () => config.metrics.sampleIntervalSec,
  });
  return { sampler, setFailing: (value: boolean) => (failing = value) };
}

function sample(metric: string, value: number, target = 'host', unit: 'percent' | 'bytes' | 'ratio' = 'percent') {
  return { metric, target, targetLabel: target === 'host' ? '宿主' : target, unit, value } as const;
}

function countRows(db: Db, resolution?: 'minute' | 'hour'): number {
  const sql =
    resolution === undefined
      ? 'SELECT COUNT(*) AS n FROM metric_buckets'
      : 'SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = ?';
  const row = (resolution === undefined ? db.prepare(sql).get() : db.prepare(sql).get(resolution)) as
    | { n: number }
    | undefined;
  return row?.n ?? -1;
}

/* ------------------------------------------------------------------ *
 * 纯函数
 * ------------------------------------------------------------------ */

describe('桶语义 · 纯函数', () => {
  it('对齐到桶起点、按采样间隔算期望样本数、partial 判定', () => {
    expect(minuteStart(1_700_000_123)).toBe(1_700_000_100);
    expect(minuteStart(1_700_000_100)).toBe(1_700_000_100);
    expect(hourStart(1_700_003_599)).toBe(1_700_002_800); // 472223 × 3600
    expect(alignTo(1_700_003_599, 'minute')).toBe(1_700_003_580);
    expect(alignTo(1_700_003_599, 'hour')).toBe(1_700_002_800);

    expect(expectedSamples(30, 'minute')).toBe(2);
    expect(expectedSamples(60, 'minute')).toBe(1);
    expect(expectedSamples(300, 'minute')).toBe(1); // 比一分钟还长的间隔仍算 1，否则缺测永远看不见
    expect(expectedSamples(30, 'hour')).toBe(HOUR_EXPECTED_MINUTE_ROWS);
    expect(expectedSamples(30, 'hour')).toBe(60);

    expect(isPartial(1, 2)).toBe(true);
    expect(isPartial(2, 2)).toBe(false);
    expect(isPartial(3, 2)).toBe(false);
  });

  it('累加器：sum/count/min/max 与"只取已结束的桶"', () => {
    const pending = new Map<string, BucketAccumulator>();
    addSample(pending, sample('host.cpu.percent', 10), 60_000);
    addSample(pending, sample('host.cpu.percent', 30), 60_000);
    addSample(pending, sample('host.cpu.percent', 20), 60_000);
    addSample(pending, sample('host.disk.percent', 55, 'disk:C'), 60_000);
    addSample(pending, sample('host.cpu.percent', 99), 60_060);
    expect(pending.size).toBe(3);

    const accumulator = pending.get(accumulatorKey(60_000, 'host.cpu.percent', 'host'));
    expect(accumulator).toBeDefined();
    expect({
      sum: accumulator?.sum,
      count: accumulator?.count,
      min: accumulator?.min,
      max: accumulator?.max,
    }).toEqual({ sum: 60, count: 3, min: 10, max: 30 });

    const ended = takeEnded(pending, 60_060);
    expect(ended.map((item) => item.bucketAt)).toEqual([60_000, 60_000]);
    // 桶相同时按 `metric|target` 稳定排序：host.cpu.percent < host.disk.percent
    expect(ended.map((item) => item.metric)).toEqual(['host.cpu.percent', 'host.disk.percent']);
    expect(ended.map((item) => item.target)).toEqual(['host', 'disk:C']);
    expect(pending.size).toBe(1); // 未结束的那一桶留在内存里
  });
});

/* ------------------------------------------------------------------ *
 * 仓储
 * ------------------------------------------------------------------ */

describe('metric_buckets 仓储 · 幂等与约束', () => {
  it('写入后按系列读回：桶内 mean/min/max/samples/expected 逐字段一致', () => {
    const db = openDb();
    try {
      const repo = new MetricBucketsRepository(db);
      const pending = new Map<string, BucketAccumulator>();
      addSample(pending, sample('host.cpu.percent', 10), 60_000);
      addSample(pending, sample('host.cpu.percent', 20), 60_000);
      addSample(pending, sample('host.cpu.percent', 30), 60_000);
      const accumulator = pending.get(accumulatorKey(60_000, 'host.cpu.percent', 'host'));
      expect(accumulator).toBeDefined();

      const row = accumulatorToRow(accumulator!, 'minute', 2, '2026-01-01T00:00:00.000Z');
      expect(row).toMatchObject({
        resolution: 'minute',
        metric: 'host.cpu.percent',
        target: 'host',
        targetLabel: '宿主',
        unit: 'percent',
        bucketAt: 60_000,
        value: 20,
        minValue: 10,
        maxValue: 30,
        samples: 3,
        expected: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      });
      expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(repo.writeBuckets([row])).toBe(1);

      const rows = repo.selectRange('minute', 'host.cpu.percent', 'host', 0, 120_000);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual(row);
      // 其它序列/分辨率读不到（前缀与分辨率都是查询条件的一部分）
      expect(repo.selectRange('hour', 'host.cpu.percent', 'host', 0, 120_000)).toHaveLength(0);
      expect(repo.selectRange('minute', 'host.cpu.percent', 'disk:C', 0, 120_000)).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it('同一桶重复写入是幂等重写（UNIQUE 约束），行数不变、值以最后一次为准', () => {
    const db = openDb();
    try {
      const repo = new MetricBucketsRepository(db);
      const base: BucketWriteInput = {
        id: 'fixed-id-1',
        resolution: 'minute',
        metric: 'host.cpu.percent',
        target: 'host',
        targetLabel: '宿主',
        unit: 'percent',
        bucketAt: 60_000,
        value: 10,
        minValue: 10,
        maxValue: 10,
        samples: 1,
        expected: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      };
      repo.writeBuckets([base]);
      repo.writeBuckets([{ ...base, value: 25, minValue: 10, maxValue: 25, samples: 2 }]);

      expect(countRows(db)).toBe(1);
      const rows = repo.selectRange('minute', 'host.cpu.percent', 'host', 0, 120_000);
      expect(rows[0]?.value).toBe(25);
      expect(rows[0]?.samples).toBe(2);
      expect(rows[0]?.id).toBe('fixed-id-1'); // 原行被更新，id 不变

      // 直接违反 UNIQUE 的裸 INSERT 会被数据库拒绝（约束是不变量，不是调用方自觉）
      expect(() =>
        db
          .prepare(
            `INSERT INTO metric_buckets (id, resolution, metric, target, target_label, unit, bucket_at, value, min_value, max_value, samples, expected, created_at)
             VALUES ('other-id', 'minute', 'host.cpu.percent', 'host', '宿主', 'percent', 60000, 1, 1, 1, 1, 2, '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      ).toThrow(/UNIQUE/i);
    } finally {
      db.close();
    }
  });

  it('整点滚动从 minute 行加权聚合；缺 minute 的整点不写行；重复调用幂等', () => {
    const db = openDb();
    try {
      const repo = new MetricBucketsRepository(db);
      const H = START;
      const mkMinute = (bucketAt: number, value: number, min: number, max: number, samples: number): BucketWriteInput => ({
        id: `m-${bucketAt}-${value}`,
        resolution: 'minute',
        metric: 'host.cpu.percent',
        target: 'host',
        targetLabel: '宿主',
        unit: 'percent',
        bucketAt,
        value,
        minValue: min,
        maxValue: max,
        samples,
        expected: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      });

      // H-3h：两条 minute 行（样本数不同 → 必须按 samples 加权）
      repo.writeBuckets([mkMinute(H - 3 * HOUR, 10, 8, 12, 2), mkMinute(H - 3 * HOUR + 60, 20, 18, 25, 3)]);
      // H-2h：一条 minute 行
      repo.writeBuckets([mkMinute(H - 2 * HOUR, 40, 40, 40, 1)]);
      // H-1h：**没有** minute 行（停机）

      const aggregates = repo.rollupMissingHours(H - 4 * HOUR, H);
      expect(aggregates).toHaveLength(2); // 只有 H-3h 与 H-2h
      expect(aggregates[0]).toMatchObject({
        hourAt: H - 3 * HOUR,
        metric: 'host.cpu.percent',
        target: 'host',
        minuteRows: 2,
        totalSamples: 5,
        weightedSum: 80, // 10×2 + 20×3
        minValue: 8,
        maxValue: 25,
      });
      expect(hourValue(aggregates[0]!)).toBe(16); // 80 / 5，而不是 (10+20)/2 = 15

      const rows = aggregates.map((aggregate) => hourAggregateToRow(aggregate, '2026-01-01T00:00:00.000Z'));
      expect(rows[0]).toMatchObject({
        resolution: 'hour',
        bucketAt: H - 3 * HOUR,
        value: 16,
        minValue: 8,
        maxValue: 25,
        samples: 2,
        expected: 60,
      });
      expect(isPartial(rows[0]!.samples, rows[0]!.expected)).toBe(true); // 60 分钟里只有 2 分钟有数据
      repo.writeBuckets(rows);
      expect(countRows(db, 'hour')).toBe(2);

      // 再滚一次：已存在的整点不再产生行（幂等）
      expect(repo.rollupMissingHours(H - 4 * HOUR, H)).toHaveLength(0);
      // 缺 minute 的整点（H-1h）**没有** hour 行
      expect(repo.selectRange('hour', 'host.cpu.percent', 'host', H - HOUR, H - HOUR)).toHaveLength(0);
      // 若该整点后来有了 minute 行（重启后补采），再滚就能补出来
      repo.writeBuckets([mkMinute(H - HOUR, 30, 30, 30, 1)]);
      expect(repo.rollupMissingHours(H - 4 * HOUR, H)).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 多副本：按服务合并，但记账要诚实
 * ------------------------------------------------------------------ */

function statsContainer(input: {
  id: string;
  name: string;
  project: string | null;
  service: string | null;
  cpu: number;
  mem: number;
}): ContainerSummary {
  const stats: ContainerStatsView = {
    cpuPercent: input.cpu,
    memUsedBytes: input.mem,
    memLimitBytes: 1_073_741_824,
    memPercent: null,
    netRxBytes: null,
    netTxBytes: null,
    blockReadBytes: null,
    blockWriteBytes: null,
    pids: null,
    collectedAt: new Date(0).toISOString(),
  };
  return makeContainer({
    id: input.id,
    name: input.name,
    composeProject: input.project,
    composeService: input.service,
    stats,
  });
}

const WEB_1 = statsContainer({ id: 'c-web-1', name: 'web-1', project: 'shop', service: 'web', cpu: 10, mem: 100 });
const WEB_2 = statsContainer({ id: 'c-web-2', name: 'web-2', project: 'shop', service: 'web', cpu: 20, mem: 200 });
const WEB_3 = statsContainer({ id: 'c-web-3', name: 'web-3', project: 'shop', service: 'web', cpu: 30, mem: 300 });
const GITEA = statsContainer({ id: 'c-gitea', name: 'gitea', project: 'shop', service: 'gitea', cpu: 5, mem: 50 });

describe('多副本合并（一个服务一条序列，但 expected 要按副本数放大）', () => {
  it('同一 compose 服务的副本合并成一个 target：标签确定、与返回顺序无关', () => {
    const cpuOf = (items: ContainerSummary[]): unknown[] =>
      collectContainerSamples(makeContainerList(items), 10)
        .filter((sample) => sample.metric === 'container.cpu.percent')
        .map((sample) => ({
          target: sample.target,
          label: sample.targetLabel,
          value: sample.value,
          replicas: sample.replicaCount,
        }));

    const forward = cpuOf([WEB_1, WEB_2, WEB_3, GITEA]);
    const reversed = cpuOf([GITEA, WEB_3, WEB_2, WEB_1]);

    // 顺序不同 → 结果完全相同（标签不再随 containers.list() 的返回顺序抖动）
    expect(forward).toEqual(reversed);
    expect(forward).toEqual([
      // 单副本也统一用"与 target 同口径"的名字：标签只由 target 决定，
      // 才不会在副本数变化时反复改名（界面上更好的名字从 /api/services 拿 displayName）
      { target: 'container:docker:shop/gitea', label: 'shop/gitea', value: 5, replicas: 1 },
      { target: 'container:docker:shop/web', label: 'shop/web', value: 10, replicas: 3 },
      { target: 'container:docker:shop/web', label: 'shop/web', value: 20, replicas: 3 },
      { target: 'container:docker:shop/web', label: 'shop/web', value: 30, replicas: 3 },
    ]);
    // 三个副本 → 两个 target（不是四个序列）
    expect(new Set(forward.map((item) => (item as { target: string }).target)).size).toBe(2);
  });

  it('expected = 每次 tick 的基准 × 副本数：掉一个副本会被判成 partial', () => {
    const pending = new Map<string, BucketAccumulator>();
    const target = 'container:docker:shop/web';
    for (const sample of collectContainerSamples(makeContainerList([WEB_1, WEB_2]), 10)) {
      if (sample.metric === 'container.cpu.percent') addSample(pending, sample, 60_000);
    }
    // 同一分钟第二次 tick：只剩一个副本（另一个挂了 / 统计没取到）
    for (const sample of collectContainerSamples(makeContainerList([WEB_1]), 10)) {
      if (sample.metric === 'container.cpu.percent') addSample(pending, sample, 60_000);
    }

    const accumulator = pending.get(accumulatorKey(60_000, 'container.cpu.percent', target));
    expect(accumulator).toBeDefined();
    expect(accumulator?.replicas).toBe(2); // 本桶见过的最大副本数
    expect(accumulator?.sum).toBe(40); // 10 + 20 + 10（副本均值语义不变：value = sum/count）
    expect(accumulator?.count).toBe(3);

    const row = accumulatorToRow(accumulator!, 'minute', 2, '2026-01-01T00:00:00.000Z');
    expect(row).toMatchObject({ target, targetLabel: 'shop/web', samples: 3, expected: 4 });
    expect(isPartial(row.samples, row.expected)).toBe(true); // 4 个期望读数只到了 3 个

    // 对照：两个副本都在（2 次 tick × 2 副本 = 4 个读数）→ 完整
    const healthy = new Map<string, BucketAccumulator>();
    for (let tick = 0; tick < 2; tick += 1) {
      for (const sample of collectContainerSamples(makeContainerList([WEB_1, WEB_2]), 10)) {
        if (sample.metric === 'container.cpu.percent') addSample(healthy, sample, 60_000);
      }
    }
    const healthyRow = accumulatorToRow(
      healthy.get(accumulatorKey(60_000, 'container.cpu.percent', target))!,
      'minute',
      2,
      '2026-01-01T00:00:00.000Z',
    );
    expect(healthyRow).toMatchObject({ samples: 4, expected: 4 });
    expect(isPartial(healthyRow.samples, healthyRow.expected)).toBe(false);
  });

  it('整条落库链路（采样器）：一个服务一行，samples/expected 都按副本数', async () => {
    const db = openDb();
    try {
      const { sampler } = makeHostSampler(db, { sampleIntervalSec: 30, containers: [WEB_1, WEB_2] });
      await sampler.tick(START);
      await sampler.tick(START + 30); // 同一分钟：2 次 tick × 2 副本 = 4 个读数
      const result = await sampler.tick(START + 60);

      // host 5 条 + 容器（cpu、内存字节）2 条 = 7 行；3 个副本仍只占 2 行
      expect(result.bucketsFlushed).toBe(7);
      const rows = db
        .prepare(
          "SELECT target, target_label AS targetLabel, samples, expected FROM metric_buckets WHERE metric = 'container.cpu.percent' ORDER BY target",
        )
        .all();
      expect(rows).toEqual([
        { target: 'container:docker:shop/web', targetLabel: 'shop/web', samples: 4, expected: 4 },
      ]);
      const memory = db
        .prepare(
          "SELECT samples, expected FROM metric_buckets WHERE metric = 'container.memory.used_bytes'",
        )
        .get() as { samples: number; expected: number };
      expect(memory).toEqual({ samples: 4, expected: 4 });
    } finally {
      db.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 采样器的落库路径
 * ------------------------------------------------------------------ */

describe('MetricsSampler · 落库与缺测', () => {
  it('同一分钟内的多次 tick 只产生一行（样本累加，不是多行）', async () => {
    const db = openDb();
    try {
      const { sampler } = makeHostSampler(db, { sampleIntervalSec: 30 });
      const first = await sampler.tick(START);
      const second = await sampler.tick(START + 30); // 同一分钟
      expect(first.bucketsFlushed).toBe(0); // 当前分钟不落库
      expect(second.bucketsFlushed).toBe(0);
      expect(countRows(db)).toBe(0);

      const third = await sampler.tick(START + 60); // 跨过分钟边界 → 落上一分钟
      expect(third.bucketsFlushed).toBe(5); // host cpu / 内存% / 内存字节 / 磁盘% / 磁盘字节
      expect(third.samplesWritten).toBe(5 * 2); // 两次 tick 的样本累加在同一行里
      expect(countRows(db)).toBe(5);

      const rows = db
        .prepare("SELECT samples, expected, value FROM metric_buckets WHERE metric = 'host.cpu.percent'")
        .all() as Array<{ samples: number; expected: number; value: number }>;
      expect(rows).toEqual([{ samples: 2, expected: 2, value: 12.5 }]);
    } finally {
      db.close();
    }
  });

  it('整分钟没有任何样本 → 不写行（缺测不是 0），但记入 gaps', async () => {
    const db = openDb();
    try {
      const { sampler, setFailing } = makeHostSampler(db, { sampleIntervalSec: 30 });
      setFailing(true); // 数据源不可用：这一分钟一个样本都拿不到

      const first = await sampler.tick(START);
      expect(first.collected).toBe(0);
      expect(first.errors.join(' ')).toContain('宿主指标采集失败');
      const second = await sampler.tick(START + 60);
      expect(second.collected).toBe(0);
      expect(second.bucketsFlushed).toBe(0);
      expect(second.gaps).toBe(1); // 中间那一个整分钟完全没有样本
      expect(countRows(db)).toBe(0); // 一行都不写
      expect(countRows(db, 'minute')).toBe(0);
    } finally {
      db.close();
    }
  });

  it('samples < expected → 行存在且标 partial（前端能看到缺测）', async () => {
    const db = openDb();
    try {
      const { sampler } = makeHostSampler(db, { sampleIntervalSec: 30 });
      await sampler.tick(START);
      const second = await sampler.tick(START + 60); // 只采到 1 个样本/序列，expected = 2
      expect(second.bucketsFlushed).toBe(5);
      expect(second.gaps).toBe(5); // 5 个 partial 桶，没有整分钟缺口

      const rows = db
        .prepare('SELECT samples, expected FROM metric_buckets ORDER BY metric')
        .all() as Array<{ samples: number; expected: number }>;
      expect(rows).toHaveLength(5);
      for (const row of rows) {
        expect(row.samples).toBe(1);
        expect(row.expected).toBe(2);
        expect(isPartial(row.samples, row.expected)).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it('保留清理按两个分辨率分别生效，边界时刻（含等号）保留', async () => {
    const db = openDb();
    try {
      const { sampler } = makeHostSampler(db, { minuteRetentionHours: 24, hourRetentionDays: 30 });
      const now = START + 100 * HOUR;
      const minuteCutoff = minuteStart(now) - 24 * HOUR;
      const hourCutoff = hourStart(now) - 30 * 24 * HOUR;
      const write = (
        resolution: 'minute' | 'hour',
        bucketAt: number,
      ): void => {
        db.prepare(
          `INSERT INTO metric_buckets (id, resolution, metric, target, target_label, unit, bucket_at, value, min_value, max_value, samples, expected, created_at)
           VALUES (?, ?, 'host.cpu.percent', 'host', '宿主', 'percent', ?, 1, 1, 1, 1, 1, '2026-01-01T00:00:00.000Z')`,
        ).run(`row-${resolution}-${bucketAt}`, resolution, bucketAt);
      };
      write('minute', minuteCutoff); // 边界：保留
      write('minute', minuteCutoff - 60); // 过期：删除
      write('hour', hourCutoff); // 边界：保留
      write('hour', hourCutoff - HOUR); // 过期：删除

      expect(sampler.prune(now)).toBe(2);
      expect(countRows(db, 'minute')).toBe(1);
      expect(countRows(db, 'hour')).toBe(1);
      const remaining = db
        .prepare('SELECT resolution, bucket_at AS bucketAt FROM metric_buckets ORDER BY bucket_at')
        .all() as Array<{ resolution: string; bucketAt: number }>;
      // 只留下两个边界行（按桶时刻升序：hour 的边界更早）
      expect(remaining).toEqual([
        { resolution: 'hour', bucketAt: hourCutoff },
        { resolution: 'minute', bucketAt: minuteCutoff },
      ]);
    } finally {
      db.close();
    }
  });
});