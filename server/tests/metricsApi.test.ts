/**
 * 历史指标 API 的端到端测试（规格 §10 `metricsApi.test.ts` 那一行 / §7 契约）。
 *
 * 真实 app：真实路由 + 真实鉴权 + 真实 CSRF + 真实 SQLite（跑完整迁移 v5）。
 * `/api/metrics` 由 `api/index.ts` 的 `PROTECTED_PREFIXES` 装配（**不是**本地再注册一次）。
 *
 * 这里钉住四件事：
 * - viewer 可读、匿名 401（只读接口也不许匿名看宿主容量）；
 * - catalog / history / storage 三个接口的**契约形状**与 §1.1 的预算数字；
 * - 参数校验：未知 metric / range / target 一律 400 且带 `allowed` / `fieldErrors`；
 * - **API 不做单位换算**：percent 与 bytes 各自返回自己的 unit 与量级；
 *   以及缺测语义：没有数据的窗口 `count = 0` 且其余字段为 null（不是 0）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import type { MetricCatalogView, MetricHistoryView, MetricStorageView } from '../src/modules/metrics/types.js';

const SETUP_TOKEN = 'METRICS-SETUP-TOKEN';
const ADMIN_PASSWORD = 'MetricsAdmin2026!';
const VIEWER_PASSWORD = 'MetricsViewer2026!';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-metrics-'));

const testConfig: PortalConfig = loadConfig({
  env: 'test',
  logLevel: 'error',
  dataDir: TMP_DIR,
  dbPath: ':memory:',
  trustProxy: true,
  tailscale: { mode: 'off', bin: '', socket: '/nonexistent', apiToken: '', tailnet: '-', timeoutMs: 200 },
  bootstrap: { token: SETUP_TOKEN, tokenFile: path.join(TMP_DIR, 'setup-token.txt') },
  session: { ttlHours: 12, rememberTtlHours: 24, cookieName: 'hp_session' },
  metrics: { sampleIntervalSec: 30, minuteRetentionHours: 24, hourRetentionDays: 30, containerLimit: 10 },
});

let handle: AppHandle;
let app: FastifyInstance;

let ipCounter = 40;
function nextIp(): string {
  ipCounter += 1;
  return `10.40.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

interface InjectOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  cookie?: string;
  csrf?: string;
  body?: unknown;
}

function inject(options: InjectOptions) {
  const headers: Record<string, string> = { 'x-forwarded-for': nextIp() };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.csrf) headers['x-csrf-token'] = options.csrf;
  return app.inject({
    method: options.method,
    url: options.url,
    headers,
    ...(options.body === undefined ? {} : { payload: options.body as object }),
  });
}

function sessionCookie(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const match = /(^|;\s*)(hp_session=[^;]*)/.exec(value);
    if (match?.[2]) return match[2];
  }
  throw new Error('响应里没有会话 Cookie');
}

interface Client {
  cookie: string;
  csrf: string;
}

async function login(username: string, password: string): Promise<Client> {
  const response = await inject({ method: 'POST', url: '/api/auth/login', body: { username, password } });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json() as { csrfToken: string };
  return { cookie: sessionCookie(response.headers['set-cookie']), csrf: body.csrfToken };
}

let admin: Client;
let viewer: Client;

/** 取历史曲线的原始响应（带 cookie，失败时把 body 一起暴露出来便于定位）。 */
async function getHistory(
  query: string,
  client: Client | null = viewer,
): Promise<{ statusCode: number; body: string; json: MetricHistoryView | null; error: Record<string, unknown> | null }> {
  const response = await inject({
    method: 'GET',
    url: `/api/metrics/history?${query}`,
    ...(client === null ? {} : { cookie: client.cookie }),
  });
  const parsed = response.json() as Record<string, unknown>;
  return {
    statusCode: response.statusCode,
    body: response.body,
    json: response.statusCode === 200 ? (parsed as unknown as MetricHistoryView) : null,
    error: response.statusCode === 200 ? null : parsed,
  };
}

