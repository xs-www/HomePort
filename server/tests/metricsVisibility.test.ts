/**
 * 历史指标**读路径的当前可见性**（P1 修复：hidden 服务不得经历史接口泄漏）。
 *
 * ## 被钉住的缺陷
 *
 * 采集侧固定 `role: 'viewer'` 只能保证"隐藏之后不再产生新样本"。但**隐藏之前**
 * 已经落库的历史行与进程内 `liveTargets` 仍在，于是"先被采集、随后隐藏"的服务
 * 仍可被 viewer 通过 `/api/metrics/catalog`（名字）与 `/api/metrics/history`
 * （曲线）枚举与查询，直到历史数据过期。这与冻结契约"hidden 服务不能经历史接口
 * 泄漏"直接冲突。
 *
 * ## 本文件怎么证明修好了（全部走**真实路由 + 真实鉴权**）
 *
 * 真实 app（`buildApp`）+ `app.inject()`：真实 SQLite（完整迁移）、真实会话 Cookie、
 * 真实 CSRF、真实前缀守卫。夹具是**真的采集**，不是塞假数据：
 *
 * 1. 管理员建一个手工服务（带一个必然探不通的健康目标）→ `handle.health.tick()`
 *    给出判定 → `handle.metrics.tick()` ×2（第二次落库）→ 该服务的
 *    `service.health.up_ratio` 序列同时进入 **DB 行**与**进程内 liveTargets**；
 * 2. 隐藏它（`PATCH /api/services/:id`）：catalog 不再列出（`target` 与
 *    `targetLabel` 都不出现，整个响应体里连服务名都不出现）；
 * 3. `history` 查询它 → 与"**从未采集过**的 target"**逐字段、逐字节**一致
 *    （把调用者自己传的 target 串抹平后比对整段响应体），且**不是** 404/403；
 * 4. 宿主指标（`host`）照常返回 → 过滤没有误伤；
 * 5. 恢复可见后再查 → 历史点**与隐藏前完全一致**（行没被删，只是访问受控）；
 * 6. 再删掉该服务（真删）+ 一条"库里有过行、但当前没有对应可见服务"的
 *    容器序列 → 同样查不到、同样 400。
 *
 * 夹具不依赖墙钟推进（只把桶对齐到当前整分钟）也不依赖真实 Docker
 * （`containers.list` 在无 Docker 时返回 unavailable 而**不抛**）；
 * HTTP 探测目标是回环上的关闭端口，探通与否都不影响结论（健康=1 / 不健康=0 都算样本）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import type { MetricCatalogView, MetricHistoryView } from '../src/modules/metrics/types.js';

const SETUP_TOKEN = 'VISIBILITY-SETUP-TOKEN';
const ADMIN_PASSWORD = 'VisibilityAdmin2026!';
const VIEWER_PASSWORD = 'VisibilityViewer2026!';

/** 服务名刻意独一无二：对整段响应体 `not.toContain` 才有判别力。 */
const SERVICE_NAME = '绝密服务-Zq7-不得泄漏';
/** 必然（在绝大多数环境）连不上的回环端口；探通/探不通都会产生样本。 */
const HEALTH_TARGET = 'http://127.0.0.1:1/';

const SERVICE_METRIC = 'service.health.up_ratio';
const CONTAINER_METRIC = 'container.cpu.percent';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-metrics-visibility-'));

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

