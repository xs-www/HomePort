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
 * 3. 只把"外部世界"换掉：`ctx.system.snapshot` / `ctx.containers.list` /
 *    `ctx.services.list` 三个数据源全换成假夹具（见 `openApp`）。
 *    换法是**改同一个对象上的方法** —— 采样器在装配期捕获的就是 `ctx.system`
 *    这个对象本身，所以改方法对所有持有者生效（与 `servicesApi.test.ts`
 *    换 `ctx.containers` 同理）；路由、鉴权、SQLite、装配流程全是真的。
 *
 * ## 时间也必须是固定常量（这次修的就是这条）
 *
 * 起点曾是 `minuteStart(Date.now() / 1000) - 3600`：于是"跑测试的真实时刻"成了输入。
 * 实测症状：22:59 跑测试时 `BASE + 60` 正好跨过整点，整点滚动凭空多出 5 条 hour 行，
 * 而断言写的是"总行数 === 本轮 flush 的行数"，于是变成 `10 === 5`，必然红。
 * 现在 `BASE` 由固定 `EPOCH` 推出（**选这个值是为了确定性，不是为了回避边界**），
 * 并且每个"本该没有 hour 行"的地方都**显式断言 `hoursRolledUp === 0`**。
 * 跨整点本身是**被测行为**：见文件末尾"22:59:30 → 23:00:30"那条用例。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import { hourStart, minuteStart } from '../src/modules/metrics/buckets.js';
import type { ServiceListResponse } from '../src/modules/services/types.js';
import type { SystemSnapshot } from '../src/modules/system/types.js';
import { makeContainerList } from './support/serviceFixtures.js';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-scheduler-'));

/** 采样间隔 5s（配置下限）：让 minute 桶的 expected = 12，便于构造"部分缺测"。 */
const SAMPLE_INTERVAL_SEC = 5;

/* ------------------------------------------------------------------ *
 * 固定时间与固定序列数（不读墙钟、不碰真实 Docker/宿主采样器）
 * ------------------------------------------------------------------ */

/**
 * 固定 epoch（unix 秒）＝ `2023-11-14T22:13:20Z`。
 *
 * 取值只要求"好算、落在一个整点内"，**不是**为了绕开整点边界 —— 跨边界由本文件
 * 末尾的专门用例主动覆盖。与 `metricsSampler.test.ts` / `metricsApi.test.ts` 同一个值。
 */
const EPOCH = 1_700_000_000;
/** `EPOCH` 所在整点的起点（22:00:00Z）。 */
const HOUR_START = hourStart(EPOCH);
/** 稳定起点：22:15:00Z。它与 `BASE + 60` / `BASE + 120` 同处一小时 → 不跨整点。 */
const BASE = HOUR_START + 15 * 60;
/** 夹具里的常量时间串（本文件禁止 `new Date(...)`）。 */
const FIXTURE_ISO = '1970-01-01T00:00:00.000Z';

/**
 * 假宿主快照提供的读数条数：CPU% + 内存% + 内存字节 + 磁盘% + 磁盘字节（1 个挂载点）。
 *
 * 容器与服务在本文件的假数据源里**明确为空**，所以"一次采集的序列数"恒等于它 ——
 * 断言因此可以写死具体数字，而不是 `toBeGreaterThan(0)`。
 */
const HOST_SERIES = 5;
/** minute 桶的期望样本数：`60 / 5s = 12`。 */
const EXPECTED_PER_MINUTE = 60 / SAMPLE_INTERVAL_SEC;

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
    generatedAt: FIXTURE_ISO,
    host: {
      hostname: 'nas',
      platform: 'linux',
      kernel: '6.1.0',
      arch: 'x64',
      cpuModel: 'test',
      cpuCores: 4,
      uptimeSec: 1000,
      bootedAt: FIXTURE_ISO,
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

/**
 * 空的服务注册表：本文件不测容器/服务指标，因此明确"一个都没有"，
 * 不触发真实 Docker 发现、不碰真实网络（发现流程会读 Docker/tailscale）。
 */
const EMPTY_SERVICES: ServiceListResponse = {
  items: [],
  total: 0,
  categories: [],
  discovery: {
    dockerAvailable: false,
    serveAvailable: false,
    serveDetail: '测试夹具：不接真实 Docker / tailscale serve',
    discoveredAt: FIXTURE_ISO,
    notes: [],
  },
  generatedAt: FIXTURE_ISO,
};

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
  // 只换"外部世界"，三个数据源全部换成注入的假夹具（改的是同一个对象上的方法，
  // 采样器/告警引擎装配期捕获的就是这些对象本身）。于是本文件既不读真实 `/proc`、
  // 也不连真实 Docker：一次采集的序列数恒为 HOST_SERIES，断言可以写死。
  handle.ctx.system.snapshot = async () => fakeSnapshot();
  handle.ctx.containers.list = async () => makeContainerList([], { dockerAvailable: false });
  handle.ctx.services.list = async () => EMPTY_SERVICES;
  // 采样间隔也要钉住，否则"每分钟几个样本"会由一个**隐性输入**决定：
  // `buildApp` 内部会跑 `settings.initialize()`，它把设置表/环境变量层的值**就地写回**
  // 同一个 config 对象 —— 于是 testConfig 传进来的 5s 会被"设置默认值 30s"取代
  // （实测 expected 从 12 悄悄变成 2）。本文件测的是装配层的 tick 语义，不是设置层的
  // 默认值，所以把生效值显式钉回 SAMPLE_INTERVAL_SEC：断言因此不受宿主环境变量影响
  // （那类"本机恰好设了某个变量就换一条路"的坑见 envBoundary.test.ts）。
  handle.config.metrics.sampleIntervalSec = SAMPLE_INTERVAL_SEC;
  opened.push(handle);
  return handle;
}

