/**
 * 服务 API 的端到端测试（真实 app + Fastify `inject`，不起端口、不碰真实 Docker/Tailscale）。
 *
 * 做法：`buildApp({ dbPath: ':memory:' })` 建真实应用（真实路由 + 真实鉴权 + 真实 CSRF + 真实 SQLite），
 * 然后把 `ctx.containers` / `ctx.tailscale` 换成假数据源 —— 路由与鉴权是**真**的，
 * 只有外部世界（Docker / tailnet / 网络）是假的。这样测的是"契约与权限"，
 * 而不是"我这台机器上恰好跑了什么容器"。
 *
 * 权限三件事必须为真：匿名 401 / viewer 写 403 / 缺 CSRF 403。
 * 健康探测只测**被拒绝的目标**（零请求），真正的 fetch 行为在
 * `servicesHealthProbe.test.ts` 里用注入 fetch 断言。
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
import { ServiceRegistryService } from '../src/modules/services/service.js';
import type { ContainerService } from '../src/modules/docker/service.js';
import type { TailscaleService } from '../src/modules/tailscale/service.js';
import type { ServiceListResponse, ServiceDetailResponse, ServiceDeleteResponse, ServiceView } from '../src/modules/services/types.js';
import {
  TS_HOST,
  makeContainer,
  makeContainerList,
  makePort,
  makeServeRoute,
  realTopology,
  type Topology,
} from './support/serviceFixtures.js';
import { containerServiceRef, serveServiceRef } from '../src/modules/services/registry.js';

const SETUP_TOKEN = 'SERVICES-SETUP-TOKEN';
const ADMIN_PASSWORD = 'ServicesAdmin2026!';
const VIEWER_PASSWORD = 'ServicesViewer2026!';

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-services-'));

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
let repo: ServicesRepository;

/** 拓扑：门户 8899（serve 443 `/`）、日历 36065（serve 8443 `/calendar`）、Gitea 3000（serve 8443 `/git/`）。 */
const topology = realTopology();

/**
 * 当前假数据源返回的拓扑。
 *
 * 做成可替换的（见 `withTopology`），是为了让"多副本 / 端口冲突"这类回归用例
 * 不必再建一个 app + 库：直接把外部世界换掉，路由、鉴权、CSRF、SQLite 全是真的。
 * 必须在读取时取 `liveTopology`（不是把 `topology` 捕获进闭包），否则替换不生效。
 */
let liveTopology: Topology = topology;

const fakeContainers = {
  list: async () => makeContainerList(liveTopology.containers, { routes: liveTopology.serveRoutes }),
} as unknown as ContainerService;

const fakeTailscale = {
  getTailscaleIpv4: () => null,
  getTailscaleDnsName: () => null,
  getStatus: async () => ({
    self: null,
    tailnet: { name: null, magicDnsSuffix: null },
    peers: [],
    summary: { peersTotal: 0, peersOnline: 0, peersOffline: 0 },
    backendState: 'Running',
    source: { available: true, mode: 'fake', detail: null },
  }),
} as unknown as TailscaleService;

