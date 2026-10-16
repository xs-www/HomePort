/**
 * 历史查询的组装与缺口统计（规格 §10 `metricsHistory.test.ts` 那一行）。
 *
 * 这些都是**纯函数**（`history.ts`）+ 一次真实 SELECT（`buckets.ts`），
 * 因此可以逐条钉住最容易算错、也最容易被 UI 误读的四件事：
 * 1. range → resolution → 窗口 → 应有桶数；
 * 2. 缺口（missing = 应有 − 实际、partial = samples < expected）；
 * 3. **空窗口不许用 0 冒充**（`count: 0` 且其余字段为 null）；
 * 4. 百分比与字节是两套 key，API 层不做任何单位换算。
 */
import { describe, expect, it } from 'vitest';
import { initDatabase, type Db } from '../src/db/database.js';
import { createSilentLogger } from '../src/logger.js';
import {
  MetricBucketsRepository,
  type BucketWriteInput,
  type MetricBucketRow,
} from '../src/modules/metrics/buckets.js';
import {
  METRIC_RANGES,
  bucketAtToIso,
  buildHistoryView,
  countGaps,
  expectedBucketsIn,
  isMetricRange,
  rangeSpec,
  rangeWindow,
  resolutionForRange,
  samplingNote,
  summarizeBuckets,
} from '../src/modules/metrics/history.js';
import { metricByKey, type MetricDefinition, type MetricHistoryView } from '../src/modules/metrics/types.js';

const logger = createSilentLogger();
const NOW = 1_700_000_000;
const HOUR = 3600;
const DAY = 86_400;

function metric(key: string): MetricDefinition {
  const found = metricByKey(key);
  if (!found) throw new Error(`目录里没有 ${key}`);
  return found;
}

function insert(
  repo: MetricBucketsRepository,
  input: {
    resolution: 'minute' | 'hour';
    metric: string;
    target: string;
    targetLabel?: string;
    unit: 'percent' | 'bytes' | 'ratio';
    bucketAt: number;
    value: number;
    min?: number;
    max?: number;
    samples: number;
    expected?: number;
  },
): void {
  const row: BucketWriteInput = {
    id: `${input.resolution}|${input.metric}|${input.target}|${input.bucketAt}`,
    resolution: input.resolution,
    metric: input.metric,
    target: input.target,
    targetLabel: input.targetLabel ?? input.target,
    unit: input.unit,
    bucketAt: input.bucketAt,
    value: input.value,
    minValue: input.min ?? input.value,
    maxValue: input.max ?? input.value,
    samples: input.samples,
    expected: input.expected ?? (input.resolution === 'minute' ? 2 : 60),
    createdAt: new Date(NOW * 1000).toISOString(),
  };
  repo.writeBuckets([row]);
}

function history(
  repo: MetricBucketsRepository,
  key: string,
  target: string,
  range: '1h' | '24h' | '7d' | '30d',
  options: { now?: number } = {},
): MetricHistoryView {
  const definition = metric(key);
  const now = options.now ?? NOW;
  const resolution = resolutionForRange(range);
  const window = rangeWindow(range, now);
  return buildHistoryView({
    metric: definition,
    target,
    targetLabel: target === 'host' ? '宿主' : target,
    range,
    now,
    rows: repo.selectRange(resolution, key, target, window.from, window.to),
    intervalSec: 30,
    source: undefined,
  });
}

/** 造一行完整的桶（纯函数用例要的是"行的语义"，不需要真的进库）。 */
function bucketRow(input: {
  bucketAt: number;
  value: number;
  minValue?: number;
  maxValue?: number;
  samples: number;
  expected: number;
}): MetricBucketRow {
  return {
    id: `row-${input.bucketAt}`,
    resolution: 'minute',
    metric: 'host.cpu.percent',
    target: 'host',
    targetLabel: '宿主',
    unit: 'percent',
    bucketAt: input.bucketAt,
    value: input.value,
    minValue: input.minValue ?? input.value,
    maxValue: input.maxValue ?? input.value,
    samples: input.samples,
    expected: input.expected,
    createdAt: new Date(NOW * 1000).toISOString(),
  };
}

