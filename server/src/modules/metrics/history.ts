/**
 * 历史查询的**纯函数**（range → resolution、窗口、缺口统计、summary 组装）。
 *
 * 这里没有 I/O：SELECT 由 `buckets.ts` 的仓储完成，本文件只负责
 * "把行集合解释成一张可画的曲线"。这样窗口/缺口这两件最容易算错的事
 * 可以在 `metricsHistory.test.ts` 里逐条钉住（含 `count: 0` 时**不许用 0 冒充**）。
 */
import { isPartial, expectedSamples, MINUTE_SECONDS, HOUR_SECONDS } from './buckets.js';
import type { MetricBucketRow } from './buckets.js';
import type {
  MetricDefinition,
  MetricGaps,
  MetricHistoryView,
  MetricPoint,
  MetricRange,
  MetricRangeSpec,
  MetricResolution,
  MetricSourceStatus,
  MetricSummary,
  MetricUnit,
} from './types.js';

/** 桶时刻（unix 秒）→ ISO。不用 `unixSecondsToIso`：它在 0 时返回 null，而 0 是合法时刻。 */
export function bucketAtToIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/** range 表（顺序即前端下拉顺序）。 */
export const METRIC_RANGES: readonly MetricRangeSpec[] = [
  { range: '1h', resolution: 'minute', windowSec: 3600, expectedBuckets: 60, label: '最近 1 小时' },
  { range: '24h', resolution: 'minute', windowSec: 86_400, expectedBuckets: 1440, label: '最近 24 小时' },
  { range: '7d', resolution: 'hour', windowSec: 7 * 86_400, expectedBuckets: 168, label: '最近 7 天' },
  { range: '30d', resolution: 'hour', windowSec: 30 * 86_400, expectedBuckets: 720, label: '最近 30 天' },
];

/** 是否是合法的 range 值。 */
export function isMetricRange(value: string): value is MetricRange {
  return METRIC_RANGES.some((spec) => spec.range === value);
}

/** 取 range 的规格；非法 range 抛错（调用方应先校验）。 */
export function rangeSpec(range: MetricRange): MetricRangeSpec {
  const spec = METRIC_RANGES.find((item) => item.range === range);
  if (!spec) throw new Error(`未知的 range: ${range}`);
  return spec;
}

/** range → 分辨率。1h/24h 用 minute，7d/30d 用 hour。 */
export function resolutionForRange(range: MetricRange): MetricResolution {
  return rangeSpec(range).resolution;
}

/**
 * 查询窗口（unix 秒，两端都对齐到桶起点）。
 *
 * `to` 也向下对齐：桶是左闭右开的整数区间，未结束的当前桶不该被算进
 * "应有桶数"，否则每个窗口都会永远缺一个桶。
 */
export function rangeWindow(range: MetricRange, now: number): { from: number; to: number } {
  const spec = rangeSpec(range);
  const step = spec.resolution === 'minute' ? MINUTE_SECONDS : HOUR_SECONDS;
  const to = Math.floor(now / step) * step;
  const from = to - spec.windowSec;
  return { from, to };
}

/** 窗口内应有的桶数 = `窗口长度 / 步长`（向下取整）。 */
export function expectedBucketsIn(from: number, to: number, resolution: MetricResolution): number {
  const step = resolution === 'minute' ? MINUTE_SECONDS : HOUR_SECONDS;
  if (to <= from) return 0;
  return Math.floor((to - from) / step);
}

/** 采样方式说明（前端必须展示的四项之一）。 */
export function samplingNote(intervalSec: number, resolution: MetricResolution): string {
  if (resolution === 'minute') {
    return `${intervalSec}s 采样 → 每分钟 1 条；缺测处断开，不补 0`;
  }
  return `由 60 条分钟聚合而来（每整点 1 条，缺分钟即 partial）；缺测处断开，不补 0`;
}

