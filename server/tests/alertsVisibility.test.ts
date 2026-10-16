/**
 * 告警**读路径的当前可见性**（P1 修复：隐藏/已删除的服务不得经告警事件泄漏）。
 *
 * ## 被钉住的缺陷
 *
 * 事件行的 `target` / `target_label` / `message` 是**触发那一刻落库**的快照，
 * 不随服务后来的可见性变化。于是服务被隐藏（或删除）之后，viewer 依然能在
 * `/api/alerts/events` 里看到它的名字，在 `/api/alerts/summary` 里看到"还有 N 条未恢复"
 * —— 计数本身就是存在性证据。这与冻结契约"hidden 服务不得经读接口泄漏"
 * （`/api/metrics/*` 已按同一句话修过一轮）直接冲突。
 *
 * ## 本文件怎么证明修好了（全部走**真实路由 + 真实鉴权**）
 *
 * 真实 app（`buildApp`）+ `app.inject()`：真实 SQLite（完整迁移 v5）、真实会话 Cookie、
 * 真实 CSRF、真实前缀守卫、真实服务注册表（`ctx.services` 就是生产那一个）。
 *
 * 1. 管理员建一个手工服务（唯一名字），直接落库"触发时快照"：`service_health`
 *    （服务名在 `targetLabel` 与 `message` 里）与 `container_exit`
 *    （`container:<sourceRef>`，名字在 `targetLabel` 里）—— 覆盖两条服务类分支；
 *    另有宿主类（磁盘/内存）与一条**从未有可见服务**的 target（与隐藏服务必须同样不可见）；
 * 2. 隐藏它（`PATCH /api/services/:id`）：事件列表与 summary **整段 JSON** 里
 *    服务名、容器名、`sourceRef`、target 串一次都不出现，且 `total` / `counts` /
 *    `bySeverity` / `top` 一起下降；
 * 3. 分页语义不变：`limit=1` 作用在**可见集合**上（不可见事件不占页位），
 *    否则会出现"看得见的事件反而翻不到"；
 * 4. 宿主类事件（磁盘/内存）不受影响；
 * 5. 库里的事件行**没被删、状态没被改**（`resolved_at` 仍为 NULL）—— 有意的组合语义；
 * 6. 恢复可见后原样回来（同一 id / target / firedAt）；
 * 7. admin 会话同样看不到（与 `/api/metrics/*` 的读路径口径一致：不分角色）；
 * 8. 注册表读失败 → **fail-closed**：服务与容器类事件一律不可见，宿主事件照常。
 *
 * 夹具不依赖 Docker、不依赖墙钟（fired_at 全是固定值）。
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
import { alertEventVisibilityWhere, type AlertEventVisibility } from '../src/modules/alerts/service.js';
import type { AlertEventListResponse, AlertSummaryView } from '../src/modules/alerts/types.js';
import { loadVisibleServiceRefs } from '../src/modules/visibility/serviceVisibility.js';

const SETUP_TOKEN = 'ALERT-VISIBILITY-SETUP-TOKEN';
const ADMIN_PASSWORD = 'AlertVisAdmin2026!';
const VIEWER_PASSWORD = 'AlertVisViewer2026!';

/** 名字刻意独一无二：对整段 JSON 做 `not.toContain` 才有判别力。 */
const SERVICE_NAME = '绝密告警服务-Zx9-不得泄漏';
const CONTAINER_LABEL = '绝密容器-Q3-不得泄漏';
const GHOST_LABEL = '幽灵服务-不得泄漏';
const DISK_LABEL = 'C:';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-alerts-visibility-'));

const testConfig: PortalConfig = loadConfig({
  env: 'test',
  logLevel: 'error',
  dataDir: TMP_DIR,
  dbPath: ':memory:',
  trustProxy: true,
  tailscale: { mode: 'off', bin: '', socket: '/nonexistent', apiToken: '', tailnet: '-', timeoutMs: 200 },
  bootstrap: { token: SETUP_TOKEN, tokenFile: path.join(TMP_DIR, 'setup-token.txt') },
  session: { ttlHours: 12, rememberTtlHours: 24, cookieName: 'hp_session' },
});

let handle: AppHandle;
let app: FastifyInstance;

