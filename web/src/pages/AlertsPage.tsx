/**
 * 告警页（`/alerts` · Sprint 2 · S2-04）。
 *
 * 权限分层（**前端隐藏 ≠ 后端允许**，后端会独立拒绝，这里只是不误导用户）：
 * - viewer：事件列表 + 计数 + 规则**只读**列表；
 * - admin：额外的「编辑规则」入口（阈值/持续时长/静默周期/恢复通知/开关）
 *   与每条未确认事件的「确认」按钮。
 *
 * 关于"为什么 viewer 也能看到规则列表"：`GET /api/alerts/rules` 在 §7 里是
 * **viewer 角色**端点 —— 只读展示不会泄露任何敏感信息，而"规则长什么样"
 * 恰恰是理解告警的必要上下文；写入口（PATCH / ack）才是 admin 专属。
 */
import { useCallback, useState, type ReactNode } from 'react';
import {
  EMPTY_ALERT_COUNTS,
  describeAlertKind,
  describeDuration,
  describeSeverity,
  ruleThresholdText,
  type AlertEventQueryState,
  type AlertEventView,
  type AlertRuleView,
} from '../api/alerts.js';
import { AlertEventList } from '../components/AlertEventList.js';
import { AlertRuleForm } from '../components/AlertRuleForm.js';
import { Modal } from '../components/Modal.js';
import { Badge, Card, ErrorNotice, Icon, Spinner } from '../components/ui.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useAsync, useSubmit } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';

const STATE_FILTERS: readonly { value: AlertEventQueryState; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '未恢复' },
  { value: 'resolved', label: '已恢复' },
];

