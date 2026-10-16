/**
 * 告警事件列表（Sprint 2 · S2-04）。
 *
 * 三条要点：
 * 1. **语义化 `<table>`**：告警是"多条同类记录"，表格才能让读屏用户按行列读；
 *    每行带 `data-alert-event-id` / `data-alert-state`，E2E 可断言。
 * 2. **恢复状态与重开次数必须可见**：`resolvedAt` 区分"还在告警/已恢复"，
 *    `reopenCount > 0` 说明"静默期内同一故障又犯了"（§2.4 的 episode 模型）。
 *    只显示一条 message 会把这两件事藏起来。
 * 3. **viewer 不渲染任何写入口**：确认按钮只在 admin 视角出现
 *    （后端仍会独立拒绝，前端隐藏只是避免误导）。
 */
import type { ReactNode } from 'react';
import {
  describeSeverity,
  formatAlertValue,
  type AlertEventView,
} from '../api/alerts.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import { Badge, EmptyState, Icon } from './ui.js';

export interface AlertEventListProps {
  items: readonly AlertEventView[];
  /** admin 才渲染「确认」按钮 */
  isAdmin: boolean;
  /** 正在确认的事件 id（按钮转圈并禁用） */
  acknowledgingId?: string | null;
  onAcknowledge: (event: AlertEventView) => void;
}

export function AlertEventList({ items, isAdmin, acknowledgingId = null, onAcknowledge }: AlertEventListProps): ReactNode {
  if (items.length === 0) {
    return (
      <EmptyState
        title="还没有告警事件"
        description="内置的四条规则默认是关闭状态（装了但不吵）；在管理员开启规则并满足触发条件后，事件会出现在这里。"
        icon={<Icon name="warning" className="size-6" />}
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] border-collapse text-left text-xs">
        <caption className="sr-only">告警事件列表：规则、目标、取值、状态与确认情况</caption>
        <thead>
          <tr className="muted border-b border-slate-200/70 text-[11px] dark:border-white/8">
            <th scope="col" className="py-2 pr-3 font-medium">严重度</th>
            <th scope="col" className="py-2 pr-3 font-medium">规则 / 目标</th>
            <th scope="col" className="py-2 pr-3 font-medium">取值</th>
            <th scope="col" className="py-2 pr-3 font-medium">状态</th>
            <th scope="col" className="py-2 pr-3 font-medium">触发时间</th>
            <th scope="col" className="py-2 pr-3 font-medium">重开</th>
            <th scope="col" className="py-2 pr-3 font-medium">确认</th>
            {isAdmin ? <th scope="col" className="py-2 font-medium">操作</th> : null}
          </tr>
        </thead>
        <tbody>
          {items.map((event) => {
            const severity = describeSeverity(event.severity);
            const resolved = event.resolvedAt !== null;
            return (
              <tr
                key={event.id}
                data-alert-event-id={event.id}
                data-alert-state={event.state}
                className="border-b border-slate-200/60 align-top dark:border-white/6"
              >
                <td className="py-2.5 pr-3">
                  <Badge tone={severity.tone} dot>
                    {severity.label}
                  </Badge>
                </td>
                <td className="py-2.5 pr-3">
                  <p className="font-medium">{event.ruleName}</p>
                  <p className="muted font-mono text-[11px]">{event.targetLabel}</p>
                  <p className="muted mt-0.5 text-[11px]">{event.message}</p>
                </td>
                <td className="py-2.5 pr-3 font-mono tabular-nums">
                  {formatAlertValue(event.value, event.unit)}
                  {event.threshold === null ? null : (
                    <span className="muted"> / 阈值 {formatAlertValue(event.threshold, event.unit)}</span>
                  )}
                </td>
                <td className="py-2.5 pr-3">
                  {resolved ? (
                    <span className="inline-flex flex-col gap-0.5">
                      <Badge tone="ok">已恢复</Badge>
                      <span className="muted text-[11px]" title={formatDateTime(event.resolvedAt)}>
                        {formatRelative(event.resolvedAt)}
                      </span>
                    </span>
                  ) : (
                    <span className="inline-flex flex-col gap-0.5">
                      <Badge tone={event.severity === 'critical' ? 'bad' : 'warn'} dot pulse>
                        未恢复
                      </Badge>
                      <span className="muted text-[11px]">自 {formatRelative(event.firedAt)}</span>
                    </span>
                  )}
                </td>
                <td className="muted py-2.5 pr-3 whitespace-nowrap">
                  {formatDateTime(event.firedAt)}
                </td>
                <td className="py-2.5 pr-3 whitespace-nowrap">
                  {/* 重开次数 = 静默期内同一 (规则, 目标) 又被触发的次数 */}
                  {event.reopenCount > 0 ? (
                    <span className="text-amber-600 dark:text-amber-300">重开 {event.reopenCount} 次</span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td className="muted py-2.5 pr-3 whitespace-nowrap">
                  {event.acknowledgedAt ? (
                    <span title={event.acknowledgedBy ? `由 ${event.acknowledgedBy} 确认` : undefined}>
                      已确认 · {formatDateTime(event.acknowledgedAt)}
                    </span>
                  ) : (
                    '未确认'
                  )}
                </td>
                {isAdmin ? (
                  <td className="py-2.5">
                    {event.acknowledgedAt ? (
                      <span className="muted">—</span>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost px-2 py-1 text-[11px]"
                        disabled={acknowledgingId === event.id}
                        onClick={() => onAcknowledge(event)}
                      >
                        {acknowledgingId === event.id ? '确认中…' : '确认'}
                      </button>
                    )}
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}