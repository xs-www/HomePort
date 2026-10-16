/**
 * 告警 API 的端到端测试（Sprint 2 §7 / §10）。
 *
 * 真实 app（真实路由 + 真实鉴权 + 真实 CSRF + 真实 SQLite，跑完整迁移 v5），
 * 五个域全部由 `api/index.ts` 的 `PROTECTED_PREFIXES` 装配（**都是真的**）。
 *
 * 只额外挂两件"故意配错"的东西，用来证明路由自身的兜底不依赖装配方：
 * - `/api/alerts-unwired`：同一套告警路由，没有统一守卫；
 * - `/api/health/monitor-unwired`：没有监视器的健康路由（503 路径）。
 *
 * 权限三件事必须为真：匿名 401 / viewer 写 403 / 缺 CSRF 403。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppHandle } from '../src/app.js';
import { composeAlertSummary, registerAlertRoutes } from '../src/api/alerts.js';
import { registerHealthMonitorRoutes } from '../src/api/healthMonitor.js';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import { AuditRepository } from '../src/db/users.js';
import { ServicesRepository } from '../src/db/services.js';
import type { AlertEventListResponse, AlertRuleListResponse, AlertRuleView, AlertSummaryView } from '../src/modules/alerts/types.js';
import type { HealthMonitorView } from '../src/modules/health/types.js';

const SETUP_TOKEN = 'ALERTS-SETUP-TOKEN';
const ADMIN_PASSWORD = 'AlertsAdmin2026!';
const VIEWER_PASSWORD = 'AlertsViewer2026!';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-alerts-'));

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

const T0_ISO = '2026-10-15T10:00:00.000Z';

let handle: AppHandle;
let app: FastifyInstance;
let audit: AuditRepository;

/** 健康监控视图（真实监视器：本仓库的 `handle.health`，没有任何 tick 时是空视图）。 */
const EMPTY_PROBE = { intervalSec: 300, concurrency: 4, inFlight: 0, lastRunAt: null, probedThisTick: 0, skippedForConcurrency: 0 };

