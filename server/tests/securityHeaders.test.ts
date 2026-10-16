/**
 * 安全响应头与可信代理边界单测（S0-03）。
 *
 * 这里测的是两件事：
 * 1. `securityHeadersFor()` / `registerSecurityHeaders()` 的输出是否正确，
 *    特别是 **HSTS 只在 HTTPS 时下发**、`/api/*` 带 `no-store`；
 * 2. `trustProxy` 的默认边界是否真的挡住了伪造的 `X-Forwarded-For`
 *    —— 这直接决定登录限流能不能被绕过。
 */
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { parseTrustProxy, DEFAULT_CSP, DEFAULT_TRUST_PROXY } from '../src/config.js';
import {
  registerSecurityHeaders,
  securityHeadersFor,
  STATIC_SECURITY_HEADERS,
} from '../src/http/securityHeaders.js';

const baseConfig = { enabled: true, csp: DEFAULT_CSP, hsts: true, hstsMaxAge: 15_552_000 };

describe('securityHeaders · HSTS 只在 HTTPS 下发', () => {
  it('明文 HTTP 不下发 HSTS（避免把内网 HTTP 锁死）', () => {
    const headers = securityHeadersFor(baseConfig, 'http');
    expect(headers['strict-transport-security']).toBeUndefined();
    expect(headers['content-security-policy']).toBe(DEFAULT_CSP);
  });

  it('HTTPS 下发 HSTS，且不带 includeSubDomains / preload', () => {
    const hsts = securityHeadersFor(baseConfig, 'https')['strict-transport-security'];
    expect(hsts).toBe('max-age=15552000');
    expect(hsts).not.toContain('includeSubDomains');
    expect(hsts).not.toContain('preload');
  });

  it('maxAge 为 0 或关闭开关时不下发 HSTS', () => {
    expect(securityHeadersFor({ ...baseConfig, hstsMaxAge: 0 }, 'https')['strict-transport-security']).toBeUndefined();
    expect(securityHeadersFor({ ...baseConfig, hsts: false }, 'https')['strict-transport-security']).toBeUndefined();
  });

  it('总开关关闭后一个头都不发', () => {
    expect(securityHeadersFor({ ...baseConfig, enabled: false }, 'https')).toEqual({});
  });

  it('固定头包含 nosniff / frame-ancestors 相关项，且 CSP 允许 SSE 所需连接', () => {
    const headers = securityHeadersFor(baseConfig, 'http');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    // SSE / fetch 走同源，必须允许 'self' 连接，否则实时指标会被 CSP 掐断
    expect(headers['content-security-policy']).toContain("connect-src 'self'");
    expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(headers['content-security-policy']).toContain("script-src 'self'");
    // 明确不要放开脚本内联（XSS 防线）
    expect(headers['content-security-policy']).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(STATIC_SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
  });
});

describe('securityHeaders · 钩子集成', () => {
  async function buildProbeApp(config = baseConfig) {
    const app = Fastify({ trustProxy: parseTrustProxy(undefined) });
    registerSecurityHeaders(app, config);
    app.get('/api/health', async () => ({ ok: true }));
    app.get('/', async (_req, reply) => reply.type('text/html').send('<html></html>'));
    app.get('/api/system/stream', async (request, reply) => {
      // 模拟真实 SSE 处理器：直接写 raw head，不走 Fastify 发送流程
      const headers = securityHeadersFor(config, request.protocol);
      reply.raw.writeHead(200, {
        ...headers,
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
      });
      reply.raw.write('data: {"cpu":1}\n\n');
      reply.raw.end();
    });
    return app;
  }

  it('API 响应带安全头与 no-store', async () => {
    const app = await buildProbeApp();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['strict-transport-security']).toBeUndefined();
    await app.close();
  });

  it('来自回环代理的 X-Forwarded-Proto: https 才产生 HSTS', async () => {
    const app = await buildProbeApp();
    const viaProxy = await app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(viaProxy.headers['strict-transport-security']).toBe('max-age=15552000');

    // 非可信来源自报 https：默认信任范围只含回环，因此不得据此下发 HSTS
    const forged = await app.inject({
      method: 'GET',
      url: '/api/health',
      remoteAddress: '100.72.255.30',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(forged.headers['strict-transport-security']).toBeUndefined();
    await app.close();
  });

  it('SSE 响应仍是 event-stream 且不被安全头破坏', async () => {
    const app = await buildProbeApp();
    const res = await app.inject({ method: 'GET', url: '/api/system/stream' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toBe('no-cache, no-transform');
    expect(res.body).toContain('data: {"cpu":1}');
    await app.close();
  });

  it('HTML 首页带 CSP（不阻断自身 JS/CSS）', async () => {
    const app = await buildProbeApp();
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.headers['content-security-policy']).toContain("style-src 'self' 'unsafe-inline'");
    await app.close();
  });

  it('关闭开关时不下发安全头，但请求仍正常', async () => {
    const app = await buildProbeApp({ ...baseConfig, enabled: false });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['x-content-type-options']).toBeUndefined();
    await app.close();
  });
});

describe('config · trustProxy 可信代理边界', () => {
  it('默认只信任回环（而不是信任所有人）', () => {
    expect(DEFAULT_TRUST_PROXY).toBe('loopback');
    expect(parseTrustProxy(undefined)).toBe('loopback');
    expect(parseTrustProxy('')).toBe('loopback');
    expect(parseTrustProxy('   ')).toBe('loopback');
    expect(parseTrustProxy(null)).toBe('loopback');
  });

  it('布尔写法保持向后兼容', () => {
    for (const raw of ['1', 'true', 'TRUE', 'on', 'yes']) expect(parseTrustProxy(raw)).toBe(true);
    for (const raw of ['0', 'false', 'off', 'no']) expect(parseTrustProxy(raw)).toBe(false);
  });

  it('支持预置名与 IP/CIDR 列表', () => {
    expect(parseTrustProxy('loopback')).toBe('loopback');
    expect(parseTrustProxy('127.0.0.1/8,::1')).toEqual(['127.0.0.1/8', '::1']);
    expect(parseTrustProxy('10.0.0.0/8')).toBe('10.0.0.0/8');
  });

  it('非法值直接报错，绝不静默退化成"信任所有人"', () => {
    expect(() => parseTrustProxy('yes-please')).toThrow(/PORTAL_TRUST_PROXY 非法/);
    expect(() => parseTrustProxy('10.0.0.0/8,not-an-ip')).toThrow(/非法/);
  });

  it('默认配置下伪造的 X-Forwarded-For 不改变 request.ip（否则限流可被绕过）', async () => {
    const app = Fastify({ trustProxy: parseTrustProxy(undefined) });
    app.get('/ip', async (request) => ({ ip: request.ip }));

    const direct = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '100.72.255.30',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(direct.json().ip).toBe('100.72.255.30');

    const viaProxy = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(viaProxy.json().ip).toBe('1.2.3.4');
    await app.close();
  });

  it('显式信任所有人时 X-Forwarded-For 生效（有反代场景的显式选择）', async () => {
    const app = Fastify({ trustProxy: parseTrustProxy('1') });
    app.get('/ip', async (request) => ({ ip: request.ip }));
    const res = await app.inject({
      method: 'GET',
      url: '/ip',
      remoteAddress: '100.72.255.30',
      headers: { 'x-forwarded-for': '1.2.3.4' },
    });
    expect(res.json().ip).toBe('1.2.3.4');
    await app.close();
  });
});