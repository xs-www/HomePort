/**
 * `MetricsSampler` —— 历史指标的采集、落库、滚动与保留（S2-01 的核心）。
 *
 * 契约见 `docs/sprint2-implementation-spec.md` §3.1（含新增的 §1.1 存储预算）。
 *
 * ## 一次 tick 做了什么（顺序不可换）
 *
 * 1. `flushPending(now)`：把**已经结束的分钟**批量落库（每 tick 至多一次写事务）；
 * 2. `rollupHours(now)`：整点滚动 —— 从 minute 行聚合出缺失的 hour 行
 *    （每小时至多一次，且启动后第一次必跑，用来补齐停机期间的整点）；
 * 3. `prune(now)`：删过期行（启动一次 + 每次小时滚动一次）；
 * 4. `collect(now)`：取数据源 → 累加进**内存**里当前分钟的累加器（**不写库**）。
 *
 * ## 为什么这样切（而不是每 tick 写库 / 攒一小时再写）
 *
 * - 每 tick 写库：30s 间隔下是一小时 120 次写事务，而曲线的最小分辨率只有一分钟，
 *   同一分钟的样本最终只会变成一行 —— 多出来的写全是浪费（这正是"采样引起高 CPU"的成因）。
 * - 攒一小时再写：小时内进程重启就丢掉最多 59 分钟样本。
 * - 折中：内存累积 + **分钟落库**。每小时写事务数与 tick 数无关（与采样间隔无关），
 *   进程重启的损失上界是"当前这一分钟"。
 *
 * ## 为什么 hour 从 DB 聚合（不在内存里攒）
 *
 * 内存里的累加器会随重启丢失，而 minute 行不会。因此整点桶由
 * `SELECT … GROUP BY` 从 minute 行算出来 —— 重启后能自动补上停机期间的整点。
 * 代价是每小时多一次聚合读，换来的是"历史不因重启而残缺"。
 *
 * ## 缺测的表达
 *
 * - 整分钟一个样本都没有 → **不写行**（`gaps` 里计数，日志里提一句）；
 * - 桶内样本不足 → 写行并标 `samples < expected`（前端显示为 partial）。
 *
 * 任何情况下都不会写 `value = 0` 来表示"不知道"。
 *
 * ## 读路径的可见性（不可省）
 *
 * 采集用 viewer 视角只保证"隐藏之后不再新增样本"；**隐藏之前**已落库的行与进程内
 * `liveTargets` 仍在。因此 `availableTargets()` 与 `resolveTarget()` 会按**当前**
 * viewer 可见服务集合再过一次（见 `visibleServiceRefs`，实现已抽到共享模块
 * `modules/visibility/serviceVisibility.ts`，与告警读路径同一份）：不可见与"从未采集过"
 * 返回同一个 null，API 层据此返回同一种 400 —— 不泄露存在性。
 */
import type { PortalConfig } from '../../config.js';
import type { Db } from '../../db/database.js';
import type { Logger } from '../../logger.js';
import { backgroundHostRequest } from '../docker/backgroundContext.js';
import type { HostContextRequest } from '../docker/service.js';
import {
  isServiceTargetVisible,
  loadVisibleServiceRefs,
  type ServiceTargetKind,
} from '../visibility/serviceVisibility.js';
import {
  HOUR_SECONDS,
  MINUTE_SECONDS,
  MetricBucketsRepository,
  accumulatorToRow,
  addSample,
  expectedSamples,
  hourAggregateToRow,
  hourStart,
  isPartial,
  minuteStart,
  takeEnded,
  type BucketAccumulator,
} from './buckets.js';
import {
  collectContainerSamples,
  collectHostSamples,
  collectServiceSamples,
  containerSource,
  HOST_TARGET,
  HOST_TARGET_LABEL,
} from './collector.js';
import {
  METRIC_RANGES,
  buildHistoryView,
  bucketAtToIso,
  rangeWindow,
  resolutionForRange,
  samplingNote,
} from './history.js';
import {
  METRIC_CATALOG,
  matchesTargetPattern,
  metricByKey,
  type MetricCatalogView,
  type MetricDefinition,
  type MetricHistoryView,
  type MetricRange,
  type MetricSample,
  type MetricSchedulerView,
  type MetricServiceVerdict,
  type MetricSourceStatus,
  type MetricStorageView,
  type MetricTargetView,
  type MetricsTickResult,
  type MetricsContainerSource,
  type MetricsHealthSource,
  type MetricsServiceRegistrySource,
  type MetricsSystemSource,
} from './types.js';

