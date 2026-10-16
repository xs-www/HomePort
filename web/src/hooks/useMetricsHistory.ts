/**
 * 历史指标的数据获取（Sprint 2 · S2-02）。
 *
 * 拆成两个 hook，因为它们的**取数来源完全不同**：
 * - `useMetricsHistory`：一条曲线一个请求（`/api/metrics/history`）；
 * - `useMetricTargets`：`metric` 决定"可选目标从哪来"。
 *
 * 关于目标列表为什么不用 `GET /api/metrics/catalog`：
 * 该端点的**响应形状没有在规格 §7 里冻结**（只有一句"§1 目录 + 可用 target"），
 * 前端按猜测解析一个没冻结的形状，等于把契约漂移藏进代码里。
 * 所以这里改用两个**已经冻结**的 Sprint 1 端点推导：
 * - 磁盘目标 ← `/api/system/snapshot` 的 `disks[].label`；
 * - 容器 / 服务目标 ← `/api/services` 的 `sourceRef`
 *   （§1 明确"容器的 target 用 `containerServiceRef(container)`，与 Sprint 1 的服务身份同源"）。
 * 等 catalog 的形状进了规格，这里换成一个请求即可（替换点只有本文件）。
 */
import { useCallback } from 'react';
import { metricByKey, type MetricHistoryView, type MetricRange, type MetricTargetOption } from '../api/metrics.js';
import { useApi } from '../auth/AuthProvider.js';
import { useAsync, type AsyncState } from './useAsync.js';

export interface MetricsHistoryQuery {
  metric: string | null;
  /** 未选定目标时为 null（此时不发请求） */
  target: string | null;
  range: MetricRange;
}

/**
 * 取一条历史曲线。
 *
 * 默认 60 秒刷新一次：`1h/24h` 窗口的后端采样间隔是 30s 级，
 * 比这更频繁地重取不会带来更多信息，只会增加库读取。
 */
export function useMetricsHistory(
  query: MetricsHistoryQuery,
  options: { refreshIntervalMs?: number } = {},
): AsyncState<MetricHistoryView | null> {
  const api = useApi();
  const { metric, target, range } = query;

  const load = useCallback(async (): Promise<MetricHistoryView | null> => {
    // 没有目标就别发请求：那注定是一次 400，空态比错误态更诚实
    if (!metric || !target) return null;
    return api.metricsHistory({ metric, target, range });
  }, [api, metric, target, range]);

  return useAsync(load, {
    immediate: Boolean(metric && target),
    refreshIntervalMs: options.refreshIntervalMs ?? 60_000,
  });
}

/**
 * 取当前指标的可用目标。
 *
 * 返回的 `value` 直接作为 `?target=` 使用（`host` / `disk:C:` / `container:docker:xxx` …）。
 */
export function useMetricTargets(metric: string | null): AsyncState<MetricTargetOption[]> {
  const api = useApi();

  const load = useCallback(async (): Promise<MetricTargetOption[]> => {
    const entry = metricByKey(metric);
    if (!entry) return [];

    switch (entry.targetKind) {
      case 'host':
        return [{ value: 'host', label: '宿主', hint: 'host' }];
      case 'disk': {
        const snapshot = await api.systemSnapshot();
        // 取不到 label 的磁盘不列出来：target 必须是稳定身份，不能靠位置猜
        return snapshot.disks
          .filter((disk) => disk.label !== '')
          .map((disk) => ({ value: `disk:${disk.label}`, label: disk.label, hint: disk.mount }));
      }
      case 'container': {
        const list = await api.services();
        return list.items
          .filter((item) => item.container !== null)
          .map((item) => ({
            value: `container:${item.sourceRef}`,
            label: item.displayName,
            hint: item.container?.name ?? item.sourceRef,
          }));
      }
      case 'service': {
        const list = await api.services();
        return list.items.map((item) => ({
          value: `service:${item.sourceRef}`,
          label: item.displayName,
          hint: item.sourceRef,
        }));
      }
    }
  }, [api, metric]);

  return useAsync(load, { immediate: Boolean(metric) });
}