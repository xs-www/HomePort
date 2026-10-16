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
 * **这条 `不分角色` 只管事件/快照类读路径**（`/events`、`/summary`、`/api/metrics/*`）：
 * 它们返回的是"触发时落库的快照"，对谁都只能给当前可见的那几条。
 * `/rules` 是**配置**类接口（admin 写的、admin 可 PATCH），它**区分角色**：viewer 的服务类
 * `target` 遮蔽成 `null`，admin 保留真值（理由见 `/rules` handler 的注释）。配置与快照是
 * 两类东西，口径不同是有意的 —— 不要拿这一处的角色分支去推翻那三处的 `不分角色`。
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
import { sumSuppressedVisible } from '../modules/alerts/service.js';
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
 * 告警域的"状态透出"入口（引擎的最小依赖面）。
 *
 * `evaluatedAt` 与 `suppressed` 的真相在引擎里（只有它每轮 tick 才知道压掉了几次、
 * 上次评估在什么时候）。这里要的是**按 target 的明细**而不是一个总数：
 * 总数没法按可见性过滤，隐藏服务的贡献会混进 viewer 看到的数字（见 `sumSuppressedVisible`）。
 */
export interface AlertSummaryEngine {
  lastTickAt(): string | null;
  suppressedByTarget(): ReadonlyMap<string, number>;
}

/**
 * 告警域的路由依赖（**由本模块定义形状**，装配方只负责把对象传进来）。
 *
 * `engine` / `scheduler` 是可选的"状态透出"入口；没有引擎时 `suppressed` /
 * `evaluatedAt` 退化为 `AlertsService` 自己记录的值（装配期没人调 `recordTick` 时就是 0/null），
 * 那一份同样是按 target 记账并按可见性求和的，不会因为"没接引擎"就漏。
 */
export interface AlertRouteDeps {
  alerts: AlertsService;
  engine?: AlertSummaryEngine | null;
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
 *
 * `suppressed` **必须按当前可见性求和**（`sumSuppressedVisible`）：它是一个 viewer
 * 看得到的数字，"隐藏服务的贡献留在里面"等于用数字承认"有个你看不见的东西在反复失败"。
 * 因此这里收的是引擎的**按 target 明细**，而不是一个总数 —— 总数无法归因，也就无法过滤。
 *
 * @param visible 当前可见服务集合（`null` = 读失败 → fail-closed，只计宿主自有目标）
 */
export function composeAlertSummary(
  summary: AlertSummaryView,
  engine: AlertSummaryEngine | null | undefined,
  visible: AlertEventVisibility,
): AlertSummaryView {
  if (!engine) return summary;
  return {
    ...summary,
    suppressed: sumSuppressedVisible(engine.suppressedByTarget(), visible),
    evaluatedAt: engine.lastTickAt() ?? summary.evaluatedAt,
  };
}

export function registerAlertRoutes(app: FastifyInstance, ctx: AlertRoutesContext, deps: AlertRouteDeps): void {
  // 兜底守卫（见文件头注释）。与 api/index.ts 的统一守卫叠加时是幂等的。
  app.addHook('onRequest', createRequireRoleHook('viewer'));
  app.addHook('onRequest', createCsrfHook());

  /**
   * 规则列表：四条内置 + 当前配置（未启用也返回，`enabled` 字段说明状态）。
   *
   * **服务类 `target` 只对 viewer 遮蔽**（`AlertsService.rules(visible, { maskServiceTargets })`
   * → `maskRuleTarget`）：`rule.target` 里写的是服务的稳定身份（`service:<ref>` /
   * `container:<ref>`），只按库里的行返回，viewer 就能靠规则列表把被隐藏或已删除的服务
   * **枚举**出来 —— 与事件快照是同一个泄漏面，只是载体从事件行换成了规则配置行。
   *
   * **为什么 admin 保留真值（本仓唯一区分角色的读路径）**：规则是 admin 自己写的**配置**
   * （`PATCH /rules/:id` 的入参），对**作者本人**遮蔽保护不了任何东西，只会让界面说假话
   * —— `web/src/components/AlertRuleForm.tsx` 把空 target 渲染成"· 适用于全部目标"，
   * 隐藏服务的定向规则会对 admin 显示成"适用全部目标"。本端点本身就是 admin 可 PATCH /
   * viewer 只读，角色分支与端点自身语义一致，因此**不需要改 web/**。
   * （`/events`、`/summary`、`/api/metrics/*` 的 `不分角色` 是**事件/快照**口径，见文件头；
   * 规则是配置，不适用 —— 两者不要互相套用。）
   *
   * 遮蔽成 `null`（契约里既有的"未限定目标"取值），**不引入第三种状态**：
   * `service:<hidden>` 之类等于直接承认"这里有一个你看不到的目标存在"。
   * 宿主类 target（`disk:<标签>` / `host`）与 null 在两种角色下都原样返回；
   * 响应形状（13 个字段）不变。读时求值，viewer 侧注册表读失败 fail-closed。
   */
  app.get('/rules', async (request) => {
    const session = requireAuth(request);
    // 只有 viewer 的读需要可见集合：admin 那条路径**根本不读** `visible`（见 `rules()`），
    // 所以这里也不去查注册表 —— 免得 admin 的请求白付一次 `registry.list`，
    // 还因为注册表偶发不可用而记一条与他无关的 warn。
    const maskServiceTargets = session.user.role !== 'admin';
    const visible = maskServiceTargets ? await loadAlertsVisibility(ctx) : null;
    const response: AlertRuleListResponse = { items: deps.alerts.rules(visible, { maskServiceTargets }) };
    return response;
  });

  /**
   * 部分更新规则（admin）。非法阈值 → 400，未知规则 → 404。
   *
   * 响应里的 `target` **不遮蔽**：这是写路径，回显的是调用方自己提交/保存的配置
   * （把"你刚写的 target"变成 null 只会让人以为没保存上），且要求 admin + CSRF，
   * 而 admin 经管理接口（`includeHidden`）本来就能看到隐藏服务。
   */
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
   * 这两个字段优先取引擎的真实值（见 `composeAlertSummary`），并**按当前可见性求和**；
   * 其余计数在服务层同样按**当前可见性**统计
   * （`open` / `unacknowledged` / `bySeverity` / `top` / `suppressed` 一致过滤）。
   */
  app.get('/summary', async (request) => {
    requireAuth(request);
    const visible = await loadAlertsVisibility(ctx);
    return composeAlertSummary(deps.alerts.summary(visible), deps.engine, visible);
  });
}