/**
 * 历史曲线（Sprint 2 · S2-02）测试。
 *
 * 覆盖规格 §10 表格里 `web/tests/metricsChart.test.tsx` 那一行，逐条：
 * 1. **缺口断开**：纯函数 `buildSeriesPath` —— 3 个点、中间缺 5 个桶 → 断言 2 段；
 *    并且"间距正好等于 resolution"**不算**缺口（判据是 `> resolution`）。
 * 2. **partial 段标记**：含部分缺测桶的连续段归入 `partialSegments`（虚线 + 空心点）。
 * 3. **单位格式化**：`percent` → `%`、`bytes` → `KB/MB/GB`（1024 进制）、
 *    `ratio` → 百分比但标签写"健康占比"，且 **percent 与 bytes 绝不互换**。
 * 4. **空态**：渲染"还没有历史数据"且**一个 `<path>` 都没有**（不画 0 平线）。
 * 5. **四项标注**：单位 / 数据源 / 采样方式 / 窗口内缺测数量都在 DOM 里。
 * 6. 可访问性：图表 `role="img"` + `aria-label`（指标名/范围/点数）；tooltip 有样本数。
 *
 * 本文件不装任何 fetch：图表是纯展示组件，数据由测试直接喂。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  MetricsChart,
  buildSeriesPath,
  bucketSeconds,
  formatAxisTick,
  niceTicks,
  type ChartPoint,
} from '../src/components/MetricsChart.js';
import {
  formatMetricValue,
  metricUnitLabel,
  metricUnitShortLabel,
  type MetricHistoryPoint,
  type MetricHistoryView,
} from '../src/api/metrics.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { HistoryPage } from '../src/pages/HistoryPage.js';
import { baseRoutes, callsTo, jsonResponse, sessionUser, stubFetch } from './serviceTestUtils.js';

/** 桶 0 的起点（固定时间，避免依赖真实时钟）。 */
const BASE = Math.floor(Date.parse('2026-10-15T10:00:00.000Z') / 1000);

const iso = (seconds: number): string => new Date(seconds * 1000).toISOString();
/** 每个桶 10px：x 与桶序号成正比，断言可以直接心算。 */
const xScale = (at: string): number => ((bucketSeconds(at) - BASE) / 60) * 10;
const yScale = (value: number): number => 200 - value * 2;

function point(offsetBuckets: number, value: number, overrides: Partial<ChartPoint> = {}): ChartPoint {
  return { at: iso(BASE + offsetBuckets * 60), value, partial: false, samples: 2, expected: 2, ...overrides };
}

function partialPoint(offsetBuckets: number, value: number): ChartPoint {
  return point(offsetBuckets, value, { partial: true, samples: 1 });
}

/** 5 个相邻的分钟桶，第 2 个是部分缺测（1/2 样本）。 */
function historyPoints(): MetricHistoryPoint[] {
  return [
    { at: iso(BASE), value: 10, min: 9, max: 11, samples: 2, expected: 2, partial: false },
    { at: iso(BASE + 60), value: 12, min: 11, max: 13, samples: 1, expected: 2, partial: true },
    { at: iso(BASE + 120), value: 14, min: 13, max: 15, samples: 2, expected: 2, partial: false },
    { at: iso(BASE + 180), value: 16, min: 15, max: 17, samples: 2, expected: 2, partial: false },
    { at: iso(BASE + 240), value: 18, min: 17, max: 19, samples: 2, expected: 2, partial: false },
  ];
}

function historyView(overrides: Partial<MetricHistoryView> = {}): MetricHistoryView {
  const points = historyPoints();
  return {
    metric: 'host.cpu.percent',
    label: '宿主 CPU 使用率',
    unit: 'percent',
    target: 'host',
    targetLabel: '宿主',
    range: '24h',
    resolution: 'minute',
    from: iso(BASE),
    to: iso(BASE + 86400),
    sampling: {
      intervalSec: 30,
      aggregate: 'mean',
      expectedPerBucket: 2,
      note: '30s 采样 → 每分钟 1 条；缺测处断开，不补 0',
    },
    source: { available: true, mode: 'host-proc', detail: '/proc/stat' },
    points,
    gaps: { missingBuckets: 3, partialBuckets: 5 },
    summary: { count: points.length, min: 9, max: 19, avg: 14, latest: 18, latestAt: iso(BASE + 240) },
    ...overrides,
  };
}

