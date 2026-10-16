/**
 * `metric_buckets` 仓储 + **桶聚合纯函数**（S2-01 的落库侧）。
 *
 * 本文件是"Sprint 2 历史数据"的唯一写入点。分层：
 * - 纯函数（对齐、累加、聚合、缺口判定）：不碰 DB，可单测、可用注入时钟；
 * - `MetricBucketsRepository`：只做 SQL 与事务，不含任何业务判断。
 *
 * ## 为什么是"内存累积 + 分钟落库"（而不是每 tick 写库）
 *
 * 采样 tick 默认 30s 一次，若每 tick 写一次库，一小时就是 120 次写事务。
 * 而历史曲线的最小分辨率就是**一分钟**：同一条序列在同一分钟里的所有样本
 * 最终只会变成一行。所以在内存里按 `metric|target` 累加
 * （`sum/count/min/max`），只在**分钟结束时**批量写一次 —— 每小时的写事务数与
 * tick 数无关（见 `metricsSampler.test.ts` 的"库写次数与 tick 数不成正比"用例）。
 *
 * 为什么不是"攒一小时再写"：那样进程在小时内重启就会丢掉最多 59 分钟的样本。
 * 分钟粒度把损失上界压到"当前这一分钟"，代价只是每分钟一次极小的写事务。
 *
 * ## 为什么整桶无样本**不写行**（而不是写 0）
 *
 * 0 是一个**合法的读数**（宿主 CPU 真的可能是 0%）。用 0 表示"没有样本"，
 * 事后没有任何办法把它们区分开：图表会画出一条平线，告警会以为指标正常，
 *  Retention 统计也会把缺测算成数据。因此缺测的表达方式是"没有行"，
 * 前端按时间间隔断开；桶内**部分**缺测则由 `samples < expected` 表达。
 */
import { randomUUID } from 'node:crypto';
import type { Db } from '../../db/database.js';
import { StatementCache } from '../../db/database.js';
import { round } from '../../util/format.js';
import type {
  BucketWriteResult,
  MetricResolution,
  MetricSample,
  MetricUnit,
} from './types.js';

/** 一分钟的秒数。 */
export const MINUTE_SECONDS = 60;
/** 一小时的秒数。 */
export const HOUR_SECONDS = 3600;
/**
 * hour 桶的期望样本数 = 一小时内的 minute 行数。
 *
 * 固定 60：hour 桶的 `samples` 语义是"这一小时里**存在多少个 minute 桶**"，
 * 与采样间隔无关（采样间隔只影响 minute 桶的 expected）。
 */
export const HOUR_EXPECTED_MINUTE_ROWS = 60;

/* ------------------------------------------------------------------ *
 * 纯函数：对齐 / 期望样本数 / 累加
 * ------------------------------------------------------------------ */

/** 桶起点：`floor(now / 60) * 60`。 */
export function minuteStart(unixSeconds: number): number {
  return Math.floor(unixSeconds / MINUTE_SECONDS) * MINUTE_SECONDS;
}

/** 桶起点：`floor(now / 3600) * 3600`。 */
export function hourStart(unixSeconds: number): number {
  return Math.floor(unixSeconds / HOUR_SECONDS) * HOUR_SECONDS;
}

/** 按分辨率对齐到桶起点。 */
export function alignTo(unixSeconds: number, resolution: MetricResolution): number {
  return resolution === 'minute' ? minuteStart(unixSeconds) : hourStart(unixSeconds);
}

/**
 * 一个桶应有几个样本。
 *
 * - minute：`max(1, round(60 / intervalSec))` —— 采集间隔比一分钟还长时仍然算 1，
 *   否则 `expected = 0` 会让每个桶都"不 partial"，缺测就再也看不见了；
 * - hour：`60`（= 一小时内应有的 minute 行数）。
 */
export function expectedSamples(intervalSec: number, resolution: MetricResolution): number {
  if (resolution === 'hour') return HOUR_EXPECTED_MINUTE_ROWS;
  const safe = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : 60;
  return Math.max(1, Math.round(MINUTE_SECONDS / safe));
}

/** 部分缺测：有行，但样本数不足。 */
export function isPartial(samples: number, expected: number): boolean {
  return samples < expected;
}