/** 一行 → 一个点。 */
export function bucketToPoint(row: MetricBucketRow): MetricPoint {
  return {
    at: bucketAtToIso(row.bucketAt),
    value: row.value,
    min: row.minValue,
    max: row.maxValue,
    samples: row.samples,
    expected: row.expected,
    partial: isPartial(row.samples, row.expected),
  };
}

/**
 * 缺口统计。
 *
 * - `missingBuckets` = 应有桶数 − 实际行数（**没有行**就是缺测，不是 0）；
 * - `partialBuckets` = 实际行里 `samples < expected` 的数量（桶存在但不完整）。
 */
export function countGaps(rows: readonly MetricBucketRow[], expectedBuckets: number): MetricGaps {
  const partialBuckets = rows.filter((row) => isPartial(row.samples, row.expected)).length;
  return {
    missingBuckets: Math.max(0, expectedBuckets - rows.length),
    partialBuckets,
  };
}

/**
 * summary：对**有值的桶**做 min/max/avg + 最新值。
 *
 * 窗口内一行都没有时 `count: 0`，其余字段**全为 null** —— 用 0 冒充"没有数据"
 * 会让前端画出一条贴着 0 的平线（正是本项目反复强调要避免的谎话）。
 * 空窗口时 `latestAt` 也为 null，前端据此显示空态文案。
 */
export function summarizeBuckets(rows: readonly MetricBucketRow[]): MetricSummary {
  if (rows.length === 0) {
    return { count: 0, min: null, max: null, avg: null, latest: null, latestAt: null };
  }
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;
  for (const row of rows) {
    if (row.minValue < min) min = row.minValue;
    if (row.maxValue > max) max = row.maxValue;
    sum += row.value;
  }
  // 行按 bucket_at 升序（仓储保证），因此最后一行就是最新的一桶
  const latestRow = rows[rows.length - 1]!;
  return {
    count: rows.length,
    min,
    max,
    avg: sum / rows.length,
    latest: latestRow.value,
    latestAt: bucketAtToIso(latestRow.bucketAt),
  };
}

/** 数据源未知时的占位（诚实说明"这次没采到"，而不是 available: true）。 */
export function unknownSource(reason: string): MetricSourceStatus {
  return { available: false, mode: 'none', detail: reason };
}

export interface BuildHistoryInput {
  metric: MetricDefinition;
  target: string;
  targetLabel: string;
  range: MetricRange;
  now: number;
  rows: readonly MetricBucketRow[];
  intervalSec: number;
  source: MetricSourceStatus | undefined;
}

/**
 * 组装 `GET /api/metrics/history` 的响应。
 *
 * **不做任何单位换算**：`unit` 与 `label` 原样透出，percent 的点就是百分比数值，
 * bytes 的点就是字节数。前端按 unit 选刻度。
 */
export function buildHistoryView(input: BuildHistoryInput): MetricHistoryView {
  const spec = rangeSpec(input.range);
  const window = rangeWindow(input.range, input.now);
  const expectedBuckets = expectedBucketsIn(window.from, window.to, spec.resolution);
  const points = input.rows.map(bucketToPoint);
  const expectedPerBucket = expectedSamples(input.intervalSec, spec.resolution);

  return {
    metric: input.metric.key,
    label: input.metric.label,
    unit: input.metric.unit as MetricUnit,
    target: input.target,
    targetLabel: input.targetLabel,
    range: input.range,
    resolution: spec.resolution,
    from: bucketAtToIso(window.from),
    to: bucketAtToIso(window.to),
    sampling: {
      intervalSec: input.intervalSec,
      aggregate: 'mean',
      expectedPerBucket,
      note: samplingNote(input.intervalSec, spec.resolution),
    },
    source:
      input.source ??
      unknownSource('本进程尚未采集到该指标的数据源状态（重启后需要一次采样）'),
    points,
    gaps: countGaps(input.rows, expectedBuckets),
    summary: summarizeBuckets(input.rows),
  };
}