let ipCounter = 110;
function nextIp(): string {
  ipCounter += 1;
  return `10.90.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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

/** 被测服务的 id 与稳定 sourceRef（`manual:<uuid>`）。 */
let serviceId: string;
let serviceRef: string;

/** 预置一条事件行：读接口只读，所以夹具直接落库（形状与引擎写入的逐列一致）。 */
function seedEvent(input: {
  id: string;
  ruleId: string;
  kind: string;
  ruleName: string;
  target: string;
  targetLabel: string;
  severity: 'warning' | 'critical';
  value: number | null;
  unit: string | null;
  message: string;
  firedAt: string;
  resolvedAt?: string | null;
}): void {
  handle.db
    .prepare(
      `INSERT INTO alert_events (
         id, rule_id, kind, rule_name, target, target_label, severity, value, threshold, unit,
         message, started_at, fired_at, resolved_at, reopen_count, acknowledged_at, acknowledged_by, created_at
       ) VALUES (
         @id, @ruleId, @kind, @ruleName, @target, @targetLabel, @severity, @value, 3, @unit,
         @message, @firedAt, @firedAt, @resolvedAt, 0, NULL, NULL, @firedAt
       )`,
    )
    .run({
      id: input.id,
      ruleId: input.ruleId,
      kind: input.kind,
      ruleName: input.ruleName,
      target: input.target,
      targetLabel: input.targetLabel,
      severity: input.severity,
      value: input.value,
      unit: input.unit,
      message: input.message,
      firedAt: input.firedAt,
      resolvedAt: input.resolvedAt ?? null,
    });
}

function getEvents(client: Client, query = ''): Promise<{ statusCode: number; body: string }> {
  return inject({ method: 'GET', url: `/api/alerts/events${query}`, cookie: client.cookie }).then((response) => ({
    statusCode: response.statusCode,
    body: response.body,
  }));
}

function getSummary(client: Client): Promise<{ statusCode: number; body: string }> {
  return inject({ method: 'GET', url: '/api/alerts/summary', cookie: client.cookie }).then((response) => ({
    statusCode: response.statusCode,
    body: response.body,
  }));
}

/** 响应体（成功路径恒为 200，解析失败直接让用例红）。 */
function eventsOf(body: string): AlertEventListResponse {
  return JSON.parse(body) as AlertEventListResponse;
}

function summaryOf(body: string): AlertSummaryView {
  return JSON.parse(body) as AlertSummaryView;
}

/** 整段 JSON 里不许出现的字符串：服务名 / 容器名 / 幽灵名 / 服务稳定身份及其两种 target 形态。 */
function leakTexts(): string[] {
  return [SERVICE_NAME, CONTAINER_LABEL, GHOST_LABEL, serviceRef, `service:${serviceRef}`, `container:${serviceRef}`];
}

async function setVisibility(visibility: 'visible' | 'hidden'): Promise<void> {
  const response = await inject({
    method: 'PATCH',
    url: `/api/services/${serviceId}`,
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { visibility },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect((response.json() as { visibility?: string }).visibility).toBe(visibility);
}

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

  // ---- 夹具：一个真实存在的可见服务（不加健康目标 → 不参与 /api/health/monitor）----
  const created = await inject({
    method: 'POST',
    url: '/api/services',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { displayName: SERVICE_NAME },
  });
  expect(created.statusCode, created.body).toBe(201);
  const service = created.json() as { id: string; sourceRef: string; visibility: string };
  expect(service.visibility).toBe('visible');
  serviceId = service.id;
  serviceRef = service.sourceRef;

  // ---- 事件夹具：两条服务类（service: / container:）+ 两条宿主类 + 一条"从未可见"----
  seedEvent({
    id: 'ev-ctr',
    ruleId: 'rule-container-exit',
    kind: 'container_exit',
    ruleName: '容器异常退出',
    target: `container:${serviceRef}`,
    targetLabel: CONTAINER_LABEL,
    severity: 'critical',
    value: 1,
    unit: 'exit_code',
    message: `容器 ${CONTAINER_LABEL} 异常退出（exited，退出码 1）`,
    firedAt: '2026-10-15T09:20:00.000Z',
  });
  seedEvent({
    id: 'ev-svc',
    ruleId: 'rule-service-health',
    kind: 'service_health',
    ruleName: '服务连续不可用',
    target: `service:${serviceRef}`,
    targetLabel: SERVICE_NAME,
    severity: 'critical',
    value: 3,
    unit: 'count',
    message: `服务 ${SERVICE_NAME} 连续 3 次探测失败（阈值 3 次）`,
    firedAt: '2026-10-15T09:40:00.000Z', // 最新：用来证明 limit 作用在过滤**之后**
  });
  seedEvent({
    id: 'ev-disk',
    ruleId: 'rule-disk-percent',
    kind: 'disk_percent',
    ruleName: '磁盘使用率过高',
    target: `disk:${DISK_LABEL}`,
    targetLabel: DISK_LABEL,
    severity: 'warning',
    value: 92,
    unit: 'percent',
    message: `磁盘 ${DISK_LABEL} 使用率 92%（阈值 85%）`,
    firedAt: '2026-10-15T09:30:00.000Z',
  });
  seedEvent({
    id: 'ev-memory',
    ruleId: 'rule-memory-percent',
    kind: 'memory_percent',
    ruleName: '内存使用率过高',
    target: 'host',
    targetLabel: '宿主',
    severity: 'warning',
    value: 95,
    unit: 'percent',
    message: '宿主内存使用率 95%（阈值 90%）',
    firedAt: '2026-10-15T09:00:00.000Z',
    resolvedAt: '2026-10-15T09:05:00.000Z',
  });
  seedEvent({
    id: 'ev-ghost',
    ruleId: 'rule-service-health',
    kind: 'service_health',
    ruleName: '服务连续不可用',
    // 从未存在过的服务：与"被隐藏的服务"必须同样不可见（否则"看得见=存在"）
    target: `service:manual:${randomUUID()}`,
    targetLabel: GHOST_LABEL,
    severity: 'warning',
    value: 5,
    unit: 'count',
    message: `服务 ${GHOST_LABEL} 连续 5 次探测失败（阈值 3 次）`,
    firedAt: '2026-10-15T09:10:00.000Z',
  });
});

afterAll(async () => {
  await handle.close();
  try {
    fs.rmSync(TMP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (error) {
    console.warn(`[alertsVisibility] 临时目录清理失败（不影响测试结论）: ${String(error)}`);
  }
});

describe('告警读接口 · 隐藏前：可见服务的事件照常出现', () => {
  it('事件列表：4 条在（服务名出现在 targetLabel 与 message 里）', async () => {
    const response = await getEvents(viewer);
    expect(response.statusCode, response.body).toBe(200);
    const body = eventsOf(response.body);
    expect(body.items.map((item) => item.id)).toEqual(['ev-svc', 'ev-disk', 'ev-ctr', 'ev-memory']);
    expect(body.total).toBe(4);
    expect(body.counts).toEqual({ open: 3, resolved: 1, unacknowledged: 3 });
    expect(body.items.find((item) => item.id === 'ev-svc')).toMatchObject({
      target: `service:${serviceRef}`,
      targetLabel: SERVICE_NAME,
    });
    expect(response.body).toContain(SERVICE_NAME);
    expect(response.body).toContain(CONTAINER_LABEL);
  });

  it('"从未有可见服务"的 target 与隐藏服务同样不可见（没有任何存在性信号）', async () => {
    const body = eventsOf((await getEvents(viewer)).body);
    expect(body.items.some((item) => item.id === 'ev-ghost')).toBe(false);
    // 库里确实有这行（不是夹具没插进去）：不可见是过滤的结果，不是数据缺失
    const ghosts = handle.db.prepare('SELECT COUNT(*) AS n FROM alert_events WHERE id = ?').get('ev-ghost') as { n: number };
    expect(ghosts.n).toBe(1);
  });

  it('summary：计数把服务类事件算在内，top 里有它们', async () => {
    const response = await getSummary(viewer);
    expect(response.statusCode, response.body).toBe(200);
    const body = summaryOf(response.body);
    expect(body.open).toBe(3);
    expect(body.unacknowledged).toBe(3);
    expect(body.bySeverity).toEqual({ warning: 1, critical: 2 });
    expect(body.top.map((item) => item.id)).toEqual(['ev-svc', 'ev-ctr', 'ev-disk']);
    expect(body.top[0]?.targetLabel).toBe(SERVICE_NAME);
    expect(response.body).toContain(SERVICE_NAME);
  });

  it('limit=1 这一页属于最新的事件（隐藏前是服务事件）', async () => {
    const response = await getEvents(viewer, '?limit=1');
    const body = eventsOf(response.body);
    expect(body.items.map((item) => item.id)).toEqual(['ev-svc']);
    expect(body.total).toBe(4);
  });
});

describe('告警读接口 · 隐藏后：读响应里连名字都不出现，计数一起下降', () => {
  beforeAll(async () => {
    await setVisibility('hidden');
  });

  it('事件列表：items / total / counts 一起只统计可见集合，整段 JSON 不含任何泄漏串', async () => {
    const response = await getEvents(viewer);
    expect(response.statusCode, response.body).toBe(200);
    const body = eventsOf(response.body);

    expect(body.items.map((item) => item.id)).toEqual(['ev-disk', 'ev-memory']);
    expect(body.total).toBe(2);
    // 计数必须同步下降 —— 留着旧计数等于用数字告诉 viewer "有一条你看不见的未恢复告警"
    expect(body.counts).toEqual({ open: 1, resolved: 1, unacknowledged: 1 });

    for (const text of leakTexts()) expect(response.body, `事件列表泄漏了 ${text}`).not.toContain(text);
    // 剩下列表里连服务/容器类 target 前缀都不该出现
    expect(response.body).not.toContain('service:');
    expect(response.body).not.toContain('container:');
  });

  it('summary：open / unacknowledged / bySeverity / top 全部同步下降，且不含任何名字', async () => {
    const response = await getSummary(viewer);
    expect(response.statusCode, response.body).toBe(200);
    const body = summaryOf(response.body);

    expect(body.open).toBe(1);
    expect(body.unacknowledged).toBe(1);
    expect(body.bySeverity).toEqual({ warning: 1, critical: 0 });
    expect(body.top.map((item) => item.id)).toEqual(['ev-disk']);
    expect(body.top[0]?.targetLabel).toBe(DISK_LABEL);

    for (const text of leakTexts()) expect(response.body, `摘要泄漏了 ${text}`).not.toContain(text);
  });

  it('分页语义不变：limit 作用在可见集合上（不可见事件不占页位，不会返回空页）', async () => {
    const response = await getEvents(viewer, '?limit=1');
    const body = eventsOf(response.body);
    expect(body.items.map((item) => item.id)).toEqual(['ev-disk']);
    expect(body.total).toBe(2);
    expect(body.counts).toEqual({ open: 1, resolved: 1, unacknowledged: 1 });
  });

  it('state 过滤也只在可见集合内生效（resolved 只剩宿主内存事件）', async () => {
    const body = eventsOf((await getEvents(viewer, '?state=resolved')).body);
    expect(body.items.map((item) => item.id)).toEqual(['ev-memory']);
    expect(body.counts).toEqual({ open: 1, resolved: 1, unacknowledged: 1 });
    const open = eventsOf((await getEvents(viewer, '?state=open')).body);
    expect(open.items.map((item) => item.id)).toEqual(['ev-disk']);
  });

  it('宿主 / 非服务类事件不受影响：磁盘与内存事件照常返回，字段原样', async () => {
    const body = eventsOf((await getEvents(viewer)).body);
    expect(body.items.find((item) => item.id === 'ev-disk')).toMatchObject({
      kind: 'disk_percent',
      target: `disk:${DISK_LABEL}`,
      targetLabel: DISK_LABEL,
      state: 'open',
    });
    expect(body.items.find((item) => item.id === 'ev-memory')).toMatchObject({
      kind: 'memory_percent',
      target: 'host',
      targetLabel: '宿主',
      state: 'resolved',
    });
  });

  it('admin 会话同样看不到（与 /api/metrics/* 的读路径同口径：读路径只有一套 viewer 可见集合）', async () => {
    const events = await getEvents(admin);
    const summary = await getSummary(admin);
    expect(events.statusCode, events.body).toBe(200);
    expect(summary.statusCode, summary.body).toBe(200);

    expect(eventsOf(events.body).items.map((item) => item.id)).toEqual(['ev-disk', 'ev-memory']);
    expect(eventsOf(events.body).counts).toEqual({ open: 1, resolved: 1, unacknowledged: 1 });
    for (const text of leakTexts()) {
      expect(events.body, `admin 事件列表泄漏了 ${text}`).not.toContain(text);
      expect(summary.body, `admin 摘要泄漏了 ${text}`).not.toContain(text);
    }
  });

  it('库里的事件行没被删、状态也没被改（有意的组合语义：读侧不可见 ≠ 引擎认为已恢复）', () => {
    const row = handle.db
      .prepare('SELECT target, target_label, resolved_at, reopen_count FROM alert_events WHERE id = ?')
      .get('ev-svc') as { target: string; target_label: string; resolved_at: string | null; reopen_count: number };
    expect(row.target).toBe(`service:${serviceRef}`);
    expect(row.target_label).toBe(SERVICE_NAME);
    expect(row.resolved_at).toBeNull(); // 仍然是未恢复 —— 只是 viewer 看不见
    expect(row.reopen_count).toBe(0);
  });
});

describe('告警读接口 · 恢复可见：行一直没删，只是访问受控', () => {
  beforeAll(async () => {
    await setVisibility('visible');
  });

  it('事件列表与摘要原样回来（同一 id / target / firedAt），计数回到隐藏前', async () => {
    const events = await getEvents(viewer);
    const body = eventsOf(events.body);
    expect(body.items.map((item) => item.id)).toEqual(['ev-svc', 'ev-disk', 'ev-ctr', 'ev-memory']);
    expect(body.total).toBe(4);
    expect(body.counts).toEqual({ open: 3, resolved: 1, unacknowledged: 3 });
    expect(body.items.find((item) => item.id === 'ev-svc')).toMatchObject({
      target: `service:${serviceRef}`,
      targetLabel: SERVICE_NAME,
      firedAt: '2026-10-15T09:40:00.000Z',
    });
    expect(events.body).toContain(SERVICE_NAME);

    const summary = summaryOf((await getSummary(viewer)).body);
    expect(summary.open).toBe(3);
    expect(summary.bySeverity).toEqual({ warning: 1, critical: 2 });
  });
});

describe('告警读接口 · 可见性来源不可用 → fail-closed', () => {
  it('注册表读失败：服务 / 容器类事件一律不可见，宿主事件照常（不是"过滤不了就不过滤"）', async () => {
    const realRegistry = handle.ctx.services;
    try {
      // 把注册表换成必然抛错的桩：只有"读失败也要收紧"才可能通过下面的断言
      handle.ctx.services = {
        list: async () => {
          throw new Error('注册表读失败（测试桩）');
        },
      } as unknown as typeof handle.ctx.services;

      const events = await getEvents(viewer);
      expect(events.statusCode, events.body).toBe(200);
      const body = eventsOf(events.body);
      expect(body.items.map((item) => item.id)).toEqual(['ev-disk', 'ev-memory']);
      expect(body.counts).toEqual({ open: 1, resolved: 1, unacknowledged: 1 });
      for (const text of leakTexts()) expect(events.body, `读失败时泄漏了 ${text}`).not.toContain(text);

      const summary = summaryOf((await getSummary(viewer)).body);
      expect(summary.open).toBe(1);
      expect(summary.top.map((item) => item.id)).toEqual(['ev-disk']);
    } finally {
      handle.ctx.services = realRegistry;
    }

    // 还原后恢复原样（证明失败态不是"过滤被永久关掉"）
    expect(eventsOf((await getEvents(viewer)).body).total).toBe(4);
  });
});

describe('共享可见性实现 · 纯函数边界', () => {
  it('alertEventVisibilityWhere：null 与空集合都只放行宿主事件；有集合时按 kind 分两个分支', () => {
    const hostOnly = "(target NOT LIKE 'service:%' AND target NOT LIKE 'container:%')";

    const unavailable = alertEventVisibilityWhere(null);
    expect(unavailable.sql).toBe(hostOnly);
    expect(unavailable.params).toEqual([]);

    const empty = alertEventVisibilityWhere(new Set<string>());
    expect(empty.sql).toBe(hostOnly);
    expect(empty.params).toEqual([]);

    const one = alertEventVisibilityWhere(new Set(['docker:gitea']));
    expect(one.params).toEqual(['service:docker:gitea', 'container:docker:gitea']);
    expect(one.sql).toContain("kind = 'service_health'");
    expect(one.sql).toContain("kind = 'container_exit'");
    expect(one.sql.startsWith(`(${hostOnly}`)).toBe(true);
  });

  it('loadVisibleServiceRefs：正常返回集合，注册表抛错返回 null（fail-closed）', async () => {
    const request = { protocol: 'http', hostname: 'localhost', headers: {}, port: 8899 } as const;
    const ok = await loadVisibleServiceRefs({
      registry: { list: async () => ({ items: [{ sourceRef: 'docker:a' }, { sourceRef: 'docker:b' }] }) },
      request,
      source: 'test',
    });
    expect([...(ok ?? [])].sort()).toEqual(['docker:a', 'docker:b']);

    const failed: AlertEventVisibility = await loadVisibleServiceRefs({
      registry: {
        list: async () => {
          throw new Error('boom');
        },
      },
      request,
      source: 'test',
    });
    expect(failed).toBeNull();
  });
});