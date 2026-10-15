/**
 * F4 工具路由：/api/tools/*
 *
 * 契约见 docs/static/04-api-contract.md §6。
 */
import type { FastifyInstance } from 'fastify';
import { notFound } from '../http/errors.js';
import { requireAuth } from '../http/guards.js';
import { idParamSchema, parseOrThrow, toolsQuerySchema } from '../http/schemas.js';
import { buildHostContext } from '../modules/docker/hostContext.js';
import type { RouteContext } from './context.js';
import { toHostContextRequest } from './context.js';

export function registerToolRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** 当前请求的主机上下文（工具入口 URL 依赖它）。 */
  const hostContextFor = (request: Parameters<typeof toHostContextRequest>[0]) =>
    buildHostContext({
      config: ctx.config,
      request: toHostContextRequest(request),
      tailscaleIpv4: ctx.tailscale.getTailscaleIpv4(),
      tailscaleDnsName: ctx.tailscale.getTailscaleDnsName(),
    });

  /** 工具列表。 */
  app.get('/', async (request) => {
    const session = requireAuth(request);
    const query = parseOrThrow(toolsQuerySchema, request.query, '工具查询参数');
    return ctx.tools.list(
      {
        probe: query.probe,
        role: session.user.role,
        ...(query.category ? { category: query.category } : {}),
      },
      hostContextFor(request),
    );
  });

  /** 单工具强制刷新探测。 */
  app.get('/:id/probe', async (request) => {
    requireAuth(request);
    const { id } = parseOrThrow(idParamSchema, request.params, '工具 ID');
    const tool = await ctx.tools.getOne(id, hostContextFor(request));
    if (!tool) throw notFound(`工具 ${id} 不存在`);
    return { tool };
  });
}
