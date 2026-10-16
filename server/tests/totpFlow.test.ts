/**
 * 两步验证（TOTP）端到端测试：走真实路由 + 真实数据库（内存）。
 *
 * 这里验的是**行为不变量**，而不是实现细节：
 * 1. 没启用两步验证的账号登录行为完全不变（回归保护）；
 * 2. 启用后必须走两步，第一步**不签发会话**；
 * 3. 绑定/关闭/重生成恢复码都要 CSRF，且未登录一律 401；
 * 4. 种子与恢复码都不以明文进数据库，也不出现在任何 API 响应里；
 * 5. 恢复码一次性；登录路径上的 TOTP 码防重放，但**会话内的再次确认不消费计数器**
 *    （否则"绑定完立刻登录"会被自己的防重放挡住 —— 这是有意的取舍，见 auth/service.ts）；
 * 6. 管理员可强制重置他人的两步验证（丢失设备流程），并吊销其全部会话。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import { totpCode } from '../src/modules/auth/totp.js';

const SETUP_TOKEN = 'TOTP-FLOW-SETUP-TOKEN';
const ADMIN_PASSWORD = 'TotpAdmin2026!';
const VIEWER_PASSWORD = 'TotpViewer2026!';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-totp-'));

const testConfig = loadConfig({
  env: 'test',
  logLevel: 'error',
  dataDir: TMP_DIR,
  dbPath: ':memory:',
  // 打开 trustProxy 让每个用例能用不同来源 IP，避免登录限流串扰
  trustProxy: true,
  tailscale: { mode: 'off', bin: '', socket: '/nonexistent', apiToken: '', tailnet: '-', timeoutMs: 200 },
  bootstrap: { token: SETUP_TOKEN, tokenFile: path.join(TMP_DIR, 'setup-token.txt') },
  session: { ttlHours: 12, rememberTtlHours: 24, cookieName: 'hp_session' },
});

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
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

let ipCounter = 40;
function nextIp(): string {
  ipCounter += 1;
  return `10.7.${Math.floor(ipCounter / 250)}.${ipCounter % 250}`;
}

interface TestClient {
  cookie: string;
  csrf: string;
  userId: number;
}

function sessionCookieOf(setCookie: string | string[] | undefined): string | null {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const match = /(^|;\s*)(hp_session=[^;]*)/.exec(value);
    if (match?.[2]) return match[2];
  }
  return null;
}

async function inject(payload: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  client?: { cookie: string; csrf?: string } | null;
  body?: unknown;
  headers?: Record<string, string>;
}) {
  const headers: Record<string, string> = {
    'x-forwarded-for': nextIp(),
    ...(payload.headers ?? {}),
  };
  if (payload.client?.cookie) headers.cookie = payload.client.cookie;
  if (payload.client?.csrf) headers['x-csrf-token'] = payload.client.csrf;
  return app.inject({
    method: payload.method,
    url: payload.url,
    headers,
    ...(payload.body === undefined ? {} : { payload: payload.body as object }),
  });
}

/** 登录（假设不需要第二步）。 */
async function login(username: string, password: string): Promise<TestClient> {
  const response = await inject({ method: 'POST', url: '/api/auth/login', body: { username, password } });
  expect(response.statusCode, `登录 ${username} 应成功：${response.body}`).toBe(200);
  const body = response.json() as { csrfToken: string; user: { id: number } };
  const cookie = sessionCookieOf(response.headers['set-cookie']);
  expect(cookie).not.toBeNull();
  return { cookie: cookie!, csrf: body.csrfToken, userId: body.user.id };
}

/**
 * 从一次成功登录的响应里取出完整客户端凭据。
 *
 * **Cookie 与 CSRF 必须成对更新**：CSRF 令牌是每条会话独立的，
 * 只换 Cookie 会让后续变更类请求全部 403 —— 这是本测试第一版踩过的坑。
 */
