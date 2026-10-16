/**
 * 历史指标（Sprint 2 · S2-02）的前端契约镜像。
 *
 * 三条纪律（全部来自 `docs/sprint2-implementation-spec.md`）：
 *
 * 1. **手写镜像**后端 JSON（§7），前端**不 import 后端代码**；字段名逐字对应，
 *    后端改契约必须先改规格再改这里（与 Sprint 1 的做法一致）。
 * 2. **percent 与 bytes 永远不互相换算**：单位是两套指标键的一部分
 *    （`*.percent` / `*.used_bytes`），前端只按 `unit` 决定"怎么显示"，
 *    绝不把 12.4 当成 12.4 字节、或把字节数按 100 取百分比。
 *    这类错误不会抛异常，只会画出一条看起来合理的错误曲线 —— 最难发现，
 *    所以格式化函数按 `unit` 显式分支，且**不提供**任何单位转换入参。
 * 3. 单位格式化写在本模块（而不是 `lib/format.ts`）的原因：`unit` 的类型定义
 *    就在这里，把「单位 → 显示规则」的映射留在同一处，避免两处各维护一半；
 *    字节换算仍复用 `lib/format.ts` 的 `formatBytes`，不重复实现。
 */
import { formatBytes } from '../lib/format.js';

/** §1 的三种单位。`ratio` 的值域是 0..1（= 健康采样占比），显示成百分比。 */
export type MetricUnit = 'percent' | 'bytes' | 'ratio';

/** §3.2 的四个窗口。 */
export type MetricRange = '1h' | '24h' | '7d' | '30d';

/** §3.2：`1h/24h` 用 minute 桶，`7d/30d` 用 hour 桶。 */
export type MetricResolution = 'minute' | 'hour';

/** `target` 的形态（§1）。前端用它决定去哪找可选目标。 */
export type MetricTargetKind = 'host' | 'disk' | 'container' | 'service';

export interface MetricCatalogEntry {
  /** 稳定标识：进库、进 URL、进前端，改名等于改契约 */
  key: string;
  label: string;
  unit: MetricUnit;
  targetKind: MetricTargetKind;
}

/**
 * §1 的指标目录（**冻结契约的字面副本**，不是从后端拉取的）。
 *
 * 为什么硬编码：`GET /api/metrics/catalog` 的响应形状**没有**在 §7 里冻结，
 * 前端不能凭猜测解析它；而"有哪些指标、什么单位"本身就是规格里写死的事实。
 * 目标列表另找来源（见 `useMetricTargets`），避免依赖未冻结的形状。
 */
export const METRIC_CATALOG: readonly MetricCatalogEntry[] = [
  { key: 'host.cpu.percent', label: '宿主 CPU 使用率', unit: 'percent', targetKind: 'host' },
  { key: 'host.memory.percent', label: '宿主内存使用率', unit: 'percent', targetKind: 'host' },
  { key: 'host.memory.used_bytes', label: '宿主已用内存', unit: 'bytes', targetKind: 'host' },
  { key: 'host.disk.percent', label: '磁盘使用率', unit: 'percent', targetKind: 'disk' },
  { key: 'host.disk.used_bytes', label: '磁盘已用空间', unit: 'bytes', targetKind: 'disk' },
  { key: 'container.cpu.percent', label: '容器 CPU', unit: 'percent', targetKind: 'container' },
  { key: 'container.memory.used_bytes', label: '容器内存（RSS 语义）', unit: 'bytes', targetKind: 'container' },
  { key: 'service.health.up_ratio', label: '服务健康采样占比', unit: 'ratio', targetKind: 'service' },
];

