/**
 * 健康监控只读路由：`GET /api/health/monitor`（S2-03 §7）。
 *
 * 单独一个文件（而不是塞进 `api/alerts.ts`）是因为它按**独立前缀**注册：
 * `PROTECTED_PREFIXES` 里 `{ prefix: '/api/health/monitor', register: … }`。
 * 本文件的前缀是它自己的，`/api/alerts` 那边无法替它注册 —— 这也正是两个前缀
 * 各自要有一条 `PROTECTED_PREFIXES` 条目的原因。
 * 前缀挂载时 Fastify 默认同时接受 `/api/health/monitor` 与带尾斜杠两种写法
 * （与 `/api/overview` 一致），因此这里只定义 `'/'` 一个路由。
 *
 * 监视器由 `app.ts` 构造**一次**（后台单例，随 scheduler tick）。这里只读它的内存状态 ——
 * 绝不能在这里 new 一个 HealthMonitor，否则会出现第二条探测循环，把宿主服务探两遍。
 */
import type { FastifyInstance } from 'fastify';
import { HttpError } from '../http/errors.js';
import { createCsrfHook, createRequireRoleHook, requireAuth } from '../http/guards.js';
import type { HealthMonitorView } from '../modules/health/types.js';

/** 监视器的最小形状（不 import 具体类，避免与并行改动耦合）。 */
export interface HealthMonitorLike {
  view(): HealthMonitorView;
}

/**
 * 依赖形状（与 `api/alerts.ts` 同一套三参约定）。
 *
 * 兼容两种装配写法：`{ health: monitor }` 或直接传 monitor 本体 ——
 * 接线由另一位代理做，多一种可接受的形状就少一次"改半天才编译过"。
 */
export interface HealthMonitorRouteDeps {
  health?: HealthMonitorLike | null;
}

/** 本域不需要全站 ctx（监视器是后台单例）；保留形参只为与其它路由域形状一致。 */
export type HealthMonitorRoutesContext = unknown;

function resolveMonitor(deps: HealthMonitorRouteDeps | HealthMonitorLike | null | undefined): HealthMonitorLike | null {
  if (!deps) return null;
  if (typeof (deps as HealthMonitorLike).view === 'function') return deps as HealthMonitorLike;
  const nested = (deps as HealthMonitorRouteDeps).health;
  return nested && typeof nested.view === 'function' ? nested : null;
}

export function registerHealthMonitorRoutes(
  app: FastifyInstance,
  _ctx: HealthMonitorRoutesContext,
  deps: HealthMonitorRouteDeps | HealthMonitorLike,
): void {
  // 兜底守卫：漏加 PROTECTED_PREFIXES 时也不能匿名读到服务健康状态（见 api/alerts.ts 的说明）。
  app.addHook('onRequest', createRequireRoleHook('viewer'));
  app.addHook('onRequest', createCsrfHook());

  app.get('/', async (request) => {
    requireAuth(request);
    const monitor = resolveMonitor(deps);
    if (!monitor) {
      // 明确的接线缺口：返回空列表会被误读成"全部健康 / 没有服务"，所以直接 503。
      throw new HttpError('UPSTREAM_UNAVAILABLE', '健康监视器尚未装配（app.ts 未把 health 传给路由依赖）');
    }
    return monitor.view();
  });
}