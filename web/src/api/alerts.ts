/**
 * 告警（Sprint 2 · S2-04）的前端契约镜像。
 *
 * 与 `api/metrics.ts` 同样的纪律：手写镜像、不 import 后端代码、字段名逐字对应。
 *
 * **不要写"宽容解析"**（§7 补冻结时的明确要求）：契约冻结之后，
 * `ruleListFrom()` 之类的归一化会把"服务端少包一层 `items`"变成"页面看起来正常
 * 但规则一条都不显示"—— 把契约违约伪装成静默兼容，比直接炸掉更难排查。
 * 因此这里的类型与 §7 一致，取值就直接取字段。
 */
import { formatPercent } from '../lib/format.js';

/** §1/§5.1 的四种规则类型（改名等于改契约）。 */
export type AlertKind = 'disk_percent' | 'memory_percent' | 'container_exit' | 'service_health';

export type AlertSeverity = 'warning' | 'critical';

/** 事件的展示状态（`resolved_at` 是否有值）。 */
export type AlertEventState = 'open' | 'resolved';

/** `/api/alerts/events?state=` 的取值。 */
export type AlertEventQueryState = 'all' | 'open' | 'resolved';

/** 事件取值单位（§5.2 的 value/unit 列）。 */
export type AlertEventUnit = 'percent' | 'exit_code' | 'count';

/** 规则视图（§7 补冻结的字段清单，与 `alert_rules` 表一一对应，不含内部列）。 */
export interface AlertRuleView {
  id: string;
  kind: AlertKind;
  name: string;
  description: string;
  /** 内置规则默认 `false`（装了但不吵） */
  enabled: boolean;
  /** 百分比阈值 / 连续失败次数；`container_exit` 固定 0 */
  threshold: number | null;
  /** 需持续多久（秒） */
  durationSec: number;
  /** `null` = 适用于全部目标 */
  target: string | null;
  /** 静默期（秒） */
  silenceSec: number;
  notifyRecovery: boolean;
  severity: AlertSeverity;
  /** 内置规则不可删除 */
  builtin: boolean;
  updatedAt: string;
}

/** `GET /api/alerts/rules` 的 200 响应（列表端点统一 `{ items }`）。 */
export interface AlertRuleListResponse {
  items: AlertRuleView[];
}

/** `PATCH /api/alerts/rules/:id` 的部分更新体（§7 的六个可写键）。 */
export interface AlertRulePatch {
  enabled?: boolean;
  threshold?: number;
  durationSec?: number;
  silenceSec?: number;
  notifyRecovery?: boolean;
  target?: string | null;
}

/** 事件视图（§7 的示例逐字段）。 */
export interface AlertEventView {
  id: string;
  ruleId: string;
  kind: AlertKind;
  ruleName: string;
  /** 稳定目标（`disk:C:` / `service:<sourceRef>` …） */
  target: string;
  targetLabel: string;
  severity: AlertSeverity;
  state: AlertEventState;
  value: number | null;
  threshold: number | null;
  unit: AlertEventUnit | null;
  message: string;
  startedAt: string;
  firedAt: string;
  /** `null` = 仍在告警 */
  resolvedAt: string | null;
  /** 静默期内重开同一 episode 的次数（> 0 表示"同一故障又犯了"） */
  reopenCount: number;
  acknowledgedAt: string | null;
  acknowledgedBy: string | null;
}

export interface AlertEventCounts {
  open: number;
  resolved: number;
  unacknowledged: number;
}

/** `GET /api/alerts/events` 的 200 响应（§7 冻结）。 */
export interface AlertEventsResponse {
  items: AlertEventView[];
  total: number;
  counts: AlertEventCounts;
}

/** `summary.top` 里的条目是**轻量投影**，不是完整的 `AlertEventView`（§7 冻结）。 */
export interface AlertSummaryTopItem {
  id: string;
  ruleName: string;
  targetLabel: string;
  severity: AlertSeverity;
  firedAt: string;
}

/**
 * `GET /api/alerts/summary` 的 200 响应（**聚合对象本身，不是列表**）。
 *
 * - `open` = 未恢复事件数；
 * - `unacknowledged` = 未恢复且未确认数（导航徽标用的就是它）；
 * - `suppressed` = 命中静默期被压掉的触发次数（"没有告警"到底是被压了
 *   还是条件没成立，靠它区分）。
 */
export interface AlertSummaryView {
  open: number;
  unacknowledged: number;
  suppressed: number;
  bySeverity: { warning: number; critical: number };
  top: AlertSummaryTopItem[];
  evaluatedAt: string | null;
}

/** 空计数（请求失败/未启用时的界面默认值，**不是**解析兜底）。 */
export const EMPTY_ALERT_COUNTS: AlertEventCounts = { open: 0, resolved: 0, unacknowledged: 0 };

// ---------------------------------------------------------------- 展示

/** 规则类型 → 中文（未知值原样透出，便于排障）。 */
export function describeAlertKind(kind: string): string {
  switch (kind) {
    case 'disk_percent':
      return '磁盘使用率';
    case 'memory_percent':
      return '内存使用率';
    case 'container_exit':
      return '容器异常退出';
    case 'service_health':
      return '服务连续探测失败';
    default:
      return kind;
  }
}

/** 严重度 → 中文 + 语义色（与 `ui.tsx` 的 Tone 对齐）。 */
export function describeSeverity(severity: string): { label: string; tone: 'warn' | 'bad' } {
  return severity === 'critical' ? { label: '严重', tone: 'bad' } : { label: '警告', tone: 'warn' };
}

/**
 * 事件取值按 `unit` 显示。
 *
 * 与指标图表同一条纪律：**按单位分支，绝不换算**。
 * `percent` 的 91.2 就是 91.2%，不会被当成 91.2 字节。
 */
export function formatAlertValue(value: number | null | undefined, unit: AlertEventUnit | null): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'percent':
      return formatPercent(value);
    case 'exit_code':
      return `退出码 ${value.toFixed(0)}`;
    case 'count':
      return `${value.toFixed(0)} 次`;
    default:
      // 单位缺失时只显示数字本身，绝不猜单位（猜错就是错的运维结论）
      return value.toFixed(1);
  }
}

/** `3 分钟` / `2 小时` 这类"持续多久"的粗粒度文案（告警阈值的人话补充）。 */
export function describeDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? seconds : 0;
  if (total <= 0) return '立即触发';
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.round(total / 60)} 分钟`;
  if (total < 86400) return `${Math.round(total / 3600)} 小时`;
  return `${Math.round(total / 86400)} 天`;
}

/** 规则阈值按 kind 说人话（`container_exit` 的 0 不是"0%"）。 */
export function ruleThresholdText(rule: AlertRuleView): string {
  switch (rule.kind) {
    case 'disk_percent':
    case 'memory_percent':
      return rule.threshold === null ? '未设置' : `${rule.threshold}%`;
    case 'service_health':
      return rule.threshold === null ? '未设置' : `连续 ${rule.threshold} 次`;
    case 'container_exit':
      // 阈值固定 0 的语义是"非 0 退出码即触发"，写成 "0%" 会完全误导
      return '固定 0（非 0 退出码即触发）';
  }
}