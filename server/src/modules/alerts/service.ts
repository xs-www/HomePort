/**
 * 告警业务出口（S2-04 §5.3）—— 规则的读/改、事件的读/确认、徽标计数。
 *
 * 这里**只做业务出口**，不做评估：触发与恢复全在 `engine.ts`（它有 episode/静默语义），
 * 本文件负责"人能看到什么、人能改什么"，以及所有写操作的审计。
 *
 * 为什么 `rules()` 不顺手补齐内置规则：播种是**装配期的显式动作**
 * （`ensureBuiltinRules()`，由 `app.ts` 调一次）。如果 GET 也播种，"迁移后新表为空"
 * 与"接口一被调用表就有四条"就会互相打脸，彩排脚本也就无法验证迁移本身是干净的。
 *
 * ## 读路径的当前可见性（S2 修复：隐藏/已删除的服务不得经告警事件泄漏）
 *
 * 事件行的 `target` / `target_label` / `message` 都是**触发那一刻**的落库快照，
 * 不会因为服务后来被隐藏或删除而变化。因此 `events()` 与 `summary()` 必须带上
 * **当前**可见性输入（由路由层用共享的 `modules/visibility/serviceVisibility.ts` 读出）
 * 再过滤一遍：target 里承载的就是服务稳定身份（`service:<sourceRef>` /
 * `container:<sourceRef>`），命中不了就整条不可见。
 *
 * 过滤放在 **SQL 层**（不是取出来再筛）：
 * - `limit` 必须作用在可见集合上，否则首页会被不可见事件占位，
 *   出现"看得见的事件反而翻不到"；
 * - `total` / `counts` / `bySeverity` / `top` 都只在可见集合内统计 ——
 *   **计数本身就是存在性证据**（"未恢复从 3 掉到 2"会告诉 viewer 少了一条什么）。
 *
 * ## 与引擎语义的组合（有意为之，不要"顺手修"）
 *
 * 隐藏一个服务**不会**动它的未恢复事件行：`resolved_at` 仍为 NULL、episode 不变量
 * 与静默期判定完全不变。结果是"viewer 看不见的事件在库里仍是未恢复状态" ——
 * 这是刻意的组合语义：告警引擎的事实（服务确实在故障）与读侧的暴露面（谁允许看到）
 * 是两件事。恢复可见后事件原样回来（行没被删、状态没被改）。反过来，
 * 只要引擎还认为目标在故障中，就不会因为"读侧看不见"而假恢复 —— 那会把
 * 真实的故障从运维视野里抹掉。
 */
import type { Db } from '../../db/database.js';
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import type { AuditRepository } from '../../db/users.js';
import { badRequest, notFound } from '../../http/errors.js';
import { CONTAINER_TARGET_PREFIX, SERVICE_TARGET_PREFIX } from '../visibility/serviceVisibility.js';
import { mergeBuiltinRules, compareAlertRules, validateRulePatch } from './rules.js';
import {
  toAlertEventView,
  toAlertRuleRow,
  toAlertRuleView,
  type AlertEventCounts,
  type AlertEventDbRow,
  type AlertEventListResponse,
  type AlertEventView,
  type AlertRuleDbRow,
  type AlertRulePatch,
  type AlertRuleRow,
  type AlertRuleView,
  type AlertSummaryView,
} from './types.js';

/** 事件列表默认条数（§7：默认 50，1..200）。 */
export const ALERT_EVENTS_DEFAULT_LIMIT = 50;
export const ALERT_EVENTS_MAX_LIMIT = 200;
/** `summary().top` 的条数。 */
export const ALERT_SUMMARY_TOP_LIMIT = 5;

export interface AlertsServiceDeps {
  db: Db;
  audit: AuditRepository;
  logger?: Logger;
  clock?: () => number;
  /**
   * 装配方习惯顺手把 `config` 一起传进来。本服务**不使用**它（阈值/静默期是每行规则自己的事，
   * 没有全局配置项），保留这个可选字段只是为了让装配代码与其它模块保持一致的形状 ——
   * 业务层依赖 config 具体字段会与并行改动耦合，这是刻意的解耦。
   */
  config?: PortalConfig;
}

export interface AlertEventQuery {
  state?: 'all' | 'open' | 'resolved';
  limit?: number;
}

