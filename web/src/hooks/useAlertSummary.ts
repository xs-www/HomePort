/**
 * 告警未确认计数（Sprint 2 · S2-04）—— 导航徽标的数据源。
 *
 * 为什么单独一个 hook：徽标活在 `AppShell` 里（每个页面都渲染），
 * 它需要的是"一个很小的数字"，不应该让每个页面都去拉完整的事件列表。
 * `GET /api/alerts/summary` 正是为此存在的 viewer 可读端点。
 *
 * 三条纪律：
 * 1. **未登录不发请求**（`enabled: false`）：`AppShell` 也会在 404 页渲染，
 *    那时没有会话，发请求只会拿到 401 并触发全局"会话失效"逻辑。
 * 2. **按 §7 冻结类型直接取字段**，不做宽容解析 —— 契约违约要在页面上暴露，
 *    而不是被归一化悄悄"兼容"成 0。
 * 3. 只有 `unacknowledged > 0` 才显示徽标（0 不显示 —— 一个恒亮的 "0" 徽标
 *    等于噪音，会让人忽略真正的告警）。
 */
import { useCallback } from 'react';
import { EMPTY_ALERT_COUNTS, type AlertSummaryView } from '../api/alerts.js';
import { useApi } from '../auth/AuthProvider.js';
import { useAsync } from './useAsync.js';

/** 未取到数据时的零值视图（徽标不显示）；这是界面默认值，不是解析兜底。 */
export const EMPTY_ALERT_SUMMARY: AlertSummaryView = {
  open: EMPTY_ALERT_COUNTS.open,
  unacknowledged: EMPTY_ALERT_COUNTS.unacknowledged,
  suppressed: 0,
  bySeverity: { warning: 0, critical: 0 },
  top: [],
  evaluatedAt: null,
};

export interface AlertSummaryState {
  /** 未恢复事件数 */
  open: number;
  /** 未恢复且未确认的事件数（徽标显示的就是它） */
  unacknowledged: number;
  /** 命中静默期被压掉的触发次数 */
  suppressed: number;
  evaluatedAt: string | null;
  loading: boolean;
  loaded: boolean;
  error: string | null;
  reload: () => Promise<void>;
}

export function useAlertSummary(options: { enabled?: boolean; refreshIntervalMs?: number } = {}): AlertSummaryState {
  const { enabled = true, refreshIntervalMs = 60_000 } = options;
  const api = useApi();

  const load = useCallback(async (): Promise<AlertSummaryView> => {
    if (!enabled) return EMPTY_ALERT_SUMMARY;
    return api.alertSummary();
  }, [api, enabled]);

  const state = useAsync(load, {
    immediate: enabled,
    refreshIntervalMs: enabled ? refreshIntervalMs : 0,
    // 刷新失败时保留上一次的计数：徽标闪一下消失比稍旧更糟
    keepPreviousData: true,
  });

  const summary = state.data ?? EMPTY_ALERT_SUMMARY;
  return {
    open: summary.open,
    unacknowledged: summary.unacknowledged,
    suppressed: summary.suppressed,
    evaluatedAt: summary.evaluatedAt,
    loading: state.loading,
    loaded: state.loaded,
    error: state.error,
    reload: state.reload,
  };
}