/** 采样器依赖（结构类型：传真实服务实例即可，无需 import 具体类）。 */
export interface MetricsDeps {
  db: Db;
  config: PortalConfig;
  logger: Logger;
  /** 宿主/磁盘数据源（`SystemService` / `SystemProvider` 都满足） */
  system: MetricsSystemSource;
  /** 容器数据源（走它自带的 TTL 2s 缓存） */
  containers: MetricsContainerSource;
  /** 服务注册表（只用到 `list()`；后台固定 `role: 'viewer'`） */
  registry: MetricsServiceRegistrySource;
  /** 健康判定来源（`HealthMonitor`；只问"现在是什么判定"，不在这里重新计数） */
  health: MetricsHealthSource;
  /** 时钟（unix 秒）；默认 `Date.now`。注入用于测试与一昼夜仿真 */
  clock?: () => number;
  /** 采样间隔（秒）；默认读 config —— 每次求值，因此设置页改完即生效 */
  intervalSec?: () => number;
}

/** `flushPending` 的结果（比 `BucketWriteResult` 多带缺口信息）。 */
export interface FlushResult {
  /** 写入（或幂等重写）的 minute 行数 */
  rows: number;
  /** 其中 `samples < expected` 的行数 */
  partial: number;
  /** 写入行里包含的原始样本总数 */
  samples: number;
  /** 缺口计数 = partial + 完全没有样本的整分钟数 */
  gaps: number;
  /** 完全没有样本、因此**没有写行**的整分钟数 */
  missingMinutes: number;
}

export interface RollupResult {
  /** 写入的 hour 行数 */
  rows: number;
  /** 其中 `samples < 60` 的行数（该整点缺分钟数据） */
  partial: number;
  /** 写入行里包含的 minute 行数合计 */
  samples: number;
}

/* ------------------------------------------------------------------ *
 * 存储预算（§1.1）
 * ------------------------------------------------------------------ */

/** §1.1 的典型部署基准：host 3 + 磁盘 6 + 容器 20 + 服务 7 = 36 条序列/分钟。 */
export const BASELINE_SERIES_PER_MINUTE = 36;
/** §1.1 的每行估算（含索引开销，四舍五入到 200 B）。 */
export const METRIC_BYTES_PER_ROW = 200;
/** §1.1 的稳态总量上限：32 MB（含索引与空闲页）。 */
export const STEADY_STATE_BUDGET_BYTES = 32 * 1024 * 1024;

/**
 * 由"每分钟序列数"线性外推存储预算。
 *
 * 这是**估算**（`note` 里必须写明，且实测大小另有 `size.bytes`）：
 * 用途是回答"照这个规模跑一年，库会不会涨到不可接受"，而不是替代实测。
 * 判据 ②（minute 行数不随运行时长增长）由 `minuteSteadyRows` 表达：
 * 它只与保留窗口有关，与跑了多久无关。
 */