let ipCounter = 30;
function nextIp(): string {
  ipCounter += 1;
  return `10.20.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
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

/** 列出服务（管理员视角，含 hidden）。 */
async function adminList(query = ''): Promise<ServiceListResponse> {
  const response = await inject({ method: 'GET', url: `/api/services${query}`, cookie: admin.cookie });
  expect(response.statusCode, response.body).toBe(200);
  return response.json() as ServiceListResponse;
}

function bySource(items: ServiceView[], sourceRef: string): ServiceView {
  const found = items.find((item) => item.sourceRef === sourceRef);
  expect(found, `未找到 ${sourceRef}`).toBeDefined();
  return found!;
}

/** 新建一个手工服务并返回它。 */
async function createService(body: Record<string, unknown>): Promise<ServiceView> {
  const response = await inject({ method: 'POST', url: '/api/services', cookie: admin.cookie, csrf: admin.csrf, body });
  expect(response.statusCode, response.body).toBe(201);
  return response.json() as ServiceView;
}

/** 强制重新发现（admin），返回列表；发现落库失败会在这里的 statusCode 上暴露出来。 */
async function discover(): Promise<{ statusCode: number; body: string; list: ServiceListResponse }> {
  const response = await inject({ method: 'POST', url: '/api/services/discover', cookie: admin.cookie, csrf: admin.csrf });
  return {
    statusCode: response.statusCode,
    body: response.body,
    list: response.statusCode === 200 ? (response.json() as ServiceListResponse) : { items: [], total: 0, categories: [], discovery: null as never, generatedAt: '' },
  };
}

/**
 * 临时替换假数据源返回的拓扑，用完恢复。
 *
 * 两个清理动作都是必要的（本文件所有用例共享一个内存库与一个发现缓存）：
 * 1. 删掉这次临时拓扑**新引入**的服务 —— 否则后续用例会看到多出来的服务；
 * 2. 重新发现真实拓扑 —— 让缓存与内存里的发现快照复位。
 */
async function withTopology<T>(next: Topology, run: () => Promise<T>): Promise<T> {
  const previous = liveTopology;
  const previousRefs = new Set<string>([
    ...previous.containers.map((container) => containerServiceRef(container)),
    ...previous.serveRoutes.map((route) => serveServiceRef(route)),
  ]);
  liveTopology = next;
  try {
    return await run();
  } finally {
    liveTopology = previous;
    for (const sourceRef of [
      ...next.containers.map((container) => containerServiceRef(container)),
      ...next.serveRoutes.map((route) => serveServiceRef(route)),
    ]) {
      if (previousRefs.has(sourceRef)) continue;
      const introduced = repo.listAll().find((service) => service.sourceRef === sourceRef);
      if (introduced) repo.delete(introduced.id);
    }
    await discover();
  }
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

  // 外部世界替换为假数据源（路由/鉴权/CSRF 保持真实）
  repo = new ServicesRepository(handle.db);
  handle.ctx.containers = fakeContainers;
  handle.ctx.tailscale = fakeTailscale;
  handle.ctx.services = new ServiceRegistryService({
    containers: fakeContainers,
    tailscale: fakeTailscale,
    repository: repo,
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

describe('服务 API · 鉴权与 CSRF', () => {
  it('匿名访问服务接口 → 401（不是空列表）', async () => {
    expect((await inject({ method: 'GET', url: '/api/services' })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/services/whatever' })).statusCode).toBe(401);
    expect((await inject({ method: 'GET', url: '/api/search?q=a' })).statusCode).toBe(401);
  });

  it('viewer 可以读（发现出来的 3 个服务）', async () => {
    const response = await inject({ method: 'GET', url: '/api/services', cookie: viewer.cookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ServiceListResponse;
    expect(body.total).toBe(3);
    expect(body.items.map((item) => item.sourceRef).sort()).toEqual([
      'docker:gitea',
      'docker:homeport/homeport',
      'docker:sisi-calendar',
    ]);
    expect(body.discovery.dockerAvailable).toBe(true);
    expect(body.discovery.serveAvailable).toBe(true);
    expect(body.discovery.discoveredAt).toBeTypeOf('string');
    expect(body.generatedAt).toBeTypeOf('string');
  });

  it('viewer 的所有写操作 → 403', async () => {
    const list = await adminList('?includeHidden=1');
    const target = bySource(list.items, 'docker:gitea');

    const attempts: InjectOptions[] = [
      { method: 'POST', url: '/api/services', body: { displayName: 'x' } },
      { method: 'PATCH', url: `/api/services/${target.id}`, body: { favorite: true } },
      { method: 'DELETE', url: `/api/services/${target.id}` },
      { method: 'POST', url: '/api/services/reorder', body: { order: [{ id: target.id, sortOrder: 1 }] } },
      { method: 'POST', url: '/api/services/discover' },
      { method: 'POST', url: `/api/services/${target.id}/health`, body: { healthTarget: 'http://127.0.0.1:1/' } },
    ];
    for (const attempt of attempts) {
      const response = await inject({ ...attempt, cookie: viewer.cookie, csrf: viewer.csrf });
      expect(response.statusCode, `${attempt.method} ${attempt.url}`).toBe(403);
    }
  });

  it('admin 写操作缺 CSRF → 403', async () => {
    const list = await adminList('?includeHidden=1');
    const target = bySource(list.items, 'docker:gitea');

    const created = await inject({
      method: 'POST',
      url: '/api/services',
      cookie: admin.cookie,
      body: { displayName: '缺 CSRF' },
    });
    expect(created.statusCode).toBe(403);

    const patched = await inject({
      method: 'PATCH',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      body: { favorite: true },
    });
    expect(patched.statusCode).toBe(403);

    const removed = await inject({ method: 'DELETE', url: `/api/services/${target.id}`, cookie: admin.cookie });
    expect(removed.statusCode).toBe(403);

    // 确认这三下真的什么都没改
    expect(bySource((await adminList('?includeHidden=1')).items, 'docker:gitea').favorite).toBe(false);
  });
});

describe('服务 API · 手工服务与校验', () => {
  it('admin 新建手工服务成功（201，身份来自 manual:<uuid>）', async () => {
    const created = await createService({
      displayName: '我的服务',
      description: '手工添加',
      category: '家庭',
      icon: 'calendar',
      preferredUrl: 'https://example.ts.net/app',
      healthPath: '/healthz',
    });
    expect(created.sourceType).toBe('manual');
    expect(created.sourceRef.startsWith('manual:')).toBe(true);
    expect(created.userEdited).toBe(true);
    expect(created.visibility).toBe('visible');
    expect(created.entry).toBe('https://example.ts.net/app');
    expect(created.entryCount).toBe(1);
    expect(created.healthPath).toBe('/healthz');
    // 入选的入口是"用户指定"那一档
    expect(created.entries[0]).toMatchObject({ kind: 'user', rank: 0, accessible: true });
  });

  it('重名服务得到互不相同的 slug（slug 冲突时仓储加后缀）', async () => {
    const first = await createService({ displayName: 'My App' });
    const second = await createService({ displayName: 'My App' });
    expect(first.slug.startsWith('my-app')).toBe(true);
    expect(second.slug).not.toBe(first.slug);
    expect(second.id).not.toBe(first.id);

    // 仓储层的冲突规则：同基名 → `-2`、`-3`…
    expect(repo.uniqueSlug('collide-me')).toBe('collide-me');
    repo.insert({
      id: 'collide-1',
      slug: 'collide-me',
      displayName: 'Collide',
      sourceType: 'manual',
      sourceRef: 'manual:collide-1',
      userEdited: true,
    });
    expect(repo.uniqueSlug('collide-me')).toBe('collide-me-2');
  });

  it('未知字段 → 400（.strict()），且不落库', async () => {
    const before = repo.count();
    const created = await inject({
      method: 'POST',
      url: '/api/services',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { displayName: '带未知字段', bogus: 1 },
    });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: { code: string } }).error.code).toBe('VALIDATION_FAILED');
    expect(repo.count()).toBe(before);

    const target = await createService({ displayName: '用于未知字段' });
    const patched = await inject({
      method: 'PATCH',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { favorite: true, bogus: 2 },
    });
    expect(patched.statusCode).toBe(400);
  });

  it('缺少必填字段 / 空 PATCH / 非法查询参数 → 400', async () => {
    expect((await inject({ method: 'POST', url: '/api/services', cookie: admin.cookie, csrf: admin.csrf, body: {} })).statusCode).toBe(400);

    const target = await createService({ displayName: '空 PATCH' });
    expect(
      (await inject({ method: 'PATCH', url: `/api/services/${target.id}`, cookie: admin.cookie, csrf: admin.csrf, body: {} }))
        .statusCode,
    ).toBe(400);
    expect(
      (await inject({ method: 'GET', url: '/api/services?bogus=1', cookie: admin.cookie })).statusCode,
    ).toBe(400);
    expect(
      (await inject({ method: 'DELETE', url: `/api/services/${target.id}?mode=hard`, cookie: admin.cookie, csrf: admin.csrf }))
        .statusCode,
    ).toBe(400);
  });

  it('危险 URL 一律 400 且不落库（javascript: / data: / 内嵌凭据 / 元数据地址）', async () => {
    const target = await createService({ displayName: '危险 URL 目标' });

    const dangerous = [
      { preferredUrl: 'javascript:alert(1)' },
      { preferredUrl: 'data:text/html,<script>alert(1)</script>' },
      { preferredUrl: 'file:///etc/passwd' },
      { preferredUrl: 'https://user:pass@example.ts.net/app' },
      { preferredUrl: 'http://169.254.169.254/' },
      { healthTarget: 'javascript:alert(1)' },
      { healthTarget: 'data:text/html,x' },
      { healthTarget: 'http://127.0.0.1:2375/containers/json' },
      { healthPath: 'healthz' },
      { icon: 'ftp://example.com/icon.png' },
    ];

    for (const body of dangerous) {
      const response = await inject({
        method: 'PATCH',
        url: `/api/services/${target.id}`,
        cookie: admin.cookie,
        csrf: admin.csrf,
        body,
      });
      expect(response.statusCode, JSON.stringify(body)).toBe(400);
      const error = response.json() as { error: { message: string } };
      expect(error.error.message.length).toBeGreaterThan(0);
    }

    // 一个都没落库
    const detail = await inject({ method: 'GET', url: `/api/services/${target.id}`, cookie: admin.cookie });
    const body = detail.json() as ServiceDetailResponse;
    expect(body.service.preferredUrl).toBeNull();
    expect(body.service.healthTarget).toBeNull();
    expect(body.service.healthPath).toBeNull();
    expect(body.service.icon).toBeNull();
  });

  it('PATCH 展示属性 / 可见性 / 排序 / 收藏都能生效', async () => {
    const target = await createService({ displayName: '被编辑的服务', category: '开发' });
    const response = await inject({
      method: 'PATCH',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { displayName: '改过的名字', favorite: true, sortOrder: 3, category: '家庭', visibility: 'hidden' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const updated = response.json() as ServiceView;
    expect(updated).toMatchObject({
      displayName: '改过的名字',
      favorite: true,
      sortOrder: 3,
      category: '家庭',
      visibility: 'hidden',
      userEdited: true,
    });
    // 恢复可见，避免影响后续用例
    await inject({
      method: 'PATCH',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { visibility: 'visible' },
    });
  });

  it('列表支持 query / category / favorite / includeHidden 过滤', async () => {
    const favorite = await createService({ displayName: 'CollectMe', favorite: true, category: '收藏夹' });

    const byQuery = await adminList('?query=collect');
    expect(byQuery.items.map((item) => item.id)).toContain(favorite.id);

    const byCategory = await adminList(`?category=${encodeURIComponent('家庭')}`);
    expect(byCategory.items.every((item) => item.category === '家庭')).toBe(true);
    expect(byCategory.items.length).toBeGreaterThan(0);

    const byFavorite = await adminList('?favorite=1');
    expect(byFavorite.items.map((item) => item.id)).toContain(favorite.id);
    expect(byFavorite.items.every((item) => item.favorite)).toBe(true);

    // categories 是按 services 顺序去重的分类，未分类排最后
    const all = await adminList('?includeHidden=1');
    expect(new Set(all.categories).size).toBe(all.categories.length);
    if (all.categories.includes('未分类')) expect(all.categories.at(-1)).toBe('未分类');
  });

  it('hidden 服务：viewer 看不到、详情 404；includeHidden 只对 admin 生效', async () => {
    const list = await adminList('?includeHidden=1');
    const target = bySource(list.items, 'docker:sisi-calendar');

    await inject({
      method: 'PATCH',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { visibility: 'hidden' },
    });

    const viewerList = await inject({ method: 'GET', url: '/api/services', cookie: viewer.cookie });
    const viewerBody = viewerList.json() as ServiceListResponse;
    expect(viewerBody.items.map((item) => item.id)).not.toContain(target.id);

    // viewer 传了 includeHidden 也不行
    const viewerInclude = await inject({ method: 'GET', url: '/api/services?includeHidden=1', cookie: viewer.cookie });
    expect((viewerInclude.json() as ServiceListResponse).items.map((item) => item.id)).not.toContain(target.id);

    const viewerDetail = await inject({ method: 'GET', url: `/api/services/${target.id}`, cookie: viewer.cookie });
    expect(viewerDetail.statusCode).toBe(404);

    const adminDetail = await inject({ method: 'GET', url: `/api/services/${target.id}`, cookie: admin.cookie });
    expect(adminDetail.statusCode).toBe(200);
    expect((adminDetail.json() as ServiceDetailResponse).service.visibility).toBe('hidden');

    // 恢复
    await inject({
      method: 'PATCH',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { visibility: 'visible' },
    });
  });
});

describe('服务 API · 详情 / 排序 / 删除 / 重新发现', () => {
  it('详情返回全部候选入口与诊断（含不可达入口）', async () => {
    const list = await adminList('?includeHidden=1');
    const calendar = bySource(list.items, 'docker:sisi-calendar');

    const response = await inject({ method: 'GET', url: `/api/services/${calendar.id}`, cookie: admin.cookie });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ServiceDetailResponse;

    expect(body.service.entry).toBe(`https://${TS_HOST}:8443/calendar`);
    expect(body.candidates.length).toBe(body.service.entryCount);
    expect(body.candidates.some((entry) => !entry.accessible)).toBe(true); // 仅本机的 :36065 仍在
    expect(body.diagnostics.containerPorts[0]).toMatchObject({ containerPort: 36065, hostPort: 36065 });
    expect(body.diagnostics.serveRoutes[0]).toMatchObject({ path: '/calendar', targetPort: 36065 });
    expect(Array.isArray(body.diagnostics.notes)).toBe(true);
  });

  it('reorder 批量排序（admin），返回排好序的列表', async () => {
    const list = await adminList('?includeHidden=1');
    const gitea = bySource(list.items, 'docker:gitea');
    const calendar = bySource(list.items, 'docker:sisi-calendar');

    const response = await inject({
      method: 'POST',
      url: '/api/services/reorder',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: {
        order: [
          { id: gitea.id, sortOrder: 1 },
          { id: calendar.id, sortOrder: 2 },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ServiceListResponse;
    expect(body.items[0]?.id).toBe(gitea.id);
    expect(body.items[1]?.id).toBe(calendar.id);

    // 排序项引用不存在的服务 → 404（不是静默忽略）
    const missing = await inject({
      method: 'POST',
      url: '/api/services/reorder',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { order: [{ id: 'nope', sortOrder: 1 }] },
    });
    expect(missing.statusCode).toBe(404);
  });

  it('DELETE 手工服务 → deleted（行真的没了）', async () => {
    const target = await createService({ displayName: '待删除的手工服务' });

    const response = await inject({
      method: 'DELETE',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ServiceDeleteResponse;
    expect(body).toMatchObject({ ok: true, mode: 'deleted', service: null });

    const detail = await inject({ method: 'GET', url: `/api/services/${target.id}`, cookie: admin.cookie });
    expect(detail.statusCode).toBe(404);
  });

  it('DELETE 自动服务 → hidden（行保留，配置不丢；可随时恢复显示）', async () => {
    const list = await adminList('?includeHidden=1');
    const target = bySource(list.items, 'docker:gitea');

    const response = await inject({
      method: 'DELETE',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ServiceDeleteResponse;
    expect(body.mode).toBe('hidden');
    expect(body.service?.visibility).toBe('hidden');

    // 行还在（发现结果里消失的自动服务不删行，避免清空用户配置）
    expect(repo.findById(target.id)).not.toBeNull();
    expect((await adminList()).items.map((item) => item.id)).not.toContain(target.id);
    expect((await adminList('?includeHidden=1')).items.map((item) => item.id)).toContain(target.id);

    // 恢复显示，供后续用例使用
    await inject({
      method: 'PATCH',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { visibility: 'visible' },
    });
  });

  it('DELETE ?mode=reset → reset（清空用户覆盖，交还给自动发现）', async () => {
    const list = await adminList('?includeHidden=1');
    const target = bySource(list.items, 'docker:sisi-calendar');

    await inject({
      method: 'PATCH',
      url: `/api/services/${target.id}`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { displayName: '我改的名字', favorite: true, preferredUrl: 'https://example.ts.net/cal', category: '我的分类' },
    });
    expect((repo.findById(target.id) ?? undefined)?.userEdited).toBe(true);
    expect((repo.findById(target.id) ?? undefined)?.preferredUrl).toBe('https://example.ts.net/cal');

    const response = await inject({
      method: 'DELETE',
      url: `/api/services/${target.id}?mode=reset`,
      cookie: admin.cookie,
      csrf: admin.csrf,
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ServiceDeleteResponse;
    expect(body.mode).toBe('reset');
    expect(body.service).toMatchObject({ userEdited: false, preferredUrl: null, favorite: false, visibility: 'visible' });

    // 重置后重新发现 → 展示属性回到自动值（这才是"交还给自动层"）
    const discover = await inject({ method: 'POST', url: '/api/services/discover', cookie: admin.cookie, csrf: admin.csrf });
    expect(discover.statusCode, discover.body).toBe(200);
    const after = bySource((discover.json() as ServiceListResponse).items, 'docker:sisi-calendar');
    expect(after.displayName).toBe('家庭日历');
    expect(after.category).toBe('家庭');
    expect(after.entry).toBe(`https://${TS_HOST}:8443/calendar`); // 首选入口回到 Serve
  });

  it('POST /discover 强制重新发现，返回最新列表与来源状态', async () => {
    const response = await inject({ method: 'POST', url: '/api/services/discover', cookie: admin.cookie, csrf: admin.csrf });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as ServiceListResponse;
    expect(body.total).toBeGreaterThanOrEqual(3);
    expect(body.discovery).toMatchObject({ dockerAvailable: true, serveAvailable: true, serveDetail: null });
    expect(body.discovery.notes).toEqual([]); // 数据源都可用 → 没有降级说明
  });

  it('写操作写了审计（service.* 动作）', async () => {
    const actions = (
      handle.db.prepare("SELECT DISTINCT action FROM audit_log WHERE action LIKE 'service.%'").all() as Array<{ action: string }>
    ).map((row) => row.action);
    // 至少覆盖 create / update / delete / reorder / health 这几类
    expect(actions).toEqual(expect.arrayContaining(['service.create', 'service.update', 'service.delete', 'service.reorder']));
  });
});

describe('服务 API · 健康探测（S1-03）', () => {
  it('未配置目标 → 400，且不发任何请求', async () => {
    const target = await createService({ displayName: '没有健康目标' });
    const response = await inject({
      method: 'POST',
      url: `/api/services/${target.id}/health`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: {},
    });
    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: { message: string } }).error.message).toContain('未配置健康检查目标');
  });

  it('云元数据地址 → state=fail 且 detail 说明"已拒绝"（请求根本没发出去）', async () => {
    const target = await createService({ displayName: '元数据探测目标' });
    const response = await inject({
      method: 'POST',
      url: `/api/services/${target.id}/health`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { healthTarget: 'http://169.254.169.254/' },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { health: { state: string; statusCode: number | null; detail: string } };
    expect(body.health.state).toBe('fail');
    expect(body.health.statusCode).toBeNull();
    expect(body.health.detail).toContain('已拒绝');
  });

  it('探测结果进内存状态（列表/详情立刻能看到 health=fail），但覆盖目标不落库', async () => {
    // 配一个"合法但不会真的被请求"的目标（探测时用显式覆盖目标，覆盖目标会被拒绝 → 零请求）
    const target = await createService({ displayName: '健康状态回读', healthTarget: 'http://127.0.0.1:9/health' });

    const probe = await inject({
      method: 'POST',
      url: `/api/services/${target.id}/health`,
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { healthTarget: 'http://169.254.169.254/' },
    });
    expect(probe.statusCode, probe.body).toBe(200);
    expect((probe.json() as { health: { state: string } }).health.state).toBe('fail');

    const detail = await inject({ method: 'GET', url: `/api/services/${target.id}`, cookie: admin.cookie });
    const body = detail.json() as ServiceDetailResponse;
    expect(body.service.status.health).toBe('fail');
    expect(body.service.status.reasons.join('\n')).toContain('已拒绝');

    // 覆盖目标只是"这一次"，绝不改写已保存的配置（不落库为信任）
    expect(body.service.healthTarget).toBe('http://127.0.0.1:9/health');

    // DB 里也没有健康结果列/表（结果只是内存态）
    const row = repo.findById(target.id);
    expect(row?.healthTarget).toBe('http://127.0.0.1:9/health');
    const columns = (handle.db.prepare('PRAGMA table_info(services)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns.some((name) => name.includes('health_result'))).toBe(false);
  });
});

/**
 * 回归：验收时发现的两个 P1。
 *
 * 共同点：都是"归属/身份聚合"没做到底 —— 内存里的规划看起来对，
 * 一旦真的落库（唯一约束）或生成视图（视图阶段重新推断归属）就露出来。
 * 所以这两条用例都走真实路由 + 真实 SQLite，而不是只断言 planDiscovery 的返回值。
 */
describe('服务发现 · 多副本与端口冲突（P1 回归）', () => {
  it('多副本：合并成一个服务，发现落库不撞唯一约束（曾经整个发现事务失败）', async () => {
    const replicas: Topology = {
      containers: [
        makeContainer({
          id: 'c-web-1',
          name: 'demo-web-1',
          composeProject: 'demo',
          composeService: 'web',
          state: 'exited',
          status: 'Exited (0) 2 hours ago',
          reachability: 'lan',
          primaryUrl: `http://${TS_HOST}:8080/`,
          ports: [makePort({ hostPort: 8080 })],
        }),
        makeContainer({
          id: 'c-web-2',
          name: 'demo-web-2',
          composeProject: 'demo',
          composeService: 'web',
          reachability: 'lan',
          primaryUrl: `http://${TS_HOST}:8081/`,
          ports: [makePort({ hostPort: 8081 })],
        }),
      ],
      serveRoutes: [],
    };

    await withTopology(replicas, async () => {
      const result = await discover();
      // 修好之前这里是 500：UNIQUE constraint failed: service_bindings.service_id, kind, ref
      expect(result.statusCode, result.body).toBe(200);

      const web = result.list.items.filter((item) => item.sourceRef === 'docker:demo/web');
      expect(web).toHaveLength(1);
      // 副本共享 sourceRef → 只有一份绑定落库（唯一约束）
      const rows = repo.listBindings([web[0]!.id]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.containerId).toBe('c-web-2');
      // 代表容器是**正在运行**的那个副本：web-1 是 exited，别让人去重启它
      expect(web[0]?.container?.name).toBe('demo-web-2');
      expect(web[0]?.status.container).toBe('running');
    });
  });

  it('端口冲突：路由不被挂回第一个容器（独立服务与容器服务不能同时认领它）', async () => {
    const conflictUrl = `https://${TS_HOST}:8443/conflict`;
    const conflict: Topology = {
      containers: [
        makeContainer({ id: 'c-a', name: 'app-a', ports: [makePort({ hostPort: 9000 })] }),
        makeContainer({ id: 'c-b', name: 'app-b', ports: [makePort({ hostPort: 9000 })] }),
      ],
      // 真实 mapper 按宿主端口取第一个匹配容器 → 故意把 owner 指给 app-a
      serveRoutes: [
        makeServeRoute({ path: '/conflict', targetPort: 9000, containerName: 'app-a', containerId: 'c-a' }),
      ],
    };

    await withTopology(conflict, async () => {
      const result = await discover();
      expect(result.statusCode, result.body).toBe(200);

      // 1) 作为独立 serve 服务列出，并带自己的入口
      const independent = bySource(result.list.items, `serve:${TS_HOST}:8443/conflict`);
      expect(independent.entries.map((entry) => entry.url)).toContain(conflictUrl);

      // 2) 两个候选容器都**不能**认领它（这正是被修掉的 P1：视图阶段又挂回第一个容器）
      for (const ref of ['docker:app-a', 'docker:app-b']) {
        const service = bySource(result.list.items, ref);
        expect(service.entries.map((entry) => entry.url), `${ref} 不该认领冲突路由`).not.toContain(conflictUrl);
        expect(service.bindingRefs, `${ref} 不该记住冲突路由`).not.toContain(`serve:${TS_HOST}:8443/conflict`);
      }

      // 3) 原因要说得出来
      expect(result.list.discovery.notes.join('\n')).toContain('无法确定归属');
    });
  });
});