/**
 * 读路径的可见性输入：**当前**可见服务的 `sourceRef` 集合。
 *
 * `null` = 可见性来源不可用（注册表读失败 / 装配缺依赖），语义是 **fail-closed**：
 * 服务与容器类事件一律不可见，宿主类（磁盘/内存）事件照常。类型上没有
 * "省略 = 不过滤"这个选项 —— 调用方必须显式表态，免得哪天多一个调用点就悄悄漏了。
 */
export type AlertEventVisibility = ReadonlySet<string> | null;

/**
 * 宿主自有事件的判据：target 不属于任何服务（`host` / `disk:<标签>`）。
 *
 * 用 target 前缀而不是 kind 做判据：**泄漏面由 target 决定**（名字就在 target/target_label 里），
 * 而 kind 只是"哪条规则触发的"。前缀写法上再叠一次 kind 校验（见下），
 * 于是"kind 说是磁盘、target 却指向服务"的手工脏行也落不进可见集合。
 */
const HOST_OWNED_EVENT_SQL = "(target NOT LIKE 'service:%' AND target NOT LIKE 'container:%')";

/**
 * 事件的可见性 SQL 片段（`AND` 用的条件，不是完整 WHERE）+ 位置参数。
 *
 * 纯函数，便于直接对边界写断言（`null` / 空集合 / 有集合三种输入）。
 */
export function alertEventVisibilityWhere(visible: AlertEventVisibility): { sql: string; params: string[] } {
  // fail-closed：读不到可见性时，只有宿主自有事件留下
  if (visible === null) return { sql: HOST_OWNED_EVENT_SQL, params: [] };

  const refs = [...visible];
  if (refs.length === 0) return { sql: HOST_OWNED_EVENT_SQL, params: [] };

  const marks = refs.map(() => '?').join(', ');
  const services = refs.map((ref) => `${SERVICE_TARGET_PREFIX}${ref}`);
  const containers = refs.map((ref) => `${CONTAINER_TARGET_PREFIX}${ref}`);
  return {
    sql:
      `(${HOST_OWNED_EVENT_SQL}` +
      ` OR (kind = 'service_health' AND target IN (${marks}))` +
      ` OR (kind = 'container_exit' AND target IN (${marks})))`,
    // 参数顺序必须与 SQL 文本里占位符出现的顺序一致：先 service 分支，再 container 分支
    params: [...services, ...containers],
  };
}

const RULE_COLUMNS = 'SELECT * FROM alert_rules';
const EVENT_COLUMNS = 'SELECT * FROM alert_events';

export class AlertsService {
  private readonly deps: AlertsServiceDeps;
  private readonly log: Logger | null;
  private readonly clock: () => number;
  /** 上次告警 tick 时间：由装配处通过 `recordTick` / `recordEvaluatedAt` 写入。 */
  private evaluatedAt: string | null = null;
  /** 自进程启动以来被"已有未恢复行"压掉的触发次数（`summary().suppressed`）。 */
  private suppressedTotal = 0;

  constructor(deps: AlertsServiceDeps) {
    this.deps = deps;
    this.log = deps.logger?.child({ mod: 'alerts' }) ?? null;
    this.clock = deps.clock ?? (() => Date.now());
  }

  /**
   * 幂等补齐四条内置规则，返回**本次插入**的条数。
   *
   * 装配时调一次（`app.ts`）。第二次调用必然返回 0；已存在的行（含管理员改过的阈值）
   * 一个字都不动 —— "补齐"绝不等于"重刷默认值"。
   */
  ensureBuiltinRules(at?: string): number {
    const now = at ?? new Date(this.clock()).toISOString();
    const existing = this.listRuleRows();
    const merged = mergeBuiltinRules(existing, now);
    const existingIds = new Set(existing.map((row) => row.id));
    const missing = merged.filter((row) => !existingIds.has(row.id));
    if (missing.length === 0) return 0;

    const insert = this.deps.db.prepare(
      `INSERT INTO alert_rules (
         id, kind, name, description, enabled, threshold, duration_sec, target,
         silence_sec, notify_recovery, severity, builtin, updated_at, created_at
       ) VALUES (
         @id, @kind, @name, @description, @enabled, @threshold, @durationSec, @target,
         @silenceSec, @notifyRecovery, @severity, @builtin, @updatedAt, @createdAt
       )`,
    );
    const write = this.deps.db.transaction((rows: readonly AlertRuleRow[]) => {
      for (const row of rows) {
        insert.run({
          id: row.id,
          kind: row.kind,
          name: row.name,
          description: row.description,
          enabled: row.enabled,
          threshold: row.threshold,
          durationSec: row.durationSec,
          target: row.target,
          silenceSec: row.silenceSec,
          notifyRecovery: row.notifyRecovery,
          severity: row.severity,
          builtin: row.builtin,
          updatedAt: row.updatedAt,
          createdAt: row.createdAt,
        });
      }
    });
    write(missing);
    return missing.length;
  }

