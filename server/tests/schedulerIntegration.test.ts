/**
 * 装配级集成：真正 `buildApp()` 出来的后台单例。
 *
 * 这个文件存在的唯一理由是计划 §5 的几句验收，它们**无法在单模块单测里证明**：
 * 「浏览器关闭后仍采集」「重启 HomePort 后历史保留」「缺测显示间断，不填 0」。
 * 单测里采集器是我自己 `new` 出来的；而这里要证明的是**装配起来的应用**，
 * 在**没有任何前端连接**的情况下确实在采、而且采到的东西跨重启还在。
 *
 * 做法（三条纪律）：
 * 1. 只用 `buildApp()` 造应用，**全程不建立任何 SSE/HTTP 客户端** ——
 *    一次 `inject` / `fetch` 都不发。这就是"浏览器关闭"的等价条件：
 *    如果采集依赖前端连接，下面的行数就会是 0。
 * 2. 时间由 `scheduler.tickOnce(now)` 显式给，**不 sleep、不依赖真实时钟**
 *    （确定性仿真；遍及跨分钟、跨整点的推进）。
 * 3. 只把"外部世界"换掉：`ctx.system.snapshot` 换成假读数。
 *    换法是**改同一个对象上的方法** —— 采样器在装配期捕获的就是 `ctx.system`
 *    这个对象本身，所以改方法对所有持有者生效（与 `servicesApi.test.ts`
 *    换 `ctx.containers` 同理）；路由、鉴权、SQLite、装配流程全是真的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import { minuteStart } from '../src/modules/metrics/buckets.js';
import type { SystemSnapshot } from '../src/modules/system/types.js';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-scheduler-'));

/** 采样间隔 5s（配置下限）：让 minute 桶的 expected = 12，便于构造"部分缺测"。 */
const SAMPLE_INTERVAL_SEC = 5;

function testConfig(dbPath: string): PortalConfig {
  return loadConfig({
    env: 'test',
    logLevel: 'error',
    dataDir: TMP_DIR,
    dbPath,
    trustProxy: true,
    tailscale: { mode: 'off', bin: '', socket: '/nonexistent', apiToken: '', tailnet: '-', timeoutMs: 200 },
    // probeIntervalSec = 0：本文件不测探测，避免任何真实网络请求
    health: { probeIntervalSec: 0, probeConcurrency: 4 },
    metrics: {
      sampleIntervalSec: SAMPLE_INTERVAL_SEC,
      minuteRetentionHours: 24,
      hourRetentionDays: 30,
      containerLimit: 10,
    },
  });
}

