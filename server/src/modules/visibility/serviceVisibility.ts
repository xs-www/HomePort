/**
 * 读路径的「当前可见服务」—— **唯一实现**（历史指标 `/api/metrics/*` 与告警 `/api/alerts/*` 共用）。
 *
 * ## 为什么需要一个共享模块
 *
 * 这个问题修过两次、都是同一个形状：**写侧按 viewer 视角采集 ≠ 读侧受可见性约束**。
 *
 * - 指标：采集时固定 `role: 'viewer'`，只保证"隐藏之后不再产生新样本"；**隐藏之前**
 *   已落库的历史行与进程内 `liveTargets` 仍带着服务名，于是 catalog 继续列、history 继续查。
 * - 告警：事件行的 `target` / `target_label` 是**触发时落库**的快照，同样不随可见性变化，
 *   于是服务被隐藏/删除后，名字继续出现在事件列表与徽标摘要里。
 *
 * 两处的答案是同一句话：读响应必须按**当前**可见性再过滤一次。既然是同一句话，
 * 实现也只能有一份 —— 各写一遍必然在两处慢慢产生"哪边口径才对"的漂移
 * （Sprint 2 的教训：同类泄漏修了三次）。
 *
 * ## 三条刻意保持的行为（与已提交的指标读路径逐字一致，不要在这里"优化"）
 *
 * 1. **不缓存**：可见性是 `services.visibility` 这一行 DB 事实，读它不产生 Docker 调用
 *    （`ServiceRegistryService.list` 内部的发现与容器列表各自走既有 TTL 缓存）。
 *    加一层缓存只会把"隐藏"的生效时刻推迟到 TTL 之后，而那段窗口正是泄漏窗口。
 * 2. **fail-closed**：注册表读失败时返回 `null`，调用方必须把它当作"服务/容器类目标一律不可见"，
 *    而不是"过滤不了就当没过滤"。
 * 3. **不分角色**：固定 `role: 'viewer'`，admin 与 viewer 走同一条可见集合
 *    （`/api/metrics/catalog`、`/api/metrics/history` 已经如此并有测试钉住）。
 *    admin 要"看到一切"就走 `includeHidden` 的管理接口，读路径不开特例。
 */
import type { Logger } from '../../logger.js';
import type { HostContextRequest } from '../docker/service.js';
import type { ServiceListQuery, ServiceRole } from '../services/service.js';

/**
 * 服务注册表的最小依赖面。
 *
 * 用**结构类型**而不是 import 具体类：只需要 `list()`，传真实 `ServiceRegistryService`
 * 实例即可自动满足（`MetricsServiceRegistrySource` 与它同形）。
 */
export interface ServiceVisibilityRegistry {
  list(
    request: HostContextRequest,
    query?: ServiceListQuery,
    role?: ServiceRole,
  ): Promise<{ items: ReadonlyArray<{ sourceRef: string }> }>;
}

/** `service:<sourceRef>` / `container:<sourceRef>`：target 里承载的服务稳定身份。 */
export const SERVICE_TARGET_PREFIX = 'service:';
export const CONTAINER_TARGET_PREFIX = 'container:';

/** 服务类目标的两种载体：服务健康（服务维度）与容器（容器是服务的绑定）。 */
export type ServiceTargetKind = 'service' | 'container';

/**
 * 从 target 取出它引用的服务稳定身份。
 *
 * - `service:<sourceRef>` → `<sourceRef>`
 * - `container:<sourceRef>` → `<sourceRef>`（`containerServiceRef` 与服务的 `sourceRef` 同源）
 * - 其它（`host`、`disk:<label>`、空串、未知前缀）→ `null`：**不属于任何服务**，
 *   调用方据此原样放过（宿主与磁盘目标与可见性无关）。
 *
 * 传了 `kind` 就是"顺便校验前缀与类型对得上"：`service_health` 只能配 `service:`、
 * `container_exit` 只能配 `container:`；对不上返回 `null`（调用方按不可见处理，fail-closed）。
 */
export function serviceRefOfTarget(target: string, kind?: ServiceTargetKind): string | null {
  if (target.startsWith(SERVICE_TARGET_PREFIX)) {
    if (kind !== undefined && kind !== 'service') return null;
    return target.slice(SERVICE_TARGET_PREFIX.length);
  }
  if (target.startsWith(CONTAINER_TARGET_PREFIX)) {
    if (kind !== undefined && kind !== 'container') return null;
    return target.slice(CONTAINER_TARGET_PREFIX.length);
  }
  return null;
}

/**
 * 一个服务类 target 是否允许出现在读响应里。
 *
 * `visible === null`（注册表不可用）时**一律拒绝** —— 宁可少列一条，也不泄露一条。
 * 不属于任何服务的 target 由调用方先判掉（本函数对它们返回 `false`，不是 `true`：
 * "宿主目标恒可见"是调用方的策略，不是这里的默认值）。
 */
export function isServiceTargetVisible(
  target: string,
  visible: ReadonlySet<string> | null,
  kind?: ServiceTargetKind,
): boolean {
  if (visible === null) return false;
  const ref = serviceRefOfTarget(target, kind);
  return ref !== null && visible.has(ref);
}

export interface ServiceVisibilityDeps {
  registry: ServiceVisibilityRegistry;
  /** 与后台采集**同一个**中性宿主上下文（`backgroundHostRequest(config)`），保证两侧判定同源。 */
  request: HostContextRequest;
  /** 日志来源标签（`metrics.read` / `alerts.read`），失败告警里用它区分是哪条读路径。 */
  source: string;
  /** 可选日志出口；没有就静默失败（返回值本身已经表达了失败）。 */
  logger?: Pick<Logger, 'warn'> | null;
}

/**
 * 读取"当前 viewer 可见服务"的 `sourceRef` 集合。
 *
 * @returns 可见集合；注册表读失败时返回 `null`（调用方必须 **fail-closed**）。
 */
export async function loadVisibleServiceRefs(deps: ServiceVisibilityDeps): Promise<ReadonlySet<string> | null> {
  try {
    const listed = await deps.registry.list(deps.request, {}, 'viewer');
    return new Set(listed.items.map((item) => item.sourceRef));
  } catch (error) {
    deps.logger?.warn('读取服务可见性失败：依赖可见性的读路径按不可见处理（fail-closed，宿主类数据不受影响）', {
      source: deps.source,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}