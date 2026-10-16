/**
 * 告警（S2-04）的**契约类型** + 纯映射函数。
 *
 * 与 `04-api-contract.md` / `web/src/api/types.ts` 一样，这里是"进库、进 URL、进前端"的
 * 稳定形状：`AlertRuleView` / `AlertEventView` 的字段名改动等于改契约。
 *
 * 两套命名刻意分开，不要混：
 * - `AlertRuleDbRow` / `AlertEventDbRow`：**数据库行**（snake_case，与迁移 v5 的列名一一对应）；
 * - `AlertRuleRow` / `AlertEventRow`：**领域行**（camelCase，供纯逻辑与业务层使用）。
 * 混用会导致"列名改了一个字却没人发现"，所以映射集中在 `toAlertRuleRow` / `toAlertEventRow`。
 *
 * 时间戳一律 ISO 字符串（与既有 `audit_log` / `services` 表一致）；
 * 只有 `bucket_at` 用 unix 秒（那是指标线的事）。`snapshot.at` 用毫秒时间戳
 * （与 `clock` 同单位，见 `toEpochMs`）。
 */

/* ------------------------------------------------------------------ *
 * 规则
 * ------------------------------------------------------------------ */

export type AlertKind = 'disk_percent' | 'memory_percent' | 'container_exit' | 'service_health';

export type AlertSeverity = 'warning' | 'critical';

/** 数据库行（迁移 v5 的 `alert_rules`）。 */
export interface AlertRuleDbRow {
  id: string;
  kind: string;
  name: string;
  description: string;
  enabled: number;
  threshold: number | null;
  duration_sec: number;
  target: string | null;
  silence_sec: number;
  notify_recovery: number;
  severity: string;
  builtin: number;
  updated_at: string;
  created_at: string;
}

/** 领域行（纯逻辑用）。 */
export interface AlertRuleRow {
  id: string;
  kind: AlertKind;
  name: string;
  description: string;
  enabled: number;
  threshold: number | null;
  durationSec: number;
  target: string | null;
  silenceSec: number;
  notifyRecovery: number;
  severity: AlertSeverity;
  builtin: number;
  updatedAt: string;
  createdAt: string;
}

/** 内置规则的定义（与 §2.3 的四条逐字对应）。 */
export type BuiltinAlertRule = AlertRuleRow;

/** `PATCH /api/alerts/rules/:id` 的部分更新（只允许这六个字段）。 */
export interface AlertRulePatch {
  enabled?: boolean;
  threshold?: number | null;
  durationSec?: number;
  silenceSec?: number;
  notifyRecovery?: boolean;
  target?: string | null;
}

/** HTTP 契约：规则视图（§7 冻结形状，逐字段对应，不含 `createdAt` 这类内部列）。 */
export interface AlertRuleView {
  id: string;
  kind: AlertKind;
  name: string;
  description: string;
  enabled: boolean;
  threshold: number | null;
  durationSec: number;
  target: string | null;
  silenceSec: number;
  notifyRecovery: boolean;
  severity: AlertSeverity;
  builtin: boolean;
  updatedAt: string;
}

/* ------------------------------------------------------------------ *
 * 事件（episode 模型）
 * ------------------------------------------------------------------ */

export type AlertEventState = 'open' | 'resolved';

/** 数据库行（迁移 v5 的 `alert_events`）。 */
export interface AlertEventDbRow {
  id: string;
  rule_id: string;
  kind: string;
  rule_name: string;
  target: string;
  target_label: string;
  severity: string;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  message: string;
  started_at: string;
  fired_at: string;
  resolved_at: string | null;
  reopen_count: number;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  created_at: string;
}

