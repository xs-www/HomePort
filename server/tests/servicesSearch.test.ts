/**
 * 聚合搜索的单测（spec §4.3 / §7.3）。
 *
 * 两层：
 * 1. `buildSearchHits` 纯函数 —— 分组顺序、标题命中优先、limit、设备不给假入口；
 * 2. 真实 app + `inject` —— **角色过滤**（viewer 搜不到 hidden 服务）、空查询 400、
 *    limit 上限、以及"设置/用户/审计/Token 绝不进索引"。
 *
 * 与 `servicesApi.test.ts` 一样：路由与鉴权是真的，外部数据源（Docker / tailnet）是假的。
 * 工具目录用真实 catalog（纯本地，不发任何请求），且搜索刻意 `probe:false`。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import { ServicesRepository } from '../src/db/services.js';
import { buildSearchHits, SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT } from '../src/api/search.js';
import { ServiceRegistryService } from '../src/modules/services/service.js';
import type { ContainerService } from '../src/modules/docker/service.js';
import type { TailscaleService } from '../src/modules/tailscale/service.js';
import type { ServiceSearchResponse, ServiceView } from '../src/modules/services/types.js';
import { TS_HOST, makeContainer, makeContainerList, makeDevice, makePort, makeTool } from './support/serviceFixtures.js';

const SETUP_TOKEN = 'SEARCH-SETUP-TOKEN';
const ADMIN_PASSWORD = 'SearchAdmin2026!';
const VIEWER_PASSWORD = 'SearchViewer2026!';
const HIDDEN_NAME = 'Secret Vault';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-search-'));

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

/** 12 个同名容器（Compose 服务名不同 → 12 个服务 + 12 个容器命中 'svc'）。 */
const containers = Array.from({ length: 12 }, (_, index) =>
  makeContainer({
    id: `c-svc-${index}`,
    name: `svc-${index}`,
    image: `alpine:3.${index}`,
    composeProject: 'lab',
    composeService: `svc-${index}`,
    ports: [makePort({ hostPort: 9100 + index })],
  }),
);

const devices = [
  makeDevice({ id: 'device-nas', hostname: 'nas-laptop', os: 'linux', online: true }),
  makeDevice({ id: 'device-phone', hostname: 'phone', os: 'android', online: false }),
];

const fakeContainers = {
  list: async () => makeContainerList(containers),
} as unknown as ContainerService;

const fakeTailscale = {
  getTailscaleIpv4: () => null,
  getTailscaleDnsName: () => null,
  getStatus: async () => ({
    self: devices[0]!,
    tailnet: { name: 'example.ts.net', magicDnsSuffix: 'ts.net' },
    peers: devices,
    summary: { peersTotal: 2, peersOnline: 1, peersOffline: 1 },
    backendState: 'Running',
    source: { available: true, mode: 'fake', detail: null },
  }),
} as unknown as TailscaleService;

let handle: AppHandle;
let app: FastifyInstance;

let ipCounter = 60;
function inject(options: { method: 'GET' | 'POST'; url: string; cookie?: string; csrf?: string; body?: unknown }) {
  ipCounter += 1;
  const headers: Record<string, string> = { 'x-forwarded-for': `10.30.0.${ipCounter % 250}` };
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
  return {
    cookie: sessionCookie(response.headers['set-cookie']),
    csrf: (response.json() as { csrfToken: string }).csrfToken,
  };
}

let admin: Client;
let viewer: Client;

