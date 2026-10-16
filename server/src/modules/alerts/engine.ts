/**
 * 告警引擎（S2-04 §5.2）—— episode 模型 + 静默期 + 恢复，**本文件不发出任何站外请求**。
 *
 * 核心不变量（Sprint 1 的教训："把它放进约束，而不是靠调用方自觉"）：
 *
 * **同一 (rule_id, target) 最多只有一行未恢复**，由迁移 v5 的部分唯一索引
 * `idx_alert_events_open ... WHERE resolved_at IS NULL` 保证。引擎的写入逻辑
 * 只是"顺着这个不变量走"：先查未恢复行，有就**不插新行**（`suppressed`），
 * 没有再看静默期决定"重开旧行"还是"插新行"。
 *
 * 为什么必须是 episode 模型（而不是"一次触发一行"）：
 * 容器一直处于 `exited`、磁盘一直高于阈值，如果每次 tick 都插一行，一晚上就是几千条
 * —— 那不是告警，那是日志。episode 把"一次故障"压成一行，恢复写 `resolved_at`，
 * 静默期内再次发生只把同一行重开（`reopen_count++`），所以"一小时内不重复刷屏"
 * 是**结构性**保证的，不依赖任何一个计数器。
 *
 * 为什么 `duration` 计时可以在内存里丢：进程重启后 `pendingSince` 清空，
 * 只是"持续时间重新计时"（最多晚 `duration_sec` 报一次），代价可接受；
 * 而**未恢复的告警绝不能因为重启再通知一次** —— 那条由数据库唯一索引兜住，与内存无关。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/database.js';
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { backgroundHostRequest } from '../docker/backgroundContext.js';
import type { HostContextRequest } from '../docker/service.js';
import type { ContainerListQuery, ContainerListResult, ContainerSummary } from '../docker/types.js';
import { containerServiceRef } from '../services/registry.js';
import type { ServiceListQuery, ServiceRole } from '../services/service.js';
import type { ServiceListResponse } from '../services/types.js';
import type { SystemSnapshot } from '../system/types.js';
import { toEpochMs, type ServiceHealthState } from '../health/types.js';
import { toAlertRuleRow, type AlertEventDbRow, type AlertRuleDbRow, type AlertRuleRow, type AlertSnapshot, type AlertTickResult } from './types.js';

// 调度器按模块路径 import 这两个 tick 结果类型（`../alerts/engine.js`），
// 因此在 engine 上转出一次，避免下游为了一个类型去记住内部文件布局。
export type { AlertTickResult } from './types.js';

/**
 * 审计出口。
 *
 * 规格写的是 `(action, detail) => void`，但装配处手上是 `AuditRepository`（带 `append`）。
 * 两种形态都接受，是为了让接线只有一行、不需要再写一个适配闭包 ——
 * 适配层越多，"动作名写错"越难在类型上发现。
 */
export type AlertAuditSink =
  | ((action: string, detail: Record<string, unknown>) => void)
  | {
      append(input: {
        actorId: number | null;
        actorName: string | null;
        action: string;
        target?: string | null;
        detail?: string | null;
        ip?: string | null;
      }): void;
    };

export interface AlertEngineDeps {
  db: Db;
  config: PortalConfig;
  logger: Logger;
  audit: AlertAuditSink;
  clock?: () => number;
  /**
   * 可选：`tick(now)` 只传一个参数时，用它自行采集快照（§3 的 scheduler 就是这么调的）。
   * 未提供时退化为**空快照**（什么都不触发、什么都不恢复），并记一条 warn。
   */
  snapshot?: { capture(nowMs: number): Promise<AlertSnapshot> };
  /** 可选：tick 结束后回调（`summary().evaluatedAt` 的接线钩子）。 */
  onTick?: (result: AlertTickResult) => void;
}

/** 一个触发候选（条件成立且 duration 窗口已满）。 */
export interface AlertCandidate {
  target: string;
  targetLabel: string;
  value: number | null;
  unit: string | null;
  message: string;
  /** 条件**首次成立**的毫秒时间戳（可能早于 fired_at：duration 窗口）。 */
  startedAt: number;
}

/** 单条规则一次的评估结果。 */
export interface RuleOutcome {
  /** 条件评估次数（rule × target，含"看了但数据未知"的目标）。 */
  evaluated: number;
  /** 条件成立且 duration 已满 → 触发候选。 */
  active: AlertCandidate[];
  /** 明确判定"条件已不成立"的目标 → 可恢复。不在里面 = 无法确认（保持未恢复）。 */
  cleared: string[];
}