  /** 全部规则（内置在前，按 kind 顺序）。未调用 `ensureBuiltinRules()` 时可以是空数组。 */
  rules(): AlertRuleView[] {
    return this.listRuleRows()
      .sort(compareAlertRules)
      .map(toAlertRuleView);
  }

  /**
   * 部分更新一条规则。
   *
   * 校验在**落库之前**完成：非法值直接 `VALIDATION_FAILED`，什么都不写
   * （不静默截断 —— 被悄悄改小的阈值比报错危险得多）。
   */
  updateRule(id: string, patch: AlertRulePatch, actor: string): AlertRuleView {
    const row = this.ruleById(id);
    if (!row) throw notFound(`告警规则 ${id} 不存在`);

    const validation = validateRulePatch(row.kind, patch);
    if (!validation.ok) {
      throw badRequest(`告警规则参数不可用：${validation.reason}`, { fieldErrors: { patch: [validation.reason] } });
    }
    const value = validation.value;

    const assignments: string[] = [];
    const params: Record<string, unknown> = { id, updatedAt: new Date(this.clock()).toISOString() };
    if (value.enabled !== undefined) {
      assignments.push('enabled = @enabled');
      params.enabled = value.enabled ? 1 : 0;
    }
    if (value.threshold !== undefined) {
      assignments.push('threshold = @threshold');
      params.threshold = value.threshold;
    }
    if (value.durationSec !== undefined) {
      assignments.push('duration_sec = @durationSec');
      params.durationSec = value.durationSec;
    }
    if (value.silenceSec !== undefined) {
      assignments.push('silence_sec = @silenceSec');
      params.silenceSec = value.silenceSec;
    }
    if (value.notifyRecovery !== undefined) {
      assignments.push('notify_recovery = @notifyRecovery');
      params.notifyRecovery = value.notifyRecovery ? 1 : 0;
    }
    if (value.target !== undefined) {
      assignments.push('target = @target');
      params.target = value.target;
    }
    // 空 patch 是合法请求（zod 层已拒绝），这里再兜一次：至少要有 updated_at 变化。
    assignments.push('updated_at = @updatedAt');

    this.deps.db.prepare(`UPDATE alert_rules SET ${assignments.join(', ')} WHERE id = @id`).run(params);

    const updated = this.ruleById(id);
    if (!updated) throw notFound(`告警规则 ${id} 不存在`);
    this.audit(actor, 'alert.rule_updated', `alert_rule:${id}`, {
      ruleId: id,
      kind: updated.kind,
      // 审计只放非敏感字段（§2.5）：改了哪些字段 + 关键数值，不放任何凭据。
      fields: Object.keys(value),
      enabled: updated.enabled === 1,
      threshold: updated.threshold,
      durationSec: updated.durationSec,
      silenceSec: updated.silenceSec,
      notifyRecovery: updated.notifyRecovery === 1,
      target: updated.target,
    });
    return toAlertRuleView(updated);
  }