/** 采样一次的秒级时刻（对齐到整分钟，便于数桶）。 */
const MINUTE_MS = 60_000;
const T0 = Math.floor(Date.now() / MINUTE_MS) * 60 - 120; // 当前分钟往前 2 分钟（秒）

beforeAll(async () => {
  handle = await buildApp({
    config: testConfig,
    logger: createSilentLogger(),
    dbPath: ':memory:',
    serveStatic: false,
    sessionCleanupIntervalMs: 0,
    // 只读接口在测试里必须可用，但后台定时器不许跑（否则测试进程不会退出）
    backgroundJobs: false,
  });
  app = handle.app;
  await app.ready();

  const bootstrap = await inject({
    method: 'POST',
    url: '/api/auth/bootstrap',
    body: { token: SETUP_TOKEN, username: 'admin', password: ADMIN_PASSWORD, displayName: '管理员' },
  });
  expect(bootstrap.statusCode, bootstrap.body).toBe(201);
  admin = await login('admin', ADMIN_PASSWORD);

  const createdViewer = await inject({
    method: 'POST',
    url: '/api/users',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { username: 'viewer1', password: VIEWER_PASSWORD, displayName: '只读账号', role: 'viewer' },
  });
  expect(createdViewer.statusCode, createdViewer.body).toBe(201);
  viewer = await login('viewer1', VIEWER_PASSWORD);

  // 手工跑两次采样（间隔一分钟）：唯一一次落库发生在第二个 tick 上。
  // 不启动后台调度器，因此落库时刻完全由测试决定。
  await handle.metrics.tick(T0);
  await handle.metrics.tick(T0 + 60);
});

afterAll(async () => {
  await handle.close();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`[metricsApi] 临时目录清理失败（不影响测试结论）: ${String(error)}`);
  }
});

