/**
 * 用户与偏好路由：/api/users/*
 *
 * 契约见 docs/static/04-api-contract.md §7。
 * `/me*` 仅要求登录；其余接口在 handler 内显式要求 admin。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../http/guards.js';
import {
  auditQuerySchema,
  createUserBodySchema,
  numericIdParamSchema,
  parseOrThrow,
  preferencesBodySchema,
  resetPasswordBodySchema,
  totpDisableBodySchema,
  totpEnableBodySchema,
  totpRecoveryCodesBodySchema,
  updateUserBodySchema,
} from '../http/schemas.js';
import type { RouteContext } from './context.js';

/** 审计日志默认条数。 */
export const DEFAULT_AUDIT_LIMIT = 100;

export function registerUserRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** 当前用户信息 + 偏好。 */
  app.get('/me', async (request) => {
    const session = requireAuth(request);
    return {
      user: session.user,
      preferences: ctx.users.preferences(session.user.id),
    };
  });

  /** 更新自己的偏好。 */
  app.patch('/me/preferences', async (request) => {
    const session = requireAuth(request);
    const body = parseOrThrow(preferencesBodySchema, request.body, '偏好参数');
    return { preferences: ctx.users.updatePreferences(session.user.id, body) };
  });

  /** 管理员：用户列表。 */
  app.get('/', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    return ctx.users.list();
  });

  // ---- 两步验证（TOTP）----
  //
  // 这几个路由刻意挂在 `/api/users/me/*` 而不是 `/api/auth/*`：
  // `/api/auth/*` 是**匿名**作用域（登录前就要能用），没有角色守卫也没有 CSRF 钩子；
  // 而绑定/关闭两步验证是登录后的变更操作，必须同时满足
  // 「已登录」+「CSRF 校验」。挂在 `/api/users` 下就自动继承这两层。

  /** 两步验证 · 开始绑定：生成种子并以未确认状态保存（明文种子只返回这一次）。 */
  app.post('/me/totp/setup', async (request) => {
    const session = requireAuth(request);
    return ctx.auth.beginTotpSetup(session);
  });

  /** 两步验证 · 确认启用：回填验证器上的码，成功后**一次性**返回恢复码。 */
  app.post('/me/totp/enable', async (request) => {
    const session = requireAuth(request);
    const body = parseOrThrow(totpEnableBodySchema, request.body, '两步验证参数');
    const result = await ctx.auth.enableTotp(session, body.code, request.ip);
    ctx.logger.info('用户启用了两步验证', { username: session.user.username });
    return result;
  });

  /** 两步验证 · 关闭（需密码；已启用时还需一次当前验证码或恢复码）。 */
  app.post('/me/totp/disable', async (request) => {
    const session = requireAuth(request);
    const body = parseOrThrow(totpDisableBodySchema, request.body, '关闭两步验证参数');
    const user = await ctx.auth.disableTotp(session, {
      password: body.password,
      code: body.code,
      ip: request.ip,
    });
    ctx.logger.info('用户关闭了两步验证', { username: session.user.username });
    return { ok: true, user };
  });

  /** 两步验证 · 重新生成恢复码（旧码全部作废）。 */
  app.post('/me/totp/recovery-codes', async (request) => {
    const session = requireAuth(request);
    const body = parseOrThrow(totpRecoveryCodesBodySchema, request.body, '恢复码参数');
    const recoveryCodes = await ctx.auth.regenerateRecoveryCodes(session, body.code, request.ip);
    return { recoveryCodes };
  });

  /**
   * 管理员：强制重置某用户的两步验证（用户丢失验证器时的兜底流程）。
   *
   * 副作用是"清空种子 + 吊销该用户全部会话"，因此审计会记录到管理员头上。
   */
  app.post('/:id/totp/reset', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(numericIdParamSchema, request.params, '用户 ID');
    const revokedSessions = ctx.auth.resetTotpForUser(session, id, request.ip);
    return { ok: true, revokedSessions };
  });

  /** 管理员：创建用户。 */
  app.post('/', async (request, reply) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const body = parseOrThrow(createUserBodySchema, request.body, '创建用户参数');
    const user = await ctx.users.create(
      session.user,
      {
        username: body.username,
        password: body.password,
        displayName: body.displayName ?? '',
        role: body.role ?? 'viewer',
      },
      request.ip,
    );
    return reply.status(201).send({ user });
  });

  /** 管理员：更新用户。 */
  app.patch('/:id', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(numericIdParamSchema, request.params, '用户 ID');
    const body = parseOrThrow(updateUserBodySchema, request.body, '更新用户参数');
    return { user: ctx.users.update(session.user, id, body, request.ip) };
  });

  /** 管理员：删除用户。 */
  app.delete('/:id', async (request, reply) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(numericIdParamSchema, request.params, '用户 ID');
    ctx.users.delete(session.user, id, request.ip);
    return reply.status(204).send();
  });

  /** 管理员：重置他人密码（吊销目标用户全部会话）。 */
  app.post('/:id/password', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(numericIdParamSchema, request.params, '用户 ID');
    const body = parseOrThrow(resetPasswordBodySchema, request.body, '重置密码参数');
    const target = ctx.users.get(id);
    const revoked = await ctx.auth.resetPassword(session, id, body.newPassword, request.ip);
    ctx.auth.invalidateUserCache(target.id);
    ctx.logger.info('管理员重置用户密码', {
      actor: session.user.username,
      target: target.username,
      revoked,
    });
    return { revoked };
  });

  /** 管理员：强制用户下线。 */
  app.post('/:id/sessions/revoke', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(numericIdParamSchema, request.params, '用户 ID');
    return { revoked: ctx.users.revokeSessions(session.user, id, request.ip) };
  });

  /** 管理员：某用户活跃会话数。 */
  app.get('/:id/sessions', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(numericIdParamSchema, request.params, '用户 ID');
    const user = ctx.users.get(id);
    return { userId: user.id, activeSessions: ctx.users.activeSessionCount(id) };
  });

  /** 管理员：审计日志。 */
  app.get('/audit/log', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const query = parseOrThrow(auditQuerySchema, request.query, '审计查询参数');
    const items = ctx.audit.list(query.limit ?? DEFAULT_AUDIT_LIMIT);
    return { items, total: items.length };
  });
}