let ipCounter = 70;
function nextIp(): string {
  ipCounter += 1;
  return `10.70.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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

/** 手工服务的 id 与它的稳定 sourceRef（`manual:<uuid>`）。 */
let serviceId: string;
let serviceRef: string;
/** 该服务的指标 target：`service:<sourceRef>`。 */
let serviceTarget: string;
/** 隐藏前查到的曲线（恢复可见后逐字段比对，证明历史行一直没删）。 */
let historyBeforeHide: MetricHistoryView | null = null;

interface RawResponse {
  statusCode: number;
  body: string;
  /** 解析后的响应体（成功与失败都解析：不泄漏存在性要看的就是**错误**响应的字段集合）。 */
  json: Record<string, unknown> | null;
}

/** 解析响应体；解析不出来（空体/非 JSON）返回 null。 */
function parseBody(body: string): Record<string, unknown> | null {
  if (body.trim() === '') return null;
  try {
    return JSON.parse(body) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function getCatalog(client: Client): Promise<RawResponse> {
  const response = await inject({ method: 'GET', url: '/api/metrics/catalog', cookie: client.cookie });
  return { statusCode: response.statusCode, body: response.body, json: parseBody(response.body) };
}

async function getHistory(metric: string, target: string, client: Client, range = '1h'): Promise<RawResponse> {
  const query = `metric=${encodeURIComponent(metric)}&target=${encodeURIComponent(target)}&range=${range}`;
  const response = await inject({ method: 'GET', url: `/api/metrics/history?${query}`, cookie: client.cookie });
  return { statusCode: response.statusCode, body: response.body, json: parseBody(response.body) };
}

/**
 * 把响应体里**调用者自己提供的 target 串**抹平。
 *
 * 400 的错误消息里会回显调用者传进来的 target（那本来就是他自己给的，不算泄漏），
 * 抹平之后"不可见的目标"与"从未出现过的目标"必须**整段 JSON 文本完全相同** ——
 * 少一个字段、多一个 `reason`、或者换成 404/403 都会在这里红。
 */
function normalizeTarget(body: string, target: string): string {
  return body.split(target).join('<target>');
}

/** 抖动无关的采样时刻：当前整分钟往前 2 分钟（第二次 tick 会把这分钟落库）。 */
const MINUTE_MS = 60_000;
const T0 = Math.floor(Date.now() / MINUTE_MS) * 60 - 120;

beforeAll(async () => {
  handle = await buildApp({
    config: testConfig,
    logger: createSilentLogger(),
    dbPath: ':memory:',
    serveStatic: false,
    sessionCleanupIntervalMs: 0,
    // 只读接口要可用，但后台定时器不许跑（否则测试进程不会退出）
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

  // ---- 真的采集一次：手工服务 → 健康判定 → 指标采样 → 落库 ----
  const created = await inject({
    method: 'POST',
    url: '/api/services',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { displayName: SERVICE_NAME, healthTarget: HEALTH_TARGET },
  });
  expect(created.statusCode, created.body).toBe(201);
  const service = created.json() as { id: string; sourceRef: string; displayName: string };
  expect(service.displayName).toBe(SERVICE_NAME);
  serviceId = service.id;
  serviceRef = service.sourceRef;
  serviceTarget = `service:${serviceRef}`;

  // 健康监视器先跑（调度器里的顺序就是 health → metrics）：判定 ∈ {healthy, degraded, down}
  await handle.health.tick(Date.now());
  const verdict = handle.health.state(serviceRef)?.verdict ?? null;
  expect(verdict, '夹具失败：健康监视器没有给出判定，服务指标就采不到样本').not.toBeNull();
  expect(verdict).not.toBe('unknown');

  // 第一次 tick 采到样本（进内存累加器 + liveTargets）；第二次把已结束的分钟落库。
  await handle.metrics.tick(T0);
  await handle.metrics.tick(T0 + 60);

  // 夹具自检：库里确实有这一行（否则后面的"不可见"是假绿）
  const rows = handle.db
    .prepare('SELECT COUNT(*) AS n FROM metric_buckets WHERE metric = ? AND target = ?')
    .get(SERVICE_METRIC, serviceTarget) as { n: number };
  expect(rows.n, '夹具失败：服务指标没有落库').toBeGreaterThan(0);
});

afterAll(async () => {
  await handle.close();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`[metricsVisibility] 临时目录清理失败（不影响测试结论）: ${String(error)}`);
  }
});

describe('历史指标读接口 · 鉴权（真实路由）', () => {
  it('匿名访问读接口 → 401；viewer 可读', async () => {
    for (const url of [
      '/api/metrics/catalog',
      `/api/metrics/history?metric=${SERVICE_METRIC}&target=${encodeURIComponent(serviceTarget)}&range=1h`,
      '/api/metrics/storage',
    ]) {
      expect((await inject({ method: 'GET', url })).statusCode, url).toBe(401);
    }
    expect((await getCatalog(viewer)).statusCode).toBe(200);
    expect((await getHistory(SERVICE_METRIC, serviceTarget, viewer)).statusCode).toBe(200);
  });
});

describe('历史指标读接口 · 隐藏前：采过的服务可见', () => {
  it('catalog 列出该服务 target，且带它的展示名', async () => {
    const catalog = await getCatalog(viewer);
    expect(catalog.statusCode, catalog.body).toBe(200);
    const body = catalog.json as unknown as MetricCatalogView;

    const entry = body.targets.find((target) => target.target === serviceTarget);
    expect(entry, `catalog 里没有 ${serviceTarget}`).toBeDefined();
    expect(entry?.metric).toBe(SERVICE_METRIC);
    expect(entry?.targetLabel).toBe(SERVICE_NAME);
    expect(catalog.body).toContain(SERVICE_NAME);
  });

  it('history 能查到该服务的点（历史行真的存在）', async () => {
    const history = await getHistory(SERVICE_METRIC, serviceTarget, viewer);
    expect(history.statusCode, history.body).toBe(200);
    const view = history.json as unknown as MetricHistoryView;
    expect(view.target).toBe(serviceTarget);
    expect(view.targetLabel).toBe(SERVICE_NAME);
    expect(view.points.length).toBeGreaterThanOrEqual(1);
    // 留一份"隐藏前"的曲线，供恢复可见后逐字段比对（证明行一直没被删）
    historyBeforeHide = view;
  });
});

describe('历史指标读接口 · 隐藏后：不再列出、不再可查、不泄漏存在性', () => {
  beforeAll(async () => {
    const hidden = await inject({
      method: 'PATCH',
      url: `/api/services/${serviceId}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { visibility: 'hidden' },
    });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect((hidden.json() as { visibility?: string }).visibility).toBe('hidden');
  });

  it('catalog：target 与 targetLabel 都不出现，服务名在整个响应体里一次都不出现', async () => {
    const catalog = await getCatalog(viewer);
    expect(catalog.statusCode, catalog.body).toBe(200);
    const body = catalog.json as unknown as MetricCatalogView;

    expect(body.targets.some((target) => target.target === serviceTarget)).toBe(false);
    expect(body.targets.some((target) => target.targetLabel === SERVICE_NAME)).toBe(false);
    // 最不容易漏的写法：整段 JSON 里连名字都不许出现
    expect(catalog.body).not.toContain(SERVICE_NAME);
    // 目录里"每指标可用 target 数"也必须同步（否则前端会显示一个选不中的数量）
    expect(body.metrics.find((metric) => metric.key === SERVICE_METRIC)?.availableTargets).toBe(0);
  });

  it('catalog：admin 会话同样看不到（读路径只有一套 viewer 可见集合）', async () => {
    const catalog = await getCatalog(admin);
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.body).not.toContain(SERVICE_NAME);
    expect((catalog.json as unknown as MetricCatalogView).targets.some((t) => t.target === serviceTarget)).toBe(false);
  });

  it('storage：读接口里也不出现隐藏服务的名字', async () => {
    const response = await inject({ method: 'GET', url: '/api/metrics/storage', cookie: viewer.cookie });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).not.toContain(SERVICE_NAME);
  });

  it('history：与"从未采集过的 target"逐字段一致（抹平 target 串后整段响应相同），且不是 404/403', async () => {
    const ghostTarget = `service:manual:${randomUUID()}`;
    const hidden = await getHistory(SERVICE_METRIC, serviceTarget, viewer);
    const ghost = await getHistory(SERVICE_METRIC, ghostTarget, viewer);

    expect(hidden.statusCode, hidden.body).toBe(400);
    expect(hidden.statusCode).not.toBe(403);
    expect(hidden.statusCode).not.toBe(404);
    expect(hidden.statusCode).toBe(ghost.statusCode);

    const hiddenError = hidden.json as { error: { code: string; details?: Record<string, unknown> } };
    expect(hiddenError.error.code).toBe('VALIDATION_FAILED');
    expect(hiddenError.error.details?.['targetPattern']).toBe('service:<sourceRef>');
    // 不可见 → 与陌生 target 的字段集合完全一致：没有 reason/visibility/hidden 之类的区分字段
    expect(Object.keys(hiddenError.error).sort()).toEqual(
      Object.keys((ghost.json as { error: Record<string, unknown> }).error).sort(),
    );

    // 逐字节：抹掉两个各自传入的 target 串之后，响应体必须完全相同
    expect(normalizeTarget(hidden.body, serviceTarget)).toBe(normalizeTarget(ghost.body, ghostTarget));
    expect(hidden.body).not.toContain(SERVICE_NAME);
  });

  it('history：admin 会话同样 400（与 viewer 一致，不做角色特例）', async () => {
    const hidden = await getHistory(SERVICE_METRIC, serviceTarget, admin);
    expect(hidden.statusCode, hidden.body).toBe(400);
    expect(hidden.body).not.toContain(SERVICE_NAME);
  });

  it('宿主指标不受影响：host 的 catalog 条目与 history 数据照常返回', async () => {
    const catalog = await getCatalog(viewer);
    const body = catalog.json as unknown as MetricCatalogView;
    const hosts = body.targets.filter((target) => target.target === 'host');
    expect(hosts.length).toBeGreaterThanOrEqual(2); // 内存百分比 + 内存字节
    expect(hosts.every((target) => target.targetLabel === '宿主')).toBe(true);
    expect(body.metrics.find((metric) => metric.key === 'host.memory.used_bytes')?.availableTargets).toBe(1);

    const history = await getHistory('host.memory.used_bytes', 'host', viewer, '24h');
    expect(history.statusCode, history.body).toBe(200);
    const view = history.json as unknown as MetricHistoryView;
    expect(view.targetLabel).toBe('宿主');
    expect(view.points.length).toBeGreaterThanOrEqual(1);
  });
});