function clientOf(
  response: { headers: Record<string, unknown>; json: () => unknown },
  fallbackUserId: number,
): TestClient {
  const body = response.json() as { csrfToken: string; user?: { id: number } };
  const cookie = sessionCookieOf(response.headers['set-cookie'] as string | string[] | undefined);
  expect(cookie, '登录响应应带会话 Cookie').not.toBeNull();
  return { cookie: cookie!, csrf: body.csrfToken, userId: body.user?.id ?? fallbackUserId };
}

/** 完成"两步登录"（admin 账号），返回刷新后的客户端凭据。 */
async function loginAdminWithTotp(code: string): Promise<TestClient> {
  const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
  expect(step1.statusCode, step1.body).toBe(200);
  const { challengeToken } = step1.json() as { challengeToken: string };
  const step2 = await inject({
    method: 'POST',
    url: '/api/auth/login/totp',
    body: { challengeToken, code },
  });
  expect(step2.statusCode, step2.body).toBe(200);
  return clientOf(step2, admin.userId);
}

/** 读数据库里该用户的 TOTP 原始列（用于断言"落库的是密文"）。 */
function totpColumns(userId: number): { secret: string | null; enabled: number; lastCounter: number | null } {
  const row = handle.db
    .prepare('SELECT totp_secret AS secret, totp_enabled AS enabled, totp_last_counter AS lastCounter FROM users WHERE id = ?')
    .get(userId) as { secret: string | null; enabled: number; lastCounter: number | null } | undefined;
  if (!row) throw new Error(`用户 ${userId} 不存在`);
  return row;
}

/** 清掉防重放计数，便于在同一个 30 秒窗口内重复"干净地"登录。 */
function clearReplayCounter(userId: number): void {
  handle.db.prepare('UPDATE users SET totp_last_counter = NULL WHERE id = ?').run(userId);
}

let admin: TestClient;
let adminSecret = '';
let adminRecoveryCodes: string[] = [];
let viewer: TestClient;

describe('两步验证 · 未启用时行为不变', () => {
  it('首启初始化创建管理员，且密码登录直接签发会话', async () => {
    const bootstrap = await inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      body: { token: SETUP_TOKEN, username: 'admin', password: ADMIN_PASSWORD, displayName: '管理员' },
    });
    expect(bootstrap.statusCode).toBe(201);

    admin = await login('admin', ADMIN_PASSWORD);
    expect(totpColumns(admin.userId).enabled).toBe(0);

    const session = await inject({ method: 'GET', url: '/api/auth/session', client: admin });
    expect(session.statusCode).toBe(200);
    expect((session.json() as { user: { totpEnabled: boolean } }).user.totpEnabled).toBe(false);
  });
});

