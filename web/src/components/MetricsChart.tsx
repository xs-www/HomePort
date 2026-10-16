/**
 * 历史曲线（Sprint 2 · S2-02）—— **手写 SVG，零依赖**。
 *
 * ## 四条不能妥协的规则（都来自规格 §8 与 §0.4）
 *
 * 1. **缺测处必须断开**：`points` 里相邻两桶的**时间间距 > 该 resolution 的秒宽**
 *    时就断线（分钟桶 60s / 小时桶 3600s）。跨缺口连线等于**编造数据**：
 *    图上会出现一段"看起来很平稳"的直线，而真相是那段时间**一个样本都没有**。
 *    判定逻辑抽成纯函数 `buildSeriesSegments` / `buildSeriesPath`，可单测。
 * 2. **缺测绝不写 0**：整桶没有样本时后端不写行，前端也就不会收到点；
 *    这里只会"少画一段"，永远不会补一个 0 值点。
 *    空态（`summary.count === 0`）更是**连 `<path>` 都不渲染**——
 *    画一条 0 的平线就是在说谎。
 * 3. **`partial: true` 的桶必须能看出来**：包含部分缺测桶的连续段走
 *    `partialSegments`（虚线 + 更浅的颜色），且这些桶额外画成**空心圆点**。
 * 4. **percent 与 bytes 绝不互相换算**：Y 轴刻度与 tooltip 一律经
 *    `formatMetricValue(value, unit)`，按 `unit` 显式分支（percent → `%`、
 *    bytes → `B/KB/MB/GB`、ratio → 百分比但标注"健康占比"）。
 */
import { useMemo, useState, type ReactNode } from 'react';
import {
  formatMetricValue,
  metricUnitLabel,
  metricUnitShortLabel,
  rangeLabel,
  resolutionSec as metricResolutionSec,
  type MetricHistoryView,
  type MetricResolution,
  type MetricUnit,
} from '../api/metrics.js';
import { formatDateTime } from '../lib/format.js';
import { Card, EmptyState, ErrorNotice, Icon, Skeleton, Spinner } from './ui.js';

// ---------------------------------------------------------------- 画布几何

const WIDTH = 760;
const HEIGHT = 260;
const PAD = { top: 16, right: 16, bottom: 30, left: 76 };
const PLOT_WIDTH = WIDTH - PAD.left - PAD.right;
const PLOT_HEIGHT = HEIGHT - PAD.top - PAD.bottom;
/** 逐桶命中区上限：再多就不渲染命中区（几百个透明 rect 会让浏览器很难受），
 *  此时图表仍完整可用，只是没有逐桶 tooltip。 */
const MAX_INTERACTIVE_NODES = 1500;
/** 键盘可达的上限（每桶一个 tab 停靠点，太多反而不可用） */
const MAX_KEYBOARD_NODES = 60;

// ---------------------------------------------------------------- 纯函数

/** 图表只需要这五个字段（`MetricHistoryPoint` 结构上兼容）。 */
export interface ChartPoint {
  at: string;
  value: number;
  partial: boolean;
  samples: number;
  expected: number;
  min?: number | null;
  max?: number | null;
}

/** 值 → Y 像素 */
export type ValueScale = (value: number) => number;
/** 时间（ISO）→ X 像素 */
export type TimeScale = (at: string) => number;

export interface ChartPointNode {
  x: number;
  y: number;
  point: ChartPoint;
}

export interface ChartSegment {
  /** 同一个连续段内的点（段内相邻点间距 ≤ resolution） */
  points: ChartPointNode[];
}

export interface ChartSeries {
  /** 全部点都是完整桶的连续段（实线） */
  complete: ChartSegment[];
  /** **至少含一个 partial 桶**的连续段（虚线 + 更浅色） */
  partialSegments: ChartSegment[];
  /** 按时间升序的全部点（命中区 / tooltip 用） */
  nodes: ChartPointNode[];
}

/** 桶起点 → unix 秒（`at` 是 ISO 字符串；非法时间返回 NaN，由调用方过滤）。 */
export function bucketSeconds(at: string): number {
  return Math.floor(Date.parse(at) / 1000);
}

/**
 * 把点切成**连续段**：相邻两点间距 > `resolutionSec` 就开新段。
 *
 * 这里的"间距"用的是桶起点时间差，而不是下标差 —— 下标差在缺测时完全看不出来
 * （缺测就是**没有行**，不存在的桶不会占下标），这正是要断线的根因。
 *
 * 纯函数：不修改入参（内部先排好序的副本），不读时钟，不碰 DOM。
 */
