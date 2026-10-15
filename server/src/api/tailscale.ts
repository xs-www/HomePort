/**
 * F2 tailnet 路由：/api/tailscale/*
 *
 * 契约见 docs/static/04-api-contract.md §4。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../http/guards.js';
import type { RouteContext } from './context.js';

export function registerTailscaleRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** 完整设备列表。`?refresh=1` 强制绕过缓存。 */
  app.get('/devices', async (request) => {
    requireAuth(request);
    const force = (request.query as { refresh?: string }).refresh === '1';
    return ctx.tailscale.getStatus(force);
  });

  /** 精简状态（顶栏/概览轮询）。 */
  app.get('/status', async (request) => {
    requireAuth(request);
    const force = (request.query as { refresh?: string }).refresh === '1';
    return ctx.tailscale.getStatusLite(force);
  });
}