/** 假宿主快照：CPU/内存/磁盘都有读数（形状与真实 `SystemSnapshot` 一致）。 */
function fakeSnapshot(): SystemSnapshot {
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
    cpu: { percent: 41.5, perCore: [], loadAvg: [0, 0, 0] },
    memory: {
      usedBytes: 8_589_934_592,
      totalBytes: 17_179_869_184,
      availableBytes: 8_589_934_592,
      percent: 50,
      cachedBytes: 0,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
    },
    disks: [
      {
        mount: '/volume1',
        label: 'volume1',
        fsType: 'ext4',
        usedBytes: 100_020_488_601,
        totalBytes: 1_000_204_886_016,
        availableBytes: 900_184_397_415,
        percent: 10,
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

/** 已经建起来的应用，close 时统一收掉（`close()` 里先 `scheduler.stop()` 再关库）。 */
const opened: AppHandle[] = [];

async function openApp(options: { dbPath: string; backgroundJobs?: boolean }): Promise<AppHandle> {
  const handle = await buildApp({
    config: testConfig(options.dbPath),
    logger: createSilentLogger(),
    backgroundJobs: options.backgroundJobs ?? false,
    serveStatic: false,
    sessionCleanupIntervalMs: 0,
  });
  // 只换外部世界：宿主读数由本用例提供。其余（Docker/tailnet）不可用不影响宿主序列。
  handle.ctx.system.snapshot = async () => fakeSnapshot();
  opened.push(handle);
  return handle;
}

afterEach(async () => {
  while (opened.length > 0) {
    const handle = opened.pop();
    if (handle) await handle.close();
  }
});

/** 某个时间桶里的行数（0 = **这一分钟没有数据**，不是"数据是 0"）。 */
function rowsAt(handle: AppHandle, bucketAt: number): number {
  const row = handle.db
    .prepare('SELECT COUNT(*) AS n FROM metric_buckets WHERE bucket_at = ?')
    .get(bucketAt) as { n: number };
  return row.n;
}

function allRows(handle: AppHandle): number {
  const row = handle.db.prepare('SELECT COUNT(*) AS n FROM metric_buckets').get() as { n: number };
  return row.n;
}

/** 一个稳定的起点：取过去的整分钟，避开"测试刚好跨过分钟边界"。 */
const BASE = minuteStart(Math.floor(Date.now() / 1000)) - 3600;

describe('后台单例 · 装配层（无前端连接也在采）', () => {
  it('backgroundJobs 决定定时器是否启动，close() 之后一定停掉', async () => {
    const off = await openApp({ dbPath: ':memory:' });
    expect(off.scheduler.running, 'backgroundJobs: false 不该启动定时器').toBe(false);

    const on = await openApp({ dbPath: ':memory:', backgroundJobs: true });
    expect(on.scheduler.running).toBe(true);

    await on.close();
    opened.splice(opened.indexOf(on), 1);
    expect(on.scheduler.running, 'close() 必须停掉定时器，否则测试进程被吊住').toBe(false);
  });

  it('不建立任何前端连接，tick 照样把样本写进库', async () => {
    const handle = await openApp({ dbPath: ':memory:' });

    // 第一个 tick 把样本放进 BASE 这一分钟；第二个 tick 跨到下一分钟，于是 BASE 桶"结束"并落库。
    const first = await handle.scheduler.tickOnce(BASE);
    expect(first.skipped).toBe(false);
    expect(first.error, '数据源不可用属于 errors[]，不该让整轮 tick 变成 error').toBeNull();
    expect(first.metrics?.collected ?? 0).toBeGreaterThan(0);
    expect(rowsAt(handle, BASE), '桶还没结束，不该提前落库').toBe(0);

    const second = await handle.scheduler.tickOnce(BASE + 60);
    const flushed = second.metrics?.bucketsFlushed ?? 0;
    expect(flushed, '结束了就必须落库').toBeGreaterThan(0);
    // 落库的行数与"报告的行数"必须一致：报告数字不能是编的
    expect(allRows(handle)).toBe(flushed);
    expect(rowsAt(handle, BASE)).toBeGreaterThan(0);
    // 三步都跑了（顺序是 health → metrics → alerts，任一步失败会是 null）
    expect(second.health).not.toBeNull();
    expect(second.metrics).not.toBeNull();
    expect(second.alerts).not.toBeNull();
  });

  it('缺测的分钟是"没有行"，不是写 0（否则图上会把没数据画成 0%）', async () => {
    const handle = await openApp({ dbPath: ':memory:' });

    // 有数据的分钟 = BASE；完全跳过的分钟 = BASE+60（从没 tick 到它）
    await handle.scheduler.tickOnce(BASE);
    const jumped = await handle.scheduler.tickOnce(BASE + 120);

    expect(rowsAt(handle, BASE), '有样本的分钟必须有行').toBeGreaterThan(0);
    expect(
      rowsAt(handle, BASE + 60),
      '整分钟没有样本时**必须没有行** —— 写 0 会把"没采到"伪装成"CPU 真的是 0%"',
    ).toBe(0);
    expect(
      jumped.metrics?.gaps ?? 0,
      '完全没样本的整分钟要被计成缺口，否则缺测在界面上不可见',
    ).toBeGreaterThan(0);
    // 而且缺的那一分钟里不能有任何一个 0 值行
    const zeroRows = handle.db
      .prepare('SELECT COUNT(*) AS n FROM metric_buckets WHERE bucket_at = ? AND value = 0')
      .get(BASE + 60) as { n: number };
    expect(zeroRows.n).toBe(0);
  });

  it('重启后历史还在（同一个库文件，新进程实例读到旧曲线）', async () => {
    const dbPath = path.join(TMP_DIR, 'restart.sqlite');

    const before = await openApp({ dbPath });
    await before.scheduler.tickOnce(BASE);
    await before.scheduler.tickOnce(BASE + 60);
    const written = allRows(before);
    expect(written).toBeGreaterThan(0);
    await before.close();
    opened.splice(opened.indexOf(before), 1);

    // "重启"：同一个库文件上重新装配一次（迁移已应用 → 不会重跑，也不会清表）
    const after = await openApp({ dbPath });
    expect(allRows(after), '历史必须跨重启保留').toBe(written);
    expect(rowsAt(after, BASE)).toBeGreaterThan(0);

    const versions = after.db
      .prepare('SELECT MAX(version) AS v FROM schema_migrations')
      .get() as { v: number };
    expect(versions.v, '重启不该重跑迁移或回退版本').toBeGreaterThanOrEqual(5);
  });

  it('单飞：上一轮没结束时，下一轮直接报 skipped（不排队、不雪崩）', async () => {
    const handle = await openApp({ dbPath: ':memory:' });

    const inFlight = handle.scheduler.tickOnce(BASE);
    const overlapping = await handle.scheduler.tickOnce(BASE);
    expect(overlapping.skipped, '重叠的那轮必须被跳过').toBe(true);
    expect(overlapping.metrics).toBeNull();

    const first = await inFlight;
    expect(first.skipped).toBe(false);
    // 被跳过的轮次不覆盖"最近一次真正跑过"的摘要
    expect(handle.scheduler.lastSummary()?.skipped).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 告警端到端：只在装配层才成立的因果链
 * ------------------------------------------------------------------ */

/** 把宿主磁盘读数换成指定百分比（其余维度保持有效）。 */
function withDiskPercent(handle: AppHandle, percent: number): void {
  const base = fakeSnapshot();
  handle.ctx.system.snapshot = async () => ({
    ...base,
    disks: base.disks.map((disk) => ({ ...disk, percent })),
  });
}

function countEvents(handle: AppHandle, where = '1 = 1'): number {
  const row = handle.db.prepare(`SELECT COUNT(*) AS n FROM alert_events WHERE ${where}`).get() as { n: number };
  return row.n;
}

/**
 * 为什么要单独写这一组。
 *
 * 告警引擎的 36 条单测可以**全绿**，而生产上一条告警都不触发 —— 因为那 36 条都是
 * "自己把快照传进去"的，而"装配时忘了把快照来源接上"这个错误在模块内部**完全看不出来**：
 * 引擎拿到空快照时的行为是"正确地什么都不做"（`evaluated = 0`），既没有异常也没有日志。
 * 这是"装配缺口"这一类缺陷：每一块都对，缺的是把它们接起来。
 *
 * 所以这组用例走**真实装配**（`buildApp` → `ctx.system` 换成假读数 → `scheduler.tickOnce`），
 * 断言的是**因果链**：读数 → 判定 → 事件落库 → 恢复 → 静默期内重开不新增 → 审计留痕。
 */
const ALERT_T = BASE + 7200;

describe('告警端到端 · 装配漏线时这里会红', () => {
  it('磁盘持续超标 → 触发一条；恢复 → 同一条标记恢复；静默期内再触发 → 重开而不新增', async () => {
    const handle = await openApp({ dbPath: ':memory:' });

    // 内置规则默认关闭（"装了但不吵"），这里显式打开磁盘那条
    const turnedOn = handle.db.prepare("UPDATE alert_rules SET enabled = 1 WHERE kind = 'disk_percent'").run();
    expect(turnedOn.changes, '应当恰好打开一条磁盘规则').toBe(1);

    // ---- 1) 条件成立但 duration 未满：不许触发（"持续超标"是硬条件，不是瞬时超标）
    withDiskPercent(handle, 91);
    const arming = await handle.scheduler.tickOnce(ALERT_T);
    expect(
      arming.alerts?.evaluated ?? 0,
      '引擎必须真的拿到快照并评估到规则 —— 这条断言就是"装配漏接 snapshot"的照妖镜',
    ).toBeGreaterThan(0);
    const early = await handle.scheduler.tickOnce(ALERT_T + 599);
    expect(early.alerts?.opened ?? 0, 'duration 没满不该触发').toBe(0);
    expect(countEvents(handle), '没触发就不该有事件行').toBe(0);

    // ---- 2) 窗口满了：触发恰好一条
    const fired = await handle.scheduler.tickOnce(ALERT_T + 700);
    expect(fired.alerts?.opened, '窗口满了应触发一条').toBe(1);
    expect(countEvents(handle, 'resolved_at IS NULL')).toBe(1);
    const firedRow = handle.db.prepare('SELECT message FROM alert_events').get() as { message: string };
    expect(firedRow.message, '告警文案要说明"持续了多久"，否则人无法判断严重性').toContain('已持续');

    // ---- 3) 持续超标不再重复通知（不变量：同一规则同一目标最多一行未恢复）
    const again = await handle.scheduler.tickOnce(ALERT_T + 800);
    expect(again.alerts?.opened ?? 0, '同一次故障不该再开一条').toBe(0);
    expect(again.alerts?.suppressed ?? 0, '被压掉的次数要可观测，否则"没告警"分不清是没触发还是被压').toBeGreaterThan(0);
    expect(countEvents(handle), '整个故障期只有一行').toBe(1);

    // ---- 4) 恢复：同一条被写 resolved_at，且不新增行
    withDiskPercent(handle, 12);
    const recovered = await handle.scheduler.tickOnce(ALERT_T + 900);
    expect(recovered.alerts?.resolved, '恢复应当被记录').toBe(1);
    expect(countEvents(handle, 'resolved_at IS NULL'), '恢复后不该还有未恢复行').toBe(0);
    expect(countEvents(handle), '恢复不是新增一条事件').toBe(1);

    // ---- 5) 静默期内再次故障：重开同一行（reopen_count++）→ "一小时内不重复刷屏"
    withDiskPercent(handle, 93);
    await handle.scheduler.tickOnce(ALERT_T + 1000); // 条件再次成立 → 重新开始计时
    const reopened = await handle.scheduler.tickOnce(ALERT_T + 1700); // duration 窗口再次满足
    expect(reopened.alerts?.reopened, '静默期内再触发应重开同一行').toBe(1);
    expect(countEvents(handle), '一小时内不重复刷屏：行数仍然是 1').toBe(1);
    const row = handle.db.prepare('SELECT reopen_count, resolved_at FROM alert_events').get() as {
      reopen_count: number;
      resolved_at: string | null;
    };
    expect(row.reopen_count).toBe(1);
    expect(row.resolved_at, '重开后重新变回"未恢复"').toBeNull();

    // ---- 6) 全过程留痕（确认与审计是告警的一部分，不是可选项）
    const actions = (
      handle.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'alert.%' ORDER BY id").all() as Array<{
        action: string;
      }>
    ).map((entry) => entry.action);
    expect(actions).toContain('alert.fired');
    expect(actions).toContain('alert.resolved');
    expect(actions).toContain('alert.reopened');
  });
});