/** 窗口内一行都没有：`count: 0` 且其余字段为 null（§3.2）。 */
function emptyView(): MetricHistoryView {
  return historyView({
    points: [],
    gaps: { missingBuckets: 1440, partialBuckets: 0 },
    summary: { count: 0, min: null, max: null, avg: null, latest: null, latestAt: null },
  });
}

const countOf = (path: string | undefined, token: string): number => path?.match(new RegExp(token, 'g'))?.length ?? 0;

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('buildSeriesPath · 缺测处必须断开', () => {
  it('3 个点中间缺 5 个桶 → 2 段（绝不跨缺口连线）', () => {
    const points = [point(0, 10), point(1, 12), point(6, 20)];
    const result = buildSeriesPath(points, 60, xScale, yScale);

    expect(result.segments).toHaveLength(2);
    expect(result.partialSegments).toHaveLength(0);

    // 第 1 段：M + L（两个点连起来）；第 2 段：只有一个 M（单点，没有跨过来的 L）
    expect(countOf(result.segments[0], 'M')).toBe(1);
    expect(countOf(result.segments[0], 'L')).toBe(1);
    expect(countOf(result.segments[1], 'M')).toBe(1);
    expect(countOf(result.segments[1], 'L')).toBe(0);

    // x 坐标按时间算：桶 6 → 60px，而不是"第 2 个点 → 10px"
    expect(result.segments[1]).toBe(`M${60},${yScale(20)}`);
  });

  it('相邻桶（间距正好等于 resolution）仍然连成 1 段 —— 判据是「> resolution」', () => {
    const points = [point(0, 10), point(1, 12), point(2, 14)];
    const result = buildSeriesPath(points, 60, xScale, yScale);
    expect(result.segments).toHaveLength(1);
    expect(countOf(result.segments[0], 'L')).toBe(2);
  });

  it('resolutionSec 真的参与判断：120s 间距在小时桶（3600s）下不算缺口', () => {
    const points = [point(0, 10), point(2, 12)];
    expect(buildSeriesPath(points, 60, xScale, yScale).segments).toHaveLength(2);
    expect(buildSeriesPath(points, 3600, xScale, yScale).segments).toHaveLength(1);
  });

  it('时间或数值非法的点被丢掉（绝不把 NaN 写进 path）', () => {
    const points: ChartPoint[] = [
      point(0, 10),
      { at: '不是时间', value: 12, partial: false, samples: 2, expected: 2 },
      point(1, Number.NaN),
      point(2, 14),
    ];
    const result = buildSeriesPath(points, 60, xScale, yScale);

    // 只剩桶 0 与桶 2（非法点被丢掉，于是中间出现真实缺口）→ 2 段
    expect(result.segments).toHaveLength(2);
    for (const path of result.segments) expect(path).not.toContain('NaN');
    expect(countOf(result.segments[0], 'L')).toBe(0);
    expect(countOf(result.segments[1], 'L')).toBe(0);
  });

  it('乱序输入也按时间排序（缺口判定依赖顺序）', () => {
    const points = [point(6, 20), point(0, 10), point(1, 12)];
    const result = buildSeriesPath(points, 60, xScale, yScale);
    expect(result.segments).toHaveLength(2);
    expect(countOf(result.segments[0], 'L')).toBe(1);
  });
});