export function buildSeriesSegments(
  points: readonly ChartPoint[],
  resolutionSec: number,
  xScale: TimeScale,
  yScale: ValueScale,
): ChartSeries {
  const clean = points
    .map((point) => ({ point, sec: bucketSeconds(point.at) }))
    // 时间或数值非法的点直接丢掉：宁可少画，也不能把 NaN 写进 SVG path
    .filter((item) => Number.isFinite(item.sec) && Number.isFinite(item.point.value))
    .sort((a, b) => a.sec - b.sec);

  const runs: ChartSegment[] = [];
  const nodes: ChartPointNode[] = [];
  let current: ChartSegment | null = null;
  let previousSec: number | null = null;
  /** 段的秒宽（未知/非法时退化为 1，保证"同桶重复点"仍连在一起） */
  const step = Number.isFinite(resolutionSec) && resolutionSec > 0 ? resolutionSec : 1;

  for (const item of clean) {
    const gap = previousSec !== null && item.sec - previousSec > step;
    if (current === null || gap) {
      current = { points: [] };
      runs.push(current);
    }
    const node: ChartPointNode = { x: xScale(item.point.at), y: yScale(item.point.value), point: item.point };
    current.points.push(node);
    nodes.push(node);
    previousSec = item.sec;
  }

  return {
    complete: runs.filter((run) => run.points.every((node) => node.point.partial !== true)),
    partialSegments: runs.filter((run) => run.points.some((node) => node.point.partial === true)),
    nodes,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 一段 → `M x,y L x,y …`（单点段退化为 `M x,y`，由组件用圆点补上）。 */
export function segmentToPath(segment: ChartSegment): string {
  return segment.points
    .map((node, index) => `${index === 0 ? 'M' : 'L'}${round2(node.x)},${round2(node.y)}`)
    .join(' ');
}

/** 一段 → 面积路径（折线封底，用于渐隐填充）。 */
export function segmentAreaPath(segment: ChartSegment, baseY: number): string {
  const first = segment.points[0];
  const last = segment.points[segment.points.length - 1];
  if (!first || !last) return '';
  const line = segment.points.map((node) => `L${round2(node.x)},${round2(node.y)}`).join(' ');
  return `M${round2(first.x)},${round2(baseY)} ${line} L${round2(last.x)},${round2(baseY)} Z`;
}

/**
 * 构建折线路径（**导出的可单测纯函数**）。
 *
 * 语义：
 * - `segments`：连续且**全部为完整桶**的段（正常实线）；
 * - `partialSegments`：连续但**含至少一个部分缺测桶**的段（虚线/浅色）。
 *
 * 为什么"含 partial 就整段换样式"而不是在 partial 处断开：
 * partial 桶**是有数据的**（只是样本不足），在它两侧断开会让图看起来像缺测，
 * 那是另一种谎言。段内**不断开**、只换样式，既保持真实的时间连续性，
 * 又能让人一眼看到"这一段的数据质量不完整"。
 */
export function buildSeriesPath(
  points: readonly ChartPoint[],
  resolutionSec: number,
  xScale: TimeScale,
  yScale: ValueScale,
): { segments: string[]; partialSegments: string[] } {
  const series = buildSeriesSegments(points, resolutionSec, xScale, yScale);
  return {
    segments: series.complete.map(segmentToPath),
    partialSegments: series.partialSegments.map(segmentToPath),
  };
}

/**
 * "整"刻度（3–5 个），步长取 1/2/2.5/5/10 × 10ⁿ。
 *
 * 为什么不用数据最小值/最大值当刻度：它们通常是 `12.4371` 这种数字，
 * 轴标签会变成一列噪声；取整刻度后 `formatMetricValue` 才能给出可读标签。
 */
export function niceTicks(min: number, max: number, count = 4): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (lo === hi) {
    // 全平序列（例如健康占比恒为 1）：给一个对称的假想范围，否则刻度会退化成一个点
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    lo -= pad;
    hi += pad;
  }
  const rawStep = (hi - lo) / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rawStep));
  const normalized = rawStep / magnitude;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10;
  const step = factor * magnitude;

  const ticks: number[] = [];
  const start = Math.floor(lo / step) * step;
  for (let value = start; value <= hi + step * 0.5 && ticks.length < 8; value += step) {
    ticks.push(round2(value)); // round2 顺带消掉浮点累加误差（0.30000000000000004）
  }
  return ticks;
}

function pad2(value: number): string {
  return String(Math.floor(value)).padStart(2, '0');
}