  /**
   * 事件列表（默认最近 50 条，按触发时间倒序）。
   *
   * `counts` 是**全量**计数（不随 `state` 过滤变化）：徽标要的是"现在有多少未确认"，
   * 不是"这一页里有多少未确认"。
   *
   * @param query    状态与条数过滤
   * @param visible  **当前**可见服务集合（`null` = read 失败 → fail-closed）：
   *                 `items` / `total` / `counts` 三者都只在可见集合内统计，
   *                 且 `limit` 作用在过滤**之后**（见 `eventWhere`）。
   */
  events(query: AlertEventQuery, visible: AlertEventVisibility): AlertEventListResponse {
    const limit = normalizeLimit(query.limit);
    const state = query.state ?? 'all';
    const where = this.eventWhere(state, visible);
    const rows = this.deps.db
      .prepare(`${EVENT_COLUMNS} ${where.sql} ORDER BY fired_at DESC, created_at DESC LIMIT ?`)
      .all(...where.params, limit) as AlertEventDbRow[];
    const total = Number(
      (this.deps.db.prepare(`SELECT COUNT(*) AS n FROM alert_events ${where.sql}`).get(...where.params) as { n: number }).n,
    );
    return { items: rows.map(toAlertEventView), total, counts: this.counts(visible) };
  }

  /**
   * 确认一条事件（已恢复的也能确认 —— "我看到了这条历史"是合法需求）。
   *
   * 幂等：重复确认不改时间、不再写审计。事先的"确认"没有新的信息量，
   * 若每次都刷新 `acknowledged_at`，"谁在什么时候先看到的"这个信息就丢了。
   *
   * **本方法不做可见性过滤**（与本次收口的读路径不同）：它是 admin 的写操作，
   * 入参是调用方手上的事件 ID；要拿到隐藏服务事件的 ID，得先有别的泄漏渠道
   * （事件 ID 是随机 UUID，读列表里已经不出现）。刻意不动它，免得改掉
   * "确认" 这条写路径的 404/幂等语义 —— 本轮的收口范围就是**读**响应。
   */
  acknowledge(id: string, actor: string): AlertEventView {
    const row = this.eventById(id);
    if (!row) throw notFound(`告警事件 ${id} 不存在`);
    if (row.acknowledged_at !== null) return toAlertEventView(row);

    const at = new Date(this.clock()).toISOString();
    this.deps.db.prepare('UPDATE alert_events SET acknowledged_at = @at, acknowledged_by = @by WHERE id = @id').run({
      id,
      at,
      by: actor,
    });
    this.audit(actor, 'alert.acknowledged', `alert_event:${id}`, {
      eventId: id,
      ruleId: row.rule_id,
      kind: row.kind,
      target: row.target,
      severity: row.severity,
    });
    const updated = this.eventById(id);
    if (!updated) throw notFound(`告警事件 ${id} 不存在`);
    return toAlertEventView(updated);
  }

  /**
   * 徽标用摘要（§7 的冻结形状）。
   *
   * `top` 只取**未恢复**事件，且是精简形状：已经解决的事件不该在"需要关注"里占位，
   * 徽标也不需要每条事件的完整消息（那会让每次轮询都多传几 KB）。
   * 排序：severity（critical 优先）→ fired_at 倒序。
   *
   * 四个计数（`open` / `unacknowledged` / `bySeverity` / `top`）**全部**按当前可见性过滤：
   * 只过滤 `top` 而留着计数，等于用数字告诉 viewer "有一条你看不见的未恢复告警"。
   *
   * @param visible 当前可见服务集合（`null` = 读失败 → fail-closed）
   */
  summary(visible: AlertEventVisibility): AlertSummaryView {
    const counts = this.counts(visible);
    const bySeverityWhere = this.eventWhere('all', visible);
    const bySeverity = this.deps.db
      .prepare(
        `SELECT
           SUM(CASE WHEN resolved_at IS NULL AND severity = 'critical' THEN 1 ELSE 0 END) AS critical,
           SUM(CASE WHEN resolved_at IS NULL AND severity <> 'critical' THEN 1 ELSE 0 END) AS warning
         FROM alert_events ${bySeverityWhere.sql}`,
      )
      .get(...bySeverityWhere.params) as { critical: number | null; warning: number | null };
    const topWhere = this.eventWhere('open', visible);
    const top = this.deps.db
      .prepare(
        `SELECT id, rule_name, target_label, severity, fired_at
         FROM alert_events ${topWhere.sql}
         ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, fired_at DESC
         LIMIT ?`,
      )
      .all(...topWhere.params, ALERT_SUMMARY_TOP_LIMIT) as Array<{
      id: string;
      rule_name: string;
      target_label: string;
      severity: string;
      fired_at: string;
    }>;

    return {
      open: counts.open,
      unacknowledged: counts.unacknowledged,
      suppressed: this.suppressedTotal,
      bySeverity: { warning: Number(bySeverity.warning ?? 0), critical: Number(bySeverity.critical ?? 0) },
      top: top.map((row) => ({
        id: row.id,
        ruleName: row.rule_name,
        targetLabel: row.target_label,
        severity: row.severity === 'critical' ? 'critical' : 'warning',
        firedAt: row.fired_at,
      })),
      evaluatedAt: this.evaluatedAt,
    };
  }