async function search(client: Client, query: string): Promise<ServiceSearchResponse> {
  const response = await inject({ method: 'GET', url: `/api/search${query}`, cookie: client.cookie });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ServiceSearchResponse;
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
  await app.ready();

  handle.ctx.containers = fakeContainers;
  handle.ctx.tailscale = fakeTailscale;
  handle.ctx.services = new ServiceRegistryService({
    containers: fakeContainers,
    tailscale: fakeTailscale,
    repository: new ServicesRepository(handle.db),
    audit: handle.ctx.audit,
    config: testConfig,
    logger: createSilentLogger(),
  });

  const bootstrap = await inject({
    method: 'POST',
    url: '/api/auth/bootstrap',
    body: { token: SETUP_TOKEN, username: 'admin', password: ADMIN_PASSWORD, displayName: '管理员' },
  });
  expect(bootstrap.statusCode, bootstrap.body).toBe(201);
  admin = await login('admin', ADMIN_PASSWORD);

  const created = await inject({
    method: 'POST',
    url: '/api/users',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { username: 'viewer1', password: VIEWER_PASSWORD, displayName: '只读账号', role: 'viewer' },
  });
  expect(created.statusCode, created.body).toBe(201);
  viewer = await login('viewer1', VIEWER_PASSWORD);

  // 管理员建一个 hidden 服务：viewer 不该搜到它
  const hidden = await inject({
    method: 'POST',
    url: '/api/services',
    cookie: admin.cookie,
    csrf: admin.csrf,
    body: { displayName: HIDDEN_NAME, visibility: 'hidden' },
  });
  expect(hidden.statusCode, hidden.body).toBe(201);
});

