/**
 * F1 容器路由：/api/containers/*
 *
 * 契约见 docs/static/04-api-contract.md §3。
 */
import type { FastifyInstance } from 'fastify';
import { notFound } from '../http/errors.js';
import { requireAuth } from '../http/guards.js';
import { containerListQuerySchema, containerLogsQuerySchema, idParamSchema, parseOrThrow } from '../http/schemas.js';
import type { RouteContext } from './context.js';
import { toHostContextRequest } from './context.js';

/** 日志默认与最大行数。 */
export const DEFAULT_LOG_TAIL = 200;

export function registerContainerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** 容器列表。 */
  app.get('/', async (request) => {
    requireAuth(request);
    const query = parseOrThrow(containerListQuerySchema, request.query, '容器查询参数');
    return ctx.containers.list(
      {
        all: query.all,
        stats: query.stats,
        ...(query.reachability ? { reachability: query.reachability } : {}),
        ...(query.q ? { q: query.q } : {}),
      },
      toHostContextRequest(request),
    );
  });

  /** 数据源状态（容器墙顶部的角标）。 */
  app.get('/source', async (request) => {
    requireAuth(request);
    return { source: await ctx.containers.checkAvailability() };
  });

  /** 容器详情。 */
  app.get('/:id', async (request) => {
    requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params, '容器 ID');
    const detail = await ctx.containers.detail(id, toHostContextRequest(request));
    if (!detail) throw notFound(`容器 ${id} 不存在`);
    return { container: detail };
  });

  /** 容器日志（已脱敏）。 */
  app.get('/:id/logs', async (request) => {
    requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params, '容器 ID');
    const query = parseOrThrow(containerLogsQuerySchema, request.query, '日志查询参数');
    const logs = await ctx.containers.logs(
      id,
      { tail: query.tail ?? DEFAULT_LOG_TAIL, timestamps: query.timestamps },
      toHostContextRequest(request),
    );
    if (!logs) throw notFound(`容器 ${id} 不存在`);
    return logs;
  });
}