let ipCounter = 30;
function nextIp(): string {
  ipCounter += 1;
  return `10.30.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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

/** 预置一条事件行（episode）——API 只读，所以夹具直接落库。 */
function seedEvent(input: {
  id: string;
  ruleId?: string;
  kind?: string;
  ruleName?: string;
  target: string;
  targetLabel?: string;
  severity?: 'warning' | 'critical';
  value?: number | null;
  unit?: string | null;
  message?: string;
  firedAt: string;
  resolvedAt?: string | null;
  reopenCount?: number;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
}): void {
  handle.db
    .prepare(
      `INSERT INTO alert_events (
         id, rule_id, kind, rule_name, target, target_label, severity, value, threshold, unit,
         message, started_at, fired_at, resolved_at, reopen_count, acknowledged_at, acknowledged_by, created_at
       ) VALUES (
         @id, @ruleId, @kind, @ruleName, @target, @targetLabel, @severity, @value, 85, @unit,
         @message, @firedAt, @firedAt, @resolvedAt, @reopenCount, @acknowledgedAt, @acknowledgedBy, @firedAt
       )`,
    )
    .run({
      id: input.id,
      ruleId: input.ruleId ?? 'rule-disk-percent',
      kind: input.kind ?? 'disk_percent',
      ruleName: input.ruleName ?? '磁盘使用率过高',
      target: input.target,
      targetLabel: input.targetLabel ?? 'C:',
      severity: input.severity ?? 'warning',
      value: input.value ?? 92,
      unit: input.unit ?? 'percent',
      message: input.message ?? '磁盘 C: 使用率 92%（阈值 85%）',
      firedAt: input.firedAt,
      resolvedAt: input.resolvedAt ?? null,
      reopenCount: input.reopenCount ?? 0,
      acknowledgedAt: input.acknowledgedAt ?? null,
      acknowledgedBy: input.acknowledgedBy ?? null,
    });
}

function listRules(client: Client): Promise<{ statusCode: number; body: string; json: AlertRuleListResponse }> {
  return inject({ method: 'GET', url: '/api/alerts/rules', cookie: client.cookie }).then((response) => ({
    statusCode: response.statusCode,
    body: response.body,
    json: response.statusCode === 200 ? (response.json() as AlertRuleListResponse) : { items: [] },
  }));
}

async function listEvents(query = ''): Promise<AlertEventListResponse> {
  const response = await inject({ method: 'GET', url: `/api/alerts/events${query}`, cookie: viewer.cookie });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as AlertEventListResponse;
}

async function patchRule(id: string, body: unknown, client: Client = admin): Promise<{ statusCode: number; body: string; json: AlertRuleView | null }> {
  const response = await inject({ method: 'PATCH', url: `/api/alerts/rules/${id}`, cookie: client.cookie, csrf: client.csrf, body });
  return {
    statusCode: response.statusCode,
    body: response.body,
    json: response.statusCode === 200 ? (response.json() as AlertRuleView) : null,
  };
}

beforeAll(async () => {
  handle = await buildApp({
    config: testConfig,
    logger: createSilentLogger(),
    dbPath: ':memory:',
    serveStatic: false,
    sessionCleanupIntervalMs: 0,
  });
  app = handle.app;
  audit = new AuditRepository(handle.db);

  // 健康监控域：`/api/health/monitor` 已由 api/index.ts 的 PROTECTED_PREFIXES 注册（真实监视器）。
  // 这里额外挂一条**没装配监视器**的同款前缀，用来覆盖 503 兜底与自定义守卫
  // （不给它任何统一守卫，证明路由自带的 viewer + CSRF 钩子独立成立）。
  app.register(
    async (scope) => {
      registerHealthMonitorRoutes(scope, {}, { health: null });
    },
    { prefix: '/api/health/monitor-unwired' },
  );

  // 告警域：故意**再注册一次**同一套路由（独立前缀），用来证明路由自带兜底守卫 ——
  // 即使 api/index.ts 漏了 PROTECTED_PREFIXES 条目，也不会匿名开放。
  // 第二个参数传真实 ctx（与生产同一条路径），于是它的可见性过滤也真的生效。
  app.register(
    async (scope) => {
      registerAlertRoutes(scope, handle.ctx, { alerts: handle.alerts });
    },
    { prefix: '/api/alerts-unwired' },
  );

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
});

afterAll(async () => {
  await handle.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('告警 API · 鉴权与 CSRF（§7）', () => {
  it('匿名访问所有告警/健康接口 → 401（不是空列表、不是 404）', async () => {
    for (const options of [
      { method: 'GET', url: '/api/alerts/rules' },
      { method: 'GET', url: '/api/alerts/events' },
      { method: 'GET', url: '/api/alerts/summary' },
      { method: 'PATCH', url: '/api/alerts/rules/rule-disk-percent', body: { enabled: true } },
      { method: 'POST', url: '/api/alerts/events/some-id/ack' },
      { method: 'GET', url: '/api/health/monitor' },
    ] satisfies InjectOptions[]) {
      const response = await inject(options);
      expect(response.statusCode, `${options.method} ${options.url}`).toBe(401);
    }
  });

  it('viewer 可以读；viewer 的写操作 → 403', async () => {
    const rules = await listRules(viewer);
    expect(rules.statusCode, rules.body).toBe(200);
    expect(rules.json.items).toHaveLength(4);

    expect((await inject({ method: 'GET', url: '/api/alerts/events', cookie: viewer.cookie })).statusCode).toBe(200);
    expect((await inject({ method: 'GET', url: '/api/alerts/summary', cookie: viewer.cookie })).statusCode).toBe(200);

    const patch = await patchRule('rule-disk-percent', { enabled: true }, viewer);
    expect(patch.statusCode, patch.body).toBe(403);

    const ack = await inject({ method: 'POST', url: '/api/alerts/events/none/ack', cookie: viewer.cookie, csrf: viewer.csrf });
    expect(ack.statusCode, ack.body).toBe(403);
  });

  it('admin 写操作缺 CSRF → 403（且不落库）', async () => {
    const response = await inject({ method: 'PATCH', url: '/api/alerts/rules/rule-disk-percent', cookie: admin.cookie, body: { enabled: true } });
    expect(response.statusCode, response.body).toBe(403);
    const row = handle.db.prepare('SELECT enabled FROM alert_rules WHERE id = ?').get('rule-disk-percent') as { enabled: number };
    expect(row.enabled).toBe(0);
  });

  it('即使某个前缀漏了 PROTECTED_PREFIXES，路由自带的兜底守卫仍然要求登录', async () => {
    // /api/alerts-unwired 不在 PROTECTED_PREFIXES 里，只有路由自带的钩子
    expect((await inject({ method: 'GET', url: '/api/alerts-unwired/rules' })).statusCode).toBe(401);
    const ok = await inject({ method: 'GET', url: '/api/alerts-unwired/rules', cookie: viewer.cookie });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('告警 API · GET /api/alerts/rules（§7 冻结形状）', () => {
  it('响应体是 { items } 且每条规则恰好 13 个字段（没有 createdAt 这类内部列）', async () => {
    const rules = await listRules(admin);
    expect(rules.statusCode, rules.body).toBe(200);
    expect(Object.keys(rules.json)).toEqual(['items']);
    expect(rules.json.items).toHaveLength(4);

    const first = rules.json.items[0]!;
    expect(Object.keys(first).sort()).toEqual([
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
    expect(Object.keys(first)).not.toContain('createdAt');
    expect(first.enabled).toBe(false);
    expect(first.builtin).toBe(true);
  });

  it('四条规则的阈值/时长/静默期/严重级与 §2.3 一致', async () => {
    const rules = (await listRules(admin)).json.items;
    const byId = new Map(rules.map((rule) => [rule.id, rule]));

    expect(byId.get('rule-disk-percent')).toMatchObject({ kind: 'disk_percent', threshold: 85, durationSec: 600, silenceSec: 3600, severity: 'warning' });
    expect(byId.get('rule-memory-percent')).toMatchObject({ kind: 'memory_percent', threshold: 90, durationSec: 300, severity: 'warning' });
    expect(byId.get('rule-container-exit')).toMatchObject({ kind: 'container_exit', threshold: 0, durationSec: 0, severity: 'critical' });
    expect(byId.get('rule-service-health')).toMatchObject({ kind: 'service_health', threshold: 3, severity: 'critical' });
    expect(rules.every((rule) => rule.notifyRecovery)).toBe(true);
  });
});

describe('告警 API · PATCH /api/alerts/rules/:id（§5.3 / §7）', () => {
  it('管理员开启规则并改阈值 → 200，落库，写审计，且立刻反映到 GET', async () => {
    const patched = await patchRule('rule-disk-percent', { enabled: true, threshold: 90 });
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json).toMatchObject({ id: 'rule-disk-percent', enabled: true, threshold: 90 });

    const row = handle.db.prepare('SELECT enabled, threshold, updated_at FROM alert_rules WHERE id = ?').get('rule-disk-percent') as {
      enabled: number;
      threshold: number;
      updated_at: string;
    };
    expect(row.enabled).toBe(1);
    expect(row.threshold).toBe(90);
    expect(patched.json?.updatedAt).toBe(row.updated_at);

    const entry = audit.list(20).find((item) => item.action === 'alert.rule_updated');
    expect(entry, '缺 alert.rule_updated 审计').toBeDefined();
    expect(entry?.actorName).toBe('admin');
    expect(entry?.target).toBe('alert_rule:rule-disk-percent'); // 审计 target 带域前缀（与既有 service:<id> 一致）
    expect(JSON.parse(entry?.detail ?? '{}')).toMatchObject({ enabled: true, threshold: 90 });

    const after = (await listRules(admin)).json.items.find((rule) => rule.id === 'rule-disk-percent');
    expect(after).toMatchObject({ enabled: true, threshold: 90 });

    // 复原，避免影响后面的用例
    expect((await patchRule('rule-disk-percent', { enabled: false, threshold: 85 })).statusCode).toBe(200);
  });

  it('越界阈值 / 未知字段 / 空对象 → 400 VALIDATION_FAILED', async () => {
    for (const body of [{ threshold: 0 }, { threshold: 100.5 }, { durationSec: 86_401 }, { silenceSec: 59 }, { enabled: 'yes' }, { wat: 1 }, {}]) {
      const response = await inject({ method: 'PATCH', url: '/api/alerts/rules/rule-disk-percent', cookie: admin.cookie, csrf: admin.csrf, body });
      expect(response.statusCode, `${JSON.stringify(body)} → ${response.body}`).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    }
    // 业务级越界（按 kind 判断的那部分）也走 400
    const serviceThreshold = await inject({
      method: 'PATCH',
      url: '/api/alerts/rules/rule-service-health',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { threshold: 11 },
    });
    expect(serviceThreshold.statusCode, serviceThreshold.body).toBe(400);
    expect((serviceThreshold.json() as { error: { code: string; details: unknown } }).error.code).toBe('VALIDATION_FAILED');

    // 目标前缀与 kind 不同源 → 400
    const wrongTarget = await inject({
      method: 'PATCH',
      url: '/api/alerts/rules/rule-disk-percent',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { target: 'service:docker:gitea' },
    });
    expect(wrongTarget.statusCode, wrongTarget.body).toBe(400);
  });

  it('未知规则 → 404 NOT_FOUND', async () => {
    const response = await inject({
      method: 'PATCH',
      url: '/api/alerts/rules/rule-nope',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { enabled: true },
    });
    expect(response.statusCode, response.body).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('内置规则不可删除（接口没有 DELETE；PATCH 也不能改 id/kind）', async () => {
    const response = await inject({
      method: 'PATCH',
      url: '/api/alerts/rules/rule-disk-percent',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { id: 'other', kind: 'memory_percent' },
    });
    expect(response.statusCode, response.body).toBe(400);
    const row = handle.db.prepare('SELECT kind FROM alert_rules WHERE id = ?').get('rule-disk-percent') as { kind: string };
    expect(row.kind).toBe('disk_percent');
  });
});

describe('告警 API · GET /api/alerts/events（§7）', () => {
  beforeAll(() => {
    // 夹具前提：`ev-3` 的目标服务必须**真的存在且可见**。
    // 读路径现在按当前可见性过滤（服务被隐藏/删除后事件不再出现），而
    // `service:docker:gitea` 在无 Docker 的测试环境里若没有对应的服务行，
    // 就是"从未有可见服务"的目标 —— 那样下面的计数/排序断言就会测到另一件事。
    // 因此这里补一行可见的 docker 服务（SQL 直插：不加健康目标，不影响
    // /api/health/monitor 的空视图断言）。
    new ServicesRepository(handle.db).insert({
      id: 'svc-fixture-gitea',
      slug: 'gitea-fixture',
      displayName: 'Gitea',
      sourceType: 'docker',
      sourceRef: 'docker:gitea',
    });

    seedEvent({ id: 'ev-1', target: 'disk:C:', firedAt: '2026-10-15T09:00:00.000Z', severity: 'warning' });
    seedEvent({ id: 'ev-2', target: 'disk:D:', targetLabel: 'D:', firedAt: '2026-10-15T09:05:00.000Z', severity: 'critical' });
    seedEvent({
      id: 'ev-3',
      ruleId: 'rule-service-health',
      kind: 'service_health',
      ruleName: '服务连续不可用',
      target: 'service:docker:gitea',
      targetLabel: 'Gitea',
      firedAt: '2026-10-15T09:10:00.000Z',
      severity: 'critical',
      resolvedAt: '2026-10-15T09:20:00.000Z',
      acknowledgedAt: '2026-10-15T09:12:00.000Z',
      acknowledgedBy: 'admin',
    });
  });

  it('形状是 { items, total, counts }，counts 是全量计数（与 limit 无关）', async () => {
    const body = await listEvents();
    expect(Object.keys(body).sort()).toEqual(['counts', 'items', 'total']);
    expect(body.counts).toEqual({ open: 2, resolved: 1, unacknowledged: 2 });
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(3);

    const item = body.items[0]!;
    expect(Object.keys(item).sort()).toEqual([
      'acknowledgedAt',
      'acknowledgedBy',
      'firedAt',
      'id',
      'kind',
      'message',
      'reopenCount',
      'resolvedAt',
      'ruleId',
      'ruleName',
      'severity',
      'startedAt',
      'state',
      'target',
      'targetLabel',
      'threshold',
      'unit',
      'value',
    ]);
  });

  it('按 fired_at 倒序（最新在前）', async () => {
    const body = await listEvents();
    expect(body.items.map((item) => item.id)).toEqual(['ev-3', 'ev-2', 'ev-1']);
  });

  it('state 过滤：open / resolved / all', async () => {
    expect((await listEvents('?state=open')).items.map((item) => item.id)).toEqual(['ev-2', 'ev-1']);
    // resolved 也要参与 total/counts 的全量语义
    const resolved = await listEvents('?state=resolved');
    expect(resolved.items.map((item) => item.id)).toEqual(['ev-3']);
    expect(resolved.counts).toEqual({ open: 2, resolved: 1, unacknowledged: 2 });
    expect((await listEvents('?state=all')).items).toHaveLength(3);
  });

  it('limit 生效（截断 items，不动 counts/total）', async () => {
    const body = await listEvents('?limit=2');
    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.counts).toEqual({ open: 2, resolved: 1, unacknowledged: 2 });
  });

  it('非法 state / 越界 limit / 未知参数 → 400', async () => {
    for (const query of ['?state=nope', '?limit=0', '?limit=999', '?limit=abc', '?wat=1']) {
      const response = await inject({ method: 'GET', url: `/api/alerts/events${query}`, cookie: viewer.cookie });
      expect(response.statusCode, `${query} → ${response.body}`).toBe(400);
      expect((response.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('告警 API · POST /api/alerts/events/:id/ack（§5.3）', () => {
  it('管理员确认 → 200，落库并写审计；重复确认幂等（保留首次时间）', async () => {
    const first = await inject({ method: 'POST', url: '/api/alerts/events/ev-1/ack', cookie: admin.cookie, csrf: admin.csrf });
    expect(first.statusCode, first.body).toBe(200);
    const body = first.json() as { id: string; acknowledgedAt: string | null; acknowledgedBy: string | null };
    expect(body.id).toBe('ev-1');
    expect(body.acknowledgedBy).toBe('admin');
    expect(body.acknowledgedAt).toBeTypeOf('string');

    const row = handle.db.prepare('SELECT acknowledged_at, acknowledged_by FROM alert_events WHERE id = ?').get('ev-1') as {
      acknowledged_at: string;
      acknowledged_by: string;
    };
    expect(row.acknowledged_by).toBe('admin');
    expect(body.acknowledgedAt).toBe(row.acknowledged_at);

    const entry = audit.list(50).find((item) => item.action === 'alert.acknowledged');
    expect(entry, '缺 alert.acknowledged 审计').toBeDefined();
    expect(entry?.actorName).toBe('admin');
    expect(entry?.target).toBe('alert_event:ev-1');

    const second = await inject({ method: 'POST', url: '/api/alerts/events/ev-1/ack', cookie: admin.cookie, csrf: admin.csrf });
    expect(second.statusCode, second.body).toBe(200);
    expect((second.json() as { acknowledgedAt: string }).acknowledgedAt).toBe(row.acknowledged_at);

    // 确认后未确认计数减少
    const events = await listEvents();
    expect(events.counts.unacknowledged).toBe(1);
  });

  it('未知事件 → 404', async () => {
    const response = await inject({ method: 'POST', url: '/api/alerts/events/no-such-id/ack', cookie: admin.cookie, csrf: admin.csrf });
    expect(response.statusCode, response.body).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

describe('告警 API · GET /api/alerts/summary（§7）', () => {
  it('形状与计数：bySeverity、top（≤5，精简字段）、suppressed / evaluatedAt', async () => {
    const response = await inject({ method: 'GET', url: '/api/alerts/summary', cookie: viewer.cookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as AlertSummaryView;
    expect(Object.keys(body).sort()).toEqual(['bySeverity', 'evaluatedAt', 'open', 'suppressed', 'top', 'unacknowledged']);
    expect(body.open).toBe(2);
    expect(body.unacknowledged).toBe(1);
    expect(body.bySeverity).toEqual({ warning: 1, critical: 1 });
    expect(body.top).toHaveLength(2);
    expect(Object.keys(body.top[0]!).sort()).toEqual(['firedAt', 'id', 'ruleName', 'severity', 'targetLabel']);
    // critical 优先，其次 fired_at
    expect(body.top.map((item) => item.id)).toEqual(['ev-2', 'ev-1']);
    // 引擎还没 tick 过 → 没有评估时间；suppressed 为 0
    expect(body.evaluatedAt).toBeNull();
    expect(body.suppressed).toBe(0);
  });

  it('top 最多 5 条，且只含未恢复事件', async () => {
    for (let index = 0; index < 6; index += 1) {
      seedEvent({
        id: `ev-top-${index}`,
        target: `disk:T${index}:`,
        targetLabel: `T${index}:`,
        firedAt: `2026-10-15T08:0${index}:00.000Z`,
        severity: 'critical',
      });
    }
    const response = await inject({ method: 'GET', url: '/api/alerts/summary', cookie: viewer.cookie });
    const body = response.json() as AlertSummaryView;
    expect(body.top).toHaveLength(5);
    expect(body.top.every((item) => !item.id.startsWith('ev-3'))).toBe(true);

    // 清理，避免影响后续用例
    handle.db.prepare("DELETE FROM alert_events WHERE id LIKE 'ev-top-%'").run();
  });

  it('composeAlertSummary：装了引擎就用引擎的真实计数（suppressed / evaluatedAt），且 suppressed 按可见性求和', () => {
    const base: AlertSummaryView = {
      open: 1,
      unacknowledged: 1,
      suppressed: 0,
      bySeverity: { warning: 1, critical: 0 },
      top: [],
      evaluatedAt: null,
    };
    // 7 次压掉 = 宿主磁盘 5 次 + 某服务目标 2 次（后者要能被可见性剔掉）
    const engine = {
      lastTickAt: () => T0_ISO,
      suppressedByTarget: () => new Map<string, number>([['disk:C:', 5], ['service:docker:gitea', 2]]),
    };

    const composed = composeAlertSummary(base, engine, new Set(['docker:gitea']));
    expect(composed.suppressed).toBe(7);
    expect(composed.evaluatedAt).toBe(T0_ISO);
    expect(composed.open).toBe(1);

    // 目标不可见 / 注册表不可用（fail-closed）→ 只计宿主自有目标：
    // 数字里留着隐藏目标的贡献，等于用"suppressed 在涨"承认它存在
    expect(composeAlertSummary(base, engine, new Set()).suppressed).toBe(5);
    expect(composeAlertSummary(base, engine, null).suppressed).toBe(5);

    // 引擎在但还没 tick 过 → evaluatedAt 退回服务层的值
    expect(
      composeAlertSummary(
        { ...base, evaluatedAt: '2026-10-15T11:00:00.000Z' },
        { lastTickAt: () => null, suppressedByTarget: () => new Map() },
        null,
      ).evaluatedAt,
    ).toBe('2026-10-15T11:00:00.000Z');
    // 没引擎 → 原样返回
    expect(composeAlertSummary(base, null, null)).toBe(base);
  });
});

describe('告警 API · GET /api/health/monitor（§7）', () => {
  it('viewer 拿到监视器视图（真实形状，不做二次包装）', async () => {
    const response = await inject({ method: 'GET', url: '/api/health/monitor', cookie: viewer.cookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as HealthMonitorView;
    expect(Object.keys(body).sort()).toEqual(['generatedAt', 'notes', 'probe', 'services', 'thresholds']);
    expect(body.thresholds).toEqual({ failThreshold: 3, okThreshold: 2 });
    expect(body.probe).toEqual(EMPTY_PROBE);
    expect(body.services).toEqual([]);
    // 没有服务可监测时必须说明，而不是安静地返回空数组
    expect(body.notes.join(' ')).toContain('还没有可监测的服务');
    expect(body.generatedAt).toBeTypeOf('string');
  });

  it('带尾斜杠也能访问（前缀注册的 both 行为，与 /api/overview 一致）', async () => {
    expect((await inject({ method: 'GET', url: '/api/health/monitor/', cookie: viewer.cookie })).statusCode).toBe(200);
  });

  it('admin 与 viewer 看到的是同一份视图（只读，无角色差异）', async () => {
    const asViewer = await inject({ method: 'GET', url: '/api/health/monitor', cookie: viewer.cookie });
    const asAdmin = await inject({ method: 'GET', url: '/api/health/monitor', cookie: admin.cookie });
    // `generatedAt` 是生成时刻（两次请求必然不同），按契约它是"这次视图的新鲜度"而不是身份，
    // 因此比较其余部分；把 generatedAt 一起比会在毫秒边界上随机失败。
    const strip = (raw: string) => ({ ...(JSON.parse(raw) as Record<string, unknown>), generatedAt: '<ignored>' });
    expect(strip(asAdmin.body)).toEqual(strip(asViewer.body));
  });

  it('监视器没装上 → 503 UPSTREAM_UNAVAILABLE（不谎报"全部健康"）', async () => {
    const response = await inject({ method: 'GET', url: '/api/health/monitor-unwired', cookie: viewer.cookie });
    expect(response.statusCode, response.body).toBe(503);
    expect((response.json() as { error: { code: string } }).error.code).toBe('UPSTREAM_UNAVAILABLE');
  });

  it('监视器域自带守卫：漏挂统一前缀也不会匿名开放', async () => {
    expect((await inject({ method: 'GET', url: '/api/health/monitor-unwired' })).statusCode).toBe(401);
  });
});

describe('告警 API · 内置规则补齐（§5.3）', () => {
  it('迁移不塞业务数据；ensureBuiltinRules 第一次补四条、第二次返回 0', async () => {
    // app 启动时已经补过一次：这里先清空，再从"空库"跑一遍完整流程
    handle.db.prepare('DELETE FROM alert_rules').run();
    expect((await listRules(admin)).json.items).toHaveLength(0);

    expect(handle.alerts.ensureBuiltinRules(T0_ISO)).toBe(4);
    expect(handle.alerts.ensureBuiltinRules(T0_ISO)).toBe(0);

    const rules = (await listRules(admin)).json.items;
    expect(rules).toHaveLength(4);
    expect(rules.every((rule) => rule.enabled === false)).toBe(true);
    expect(rules.map((rule) => rule.id)).toEqual([
      'rule-disk-percent',
      'rule-memory-percent',
      'rule-container-exit',
      'rule-service-health',
    ]);
  });

  it('补齐是幂等的：并发的两次补齐不会产生重复行', async () => {
    const results = await Promise.all([Promise.resolve(handle.alerts.ensureBuiltinRules(T0_ISO)), Promise.resolve(handle.alerts.ensureBuiltinRules(T0_ISO))]);
    expect(results).toEqual([0, 0]);
    expect((await listRules(admin)).json.items).toHaveLength(4);
  });
});