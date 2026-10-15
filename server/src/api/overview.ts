/**
 * 概览路由：/api/overview
 *
 * 契约见 docs/static/04-api-contract.md §2。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../http/guards.js';
import type { RouteContext } from './context.js';
import { toHostContextRequest } from './context.js';

export function registerOverviewRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/', async (request) => {
    const session = requireAuth(request);
    return ctx.overview.build(toHostContextRequest(request), session.user.role);
  });
}