describe('buildSeriesPath · partial 段标记', () => {
  it('含部分缺测桶的连续段归入 partialSegments，完整段留在 segments', () => {
    const points = [
      point(0, 10),
      partialPoint(1, 12),
      point(2, 14),
      // 缺口（缺 5 个桶）
      point(8, 20),
      point(9, 22),
    ];
    const result = buildSeriesPath(points, 60, xScale, yScale);

    expect(result.segments).toHaveLength(1);
    expect(result.partialSegments).toHaveLength(1);
    // partial 段内**不断开**（partial 是"有数据但样本不足"，不是缺测）
    expect(countOf(result.partialSegments[0], 'L')).toBe(2);
    expect(countOf(result.segments[0], 'L')).toBe(1);
  });

  it('组件用虚线 + 空心点区分 partial 桶，且完整段是实线', () => {
    const { container } = render(<MetricsChart view={historyView()} />);

    const partialGroup = container.querySelector('[data-partial-segment="true"]');
    expect(partialGroup).not.toBeNull();
    const dashed = partialGroup?.querySelector('path[stroke-dasharray]');
    expect(dashed?.getAttribute('stroke-dasharray')).toBe('5 4');

    // 5 个连续桶里第 2 个是 partial → 整段都是 partial 段，没有完整段
    expect(container.querySelectorAll('[data-partial-segment="true"]').length).toBe(1);
    // 空心圆点（琥珀描边）标出部分缺测桶
    expect(container.querySelectorAll('circle.stroke-amber-500').length).toBe(1);
  });
});

describe('单位格式化 · percent 与 bytes 绝不互换', () => {
  it('percent → 百分比', () => {
    expect(formatMetricValue(12.4, 'percent')).toBe('12.4%');
    expect(formatMetricValue(0, 'percent')).toBe('0.0%');
  });

  it('bytes → B/KB/MB/GB（1024 进制，保留 1 位小数）', () => {
    expect(formatMetricValue(1536, 'bytes')).toBe('1.5 KB');
    expect(formatMetricValue(3.5 * 1024 ** 2, 'bytes')).toBe('3.5 MB');
    expect(formatMetricValue(2 * 1024 ** 3, 'bytes')).toBe('2.0 GB');
    expect(formatMetricValue(512, 'bytes')).toBe('512 B');
  });

  it('ratio → 百分比显示，但标签写"健康占比"（0..1 的采样占比）', () => {
    expect(formatMetricValue(0.875, 'ratio')).toBe('87.5%');
    expect(metricUnitLabel('ratio')).toContain('健康占比');
    expect(metricUnitShortLabel('ratio')).toBe('健康占比');
  });

  it('同一个数字在两种单位下给出不同结果（不互换、不隐式换算）', () => {
    expect(formatMetricValue(1536, 'bytes')).not.toBe(formatMetricValue(1536, 'percent'));
    expect(formatMetricValue(12.4, 'percent')).not.toContain('B');
    expect(formatMetricValue(1536, 'bytes')).not.toContain('%');
    // bytes 的格式化只接受字节数，percent 只接受百分比：不存在任何单位转换入参
    expect(metricUnitShortLabel('bytes')).toBe('B/KB/MB/GB');
    expect(metricUnitShortLabel('percent')).toBe('%');
  });

  it('缺失/非法值显示 "—"，绝不渲染 NaN', () => {
    expect(formatMetricValue(undefined, 'bytes')).toBe('—');
    expect(formatMetricValue(null, 'percent')).toBe('—');
    expect(formatMetricValue(Number.NaN, 'ratio')).toBe('—');
    expect(formatMetricValue(Number.POSITIVE_INFINITY, 'bytes')).toBe('—');
  });
});

