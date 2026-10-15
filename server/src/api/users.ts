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