afterAll(async () => {
  await handle.close();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ *
 * 纯函数：分组与排序
 * ------------------------------------------------------------------ */

function serviceView(partial: Partial<ServiceView> & { id: string; displayName: string }): ServiceView {
  return {
    slug: partial.displayName.toLowerCase().replace(/\s+/g, '-'),
    description: null,
    icon: null,
    category: null,
    sourceType: 'docker',
    sourceRef: `docker:${partial.id}`,
    bindingRefs: [],
    visibility: 'visible',
    favorite: false,
    sortOrder: 100,
    preferredUrl: null,
    entry: null,
    entries: [],
    entryCount: 0,
    status: { container: 'running', reachable: true, health: 'skipped', reasons: [] },
    container: null,
    userEdited: false,
    healthTarget: null,
    healthPath: null,
    createdAt: '2026-10-16T00:00:00.000Z',
    updatedAt: '2026-10-16T00:00:00.000Z',
    ...partial,
  };
}

describe('buildSearchHits · 分组顺序与命中优先级', () => {
  it('分组顺序固定为 服务 → 容器 → 设备 → 工具', () => {
    const hits = buildSearchHits(
      {
        services: [serviceView({ id: 's1', displayName: 'app-service', entry: `https://${TS_HOST}:8443/app` })],
        containers: [makeContainer({ id: 'c1', name: 'app-container' })],
        devices: [makeDevice({ id: 'd1', hostname: 'app-nas' })],
        tools: [makeTool({ id: 't1', name: 'app-tool' })],
      },
      'app',
      20,
    );
    expect(hits.map((hit) => hit.kind)).toEqual(['service', 'container', 'device', 'tool']);
  });

  it('同一分组内：标题命中排在 keywords 命中之前', () => {
    const hits = buildSearchHits(
      {
        services: [],
        containers: [],
        devices: [],
        tools: [
          // 先加入的是"keywords 命中"（title 不含 app，但 category 含 app）
          makeTool({ id: 'keyword-hit', name: 'Zed', category: 'app' }),
          makeTool({ id: 'title-hit', name: 'app-tool' }),
        ],
      },
      'app',
      20,
    );
    expect(hits.map((hit) => hit.id)).toEqual(['title-hit', 'keyword-hit']);
  });

  it('大小写不敏感的子串匹配，且支持 keywords（slug / 端口 / 镜像）', () => {
    const hits = buildSearchHits(
      {
        services: [serviceView({ id: 's1', displayName: '家庭日历' })],
        containers: [makeContainer({ id: 'c1', name: 'web', image: 'nginx:alpine', ports: [makePort({ hostPort: 8123 })] })],
        devices: [],
        tools: [],
      },
      'NGINX',
      20,
    );
    expect(hits.map((hit) => hit.id)).toEqual(['c1']);

    const bySlug = buildSearchHits(
      { services: [serviceView({ id: 's2', displayName: '家庭日历' })], containers: [], devices: [], tools: [] },
      'docker:s2',
      20,
    );
    expect(bySlug.map((hit) => hit.id)).toEqual(['s2']);
  });

  it('limit 生效；空查询返回空数组（不返回全量）', () => {
    const index = {
      services: [],
      containers: containers.map((container) => container),
      devices: [],
      tools: [],
    };
    expect(buildSearchHits(index, 'svc', 3)).toHaveLength(3);
    expect(buildSearchHits(index, '', 10)).toHaveLength(0);
    expect(buildSearchHits(index, '   ', 10)).toHaveLength(0);
  });

  it('设备没有可点击入口（url 为 null，不给一个打不开的地址）', () => {
    const hits = buildSearchHits(
      { services: [], containers: [], devices: [makeDevice({ id: 'd1', hostname: 'nas' })], tools: [] },
      'nas',
      10,
    );
    expect(hits[0]).toMatchObject({ kind: 'device', url: null });
    expect(hits[0]?.subtitle).toContain('在线');
  });
});

/* ------------------------------------------------------------------ *
 * 路由：角色过滤 / limit / 空查询 / 不索引敏感内容
 * ------------------------------------------------------------------ */

describe('GET /api/search · 契约与权限', () => {
  it('匿名 → 401', async () => {
    expect((await inject({ method: 'GET', url: '/api/search?q=svc' })).statusCode).toBe(401);
  });

  it('默认 limit=8，`limit` 上限 20（21 → 400）', async () => {
    expect(SEARCH_DEFAULT_LIMIT).toBe(8);
    expect(SEARCH_MAX_LIMIT).toBe(20);

    const dflt = await search(viewer, '?q=svc');
    expect(dflt.items).toHaveLength(8);
    expect(dflt.query).toBe('svc');

    const max = await search(viewer, '?q=svc&limit=20');
    expect(max.items).toHaveLength(20);

    const over = await inject({ method: 'GET', url: '/api/search?q=svc&limit=21', cookie: viewer.cookie });
    expect(over.statusCode).toBe(400);
    expect((over.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
  });

  it('空查询 / 非法 limit → 400（不静默返回全量）', async () => {
    for (const url of ['/api/search', '/api/search?q=', '/api/search?q=%20%20', '/api/search?q=a&limit=0', '/api/search?q=a&bogus=1']) {
      const response = await inject({ method: 'GET', url, cookie: viewer.cookie });
      expect(response.statusCode, url).toBe(400);
    }
  });

  it('viewer 搜不到 hidden 服务，admin 能搜到（结果按角色过滤）', async () => {
    const viewerHits = await search(viewer, `?q=${encodeURIComponent('secret')}`);
    expect(viewerHits.items).toHaveLength(0);

    const adminHits = await search(admin, `?q=${encodeURIComponent('secret')}`);
    expect(adminHits.items).toHaveLength(1);
    expect(adminHits.items[0]).toMatchObject({ kind: 'service', title: HIDDEN_NAME });
  });

  it('容器与设备对 viewer 同样可见（沿用既有只读权限）', async () => {
    // 服务的 keywords 里含容器镜像，所以这里用上限 20 才能同时看到容器分组
    const containerHits = await search(viewer, '?q=alpine&limit=20');
    expect(containerHits.items.some((hit) => hit.kind === 'container')).toBe(true);

    const deviceHits = await search(viewer, '?q=nas-laptop');
    expect(deviceHits.items.some((hit) => hit.kind === 'device' && hit.title === 'nas-laptop')).toBe(true);
  });

  it('工具索引来自既有目录（probe:false → 不发探测请求）', async () => {
    const hits = await search(viewer, '?q=Ollama');
    const tool = hits.items.find((hit) => hit.kind === 'tool');
    expect(tool).toMatchObject({ title: 'Ollama' });
    expect(tool?.url).toContain('11434');
  });

  it('绝不索引设置 / 用户 / 审计：拿用户名与设置值搜不到任何东西', async () => {
    for (const needle of ['viewer1', 'admin', 'PORTAL_PUBLIC_HOST', 'audit_log']) {
      const hits = await search(admin, `?q=${encodeURIComponent(needle)}`);
      expect(hits.items, needle).toHaveLength(0);
    }
  });
});