describe('niceTicks · Y 轴 3–5 个整刻度', () => {
  it('给出 3–5 个有限刻度', () => {
    const ticks = niceTicks(0, 100, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(5);
    expect(ticks.every((tick) => Number.isFinite(tick))).toBe(true);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(100);
  });

  it('全平序列与非法输入都不产生 NaN', () => {
    expect(niceTicks(5, 5).every((tick) => Number.isFinite(tick))).toBe(true);
    expect(niceTicks(0.4, 0.6, 4).every((tick) => Number.isFinite(tick))).toBe(true);
    expect(niceTicks(Number.NaN, 1)).toEqual([]);
  });
});

describe('MetricsChart · 空态必须诚实', () => {
  it('count === 0 时显示"还没有历史数据"、说明采样与保留，且不画任何 path（不画 0 平线）', () => {
    const { container } = render(<MetricsChart view={emptyView()} />);

    expect(screen.getByText('还没有历史数据')).toBeTruthy();
    // **一个 <path> 都没有**：没有曲线、没有 0 平线、也没有隐含的坐标轴假数据
    expect(container.querySelectorAll('path')).toHaveLength(0);
    expect(container.querySelector('[data-testid="metrics-chart-canvas"]')).toBeNull();
    expect(container.textContent).not.toContain('NaN');

    // 空态也要说清"为什么现在是空的"
    expect(container.textContent).toContain('后台采样每 30 秒一次');
    expect(container.textContent).toContain('重启 HomePort 后历史会保留');
    expect(container.textContent).toContain('缺测处会断开');
  });

  it('空态也照样标注缺测桶数（没有数据时"缺了多少"才是最有用的信息）', () => {
    render(<MetricsChart view={emptyView()} />);
    expect(screen.getByText('整桶缺测 1440 个 · 部分缺测 0 个')).toBeTruthy();
  });
});

describe('MetricsChart · 四项标注缺一不可', () => {
  it('单位 / 数据源（mode + detail）/ 采样方式 / 窗口内缺测数量都在 DOM 里', () => {
    const { container } = render(<MetricsChart view={historyView()} />);

    expect(screen.getByText('单位')).toBeTruthy();
    expect(screen.getByText('数据源')).toBeTruthy();
    expect(screen.getByText('采样方式')).toBeTruthy();
    expect(screen.getByText('窗口内缺测')).toBeTruthy();

    // 1. 单位：百分比，且带取值范围
    expect(screen.getByText('百分比（%），0–100')).toBeTruthy();
    // 2. 数据源：mode + detail 都要透出
    expect(screen.getByText('host-proc · /proc/stat')).toBeTruthy();
    // 3. 采样方式：sampling.note 原样透出
    expect(screen.getByText('30s 采样 → 每分钟 1 条；缺测处断开，不补 0')).toBeTruthy();
    // 4. 窗口内缺测：missingBuckets / partialBuckets 两个数都要有
    expect(screen.getByText('整桶缺测 3 个 · 部分缺测 5 个')).toBeTruthy();
    expect(container.textContent).toContain('宿主');
  });

  it('数据源不可用时明确写"不可用"，不假装正常', () => {
    render(<MetricsChart view={historyView({ source: { available: false, mode: 'none', detail: '宿主机 /proc 不可读' } })} />);
    expect(screen.getByText('不可用：none · 宿主机 /proc 不可读')).toBeTruthy();
  });
});

describe('MetricsChart · 无障碍与 tooltip', () => {
  it('图表有 role="img" 与含指标名/范围/点数的 aria-label', () => {
    render(<MetricsChart view={historyView()} />);
    const svg = screen.getByRole('img');
    const label = svg.getAttribute('aria-label') ?? '';

    expect(label).toContain('宿主 CPU 使用率');
    expect(label).toContain('最近 24 小时');
    expect(label).toContain('共 5 个数据点');
    expect(label).toContain('整桶缺测 3 个');
  });

  it('悬停显示时间/值（带单位）/样本数，部分缺测能一眼看出来', () => {
    const { container } = render(<MetricsChart view={historyView()} />);

    // 完整桶：2/2 样本
    const complete = container.querySelector('[data-bucket-index="0"]');
    expect(complete).not.toBeNull();
    fireEvent.mouseOver(complete as Element);
    let tooltip = screen.getByTestId('metrics-chart-tooltip').textContent ?? '';
    expect(tooltip).toContain('10.0%');
    expect(tooltip).toContain('2/2 样本');
    expect(tooltip).not.toContain('部分缺测');

    // 部分缺测桶：1/2 样本（部分缺测）
    const partial = container.querySelector('[data-bucket-index="1"]');
    fireEvent.mouseOver(partial as Element);
    tooltip = screen.getByTestId('metrics-chart-tooltip').textContent ?? '';
    expect(tooltip).toContain('12.0%');
    expect(tooltip).toContain('1/2 样本（部分缺测）');
  });

  it('X 轴刻度按 resolution 给人话（分钟桶 = HH:MM，小时桶 = MM-DD HH:MM）', () => {
    expect(formatAxisTick(iso(BASE), 'minute')).toMatch(/^\d{2}:\d{2}$/);
    expect(formatAxisTick(iso(BASE), 'hour')).toMatch(/^\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});

describe('HistoryPage · 指标 × 目标 × 范围（集成）', () => {
  /** 只用到 `disks`，其余字段按契约给最小可用值（这里不测系统快照本身）。 */
  const snapshot = {
    generatedAt: iso(BASE),
    host: { hostname: 'nas', osLabel: 'Linux', cpuModel: 'x', cpuCores: 4, arch: 'x64', kernel: '6', uptimeSec: 1, hostIsLinux: true },
    cpu: { percent: 10, perCore: [], loadAvg: [0, 0, 0] },
    memory: { usedBytes: 1, totalBytes: 2, availableBytes: 1, percent: 50, cachedBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0 },
    disks: [{ mount: '/mnt/c', label: 'C:', fsType: 'ntfs', usedBytes: 1, totalBytes: 2, availableBytes: 1, percent: 50, error: null }],
    gpu: null,
    sources: {
      cpu: { available: true, mode: 'host-proc', detail: null },
      memory: { available: true, mode: 'host-proc', detail: null },
      disk: { available: true, mode: 'statfs', detail: null },
      gpu: { available: false, mode: 'none', detail: null },
    },
  };

  it('默认指标自动选中第一个目标并取数；切换指标时目标重新推导、曲线整体重取', async () => {
    const calls = stubFetch({
      ...baseRoutes(sessionUser()),
      '/api/alerts/summary': () =>
        jsonResponse({ open: 0, unacknowledged: 0, suppressed: 0, bySeverity: { warning: 0, critical: 0 }, top: [], evaluatedAt: null }),
      '/api/metrics/history?metric=host.cpu.percent&target=host&range=24h': () => jsonResponse(historyView()),
      '/api/system/snapshot': () => jsonResponse(snapshot),
      // target 里的冒号会被 URLSearchParams 编码成 %3A
      '/api/metrics/history?metric=host.disk.percent&target=disk%3AC%3A&range=24h': () =>
        jsonResponse(
          historyView({ metric: 'host.disk.percent', label: '磁盘使用率', target: 'disk:C:', targetLabel: 'C:' }),
        ),
    });

    render(
      <MemoryRouter>
        <AuthProvider>
          <HistoryPage />
        </AuthProvider>
      </MemoryRouter>,
    );

    // host 类指标的目标是静态的 → 无需额外请求，直接取到曲线
    await screen.findByRole('img');
    expect(callsTo(calls, '/api/metrics/history?metric=host.cpu.percent&target=host&range=24h')).toHaveLength(1);
    expect((screen.getByLabelText('目标') as HTMLSelectElement).value).toBe('host');

    // 切到磁盘指标：目标列表改从 /api/system/snapshot 推导，并按新 target 重取
    fireEvent.change(screen.getByLabelText('指标'), { target: { value: 'host.disk.percent' } });
    await waitFor(() => expect(callsTo(calls, '/api/system/snapshot')).toHaveLength(1));
    await waitFor(() =>
      expect(callsTo(calls, '/api/metrics/history?metric=host.disk.percent&target=disk%3AC%3A&range=24h')).toHaveLength(1),
    );
    expect((screen.getByLabelText('目标') as HTMLSelectElement).value).toBe('disk:C:');
    // 目标标签来自冻结的 disks[].label，而不是容器/位置推断
    expect((screen.getByLabelText('目标') as HTMLSelectElement).textContent).toContain('C:');
  });
});