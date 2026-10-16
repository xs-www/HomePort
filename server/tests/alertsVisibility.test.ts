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
import type { HealthProbeResult } from '../src/modules/services/healthProbe.js';
import { maskRuleTarget, sumSuppressedVisible, alertEventVisibilityWhere, type AlertEventVisibility } from '../src/modules/alerts/service.js';
import type { AlertEventListResponse, AlertRuleView, AlertSummaryView } from '../src/modules/alerts/types.js';
import type { SystemSnapshot } from '../src/modules/system/types.js';
import { loadVisibleServiceRefs } from '../src/modules/visibility/serviceVisibility.js';
import { makeContainerList } from './support/serviceFixtures.js';

const SETUP_TOKEN = 'ALERT-VISIBILITY-SETUP-TOKEN';
const ADMIN_PASSWORD = 'AlertVisAdmin2026!';
const VIEWER_PASSWORD = 'AlertVisViewer2026!';

/** 服务名刻意独一无二：对整段 JSON 做 `not.toContain` 才有判别力。 */
const SERVICE_NAME = '绝密告警服务-Zx9-不得泄漏';
const CONTAINER_LABEL = '绝密容器-Q3-不得泄漏';
const GHOST_LABEL = '幽灵服务-不得泄漏';
const DISK_LABEL = 'C:';
/** 第二组夹具：专门用来把 suppressed 压出非零值、并把规则 target 指向它。 */
const SUPPRESSED_NAME = '被压掉的绝密服务-Sx4-不得泄漏';
/** 第三组夹具：只用来验规则 target 的遮蔽（隐藏/删除/fail-closed）。 */
const RULE_TARGET_NAME = '规则目标绝密服务-Rt6-不得泄漏';

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

  it('maskRuleTarget / sumSuppressedVisible：宿主自有放行，服务类按可见集合，未知前缀 fail-closed', () => {
    const visible = new Set(['docker:gitea']);

    // 宿主自有（磁盘/内存）与"未限定目标"原样放行
    expect(maskRuleTarget('disk:C:', visible)).toBe('disk:C:');
    expect(maskRuleTarget('host', visible)).toBe('host');
    expect(maskRuleTarget(null, visible)).toBeNull();
    // 服务类：可见 → 原样；不可见 / 空集合 / 注册表不可用（fail-closed）→ null
    expect(maskRuleTarget('service:docker:gitea', visible)).toBe('service:docker:gitea');
    expect(maskRuleTarget('container:docker:gitea', visible)).toBe('container:docker:gitea');
    expect(maskRuleTarget('service:docker:secret', visible)).toBeNull();
    expect(maskRuleTarget('service:docker:gitea', new Set())).toBeNull();
    expect(maskRuleTarget('service:docker:gitea', null)).toBeNull();
    // 未知前缀（手工脏行）不是"宿主自有"，同样遮蔽：宁可少显示，也不泄露一行
    expect(maskRuleTarget('weird:secret', visible)).toBeNull();

    const byTarget: Array<readonly [string, number]> = [['disk:C:', 2], ['host', 1], ['service:docker:gitea', 3], ['service:docker:secret', 5]];
    expect(sumSuppressedVisible(byTarget, visible)).toBe(6);
    expect(sumSuppressedVisible(byTarget, new Set())).toBe(3);
    expect(sumSuppressedVisible(byTarget, null)).toBe(3);
    // 非有限值 / 非正值不入账
    expect(sumSuppressedVisible([['disk:C:', Number.NaN], ['disk:C:', -1], ['disk:C:', 2]], visible)).toBe(2);
  });
});