/** 累加器：一个 (bucketAt, metric, target) 的 sum/count/min/max。 */
export interface BucketAccumulator {
  metric: string;
  target: string;
  targetLabel: string;
  unit: MetricUnit;
  bucketAt: number;
  sum: number;
  count: number;
  min: number;
  max: number;
  /**
   * 本桶里见过的**最大副本数**（宿主/磁盘/服务恒为 1）。
   *
   * 多副本按服务合并后，一次 tick 对同一 target 会有 N 个读数，
   * 所以 `expected` 必须是 `base × replicas`，否则"掉一个副本"永远显示为正常。
   * 取最大值（而不是累加）是因为它描述的是"每 tick 几个读数"，
   * 与桶里累计了多少个 tick 无关。
   */
  replicas: number;
}

/** 累加器的键：桶 + 序列。桶在前，便于按桶前缀扫。 */
export function accumulatorKey(bucketAt: number, metric: string, target: string): string {
  return `${bucketAt}|${metric}|${target}`;
}

/**
 * 把一个样本折进累加器集合（不存在则新建）。
 *
 * @returns 受影响的累加器
 */
export function addSample(
  accumulators: Map<string, BucketAccumulator>,
  sample: MetricSample,
  bucketAt: number,
): BucketAccumulator {
  const key = accumulatorKey(bucketAt, sample.metric, sample.target);
  const existing = accumulators.get(key);
  const replicas = Math.max(1, sample.replicaCount ?? 1);
  if (existing) {
    existing.sum += sample.value;
    existing.count += 1;
    if (sample.value < existing.min) existing.min = sample.value;
    if (sample.value > existing.max) existing.max = sample.value;
    if (replicas > existing.replicas) existing.replicas = replicas;
    // 标签随桶更新：服务改名/容器重建后，最新一桶反映当前展示名。
    // 多副本的标签由 collector 统一成"合并口径的名字"，因此这里不会随返回顺序抖动。
    existing.targetLabel = sample.targetLabel;
    return existing;
  }
  const created: BucketAccumulator = {
    metric: sample.metric,
    target: sample.target,
    targetLabel: sample.targetLabel,
    unit: sample.unit,
    bucketAt,
    sum: sample.value,
    count: 1,
    min: sample.value,
    max: sample.value,
    replicas,
  };
  accumulators.set(key, created);
  return created;
}

/**
 * 取出并移除所有**已经结束**的桶（`bucketAt < before`）。
 *
 * 副作用只发生在传入的 Map 上；返回的顺序按 `bucketAt` 再按 `metric|target`
 * 稳定排序 —— 让写入顺序可预测，测试才能断言具体行。
 */
