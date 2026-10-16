/**
 * 历史指标路由：`/api/metrics/*`（S2-02 的读侧）。
 *
 * 契约见 `docs/sprint2-implementation-spec.md` §7：
 * | 方法 | 路径 | 角色 |
 * | --- | --- | --- |
 * | GET | `/api/metrics/catalog` | viewer |
 * | GET | `/api/metrics/history` | viewer |
 * | GET | `/api/metrics/storage` | viewer |
 *
 * 三个都是只读接口，权限由 `api/index.ts` 的前缀守卫（`requireRole('viewer')` + CSRF 钩子）
 * 统一保证；这里再 `requireAuth` 一次是纵深防御（万一将来有人把前缀漏掉）。
 *
 * **API 层不做任何单位换算**：percent 就是百分比数值，bytes 就是字节数，
 * unit 原样透出，前端按 unit 选刻度。
 */
import type { FastifyInstance } from 'fastify';
import { badRequest } from '../http/errors.js';
import { requireAuth } from '../http/guards.js';
import { METRIC_RANGES, isMetricRange } from '../modules/metrics/history.js';
import type { MetricsSampler } from '../modules/metrics/sampler.js';
import type { BackgroundScheduler } from '../modules/metrics/scheduler.js';
import { METRIC_CATALOG, metricByKey, type MetricSchedulerView } from '../modules/metrics/types.js';
import type { RouteContext } from './context.js';

/**
 * 本域的路由依赖。
 *
 * 为什么不放进 `RouteContext`：`RouteContext` 的字段是"全站共享依赖"，
 * 而采样器只有本域与调度器用；从 `registerRoutes(app, ctx, deps)` 显式传入，
 * 依赖方向一眼可见。
 *
 * 注意（与 `app.ts` 的实现对齐）：采样器**始终被构造**，只有后台**定时器**
 * 受 `buildApp({ backgroundJobs })` 控制 —— 于是 `backgroundJobs: false` 的测试
 * 仍能读 `/api/metrics/history`（不会因为没数据源而只能测 404），
 * 同时不会被后台 tick 重复采集。
 */
export interface MetricsRouteDeps {
  metrics: MetricsSampler;
  /** 后台调度器（可选）：只用于透出"后台有没有在跑、上次错在哪" */
  scheduler?: BackgroundScheduler;
}

/** 取一个必填的字符串查询参数。 */
function requiredQueryParam(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw badRequest(`缺少查询参数 ${name}`, { fieldErrors: { [name]: [`必须提供 ${name}`] } });
  }
  return value.trim();
}

/** 调度器状态视图；没接调度器时为 null（测试里很常见）。 */
export function toSchedulerView(scheduler?: BackgroundScheduler): MetricSchedulerView | null {
  if (!scheduler) return null;
  const summary = scheduler.lastSummary();
  return {
    running: scheduler.running,
    lastTickAt: summary?.at ?? null,
    lastDurationMs: summary?.durationMs ?? null,
    lastError: summary?.error ?? null,
  };
}

export function registerMetricsRoutes(
  app: FastifyInstance,
  _ctx: RouteContext,
  deps: MetricsRouteDeps,
): void {
  /** 目录：指标清单 + 可用 target + range 表 + 采样状态（前端据此渲染选择器）。 */
  app.get('/catalog', async (request) => {
    requireAuth(request);
    return deps.metrics.catalog(toSchedulerView(deps.scheduler));
  });

  /**
   * 历史曲线。
   *
   * 两个校验都在这里做（而不是在 service 层抛 HTTP 错误）：
   * 未知 metric / 未知 range / 未知 target 一律 `VALIDATION_FAILED`，
   * 并且把"允许什么"写进 details，前端可以直接展示。
   */
  app.get('/history', async (request) => {
    requireAuth(request);
    const query = (request.query ?? {}) as Record<string, unknown>;
    const metricKey = requiredQueryParam(query['metric'], 'metric');
    const target = requiredQueryParam(query['target'], 'target');
    const range = requiredQueryParam(query['range'], 'range');

    const metric = metricByKey(metricKey);
    if (!metric) {
      throw badRequest(`未知的指标键 "${metricKey}"`, {
        fieldErrors: { metric: [`未知的指标键 "${metricKey}"`] },
        allowed: METRIC_CATALOG.map((item) => item.key),
      });
    }
    if (!isMetricRange(range)) {
      throw badRequest(`未知的时间范围 "${range}"`, {
        fieldErrors: { range: [`只能是 ${METRIC_RANGES.map((item) => item.range).join(' / ')}`] },
      });
    }

    const targetLabel = deps.metrics.resolveTarget(metric, target);
    if (targetLabel === null) {
      throw badRequest(`未知的指标目标 "${target}"`, {
        fieldErrors: { target: [`该指标下没有出现过的 target：${target}`] },
        targetPattern: metric.targetPattern,
      });
    }

    return deps.metrics.history({ metric, target, targetLabel, range });
  });

  /** 存储：行数 / 文件占用 / 保留配置 / 预算估算 + 最近一次采样摘要。 */
  app.get('/storage', async (request) => {
    requireAuth(request);
    return deps.metrics.storage();
  });
}