describe('历史指标读接口 · 恢复可见：历史行没被删，只是访问受控', () => {
  beforeAll(async () => {
    const restored = await inject({
      method: 'PATCH',
      url: `/api/services/${serviceId}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { visibility: 'visible' },
    });
    expect(restored.statusCode, restored.body).toBe(200);
  });

  it('catalog 重新列出它，名字回来', async () => {
    const catalog = await getCatalog(viewer);
    expect(catalog.statusCode, catalog.body).toBe(200);
    const entry = (catalog.json as unknown as MetricCatalogView).targets.find((t) => t.target === serviceTarget);
    expect(entry?.targetLabel).toBe(SERVICE_NAME);
    expect(catalog.body).toContain(SERVICE_NAME);
  });

  it('history 重新可查，且点与隐藏前完全一致（证明行一直没删）', async () => {
    expect(historyBeforeHide, '夹具失败：没拿到隐藏前的曲线').not.toBeNull();
    const after = await getHistory(SERVICE_METRIC, serviceTarget, viewer);
    expect(after.statusCode, after.body).toBe(200);
    const view = after.json as unknown as MetricHistoryView;
    expect(view.points.length).toBeGreaterThanOrEqual(1);
    expect(view.points).toEqual(historyBeforeHide?.points);
    expect(view.summary).toEqual(historyBeforeHide?.summary);
    expect(view.gaps).toEqual(historyBeforeHide?.gaps);
    expect(view.targetLabel).toBe(SERVICE_NAME);
  });
});

describe('历史指标读接口 · 已删除 / 从未有可见服务的序列', () => {
  beforeAll(async () => {
    const removed = await inject({
      method: 'DELETE',
      url: `/api/services/${serviceId}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((removed.json() as { mode?: string }).mode).toBe('deleted');
  });

  it('删掉服务后 catalog 不含它，history 与陌生 target 一致（历史行仍在库里）', async () => {
    const rows = handle.db
      .prepare('SELECT COUNT(*) AS n FROM metric_buckets WHERE metric = ? AND target = ?')
      .get(SERVICE_METRIC, serviceTarget) as { n: number };
    expect(rows.n, '删除服务不该删掉历史行').toBeGreaterThan(0);

    const catalog = await getCatalog(viewer);
    expect(catalog.body).not.toContain(SERVICE_NAME);
    expect((catalog.json as unknown as MetricCatalogView).targets.some((t) => t.target === serviceTarget)).toBe(false);

    const deleted = await getHistory(SERVICE_METRIC, serviceTarget, viewer);
    const ghostTarget = `service:manual:${randomUUID()}`;
    const ghost = await getHistory(SERVICE_METRIC, ghostTarget, viewer);
    expect(deleted.statusCode, deleted.body).toBe(400);
    expect(normalizeTarget(deleted.body, serviceTarget)).toBe(normalizeTarget(ghost.body, ghostTarget));
  });

  it('容器类 target 同样受控：库里有行但没有可见服务时，catalog 不列、history 与陌生 target 一致', async () => {
    // 直接落一行"曾经采过"的容器序列：它对应的服务当前不存在（等价于服务被删/隐藏后残留的历史行）
    const containerTarget = 'container:docker:ghost/secret-web';
    handle.db
      .prepare(
        `INSERT INTO metric_buckets (
           id, resolution, metric, target, target_label, unit, bucket_at,
           value, min_value, max_value, samples, expected, created_at
         ) VALUES (
           @id, 'minute', @metric, @target, @targetLabel, 'percent', @bucketAt,
           3, 3, 3, 1, 2, @createdAt
         )`,
      )
      .run({
        id: randomUUID(),
        metric: CONTAINER_METRIC,
        target: containerTarget,
        targetLabel: '幽灵容器-不得泄漏',
        bucketAt: T0,
        createdAt: new Date(T0 * 1000).toISOString(),
      });

    const catalog = await getCatalog(viewer);
    expect(catalog.statusCode, catalog.body).toBe(200);
    expect(catalog.body).not.toContain('幽灵容器-不得泄漏');
    expect((catalog.json as unknown as MetricCatalogView).targets.some((t) => t.target === containerTarget)).toBe(false);

    const leaked = await getHistory(CONTAINER_METRIC, containerTarget, viewer);
    const ghostTarget = 'container:docker:ghost/never-existed';
    const ghost = await getHistory(CONTAINER_METRIC, ghostTarget, viewer);
    expect(leaked.statusCode, leaked.body).toBe(400);
    expect(leaked.statusCode).not.toBe(404);
    expect(normalizeTarget(leaked.body, containerTarget)).toBe(normalizeTarget(ghost.body, ghostTarget));
  });
});