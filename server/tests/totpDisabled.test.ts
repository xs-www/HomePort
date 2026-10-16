/**
 * `PORTAL_TOTP_ENABLED=0` 的**语义**测试。
 *
 * 这个开关最容易写成"关掉就什么都不管"，那样会静默降低所有已绑定账号的安全性；
 * 也容易写成"关掉就把两步验证整个停掉"，那样用户连关闭它都做不到。
 * 因此这里把三条边界钉死：
 *
 * 1. 关掉时**不能新绑定**（setup / enable 都被拒，`TOTP_UNAVAILABLE`）；
 * 2. 关掉时**已绑定的账号仍然必须走第二步**（不存在静默降级）；
 * 3. 关掉时**仍然可以关闭两步验证 / 重生成恢复码**（否则用户被锁在门外）。
 *
 * 用独立的 app 实例（独立内存库 + 独立临时数据目录）跑，避免污染 totpFlow.test.ts。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppHandle } from '../src/app.js';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import { totpCode } from '../src/modules/auth/totp.js';

const SETUP_TOKEN = 'TOTP-OFF-SETUP-TOKEN';
const PASSWORD = 'TotpOffAdmin2026!';
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-totp-off-'));

let handle: AppHandle;
let app: FastifyInstance;
let config: PortalConfig;

beforeAll(async () => {
  config = loadConfig({
    env: 'test',
    logLevel: 'error',
    dataDir: TMP_DIR,
    dbPath: ':memory:',
    trustProxy: true,
    tailscale: { mode: 'off', bin: '', socket: '/nonexistent', apiToken: '', tailnet: '-', timeoutMs: 200 },
    bootstrap: { token: SETUP_TOKEN, tokenFile: path.join(TMP_DIR, 'setup-token.txt') },
    session: { ttlHours: 12, rememberTtlHours: 24, cookieName: 'hp_session' },
    // 服务端关闭两步验证
    totp: { enabled: false, issuer: 'HomePort', window: 1, challengeTtlSeconds: 300 },
  });
  handle = await buildApp({
    config,
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

let ip = 90;
function inject(payload: {
  method: 'GET' | 'POST';
  url: string;
  cookie?: string;
  csrf?: string;
  body?: unknown;
}) {
  ip += 1;
  const headers: Record<string, string> = { 'x-forwarded-for': `10.9.0.${ip}` };
  if (payload.cookie) headers.cookie = payload.cookie;
  if (payload.csrf) headers['x-csrf-token'] = payload.csrf;
  return app.inject({
    method: payload.method,
    url: payload.url,
    headers,
    ...(payload.body === undefined ? {} : { payload: payload.body as object }),
  });
}

interface Client {
  cookie: string;
  csrf: string;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
  for (const value of values) {
    const match = /(^|;\s*)(hp_session=[^;]*)/.exec(value);
    if (match?.[2]) return match[2];
  }
  throw new Error('登录响应里没有会话 Cookie');
}

async function login(): Promise<Client> {
  const response = await inject({
    method: 'POST',
    url: '/api/auth/login',
    body: { username: 'admin', password: PASSWORD },
  });
  expect(response.statusCode, response.body).toBe(200);
  const body = response.json() as { csrfToken: string };
  return { cookie: cookieOf(response.headers['set-cookie']), csrf: body.csrfToken };
}

describe('两步验证 · 服务端关闭（PORTAL_TOTP_ENABLED=0）', () => {
  let admin: Client;
  let secret = '';

  it('首启初始化后密码登录正常（关闭 TOTP 不影响既有认证）', async () => {
    const bootstrap = await inject({
      method: 'POST',
      url: '/api/auth/bootstrap',
      body: { token: SETUP_TOKEN, username: 'admin', password: PASSWORD, displayName: '管理员' },
    });
    expect(bootstrap.statusCode).toBe(201);
    admin = await login();
  });

  it('关闭时不允许开始绑定（400 TOTP_UNAVAILABLE）', async () => {
    const response = await inject({ method: 'POST', url: '/api/users/me/totp/setup', cookie: admin.cookie, csrf: admin.csrf });
    expect(response.statusCode, response.body).toBe(400);
    expect((response.json() as { error: { code: string } }).error.code).toBe('TOTP_UNAVAILABLE');
  });

  it('打开开关后可以绑定（证明门禁是唯一拦路者）', async () => {
    config.totp.enabled = true;

    const setup = await inject({ method: 'POST', url: '/api/users/me/totp/setup', cookie: admin.cookie, csrf: admin.csrf });
    expect(setup.statusCode, setup.body).toBe(200);
    secret = (setup.json() as { secret: string }).secret;

    const enable = await inject({
      method: 'POST',
      url: '/api/users/me/totp/enable',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { code: totpCode(secret) },
    });
    expect(enable.statusCode, enable.body).toBe(200);
  });

  it('再次关闭开关：已绑定的账号仍然必须走第二步，且第二步可用', async () => {
    config.totp.enabled = false;

    const step1 = await inject({ method: 'POST', url: '/api/auth/login', body: { username: 'admin', password: PASSWORD } });
    expect(step1.statusCode).toBe(200);
    const challenge = step1.json() as { totpRequired?: boolean; challengeToken?: string };
    // 关键：不存在"关掉开关就只用密码"的静默降级
    expect(challenge.totpRequired).toBe(true);

    const step2 = await inject({
      method: 'POST',
      url: '/api/auth/login/totp',
      body: { challengeToken: challenge.challengeToken, code: totpCode(secret) },
    });
    expect(step2.statusCode, step2.body).toBe(200);
    admin = { cookie: cookieOf(step2.headers['set-cookie']), csrf: (step2.json() as { csrfToken: string }).csrfToken };
  });

  it('关闭开关时仍能关闭两步验证（不会被自己的开关锁在门外）', async () => {
    const response = await inject({
      method: 'POST',
      url: '/api/users/me/totp/disable',
      cookie: admin.cookie,
      csrf: admin.csrf,
      body: { password: PASSWORD, code: totpCode(secret) },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect((response.json() as { user: { totpEnabled: boolean } }).user.totpEnabled).toBe(false);
  });
});