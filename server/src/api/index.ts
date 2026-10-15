/**
 * 路由总装。
 *
 * 权限模型在这里集中表达（"默认安全"）：
 * - `/api/health`、`/api/auth/*` 允许匿名（仅解析会话 + CSRF，不强制登录）；
 * - 其余 `/api/*` 统一要求已登录（viewer 起步），个别接口在 handler 内再要求 admin。
 *
 * 因此新增路由时即使忘记加守卫，最坏结果是"需要登录"，不会匿名开放。
 *
 * 注意：404 处理统一在 app.ts 的 `setNotFoundHandler`（Fastify 只允许注册一个根级处理器）。
 */
import type { FastifyInstance } from 'fastify';
import { createCsrfHook, createRequireRoleHook } from '../http/guards.js';
import { registerAuthRoutes } from './auth.js';
import { registerContainerRoutes } from './containers.js';
import type { RouteContext } from './context.js';
import { registerHealthRoutes } from './health.js';
import { registerOverviewRoutes } from './overview.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSystemRoutes } from './system.js';
import { registerTailscaleRoutes } from './tailscale.js';
import { registerToolRoutes } from './tools.js';
import { registerUserRoutes } from './users.js';

/** 需要登录的路由域。 */
const PROTECTED_PREFIXES: ReadonlyArray<{ prefix: string; register: (app: FastifyInstance, ctx: RouteContext) => void }> = [
  { prefix: '/api/overview', register: registerOverviewRoutes },
  { prefix: '/api/containers', register: registerContainerRoutes },
  { prefix: '/api/tailscale', register: registerTailscaleRoutes },
  { prefix: '/api/system', register: registerSystemRoutes },
  { prefix: '/api/tools', register: registerToolRoutes },
  { prefix: '/api/users', register: registerUserRoutes },
  // 设置域内的每个 handler 自行要求 admin（不能只靠 prefix 守卫，
  // 因为 /api/users 下也有非 admin 的 /me 路由，保持一致的写法更安全）
  { prefix: '/api/settings', register: registerSettingsRoutes },
];

export function registerRoutes(app: FastifyInstance, ctx: RouteContext): void {
  // ---- 匿名可访问
  app.register(
    async (scope) => {
      registerHealthRoutes(scope, ctx);
    },
    { prefix: '/api' },
  );

  app.register(
    async (scope) => {
      registerAuthRoutes(scope, ctx);
    },
    { prefix: '/api/auth' },
  );

  // ---- 需要登录（viewer 及以上）+ CSRF
  for (const domain of PROTECTED_PREFIXES) {
    app.register(
      async (scope) => {
        scope.addHook('onRequest', createRequireRoleHook('viewer'));
        scope.addHook('onRequest', createCsrfHook());
        domain.register(scope, ctx);
      },
      { prefix: domain.prefix },
    );
  }
}
