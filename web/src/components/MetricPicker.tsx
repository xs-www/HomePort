/**
 * 指标 / 目标 / 时间范围选择器（Sprint 2 · S2-02）。
 *
 * 三条约定：
 * 1. **纯展示组件**：指标目录、目标列表都由页面传进来（数据获取在 hook 里），
 *    这样组件本身可以在没有 fetch 的情况下单测。
 * 2. **固定 id**：`#metric-key` / `#metric-target` / `#metric-range` ——
 *    与 `ServiceForm` 的 `#service-name` 同样的理由：E2E 与单测依赖稳定选择器。
 * 3. **切换指标时整体重取**：选择器只把意图回调给页面，页面负责把目标重置成
 *    新指标的第一个可用目标（percent 与 bytes 是两套键，目标列表也不同，
 *    绝不能"沿用上一个指标的目标"）。
 */
import type { ReactNode } from 'react';
import {
  METRIC_CATALOG,
  METRIC_RANGES,
  metricByKey,
  metricUnitShortLabel,
  type MetricRange,
  type MetricTargetOption,
} from '../api/metrics.js';
import { Spinner } from './ui.js';

export interface MetricPickerValue {
  metric: string;
  target: string;
  range: MetricRange;
}

export interface MetricPickerProps {
  value: MetricPickerValue;
  /** 当前指标的可用目标（页面用 `useMetricTargets` 取） */
  targets: readonly MetricTargetOption[];
  targetsLoading?: boolean;
  onChange: (next: MetricPickerValue) => void;
}

export function MetricPicker({ value, targets, targetsLoading = false, onChange }: MetricPickerProps): ReactNode {
  const entry = metricByKey(value.metric);
  const targetMissing = value.target === '' || !targets.some((option) => option.value === value.target);

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <div>
        <label className="label" htmlFor="metric-key">
          指标
        </label>
        <select
          id="metric-key"
          className="input"
          value={value.metric}
          onChange={(event) => onChange({ ...value, metric: event.target.value, target: '' })}
        >
          {METRIC_CATALOG.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
        <p className="muted mt-1.5 text-[11px]">
          {entry ? `显示格式：${metricUnitShortLabel(entry.unit)}` : '未知指标'}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="metric-target">
          目标
        </label>
        <select
          id="metric-target"
          className="input"
          value={targetMissing ? '' : value.target}
          disabled={targetsLoading || targets.length === 0}
          onChange={(event) => onChange({ ...value, target: event.target.value })}
        >
          {targets.length === 0 ? <option value="">（没有可用目标）</option> : null}
          {targets.map((option) => (
            <option key={option.value} value={option.value}>
              {option.hint ? `${option.label} · ${option.hint}` : option.label}
            </option>
          ))}
        </select>
        <p className="muted mt-1.5 text-[11px]">
          {targetsLoading ? <Spinner label="正在读取可用目标…" /> : '同一条曲线的第二半身份（metric + target）'}
        </p>
      </div>

      <div>
        <label className="label" htmlFor="metric-range">
          时间范围
        </label>
        <select
          id="metric-range"
          className="input"
          value={value.range}
          onChange={(event) => onChange({ ...value, range: event.target.value as MetricRange })}
        >
          {METRIC_RANGES.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </select>
        <p className="muted mt-1.5 text-[11px]">1 小时 / 24 小时用分钟桶；7 天 / 30 天用小时桶</p>
      </div>
    </div>
  );
}