/* ==================================================================== *
 * 复审驳回的两项 P1（同一组收口，2026-10 追加）
 *
 * 1. `suppressed` 不能只报一个"全局总数"：隐藏/删除的服务每被压掉一次都会让它涨，
 *    数字本身就成了存在性证据。要求：非零夹具 + 隐藏/删除/fail-closed 全覆盖。
 * 2. `rule.target` 里同样写着服务的稳定身份，viewer 读一次规则列表就能枚举隐藏服务。
 *
 * 这一组刻意走**真实调度器**（`handle.scheduler.tickOnce`）：suppressed 的唯一来源是
 * 引擎的记账，手工调 `recordTick` 只能测个空壳。
 *
 * ## 外部数据源必须全部换掉（复审驳回的阻断项：本组曾在默认 hookTimeout 下超时）
 *
 * `tickOnce` 一次会经三条路径读**外部世界**：宿主采样（`ctx.system.snapshot`）、
 * Docker（`ctx.containers.list`，发现与容器列表各一次）、HTTP 探测（`healthProbe`）。
 * 只换宿主快照时，剩下两条会真的去连宿主 Docker endpoint —— 在没有 Docker（或
 * Docker Desktop 抖动）的开发机上每轮 tick 都要等到超时，两次 tick 直接把
 * `beforeAll` 顶过 30s，于是整组 6 条 suppressed 用例全被跳过。
 *
 * 换法照抄 `schedulerIntegration.test.ts` / `metricsApi.test.ts` 的既有三件套，
 * 只把**外部世界**换掉，被测逻辑一行不动（四个替换点见 `isolateTickDataSources`）：
 * - `ctx.system.snapshot` → 假宿主快照（内存 95%，本组 suppressed 的宿主来源）；
 * - `ctx.containers.list` → `makeContainerList([], { dockerAvailable: false })`
 *   （本组不测容器，容器维度明确"不可用"）；
 * - `ctx.services` → **保持生产那一个实例**（这正是被审的地方）：它是
 *   `repository.listAll()` 读 DB + `role='viewer'` 过滤，本身不产生任何外部调用
 *   （发现与容器列表走上面那个假 `containers`），因此隐藏/删除**立刻**反映到
 *   可见集合里 —— 换成静态 `EMPTY_SERVICES` 会把"按可见性求和"这件事架空；
 * - 健康监视器的**探测** → 注入的固定 `fail`（监视器实例本身仍是生产那一个，
 *   状态机与连续失败计数都是真的）。于是本组每轮 tick 是**零出站请求**，
 *   不靠"回环端口恰好连不上"这种宿主相关的巧合。
 * ==================================================================== */

/** 固定的 unix 秒刻度（不依赖墙钟；只用于 duration/silence 比较）。 */
const TICK_1 = 1_700_006_000;
const TICK_2 = TICK_1 + 60;
const TICK_3 = TICK_2 + 60;
const FIXTURE_ISO = '2026-10-15T00:00:00.000Z';

/**
 * 本组两轮 `tickOnce` 的墙钟耗时（ms）。
 *
 * 复审驳回的症状是"这个 `beforeAll` 被外部数据源顶过 30s 的 `hookTimeout`，整组被跳过"。
 * 隔离修好之后，两轮 tick 只做内存与 SQLite 的活，实测在毫秒量级。把耗时记下来并在
 * 夹具自检里断言一个**宽松但有判别力**的上界：真去连 Docker（单次 30s 级超时）必然撞破它，
 * 而正常实现离它两个数量级。这样"跑得快"不是靠 reviewer 看时间戳，而是用例本身在管。
 */
let lastTickMs = 0;
/** 两轮 tick 的耗时上界（ms）：正常 ~10²ms，连一次真 Docker 就是 10⁴ms 级。 */
const TICK_BUDGET_MS = 5_000;

/** 假宿主读数：内存百分比可控，用来让 `memory_percent` 规则稳定触发（它是宿主自有目标）。 */
function fakeSystemSnapshot(memoryPercent: number): SystemSnapshot {
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
      percent: memoryPercent,
      cachedBytes: 0,
      swapUsedBytes: 0,
      swapTotalBytes: 0,
    },
    // 不提供磁盘读数：本组只靠内存（宿主自有）与服务（服务类）两个来源区分贡献
    disks: [],
    gpu: null,
    sources: {
      cpu: { available: true, mode: 'host-proc', detail: null },
      memory: { available: true, mode: 'host-proc', detail: null },
      disk: { available: false, mode: 'none', detail: '测试夹具：不提供磁盘读数' },
      gpu: { available: false, mode: 'none', detail: null },
    },
  };
}