/** HTTP 契约：事件视图（`GET /api/alerts/events` 的 items 元素）。 */
export interface AlertEventView {
  id: string;
  ruleId: string;
  kind: AlertKind;
  ruleName: string;
  target: string;
  targetLabel: string;
  severity: AlertSeverity;
  state: AlertEventState;
  value: number | null;
  threshold: number | null;
  unit: string | null;
  message: string;
  startedAt: string;
  firedAt: string;
  resolvedAt: string | null;
  reopenCount: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface AlertEventCounts {
  open: number;
  resolved: number;
  unacknowledged: number;
}

/** `GET /api/alerts/rules` 的响应体（无信封；**裸数组由路由层包成 `{ items }`**）。 */
export interface AlertRuleListResponse {
  items: AlertRuleView[];
}

export interface AlertEventListResponse {
  items: AlertEventView[];
  total: number;
  counts: AlertEventCounts;
}

/** `summary().top` 的条目（**精简形状**：徽标与"需要关注"列表只需要这五个字段）。 */
export interface AlertSummaryTopItem {
  id: string;
  ruleName: string;
  targetLabel: string;
  severity: AlertSeverity;
  firedAt: string;
}

export interface AlertSummaryView {
  open: number;
  unacknowledged: number;
  /**
   * 因"同一 (rule,target) 仍在告警"而未产生新通知的触发次数（自进程启动累计）。
   *
   * 存在的唯一理由：让"没有告警"这件事可解释 —— 是被静默压掉了，还是条件根本没成立。
   */
  suppressed: number;
  bySeverity: { warning: number; critical: number };
  /** 按 severity 与 fired_at 排序的前 5 条**未恢复**事件。 */
  top: AlertSummaryTopItem[];
  /** 上次告警引擎 tick 的时间（没有 tick 过则为 null）。 */
  evaluatedAt: string | null;
}

/* ------------------------------------------------------------------ *
 * 引擎
 * ------------------------------------------------------------------ */

export type HealthVerdictLike = 'healthy' | 'degraded' | 'down' | 'unknown';

export interface AlertSnapshot {
  at: number;
  host: {
    cpuPercent: number | null;
    memoryPercent: number | null;
    disks: Array<{ label: string; percent: number | null }>;
  };
  containers: Array<{
    sourceRef: string;
    label: string;
    containerId: string;
    state: string;
    /**
     * 容器退出码。
     *
     * 真实快照里由 `ContainerSummary.exitCode` 提供（`docker/mapper.ts` 映射
     * `inspect.State.ExitCode`）；**`null` = 未知**、`0` = 正常退出，两者都不触发
     * `container_exit` 但语义不同，不许互相伪装。
     * 自己构造快照时可以留 null —— 按规格，`exited` + 未知退出码**不触发**，
     * 宁可漏报也不能把"正常停止"报成异常退出。
     */
    exitCode: number | null;
    startedAt: string | null;
  }>;
  services: Array<{
    sourceRef: string;
    serviceId: string;
    label: string;
    verdict: HealthVerdictLike;
    consecutiveFailures: number;
  }>;
}

export interface AlertTickResult {
  at: string;
  /** 条件评估次数（rule × target）。 */
  evaluated: number;
  /** 新建事件数（**只有新建算"再次通知"**）。 */
  opened: number;
  /** 静默期内重开同一行的次数。 */
  reopened: number;
  resolved: number;
  /** 因"同一 (rule,target) 已有未恢复 episode"而未产生新通知的触发次数。 */
  suppressed: number;
}

/* ------------------------------------------------------------------ *
 * 纯映射（无副作用）
 * ------------------------------------------------------------------ */

const ALERT_KIND_SET: ReadonlySet<string> = new Set(['disk_percent', 'memory_percent', 'container_exit', 'service_health']);

/**
 * 未知 kind 收敛为 `disk_percent`。
 *
 * 注意：迁移 v5 **没有**给 `alert_rules.kind` / `severity` 加 CHECK 约束
 * （只有 v1 的 `users.role` 有），所以这里是**唯一**的收敛点 ——
 * 它不是"防手写测试数据"的兜底，从库里读出来的脏值同样靠它。
 */
function normalizeKind(value: string): AlertKind {
  return ALERT_KIND_SET.has(value) ? (value as AlertKind) : 'disk_percent';
}

function normalizeSeverity(value: string): AlertSeverity {
  return value === 'critical' ? 'critical' : 'warning';
}

export function toAlertRuleRow(row: AlertRuleDbRow): AlertRuleRow {
  return {
    id: row.id,
    kind: normalizeKind(row.kind),
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    threshold: row.threshold,
    durationSec: row.duration_sec,
    target: row.target,
    silenceSec: row.silence_sec,
    notifyRecovery: row.notify_recovery,
    severity: normalizeSeverity(row.severity),
    builtin: row.builtin,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  };
}

export function toAlertRuleView(row: AlertRuleRow): AlertRuleView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    description: row.description,
    enabled: row.enabled === 1,
    threshold: row.threshold,
    durationSec: row.durationSec,
    target: row.target,
    silenceSec: row.silenceSec,
    notifyRecovery: row.notifyRecovery === 1,
    severity: row.severity,
    builtin: row.builtin === 1,
    updatedAt: row.updatedAt,
  };
}

export function alertEventState(row: Pick<AlertEventDbRow, 'resolved_at'>): AlertEventState {
  return row.resolved_at === null ? 'open' : 'resolved';
}

export function toAlertEventView(row: AlertEventDbRow): AlertEventView {
  return {
    id: row.id,
    ruleId: row.rule_id,
    kind: normalizeKind(row.kind),
    ruleName: row.rule_name,
    target: row.target,
    targetLabel: row.target_label,
    severity: normalizeSeverity(row.severity),
    state: alertEventState(row),
    value: row.value,
    threshold: row.threshold,
    unit: row.unit,
    message: row.message,
    startedAt: row.started_at,
    firedAt: row.fired_at,
    resolvedAt: row.resolved_at,
    reopenCount: row.reopen_count,
    acknowledgedAt: row.acknowledged_at,
    acknowledgedBy: row.acknowledged_by,
  };
}