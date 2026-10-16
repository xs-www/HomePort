/**
 * 升级路径测试：**既有部署**（v3 库）升级到 Sprint 1（v4 `services_registry`）后，
 * 用户 / 会话 / 设置必须无损；迁移可重复执行；服务行与用户覆盖在重新发现后保留。
 *
 * 与 `migrationV3.test.ts` 同一套"真实回落"结构，而不是造一个假库：
 *   1. 用当前代码建一个**文件库**（v4），写入管理员 / viewer / 一条设置；
 *   2. 用 SQLite 把它**退回 v3 形态** —— 删掉 v4 的三张表与 `schema_migrations` 里的 version=4；
 *   3. 用当前代码**重新启动**同一个文件库 → v4 迁移在**已有数据**上重放。
 *
 * 回退策略（本用例刻意固化为断言）：迁移是 **append-only + 只能前滚**，
 * 没有任何 `down` 迁移 —— 回退的唯一手段是"停容器 + 用备份覆盖 `portal.sqlite`"，
 * 而不是"跑一条反向 SQL"。
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
import { MIGRATIONS, openDatabase, runMigrations } from '../src/db/database.js';
import { ServicesRepository } from '../src/db/services.js';
import { ServiceRegistryService } from '../src/modules/services/service.js';
import type { ContainerService } from '../src/modules/docker/service.js';
import type { ContainerSummary } from '../src/modules/docker/types.js';
import type { TailscaleService } from '../src/modules/tailscale/service.js';
import { makeContainer, makeContainerList, makePort } from './support/serviceFixtures.js';

const SETUP_TOKEN = 'MIGRATION-V4-SETUP-TOKEN';
const ADMIN_PASSWORD = 'MigrationV4Admin2026!';
const VIEWER_PASSWORD = 'MigrationV4Viewer2026!';
const PUBLIC_HOST = 'portal-before-v4.example';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-migrate-v4-'));
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
  const handle = await buildApp({ config, logger, dbPath: DB_PATH, serveStatic: false, sessionCleanupIntervalMs: 0 });
  await handle.app.ready();
  return handle;
}

let ip = 80;
function inject(
  app: FastifyInstance,
  payload: { method: 'GET' | 'POST' | 'PATCH'; url: string; cookie?: string; csrf?: string; body?: unknown },
) {
  ip += 1;
  const headers: Record<string, string> = { 'x-forwarded-for': `10.40.0.${ip % 250}` };
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

/** 升级前拿到的管理员会话（用来证明"会话无损"）。 */
let sessionFromBefore = '';

/** 模拟"容器重建"的数据源：容器 ID 可变、Compose 名不变；也可整体切换为"Docker 不可达"。 */
function calendarContainer(containerId: string): ContainerSummary {
  return makeContainer({
    id: containerId,
    name: 'sisi-calendar',
    image: 'sisi-calendar:latest',
    reachability: 'localhost-only',
    primaryUrl: null,
    ports: [makePort({ hostPort: 36065, hostIp: '127.0.0.1', reachability: 'localhost-only', url: null })],
  });
}

/** 可变的假数据源（同一个对象在多次 sync 之间切换内容，模拟容器重建 / Docker 掉线）。 */
let liveContainers: ContainerSummary[] = [calendarContainer('c-calendar-v4-a')];
let dockerAvailable = true;
const dynamicContainers = {
  list: async () => makeContainerList(liveContainers, { dockerAvailable, serveAvailable: dockerAvailable }),
} as unknown as ContainerService;

const fakeTailscale = {
  getTailscaleIpv4: () => null,
  getTailscaleDnsName: () => null,
} as unknown as TailscaleService;