function episodeKey(ruleId: string, target: string): string {
  return `${ruleId}|${target}`;
}

/** 数字格式化：整数不带小数点，其余保留 1 位（`91.2` / `85`）。 */
function fmtNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** 触发消息里的"已持续 N 分钟"（duration = 0 时不写，避免"已持续 0 分钟"这种噪声）。 */
function durationText(rule: AlertRuleRow, startedAt: number, nowMs: number): string {
  if (rule.durationSec <= 0) return '';
  const minutes = Math.max(0, Math.round((nowMs - startedAt) / 60_000));
  return `，已持续 ${minutes} 分钟`;
}

/**
 * duration 门控：条件成立后要**持续** `durationSec` 才算数。
 *
 * `pendingSince` 是调用方传入的内存累加器（跨 tick 共享）；条件一旦不成立立刻忘记起点，
 * 这样"抖动一下又恢复"不会把不同时间段的持续时间累加成一个假的"持续了 10 分钟"。
 */
function gateDuration(
  rule: AlertRuleRow,
  target: string,
  conditionTrue: boolean,
  nowMs: number,
  pendingSince: Map<string, number>,
): boolean {
  const key = episodeKey(rule.id, target);
  if (!conditionTrue) {
    pendingSince.delete(key);
    return false;
  }
  if (!pendingSince.has(key)) pendingSince.set(key, nowMs);
  const since = pendingSince.get(key) ?? nowMs;
  return nowMs - since >= rule.durationSec * 1000;
}

/**
 * 评估一条规则（**纯逻辑**：只读快照与传入的累加器，不碰数据库、不发请求）。
 *
 * 导出它就是为了能直接对四条规则的触发/不触发边界写单元测试，
 * 不必每次都走一遍 SQLite 与 tick 编排。
 */
