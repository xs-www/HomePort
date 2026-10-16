/**
 * `BackgroundScheduler` —— 唯一的后台单例（S2-01 §3）。
 *
 * ## 为什么必须有它，以及为什么默认不开
 *
 * - **全进程只有一个**：为每个前端会话采集是浪费（SSE 仍走原有 `SystemService`，
 *   既不读也不需要 `metric_buckets`）。采样、健康判定、告警评估都挂在同一个 tick 上，
 *   顺序固定，因此"指标里的健康占比用的是本 tick 刚更新的判定"这一点才有保证。
 * - **`buildApp` 默认 `backgroundJobs: false`**：`buildApp` 被大量测试 `inject` 复用，
 *   默认开定时器会让测试变慢且相互干扰；生产入口只有一个（`index.ts`），由它显式开启。
 *
 * ## 三条硬约束
 *
 * 1. **单飞**：上一轮没结束时新的 tick 立即返回 `{ skipped: true }`，不排队、不并发。
 *    否则一次慢采集会叠出多轮并发，把 docker/DB 一起拖垮。
 * 2. **失败隔离**：每一步各自 try/catch，错误只累加到 `TickSummary.error` 并记日志，
 *    **绝不向上抛** —— 后台任务崩掉整个进程是不可接受的。剩下的步骤仍然继续执行。
 * 3. **定时器必须 `unref()`**：否则测试进程会被它吊住（`app.close()` 也要 `stop()`）。
 */
import type { Logger } from '../../logger.js';
import type { AlertTickResult } from '../alerts/engine.js';
import type { HealthTickResult } from '../health/monitor.js';
import type { MetricsTickResult } from './types.js';

/** 后台 tick 间隔的兜底值（ms）；正常情况下由 config 经 `intervalMs()` 提供。 */
export const DEFAULT_SCHEDULER_INTERVAL_MS = 30_000;
/** 间隔下限（ms）：防止设置页填出 1ms 把宿主打满。 */
export const MIN_SCHEDULER_INTERVAL_MS = 1_000;

export interface SchedulerDeps {
  health: { tick(now: number): Promise<HealthTickResult> };
  metrics: { tick(now: number): Promise<MetricsTickResult> };
  alerts: { tick(now: number): Promise<AlertTickResult> };
  logger: Logger;
  /**
   * 时钟，**单位是 unix 秒**（与各 `tick(now)` 的参数一致；不再是 ms，
   * 原规格 §3 的"默认 Date.now"只是说"用系统时钟"，单位以各 tick 的契约为准）。
   */
  clock?: () => number;
  /** tick 间隔（ms）。**每次排期时重新求值**，因此设置页改完下一周期即生效。 */
  intervalMs?: () => number;
}

export interface TickSummary {
  /** 本轮 tick 的时刻（ISO） */
  at: string;
  durationMs: number;
  /** 本轮被单飞跳过（上一轮还没结束） */
  skipped: boolean;
  /** 各步结果；该步**未执行或失败**时为 null（不用 0 值冒充"跑过了"） */
  health: HealthTickResult | null;
  metrics: MetricsTickResult | null;
  alerts: AlertTickResult | null;
  /** 任一步的错误摘要；null = 全部成功。**只记录，不抛出** */
  error: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BackgroundScheduler {
  private readonly deps: SchedulerDeps;
  private readonly log: Logger;
  private readonly clock: () => number;
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  /** 当前定时器使用的间隔，用于发现配置变化后重新排期 */
  private scheduledIntervalMs = 0;
  /** 在飞的那一轮（单飞的依据） */
  private inFlight: Promise<TickSummary> | null = null;
  private summary: TickSummary | null = null;

  constructor(deps: SchedulerDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ mod: 'scheduler' });
    this.clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  /** 定时器是否在跑（`stop()` 之后为 false）。 */
  get running(): boolean {
    return this.started;
  }