describe('两步验证 · 绑定流程', () => {
  it('未登录不能访问绑定接口（挂在 /api/users 下即继承登录 + CSRF 守卫）', async () => {
    const anonymous = await inject({ method: 'POST', url: '/api/users/me/totp/setup' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('缺少 CSRF 令牌时被拒（变更类请求）', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/users/me/totp/setup',
      client: { cookie: admin.cookie },
    });
    expect(response.statusCode).toBe(403);
  });

  it('setup 返回明文种子与 otpauth 链接，但库里存的是密文且尚未启用', async () => {
    const response = await inject({ method: 'POST', url: '/api/users/me/totp/setup', client: admin });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { secret: string; otpauthUri: string; digits: number; period: number };
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.otpauthUri.startsWith('otpauth://totp/')).toBe(true);
    expect(body.digits).toBe(6);
    expect(body.period).toBe(30);

    adminSecret = body.secret;
    const columns = totpColumns(admin.userId);
    expect(columns.enabled).toBe(0);
    // 落库必须是密文，且不含明文种子的任何片段
    expect(columns.secret).toMatch(/^enc:v1:/);
    expect(columns.secret).not.toContain(adminSecret);
  });

  it('用错误的码确认启用会被拒绝，且账号仍未启用', async () => {
    const wrong = String((Number(totpCode(adminSecret)) + 7) % 1_000_000).padStart(6, '0');
    const response = await inject({
      method: 'POST',
      url: '/api/users/me/totp/enable',
      client: admin,
      body: { code: wrong },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe('TOTP_INVALID');
    expect(totpColumns(admin.userId).enabled).toBe(0);
  });

  it('用正确的码启用成功，一次性返回 10 个恢复码（库里只存摘要）', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/users/me/totp/enable',
      client: admin,
      body: { code: totpCode(adminSecret) },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = response.json() as { recoveryCodes: string[]; user: { totpEnabled: boolean } };
    expect(body.recoveryCodes).toHaveLength(10);
    expect(body.user.totpEnabled).toBe(true);
    adminRecoveryCodes = body.recoveryCodes;

    expect(totpColumns(admin.userId).enabled).toBe(1);
    // 恢复码不得以明文进库
    const rows = handle.db.prepare('SELECT code_hash FROM totp_recovery_codes WHERE user_id = ?').all(admin.userId) as Array<{
      code_hash: string;
    }>;
    expect(rows).toHaveLength(10);
    for (const row of rows) {
      expect(row.code_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(adminRecoveryCodes.some((code) => row.code_hash.includes(code.replace('-', '')))).toBe(false);
    }
  });

  it('重复 setup 在已启用时报冲突', async () => {
    const response = await inject({ method: 'POST', url: '/api/users/me/totp/setup', client: admin });
    expect(response.statusCode).toBe(409);
  });
});

describe('两步验证 · 登录两步流程', () => {
  it('第一步只返回挑战，不签发会话', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/auth/login',
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { totpRequired?: boolean; challengeToken?: string; user?: unknown };
    expect(body.totpRequired).toBe(true);
    expect(typeof body.challengeToken).toBe('string');
    expect(body.user).toBeUndefined();
    // 关键：不能有会话 Cookie，否则第二步形同虚设
    expect(sessionCookieOf(response.headers['set-cookie'])).toBeNull();
  });

  it('第二步用错误的码 → 401 TOTP_INVALID', async () => {
    const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
    const { challengeToken } = step1.json() as { challengeToken: string };
    const wrong = String((Number(totpCode(adminSecret)) + 3) % 1_000_000).padStart(6, '0');

    const step2 = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken, code: wrong },
    });
    expect(step2.statusCode).toBe(401);
    expect((step2.json() as { error: { code: string } }).error.code).toBe('TOTP_INVALID');
  });

  it('绑定完立刻用同一个码登录也成功（防重放不作用于绑定路径）', async () => {
    const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
    const { challengeToken } = step1.json() as { challengeToken: string };
    const step2 = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken, code: totpCode(adminSecret) },
    });
    expect(step2.statusCode, step2.body).toBe(200);
    expect(sessionCookieOf(step2.headers['set-cookie'])).not.toBeNull();
    admin = clientOf(step2, admin.userId);
  });

  it('同一个登录码再次使用会被判重放', async () => {
    // 先清掉上一轮记录的计数器，让这次"第一次使用"是干净的
    clearReplayCounter(admin.userId);
    const code = totpCode(adminSecret);

    // 第一次：正常登录，该码的时间步被记为已用
    admin = await loginAdminWithTotp(code);

    // 第二次：同一个码（换一个新挑战）必须被判重放而失败
    const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
    const replay = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken: (step1.json() as { challengeToken: string }).challengeToken, code },
    });
    expect(replay.statusCode).toBe(401);
    expect((replay.json() as { error: { code: string } }).error.code).toBe('TOTP_INVALID');
  });

  it('无效/伪造的挑战令牌 → 401 TOTP_CHALLENGE_EXPIRED', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken: 'x'.repeat(32), code: totpCode(adminSecret) },
    });
    expect(response.statusCode).toBe(401);
    expect((response.json() as { error: { code: string } }).error.code).toBe('TOTP_CHALLENGE_EXPIRED');
  });

  it('连续错码 5 次后挑战作废，即使随后给对码也不再接受', async () => {
    const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
    const { challengeToken } = step1.json() as { challengeToken: string };
    const wrong = String((Number(totpCode(adminSecret)) + 11) % 1_000_000).padStart(6, '0');

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await inject({ method: 'POST', url: '/api/auth/login/totp', body: { challengeToken, code: wrong } });
      expect(response.statusCode).toBe(401);
    }
    // 第 6 次给正确的码：挑战已被作废
    clearReplayCounter(admin.userId);
    const afterLocked = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken, code: totpCode(adminSecret) },
    });
    expect(afterLocked.statusCode).toBe(401);
    expect((afterLocked.json() as { error: { code: string } }).error.code).toBe('TOTP_CHALLENGE_EXPIRED');
  });
});

