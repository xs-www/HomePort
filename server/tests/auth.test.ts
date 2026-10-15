/**
 * 认证与权限的端到端测试（Fastify `inject`，内存数据库，不起真实端口）。
 *
 * 这里验的是**安全不变量**，不是实现细节：
 * 1. 首启只能初始化一次，且首个账号必为管理员
 * 2. 未登录访问受保护接口 → 401（而不是 200 或重定向）
 * 3. 变更类请求缺 CSRF → 403
 * 4. viewer 访问管理员接口 → 403
 * 5. 密码错误与用户不存在返回同一错误，避免用户枚举
 * 6. 重置密码会吊销目标用户的全部会话
 * 7. 最后一个管理员不能被删除/降级/禁用
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';

const SETUP_TOKEN = 'TEST-SETUP-TOKEN-WXYZ';
const ADMIN_PASSWORD = 'PortalAdmin2026!';

/** 测试配置：关闭 tailscale 外部调用、不托管静态资源、不启动定时器。 */
const testConfig = loadConfig({
  env: 'test',
  logLevel: 'error',
  dataDir: '/tmp/hp-auth-test',
  dbPath: ':memory:',
  // 打开 trustProxy，使测试可以借 x-forwarded-for 使用不同的"来源 IP"，
  // 从而既验证登录限流存在，又不让限流串扰其它用例。
  trustProxy: true,
  tailscale: {
    mode: 'off',
    bin: '',
    socket: '/nonexistent',
    apiToken: '',
    tailnet: '-',
    timeoutMs: 500,
  },
  bootstrap: { token: SETUP_TOKEN, tokenFile: '/tmp/hp-auth-test/setup-token.txt' },
  session: { ttlHours: 12, rememberTtlHours: 24, cookieName: 'hp_session' },
});