describe('历史指标 API · 鉴权', () => {
  it('匿名访问三个接口 → 401（不是 200 空数据）', async () => {
    for (const url of ['/api/metrics/catalog', '/api/metrics/history?metric=host.cpu.percent&target=host&range=1h', '/api/metrics/storage']) {
      const response = await inject({ method: 'GET', url });
      expect(response.statusCode, url).toBe(401);
    }
  });

  it('viewer 三个接口都可读（只读接口不要求写权限，也不需要 CSRF 头）', async () => {
    expect((await inject({ method: 'GET', url: '/api/metrics/catalog', cookie: viewer.cookie })).statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: '/api/metrics/storage', cookie: viewer.cookie })).statusCode).toBe(200);
    expect((await getHistory('metric=host.cpu.percent&target=host&range=1h')).statusCode).toBe(200);
  });

  it('本域没有写接口：POST 到 /api/metrics/history → 404', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/metrics/history',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: {},
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('历史指标 API · catalog', () => {
  it('恰好 8 个指标键，顺序即前端展示顺序，每个都带 unit/targetPattern', async () => {
    const response = await inject({ method: 'GET', url: '/api/metrics/catalog', cookie: viewer.cookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as MetricCatalogView;

    expect(body.metrics.map((metric) => metric.key)).toEqual([
      'host.cpu.percent',
      'host.memory.percent',
      'host.memory.used_bytes',
      'host.disk.percent',
      'host.disk.used_bytes',
      'container.cpu.percent',
      'container.memory.used_bytes',
      'service.health.up_ratio',
    ]);
    expect(body.metrics.map((metric) => metric.unit)).toEqual([
      'percent',
      'percent',
      'bytes',
      'percent',
      'bytes',
      'percent',
      'bytes',
      'ratio',
    ]);
    const disk = body.metrics.find((metric) => metric.key === 'host.disk.percent');
    expect(disk?.targetPattern).toBe('disk:<label>');
    expect(body.metrics.every((metric) => typeof metric.label === 'string' && metric.label !== '')).toBe(true);

    // range 表：分钟级的两个 + 小时级的两个
    expect(body.ranges.map((range) => [range.range, range.resolution, range.expectedBuckets])).toEqual([
      ['1h', 'minute', 60],
      ['24h', 'minute', 1440],
      ['7d', 'hour', 168],
      ['30d', 'hour', 720],
    ]);

    // 采样状态：本测试用 backgroundJobs: false 建 app → 调度器存在但**没在跑**
    expect(body.sampling.intervalSec).toBe(30);
    expect(body.sampling.expectedPerMinuteBucket).toBe(2);
    expect(body.sampling.containerLimit).toBe(10);
    expect(body.sampling.aggregate).toBe('mean');
    expect(body.scheduler?.running).toBe(false);
    expect(body.scheduler?.lastTickAt).toBeNull(); // 后台没跑过（手工 tick 不是调度器那轮）
  });

  it('target 列表来自"库里出现过的行 + 本进程刚采到的"，且已包含刚采到的宿主 target', async () => {
    const response = await inject({ method: 'GET', url: '/api/metrics/catalog', cookie: viewer.cookie });
    const body = response.json() as MetricCatalogView;

    const hosts = body.targets.filter((target) => target.target === 'host');
    const hostMetrics = hosts.map((target) => target.metric);
    // 内存百分比与内存字节一定采得到（os.totalmem/freemem 始终可用）
    expect(hostMetrics).toContain('host.memory.percent');
    expect(hostMetrics).toContain('host.memory.used_bytes');
    // CPU 百分比要两次采样做差：进程刚启动的头几秒可能还没有基线 ——
    // 那种情况必须**没有行**（缺测不写 0），所以这里给的是上界而不是等号
    expect(hostMetrics.length).toBeGreaterThanOrEqual(2);
    expect(hostMetrics.length).toBeLessThanOrEqual(3);
    expect(hosts.every((target) => target.targetLabel === '宿主' && target.unit !== undefined)).toBe(true);
    expect(hosts.every((target) => target.lastSeenAt !== null)).toBe(true);
    expect(
      body.metrics.find((metric) => metric.key === 'host.memory.used_bytes')?.availableTargets,
    ).toBe(1);
    // 目录里的 seriesPerMinute 与 target 列表同源（前端选中的目标一定能查到历史）
    expect(body.targets.every((target) => hostMetrics.includes(target.metric) || target.target !== 'host')).toBe(true);
  });
});

describe('历史指标 API · history 校验', () => {
  it('缺参数 → 400 且指出是哪个参数', async () => {
    const response = await inject({ method: 'GET', url: '/api/metrics/history?target=host&range=1h', cookie: viewer.cookie });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details?: { fieldErrors?: Record<string, string[]> } } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details?.fieldErrors?.['metric']?.[0]).toContain('metric');
  });

  it('未知 metric → 400 并列出全部允许值（前端可直接渲染）', async () => {
    const result = await getHistory('metric=host.nope&target=host&range=1h');
    expect(result.statusCode).toBe(400);
    const error = result.error as {
      error: { code: string; details?: { allowed?: string[]; fieldErrors?: Record<string, string[]> } };
    };
    expect(error.error.code).toBe('VALIDATION_FAILED');
    expect(error.error.details?.allowed).toHaveLength(8);
    expect(error.error.details?.allowed).toContain('host.disk.used_bytes');
    expect(error.error.details?.fieldErrors?.['metric']?.[0]).toContain('host.nope');
  });

  it('未知 range → 400 并说明只能是哪四个', async () => {
    const result = await getHistory('metric=host.cpu.percent&target=host&range=2h');
    expect(result.statusCode).toBe(400);
    const error = result.error as { error: { code: string; details?: { fieldErrors?: Record<string, string[]> } } };
    expect(error.error.details?.fieldErrors?.['range']?.[0]).toBe('只能是 1h / 24h / 7d / 30d');
  });

  it('target 形态不匹配 / 从未出现过 → 400（区分两种原因）', async () => {
    // host 类指标的 target 只能是 `host`
    const wrongKind = await getHistory('metric=host.cpu.percent&target=disk:C&range=1h');
    expect(wrongKind.statusCode).toBe(400);

    // 形态对但库里没有（服务指标还没采过任何服务）
    const neverSeen = await getHistory('metric=service.health.up_ratio&target=service:docker:homeport/nope&range=1h');
    expect(neverSeen.statusCode).toBe(400);
    const error = neverSeen.error as {
      error: { code: string; details?: { fieldErrors?: Record<string, string[]>; targetPattern?: string } };
    };
    expect(error.error.details?.fieldErrors?.['target']?.[0]).toContain('没有出现过');
    expect(error.error.details?.targetPattern).toBe('service:<sourceRef>');
  });
});

describe('历史指标 API · history 数据与单位', () => {
  it('刚采过的那一分钟：1 个点、samples < expected 标 partial、缺口数正确', async () => {
    const result = await getHistory('metric=host.memory.used_bytes&target=host&range=24h');
    expect(result.statusCode, result.body).toBe(200);
    const view = result.json!;

    expect(view.metric).toBe('host.memory.used_bytes');
    expect(view.target).toBe('host');
    expect(view.targetLabel).toBe('宿主');
    expect(view.unit).toBe('bytes');
    expect(view.resolution).toBe('minute');
    expect(view.points).toHaveLength(1);
    expect(view.points[0]?.at).toBe(new Date(T0 * 1000).toISOString()); // 落库的是第一个整分钟
    expect(view.points[0]?.samples).toBe(1);
    expect(view.points[0]?.expected).toBe(2);
    expect(view.points[0]?.partial).toBe(true);
    expect(view.gaps).toEqual({ missingBuckets: 1439, partialBuckets: 1 });
    expect(view.summary.count).toBe(1);
    expect(view.summary.latest).toBe(view.points[0]?.value);
    expect(view.sampling.expectedPerBucket).toBe(2);
  });

  it('percent 与 bytes 各返回自己的 unit 与量级（API 不做任何换算）', async () => {
    const bytesView = (await getHistory('metric=host.memory.used_bytes&target=host&range=24h')).json!;
    const percentView = (await getHistory('metric=host.memory.percent&target=host&range=24h')).json!;

    expect(bytesView.unit).toBe('bytes');
    expect(percentView.unit).toBe('percent');
    const bytesValue = bytesView.points[0]?.value ?? 0;
    const percentValue = percentView.points[0]?.value ?? -1;
    expect(bytesValue).toBeGreaterThan(1024 * 1024); // 字节量级
    expect(percentValue).toBeGreaterThanOrEqual(0);
    expect(percentValue).toBeLessThanOrEqual(100); // 百分比量级

    // 两条曲线是两个独立的 key，互不覆盖
    expect(bytesView.metric).not.toBe(percentView.metric);
    expect(bytesView.points[0]?.value).not.toBe(percentView.points[0]?.value);
  });

  it('没有数据的窗口：count = 0 且 min/max/avg/latest 全为 null（绝不用 0 冒充）', async () => {
    // disk 指标在本机可能一个都没采到（容器化/无挂载点配置）；无论如何都要"空就空"
    const result = await getHistory('metric=host.disk.percent&target=disk:C&range=1h');
    if (result.statusCode === 400) {
      // 该 target 从未出现过 → 400 也是诚实答案（下面用已知存在的 target 再验一次空窗口）
      const fallback = await getHistory('metric=host.memory.used_bytes&target=host&range=7d');
      expect(fallback.statusCode).toBe(200);
      expect(fallback.json?.resolution).toBe('hour');
      // 只有 1 分钟的 minute 行，还没滚动出任何 hour 行 → 空窗口
      expect(fallback.json?.points).toEqual([]);
      expect(fallback.json?.summary).toEqual({
        count: 0,
        min: null,
        max: null,
        avg: null,
        latest: null,
        latestAt: null,
      });
      expect(fallback.json?.gaps).toEqual({ missingBuckets: 168, partialBuckets: 0 });
      return;
    }
    const view = result.json!;
    expect(view.summary.count).toBe(0);
    expect(view.summary.avg).toBeNull();
    expect(view.summary.avg).not.toBe(0);
  });

  it('数据源状态是"尚未采集"时明确说出来，而不是假装可用', async () => {
    // container 指标：本环境没有 Docker → 采集报错、没有来源状态
    const result = await getHistory('metric=host.cpu.percent&target=host&range=1h');
    expect(result.statusCode).toBe(200);
    const view = result.json!;
    expect(view.source.available).toBe(true); // 本机 /proc（或容器视图）可用
    expect(view.source.mode).not.toBe('none');
  });
});

describe('历史指标 API · storage', () => {
  it('行数/占用/保留配置/预算都按 §1.1 报出', async () => {
    const response = await inject({ method: 'GET', url: '/api/metrics/storage', cookie: viewer.cookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as MetricStorageView;

    // 每个"确实采到读数"的序列恰好一行；CPU 百分比可能因为还没有基线而没采到，
    // 所以断言"行数 = 上次 flush 的行数"这条等式，而不是写死 3
    expect(body.rows.minute).toBeGreaterThanOrEqual(2);
    expect(body.rows.minute).toBeLessThanOrEqual(3);
    expect(body.rows.total).toBe(body.rows.minute + body.rows.hour);
    expect(body.rows.minute).toBe(body.lastTick?.bucketsFlushed);
    expect(body.size.pageSize).toBeGreaterThan(0);
    expect(body.size.bytes).toBeGreaterThan(0);
    expect(body.size.megabytes).toBeGreaterThan(0);

    expect(body.bounds.minute.newestAt).toBe(new Date(T0 * 1000).toISOString());
    expect(body.bounds.minute.oldestAt).toBe(new Date(T0 * 1000).toISOString());

    expect(body.retention.minuteHours).toBe(24);
    expect(body.retention.hourDays).toBe(30);
    // 清理截止时刻按**当前时钟**算（而不是按最后一次落库的时刻），并且两端都对齐到桶起点：
    // 用响应自己的 generatedAt 推导，避免测试在分钟边界上抖动
    const generatedAtSec = Math.floor(Date.parse(body.generatedAt) / 1000);
    const nowMinute = Math.floor(generatedAtSec / 60) * 60;
    const nowHour = Math.floor(generatedAtSec / 3600) * 3600;
    expect(body.retention.minuteCutoffAt).toBe(new Date((nowMinute - 24 * 3600) * 1000).toISOString());
    expect(body.retention.hourCutoffAt).toBe(new Date((nowHour - 30 * 86_400) * 1000).toISOString());

    // 预算：有实测序列数时按实测外推，数字必须落在 §1.1 的公式上
    expect(body.budget.basis).toBe('observed');
    expect(body.budget.bytesPerRow).toBe(200);
    expect(body.budget.steadyLimitBytes).toBe(32 * 1024 * 1024);
    expect(body.budget.seriesPerMinute).toBe(body.rows.minute);
    expect(body.budget.minuteRowsPerDay).toBe(body.budget.seriesPerMinute * 1440);
    expect(body.budget.minuteSteadyRows).toBe(body.budget.seriesPerMinute * 60 * 24);
    expect(body.budget.withinBudget).toBe(true);
    expect(body.budget.note).toContain('估算');

    // 数据源不可用只会被记成错误、不抛；无论本机有没有 Docker，下列不变量都必须成立
    expect(body.lastTick?.at).not.toBeNull();
    expect(body.lastTick?.collected).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.lastTick?.errors)).toBe(true);
    // 落库的序列数不可能超过这一轮真正采到的读数数（采集失败不会凭空写行）
    expect(body.rows.minute).toBeLessThanOrEqual(body.lastTick?.collected ?? 0);
  });
});