describe('两步验证 · 恢复码', () => {
  it('恢复码可以完成第二步，且用掉一次就失效', async () => {
    clearReplayCounter(admin.userId);
    const recoveryCode = adminRecoveryCodes[0]!;

    const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
    const ok = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken: (step1.json() as { challengeToken: string }).challengeToken, code: recoveryCode },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    admin = clientOf(ok, admin.userId);

    const step2 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
    const reuse = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken: (step2.json() as { challengeToken: string }).challengeToken, code: recoveryCode },
    });
    expect(reuse.statusCode).toBe(401);
  });

  it('恢复码可以不带连字符输入（归一化）', async () => {
    const plain = adminRecoveryCodes[1]!.replace('-', '');
    const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
    const response = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken: (step1.json() as { challengeToken: string }).challengeToken, code: plain },
    });
    expect(response.statusCode, response.body).toBe(200);
  });

  it('重新生成恢复码后旧码全部作废', async () => {
    clearReplayCounter(admin.userId);
    const oldCode = adminRecoveryCodes[2]!;
    const regenerate = await inject({
      method: 'POST',
      url: '/api/users/me/totp/recovery-codes',
      client: admin,
      body: { code: totpCode(adminSecret) },
    });
    expect(regenerate.statusCode, regenerate.body).toBe(200);
    const fresh = (regenerate.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(oldCode);

    const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: ADMIN_PASSWORD } });
    const stale = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken: (step1.json() as { challengeToken: string }).challengeToken, code: oldCode },
    });
    expect(stale.statusCode).toBe(401);
    adminRecoveryCodes = fresh;
  });
});

describe('两步验证 · 种子不外泄', () => {
  it('用户与设置相关接口的响应里都不含明文种子或密文', async () => {
    const responses = await Promise.all([
      inject({ method: 'GET', url: '/api/users', client: admin }),
      inject({ method: 'GET', url: '/api/users/me', client: admin }),
      inject({ method: 'GET', url: '/api/auth/session', client: admin }),
    ]);
    for (const response of responses) {
      expect(response.body).not.toContain(adminSecret);
      expect(response.body).not.toContain('enc:v1:');
      expect(response.body).not.toContain('totpSecret');
      expect(response.body).not.toContain(adminRecoveryCodes[0]!);
    }
  });

  it('用户列表带 totpEnabled 标记（前端据此显示徽标）', async () => {
    const response = await inject({ method: 'GET', url: '/api/users', client: admin });
    const users = (response.json() as { items: Array<{ username: string; totpEnabled: boolean; totpConfirmedAt: string | null }> }).items;
    const adminRow = users.find((user) => user.username === 'admin');
    expect(adminRow?.totpEnabled).toBe(true);
    // 前端用 totpConfirmedAt 显示"启用时间"，必须是真实的时间字符串而不是 undefined
    expect(typeof adminRow?.totpConfirmedAt).toBe('string');
    expect(Number.isNaN(Date.parse(adminRow!.totpConfirmedAt!))).toBe(false);

    // 会话接口也带同样的字段（登录后立即渲染安全面板时会用到）
    const session = await inject({ method: 'GET', url: '/api/auth/session', client: admin });
    const sessionUser = (session.json() as { user: { totpEnabled: boolean; totpConfirmedAt: string | null } }).user;
    expect(sessionUser.totpEnabled).toBe(true);
    expect(typeof sessionUser.totpConfirmedAt).toBe('string');
  });
});