/** 自增的测试来源 IP，保证每个用例有独立的限流桶。 */
let ipCounter = 10;
function nextIp(): string {
  ipCounter += 1;
  return `10.9.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

interface TestClient {
  cookie: string;
  csrf: string;
}

let handle: AppHandle;
let app: FastifyInstance;

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
});

afterAll(async () => {
  await handle.close();
});

/** 从响应头里取出会话 Cookie 的 `name=value` 片段。 */
function extractSessionCookie(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const match = /(^|;\s*)(hp_session=[^;]*)/.exec(value);
    if (match?.[2]) return match[2];
  }
  throw new Error('响应中没有会话 Cookie');
}

/** 登录并返回 Cookie 与 CSRF 令牌。每次使用独立的来源 IP，避免限流串扰。 */
async function login(username: string, password: string): Promise<TestClient> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-forwarded-for': nextIp() },
    payload: { username, password, remember: false },
  });
  expect(response.statusCode).toBe(200);
  const body = response.json() as { csrfToken: string };
  return { cookie: extractSessionCookie(response.headers['set-cookie']), csrf: body.csrfToken };
}

describe('认证流程', () => {
  it('未初始化时会话接口报告 setupRequired', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/auth/session' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { setupRequired: boolean; authenticated: boolean; csrfToken: string };
    expect(body.setupRequired).toBe(true);
    expect(body.authenticated).toBe(false);
    // 未登录不应下发可用的 CSRF 令牌
    expect(body.csrfToken).toBe('');
  });

  it('未初始化时登录被拒绝并提示先初始化', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('SETUP_REQUIRED');
  });

  it('错误的初始化令牌被拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { token: 'WRONG-TOKEN', username: 'admin', password: ADMIN_PASSWORD, displayName: '管理员' },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { details: { fieldErrors: Record<string, string[]> } } };
    expect(body.error.details.fieldErrors.token).toBeDefined();
  });

  it('弱密码被拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { token: SETUP_TOKEN, username: 'admin', password: 'short', displayName: '管理员' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('正确令牌可创建管理员，且角色强制为 admin', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { token: SETUP_TOKEN, username: 'admin', password: ADMIN_PASSWORD, displayName: '管理员' },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json() as { user: { username: string; role: string } };
    expect(body.user.username).toBe('admin');
    expect(body.user.role).toBe('admin');
  });

  it('重复初始化被拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      payload: { token: SETUP_TOKEN, username: 'other', password: ADMIN_PASSWORD, displayName: 'x' },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: { code: string } }).error.code).toBe('ALREADY_INITIALIZED');
  });

  it('错误密码与不存在的用户返回同一种错误（防用户枚举）', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { username: 'admin', password: 'WrongPassword123!' },
    });
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { username: 'ghost', password: 'WrongPassword123!' },
    });
    expect(wrongPassword.statusCode).toBe(401);
    expect(noSuchUser.statusCode).toBe(401);
    const a = wrongPassword.json() as { error: { code: string; message: string } };
    const b = noSuchUser.json() as { error: { code: string; message: string } };
    expect(a.error.code).toBe('INVALID_CREDENTIALS');
    expect(b.error.code).toBe('INVALID_CREDENTIALS');
    expect(a.error.message).toBe(b.error.message);
  });
});

describe('会话与 CSRF', () => {
  let admin: TestClient;

  beforeAll(async () => {
    admin = await login('admin', ADMIN_PASSWORD);
  });

  it('登录后携带 Cookie 可访问受保护接口', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { user: { username: string }; preferences: { theme: string } };
    expect(body.user.username).toBe('admin');
    expect(body.preferences.theme).toBe('dark');
  });

  it('不带 Cookie 访问受保护接口 → 401', async () => {
    for (const url of ['/api/overview', '/api/containers', '/api/tailscale/devices', '/api/system/snapshot', '/api/tools', '/api/users']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.statusCode, `${url} 应要求登录`).toBe(401);
    }
  });

  it('伪造的会话 Cookie → 401', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/me',
      headers: { cookie: 'hp_session=forged-token-value' },
    });
    expect(response.statusCode).toBe(401);
  });

  it('会话接口返回 CSRF 令牌', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/auth/session',
      headers: { cookie: admin.cookie },
    });
    const body = response.json() as { authenticated: boolean; csrfToken: string; user: { username: string } };
    expect(body.authenticated).toBe(true);
    expect(body.user.username).toBe('admin');
    expect(body.csrfToken).toBe(admin.csrf);
  });

  it('变更类请求缺少 CSRF → 403', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/users/me/preferences',
      headers: { cookie: admin.cookie },
      payload: { theme: 'light' },
    });
    expect(response.statusCode).toBe(403);
    expect((response.json() as { error: { code: string } }).error.code).toBe('CSRF_MISMATCH');
  });

  it('CSRF 令牌错误 → 403', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/users/me/preferences',
      headers: { cookie: admin.cookie, 'x-csrf-token': 'not-the-right-token' },
      payload: { theme: 'light' },
    });
    expect(response.statusCode).toBe(403);
  });

  it('携带正确 CSRF 令牌的变更成功', async () => {
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/users/me/preferences',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { theme: 'light' },
    });
    expect(response.statusCode).toBe(200);
    expect((response.json() as { preferences: { theme: string } }).preferences.theme).toBe('light');
  });

  it('登出后会话立即失效', async () => {
    const temp = await login('admin', ADMIN_PASSWORD);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: temp.cookie, 'x-csrf-token': temp.csrf },
    });
    expect(logout.statusCode).toBe(204);

    const after = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: temp.cookie } });
    expect(after.statusCode).toBe(401);
  });

  it('GET 等安全方法不需要 CSRF', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(200);
  });
});

describe('角色与账号管理', () => {
  let admin: TestClient;
  let viewer: TestClient;
  let viewerId: number;

  beforeAll(async () => {
    admin = await login('admin', ADMIN_PASSWORD);

    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { username: 'viewer01', password: 'ViewerPass2026!', displayName: '只读用户', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    viewerId = (created.json() as { user: { id: number } }).user.id;

    viewer = await login('viewer01', 'ViewerPass2026!');
  });

  it('viewer 可访问只读数据接口', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/containers', headers: { cookie: viewer.cookie } });
    // 数据源可用与否取决于运行环境；契约要求两种情况都返回 200 + 结构完整
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: unknown[]; source: { available: boolean; mode: string }; summary: { total: number } };
    expect(Array.isArray(body.items)).toBe(true);
    expect(typeof body.source.available).toBe('boolean');
    expect(body.summary.total).toBe(body.items.length);
  });

  it('viewer 访问管理员接口 → 403', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: viewer.cookie } });
    expect(list.statusCode).toBe(403);
    expect((list.json() as { error: { code: string } }).error.code).toBe('FORBIDDEN');

    const create = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: viewer.cookie, 'x-csrf-token': viewer.csrf },
      payload: { username: 'x01', password: 'SomePassword123!', role: 'admin' },
    });
    expect(create.statusCode).toBe(403);
  });

  it('重名用户被拒绝', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { username: 'VIEWER01', password: 'AnotherPass2026!', role: 'viewer' },
    });
    expect(response.statusCode).toBe(409);
  });

  it('不能删除最后一个管理员', async () => {
    const meResponse = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: admin.cookie } });
    const adminId = (meResponse.json() as { user: { id: number } }).user.id;

    // 先尝试禁用，再尝试降级，最后尝试删除
    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(409);

    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { role: 'viewer' },
    });
    expect(demote.statusCode).toBe(409);

    const remove = await app.inject({
      method: 'DELETE',
      url: `/api/users/${adminId}`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
    });
    expect(remove.statusCode).toBe(409);
  });

  it('重置密码会吊销目标用户的会话', async () => {
    const reset = await app.inject({
      method: 'POST',
      url: `/api/users/${viewerId}/password`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { newPassword: 'RotatedPass2026!' },
    });
    expect(reset.statusCode).toBe(200);
    expect((reset.json() as { revoked: number }).revoked).toBeGreaterThanOrEqual(1);

    // 旧会话失效
    const oldSession = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: viewer.cookie } });
    expect(oldSession.statusCode).toBe(401);

    // 新密码可登录
    viewer = await login('viewer01', 'RotatedPass2026!');
    const newSession = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: viewer.cookie } });
    expect(newSession.statusCode).toBe(200);
  });

  it('禁用用户后其会话立即失效且无法再登录', async () => {
    const disable = await app.inject({
      method: 'PATCH',
      url: `/api/users/${viewerId}`,
      headers: { cookie: admin.cookie, 'x-csrf-token': admin.csrf },
      payload: { disabled: true },
    });
    expect(disable.statusCode).toBe(200);

    const oldSession = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: viewer.cookie } });
    expect(oldSession.statusCode).toBe(401);

    const relogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'viewer01', password: 'RotatedPass2026!' },
    });
    expect(relogin.statusCode).toBe(403);
  });

  it('审计日志记录了关键动作', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/users/audit/log?limit=50',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(200);
    const actions = (response.json() as { items: Array<{ action: string }> }).items.map((item) => item.action);
    expect(actions).toContain('auth.bootstrap');
    expect(actions).toContain('auth.login');
    expect(actions).toContain('user.create');
    expect(actions).toContain('user.password_reset');
    expect(actions).toContain('user.update');
  });

  it('自助改密后当前会话仍可用', async () => {
    const fresh = await login('admin', ADMIN_PASSWORD);
    const change = await app.inject({
      method: 'POST',
      url: '/api/auth/password',
      headers: { cookie: fresh.cookie, 'x-csrf-token': fresh.csrf },
      payload: { currentPassword: ADMIN_PASSWORD, newPassword: 'PortalAdmin2027!' },
    });
    expect(change.statusCode).toBe(204);

    const stillValid = await app.inject({ method: 'GET', url: '/api/users/me', headers: { cookie: fresh.cookie } });
    expect(stillValid.statusCode).toBe(200);

    const withOldPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(withOldPassword.statusCode).toBe(401);

    const withNewPassword = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': nextIp() },
      payload: { username: 'admin', password: 'PortalAdmin2027!' },
    });
    expect(withNewPassword.statusCode).toBe(200);
  });

  it('登录失败次数过多会被限流（429）', async () => {
    // 固定同一个来源 IP，连续失败直至触发限流（配置为 10 次/分钟）
    const ip = nextIp();
    let sawRateLimit = false;
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-forwarded-for': ip },
        payload: { username: 'admin', password: 'DefinitelyWrong123!' },
      });
      if (response.statusCode === 429) {
        sawRateLimit = true;
        expect((response.json() as { error: { code: string } }).error.code).toBe('RATE_LIMITED');
        break;
      }
      expect(response.statusCode).toBe(401);
    }
    expect(sawRateLimit).toBe(true);
  });
});

describe('接口契约', () => {
  let admin: TestClient;

  beforeAll(async () => {
    admin = await login('admin', 'PortalAdmin2027!');
  });

  it('/api/health 无需登录且结构完整', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      status: string;
      setupRequired: boolean;
      sources: Record<string, { available: boolean; mode: string }>;
    };
    expect(body.status).toBe('ok');
    expect(body.setupRequired).toBe(false);
    for (const key of ['docker', 'tailscale', 'system', 'disk', 'gpu']) {
      expect(body.sources[key], `health.sources.${key} 应存在`).toBeDefined();
    }
  });

  it('未知 API 路径返回 JSON 404 而不是 HTML', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/definitely-not-exists', headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('非法的查询参数返回字段级错误', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/containers?reachability=bogus',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: { code: string; details: { fieldErrors: Record<string, string[]> } } };
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.details.fieldErrors.reachability).toBeDefined();
  });

  it('概览接口返回完整结构，数据源状态反映真实可用性', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/overview', headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      warnings: string[];
      sources: { docker: { available: boolean } };
      containers: { total: number };
      tailnet: { peersTotal: number };
    };
    // 数据源是否可用取决于运行环境（CI 无 docker / 本机有 docker），
    // 契约只要求字段存在且类型正确，不可用时通过 warnings 说明原因。
    expect(typeof body.sources.docker.available).toBe('boolean');
    expect(typeof body.containers.total).toBe('number');
    expect(typeof body.tailnet.peersTotal).toBe('number');
    expect(Array.isArray(body.warnings)).toBe(true);
    if (!body.sources.docker.available) {
      expect(body.warnings.length).toBeGreaterThan(0);
    }
  });

  it('不存在的容器详情返回 404（无论 docker 数据源是否可用）', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/containers/no-such-container',
      headers: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('工具目录在未探测到端口时仍返回完整结构', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/tools?probe=0', headers: { cookie: admin.cookie } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: Array<{ id: string; status: { state: string } }>; summary: { total: number } };
    expect(body.summary.total).toBeGreaterThan(0);
    // probe=0 时不探测
    expect(body.items.every((item) => item.status.state === 'unknown')).toBe(true);
  });
});
