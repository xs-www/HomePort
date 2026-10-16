/**
 * 服务注册表路由：/api/services/*
 *
 * 契约见 docs/sprint1-implementation-spec.md §4。**成功响应不带信封**：
 * 列表直接返回 `ServiceListResponse`，详情直接返回 `ServiceDetailResponse`，
 * 与 spec 的 JSON 示例逐字段对应（前端 `web/src/api/types.ts` 是同一份形状）。
 *
 * 权限三件套（匿名 401 / viewer 写 403 / 缺 CSRF 403）：
 * - `/api/services` 在 `api/index.ts` 的 `PROTECTED_PREFIXES` 里 → 前缀守卫已要求登录 + CSRF；
 * - 写操作在 handler 内再 `assertAdmin`（与 `api/settings.ts` 同一写法）。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth, type AuthContext } from '../http/guards.js';
import {
  idParamSchema,
  parseOrThrow,
  serviceCreateBodySchema,
  serviceDeleteQuerySchema,
  serviceHealthBodySchema,
  serviceListQuerySchema,
  serviceReorderBodySchema,
  serviceUpdateBodySchema,
} from '../http/schemas.js';
import type { ServiceActor } from '../modules/services/service.js';
import type { RouteContext } from './context.js';
import { toHostContextRequest } from './context.js';

export function registerServiceRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** 路由层 → 服务层：把已认证用户转成审计执行者。 */
  const actorOf = (session: AuthContext, ip: string): ServiceActor => ({
    userId: session.user.id,
    username: session.user.username,
    ip,
  });

  /** 服务墙列表（`includeHidden` 仅 admin 生效，判定在服务层）。 */
  app.get('/', async (request) => {
    const session = requireAuth(request);
    const query = parseOrThrow(serviceListQuerySchema, request.query, '服务查询参数');
    return ctx.services.list(
      toHostContextRequest(request),
      {
        ...(query.query ? { query: query.query } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.favorite !== undefined ? { favorite: query.favorite } : {}),
        ...(query.includeHidden !== undefined ? { includeHidden: query.includeHidden } : {}),
      },
      session.user.role,
    );
  });

  /** 服务详情（含全部候选入口与诊断）；hidden 对非 admin 返回 404。 */
  app.get('/:id', async (request) => {
    const session = requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params, '服务 ID');
    return ctx.services.detail(id, toHostContextRequest(request), session.user.role);
  });

  /** 新建手工服务。 */
  app.post('/', async (request, reply) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const body = parseOrThrow(serviceCreateBodySchema, request.body, '创建服务参数');
    const service = await ctx.services.create(body, actorOf(session, request.ip), toHostContextRequest(request));
    return reply.status(201).send(service);
  });

  /** 批量排序（放在 `/:id` 之前的静态路径，语义更直观；Fastify 也优先匹配静态段）。 */
  app.post('/reorder', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const body = parseOrThrow(serviceReorderBodySchema, request.body, '排序参数');
    return ctx.services.reorder(body.order, actorOf(session, request.ip), toHostContextRequest(request));
  });

  /** 强制重新发现（跳过 TTL 缓存），返回最新列表。 */
  app.post('/discover', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const hostRequest = toHostContextRequest(request);
    await ctx.services.sync(hostRequest, { force: true });
    return ctx.services.list(hostRequest, { includeHidden: true }, 'admin');
  });

  /** 改展示属性 / 首选入口 / 可见性 / 排序 / 收藏 / 健康配置。 */
  app.patch('/:id', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(idParamSchema, request.params, '服务 ID');
    const body = parseOrThrow(serviceUpdateBodySchema, request.body, '更新服务参数');
    return ctx.services.update(id, body, actorOf(session, request.ip), toHostContextRequest(request));
  });

  /** 删除（手工）/ 隐藏（自动）/ 重置用户覆盖（`?mode=reset`）。 */
  app.delete('/:id', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(idParamSchema, request.params, '服务 ID');
    const query = parseOrThrow(serviceDeleteQuerySchema, request.query, '删除参数');
    return ctx.services.remove(
      id,
      query.mode === 'reset' ? 'reset' : null,
      actorOf(session, request.ip),
      toHostContextRequest(request),
    );
  });

  /** 一次性健康探测（管理员显式动作；目标每次重新校验）。 */
  app.post('/:id/health', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(idParamSchema, request.params, '服务 ID');
    const body = parseOrThrow(serviceHealthBodySchema, request.body ?? {}, '健康探测参数');
    return ctx.services.probeHealth(
      id,
      body.healthTarget ?? null,
      actorOf(session, request.ip),
      toHostContextRequest(request),
    );
  });
}