afterEach(async () => {
  while (opened.length > 0) {
    const handle = opened.pop();
    if (handle) await handle.close();
  }
});

/** 某个分辨率下、某个时间桶里的行数（0 = **这个桶没有数据**，不是"数据是 0"）。 */
function rowsAt(handle: AppHandle, bucketAt: number, resolution: 'minute' | 'hour' = 'minute'): number {
  const row = handle.db
    .prepare('SELECT COUNT(*) AS n FROM metric_buckets WHERE resolution = ? AND bucket_at = ?')
    .get(resolution, bucketAt) as { n: number };
  return row.n;
}

function allRows(handle: AppHandle): number {
  const row = handle.db.prepare('SELECT COUNT(*) AS n FROM metric_buckets').get() as { n: number };
  return row.n;
}

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
    expect(first.metrics?.collected, '假数据源：宿主 5 条读数，容器/服务明确为空').toBe(HOST_SERIES);
    expect(first.metrics?.bucketsFlushed, '桶还没结束，不该提前落库').toBe(0);
    expect(rowsAt(handle, BASE), '桶还没结束，不该提前落库').toBe(0);

    const second = await handle.scheduler.tickOnce(BASE + 60);
    expect(second.metrics?.bucketsFlushed, '结束了就必须落库：5 条序列各 1 行').toBe(HOST_SERIES);
    expect(
      second.metrics?.hoursRolledUp,
      'BASE 与 BASE+60 同处 22 点这一小时 → 一条 hour 行都不该有（这里显式断言，不靠"恰好没跨"）',
    ).toBe(0);
    // 落库的行数与"报告的行数"必须一致：报告数字不能是编的。
    // （曾经这里会随机变成 10 === 5：跨整点后多出 5 条 hour 行，而报告只算 minute 行。）
    expect(allRows(handle)).toBe(HOST_SERIES);
    expect(rowsAt(handle, BASE)).toBe(HOST_SERIES);
    // 落库的 minute 行自己是诚实的：同一分钟只有 1 个 tick → samples 1 < expected 12（partial）
    const minuteCpu = handle.db
      .prepare(
        "SELECT samples, expected FROM metric_buckets WHERE resolution = 'minute' AND metric = 'host.cpu.percent' AND target = 'host'",
      )
      .get() as { samples: number; expected: number };
    expect(minuteCpu.samples).toBe(1);
    expect(minuteCpu.expected).toBe(EXPECTED_PER_MINUTE);
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

    expect(rowsAt(handle, BASE), '有样本的分钟必须有行').toBe(HOST_SERIES);
    expect(
      rowsAt(handle, BASE + 60),
      '整分钟没有样本时**必须没有行** —— 写 0 会把"没采到"伪装成"CPU 真的是 0%"',
    ).toBe(0);
    expect(
      jumped.metrics?.gaps,
      '完全没样本的整分钟要被计成缺口，否则缺测在界面上不可见',
    ).toBe(1 + HOST_SERIES); // 1 个完全缺测的整分钟 + 5 条 partial 桶（samples 1 < expected 12）
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
    expect(written, '不跨整点 → 全库就是这 5 条 minute 行').toBe(HOST_SERIES);
    await before.close();
    opened.splice(opened.indexOf(before), 1);

    // "重启"：同一个库文件上重新装配一次（迁移已应用 → 不会重跑，也不会清表）
    const after = await openApp({ dbPath });
    expect(allRows(after), '历史必须跨重启保留').toBe(written);
    expect(rowsAt(after, BASE)).toBe(HOST_SERIES);

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

/* ------------------------------------------------------------------ *
 * 跨整点：主动覆盖，而不是"希望跑测试的时刻不跨整点"
 * ------------------------------------------------------------------ */