describe('range 表与窗口', () => {
  it('range → resolution / 窗口 / 应有桶数（规格 §3.2 的四行）', () => {
    expect(METRIC_RANGES.map((item) => [item.range, item.resolution, item.windowSec])).toEqual([
      ['1h', 'minute', 3600],
      ['24h', 'minute', 86_400],
      ['7d', 'hour', 7 * 86_400],
      ['30d', 'hour', 30 * 86_400],
    ]);
    expect(resolutionForRange('1h')).toBe('minute');
    expect(resolutionForRange('24h')).toBe('minute');
    expect(resolutionForRange('7d')).toBe('hour');
    expect(resolutionForRange('30d')).toBe('hour');
    expect(rangeSpec('24h').expectedBuckets).toBe(1440);

    expect(isMetricRange('24h')).toBe(true);
    expect(isMetricRange('2h')).toBe(false);

    // 窗口两端都向下对齐到桶起点（未结束的当前桶不计入"应有桶数"）
    const window = rangeWindow('24h', NOW);
    expect(window.to).toBe(Math.floor(NOW / 60) * 60);
    expect(window.from).toBe(window.to - DAY);
    expect(expectedBucketsIn(window.from, window.to, 'minute')).toBe(1440);

    const hourly = rangeWindow('7d', NOW);
    expect(hourly.to % HOUR).toBe(0);
    expect(expectedBucketsIn(hourly.from, hourly.to, 'hour')).toBe(168);
    const monthly = rangeWindow('30d', NOW);
    expect(expectedBucketsIn(monthly.from, monthly.to, 'hour')).toBe(720);
    expect(expectedBucketsIn(window.to, window.from, 'minute')).toBe(0); // 反向窗口不许出现负数

    expect(samplingNote(30, 'minute')).toContain('不补 0');
    expect(samplingNote(30, 'hour')).toContain('60');
  });

  it('一次 SELECT 只取窗口内的桶（含端点），分辨率决定读哪张表', () => {
    const db: Db = initDatabase({ file: ':memory:', logger }).db;
    try {
      const repo = new MetricBucketsRepository(db);
      const window = rangeWindow('1h', NOW);
      insert(repo, { resolution: 'minute', metric: 'host.cpu.percent', target: 'host', unit: 'percent', bucketAt: window.from - 60, value: 1, samples: 2 });
      insert(repo, { resolution: 'minute', metric: 'host.cpu.percent', target: 'host', unit: 'percent', bucketAt: window.from, value: 2, samples: 2 });
      insert(repo, { resolution: 'minute', metric: 'host.cpu.percent', target: 'host', unit: 'percent', bucketAt: window.to, value: 3, samples: 2 });
      insert(repo, { resolution: 'minute', metric: 'host.cpu.percent', target: 'host', unit: 'percent', bucketAt: window.to + 60, value: 4, samples: 2 });
      // 同一 metric 的 hour 行不该被 minute 查询读到
      insert(repo, { resolution: 'hour', metric: 'host.cpu.percent', target: 'host', unit: 'percent', bucketAt: window.from, value: 9, samples: 60 });

      const view = history(repo, 'host.cpu.percent', 'host', '1h');
      expect(view.points.map((point) => point.value)).toEqual([2, 3]);
      expect(view.points.map((point) => point.at)).toEqual([
        bucketAtToIso(window.from),
        bucketAtToIso(window.to),
      ]);
      expect(view.resolution).toBe('minute');
      expect(view.gaps).toEqual({ missingBuckets: 58, partialBuckets: 0 });
      expect(view.summary).toMatchObject({ count: 2, min: 2, max: 3, avg: 2.5, latest: 3 });
      expect(view.summary.latestAt).toBe(bucketAtToIso(window.to));

      // 7d 走 hour 表：只看到那一条 hour 行
      const weekly = history(repo, 'host.cpu.percent', 'host', '7d');
      expect(weekly.resolution).toBe('hour');
      expect(weekly.points.map((point) => point.value)).toEqual([9]);
    } finally {
      db.close();
    }
  });
});