describe('两步验证 · 管理员强制重置（丢失设备流程）', () => {
  let viewerSecret = '';
  let viewerRecoveryCodes: string[] = [];

  it('viewer 启用两步验证后，其会话在管理员重置时被吊销', async () => {
    // 管理员建一个 viewer 并登录
    const created = await inject({
      method: 'POST',
      url: '/api/users',
      client: admin,
      body: { username: 'viewer1', password: VIEWER_PASSWORD, displayName: '只读账号', role: 'viewer' },
    });
    expect(created.statusCode).toBe(201);
    viewer = await login('viewer1', VIEWER_PASSWORD);

    // viewer 自己绑定两步验证
    const setup = await inject({ method: 'POST', url: '/api/users/me/totp/setup', client: viewer });
    viewerSecret = (setup.json() as { secret: string }).secret;
    const enable = await inject({
      method: 'POST',
      url: '/api/users/me/totp/enable',
      client: viewer,
      body: { code: totpCode(viewerSecret) },
    });
    expect(enable.statusCode, enable.body).toBe(200);
    viewerRecoveryCodes = (enable.json() as { recoveryCodes: string[] }).recoveryCodes;
    expect(totpColumns(viewer.userId).enabled).toBe(1);

    // viewer 不能自己重置别人的（也不能碰管理员接口）
    const forbidden = await inject({
      method: 'POST',
      url: `/api/users/${admin.userId}/totp/reset`,
      client: { cookie: viewer.cookie, csrf: viewer.csrf },
    });
    expect(forbidden.statusCode).toBe(403);

    // 管理员强制重置
    const reset = await inject({
      method: 'POST',
      url: `/api/users/${viewer.userId}/totp/reset`,
      client: admin,
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const result = reset.json() as { ok: boolean; revokedSessions: number };
    expect(result.ok).toBe(true);
    expect(result.revokedSessions).toBeGreaterThanOrEqual(1);

    expect(totpColumns(viewer.userId).enabled).toBe(0);
    const leftovers = handle.db
      .prepare('SELECT COUNT(*) AS c FROM totp_recovery_codes WHERE user_id = ?')
      .get(viewer.userId) as { c: number };
    expect(leftovers.c).toBe(0);

    // 被吊销：旧 Cookie 立刻失效
    const after = await inject({ method: 'GET', url: '/api/users/me', client: viewer });
    expect(after.statusCode).toBe(401);

    // 重置后 viewer 只需密码即可登录
    viewer = await login('viewer1', VIEWER_PASSWORD);
    expect(viewerRecoveryCodes.length).toBe(10);
    expect(viewerSecret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('重置不存在的用户 → 404', async () => {
    const response = await inject({ method: 'POST', url: '/api/users/9999/totp/reset', client: admin });
    expect(response.statusCode).toBe(404);
  });
});

describe('两步验证 · 关闭', () => {
  it('密码错误 → 400；缺少验证码 → 400；正确密码 + 正确码 → 关闭成功', async () => {
    const wrongPassword = await inject({
      method: 'POST',
      url: '/api/users/me/totp/disable',
      client: admin,
      body: { password: 'WrongPassword2026!', code: totpCode(adminSecret) },
    });
    expect(wrongPassword.statusCode).toBe(400);

    const missingCode = await inject({
      method: 'POST',
      url: '/api/users/me/totp/disable',
      client: admin,
      body: { password: ADMIN_PASSWORD },
    });
    expect(missingCode.statusCode).toBe(400);

    const wrongCode = await inject({
      method: 'POST',
      url: '/api/users/me/totp/disable',
      client: admin,
      body: { password: ADMIN_PASSWORD, code: '000000' },
    });
    expect(wrongCode.statusCode).toBe(401);

    clearReplayCounter(admin.userId);
    const ok = await inject({
      method: 'POST',
      url: '/api/users/me/totp/disable',
      client: admin,
      body: { password: ADMIN_PASSWORD, code: totpCode(adminSecret) },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((ok.json() as { user: { totpEnabled: boolean } }).user.totpEnabled).toBe(false);
    expect(totpColumns(admin.userId).secret).toBeNull();
  });

  it('关闭后登录恢复成"一步完成"', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/auth/login',
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { totpRequired?: boolean; csrfToken: string };
    expect(body.totpRequired).toBeUndefined();
    expect(typeof body.csrfToken).toBe('string');
  });
});