export function evaluateRule(
  rule: AlertRuleRow,
  snapshot: AlertSnapshot,
  nowMs: number,
  pendingSince: Map<string, number>,
): RuleOutcome {
  const outcome: RuleOutcome = { evaluated: 0, active: [], cleared: [] };
  const threshold = rule.threshold;

  if (rule.kind === 'disk_percent' || rule.kind === 'memory_percent') {
    if (threshold === null) return outcome;
    // 百分比类：数据缺失（percent === null / 没有磁盘）时**既不触发也不恢复** ——
    // 取数失败就把告警"自动恢复"掉，是运维上最糟糕的假象。
    const subjects: Array<{ target: string; targetLabel: string; percent: number | null }> = [];
    if (rule.kind === 'disk_percent') {
      const disks = snapshot.host.disks;
      if (rule.target === null) {
        const seenLabels = new Set<string>();
        for (const disk of disks) {
          const target = `disk:${disk.label}`;
          if (seenLabels.has(target)) continue;
          seenLabels.add(target);
          subjects.push({ target, targetLabel: disk.label, percent: disk.percent });
        }
      } else {
        const disk = disks.find((item) => `disk:${item.label}` === rule.target);
        if (!disk) {
          // 目标磁盘从快照里消失了：有其它磁盘数据说明"确实没有这块盘" → 可恢复；
          // 整个列表为空则视为取数失败 → 不动。
          if (disks.length > 0) outcome.cleared.push(rule.target);
          return outcome;
        }
        subjects.push({ target: rule.target, targetLabel: disk.label, percent: disk.percent });
      }
    } else {
      subjects.push({
        target: rule.target ?? 'host',
        targetLabel: '宿主',
        percent: snapshot.host.memoryPercent,
      });
    }

    for (const subject of subjects) {
      outcome.evaluated += 1;
      if (subject.percent === null) continue;
      const condition = subject.percent > threshold;
      const ready = gateDuration(rule, subject.target, condition, nowMs, pendingSince);
      if (!condition) {
        outcome.cleared.push(subject.target);
        continue;
      }
      if (!ready) continue;
      const since = pendingSince.get(episodeKey(rule.id, subject.target)) ?? nowMs;
      const noun = rule.kind === 'disk_percent' ? `磁盘 ${subject.targetLabel} 使用率` : '宿主内存使用率';
      outcome.active.push({
        target: subject.target,
        targetLabel: subject.targetLabel,
        value: subject.percent,
        unit: 'percent',
        message: `${noun} ${fmtNumber(subject.percent)}%（阈值 ${fmtNumber(threshold)}%${durationText(rule, since, nowMs)}）`,
        startedAt: since,
      });
    }
    return outcome;
  }

  if (rule.kind === 'container_exit') {
    const containers =
      rule.target === null
        ? snapshot.containers
        : snapshot.containers.filter((item) => `container:${item.sourceRef}` === rule.target);
    // 指定目标但快照里没有这个容器 → 无法确认它是否恢复，保持未恢复（不猜）。
    if (rule.target !== null && containers.length === 0) return outcome;

    for (const container of containers) {
      const target = `container:${container.sourceRef}`;
      outcome.evaluated += 1;
      const abnormal = container.state === 'dead' || (container.state === 'exited' && container.exitCode !== null && container.exitCode !== 0);
      if (abnormal) {
        const ready = gateDuration(rule, target, true, nowMs, pendingSince);
        if (!ready) continue;
        const since = pendingSince.get(episodeKey(rule.id, target)) ?? nowMs;
        const codeText = container.exitCode === null ? '退出码未知' : `退出码 ${container.exitCode}`;
        outcome.active.push({
          target,
          targetLabel: container.label,
          value: container.exitCode,
          unit: 'exit_code',
          message: `容器 ${container.label} 异常退出（${container.state}，${codeText}）`,
          startedAt: since,
        });
        continue;
      }
      // 恢复条件 = 该容器重新 running（规格明文）。
      // `exited` 但退出码为 0 或未知时**不动**：证据不足时既不能说"还在故障"，
      // 也不能说"已恢复"。
      if (container.state === 'running') {
        gateDuration(rule, target, false, nowMs, pendingSince);
        outcome.cleared.push(target);
      }
    }
    return outcome;
  }

  // service_health：连续失败次数**由健康状态机给**，引擎不再自己数（否则两处计数必然漂移）。
  if (threshold === null) return outcome;
  const services =
    rule.target === null ? snapshot.services : snapshot.services.filter((item) => `service:${item.sourceRef}` === rule.target);
  if (rule.target !== null && services.length === 0) return outcome;

  for (const service of services) {
    const target = `service:${service.sourceRef}`;
    outcome.evaluated += 1;
    const condition = service.consecutiveFailures >= threshold;
    const ready = gateDuration(rule, target, condition, nowMs, pendingSince);
    if (!condition) {
      outcome.cleared.push(target);
      continue;
    }
    if (!ready) continue;
    const since = pendingSince.get(episodeKey(rule.id, target)) ?? nowMs;
    outcome.active.push({
      target,
      targetLabel: service.label,
      value: service.consecutiveFailures,
      unit: 'count',
      message: `服务 ${service.label} 连续 ${service.consecutiveFailures} 次探测失败（阈值 ${threshold} 次）`,
      startedAt: since,
    });
  }
  return outcome;
}

/* ------------------------------------------------------------------ *
 * 默认快照采集（可选依赖）
 * ------------------------------------------------------------------ */

export interface AlertSnapshotSourceDeps {
  config: PortalConfig;
  system: { snapshot(): Promise<SystemSnapshot> };
  containers: { list(query: ContainerListQuery, request: HostContextRequest): Promise<ContainerListResult> };
  registry: { list(request: HostContextRequest, query?: ServiceListQuery, role?: ServiceRole): Promise<ServiceListResponse> };
  /** 健康监视器（`service_health` 的 verdict 与连续失败次数只能从这里来）。 */
  health: { states(): ServiceHealthState[] };
  logger?: Logger;
}

/**
 * 从既有数据源采集一份告警快照。
 *
 * 单个数据源失败**只降级该部分**（对应规则本轮不触发/不恢复），不抛错：
 * 告警引擎是后台任务，宁可少报一轮，也不能因为一个数据源抖动就整轮失败。
 *
 * `exitCode`：由 `ContainerSummary.exitCode` 映射而来（`docker/mapper.ts`），
 * 这里仍做**容错读取**（字段缺失或类型不符一律当 `null` = 未知），
 * 这样即便上游契约变化也只是"少一条告警"，不会让整轮评估抛错。
 */
