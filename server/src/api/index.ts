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
import type { HealthMonitor } from '../modules/health/monitor.js';
import type { MetricsSampler } from '../modules/metrics/sampler.js';
import type { BackgroundScheduler } from '../modules/metrics/scheduler.js';
import { registerAlertRoutes } from './alerts.js';
import { registerAuthRoutes } from './auth.js';
import { registerContainerRoutes } from './containers.js';
import type { RouteContext } from './context.js';
import { registerHealthMonitorRoutes } from './healthMonitor.js';
import { registerHealthRoutes } from './health.js';
import { registerMetricsRoutes } from './metrics.js';
import { registerOverviewRoutes } from './overview.js';
import { registerSearchRoutes } from './search.js';
import { registerServiceRoutes } from './services.js';
import { registerSettingsRoutes } from './settings.js';
import { registerSystemRoutes } from './system.js';
import { registerTailscaleRoutes } from './tailscale.js';
import { registerToolRoutes } from './tools.js';
import { registerUserRoutes } from './users.js';

/**
 * 告警路由的依赖形状**由 alerts 模块自己定义**。
 *
 * 用 `Parameters<typeof registerAlertRoutes>[2]` 而不是在这里再造一个类型：
 * 两条线并行开发时，任何一方都不该把对方的依赖形状锁死在自己的文件里
 * （它现在就等于 alerts 模块的第三个参数类型）。
 */
export type AlertsRouteDeps = Parameters<typeof registerAlertRoutes>[2];

/**
 * 后台相关的路由依赖（Sprint 2）。
 *
 * 刻意**不放进 `RouteContext`**：`RouteContext` 是全站共享依赖，
 * 而采样器/调度器/健康监视器只有这几个新域用。显式传参让依赖方向一眼可见。
 *
 * 注意：**这些对象始终被构造**（`app.ts` 里无条件 `new`），只有后台**定时器**
 * 受 `buildApp({ backgroundJobs })` 控制 —— 于是 `backgroundJobs: false` 的测试
 * 仍能读 `/api/metrics/history`、`/api/alerts/rules` 等只读接口，
 * 同时不会被后台 tick 重复采集。注释以这段为准（早前写法与实现不符）。
 */
export interface RouteDependencies {
  metrics: MetricsSampler;
  scheduler: BackgroundScheduler;
  /** 健康监视器（`/api/health/monitor` 用；app.ts 里已构造同一个实例） */
  health: HealthMonitor;
  alerts: AlertsRouteDeps;
}

type RouteRegistrar = (app: FastifyInstance, ctx: RouteContext, deps: RouteDependencies) => void;

/** 需要登录的路由域。 */
const PROTECTED_PREFIXES: ReadonlyArray<{ prefix: string; register: RouteRegistrar }> = [
  { prefix: '/api/overview', register: registerOverviewRoutes },
  { prefix: '/api/containers', register: registerContainerRoutes },
  { prefix: '/api/tailscale', register: registerTailscaleRoutes },
  { prefix: '/api/system', register: registerSystemRoutes },
  { prefix: '/api/tools', register: registerToolRoutes },
  // 服务注册表（Sprint 1）：读接口 viewer 可用，写接口在 handler 内要求 admin；
  // 聚合搜索按角色过滤索引内容。
  { prefix: '/api/services', register: registerServiceRoutes },
  { prefix: '/api/search', register: registerSearchRoutes },
  { prefix: '/api/users', register: registerUserRoutes },
  // 设置域内的每个 handler 自行要求 admin（不能只靠 prefix 守卫，
  // 因为 /api/users 下也有非 admin 的 /me 路由，保持一致的写法更安全）
  { prefix: '/api/settings', register: registerSettingsRoutes },
  // 历史指标（Sprint 2）：三个读接口都是 viewer 起步；写操作不存在
  // （采样是后台单例的事，不开放给前端触发）。
  {
    prefix: '/api/metrics',
    register: (app, ctx, deps) => registerMetricsRoutes(app, ctx, { metrics: deps.metrics, scheduler: deps.scheduler }),
  },
  // 告警（Sprint 2）：读 viewer，改规则/确认在 handler 内要求 admin
  { prefix: '/api/alerts', register: (app, ctx, deps) => registerAlertRoutes(app, ctx, deps.alerts) },
  // 健康监测视图（Sprint 2 / S2-03）：逐服务三维状态 + 探测统计，viewer 可读
  {
    prefix: '/api/health/monitor',
    register: (app, ctx, deps) => registerHealthMonitorRoutes(app, ctx, { health: deps.health }),
  },
];

export function registerRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
  deps: RouteDependencies,
): void {
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
        domain.register(scope, ctx, deps);
      },
      { prefix: domain.prefix },
    );
  }
}