beforeAll(async () => {
  // ---- 阶段 1：升级前（v3 时代的功能）----
  const before = await startApp();
  const app = before.app;

  const bootstrap = await inject(app, {
    method: 'POST',
    url: '/api/auth/bootstrap',
    body: { token: SETUP_TOKEN, username: 'admin', password: ADMIN_PASSWORD, displayName: '管理员' },
  });
  expect(bootstrap.statusCode, bootstrap.body).toBe(201);

  const login = await inject(app, {
    method: 'POST',
    url: '/api/auth/login',
    body: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(login.statusCode, login.body).toBe(200);
  sessionFromBefore = cookieOf(login.headers['set-cookie']);

  const viewer = await inject(app, {
    method: 'POST',
    url: '/api/users',
    cookie: sessionFromBefore,
    csrf: (login.json() as { csrfToken: string }).csrfToken,
    body: { username: 'viewer1', password: VIEWER_PASSWORD, displayName: '只读账号', role: 'viewer' },
  });
  expect(viewer.statusCode, viewer.body).toBe(201);

  const saved = await inject(app, {
    method: 'PATCH',
    url: '/api/settings',
    cookie: sessionFromBefore,
    csrf: (login.json() as { csrfToken: string }).csrfToken,
    body: { values: { PORTAL_PUBLIC_HOST: PUBLIC_HOST } },
  });
  expect(saved.statusCode, saved.body).toBe(200);

  // v4 的表此时已经存在（新库直接跑 v1→v4）
  const raw = new Database(DB_PATH, { readonly: true });
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'service%'")
    .all() as Array<{ name: string }>;
  expect(tables.map((row) => row.name).sort()).toEqual(['service_bindings', 'service_preferences', 'services']);
  raw.close();

  await before.close();

  // ---- 阶段 2：把库退回 v3 形态（删表 + 删迁移记录）----
  const downgrade = new Database(DB_PATH);
  downgrade.exec(`
    DROP TABLE service_bindings;
    DROP TABLE services;
    DROP TABLE service_preferences;
    DELETE FROM schema_migrations WHERE version = 4;
  `);
  const applied = downgrade.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
  expect(applied.v).toBe(3);
  downgrade.close();
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('迁移 v4 · 既有部署升级后无损', () => {
  let handle: AppHandle;
  let app: FastifyInstance;

  beforeAll(async () => {
    // ---- 阶段 3：重新启动同一个库，v4 迁移在已有数据上重放 ----
    handle = await startApp();
    app = handle.app;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('v4 的表回来了，schema_migrations 恰好 4 行', () => {
    const raw = new Database(DB_PATH, { readonly: true });
    const maxVersion = raw.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number };
    expect(maxVersion.v).toBe(4);

    const rows = raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
    expect(rows.map((row) => row.version)).toEqual([1, 2, 3, 4]);

    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'service%'")
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name).sort()).toEqual(['service_bindings', 'service_preferences', 'services']);

    const columns = (raw.prepare('PRAGMA table_info(services)').all() as Array<{ name: string }>).map((row) => row.name);
    for (const column of ['source_type', 'source_ref', 'binding_refs', 'user_edited', 'health_target', 'health_path']) {
      expect(columns).toContain(column);
    }
    raw.close();
  });

  it('迁移 append-only：v4 没有 down，回退只能靠备份恢复', () => {
    const v4 = MIGRATIONS.find((migration) => migration.version === 4);
    expect(v4?.name).toBe('services_registry');
    expect(v4 && 'down' in v4).toBe(false);
    // 版本号单调递增（不允许插队/改写历史）
    expect(MIGRATIONS.map((migration) => migration.version)).toEqual([1, 2, 3, 4]);
  });

  it('重复 runMigrations 幂等（第二次什么都不做）', () => {
    const db = openDatabase({ file: DB_PATH });
    try {
      const appliedAgain = runMigrations(db, MIGRATIONS, logger);
      expect(appliedAgain).toEqual([]);
      const count = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get() as { n: number };
      expect(count.n).toBe(4);
    } finally {
      db.close();
    }
  });

  it('升级前的管理员会话仍然有效（会话无损）', async () => {
    const response = await inject(app, { method: 'GET', url: '/api/users', cookie: sessionFromBefore });
    expect(response.statusCode, response.body).toBe(200);
    const items = (response.json() as { items: Array<{ username: string }> }).items;
    expect(items.map((user) => user.username).sort()).toEqual(['admin', 'viewer1']);
  });

  it('用户与设置都在，且来源仍标记为数据库', async () => {
    const login = await inject(app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(login.statusCode, login.body).toBe(200);
    const cookie = cookieOf(login.headers['set-cookie']);
    const csrf = (login.json() as { csrfToken: string }).csrfToken;

    const settings = await inject(app, { method: 'GET', url: '/api/settings', cookie, csrf });
    expect(settings.statusCode, settings.body).toBe(200);
    const items = (settings.json() as { settings: Array<{ key: string; value: unknown; source: string }> }).settings;
    expect(items.find((item) => item.key === 'PORTAL_PUBLIC_HOST')).toMatchObject({
      value: PUBLIC_HOST,
      source: 'database',
    });
  });
});

describe('迁移 v4 · 服务行与用户覆盖在重新发现后保留', () => {
  let handle: AppHandle;
  let repo: ServicesRepository;
  let registry: ServiceRegistryService;

  beforeAll(async () => {
    handle = await startApp();
    repo = new ServicesRepository(handle.db);
    // 整个 describe 都跑在假数据源上：路由/鉴权/DB 是真的，Docker 是假的（绝不碰宿主）
    handle.ctx.containers = dynamicContainers;
    handle.ctx.tailscale = fakeTailscale;
    registry = new ServiceRegistryService({
      containers: dynamicContainers,
      tailscale: fakeTailscale,
      repository: repo,
      audit: handle.ctx.audit,
      config,
      logger,
    });
    handle.ctx.services = registry;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('第一次发现写入服务行与绑定快照', async () => {
    const snapshot = await registry.sync(undefined, { force: true });
    expect(snapshot.plan.services.map((service) => service.sourceRef)).toEqual(['docker:sisi-calendar']);

    const service = repo.findBySource('docker', 'docker:sisi-calendar');
    expect(service).not.toBeNull();
    expect(service?.displayName).toBe('家庭日历'); // 自动展示属性
    expect(service?.userEdited).toBe(false);
    expect(repo.count()).toBe(1);

    const bindings = repo.listBindings([service!.id]);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({ kind: 'container', containerId: 'c-calendar-v4-a', containerName: 'sisi-calendar' });
  });

  it('用户改了展示属性与首选入口后，再次发现仍然保留（ID 相同、行不重复）', async () => {
    const service = repo.findBySource('docker', 'docker:sisi-calendar')!;
    repo.updateUserFields(
      service.id,
      {
        displayName: '我家的日历',
        preferredUrl: 'https://family-nas.tail585599.ts.net:8443/calendar',
        favorite: true,
        sortOrder: 1,
      },
      'admin',
    );

    // 容器重建：新 ID、同 Compose 名 → 同一 sourceRef
    liveContainers = [calendarContainer('c-calendar-v4-b')];

    await registry.sync(undefined, { force: true });
    await registry.sync(undefined, { force: true }); // 第二次：幂等，不再新增行

    expect(repo.count()).toBe(1);
    const after = repo.findBySource('docker', 'docker:sisi-calendar')!;
    expect(after.id).toBe(service.id);
    expect(after.displayName).toBe('我家的日历');
    expect(after.preferredUrl).toBe('https://family-nas.tail585599.ts.net:8443/calendar');
    expect(after.favorite).toBe(true);
    expect(after.sortOrder).toBe(1);
    expect(after.userEdited).toBe(true);

    // 绑定快照更新为新容器 ID（快照性质：可丢可重算）
    expect(repo.listBindings([after.id])[0]?.containerId).toBe('c-calendar-v4-b');
  });

  it('空发现（Docker 不可达）不会删掉已有服务行', async () => {
    const service = repo.findBySource('docker', 'docker:sisi-calendar')!;
    liveContainers = [];
    dockerAvailable = false;

    const snapshot = await registry.sync(undefined, { force: true });
    expect(snapshot.plan.services).toHaveLength(0);
    expect(snapshot.plan.notes.join('\n')).toContain('Docker 不可达');
    expect(repo.findById(service.id)).not.toBeNull();
    expect(repo.count()).toBe(1);
  });

  it('API 层能读到这一行（服务墙不会因为迁移而空掉）', async () => {
    const login = await inject(handle.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    const cookie = cookieOf(login.headers['set-cookie']);

    const response = await inject(handle.app, { method: 'GET', url: '/api/services?includeHidden=1', cookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { items: Array<{ displayName: string; sourceRef: string }> };
    const calendar = body.items.find((item) => item.sourceRef === 'docker:sisi-calendar');
    expect(calendar?.displayName).toBe('我家的日历');
  });
});