export function takeEnded(
  accumulators: Map<string, BucketAccumulator>,
  before: number,
): BucketAccumulator[] {
  const ended: BucketAccumulator[] = [];
  for (const [key, accumulator] of accumulators) {
    if (accumulator.bucketAt < before) {
      ended.push(accumulator);
      accumulators.delete(key);
    }
  }
  ended.sort((a, b) => {
    if (a.bucketAt !== b.bucketAt) return a.bucketAt - b.bucketAt;
    const left = `${a.metric}|${a.target}`;
    const right = `${b.metric}|${b.target}`;
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return ended;
}

/** 待写入的一行（列名与表结构一一对应）。 */
export interface BucketWriteInput {
  id: string;
  resolution: MetricResolution;
  metric: string;
  target: string;
  targetLabel: string;
  unit: MetricUnit;
  bucketAt: number;
  value: number;
  minValue: number;
  maxValue: number;
  samples: number;
  expected: number;
  createdAt: string;
}

/**
 * 把累加器转成待写入行（`value` = 桶内均值，保留 3 位小数）。
 *
 * @param baseExpected 单个目标的期望读数数（= 每 tick 一个 × 每分钟 tick 数）；
 *   真正的 `expected` 会再乘以桶内最大副本数 —— 多副本合并时一次 tick 有 N 个读数，
 *   不乘就会让"掉了一个副本"永远显示为正常。
 */
export function accumulatorToRow(
  accumulator: BucketAccumulator,
  resolution: MetricResolution,
  baseExpected: number,
  createdAt: string,
): BucketWriteInput {
  const mean = accumulator.count > 0 ? accumulator.sum / accumulator.count : 0;
  const expected = baseExpected * Math.max(1, accumulator.replicas);
  return {
    id: randomUUID(),
    resolution,
    metric: accumulator.metric,
    target: accumulator.target,
    targetLabel: accumulator.targetLabel,
    unit: accumulator.unit,
    bucketAt: accumulator.bucketAt,
    value: round(mean, 3) ?? mean,
    minValue: round(accumulator.min, 3) ?? accumulator.min,
    maxValue: round(accumulator.max, 3) ?? accumulator.max,
    samples: accumulator.count,
    expected,
    createdAt,
  };
}

/* ------------------------------------------------------------------ *
 * 纯函数：hour 从 minute 行聚合
 * ------------------------------------------------------------------ */

/** `SELECT … GROUP BY` 出来的一个整点聚合（还没落库）。 */
export interface HourAggregate {
  hourAt: number;
  metric: string;
  target: string;
  targetLabel: string;
  unit: MetricUnit;
  /** 该整点内**存在**的 minute 行数（= hour 桶的 samples） */
  minuteRows: number;
  /** 该整点内全部原始样本数（= minute 行 samples 之和），用于加权平均 */
  totalSamples: number;
  /** Σ(value × samples)：加权平均的分子 */
  weightedSum: number;
  minValue: number;
  maxValue: number;
}

/**
 * minute 行 → hour 行的加权平均。
 *
 * 为什么按 `samples` 加权而不是对 minute 均值再取平均：如果某分钟只有 1 个样本
 * 而另一分钟有 2 个，直接平均会让"样本少的那一分钟"权重过大，
 * 得到的不是"这一小时全部样本的均值"。规格 §2.1 要求的就是后者。
 */
export function hourValue(aggregate: HourAggregate): number {
  if (aggregate.totalSamples <= 0) return 0;
  return aggregate.weightedSum / aggregate.totalSamples;
}

/** 把整点聚合转成待写入的 hour 行（`expected = 60`，`samples` = minute 行数）。 */
export function hourAggregateToRow(aggregate: HourAggregate, createdAt: string): BucketWriteInput {
  const value = hourValue(aggregate);
  return {
    id: randomUUID(),
    resolution: 'hour',
    metric: aggregate.metric,
    target: aggregate.target,
    targetLabel: aggregate.targetLabel,
    unit: aggregate.unit,
    bucketAt: aggregate.hourAt,
    value: round(value, 3) ?? value,
    minValue: round(aggregate.minValue, 3) ?? aggregate.minValue,
    maxValue: round(aggregate.maxValue, 3) ?? aggregate.maxValue,
    samples: aggregate.minuteRows,
    expected: HOUR_EXPECTED_MINUTE_ROWS,
    createdAt,
  };
}

/* ------------------------------------------------------------------ *
 * 仓储（唯一写入点）
 * ------------------------------------------------------------------ */

/** 读出来的一行（供 history 组装视图）。 */
export interface MetricBucketRow {
  id: string;
  resolution: MetricResolution;
  metric: string;
  target: string;
  targetLabel: string;
  unit: MetricUnit;
  bucketAt: number;
  value: number;
  minValue: number;
  maxValue: number;
  samples: number;
  expected: number;
  createdAt: string;
}

const UPSERT_SQL = `
INSERT INTO metric_buckets (
  id, resolution, metric, target, target_label, unit, bucket_at,
  value, min_value, max_value, samples, expected, created_at
) VALUES (
  @id, @resolution, @metric, @target, @targetLabel, @unit, @bucketAt,
  @value, @minValue, @maxValue, @samples, @expected, @createdAt
)
ON CONFLICT(resolution, metric, target, bucket_at) DO UPDATE SET
  value        = excluded.value,
  min_value    = excluded.min_value,
  max_value    = excluded.max_value,
  samples      = excluded.samples,
  expected     = excluded.expected,
  target_label = excluded.target_label,
  unit         = excluded.unit,
  created_at   = excluded.created_at
`;

const SELECT_COLUMNS = `
  id, resolution, metric, target,
  target_label AS targetLabel, unit,
  bucket_at AS bucketAt, value,
  min_value AS minValue, max_value AS maxValue,
  samples, expected, created_at AS createdAt
`;

export class MetricBucketsRepository {
  private readonly statements: StatementCache;
  private readonly upsertMany: (rows: readonly BucketWriteInput[]) => void;

  constructor(private readonly db: Db) {
    this.statements = new StatementCache(db);
    // 批量写 = **一次事务**里跑 N 条 upsert。把事务缓存下来，
    // 避免每次调用都重新编译（better-sqlite3 的 transaction() 有编译开销）。
    this.upsertMany = db.transaction((rows: readonly BucketWriteInput[]) => {
      const statement = this.statements.get(UPSERT_SQL);
      for (const row of rows) statement.run(row);
    });
    this.deleteExpiredTx = db.transaction((minuteCutoff: number, hourCutoff: number) => {
      const statement = this.statements.get(
        'DELETE FROM metric_buckets WHERE resolution = ? AND bucket_at < ?',
      );
      const minutes = statement.run('minute', minuteCutoff).changes;
      const hours = statement.run('hour', hourCutoff).changes;
      return minutes + hours;
    });
  }

  /**
   * 批量写入（幂等：同桶重写覆盖而非插入新行）。
   *
   * @returns 写入的行数
   */
  writeBuckets(rows: readonly BucketWriteInput[]): number {
    if (rows.length === 0) return 0;
    this.upsertMany(rows);
    return rows.length;
  }

  /** 一条序列在窗口内的桶，按时间升序。命中 `idx_metric_buckets_series`。 */
  selectRange(
    resolution: MetricResolution,
    metric: string,
    target: string,
    from: number,
    to: number,
  ): MetricBucketRow[] {
    return this.statements
      .get(
        `SELECT ${SELECT_COLUMNS} FROM metric_buckets
         WHERE resolution = ? AND metric = ? AND target = ? AND bucket_at >= ? AND bucket_at <= ?
         ORDER BY bucket_at ASC`,
      )
      .all(resolution, metric, target, from, to) as MetricBucketRow[];
  }

  /**
   * 已完整结束、minute 行存在但 **hour 行缺失**的整点聚合。
   *
   * 为什么从 DB 聚合而不是在内存里累积：进程重启后内存没了，但 minute 行还在，
   * 于是停机期间的整点能被补齐；反过来，**没有 minute 行的整点不会凭空造出 hour 行**
   * （那就是缺测，按约定不写行）。
   *
   * @param from 窗口起点（unix 秒，含）
   * @param toExclusive 窗口终点（unix 秒，不含；调用方保证它落在整点边界上，
   *   即只有**已经结束**的小时会被聚合）
   */
  rollupMissingHours(from: number, toExclusive: number): HourAggregate[] {
    const aggregates = this.statements
      .get(
        `SELECT
           (bucket_at / 3600) * 3600              AS hourAt,
           metric,
           target,
           target_label                           AS targetLabel,
           unit,
           COUNT(*)                               AS minuteRows,
           SUM(samples)                           AS totalSamples,
           SUM(value * samples)                   AS weightedSum,
           MIN(min_value)                         AS minValue,
           MAX(max_value)                         AS maxValue
         FROM metric_buckets
         WHERE resolution = 'minute' AND bucket_at >= ? AND bucket_at < ?
         GROUP BY hourAt, metric, target
         ORDER BY hourAt ASC, metric ASC, target ASC`,
      )
      .all(from, toExclusive) as HourAggregate[];

    if (aggregates.length === 0) return [];

    const existing = new Set(
      (this.statements
        .get(
          `SELECT bucket_at AS bucketAt, metric, target FROM metric_buckets
           WHERE resolution = 'hour' AND bucket_at >= ? AND bucket_at < ?`,
        )
        .all(from, toExclusive) as Array<{ bucketAt: number; metric: string; target: string }>).map(
        (row) => `${row.bucketAt}|${row.metric}|${row.target}`,
      ),
    );

    return aggregates.filter(
      (aggregate) => !existing.has(`${aggregate.hourAt}|${aggregate.metric}|${aggregate.target}`),
    );
  }

  /**
   * 删除某个分辨率的过期行。
   *
   * @param cutoff 早于该时刻（unix 秒，不含）的行被删除
   * @returns 删除行数（只 DELETE，不做 VACUUM —— 空闲页留给后续写入复用）
   */
  deleteOlderThan(resolution: MetricResolution, cutoff: number): number {
    const result = this.statements
      .get('DELETE FROM metric_buckets WHERE resolution = ? AND bucket_at < ?')
      .run(resolution, cutoff);
    return result.changes;
  }

  /**
   * 一次事务里清掉两个分辨率的过期行。
   *
   * 保留清理是**一次性动作**（启动 + 每个整点）：要么两个分辨率都清完，
   * 要么都不清 —— 半个清理状态会让"行数为什么不对"变得难以复现。
   *
   * @returns 删除行数合计
   */
  deleteExpired(minuteCutoff: number, hourCutoff: number): number {
    return this.deleteExpiredTx(minuteCutoff, hourCutoff);
  }

  private readonly deleteExpiredTx: (minuteCutoff: number, hourCutoff: number) => number;

  /** 两个分辨率的行数。 */
  countRows(): { minute: number; hour: number; total: number } {
    const rows = this.statements
      .get('SELECT resolution, COUNT(*) AS n FROM metric_buckets GROUP BY resolution')
      .all() as Array<{ resolution: MetricResolution; n: number }>;
    const minute = rows.find((row) => row.resolution === 'minute')?.n ?? 0;
    const hour = rows.find((row) => row.resolution === 'hour')?.n ?? 0;
    return { minute, hour, total: minute + hour };
  }

  /** SQLite 文件占用（页计数 × 页大小），用于"库大小符合预算"的验收。 */
  storageStats(): { pageCount: number; pageSize: number; freelistCount: number; bytes: number } {
    const pageCount = Number(this.db.pragma('page_count', { simple: true }) ?? 0);
    const pageSize = Number(this.db.pragma('page_size', { simple: true }) ?? 0);
    const freelistCount = Number(this.db.pragma('freelist_count', { simple: true }) ?? 0);
    return { pageCount, pageSize, freelistCount, bytes: pageCount * pageSize };
  }

  /** 每个分辨率最老/最新的桶时刻（unix 秒）。 */
  timeBounds(): {
    minute: { oldestAt: number | null; newestAt: number | null };
    hour: { oldestAt: number | null; newestAt: number | null };
  } {
    const rows = this.statements
      .get(
        `SELECT resolution, MIN(bucket_at) AS oldestAt, MAX(bucket_at) AS newestAt
         FROM metric_buckets GROUP BY resolution`,
      )
      .all() as Array<{
      resolution: MetricResolution;
      oldestAt: number | null;
      newestAt: number | null;
    }>;
    const pick = (resolution: MetricResolution) => {
      const row = rows.find((item) => item.resolution === resolution);
      return { oldestAt: row?.oldestAt ?? null, newestAt: row?.newestAt ?? null };
    };
    return { minute: pick('minute'), hour: pick('hour') };
  }

  /** 最近窗口内实际出现过的序列数（用于存储预算"按实际情况修正"）。 */
  seriesPerMinuteSince(fromBucketAt: number): number {
    const row = this.statements
      .get(
        `SELECT COUNT(*) AS n FROM (
           SELECT DISTINCT metric, target FROM metric_buckets
           WHERE resolution = 'minute' AND bucket_at >= ?
         )`,
      )
      .get(fromBucketAt) as { n: number } | undefined;
    return row?.n ?? 0;
  }

  /**
   * 库中出现过的 target 清单（目录接口的"可用 target"）。
   *
   * 依赖 SQLite 的 bare-column 语义：与 `MAX(bucket_at)` 同组的裸列取自
   * 命中该最大值的行 —— 于是 `target_label`/`unit` 是该 target 最近一次的展示值。
   */
  listTargets(sinceBucketAt: number): Array<{
    metric: string;
    target: string;
    targetLabel: string;
    unit: MetricUnit;
    lastSeenAt: number;
  }> {
    return this.statements
      .get(
        `SELECT metric, target, target_label AS targetLabel, unit, MAX(bucket_at) AS lastSeenAt
         FROM metric_buckets
         WHERE bucket_at >= ?
         GROUP BY metric, target
         ORDER BY metric ASC, target ASC`,
      )
      .all(sinceBucketAt) as Array<{
      metric: string;
      target: string;
      targetLabel: string;
      unit: MetricUnit;
      lastSeenAt: number;
    }>;
  }

  /** 某个 target 最近一次的展示标签；从未出现过返回 null（= 未知 target）。 */
  findLatestTargetLabel(metric: string, target: string): string | null {
    const row = this.statements
      .get(
        `SELECT target_label AS targetLabel FROM metric_buckets
         WHERE metric = ? AND target = ?
         ORDER BY bucket_at DESC LIMIT 1`,
      )
      .get(metric, target) as { targetLabel: string } | undefined;
    return row?.targetLabel ?? null;
  }
}

/** 供 `sampler.ts` 复用的小工具：把写结果拼起来。 */
export function combineWriteResults(results: readonly BucketWriteResult[]): BucketWriteResult {
  return results.reduce<BucketWriteResult>(
    (total, item) => ({ rows: total.rows + item.rows, partial: total.partial + item.partial }),
    { rows: 0, partial: 0 },
  );
}