/**
 * 升级路径测试：**既有部署**（v2 库，无 TOTP）升级到 Sprint 0（v3）后，
 * 管理员、用户、设置（含已加密的敏感项）必须无损，且能正常登录。
 *
 * 做法是"真实回落"而不是造一个假库：
 *   1. 用当前代码建一个**文件库**（v3），写入管理员 / viewer / 一条普通设置 / 一条敏感设置；
 *   2. 用 SQLite 把库**退回 v2 形态** —— 删掉 v3 新增的 4 个列与 2 张表，
 *      并删除 `schema_migrations` 里 version=3 的记录；
 *   3. 用当前代码**重新启动**同一个文件库 → v3 迁移自动重放。
 *
 * 这样测的是「升级时真实发生的事」：迁移在**已有数据**上重放、密钥文件被复用、
 * 加密的敏感值仍能读出。比"新建空库跑一遍迁移"强得多。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import { createSecretBox, loadOrCreateKey } from '../src/modules/settings/secretBox.js';

const SETUP_TOKEN = 'MIGRATION-SETUP-TOKEN';
const ADMIN_PASSWORD = 'MigrationAdmin2026!';
const VIEWER_PASSWORD = 'MigrationViewer2026!';
const SENSITIVE_VALUE = 'tskey-api-migration-probe-1234';
const PLAIN_VALUE = 'before-upgrade.example';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-migrate-'));
const DB_PATH = path.join(TMP_DIR, 'portal.sqlite');

const config: PortalConfig = loadConfig({
  env: 'test',
  logLevel: 'error',
  dataDir: TMP_DIR,
  dbPath: DB_PATH,
  trustProxy: true,
  tailscale: { mode: 'off', bin: '', socket: '/nonexistent', apiToken: '', tailnet: '-', timeoutMs: 200 },
  bootstrap: { token: SETUP_TOKEN, tokenFile: path.join(TMP_DIR, 'setup-token.txt') },
  session: { ttlHours: 12, rememberTtlHours: 24, cookieName: 'hp_session' },
});

const logger = createSilentLogger();

async function startApp(): Promise<AppHandle> {
  const handle = await buildApp({
    config,
    logger,
    dbPath: DB_PATH,
    serveStatic: false,
    sessionCleanupIntervalMs: 0,
  });
  await handle.app.ready();
  return handle;
}

let ip = 20;
function inject(
  app: FastifyInstance,
  payload: { method: 'GET' | 'POST' | 'PATCH'; url: string; cookie?: string; csrf?: string; body?: unknown },
) {
  ip += 1;
  const headers: Record<string, string> = { 'x-forwarded-for': `10.11.0.${ip}` };
  if (payload.cookie) headers.cookie = payload.cookie;
  if (payload.csrf) headers['x-csrf-token'] = payload.csrf;
  return app.inject({
    method: payload.method,
    url: payload.url,
    headers,
    ...(payload.body === undefined ? {} : { payload: payload.body as object }),
  });
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const match = /(^|;\s*)(hp_session=[^;]*)/.exec(value);
    if (match?.[2]) return match[2];
  }
  throw new Error('登录响应里没有会话 Cookie');
}

let adminCookie = '';
let adminCsrf = '';

beforeAll(async () => {
  // ---- 阶段 1：升级前的状态（用当前代码建库，但只用到 v1/v2 的功能）----
  const before = await startApp();
  const app = before.app;

  const bootstrap = await inject(app, {
    method: 'POST',
    url: '/api/auth/bootstrap',
    body: { token: SETUP_TOKEN, username: 'admin', password: ADMIN_PASSWORD, displayName: '管理员' },
  });
  expect(bootstrap.statusCode).toBe(201);

  const login = await inject(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  adminCookie = cookieOf(login.headers['set-cookie']);
  adminCsrf = (login.json() as { csrfToken: string }).csrfToken;

  const viewer = await inject(app, {
    method: 'POST',
    url: '/api/users',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { username: 'viewer1', password: VIEWER_PASSWORD, displayName: '只读账号', role: 'viewer' },
  });
  expect(viewer.statusCode).toBe(201);

  const save = await inject(app, {
    method: 'PATCH',
    url: '/api/settings',
    cookie: adminCookie,
    csrf: adminCsrf,
    body: { values: { PORTAL_PUBLIC_HOST: PLAIN_VALUE, PORTAL_TAILSCALE_API_TOKEN: SENSITIVE_VALUE } },
  });
  expect(save.statusCode, save.body).toBe(200);
  expect((save.json() as { updatedKeys: string[] }).updatedKeys).toContain('PORTAL_PUBLIC_HOST');

  await before.close();

  // ---- 阶段 2：把库退回 v2 形态 ----
  const raw = new Database(DB_PATH);
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'totp_%'")
    .all() as Array<{ name: string }>;
  expect(tables.map((row) => row.name).sort()).toEqual(['totp_challenges', 'totp_recovery_codes']);

  raw.exec(`
    ALTER TABLE users DROP COLUMN totp_secret;
    ALTER TABLE users DROP COLUMN totp_enabled;
    ALTER TABLE users DROP COLUMN totp_confirmed_at;
    ALTER TABLE users DROP COLUMN totp_last_counter;
    DROP TABLE totp_recovery_codes;
    DROP TABLE totp_challenges;
    DELETE FROM schema_migrations WHERE version = 3;
  `);
  const applied = raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
  expect(applied.v).toBe(2); // 确认已退回 v2
  raw.close();

  // 敏感设置此时已经是密文（升级前就由 secretStore 加密落库）
  const check = new Database(DB_PATH, { readonly: true });
  const sensitiveRow = check.prepare("SELECT value FROM settings WHERE key = 'PORTAL_TAILSCALE_API_TOKEN'").get() as
    | { value: string }
    | undefined;
  check.close();
  expect(sensitiveRow?.value.startsWith('enc:v1:')).toBe(true);
  expect(sensitiveRow?.value).not.toContain(SENSITIVE_VALUE);
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('迁移 v3 · 既有部署升级后无损', () => {
  let handle: AppHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    // ---- 阶段 3：重新启动同一个库，v3 迁移重放 ----
    handle = await startApp();
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('迁移在已有数据上重放成功，v3 的列与表都回来了', () => {
    const raw = new Database(DB_PATH, { readonly: true });
    const maxVersion = raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
    expect(maxVersion.v).toBe(3);

    const columns = raw.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    const names = columns.map((column) => column.name);
    for (const column of ['totp_secret', 'totp_enabled', 'totp_confirmed_at', 'totp_last_counter']) {
      expect(names).toContain(column);
    }
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'totp_%'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual(['totp_challenges', 'totp_recovery_codes']);
    raw.close();
  });

  it('原管理员密码照旧，可正常登录（重启即可用）', async () => {
    const response = await inject(app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { user: { username: string; totpEnabled: boolean }; csrfToken: string };
    expect(body.user.username).toBe('admin');
    expect(body.user.totpEnabled).toBe(false); // 升级不会凭空打开两步验证
    adminCookie = cookieOf(response.headers['set-cookie']);
    adminCsrf = body.csrfToken;
  });

  it('原有用户与设置都在，且来源仍标记为数据库', async () => {
    const users = await inject(app, { method: 'GET', url: '/api/users', cookie: adminCookie, csrf: adminCsrf });
    expect(users.statusCode).toBe(200);
    const list = (users.json() as { items: Array<{ username: string }> }).items;
    expect(list.map((user) => user.username).sort()).toEqual(['admin', 'viewer1']);

    const settings = await inject(app, { method: 'GET', url: '/api/settings', cookie: adminCookie, csrf: adminCsrf });
    expect(settings.statusCode).toBe(200);
    const items = (settings.json() as { settings: Array<{ key: string; value: unknown; source: string }> }).settings;
    const publicHost = items.find((item) => item.key === 'PORTAL_PUBLIC_HOST');
    expect(publicHost?.value).toBe(PLAIN_VALUE);
    expect(publicHost?.source).toBe('database');
  });

  it('升级前加密的敏感设置仍能解出原值（密钥文件被复用而不是重新生成）', () => {
    const raw = new Database(DB_PATH, { readonly: true });
    const row = raw.prepare("SELECT value FROM settings WHERE key = 'PORTAL_TAILSCALE_API_TOKEN'").get() as
      | { value: string }
      | undefined;
    raw.close();
    expect(row?.value.startsWith('enc:v1:')).toBe(true);

    // 用同一个数据目录里的密钥文件解 —— 证明密钥是持久的、没有在重启时被换掉
    const loaded = loadOrCreateKey({ explicit: config.secrets.key, keyFile: config.secrets.keyFile, logger });
    expect(loaded.source).toBe('file');
    const box = createSecretBox({ key: loaded.key, previousKeys: [] });
    expect(box.decrypt(row!.value)).toBe(SENSITIVE_VALUE);
  });

  it('升级后两步验证可以正常绑定（新列真的可用，不是只建了列）', async () => {
    const setup = await inject(app, {
      method: 'POST',
      url: '/api/users/me/totp/setup',
      cookie: adminCookie,
      csrf: adminCsrf,
    });
    expect(setup.statusCode, setup.body).toBe(200);

    const raw = new Database(DB_PATH, { readonly: true });
    const row = raw.prepare("SELECT totp_secret, totp_enabled FROM users WHERE username = 'admin'").get() as {
      totp_secret: string | null;
      totp_enabled: number;
    };
    raw.close();
    expect(row.totp_secret?.startsWith('enc:v1:')).toBe(true);
    expect(row.totp_enabled).toBe(0); // 未确认前不算启用
  });
});