export function createAlertSnapshotSource(deps: AlertSnapshotSourceDeps): { capture(nowMs: number): Promise<AlertSnapshot> } {
  const log = deps.logger?.child({ mod: 'alerts' });
  return {
    async capture(nowMs: number): Promise<AlertSnapshot> {
      const request = backgroundHostRequest(deps.config);
      const system = await deps.system.snapshot().catch((error: unknown) => {
        log?.warn('告警快照：宿主指标获取失败', { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      const live = await deps.containers.list({ all: true, stats: false }, request).catch((error: unknown) => {
        log?.warn('告警快照：容器列表获取失败', { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      const services = await deps.registry.list(request, {}, 'viewer').catch((error: unknown) => {
        log?.warn('告警快照：服务列表获取失败', { error: error instanceof Error ? error.message : String(error) });
        return null;
      });
      const healthStates = deps.health.states();
      const labelByRef = new Map((services?.items ?? []).map((view) => [view.sourceRef, view.displayName]));

      return {
        at: nowMs,
        host: {
          cpuPercent: system?.cpu.percent ?? null,
          memoryPercent: system?.memory.percent ?? null,
          disks: (system?.disks ?? []).map((disk) => ({ label: disk.label, percent: disk.percent })),
        },
        containers: (live?.items ?? []).map((container) => ({
          sourceRef: containerServiceRef(container),
          label: container.name,
          containerId: container.id,
          state: container.state,
          exitCode: readExitCode(container),
          startedAt: container.startedAt,
        })),
        // 服务宇宙取**健康状态**而不是服务列表：列表里有而状态里没有的服务
        // 意味着"还没评估过"，把它当成 consecutiveFailures = 0 会把未恢复的告警假恢复掉。
        services: healthStates.map((state) => ({
          sourceRef: state.sourceRef,
          serviceId: state.serviceId,
          label: labelByRef.get(state.sourceRef) ?? state.sourceRef,
          verdict: state.verdict,
          consecutiveFailures: state.consecutiveFailures,
        })),
      };
    },
  };
}

/** 容错读取容器退出码（当前 `ContainerSummary` 没有该字段 → 恒为 null）。 */
function readExitCode(container: ContainerSummary): number | null {
  const raw = (container as unknown as { exitCode?: unknown }).exitCode;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export class AlertEngine {
  private readonly deps: AlertEngineDeps;
  private readonly log: Logger;
  private readonly clock: () => number;
  /** duration 计时（内存，重启即重新计时——规格明确接受）。 */
  private readonly pendingSince = new Map<string, number>();
  private lastTickAtValue: string | null = null;
  /** 自进程启动以来被"已有未恢复行"压掉的触发次数（`summary().suppressed` 的来源）。 */
  private suppressedTotalValue = 0;
  private warnedMissingSnapshot = false;

  constructor(deps: AlertEngineDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ mod: 'alerts' });
    this.clock = deps.clock ?? (() => Date.now());
  }

  /** 上次 tick 的时间（ISO）；`AlertsService.summary().evaluatedAt` 用它。 */
  lastTickAt(): string | null {
    return this.lastTickAtValue;
  }

  /** 累计被压掉的触发次数（`summary().suppressed`）。 */
  suppressedTotal(): number {
    return this.suppressedTotalValue;
  }

  /**
   * 跑一轮告警评估。
   *
   * @param now      毫秒时间戳（秒制也能识别，见 `toEpochMs`）
   * @param snapshot 可选；缺省时用注入的 `snapshot.capture`，都没有则退化为空快照
   */
  async tick(now: number, snapshot?: AlertSnapshot): Promise<AlertTickResult> {
    // `now` 非有限（例如调用方漏传）时退回注入时钟，而不是让 NaN 静默污染所有时间比较。
    const nowMs = Number.isFinite(now) ? toEpochMs(now) : this.clock();
    const at = new Date(nowMs).toISOString();
    const snap = snapshot ?? (await this.captureSnapshot(nowMs));

    const rules = this.loadEnabledRules();
    const openEpisodes = this.loadOpenEpisodes();
    let evaluated = 0;
    let opened = 0;
    let reopened = 0;
    let resolved = 0;
    let suppressed = 0;

    for (const rule of rules) {
      const outcome = evaluateRule(rule, snap, nowMs, this.pendingSince);
      evaluated += outcome.evaluated;

      // 1) 先处理恢复：条件明确不成立的行写 resolved_at。
      for (const target of outcome.cleared) {
        const key = episodeKey(rule.id, target);
        const open = openEpisodes.get(key);
        if (!open) continue;
        this.resolveEpisode(open, rule, at);
        openEpisodes.delete(key);
        resolved += 1;
      }

      // 2) 再处理触发：已有未恢复行 → 不插新行（重启不重复通知的不变量）。
      for (const candidate of outcome.active) {
        const key = episodeKey(rule.id, candidate.target);
        if (openEpisodes.has(key)) {
          suppressed += 1;
          continue;
        }
        const written = this.recordTrigger(rule, candidate, nowMs, at);
        if (written === 'opened') opened += 1;
        else if (written === 'reopened') reopened += 1;
        else suppressed += 1;
      }
    }

    this.lastTickAtValue = at;
    this.suppressedTotalValue += suppressed;
    const result: AlertTickResult = { at, evaluated, opened, reopened, resolved, suppressed };
    try {
      this.deps.onTick?.(result);
    } catch (error) {
      this.log.warn('告警 tick 回调失败', { error });
    }
    return result;
  }

  private async captureSnapshot(nowMs: number): Promise<AlertSnapshot> {
    if (this.deps.snapshot) return this.deps.snapshot.capture(nowMs);
    if (!this.warnedMissingSnapshot) {
      // 只警告一次：这是装配缺口，不是每轮的运行故障，不需要刷屏。
      this.warnedMissingSnapshot = true;
      this.log.warn('告警引擎未配置快照来源：本轮不评估任何条件（请在装配处传 snapshot 或 tick 的第二参数）');
    }
    return { at: nowMs, host: { cpuPercent: null, memoryPercent: null, disks: [] }, containers: [], services: [] };
  }

  private loadEnabledRules(): AlertRuleRow[] {
    const rows = this.deps.db.prepare('SELECT * FROM alert_rules').all() as AlertRuleDbRow[];
    // `enabled = 0` 的规则**完全不评估**（默认四条内置规则即"装了但不吵"）。
    return rows.map(toAlertRuleRow).filter((rule) => rule.enabled === 1);
  }

  private loadOpenEpisodes(): Map<string, AlertEventDbRow> {
    const rows = this.deps.db.prepare('SELECT * FROM alert_events WHERE resolved_at IS NULL').all() as AlertEventDbRow[];
    const map = new Map<string, AlertEventDbRow>();
    for (const row of rows) map.set(episodeKey(row.rule_id, row.target), row);
    return map;
  }

  private latestEpisode(ruleId: string, target: string): AlertEventDbRow | null {
    const row = this.deps.db
      .prepare('SELECT * FROM alert_events WHERE rule_id = ? AND target = ? ORDER BY fired_at DESC, created_at DESC LIMIT 1')
      .get(ruleId, target) as AlertEventDbRow | undefined;
    return row ?? null;
  }

  /**
   * 落库一次触发：静默期内 → 重开旧行；否则 → 插新行。
   *
   * "静默期内"的判据是**上次触发时间**（`fired_at`）而不是恢复时间：
   * 逐字对应 §2.4 的"若在 `fired_at`（上次触发）后 `silence_sec` 内条件再次成立"。
   */
  private recordTrigger(rule: AlertRuleRow, candidate: AlertCandidate, nowMs: number, at: string): 'opened' | 'reopened' | 'suppressed' {
    const previous = this.latestEpisode(rule.id, candidate.target);
    if (previous && previous.resolved_at !== null) {
      const firedMs = Date.parse(previous.fired_at);
      const withinSilence = Number.isFinite(firedMs) && nowMs - firedMs < rule.silenceSec * 1000;
      if (withinSilence) {
        this.reopenEpisode(previous, rule, candidate, at);
        return 'reopened';
      }
    }

    const id = `alert-${randomUUID()}`;
    try {
      this.deps.db
        .prepare(
          `INSERT INTO alert_events (
             id, rule_id, kind, rule_name, target, target_label, severity, value, threshold, unit,
             message, started_at, fired_at, resolved_at, reopen_count, acknowledged_at, acknowledged_by, created_at
           ) VALUES (
             @id, @ruleId, @kind, @ruleName, @target, @targetLabel, @severity, @value, @threshold, @unit,
             @message, @startedAt, @firedAt, NULL, 0, NULL, NULL, @createdAt
           )`,
        )
        .run({
          id,
          ruleId: rule.id,
          kind: rule.kind,
          ruleName: rule.name,
          target: candidate.target,
          targetLabel: candidate.targetLabel,
          severity: rule.severity,
          value: candidate.value,
          threshold: rule.threshold,
          unit: candidate.unit,
          message: candidate.message,
          startedAt: new Date(candidate.startedAt).toISOString(),
          firedAt: at,
          createdAt: at,
        });
    } catch (error) {
      // 部分唯一索引兜底：并发/异常路径下若已存在未恢复行，唯一约束会拒绝插入。
      // 这不是故障，而是不变量在起作用 —— 记 suppressed 而不是让整轮 tick 崩掉。
      if (isUniqueViolation(error)) {
        this.log.warn('告警事件已存在未恢复行，跳过插入（唯一索引生效）', { ruleId: rule.id, target: candidate.target });
        return 'suppressed';
      }
      throw error;
    }

    this.audit('alert.fired', candidate.target, {
      eventId: id,
      ruleId: rule.id,
      kind: rule.kind,
      target: candidate.target,
      value: candidate.value,
      threshold: rule.threshold,
      severity: rule.severity,
    });
    return 'opened';
  }

  /**
   * 静默期内重开同一行。
   *
   * 为什么清空 `acknowledged_*`：确认（ack）的语义是"我知道这一次故障了"；
   * 故障重开是一个**新的事实**，沿用一个已经过期的"我知道了"会让看板骗人。
   */
  private reopenEpisode(previous: AlertEventDbRow, rule: AlertRuleRow, candidate: AlertCandidate, at: string): void {
    this.deps.db
      .prepare(
        `UPDATE alert_events SET
           resolved_at = NULL,
           reopen_count = reopen_count + 1,
           acknowledged_at = NULL,
           acknowledged_by = NULL,
           kind = @kind,
           rule_name = @ruleName,
           target_label = @targetLabel,
           severity = @severity,
           value = @value,
           threshold = @threshold,
           unit = @unit,
           message = @message,
           started_at = @startedAt,
           fired_at = @firedAt
         WHERE id = @id`,
      )
      .run({
        id: previous.id,
        kind: rule.kind,
        ruleName: rule.name,
        targetLabel: candidate.targetLabel,
        severity: rule.severity,
        value: candidate.value,
        threshold: rule.threshold,
        unit: candidate.unit,
        message: candidate.message,
        startedAt: new Date(candidate.startedAt).toISOString(),
        firedAt: at,
      });

    this.audit('alert.reopened', previous.target, {
      eventId: previous.id,
      ruleId: rule.id,
      kind: rule.kind,
      target: previous.target,
      value: candidate.value,
      threshold: rule.threshold,
      reopenCount: previous.reopen_count + 1,
    });
  }

  private resolveEpisode(open: AlertEventDbRow, rule: AlertRuleRow, at: string): void {
    this.deps.db.prepare('UPDATE alert_events SET resolved_at = @resolvedAt WHERE id = @id').run({ id: open.id, resolvedAt: at });
    this.audit('alert.resolved', open.target, {
      eventId: open.id,
      ruleId: rule.id,
      kind: open.kind,
      target: open.target,
      value: open.value,
      firedAt: open.fired_at,
      resolvedAt: at,
      // Sprint 2 没有出站通道（Sprint 4 才有）；这里把"是否希望恢复通知"记进审计，
      // 免得将来接通知时又要回去猜用户当初的意图。
      notifyRecovery: rule.notifyRecovery === 1,
    });
  }

  /** 审计：失败只告警。告警已经落库，不能因为审计写不进去就回滚或抛错。 */
  private audit(action: string, target: string | null, detail: Record<string, unknown>): void {
    try {
      if (typeof this.deps.audit === 'function') {
        this.deps.audit(action, detail);
      } else {
        this.deps.audit.append({ actorId: null, actorName: 'system', action, target, detail: JSON.stringify(detail) });
      }
    } catch (error) {
      this.log.warn('告警审计写入失败', { action, error });
    }
  }

  /** 诊断用：当前 duration 计时中有多少目标（测试与排障都靠它）。 */
  pendingCount(): number {
    return this.pendingSince.size;
  }
}

/** better-sqlite3 的唯一约束错误（部分唯一索引被触发）。 */
function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT';
}