/** 秒 → X 轴刻度文案（本地时区，与仓库其它时间展示一致）。 */
export function formatAxisSeconds(sec: number, resolution: MetricResolution): string {
  if (!Number.isFinite(sec)) return '';
  const date = new Date(sec * 1000);
  const time = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
  // 分钟桶的窗口最多 24h，只需要时刻；小时桶跨天，必须带日期
  return resolution === 'hour' ? `${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${time}` : time;
}

/** ISO → X 轴刻度文案。 */
export function formatAxisTick(at: string, resolution: MetricResolution): string {
  return formatAxisSeconds(bucketSeconds(at), resolution);
}

function resolutionLabel(resolution: MetricResolution): string {
  return resolution === 'hour' ? '每小时聚合' : '每分钟聚合';
}

// ---------------------------------------------------------------- 布局

interface ChartLayout {
  ticks: number[];
  baseY: number;
  xScale: TimeScale;
  yScale: ValueScale;
}

/** 由视图算出刻度与两个比例尺（纯函数，便于推理）。 */
function buildLayout(view: MetricHistoryView, resolutionSec: number): ChartLayout {
  const values: number[] = [];
  for (const point of view.points) {
    for (const value of [point.value, point.min, point.max]) {
      if (typeof value === 'number' && Number.isFinite(value)) values.push(value);
    }
  }
  const lo = values.length > 0 ? Math.min(...values) : 0;
  const hi = values.length > 0 ? Math.max(...values) : 1;

  let ticks = niceTicks(lo, hi, 4);
  if (ticks.length < 2) ticks = [lo, hi === lo ? lo + 1 : hi];

  const first = ticks[0] ?? lo;
  const lastTick = ticks[ticks.length - 1] ?? hi;
  const yMin = Math.min(first, lastTick);
  const yMax = Math.max(first, lastTick) === yMin ? yMin + 1 : Math.max(first, lastTick);

  const yScale: ValueScale = (value) => PAD.top + ((yMax - value) / (yMax - yMin)) * PLOT_HEIGHT;

  const fromSec = bucketSeconds(view.from);
  const toSec = bucketSeconds(view.to);
  const rawSpan = toSec - fromSec;
  const span = Number.isFinite(rawSpan) && rawSpan > 0 ? rawSpan : resolutionSec;
  const xScale: TimeScale = (at) => {
    const sec = bucketSeconds(at);
    if (!Number.isFinite(sec)) return PAD.left;
    // 夹到 [0,1]：服务端若回了一个略微越界的桶，也不该画到坐标区外
    const ratio = Math.min(1, Math.max(0, (sec - fromSec) / span));
    return PAD.left + ratio * PLOT_WIDTH;
  };

  return { ticks, baseY: PAD.top + PLOT_HEIGHT, xScale, yScale };
}

// ---------------------------------------------------------------- 组件

export interface MetricsChartProps {
  view: MetricHistoryView | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}

export function MetricsChart({ view, loading = false, error = null, onRetry }: MetricsChartProps): ReactNode {
  const [hover, setHover] = useState<number | null>(null);

  const resolutionSeconds = view ? metricResolutionSec(view.resolution) : 60;
  const layout = useMemo(() => (view ? buildLayout(view, resolutionSeconds) : null), [view, resolutionSeconds]);
  const series = useMemo(
    () =>
      view && layout && view.points.length > 0
        ? buildSeriesSegments(view.points, resolutionSeconds, layout.xScale, layout.yScale)
        : { complete: [], partialSegments: [], nodes: [] },
    [view, layout, resolutionSeconds],
  );

  if (error) {
    return (
      <div className="space-y-3">
        <ErrorNotice message={error} onRetry={onRetry} />
      </div>
    );
  }

  if (!view) {
    return (
      <Card title="历史曲线">
        {loading ? <Spinner label="正在加载历史数据…" /> : <Skeleton rows={5} />}
      </Card>
    );
  }

  const hasData = view.summary.count > 0 && series.nodes.length > 0;
  const unit: MetricUnit = view.unit;
  const emptyDescription = `后台采样每 ${view.sampling.intervalSec} 秒一次；重启 HomePort 后历史会保留；缺测处会断开，不补 0。`;

  return (
    <Card
      title={view.label}
      subtitle={`目标 ${view.targetLabel} · ${rangeLabel(view.range)} · ${resolutionLabel(view.resolution)}`}
      actions={
        <span className="flex items-center gap-2">
          {loading ? <Spinner label="刷新中" /> : null}
          {hasData ? (
            <span className="font-mono text-sm font-semibold tabular-nums">
              {formatMetricValue(view.summary.latest, unit)}
            </span>
          ) : null}
        </span>
      }
    >
      {hasData && layout ? (
        <ChartCanvas
          view={view}
          layout={layout}
          series={series}
          resolutionSeconds={resolutionSeconds}
          unit={unit}
          hover={hover}
          onHover={setHover}
        />
      ) : (
        // 空态：**不画任何 <path>**，也不画一条 0 的平线（那是最容易撒的谎）。
        // 刻意不放图标：空态里连一个 <svg>/<path> 都不存在，"没有曲线"这件事
        // 才能在测试里被直接断言（也少一层视觉噪音）。
        <EmptyState title="还没有历史数据" description={emptyDescription} />
      )}

      <MetricAnnotations view={view} />
    </Card>
  );
}