  /** 装配处（或引擎 `onTick`）记录一次 tick 结果，供 `summary()` 使用。 */
  recordTick(result: { at: string; suppressed: number }): void {
    this.evaluatedAt = result.at;
    // 累计而不是"上次的值"：徽标旁边的解释是"共压掉 N 次"，
    // 只报上一轮的话，绝大多数时刻都会显示 0，等于没有信息。
    this.suppressedTotal += Number.isFinite(result.suppressed) ? result.suppressed : 0;
  }

  /** 只记录评估时间（不需要 suppressed 时的轻量入口）。 */
  recordEvaluatedAt(at: string): void {
    this.evaluatedAt = at;
  }

  /* ---------------- 内部 ---------------- */

  private listRuleRows(): AlertRuleRow[] {
    return (this.deps.db.prepare(RULE_COLUMNS).all() as AlertRuleDbRow[]).map(toAlertRuleRow);
  }

  private ruleById(id: string): AlertRuleRow | null {
    const row = this.deps.db.prepare('SELECT * FROM alert_rules WHERE id = ?').get(id) as AlertRuleDbRow | undefined;
    return row ? toAlertRuleRow(row) : null;
  }

  private eventById(id: string): AlertEventDbRow | null {
    const row = this.deps.db.prepare('SELECT * FROM alert_events WHERE id = ?').get(id) as AlertEventDbRow | undefined;
    return row ?? null;
  }

  /**
   * 组装读查询的 WHERE 片段（状态过滤 + 可见性过滤）+ 参数。
   *
   * 可见性条件**总是在**（fail-closed 时退化为"只有宿主自有事件"），所以这里只有
   * "有没有状态条件"这一种分支，不存在"忘了加可见性"的写法。
   */
  private eventWhere(state: 'all' | 'open' | 'resolved', visible: AlertEventVisibility): { sql: string; params: string[] } {
    const visibility = alertEventVisibilityWhere(visible);
    const stateCondition =
      state === 'open' ? 'resolved_at IS NULL' : state === 'resolved' ? 'resolved_at IS NOT NULL' : null;
    const conditions = stateCondition === null ? [visibility.sql] : [stateCondition, visibility.sql];
    return { sql: `WHERE ${conditions.join(' AND ')}`, params: visibility.params };
  }

  private counts(visible: AlertEventVisibility): AlertEventCounts {
    const where = this.eventWhere('all', visible);
    const row = this.deps.db
      .prepare(
        `SELECT
           SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) AS open,
           SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) AS resolved,
           SUM(CASE WHEN resolved_at IS NULL AND acknowledged_at IS NULL THEN 1 ELSE 0 END) AS unacknowledged
         FROM alert_events ${where.sql}`,
      )
      .get(...where.params) as { open: number | null; resolved: number | null; unacknowledged: number | null };
    return {
      open: Number(row.open ?? 0),
      resolved: Number(row.resolved ?? 0),
      unacknowledged: Number(row.unacknowledged ?? 0),
    };
  }

  private audit(actor: string, action: string, target: string, detail: Record<string, unknown>): void {
    try {
      this.deps.audit.append({
        actorId: null,
        actorName: actor,
        action,
        target,
        detail: JSON.stringify(detail),
        ip: null,
      });
    } catch (error) {
      this.log?.warn('告警审计写入失败', { action, error });
    }
  }
}

/** limit 归一化：非有限/越界一律收敛到 [1, 200]（路由层的 zod 已校验，这里是兜底）。 */
export function normalizeLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return ALERT_EVENTS_DEFAULT_LIMIT;
  const rounded = Math.floor(value);
  if (rounded < 1) return ALERT_EVENTS_DEFAULT_LIMIT;
  return Math.min(rounded, ALERT_EVENTS_MAX_LIMIT);
}