async function createService(displayName: string, healthTarget?: string): Promise<{ id: string; sourceRef: string }> {
  const response = await inject({
    method: 'POST',
    url: '/api/services',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: healthTarget === undefined ? { displayName } : { displayName, healthTarget },
  });
  expect(response.statusCode, response.body).toBe(201);
  const created = response.json() as { id: string; sourceRef: string };
  return created;
}

async function setVisibilityOf(id: string, visibility: 'visible' | 'hidden'): Promise<void> {
  const response = await inject({
    method: 'PATCH',
    url: `/api/services/${id}`,
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { visibility },
  });
  expect(response.statusCode, response.body).toBe(200);
  expect((response.json() as { visibility?: string }).visibility).toBe(visibility);
}

/** 手工服务是**真删**（自动服务才是改 hidden）：覆盖"已删除"这一条可见性判据。 */
async function deleteService(id: string): Promise<void> {
  const response = await inject({ method: 'DELETE', url: `/api/services/${id}`, cookie: admin.cookie, csrf: admin.csrf });
  expect(response.statusCode, response.body).toBe(200);
  expect((response.json() as { mode?: string }).mode).toBe('deleted');
}

async function patchRule(id: string, patch: Record<string, unknown>): Promise<void> {
  const response = await inject({
    method: 'PATCH',
    url: `/api/alerts/rules/${id}`,
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: patch,
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function getRules(client: Client): Promise<{ statusCode: number; body: string }> {
  const response = await inject({ method: 'GET', url: '/api/alerts/rules', cookie: client.cookie });
  return { statusCode: response.statusCode, body: response.body };
}

function rulesOf(body: string): AlertRuleView[] {
  return (JSON.parse(body) as { items: AlertRuleView[] }).items;
}

function ruleOf(items: AlertRuleView[], id: string): AlertRuleView {
  const found = items.find((rule) => rule.id === id);
  if (!found) throw new Error(`规则 ${id} 不在响应里`);
  return found;
}

/** 把注册表读路径打成"抛错"，验证 fail-closed（`try/finally` 里必须还原）。 */
function breakRegistry(): () => void {
  const original = handle.ctx.services.list.bind(handle.ctx.services);
  handle.ctx.services.list = async () => {
    throw new Error('registry down（测试夹具）');
  };
  return () => {
    handle.ctx.services.list = original;
  };
}

/**
 * 本组专用的外部世界隔离（换法照抄 `schedulerIntegration.test.ts` 的三件套，
 * 外加一个注入探测）。
 *
 * 为什么在组内装而不是全局装：只有本组真的跑 `tickOnce`。装在这里，别的组
 * （包括那条"把注册表换成抛错桩"的 fail-closed 用例）读路径行为一个字不变。
 *
 * 四件事，全部只换"外部世界"，被测逻辑一行不动：
 * 1. `ctx.system.snapshot` → 假宿主快照（内存 95%，本组 suppressed 的宿主来源）；
 * 2. `ctx.containers.list` → 容器列表明确为空且"Docker 不可用"。
 *    这正是复审驳回的阻断项：原来只换宿主快照，`tickOnce` 仍会经这里去连宿主
 *    Docker endpoint，在没有 Docker 的开发机上每轮等到超时，两轮把 `beforeAll` 顶过
 *    30s `hookTimeout`，整组 6 条 suppressed 用例全被跳过；
 * 3. `ctx.services`（可见性来源）→ **保持生产那一个实例**：`loadVisibleServiceRefs`
 *    与健康监视器读的都是同一个注册表对象，而 `serviceRegistry.list()` 本身不产生
 *    外部调用（发现与容器列表走上面那个假 `containers`），因此隐藏/删除**立刻**
 *    反映到可见集合里。换成静态 `EMPTY_SERVICES` 会把"按可见性求和"这件事架空；
 * 4. 健康监视器的**探测** → 注入的固定 `fail`（见 `overrideHealthProbe`）：
 *    监视器仍是生产那一个实例（状态机、连续失败计数、`visibleRefs` 都是真的），
 *    只把"探测结果从哪来"换掉，于是每轮 tick 零出站请求、也不依赖"回环端口恰好
 *    连不上"这种宿主相关的巧合。
 */
/**
 * 把健康监视器的**探测**换成注入实现，返回还原函数。
 *
 * 为什么改 `deps.probe` 而不是 `handle.health = new HealthMonitor(...)`：调度器与
 * 告警快照来源在装配期就捕获了那个 `HealthMonitor` **实例**，换 `handle` 上的引用
 * 对它们无效（实测：换完仍然走真实探测）。`deps` 上的字段是同一个对象上的方法，
 * 换它才对所有持有者生效 —— 与 `schedulerIntegration.test.ts` 换 `ctx.containers.list`
 * 是同一条思路，只是这里要够到的是私有依赖，所以用一次结构化断言（`src` 不动）。
 *
 * 换的只有"探测结果从哪来"；健康状态机、连续失败计数、规则评估、记账全是真的。
 */
function overrideHealthProbe(probe: (target: string) => Promise<HealthProbeResult>): () => void {
  const deps = (handle.health as unknown as { deps: { probe: (target: string, options?: { timeoutMs?: number }) => Promise<HealthProbeResult> } }).deps;
  const original = deps.probe;
  deps.probe = (target: string) => probe(target);
  return () => {
    deps.probe = original;
  };
}

/** 本组注入的探测结果：恒失败（"这个服务连续探测不通"）。**不发出站请求**。 */
async function failingProbe(): Promise<HealthProbeResult> {
  return {
    state: 'fail',
    statusCode: null,
    durationMs: 0,
    detail: '测试夹具：探测注入为失败（不发出站请求）',
    at: FIXTURE_ISO,
  };
}

function isolateTickDataSources(): { restore: () => void } {
  const realSnapshot = handle.ctx.system.snapshot;
  const realContainersList = handle.ctx.containers.list;
  const realProbeIntervalSec = handle.config.health.probeIntervalSec;
  handle.ctx.system.snapshot = async () => fakeSystemSnapshot(95);
  // 假夹具：本组不测容器，容器维度明确"不可用"。三个持有者（注册表 / 健康监视器 /
  // 告警快照）拿到的都是 `ctx.containers` 这**同一个对象**，所以换这一处就全换了。
  handle.ctx.containers.list = (async () => makeContainerList([], { dockerAvailable: false })) as typeof handle.ctx.containers.list;
  // 探测节流钉成 1s：间隔为 0 时监视器**根本不会排上探测**，服务就永远拿不到
  // "连续失败"，本组会静默退化成 0 并失去判别力。这是"把输入的隐性来源显式钉住"，
  // 与 `schedulerIntegration.test.ts` 钉 `sampleIntervalSec` 同一个理由。
  handle.config.health.probeIntervalSec = 1;
  const restoreProbe = overrideHealthProbe(failingProbe);
  return {
    restore: () => {
      restoreProbe();
      handle.ctx.system.snapshot = realSnapshot;
      handle.ctx.containers.list = realContainersList;
      handle.config.health.probeIntervalSec = realProbeIntervalSec;
    },
  };
}

describe('告警读接口 · suppressed 按可见性求和（非零夹具 + 隐藏/删除/fail-closed）', () => {
  let suppressedServiceId: string;
  let suppressedRef: string;
  let restoreSources: (() => void) | null = null;

  beforeAll(async () => {
    // 一个健康探测被注入成"一直失败"的服务 + 两条规则显式打开
    // （healthTarget 仍然填了真实形态的回环地址：它只是"这个服务有健康目标"的配置证据，
    //  探测本身由 isolateTickDataSources 注入，不会真的发出站请求）
    const created = await createService(SUPPRESSED_NAME, 'http://127.0.0.1:1/');
    suppressedServiceId = created.id;
    suppressedRef = created.sourceRef;

    // 宿主自有来源：内存 95% 让 memory_percent 规则触发（默认关闭，这里显式打开）；
    // 同时把 Docker 与宿主采样换成假夹具（见 isolateTickDataSources 的注释）
    const restore = isolateTickDataSources().restore;
    restoreSources = restore;
    await patchRule('rule-memory-percent', { enabled: true, threshold: 1, durationSec: 0 });
    await patchRule('rule-service-health', { enabled: true, threshold: 1, durationSec: 0 });

    // 第一轮：两条规则各开一个 episode（宿主内存 + 该服务）
    // 第二轮：两条都已有未恢复行 → 各被压掉 1 次（这才是 suppressed 的唯一来源）
    // 两轮一起计时：这个数字是本组"确实只做内存 + SQLite 的活"的证据（见 TICK_BUDGET_MS）
    const tickStartedAt = Date.now();
    await handle.scheduler.tickOnce(TICK_1);
    await handle.scheduler.tickOnce(TICK_2);
    lastTickMs = Date.now() - tickStartedAt;
  });

  afterAll(() => {
    restoreSources?.();
    restoreSources = null;
  });

  it('夹具自检：压掉次数非零，且按 target 归因正确（宿主 1 + 该服务 1）', async () => {
    const last = handle.scheduler.lastSummary()?.alerts;
    expect(last?.suppressed).toBe(2);
    expect(last?.suppressedByTarget).toEqual({ host: 1, [`service:${suppressedRef}`]: 1 });
    // 隔离自检：两轮 tick 的墙钟耗时必须在预算内。真的去连宿主 Docker endpoint
    // （单次超时就 10⁴ms 级）必然撞破它 —— 复审驳回的正是"`beforeAll` 撞 30s
    // `hookTimeout`、6 条 suppressed 用例全被跳过"这个症状
    expect(lastTickMs, '两轮 tick 必须只做内存 + SQLite 的活（外部数据源已全部换掉）').toBeLessThan(TICK_BUDGET_MS);

    const body = (await getSummary(viewer)).body;
    // 判别力前提：数字必须非零，否则"按可见性求和"这件事根本测不到（0 怎么过滤都是 0）
    expect(summaryOf(body).suppressed).toBe(2);
    expect(body).toContain(`"suppressed":2`);
    expect(summaryOf((await getSummary(admin)).body).suppressed).toBe(2);
  });

  it('隐藏后：该服务的贡献从数字里消失（宿主贡献留着，数字不是被清零）', async () => {
    await setVisibilityOf(suppressedServiceId, 'hidden');

    const body = (await getSummary(viewer)).body;
    expect(summaryOf(body).suppressed).toBe(1);
    expect(body).not.toContain(SUPPRESSED_NAME);
    expect(body).not.toContain(suppressedRef);
    // 同一口径：admin 与 viewer 拿到同一个数字（与 /events、/summary、/api/metrics/* 一致）
    expect(summaryOf((await getSummary(admin)).body).suppressed).toBe(1);

    // 隐藏不改写历史：事件行仍在库里、仍是"未恢复"（引擎不假恢复）
    const row = handle.db.prepare('SELECT resolved_at FROM alert_events WHERE target = ?').get(`service:${suppressedRef}`) as
      | { resolved_at: string | null }
      | undefined;
    expect(row).toBeTruthy();
    expect(row?.resolved_at).toBeNull();
  });

  it('隐藏之后继续 tick：隐藏目标一次都不再计入（累计值仍等于宿主贡献）', async () => {
    await handle.scheduler.tickOnce(TICK_3);

    // 本轮只有宿主内存被压掉：隐藏目标既没被评估、更没进任何数字
    const last = handle.scheduler.lastSummary()?.alerts;
    expect(last?.suppressed).toBe(1);
    expect(last?.suppressedByTarget).toEqual({ host: 1 });
    // 累计：宿主 2 次 + 该服务 1 次（后者必须被剔除）
    expect(summaryOf((await getSummary(viewer)).body).suppressed).toBe(2);
  });

  it('恢复可见后：同一个数字原样回来（宿主 2 + 该服务 1）', async () => {
    await setVisibilityOf(suppressedServiceId, 'visible');
    expect(summaryOf((await getSummary(viewer)).body).suppressed).toBe(3);
  });

  it('删除后：贡献再次消失（删除与隐藏走同一条可见性判据）', async () => {
    await deleteService(suppressedServiceId);

    const body = (await getSummary(viewer)).body;
    expect(summaryOf(body).suppressed).toBe(2);
    expect(body).not.toContain(SUPPRESSED_NAME);
    expect(body).not.toContain(suppressedRef);
  });

  it('注册表读失败：suppressed fail-closed（只计宿主自有目标，服务类一律剔除）', async () => {
    const restore = breakRegistry();
    try {
      const body = (await getSummary(viewer)).body;
      expect(summaryOf(body).suppressed).toBe(2);
    } finally {
      restore();
    }
    // 还原后仍是 2（该服务已删，宿主贡献 2 是稳定值）
    expect(summaryOf((await getSummary(viewer)).body).suppressed).toBe(2);
  });
});

describe('告警读接口 · 规则 target 对 viewer 遮蔽 / 对 admin 保留真值（隐藏/删除/fail-closed）', () => {
  let targetServiceId: string;
  let targetRef: string;

  beforeAll(async () => {
    const created = await createService(RULE_TARGET_NAME);
    targetServiceId = created.id;
    targetRef = created.sourceRef;

    // 四条内置规则各挂一个 target：两条服务类（要遮蔽）+ 两条宿主类（不受影响）
    await patchRule('rule-service-health', { target: `service:${targetRef}` });
    await patchRule('rule-container-exit', { target: `container:${targetRef}` });
    await patchRule('rule-disk-percent', { target: `disk:${DISK_LABEL}` });
    await patchRule('rule-memory-percent', { target: 'host' });
  });

  it('可见时：服务/容器类 target 原样返回，宿主类不受影响，形状仍是冻结的 13 字段', async () => {
    const response = await getRules(viewer);
    expect(response.statusCode, response.body).toBe(200);
    const items = rulesOf(response.body);

    expect(items).toHaveLength(4);
    expect(Object.keys(ruleOf(items, 'rule-service-health')).sort()).toEqual([
      'builtin',
      'description',
      'durationSec',
      'enabled',
      'id',
      'kind',
      'name',
      'notifyRecovery',
      'severity',
      'silenceSec',
      'target',
      'threshold',
      'updatedAt',
    ]);
    expect(ruleOf(items, 'rule-service-health').target).toBe(`service:${targetRef}`);
    expect(ruleOf(items, 'rule-container-exit').target).toBe(`container:${targetRef}`);
    expect(ruleOf(items, 'rule-disk-percent').target).toBe(`disk:${DISK_LABEL}`);
    expect(ruleOf(items, 'rule-memory-percent').target).toBe('host');
    expect(response.body).toContain(targetRef);
  });

  it('隐藏后：服务/容器类 target 变成 null（不是占位符），整段 JSON 里没有它的名字与身份', async () => {
    await setVisibilityOf(targetServiceId, 'hidden');

    const response = await getRules(viewer);
    const items = rulesOf(response.body);
    expect(ruleOf(items, 'rule-service-health').target).toBeNull();
    expect(ruleOf(items, 'rule-container-exit').target).toBeNull();
    // 宿主自有目标与可见性无关：照常返回
    expect(ruleOf(items, 'rule-disk-percent').target).toBe(`disk:${DISK_LABEL}`);
    expect(ruleOf(items, 'rule-memory-percent').target).toBe('host');
    expect(response.body).not.toContain(targetRef);
    expect(response.body).not.toContain(RULE_TARGET_NAME);

    // admin 保留真值：规则是 admin 自己写的**配置**，对作者本人遮蔽保护不了任何东西，
    // 只会让界面说假话（`AlertRuleForm` 把空 target 渲染成"· 适用于全部目标"）。
    // 配置类接口区分角色，与 `/events`、`/summary`、`/api/metrics/*` 的"不分角色"
    // 是两套口径（见 `api/alerts.ts` 文件头）。
    const adminBody = (await getRules(admin)).body;
    expect(ruleOf(rulesOf(adminBody), 'rule-service-health').target).toBe(`service:${targetRef}`);
    expect(ruleOf(rulesOf(adminBody), 'rule-container-exit').target).toBe(`container:${targetRef}`);
    expect(adminBody).toContain(targetRef);
  });

  it('注册表读失败：fail-closed（服务类 target 一律 null，宿主类照常）', async () => {
    const restore = breakRegistry();
    try {
      const response = await getRules(viewer);
      expect(response.statusCode, response.body).toBe(200);
      const items = rulesOf(response.body);
      expect(ruleOf(items, 'rule-service-health').target).toBeNull();
      expect(ruleOf(items, 'rule-container-exit').target).toBeNull();
      expect(ruleOf(items, 'rule-disk-percent').target).toBe(`disk:${DISK_LABEL}`);
      expect(ruleOf(items, 'rule-memory-percent').target).toBe('host');
      expect(response.body).not.toContain(targetRef);

      // admin 的读**根本不看可见集合** ⇒ 注册表挂了也不影响他。
      // 这不是 fail-open，而是那条路径压根不读这份数据（角色分支在路由层就分开了）。
      const adminItems = rulesOf((await getRules(admin)).body);
      expect(ruleOf(adminItems, 'rule-service-health').target).toBe(`service:${targetRef}`);
      expect(ruleOf(adminItems, 'rule-container-exit').target).toBe(`container:${targetRef}`);
    } finally {
      restore();
    }
  });

  it('恢复可见后：target 原样回来（遮蔽是读时求值，没动库里的配置）', async () => {
    await setVisibilityOf(targetServiceId, 'visible');

    const items = rulesOf((await getRules(viewer)).body);
    expect(ruleOf(items, 'rule-service-health').target).toBe(`service:${targetRef}`);
    expect(ruleOf(items, 'rule-container-exit').target).toBe(`container:${targetRef}`);

    // 库里的行从来没被改写：读路径遮蔽不是"把配置清空"
    const stored = handle.db.prepare('SELECT target FROM alert_rules WHERE id = ?').get('rule-service-health') as { target: string | null };
    expect(stored.target).toBe(`service:${targetRef}`);
  });

  it('删除后：target 再次遮蔽（已删除的服务不能靠规则配置被枚举出来）', async () => {
    await deleteService(targetServiceId);

    const response = await getRules(viewer);
    const items = rulesOf(response.body);
    expect(ruleOf(items, 'rule-service-health').target).toBeNull();
    expect(ruleOf(items, 'rule-container-exit').target).toBeNull();
    expect(ruleOf(items, 'rule-disk-percent').target).toBe(`disk:${DISK_LABEL}`);
    expect(response.body).not.toContain(targetRef);
    expect(response.body).not.toContain(RULE_TARGET_NAME);

    // 服务被真删之后 admin 仍见真值：他读的是**自己写的配置**，不是"当前可发现的服务"
    const adminItems = rulesOf((await getRules(admin)).body);
    expect(ruleOf(adminItems, 'rule-service-health').target).toBe(`service:${targetRef}`);
    expect(ruleOf(adminItems, 'rule-container-exit').target).toBe(`container:${targetRef}`);
  });
});