/**
 * F5 认证路由：/api/auth/*
 *
 * 契约见 docs/static/04-api-contract.md §1。
 * 本文件只做「校验 → 调用 service → 设置 Cookie」，不含业务判断。
 */
import type { FastifyInstance } from 'fastify';
import { buildClearCookie, buildSessionCookie, clientHints, requireAuth } from '../http/guards.js';
import { bootstrapBodySchema, changePasswordBodySchema, loginBodySchema, parseOrThrow } from '../http/schemas.js';
import type { RouteContext } from './context.js';

/** 登录限流配置：10 次/分钟/IP。 */
export const LOGIN_RATE_LIMIT = { max: 10, timeWindow: '1 minute' };

export function registerAuthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  const { auth, config, logger } = ctx;

  /** 会话状态（免登录）。未登录时 csrfToken 为空字符串。 */
  app.get('/session', async (request) => {
    const view = auth.describeSession(request.auth);
    return {
      setupRequired: view.setupRequired,
      authenticated: view.authenticated,
      csrfToken: view.csrfToken,
      user: view.user,
      expiresAt: view.expiresAt,
    };
  });

  /** 登录。 */
  app.post('/login', { config: { rateLimit: LOGIN_RATE_LIMIT } }, async (request, reply) => {
    const body = parseOrThrow(loginBodySchema, request.body, '登录参数');
    const result = await auth.login({
      username: body.username,
      password: body.password,
      remember: body.remember ?? false,
      hints: clientHints(request),
    });

    const maxAgeSeconds = Math.max(0, Math.floor((Date.parse(result.expiresAt) - Date.now()) / 1000));
    reply.header(
      'set-cookie',
      buildSessionCookie({
        name: config.session.cookieName,
        value: result.token,
        expires: new Date(result.expiresAt),
        secure: config.secureCookies,
        maxAgeSeconds,
      }),
    );
    logger.info('用户登录', { username: result.user.username, role: result.user.role, ip: request.ip });
    return { user: result.user, csrfToken: result.csrfToken, expiresAt: result.expiresAt };
  });

  /** 登出。 */
  app.post('/logout', async (request, reply) => {
    const session = requireAuth(request);
    auth.logout(session.session.id, session.user, request.ip);
    reply.header('set-cookie', buildClearCookie(config.session.cookieName, config.secureCookies));
    return reply.status(204).send();
  });

  /** 首启初始化。 */
  app.post('/bootstrap', async (request, reply) => {
    const body = parseOrThrow(bootstrapBodySchema, request.body, '初始化参数');
    const user = await auth.bootstrap({
      token: body.token,
      username: body.username,
      password: body.password,
      displayName: (body.displayName ?? '').trim(),
      hints: clientHints(request),
    });
    return reply.status(201).send({ user });
  });

  /** 自助改密。 */
  app.post('/password', async (request, reply) => {
    const session = requireAuth(request);
    const body = parseOrThrow(changePasswordBodySchema, request.body, '改密参数');
    await auth.changeOwnPassword(session, {
      currentPassword: body.currentPassword,
      newPassword: body.newPassword,
      ip: request.ip,
    });
    return reply.status(204).send();
  });

  /** 当前会话详情（诊断用）。 */
  app.get('/session/activity', async (request) => {
    const session = requireAuth(request);
    return {
      sessionId: session.session.id,
      createdAt: session.session.createdAt,
      expiresAt: session.session.expiresAt,
      lastSeenAt: session.session.lastSeenAt,
      userAgent: session.session.userAgent,
      remoteAddr: session.session.remoteAddr,
    };
  });
}