  /**
   * 启动：**立即跑一次** tick，然后按间隔排期。
   *
   * 立即跑一次是必要的：重启后要尽快补齐停机期间的整点桶，
   * 并让监控/历史页在第一个间隔之前就有状态。
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    void this.tickOnce();
    this.schedule();
  }

  /** 停止：清掉定时器。`app.close()` 必须调用，否则测试进程被吊住。 */
  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 最近一次**真正跑过**的 tick 摘要（被跳过的轮次不覆盖它）。 */
  lastSummary(): TickSummary | null {
    return this.summary;
  }

  /**
   * 跑一轮：`health.tick()` → `metrics.tick()` → `alerts.tick()`。
   *
   * 顺序是契约的一部分：指标里的 `service.health.up_ratio` 必须用本 tick
   * **刚更新**的健康判定；告警评估必须看到本 tick **刚写入**的样本。
   *
   * @param now unix 秒；省略时取注入时钟
   */
  async tickOnce(now?: number): Promise<TickSummary> {
    if (this.inFlight) {
      // 单飞：不排队、不等待，直接把"这轮被跳过了"告诉调用方。
      // 等待在飞的那一轮会让 tick 队列越积越长（每轮都慢的话就是雪崩）。
      return {
        at: new Date(this.resolveNow(now) * 1000).toISOString(),
        durationMs: 0,
        skipped: true,
        health: null,
        metrics: null,
        alerts: null,
        error: null,
      };
    }

    const at = this.resolveNow(now);
    const startedAt = Date.now();
    const run = this.runSteps(at, startedAt);
    this.inFlight = run;
    try {
      return await run;
    } finally {
      this.inFlight = null;
    }
  }

  /** 依次执行三步；每一步的错误都被隔离在本步。 */
  private async runSteps(now: number, startedAt: number): Promise<TickSummary> {
    const errors: string[] = [];
    let health: HealthTickResult | null = null;
    let metrics: MetricsTickResult | null = null;
    let alerts: AlertTickResult | null = null;

    try {
      health = await this.deps.health.tick(now);
    } catch (error) {
      errors.push(`health: ${errorMessage(error)}`);
      this.log.warn('健康监测 tick 失败（本轮其余步骤继续）', { error });
    }

    try {
      metrics = await this.deps.metrics.tick(now);
    } catch (error) {
      errors.push(`metrics: ${errorMessage(error)}`);
      this.log.warn('指标采样 tick 失败（本轮其余步骤继续）', { error });
    }

    try {
      alerts = await this.deps.alerts.tick(now);
    } catch (error) {
      errors.push(`alerts: ${errorMessage(error)}`);
      this.log.warn('告警评估 tick 失败（本轮其余步骤继续）', { error });
    }

    const summary: TickSummary = {
      at: new Date(now * 1000).toISOString(),
      durationMs: Date.now() - startedAt,
      skipped: false,
      health,
      metrics,
      alerts,
      error: errors.length > 0 ? errors.join('; ') : null,
    };
    this.summary = summary;
    return summary;
  }

  /** 排期；间隔变化时重新排期（设置页 live 生效的落地方式）。 */
  private schedule(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!this.started) return;

    const intervalMs = this.resolveIntervalMs();
    this.scheduledIntervalMs = intervalMs;
    this.timer = setInterval(() => {
      if (this.resolveIntervalMs() !== this.scheduledIntervalMs) {
        // 间隔被改过：先按新间隔重新排期，本轮仍然照跑（空转一轮没有必要）
        this.schedule();
      }
      void this.tickOnce();
    }, intervalMs);
    // 必需：否则 `buildApp({ backgroundJobs: false })` 之外的测试进程会被定时器吊住
    this.timer.unref();
  }

  private resolveNow(now?: number): number {
    if (now !== undefined && Number.isFinite(now)) return now;
    return this.clock();
  }

  private resolveIntervalMs(): number {
    const raw = this.deps.intervalMs?.() ?? DEFAULT_SCHEDULER_INTERVAL_MS;
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_SCHEDULER_INTERVAL_MS;
    return Math.max(MIN_SCHEDULER_INTERVAL_MS, Math.floor(raw));
  }
}