export function estimateBudget(input: {
  minuteRetentionHours: number;
  hourRetentionDays: number;
  observedSeriesPerMinute: number;
}): MetricStorageView['budget'] {
  const observed = Number.isFinite(input.observedSeriesPerMinute) ? input.observedSeriesPerMinute : 0;
  const basis: 'observed' | 'baseline' = observed > 0 ? 'observed' : 'baseline';
  const seriesPerMinute = basis === 'observed' ? observed : BASELINE_SERIES_PER_MINUTE;

  const minuteRowsPerDay = seriesPerMinute * (24 * 60);
  const hourRowsPerDay = seriesPerMinute * 24;
  const minuteSteadyRows = Math.round(seriesPerMinute * 60 * input.minuteRetentionHours);
  const hourSteadyRows = hourRowsPerDay * input.hourRetentionDays;
  const estimatedBytesPerDay = (minuteRowsPerDay + hourRowsPerDay) * METRIC_BYTES_PER_ROW;
  const estimatedSteadyBytes = (minuteSteadyRows + hourSteadyRows) * METRIC_BYTES_PER_ROW;

  return {
    basis,
    seriesPerMinute,
    bytesPerRow: METRIC_BYTES_PER_ROW,
    minuteRowsPerDay,
    hourRowsPerDay,
    minuteSteadyRows,
    hourSteadyRows,
    estimatedBytesPerDay,
    estimatedSteadyBytes,
    steadyLimitBytes: STEADY_STATE_BUDGET_BYTES,
    withinBudget: estimatedSteadyBytes <= STEADY_STATE_BUDGET_BYTES,
    note:
      `按${basis === 'observed' ? '最近一小时实际出现的' : '§1.1 典型部署基准的'} ` +
      `${seriesPerMinute} 条序列/分钟线性外推（每行约 ${METRIC_BYTES_PER_ROW} B，含索引开销）；` +
      `这是估算而非实测，实测占用见 size.bytes。分钟行数由保留窗口封顶，不随运行时长增长。`,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 历史指标采样器。
 *
 * **全进程只有一个**（由 `app.ts` 装配）：多实例会各自维护内存累加器，
 * 导致同一桶被两路写入（虽然 upsert 幂等，但 `samples` 会互相覆盖，缺测判定就错了）。
 */
export class MetricsSampler {
  private readonly deps: MetricsDeps;
  private readonly log: Logger;
  private readonly repo: MetricBucketsRepository;
  private readonly hostRequest: HostContextRequest;
  private readonly clock: () => number;
  /** 当前（未结束）分钟的累加器：key = `bucketAt|metric|target` */
  private readonly pending = new Map<string, BucketAccumulator>();
  /** 本进程见过的 target（含尚未落库的），用于目录与 target 校验 */
  private readonly liveTargets = new Map<string, MetricTargetView>();
  /** 上一次 tick 所在的分钟桶（用于识别"整分钟没有样本"的缺口） */
  private lastTickBucketAt: number | null = null;
  /** 上一次做过整点滚动的整点（null = 启动后还没做过，必须做一次补齐） */
  private lastRollupHourAt: number | null = null;
  /** 上一次保留清理的整点 */
  private lastPruneHourAt: number | null = null;
  /** 最近一次各 metric 的数据源状态（供 history 透出） */
  private readonly lastSources: Record<string, MetricSourceStatus> = {};
  private lastResult: MetricsTickResult | null = null;

  constructor(deps: MetricsDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ mod: 'metrics' });
    this.repo = new MetricBucketsRepository(deps.db);
    this.hostRequest = backgroundHostRequest(deps.config);
    this.clock = deps.clock ?? (() => Math.floor(Date.now() / 1000));
  }

  /* ---------------------------------------------------------------- *
   * tick
   * ---------------------------------------------------------------- */

  /**
   * 一次采样 tick。
   *
   * @param now unix 秒（由调用方给出，便于注入时钟）
   */
  async tick(now: number): Promise<MetricsTickResult> {
    const bucketAt = minuteStart(now);
    const errors: string[] = [];

    // 1) 已经结束的分钟 → 落库（本 tick 唯一的分钟级写事务）
    const flush = this.flushPending(now);
    // 2) 整点滚动（每小时一次；启动后第一次必跑，用于补齐停机期间的整点）
    const rollup = this.rollupHours(now);
    // 3) 保留清理（启动一次 + 每次小时滚动一次）
    const pruned = this.pruneIfDue(now);
    // 4) 采集（只进内存累加器，不写库）
    const collected = await this.collect(now, bucketAt, errors);

    const result: MetricsTickResult = {
      at: new Date(now * 1000).toISOString(),
      collected,
      samplesWritten: flush.samples + rollup.samples,
      bucketsFlushed: flush.rows,
      hoursRolledUp: rollup.rows,
      pruned,
      gaps: flush.gaps,
      errors,
    };
    this.lastResult = result;

    if (flush.rows > 0 || rollup.rows > 0) {
      this.log.debug('历史指标已落库', {
        minuteRows: flush.rows,
        hourRows: rollup.rows,
        samples: result.samplesWritten,
        gaps: flush.gaps,
      });
    }
    if (errors.length > 0) {
      this.log.warn('指标采集存在错误（该分钟可能缺测，缺测不写 0）', { errors });
    }
    return result;
  }

  /**
   * 把**已经结束**的分钟批量落库。
   *
   * 已结束 = `bucketAt < 当前分钟起点`。当前分钟继续在内存里累加，
   * 因此"同一分钟内多次 tick"不会产生重复行，也不会写半个桶。
   */
  flushPending(now: number): FlushResult {
    const currentMinute = minuteStart(now);
    const ended = takeEnded(this.pending, currentMinute);

    // 整分钟一个样本都没有：两次 tick 之间跨过了多个分钟，或者这一分钟虽然 tick 过
    // 但一个读数都没取到（数据源整体不可用）。这些分钟**不写行**（缺测就是没有行），
    // 但必须计入 gaps 并留日志，否则"没有告警/没有曲线"到底是缺测还是真的平稳就说不清了。
    //
    // 数法：把 [上一次 tick 所在分钟, 当前分钟) 之间的分钟数与其中**真的有累加器**的
    // 分钟数相减 —— 这样"tick 过但零样本"的那一分钟也会被算成缺口（它同样没有行）。
    let missingMinutes = 0;
    if (this.lastTickBucketAt !== null && currentMinute > this.lastTickBucketAt) {
      const bridged = Math.round((currentMinute - this.lastTickBucketAt) / MINUTE_SECONDS);
      const populated = new Set<number>();
      for (const accumulator of ended) populated.add(accumulator.bucketAt);
      for (const accumulator of this.pending.values()) populated.add(accumulator.bucketAt);
      let observed = 0;
      for (const bucketAt of populated) {
        if (bucketAt >= this.lastTickBucketAt && bucketAt < currentMinute) observed += 1;
      }
      missingMinutes = Math.max(0, bridged - observed);
    }
    this.lastTickBucketAt = currentMinute;

    if (missingMinutes > 0) {
      this.log.warn('采样存在整分钟缺口（该段不写行，不补 0）', { missingMinutes, at: currentMinute });
    }

    if (ended.length === 0) {
      return { rows: 0, partial: 0, samples: 0, gaps: missingMinutes, missingMinutes };
    }

    const expected = this.expectedPerMinuteBucket();
    const createdAt = new Date(now * 1000).toISOString();
    const rows = ended.map((accumulator) => accumulatorToRow(accumulator, 'minute', expected, createdAt));
    this.repo.writeBuckets(rows);

    const partial = rows.filter((row) => isPartial(row.samples, row.expected)).length;
    const samples = rows.reduce((total, row) => total + row.samples, 0);
    return { rows: rows.length, partial, samples, gaps: partial + missingMinutes, missingMinutes };
  }

  /**
   * 整点滚动：把"已完整结束、minute 行存在但 hour 行缺失"的整点补成 hour 行。
   *
   * 每小时最多做一次（`lastRollupHourAt` 守卫）；构造后的第一次调用必然执行，
   * 于是**重启后停机期间的整点会被补齐**（前提是 minute 行还在保留窗口内）。
   */
  rollupHours(now: number): RollupResult {
    const currentHour = hourStart(now);
    if (this.lastRollupHourAt !== null && this.lastRollupHourAt >= currentHour) {
      return { rows: 0, partial: 0, samples: 0 };
    }
    this.lastRollupHourAt = currentHour;

    const lookbackHours = this.rollupLookbackHours();
    const from = currentHour - lookbackHours * HOUR_SECONDS;
    const aggregates = this.repo.rollupMissingHours(from, currentHour);
    if (aggregates.length === 0) return { rows: 0, partial: 0, samples: 0 };

    const createdAt = new Date(now * 1000).toISOString();
    const rows = aggregates.map((aggregate) => hourAggregateToRow(aggregate, createdAt));
    this.repo.writeBuckets(rows);

    this.log.debug('整点桶已从分钟行聚合补齐', {
      hours: rows.length,
      from: bucketAtToIso(from),
      to: bucketAtToIso(currentHour),
    });
    return {
      rows: rows.length,
      partial: rows.filter((row) => isPartial(row.samples, row.expected)).length,
      samples: rows.reduce((total, row) => total + row.samples, 0),
    };
  }

  /**
   * 保留清理：删掉两个分辨率各自的过期行。
   *
   * @returns 删除行数（只 DELETE，不做 VACUUM；空闲页留给后续写入复用）
   */
  prune(now: number): number {
    const config = this.deps.config.metrics;
    const minuteCutoff = minuteStart(now) - config.minuteRetentionHours * HOUR_SECONDS;
    const hourCutoff = hourStart(now) - config.hourRetentionDays * 24 * HOUR_SECONDS;
    const removed = this.repo.deleteExpired(minuteCutoff, hourCutoff);
    if (removed > 0) {
      this.log.info('历史指标已按保留策略清理', { removed, minuteCutoff, hourCutoff });
    }
    return removed;
  }

  /* ---------------------------------------------------------------- *
   * 查询与视图
   * ---------------------------------------------------------------- */

  /** 最近一次 tick 的摘要（供 `/api/metrics/storage` 透出）。 */
  lastTick(): MetricsTickResult | null {
    return this.lastResult;
  }

  /**
   * 目录里的可用 target：库中出现过的 + 本进程刚采到但还没落库的，
   * **再按"当前可见性"过滤**（见 `visibleServiceRefs`）。
   *
   * 过滤只可能**减少**条目：宿主/磁盘 target 恒在（它们不属于任何服务）。
   * 因此"藏掉一个服务后再看目录"是安全的默认方向：看不到就是看不到，
   * 不会因为多一次可见性读取而多出条目。
   */
  async availableTargets(): Promise<MetricTargetView[]> {
    const since = hourStart(this.clock()) - 30 * 24 * HOUR_SECONDS;
    const merged = new Map<string, MetricTargetView>();
    for (const row of this.repo.listTargets(since)) {
      merged.set(`${row.metric}|${row.target}`, {
        metric: row.metric,
        target: row.target,
        targetLabel: row.targetLabel,
        unit: row.unit,
        lastSeenAt: bucketAtToIso(row.lastSeenAt),
      });
    }
    for (const [key, live] of this.liveTargets) {
      if (!merged.has(key)) merged.set(key, live);
    }

    // 只有真的存在"服务类 target"时才去问注册表：纯宿主/磁盘的目录（例如没有
    // Docker 的环境）完全不触碰服务层，行为与改动前逐字节一致。
    const candidates = [...merged.values()];
    const needsVisibility = candidates.some((target) => !this.isHostOwnedTarget(target.metric));
    const visible = needsVisibility ? await this.visibleServiceRefs() : null;

    return candidates
      .filter((target) => this.targetVisible(target.metric, target.target, visible))
      .sort((left, right) => {
        if (left.metric !== right.metric) return left.metric < right.metric ? -1 : 1;
        return left.target < right.target ? -1 : left.target > right.target ? 1 : 0;
      });
  }

  /**
   * 校验并解析 target：形态必须匹配、**确实出现过**（库里有行或本进程刚采到），
   * 且对服务/容器类 target 还必须是**当前可见**的。
   *
   * 这是 `GET /api/metrics/history` 的唯一校验闸门：不可见与"从未出现过"
   * 在这里是**同一个返回值 null**，API 层因此产出一模一样的 400
   * （`VALIDATION_FAILED` + `targetPattern`）—— 调用者无法从响应里区分
   * "这个服务存在但你无权看" 与 "这个 target 从来没采过"。
   *
   * @returns 展示标签；未知/不可见 target 返回 null（API 层据此返回 400）
   */
  async resolveTarget(metric: MetricDefinition, target: string): Promise<string | null> {
    if (!matchesTargetPattern(metric, target)) return null;
    if (target === HOST_TARGET) return HOST_TARGET_LABEL;
    // 宿主/磁盘 target 到此直接查标签：它们的响应与可见性无关，保持原样。
    // 服务/容器 target 必须先过当前可见性——**在做任何存在性查找之前**，
    // 否则"库里曾经有过"本身就是存在性证据。
    if (!this.isHostOwnedTarget(metric.key)) {
      const visible = await this.visibleServiceRefs();
      if (!this.targetVisible(metric.key, target, visible)) return null;
    }
    const live = this.liveTargets.get(`${metric.key}|${target}`);
    if (live) return live.targetLabel;
    return this.repo.findLatestTargetLabel(metric.key, target);
  }

  /** 历史曲线（一次 SELECT + 纯函数组装）。 */
  history(input: {
    metric: MetricDefinition;
    target: string;
    targetLabel: string;
    range: MetricRange;
  }): MetricHistoryView {
    const now = this.clock();
    const resolution = resolutionForRange(input.range);
    const window = rangeWindow(input.range, now);
    const rows = this.repo.selectRange(resolution, input.metric.key, input.target, window.from, window.to);
    return buildHistoryView({
      metric: input.metric,
      target: input.target,
      targetLabel: input.targetLabel,
      range: input.range,
      now,
      rows,
      intervalSec: this.intervalSec(),
      source: this.lastSources[input.metric.key],
    });
  }

  /** 目录（含可用 target、range 表、采样状态与调度状态）。target 已按当前可见性过滤。 */
  async catalog(scheduler: MetricSchedulerView | null = null): Promise<MetricCatalogView> {
    const targets = await this.availableTargets();
    const intervalSec = this.intervalSec();
    const limit = this.deps.config.metrics.containerLimit;
    return {
      metrics: METRIC_CATALOG.map((metric) => ({
        ...metric,
        availableTargets: targets.filter((target) => target.metric === metric.key).length,
      })),
      targets,
      ranges: [...METRIC_RANGES],
      sampling: {
        intervalSec,
        expectedPerMinuteBucket: expectedSamples(intervalSec, 'minute'),
        containerLimit: limit,
        containerNote:
          limit > 0
            ? `只采关键容器：运行中的优先，按稳定身份排序取前 ${limit} 个；超出上限的容器不采（历史库大小由此封顶）`
            : '当前容器上限为 0：完全不采容器指标（宿主与磁盘指标不受影响）',
        aggregate: 'mean',
        note: samplingNote(intervalSec, 'minute'),
      },
      scheduler,
    };
  }

  /** 存储视图：行数、文件占用、时间范围、保留配置与预算（§1.1）。 */
  storage(): MetricStorageView {
    const now = this.clock();
    const config = this.deps.config.metrics;
    const rows = this.repo.countRows();
    const size = this.repo.storageStats();
    const bounds = this.repo.timeBounds();
    const observedSeries = this.repo.seriesPerMinuteSince(minuteStart(now) - HOUR_SECONDS);

    return {
      generatedAt: new Date(now * 1000).toISOString(),
      rows,
      size: {
        pageCount: size.pageCount,
        pageSize: size.pageSize,
        freelistCount: size.freelistCount,
        bytes: size.bytes,
        megabytes: Math.round((size.bytes / (1024 * 1024)) * 100) / 100,
      },
      bounds: {
        minute: {
          oldestAt: bounds.minute.oldestAt === null ? null : bucketAtToIso(bounds.minute.oldestAt),
          newestAt: bounds.minute.newestAt === null ? null : bucketAtToIso(bounds.minute.newestAt),
        },
        hour: {
          oldestAt: bounds.hour.oldestAt === null ? null : bucketAtToIso(bounds.hour.oldestAt),
          newestAt: bounds.hour.newestAt === null ? null : bucketAtToIso(bounds.hour.newestAt),
        },
      },
      retention: {
        minuteHours: config.minuteRetentionHours,
        hourDays: config.hourRetentionDays,
        minuteCutoffAt: bucketAtToIso(minuteStart(now) - config.minuteRetentionHours * HOUR_SECONDS),
        hourCutoffAt: bucketAtToIso(hourStart(now) - config.hourRetentionDays * 24 * HOUR_SECONDS),
      },
      budget: estimateBudget({
        minuteRetentionHours: config.minuteRetentionHours,
        hourRetentionDays: config.hourRetentionDays,
        observedSeriesPerMinute: observedSeries,
      }),
      lastTick: this.lastResult,
    };
  }

  /* ---------------------------------------------------------------- *
   * 内部
   * ---------------------------------------------------------------- */

  /**
   * 采集并把样本累加进当前分钟的累加器（**不写库**）。
   *
   * 三个数据源各自 try/catch：任一数据源失败只让**它自己的**指标缺测，
   * 不影响其它指标 —— 采集失败在落库时就表现为"那一分钟没有样本"（gap），不是 0。
   */
  private async collect(now: number, bucketAt: number, errors: string[]): Promise<number> {
    const samples: MetricSample[] = [];
    const sources: Record<string, MetricSourceStatus> = {};
    const containerLimit = this.deps.config.metrics.containerLimit;

    // 宿主 / 磁盘：SystemProvider.snapshot()（SSE 本来就在用同一个数据源）
    try {
      const snapshot = await this.deps.system.snapshot();
      samples.push(...collectHostSamples(snapshot));
      sources['host.cpu.percent'] = snapshot.sources.cpu;
      sources['host.memory.percent'] = snapshot.sources.memory;
      sources['host.memory.used_bytes'] = snapshot.sources.memory;
      sources['host.disk.percent'] = snapshot.sources.disk;
      sources['host.disk.used_bytes'] = snapshot.sources.disk;
    } catch (error) {
      errors.push(`宿主指标采集失败：${errorMessage(error)}`);
    }

    // 容器：containers.list() 自带 TTL 缓存，因此不新增 docker API 调用频率
    if (containerLimit > 0) {
      try {
        const listed = await this.deps.containers.list({ all: true, stats: true }, this.hostRequest);
        samples.push(...collectContainerSamples(listed, containerLimit));
        const source = containerSource(listed);
        sources['container.cpu.percent'] = source;
        sources['container.memory.used_bytes'] = source;
      } catch (error) {
        errors.push(`容器指标采集失败：${errorMessage(error)}`);
      }
    }

    // 服务健康：用本 tick 刚更新的判定（调度器保证 health.tick() 在本步之前）；
    // role: 'viewer' → hidden 服务不进样本，历史接口因此不会泄露隐藏服务名
    try {
      const listed = await this.deps.registry.list(this.hostRequest, {}, 'viewer');
      samples.push(
        ...collectServiceSamples(listed, (sourceRef: string) => this.verdictOf(sourceRef)),
      );
      sources['service.health.up_ratio'] = { available: true, mode: 'health-monitor', detail: null };
    } catch (error) {
      errors.push(`服务健康指标采集失败：${errorMessage(error)}`);
    }

    for (const sample of samples) {
      addSample(this.pending, sample, bucketAt);
      this.liveTargets.set(`${sample.metric}|${sample.target}`, {
        metric: sample.metric,
        target: sample.target,
        targetLabel: sample.targetLabel,
        unit: sample.unit,
        lastSeenAt: null,
      });
    }
    Object.assign(this.lastSources, sources);

    if (samples.length === 0 && errors.length === 0) {
      // 数据源都成功但一个可用读数都没有：这是"缺测"，不是"全是 0"
      this.log.warn('本次采样没有拿到任何可用读数（该分钟将没有样本，不写 0）', { at: now });
    }
    return samples.length;
  }

  /** 健康判定：unknown 表示"不计样本"。 */
  private verdictOf(sourceRef: string): MetricServiceVerdict {
    try {
      return this.deps.health.state(sourceRef)?.verdict ?? 'unknown';
    } catch (error) {
      this.log.debug('读取健康判定失败，按 unknown 处理（不计样本）', {
        sourceRef,
        error: errorMessage(error),
      });
      return 'unknown';
    }
  }

  /* ---------------------------------------------------------------- *
   * 读路径的可见性（S2 修复：hidden 服务不得经历史接口泄漏）
   * ---------------------------------------------------------------- */

  /**
   * 读路径的"当前 viewer 可见服务"集合。
   *
   * ## 为什么读路径必须自己再判一次
   *
   * 采集侧固定 `role: 'viewer'` 只保证"隐藏之后不再产生新样本"。但**隐藏之前**
   * 已经写进 `metric_buckets` 的历史行与进程内 `liveTargets` 仍然带着服务名 ——
   * 只靠采集视角，被隐藏的服务会被 catalog 继续列出、被 history 继续查到，
   * 直到历史数据过期。这正是"读接口绕过当前可见性"的泄漏面。
   *
   * ## 实现已经抽到共享模块
   *
   * 具体的"怎么读、读失败怎么办、要不要缓存"全在 `modules/visibility/serviceVisibility.ts`
   * —— 那里是同一份口径的唯一实现，告警读路径（`/api/alerts/*`）调用的是**同一个函数**。
   * 本方法只负责把采样器自己的依赖（注册表 + 后台宿主上下文 + 日志）喂进去。
   *
   * @returns 可见服务的 `sourceRef` 集合；注册表读失败时返回 `null`
   *   （调用方按 **fail-closed** 处理：服务/容器类 target 一律视为不可见）。
   *   宿主与磁盘指标不经过这个判定，因此注册表抖动不会影响它们。
   */
  private async visibleServiceRefs(): Promise<ReadonlySet<string> | null> {
    return loadVisibleServiceRefs({
      registry: this.deps.registry,
      request: this.hostRequest,
      source: 'metrics.read',
      logger: this.log,
    });
  }

  /**
   * 这个 metric 的 target 是否属于**宿主自身**（host / disk）。
   *
   * 宿主与磁盘不属于任何服务，可见性过滤必须原样放过它们（行为与响应保持不变）。
   * metric key 不在目录里（契约变更后的历史行）按"非宿主"处理：fail-closed。
   */
  private isHostOwnedTarget(metricKey: string): boolean {
    const metric = metricByKey(metricKey);
    if (!metric) return false;
    return metric.targetKind === 'host' || metric.targetKind === 'disk';
  }

  /**
   * 一个 target 是否允许出现在读响应里。
   *
   * 服务/容器 target 里带的就是服务的稳定身份：`service:<sourceRef>` 与
   * `container:<sourceRef>`（`containerServiceRef` 与服务的 `sourceRef` 同源），
   * 因此必须命中**当前**可见集合；集合为 `null`（注册表不可用）时一律拒绝。
   * "取身份 + 判可见"这段与告警共用 `serviceVisibility` 里的同一对函数。
   */
  private targetVisible(metricKey: string, target: string, visible: ReadonlySet<string> | null): boolean {
    if (this.isHostOwnedTarget(metricKey)) return true;
    const metric = metricByKey(metricKey);
    if (!metric) return false;
    const kind: ServiceTargetKind = metric.targetKind === 'container' ? 'container' : 'service';
    return isServiceTargetVisible(target, visible, kind);
  }

  /** 当前采样间隔（秒）；非法值回退到 60，避免 expected 变成 NaN。 */
  private intervalSec(): number {
    const raw = this.deps.intervalSec?.() ?? this.deps.config.metrics.sampleIntervalSec;
    if (!Number.isFinite(raw) || raw <= 0) return 60;
    return raw;
  }

  /** minute 桶的期望样本数。 */
  private expectedPerMinuteBucket(): number {
    return expectedSamples(this.intervalSec(), 'minute');
  }

  /**
   * 整点滚动的回溯窗口。
   *
   * 只可能补出"minute 行还在"的整点，所以回溯窗口取 minute 保留窗口即可；
   * 至少 2 小时，保证小时级的短暂停机也能被补上。
   */
  private rollupLookbackHours(): number {
    const hours = this.deps.config.metrics.minuteRetentionHours;
    if (!Number.isFinite(hours) || hours <= 0) return 2;
    return Math.max(2, Math.ceil(hours));
  }

  /** 保留清理：启动后第一次调用必做，之后每个整点一次。 */
  private pruneIfDue(now: number): number {
    const currentHour = hourStart(now);
    if (this.lastPruneHourAt !== null && this.lastPruneHourAt >= currentHour) return 0;
    this.lastPruneHourAt = currentHour;
    return this.prune(now);
  }
}