// ---------------------------------------------------------------- 画布

interface ChartCanvasProps {
  view: MetricHistoryView;
  layout: ChartLayout;
  series: ChartSeries;
  resolutionSeconds: number;
  unit: MetricUnit;
  hover: number | null;
  onHover: (index: number | null) => void;
}

function ChartCanvas({ view, layout, series, resolutionSeconds, unit, hover, onHover }: ChartCanvasProps): ReactNode {
  const { ticks, baseY, xScale, yScale } = layout;
  const { gaps } = view;
  const interactive = series.nodes.length <= MAX_INTERACTIVE_NODES;
  const keyboard = series.nodes.length <= MAX_KEYBOARD_NODES;

  const ariaLabel =
    `${view.label}（${view.targetLabel}）历史曲线：${rangeLabel(view.range)}，${resolutionLabel(view.resolution)}，` +
    `共 ${view.points.length} 个数据点；单位 ${metricUnitLabel(unit)}；` +
    `整桶缺测 ${gaps.missingBuckets} 个，部分缺测 ${gaps.partialBuckets} 个`;

  const hoverNode = hover !== null ? series.nodes[hover] : undefined;

  // X 轴刻度：起点 / 1/3 / 2/3 / 终点（4 个足够，且不依赖分钟桶的真实点位）
  const fromSec = bucketSeconds(view.from);
  const toSec = bucketSeconds(view.to);
  const xTicks = [0, 1 / 3, 2 / 3, 1].map((ratio) => {
    const sec = fromSec + (toSec - fromSec) * ratio;
    return { x: xScale(new Date(sec * 1000).toISOString()), label: formatAxisSeconds(sec, view.resolution) };
  });

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        className="h-56 w-full"
        role="img"
        aria-label={ariaLabel}
        data-testid="metrics-chart-canvas"
      >
        {/* Y 轴刻度 + 网格（标签带单位：percent → %、bytes → B/KB/MB/GB、ratio → %）
            刻度文案一律走 formatMetricValue，绝不在 JSX 里手写单位。 */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={yScale(tick)}
              y2={yScale(tick)}
              className="text-slate-300 dark:text-white/10"
              stroke="currentColor"
              strokeWidth="1"
              strokeDasharray="2 4"
            />
            <text
              x={PAD.left - 8}
              y={yScale(tick) + 3.5}
              textAnchor="end"
              className="fill-slate-500 text-[10px] dark:fill-ink-300"
            >
              {formatMetricValue(tick, unit)}
            </text>
          </g>
        ))}

        {/* X 轴刻度 */}
        {xTicks.map((tick, index) => (
          <text
            key={`${tick.label}-${index}`}
            x={tick.x}
            y={HEIGHT - 10}
            textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'}
            className="fill-slate-500 text-[10px] dark:fill-ink-300"
          >
            {tick.label}
          </text>
        ))}

        {/* 面积 + 折线：完整段实线，含 partial 桶的段虚线且更浅 */}
        {series.complete.map((segment, index) => (
          <g key={`complete-${index}`}>
            <path d={segmentAreaPath(segment, baseY)} className="fill-sky-500/12" stroke="none" />
            <path
              d={segmentToPath(segment)}
              fill="none"
              strokeWidth="2"
              strokeLinejoin="round"
              strokeLinecap="round"
              className="stroke-sky-500"
            />
          </g>
        ))}
        {series.partialSegments.map((segment, index) => (
          <g key={`partial-${index}`} data-partial-segment="true">
            <path d={segmentAreaPath(segment, baseY)} className="fill-amber-500/12" stroke="none" />
            <path
              d={segmentToPath(segment)}
              fill="none"
              strokeWidth="2"
              strokeDasharray="5 4"
              strokeLinejoin="round"
              strokeLinecap="round"
              className="stroke-amber-500/70"
            />
          </g>
        ))}

        {/* 单点段：折线画不出任何东西，用实心点表示"这里有一个桶" */}
        {[...series.complete, ...series.partialSegments]
          .filter((segment) => segment.points.length === 1)
          .map((segment, index) => {
            const node = segment.points[0];
            if (!node) return null;
            return <circle key={`single-${index}`} cx={node.x} cy={node.y} r="2.5" className="fill-sky-500" />;
          })}

        {/* 部分缺测的桶：空心琥珀点（与完整桶一眼可分） */}
        {series.nodes
          .filter((node) => node.point.partial === true)
          .map((node, index) => (
            <circle
              key={`partial-dot-${index}`}
              cx={node.x}
              cy={node.y}
              r="3"
              strokeWidth="1.5"
              className="fill-white stroke-amber-500 dark:fill-ink-900"
            />
          ))}

        {/* 逐桶命中区（透明 rect）；超过上限就不渲染，避免上千个 DOM 节点 */}
        {interactive
          ? series.nodes.map((node, index) => {
              const half = Math.max(2, PLOT_WIDTH / Math.max(1, series.nodes.length) / 2);
              return (
                <rect
                  key={`hit-${index}`}
                  data-bucket-index={index}
                  x={node.x - half}
                  y={PAD.top}
                  width={half * 2}
                  height={PLOT_HEIGHT}
                  fill="transparent"
                  tabIndex={keyboard ? 0 : undefined}
                  role={keyboard ? 'button' : undefined}
                  aria-label={
                    keyboard
                      ? `${formatDateTime(node.point.at)}，${formatMetricValue(node.point.value, unit)}`
                      : undefined
                  }
                  onMouseEnter={() => onHover(index)}
                  onMouseLeave={() => onHover(null)}
                  onFocus={() => onHover(index)}
                  onBlur={() => onHover(null)}
                />
              );
            })
          : null}
      </svg>

      {/* tooltip：时间 / 值（带单位）/ 样本数（能看出数据质量） */}
      {hoverNode ? (
        <div
          data-testid="metrics-chart-tooltip"
          aria-live="polite"
          className="pointer-events-none absolute top-2 z-10 w-52 -translate-x-1/2 rounded-xl bg-white/95 px-3 py-2 text-[11px] shadow-lg ring-1 ring-slate-200 dark:bg-ink-900/95 dark:ring-white/10"
          style={{ left: `${(hoverNode.x / WIDTH) * 100}%` }}
        >
          <p className="muted">{formatDateTime(hoverNode.point.at)}</p>
          <p className="mt-0.5 font-mono text-xs font-semibold tabular-nums">
            {formatMetricValue(hoverNode.point.value, unit)}
            <span className="muted ml-1 font-sans font-normal">{metricUnitShortLabel(unit)}</span>
          </p>
          <p className="muted mt-0.5">
            {hoverNode.point.samples}/{hoverNode.point.expected} 样本
            {hoverNode.point.partial ? '（部分缺测）' : ''}
          </p>
          <p className="muted mt-0.5">
            桶内区间 {formatMetricValue(hoverNode.point.min ?? null, unit)} –{' '}
            {formatMetricValue(hoverNode.point.max ?? null, unit)} · {resolutionSeconds}s 桶
          </p>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- 四项标注

/**
 * 计划 S2-02 的原文要求：**单位、数据源、采样方式、窗口内缺测数量** 缺一不可。
 *
 * 这四项不是"补充信息"，而是判读曲线的前提：不知道单位就会看错数量级，
 * 不知道数据源就不知道可信度，不知道采样方式就不知道一条线的分辨率，
 * 不知道缺测数量就会把"没有数据"当成"值为 0"。
 */
function MetricAnnotations({ view }: { view: MetricHistoryView }): ReactNode {
  const detailSuffix = view.source.detail ? ` · ${view.source.detail}` : '';
  const sourceText = view.source.available
    ? `${view.source.mode}${detailSuffix}`
    : `不可用：${view.source.mode}${detailSuffix}`;

  return (
    <dl className="mt-4 divide-y divide-slate-200/70 border-t border-slate-200/70 pt-1 dark:divide-white/6 dark:border-white/8">
      <Annotation label="单位">{metricUnitLabel(view.unit)}</Annotation>
      <Annotation label="数据源">
        <span className={view.source.available ? undefined : 'text-rose-600 dark:text-rose-300'}>{sourceText}</span>
      </Annotation>
      <Annotation label="采样方式">{view.sampling.note}</Annotation>
      <Annotation label="窗口内缺测">
        {`整桶缺测 ${view.gaps.missingBuckets} 个 · 部分缺测 ${view.gaps.partialBuckets} 个`}
      </Annotation>
    </dl>
  );
}

function Annotation({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <dt className="muted shrink-0 text-xs">{label}</dt>
      <dd className="min-w-0 text-right text-xs break-all">{children}</dd>
    </div>
  );
}