/**
 * 告警路由：`/api/alerts/*`（S2-04 §7）。
 *
 * 契约（**无信封**，与既有接口一致）：
 * | 方法 | 路径 | 角色 |
 * | --- | --- | --- |
 * | GET | `/api/alerts/rules` | viewer |
 * | PATCH | `/api/alerts/rules/:id` | admin |
 * | GET | `/api/alerts/events?state=&limit=` | viewer |
 * | POST | `/api/alerts/events/:id/ack` | admin |
 * | GET | `/api/alerts/summary` | viewer |
 *
 * 权限分两层，缺一不可：
 * 1. 路由域（`/api/alerts`）在 `api/index.ts` 的 `PROTECTED_PREFIXES` 里统一挂
 *    `requireRole('viewer')` + CSRF；
 * 2. 写操作在 handler 内再 `assertAdmin`（与 `api/services.ts` 同一写法）。
 *
 * **本文件另外自带一份 viewer + CSRF 钩子作为兜底**：接线是另一位代理的工作，
 * 万一 `PROTECTED_PREFIXES` 漏了这条前缀，最坏结果也必须是"需要登录 + 缺 CSRF 被拒"，
 * 而不是把只读的规则与事件匿名开放出去。重复挂同一钩子是幂等的（只是多校验一次），
 * 这个代价远小于"漏一个前缀就对外裸奔"。
 *
 * ## 读路径的当前可见性（S2 修复）
 *
 * 事件行的 `target` / `target_label` / `message` 是**触发时落库**的快照，不会随
 * 服务被隐藏/删除而变化 —— 只按库里的行读，viewer 就一直在告警里看到被隐藏服务的名字。
 * 因此 `/events` 与 `/summary` 每次请求都先用**共享的** `modules/visibility/serviceVisibility.ts`
 * 取一份"当前 viewer 可见服务"，交给 `AlertsService` 过滤（SQL 层，见那边的注释）。
 *
 * 与已提交的 `/api/metrics/*` 读路径**同一口径**：同一条共享函数、固定 `role: 'viewer'`、
 * 不缓存、注册表读失败 fail-closed、**admin 与 viewer 看到同一份可见集合**
 * （`visibility.test.ts` 里对 metrics 的行为就是这样钉住的：
 * "admin 会话同样看不到"。要"看全部"请走 `includeHidden` 的管理接口，读路径不开特例）。
 *
 * 校验 schema 写在本文件而不是 `http/schemas.ts`：那是既有共享文件（本轮不许改），
 * 且这里的规则校验真正的主场在 `modules/alerts/rules.ts`（`validateRulePatch`），
 * zod 只负责"形状 + 边界"。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PortalConfig } from '../config.js';
import { createCsrfHook, createRequireRoleHook, requireAuth, type AuthContext } from '../http/guards.js';
import { idParamSchema, parseOrThrow } from '../http/schemas.js';
import { backgroundHostRequest } from '../modules/docker/backgroundContext.js';
import type { HealthMonitorView } from '../modules/health/types.js';
import type { AlertsService, AlertEventVisibility } from '../modules/alerts/service.js';
import type { AlertRuleListResponse, AlertRulePatch, AlertSummaryView } from '../modules/alerts/types.js';
import { loadVisibleServiceRefs, type ServiceVisibilityRegistry } from '../modules/visibility/serviceVisibility.js';

/**
 * 路由所需的最小依赖（局部接口）。
 *
 * 刻意**不**复述 `api/context.ts` 的 `RouteContext`：那个类型由装配方维护，
 * 两边各自定义会在对方加字段时产生编译冲突。这里只声明本文件真正用到的东西。
 *
 * `config` / `services` / `logger` 都是**可选**的，因为本文件会被单独挂载测试
 * （见 `tests/alertsApi.test.ts` 的 `/api/alerts-unwired`）。缺任意一个都按
 * "可见性来源不可用"处理 —— **fail-closed**，不是不过滤。
 */
export interface AlertRoutesContext {
  users: { assertAdmin(user: { role: string }): void };
  /** 与后台采集同一个中性宿主上下文的来源（`backgroundHostRequest(config)`） */
  config?: Pick<PortalConfig, 'port'>;
  /** 服务注册表（只需 `list()`；与 `/api/metrics/*` 用的是同一个实例） */
  services?: ServiceVisibilityRegistry;
  logger?: { warn(message: string, detail?: Record<string, unknown>): void } | null;
}

/**
 * 告警域的路由依赖（**由本模块定义形状**，装配方只负责把对象传进来）。
 *
 * `engine` / `scheduler` 是可选的"状态透出"入口：`summary().evaluatedAt` 与
 * `suppressed` 的真实来源是引擎（它才知道"这一轮压掉了几次"）；没有引擎时
 * 退化为 `AlertsService` 自己记录的值（装配期没人调 `recordTick` 时就是 0/null）。
 */
export interface AlertRouteDeps {
  alerts: AlertsService;
  engine?: { lastTickAt(): string | null; suppressedTotal(): number } | null;
  /** 后台调度器：当前不读它的字段，仅接受装配方传入（透出后台状态由 /api/metrics 负责）。 */
  scheduler?: unknown;
  /**
   * 健康监视器。若装配方把它放进这里，仍**需要**在 `api/index.ts` 的
   * `PROTECTED_PREFIXES` 里单独注册 `/api/health/monitor`
   * （见 `api/healthMonitor.ts`）—— 本文件的前缀是 `/api/alerts`，无法替它注册。
   */
  health?: { view(): HealthMonitorView } | null;
}