export function AlertsPage(): ReactNode {
  const { api, isAdmin } = useAuth();
  const [state, setState] = useState<AlertEventQueryState>('all');
  const [editing, setEditing] = useState<AlertRuleView | null>(null);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const { submit, error: submitError } = useSubmit();

  const eventsLoader = useCallback(() => api.alertEvents({ state, limit: 100 }), [api, state]);
  const events = useAsync(eventsLoader, { refreshIntervalMs: 30_000 });

  // `GET /api/alerts/rules` 的响应由 §7 冻结为 `{ items }`：直接取，不做宽容解析
  const rulesLoader = useCallback(() => api.alertRules(), [api]);
  const rules = useAsync(rulesLoader, { refreshIntervalMs: 60_000 });
  const ruleItems = rules.data?.items ?? [];

  const counts = events.data?.counts ?? EMPTY_ALERT_COUNTS;
  const items = events.data?.items ?? [];

  const onAcknowledge = (event: AlertEventView): void => {
    setAcknowledgingId(event.id);
    void submit(async () => {
      await api.acknowledgeAlertEvent(event.id);
      // 确认后重取：计数与"已确认"列必须立刻反映真实状态，不能靠本地乐观更新
      await events.reload();
    }).finally(() => setAcknowledgingId(null));
  };

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">告警</p>
          <p className="muted mt-0.5 text-xs">
            站内事件与规则；本 Sprint 不发出任何外部通知，也不自动修复
          </p>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void events.reload()} disabled={events.loading}>
          <Icon name="refresh" className="size-3.5" />
          刷新
        </button>
      </div>

      {/* 计数条：viewer 也能看（只读页面） */}
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={counts.open > 0 ? 'warn' : 'idle'} dot pulse={counts.open > 0}>
          未恢复 {counts.open}
        </Badge>
        <Badge tone="ok">已恢复 {counts.resolved}</Badge>
        <Badge tone={counts.unacknowledged > 0 ? 'bad' : 'idle'}>未确认 {counts.unacknowledged}</Badge>
        {isAdmin ? null : <span className="muted text-[11px]">只读视角：修改规则与确认告警需要管理员权限</span>}
      </div>

      {submitError ? <ErrorNotice message={submitError} /> : null}
      {events.error ? <ErrorNotice message={events.error} onRetry={() => void events.reload()} /> : null}

      {/* 事件列表 */}
      <Card
        title="告警事件"
        subtitle="同一规则同一目标的一次故障是一条事件（恢复后静默期内重开同一行）"
        actions={
          <div className="flex items-center gap-1">
            {STATE_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                className={`btn px-2.5 py-1 text-[11px] ${state === filter.value ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={state === filter.value}
                onClick={() => setState(filter.value)}
              >
                {filter.label}
              </button>
            ))}
          </div>
        }
      >
        {events.loading && !events.loaded ? (
          <Spinner label="正在加载告警事件…" />
        ) : (
          <AlertEventList
            items={items}
            isAdmin={isAdmin}
            acknowledgingId={acknowledgingId}
            onAcknowledge={onAcknowledge}
          />
        )}
      </Card>

      {/* 规则列表：所有人可读，admin 才有编辑入口 */}
      <Card
        title="告警规则"
        subtitle="内置四条默认关闭（装了但不吵）；开启后才参与评估"
        actions={rules.loading && !rules.loaded ? <Spinner label="读取规则…" /> : null}
      >
        {rules.error ? <ErrorNotice message={rules.error} onRetry={() => void rules.reload()} /> : null}
        <div data-testid="alert-rules" className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
            <caption className="sr-only">告警规则列表：类型、开关状态、阈值、持续时长与静默周期</caption>
            <thead>
              <tr className="muted border-b border-slate-200/70 text-[11px] dark:border-white/8">
                <th scope="col" className="py-2 pr-3 font-medium">规则</th>
                <th scope="col" className="py-2 pr-3 font-medium">类型</th>
                <th scope="col" className="py-2 pr-3 font-medium">状态</th>
                <th scope="col" className="py-2 pr-3 font-medium">阈值</th>
                <th scope="col" className="py-2 pr-3 font-medium">持续时长</th>
                <th scope="col" className="py-2 pr-3 font-medium">静默周期</th>
                <th scope="col" className="py-2 pr-3 font-medium">严重度</th>
                {isAdmin ? <th scope="col" className="py-2 font-medium">操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {(ruleItems).map((rule) => {
                const severity = describeSeverity(rule.severity);
                return (
                  <tr key={rule.id} data-alert-rule-id={rule.id} className="border-b border-slate-200/60 dark:border-white/6">
                    <td className="py-2.5 pr-3">
                      <p className="font-medium">{rule.name}</p>
                      <p className="muted text-[11px]">{rule.description}</p>
                    </td>
                    <td className="muted py-2.5 pr-3 whitespace-nowrap">{describeAlertKind(rule.kind)}</td>
                    <td className="py-2.5 pr-3">
                      {rule.enabled ? (
                        <Badge tone="ok" dot>
                          启用中
                        </Badge>
                      ) : (
                        <Badge tone="idle">已关闭</Badge>
                      )}
                    </td>
                    <td className="py-2.5 pr-3 whitespace-nowrap">{ruleThresholdText(rule)}</td>
                    <td className="muted py-2.5 pr-3 whitespace-nowrap">{describeDuration(rule.durationSec)}</td>
                    <td className="muted py-2.5 pr-3 whitespace-nowrap">{describeDuration(rule.silenceSec)}</td>
                    <td className="py-2.5 pr-3">
                      <Badge tone={severity.tone}>{severity.label}</Badge>
                    </td>
                    {isAdmin ? (
                      <td className="py-2.5">
                        <button
                          type="button"
                          className="btn btn-ghost px-2 py-1 text-[11px]"
                          aria-label={`编辑规则 ${rule.name}`}
                          onClick={() => setEditing(rule)}
                        >
                          编辑规则
                        </button>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!rules.loading && ruleItems.length === 0 && !rules.error ? (
          <p className="muted mt-3 text-xs">没有读到规则（后端会在启动时补齐四条内置规则）。</p>
        ) : null}
      </Card>

      {/* 规则编辑（admin）：复用 Modal 与 ServiceForm 的字段规范 */}
      <Modal
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing ? `编辑规则：${editing.name}` : '编辑规则'}
        description="改动只提交被修改过的字段（PATCH 部分更新）"
      >
        {editing ? (
          <AlertRuleForm
            rule={editing}
            onCancel={() => setEditing(null)}
            onSaved={async () => {
              setEditing(null);
              await rules.reload();
            }}
          />
        ) : null}
      </Modal>
    </Shell>
  );
}