describe('缺口与 summary', () => {
  it('missingBuckets = 应有 − 实际；partialBuckets = samples < expected', () => {
    const rows = [
      bucketRow({ bucketAt: 60, value: 10, samples: 2, expected: 2 }),
      bucketRow({ bucketAt: 120, value: 11, samples: 1, expected: 2 }),
      bucketRow({ bucketAt: 180, value: 12, samples: 1, expected: 2 }),
    ];
    expect(countGaps(rows, 1440)).toEqual({ missingBuckets: 1437, partialBuckets: 2 });
    expect(countGaps(rows, 2)).toEqual({ missingBuckets: 0, partialBuckets: 2 });
    expect(countGaps([], 60)).toEqual({ missingBuckets: 60, partialBuckets: 0 });
  });

  it('空窗口：count = 0，其余字段全为 null（绝不用 0 冒充）', () => {
    const db: Db = initDatabase({ file: ':memory:', logger }).db;
    try {
      const repo = new MetricBucketsRepository(db);
      const view = history(repo, 'host.cpu.percent', 'host', '24h');

      expect(view.points).toEqual([]);
      expect(view.summary).toEqual({ count: 0, min: null, max: null, avg: null, latest: null, latestAt: null });
      expect(view.gaps).toEqual({ missingBuckets: 1440, partialBuckets: 0 });
      expect(view.summary.avg).not.toBe(0); // 关键：不是 0
      // 数据源尚未采过 → 诚实说明，而不是假装 available
      expect(view.source).toEqual({
        available: false,
        mode: 'none',
        detail: expect.stringContaining('尚未采集'),
      });
      expect(view.sampling).toEqual({
        intervalSec: 30,
        aggregate: 'mean',
        expectedPerBucket: 2,
        note: expect.stringContaining('每分钟 1 条'),
      });
    } finally {
      db.close();
    }
  });

  it('summary 的 min/max/avg 取桶的极值与均值，latest 取最新一桶', () => {
    const rows = [
      bucketRow({ bucketAt: 60, value: 10, minValue: 8, maxValue: 12, samples: 2, expected: 2 }),
      bucketRow({ bucketAt: 120, value: 30, minValue: 25, maxValue: 35, samples: 2, expected: 2 }),
      bucketRow({ bucketAt: 180, value: 20, minValue: 19, maxValue: 21, samples: 1, expected: 2 }),
    ];
    expect(summarizeBuckets(rows)).toEqual({
      count: 3,
      min: 8,
      max: 35,
      avg: 20,
      latest: 20,
      latestAt: new Date(180 * 1000).toISOString(),
    });
  });

  it('percent 与 bytes 是两套 key：各自返回自己的 unit 与量级，不做任何换算', () => {
    const db: Db = initDatabase({ file: ':memory:', logger }).db;
    try {
      const repo = new MetricBucketsRepository(db);
      const window = rangeWindow('24h', NOW);
      const bucketAt = window.to - 60;
      insert(repo, {
        resolution: 'minute',
        metric: 'host.disk.percent',
        target: 'disk:C',
        targetLabel: 'C',
        unit: 'percent',
        bucketAt,
        value: 55.5,
        min: 55.1,
        max: 55.9,
        samples: 2,
      });
      insert(repo, {
        resolution: 'minute',
        metric: 'host.disk.used_bytes',
        target: 'disk:C',
        targetLabel: 'C',
        unit: 'bytes',
        bucketAt,
        value: 500_000_000_000,
        min: 499_000_000_000,
        max: 501_000_000_000,
        samples: 2,
      });

      const percent = history(repo, 'host.disk.percent', 'disk:C', '24h');
      const bytes = history(repo, 'host.disk.used_bytes', 'disk:C', '24h');

      expect(percent.unit).toBe('percent');
      expect(percent.points[0]?.value).toBe(55.5);
      expect(percent.summary).toMatchObject({ min: 55.1, max: 55.9, avg: 55.5, latest: 55.5 });

      expect(bytes.unit).toBe('bytes');
      expect(bytes.points[0]?.value).toBe(500_000_000_000);
      expect(bytes.summary).toMatchObject({ min: 499_000_000_000, max: 501_000_000_000 });
      // 两条曲线互不影响（target 相同、metric 不同）
      expect(percent.points).toHaveLength(1);
      expect(bytes.points).toHaveLength(1);
      expect(percent.points[0]?.partial).toBe(false);
      expect(percent.metric).toBe('host.disk.percent');
      expect(bytes.metric).toBe('host.disk.used_bytes');
    } finally {
      db.close();
    }
  });

  it('samples < expected 的点标 partial，前端据此断开缺测', () => {
    const db: Db = initDatabase({ file: ':memory:', logger }).db;
    try {
      const repo = new MetricBucketsRepository(db);
      const window = rangeWindow('1h', NOW);
      insert(repo, { resolution: 'minute', metric: 'host.cpu.percent', target: 'host', unit: 'percent', bucketAt: window.from, value: 10, samples: 1, expected: 2 });
      insert(repo, { resolution: 'minute', metric: 'host.cpu.percent', target: 'host', unit: 'percent', bucketAt: window.from + 60, value: 11, samples: 2, expected: 2 });

      const view = history(repo, 'host.cpu.percent', 'host', '1h');
      expect(view.points.map((point) => point.partial)).toEqual([true, false]);
      expect(view.points.map((point) => point.samples)).toEqual([1, 2]);
      expect(view.gaps.partialBuckets).toBe(1);
    } finally {
      db.close();
    }
  });
});