/** `GET /api/alerts/events` 查询参数（`.strict()`：拼错参数直接 400，不静默忽略）。 */
const eventQuerySchema = z
  .object({
    state: z.enum(['all', 'open', 'resolved']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .strict();

/**
 * `PATCH /api/alerts/rules/:id` 请求体：只接受这六个字段（§7 明文）。
 *
 * 只校验"是不是这个类型/这个形状"，取值域交给 `validateRulePatch`
 * （那里知道 kind，才能判断"service_health 的阈值必须 ≤ 10"这类规则）。
 */
const rulePatchBodySchema = z
  .object({
    enabled: z.boolean().optional(),
    threshold: z.number().finite().nullable().optional(),
    durationSec: z.number().int().optional(),
    silenceSec: z.number().int().optional(),
    notifyRecovery: z.boolean().optional(),
    target: z.string().max(200).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

function actorOf(session: AuthContext): string {
  return session.user.username;
}

/**
 * 取"当前可见服务集合"给读 handler 用（`null` = 不可用 → 下游 fail-closed）。
 *
 * 依赖缺失（单独挂载本文件时很常见）不当异常抛：读接口失败会变成 5xx，
 * 而正确行为是"少显示几条"，不是"整个告警页打不开"。所以这里只记一条 warn。
 */
async function loadAlertsVisibility(ctx: AlertRoutesContext): Promise<AlertEventVisibility> {
  const registry = ctx.services;
  const config = ctx.config;
  if (!registry || !config) {
    ctx.logger?.warn('告警读路径缺少可见性来源（config/services 未装配）：服务与容器类事件按不可见处理（fail-closed）', {
      source: 'alerts.read',
      hasConfig: Boolean(config),
      hasRegistry: Boolean(registry),
    });
    return null;
  }
  return loadVisibleServiceRefs({
    registry,
    request: backgroundHostRequest(config),
    source: 'alerts.read',
    logger: ctx.logger ?? null,
  });
}

/**
 * 把服务层摘要与引擎的真实计数合起来（纯函数，便于单测）。
 *
 * 为什么需要合成：`suppressed` 与 `evaluatedAt` 的真相在引擎里（只有它每轮 tick
 * 才知道压掉了几次、上次评估在什么时候），而其余计数在数据库里（服务层查得到）。
 * 装配方传了引擎就用引擎的值 —— 不做 `Math.max` 之类的"折中"，一个数只能有一个来源。
 */
export function composeAlertSummary(
  summary: AlertSummaryView,
  engine: { lastTickAt(): string | null; suppressedTotal(): number } | null | undefined,
): AlertSummaryView {
  if (!engine) return summary;
  return { ...summary, suppressed: engine.suppressedTotal(), evaluatedAt: engine.lastTickAt() ?? summary.evaluatedAt };
}

export function registerAlertRoutes(app: FastifyInstance, ctx: AlertRoutesContext, deps: AlertRouteDeps): void {
  // 兜底守卫（见文件头注释）。与 api/index.ts 的统一守卫叠加时是幂等的。
  app.addHook('onRequest', createRequireRoleHook('viewer'));
  app.addHook('onRequest', createCsrfHook());

  /**
   * 规则列表：四条内置 + 当前配置（未启用也返回，`enabled` 字段说明状态）。
   *
   * **不做可见性过滤**（与本轮收口的 `/events`、`/summary` 不同）：`rule.target` 是
   * **管理员自己写的配置**（`PATCH /rules/:id` 的入参，按 kind 校验过前缀），
   * 不是"发现出来的服务名"；把它按可见性抹成 null 会让 viewer 看到一份与
   * 实际规则不一致的配置（"这条规则到底盯的是什么"会说不清）。这是刻意的边界，
   * 不是漏改 —— 本轮的泄漏面是**触发时落库的事件快照**。
   */
  app.get('/rules', async (request) => {
    requireAuth(request);
    const response: AlertRuleListResponse = { items: deps.alerts.rules() };
    return response;
  });

  /** 部分更新规则（admin）。非法阈值 → 400，未知规则 → 404。 */
  app.patch('/rules/:id', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(idParamSchema, request.params, '告警规则 ID');
    const body = parseOrThrow(rulePatchBodySchema, request.body, '告警规则参数');
    return deps.alerts.updateRule(id, body as AlertRulePatch, actorOf(session));
  });

  /**
   * 事件列表：默认最近 50 条；`counts` 是全量计数（徽标用）。
   *
   * 三条语义一起看才完整：`items` 按当前可见性过滤后才截断到 `limit`；
   * `total` 与 `counts` 同样是**可见集合内**的全量计数（与 `limit` 无关）。
   */
  app.get('/events', async (request) => {
    requireAuth(request);
    const query = parseOrThrow(eventQuerySchema, request.query, '告警事件查询参数');
    return deps.alerts.events({ state: query.state, limit: query.limit }, await loadAlertsVisibility(ctx));
  });

  /** 确认事件（admin）。已恢复的事件也能确认；重复确认幂等。 */
  app.post('/events/:id/ack', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const { id } = parseOrThrow(idParamSchema, request.params, '告警事件 ID');
    return deps.alerts.acknowledge(id, actorOf(session));
  });

  /**
   * 徽标用摘要（含 `suppressed` 与 `evaluatedAt`）。
   *
   * 这两个字段优先取引擎的真实值（见 `composeAlertSummary`）；其余计数在服务层
   * 按**当前可见性**统计（`open` / `unacknowledged` / `bySeverity` / `top` 一致过滤）。
   */
  app.get('/summary', async (request) => {
    requireAuth(request);
    return composeAlertSummary(deps.alerts.summary(await loadAlertsVisibility(ctx)), deps.engine);
  });
}