/** 22:59:00（`EPOCH` 所在整点的最后一分钟）。 */
const LAST_MINUTE_OF_HOUR = HOUR_START + 59 * 60;
/** 22:59:30：还在 22 点这一小时里的 tick 时刻。 */
const TICK_BEFORE_BOUNDARY = LAST_MINUTE_OF_HOUR + 30;
/** 23:00:30：跨过整点之后的第一个 tick 时刻。 */
const TICK_AFTER_BOUNDARY = TICK_BEFORE_BOUNDARY + 60;

/**
 * 为什么要有这一组。
 *
 * 上面那些用例断言的是"不该有 hour 行"，它们只能证明"没跨整点时不乱滚"；
 * 而整点滚动**本身**（滚出几行、hour 行的 samples/expected 是什么口径、
 * 未结束的整点会不会提前滚出来）以前从来没有被**显式**测过 ——
 * 只被"跑测试时恰好跨了整点"这件事随机地碰到，然后以随机失败的形式暴露。
 *
 * 所以这里把 tick 序列钉成 22:59:30 → 23:00:30（明确跨过一次整点），
 * 把"跨边界"从此变成**被测行为**。
 */
describe('整点滚动 · 显式跨过 22:59:30 → 23:00:30', () => {
  it('跨整点：22:59 的分钟落 5 行 minute，22 点整点滚出 5 行 hour（samples = 1/60）', async () => {
    const handle = await openApp({ dbPath: ':memory:' });

    // ---- 1) 23:00 之前的最后一个 tick：样本进内存累加器，什么都没落库
    const before = await handle.scheduler.tickOnce(TICK_BEFORE_BOUNDARY);
    expect(before.metrics?.collected).toBe(HOST_SERIES);
    expect(before.metrics?.bucketsFlushed, '22:59 这一分钟还没结束 → 不落库').toBe(0);
    expect(before.metrics?.hoursRolledUp, '22 点这一小时还没结束 → 不该有 hour 行').toBe(0);
    expect(rowsAt(handle, LAST_MINUTE_OF_HOUR), '还没结束的分钟没有行').toBe(0);
    expect(allRows(handle)).toBe(0);

    // ---- 2) 跨过整点的那个 tick
    const after = await handle.scheduler.tickOnce(TICK_AFTER_BOUNDARY);

    // ① 跨过分钟边界：22:59 整分钟落库；这一分钟只有 1 个 tick → samples 1 < expected 12
    expect(after.metrics?.bucketsFlushed, '跨过分钟边界 → 22:59 落 5 行 minute').toBe(HOST_SERIES);
    expect(rowsAt(handle, LAST_MINUTE_OF_HOUR, 'minute')).toBe(HOST_SERIES);

    // ② 跨过整点边界：22 点整点被滚动出来，**每个序列恰好 1 行**
    expect(after.metrics?.hoursRolledUp, '跨过整点 → 22 点滚出 5 行 hour').toBe(HOST_SERIES);
    expect(rowsAt(handle, HOUR_START, 'hour')).toBe(HOST_SERIES);

    // ③ hour 行的口径：samples = "该整点里**存在**几个 minute 桶"（= 1，不是 60），
    //    expected 恒为 60，value 是**按 minute 行 samples 加权**的平均（只有一个样本 → 就是它本身）
    const hourCpu = handle.db
      .prepare(
        "SELECT samples, expected, value FROM metric_buckets WHERE resolution = 'hour' AND metric = 'host.cpu.percent' AND target = 'host'",
      )
      .get() as { samples: number; expected: number; value: number };
    expect(hourCpu.samples, 'hour.samples = 该整点里存在的 minute 行数').toBe(1);
    expect(hourCpu.expected, 'hour.expected 恒为 60（与采样间隔无关）').toBe(60);
    expect(hourCpu.value, '只有一个样本 → 加权平均就是它本身').toBe(41.5);

    // ④ 总行数 = 5 行 minute + 5 行 hour；缺口 = 5 条 partial（samples 1 < 12）+ 0 个完全缺测的整分钟
    expect(allRows(handle)).toBe(HOST_SERIES * 2);
    expect(after.metrics?.gaps, '5 条 partial 桶 + 0 个完全缺测的整分钟').toBe(HOST_SERIES);
    expect(after.metrics?.pruned, '没有过期行（保留窗口远未到期）').toBe(0);

    // ⑤ 23 点这一小时**还没有结束** → 不许提前滚出 hour 行
    expect(rowsAt(handle, HOUR_START + 3600, 'hour'), '未结束的整点不许提前滚出').toBe(0);

    // ⑥ 幂等：同一个整点再 tick 一次不会重复滚（upsert 幂等 + "每小时至多一次"守卫）
    const again = await handle.scheduler.tickOnce(TICK_AFTER_BOUNDARY + 30);
    expect(again.metrics?.hoursRolledUp, '同一整点内不重复滚动').toBe(0);
    expect(rowsAt(handle, HOUR_START, 'hour'), 'hour 行数不变').toBe(HOST_SERIES);
  });
});