/** 时间范围选项（`range` → 人类可读标签）。 */
export const METRIC_RANGES: readonly { value: MetricRange; label: string }[] = [
  { value: '1h', label: '最近 1 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
];

/** 按 key 查目录项（未知 key 返回 null，调用方据此走空态而不是硬渲染）。 */
export function metricByKey(key: string | null | undefined): MetricCatalogEntry | null {
  if (!key) return null;
  return METRIC_CATALOG.find((entry) => entry.key === key) ?? null;
}

/** 桶的秒宽度：缺口判定与 X 轴对齐都用它（§3.2 的 resolution）。 */
export function resolutionSec(resolution: MetricResolution): number {
  return resolution === 'hour' ? 3600 : 60;
}

/** range → 人类可读标签（未知值原样返回，便于排障）。 */
export function rangeLabel(range: string): string {
  return METRIC_RANGES.find((item) => item.value === range)?.label ?? range;
}

/** 单位 → 完整说明（用于图表"单位"标注）。 */
export function metricUnitLabel(unit: MetricUnit): string {
  switch (unit) {
    case 'percent':
      return '百分比（%），0–100';
    case 'bytes':
      return '字节（B/KB/MB/GB，1024 进制，保留 1 位小数）';
    case 'ratio':
      // 刻意写成"健康占比"而不是"百分比"：ratio 的单位是 0..1 的采样占比，
      // 与 percent 指标是**两套键**，标签混用会让人误以为可以互相换算。
      return '健康占比（%，1.0 = 窗口内全部采样健康）';
  }
}

/** 单位 → 极短标签（Y 轴表头、tooltip 后缀）。 */
export function metricUnitShortLabel(unit: MetricUnit): string {
  switch (unit) {
    case 'percent':
      return '%';
    case 'bytes':
      return 'B/KB/MB/GB';
    case 'ratio':
      return '健康占比';
  }
}

/**
 * 按 `unit` 格式化数值（Y 轴刻度与 tooltip 的唯一入口）。
 *
 * - `percent` → `12.4%`
 * - `bytes`   → `1.5 KB` / `3.5 MB` / `2.0 GB`（1024 进制；整字节不带小数）
 * - `ratio`   → `87.5%`（值域 0..1 → 百分比；标签侧写"健康占比"）
 *
 * 非法值（null / NaN / Infinity）一律 `—`：**绝不**把 `undefined` 渲染成 `NaN`。
 * 这里**不做**任何跨单位换算 —— 传什么单位就按什么单位显示。
 */
export function formatMetricValue(value: number | null | undefined, unit: MetricUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'percent':
      return `${value.toFixed(1)}%`;
    case 'bytes':
      return formatBytes(value, 1);
    case 'ratio':
      return `${(value * 100).toFixed(1)}%`;
  }
}

// ---------------------------------------------------------------- §7 响应形状

/** 单个桶（缺测整桶**不会出现**在这里：没有行就是没有点）。 */
export interface MetricHistoryPoint {
  /** 桶起点的 ISO 时间 */
  at: string;
  /** 桶内均值 */
  value: number;
  min: number;
  max: number;
  /** 实际参与聚合的样本数 */
  samples: number;
  /** 该桶应有的样本数 */
  expected: number;
  /** `samples < expected` → 部分缺测（图表必须能看出来） */
  partial: boolean;
}

export interface MetricHistorySampling {
  intervalSec: number;
  aggregate: string;
  expectedPerBucket: number;
  note: string;
}

export interface MetricHistorySource {
  available: boolean;
  mode: string;
  detail: string | null;
}

export interface MetricHistoryGaps {
  /** 窗口内应有桶数 − 实际行数 */
  missingBuckets: number;
  /** 实际行里 `samples < expected` 的数量 */
  partialBuckets: number;
}

export interface MetricHistorySummary {
  /** 有值的桶数量；0 表示窗口内一行都没有（其余字段为 null，**不是** 0） */
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  latest: number | null;
  latestAt: string | null;
}

/** `GET /api/metrics/history` 的完整响应（§7 逐字段）。 */
export interface MetricHistoryView {
  metric: string;
  label: string;
  unit: MetricUnit;
  target: string;
  targetLabel: string;
  range: MetricRange;
  resolution: MetricResolution;
  from: string;
  to: string;
  sampling: MetricHistorySampling;
  source: MetricHistorySource;
  points: MetricHistoryPoint[];
  gaps: MetricHistoryGaps;
  summary: MetricHistorySummary;
}

/** 可选目标（`metric` + `target` 一起构成一条曲线）。 */
export interface MetricTargetOption {
  /** 直接作为 `?target=` 的值（`host` / `disk:C:` / `container:<sourceRef>` …） */
  value: string;
  label: string;
  hint?: string;
}