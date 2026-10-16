/**
 * 告警规则编辑表单（Sprint 2 · S2-04，**admin 专用**）。
 *
 * 与 `ServiceForm` 同一套规范与视觉（这是硬要求，不是巧合）：
 * - 每个输入都有 `<label htmlFor>` 与稳定 id（`alert-rule-<id>-threshold` 等），E2E 可寻址；
 * - 非法值**就地**提示（`aria-invalid` + `aria-describedby` + `role="alert"`）并禁用保存，
 *   后端仍会独立校验（§5.1：越界一律 `VALIDATION_FAILED`，不静默截断）；
 * - 顶部错误条 + 字段级错误两处都显示。
 *
 * 两个刻意的设计：
 * 1. **PATCH 只发改动过的字段**（`rulePatchFrom`）：与设置面板同一思路 ——
 *    "把某字段改回默认"与"从未碰过该字段"语义分明，也避免把整行回写覆盖别人的改动。
 * 2. **阈值/持续时长的边界在本地就先拦**：后端拒绝是底线，让用户在点保存前
 *    就看见"阈值必须 ≤ 100"才是体验。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import {
  describeAlertKind,
  type AlertKind,
  type AlertRulePatch,
  type AlertRuleView,
} from '../api/alerts.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useSubmit } from '../hooks/useAsync.js';
import { ErrorNotice } from './ui.js';

/** 每种规则类型可编辑的字段（`fixed` = 阈值不可编辑，如 `container_exit`）。 */
export interface RuleFieldSpec {
  threshold: 'percent' | 'count' | 'fixed';
  /** 是否可编辑"持续时长"（容器退出/服务失败是瞬时判定，没有持续时间概念） */
  duration: boolean;
  thresholdMin: number;
  thresholdMax: number;
  thresholdInteger: boolean;
}

/** §5.1 的阈值校验范围，逐条对应用户能看到的输入。 */
export function ruleFieldSpec(kind: AlertKind): RuleFieldSpec {
  switch (kind) {
    case 'disk_percent':
    case 'memory_percent':
      return { threshold: 'percent', duration: true, thresholdMin: 0, thresholdMax: 100, thresholdInteger: false };
    case 'service_health':
      // 连续失败次数：整数 1–10
      return { threshold: 'count', duration: false, thresholdMin: 1, thresholdMax: 10, thresholdInteger: true };
    case 'container_exit':
      // 非 0 退出码即触发，不设百分比；阈值固定 0
      return { threshold: 'fixed', duration: false, thresholdMin: 0, thresholdMax: 0, thresholdInteger: true };
  }
}

/** 表单草稿（数字已解析；解析失败时为 NaN，由校验器报错）。 */
export interface RuleDraft {
  enabled: boolean;
  threshold: number;
  durationSec: number;
  silenceSec: number;
  notifyRecovery: boolean;
}

/** 本地校验（与后端 §5.1 同一套范围）；返回字段 → 错误文案。 */
export function validateRuleDraft(kind: AlertKind, draft: RuleDraft): Record<string, string[]> {
  const spec = ruleFieldSpec(kind);
  const errors: Record<string, string[]> = {};

  if (spec.threshold !== 'fixed') {
    const { threshold } = draft;
    if (!Number.isFinite(threshold)) {
      errors.threshold = ['阈值必须是数字'];
    } else if (spec.thresholdInteger && !Number.isInteger(threshold)) {
      errors.threshold = ['阈值必须是整数'];
    } else if (threshold <= spec.thresholdMin || threshold > spec.thresholdMax) {
      errors.threshold =
        spec.threshold === 'percent'
          ? [`阈值必须大于 ${spec.thresholdMin} 且不超过 ${spec.thresholdMax}（单位 %）`]
          : [`阈值必须在 ${spec.thresholdMin}–${spec.thresholdMax} 之间`];
    }
  }

  if (spec.duration) {
    if (!Number.isFinite(draft.durationSec) || draft.durationSec < 0 || draft.durationSec > 86400) {
      errors.durationSec = ['持续时长必须在 0–86400 秒之间（0 = 条件成立即触发）'];
    }
  }

  if (!Number.isFinite(draft.silenceSec) || draft.silenceSec < 60 || draft.silenceSec > 604800) {
    errors.silenceSec = ['静默周期必须在 60–604800 秒（7 天）之间'];
  }

  return errors;
}

/** 只保留**相对原规则有改动**的字段（PATCH 语义：没传 = 不动）。 */
export function rulePatchFrom(rule: AlertRuleView, draft: RuleDraft): AlertRulePatch {
  const spec = ruleFieldSpec(rule.kind);
  const patch: AlertRulePatch = {};

  if (draft.enabled !== rule.enabled) patch.enabled = draft.enabled;
  if (spec.threshold !== 'fixed' && draft.threshold !== rule.threshold) patch.threshold = draft.threshold;
  if (spec.duration && draft.durationSec !== rule.durationSec) patch.durationSec = draft.durationSec;
  if (draft.silenceSec !== rule.silenceSec) patch.silenceSec = draft.silenceSec;
  if (draft.notifyRecovery !== rule.notifyRecovery) patch.notifyRecovery = draft.notifyRecovery;

  return patch;
}

export interface AlertRuleFormProps {
  rule: AlertRuleView;
  /** 保存成功后的回调（父组件负责 reload 与关闭弹窗） */
  onSaved: () => void | Promise<void>;
  onCancel: () => void;
}

export function AlertRuleForm({ rule, onSaved, onCancel }: AlertRuleFormProps): ReactNode {
  const { api } = useAuth();
  const { submit, submitting, error, fieldErrors } = useSubmit();
  const spec = ruleFieldSpec(rule.kind);

  const [enabled, setEnabled] = useState(rule.enabled);
  const [threshold, setThreshold] = useState(rule.threshold === null ? '' : String(rule.threshold));
  const [durationSec, setDurationSec] = useState(String(rule.durationSec));
  const [silenceSec, setSilenceSec] = useState(String(rule.silenceSec));
  const [notifyRecovery, setNotifyRecovery] = useState(rule.notifyRecovery);

  const draft: RuleDraft = {
    enabled,
    threshold: threshold.trim() === '' ? Number.NaN : Number(threshold),
    durationSec: durationSec.trim() === '' ? Number.NaN : Number(durationSec),
    silenceSec: silenceSec.trim() === '' ? Number.NaN : Number(silenceSec),
    notifyRecovery,
  };

  const localErrors = validateRuleDraft(rule.kind, draft);
  const errorFor = (field: string): string[] => [...(localErrors[field] ?? []), ...(fieldErrors[field] ?? [])];
  const canSubmit =
    Object.keys(localErrors).length === 0 &&
    errorFor('threshold').length === 0 &&
    errorFor('durationSec').length === 0 &&
    errorFor('silenceSec').length === 0;

  const thresholdId = `alert-rule-${rule.id}-threshold`;
  const durationId = `alert-rule-${rule.id}-duration`;
  const silenceId = `alert-rule-${rule.id}-silence`;

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) return;
    void submit(async () => {
      const patch = rulePatchFrom(rule, draft);
      // 没有任何改动就别发请求：空 PATCH 只会污染审计日志
      if (Object.keys(patch).length > 0) await api.updateAlertRule(rule.id, patch);
      await onSaved();
    });
  };

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {error ? <ErrorNotice message={error} /> : null}

      <p className="muted rounded-xl bg-slate-500/8 px-3 py-2 text-[11px] leading-relaxed">
        {describeAlertKind(rule.kind)}
        {rule.builtin ? ' · 内置规则（不可删除，可开关与改阈值）' : ''}
        {rule.target ? ` · 仅适用于 ${rule.target}` : ' · 适用于全部目标'}
      </p>

      {/* 启用开关 */}
      <div className="flex items-start gap-2.5">
        <input
          id={`alert-rule-${rule.id}-enabled`}
          type="checkbox"
          className="mt-0.5 size-4"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        <div>
          <label className="text-xs font-medium" htmlFor={`alert-rule-${rule.id}-enabled`}>
            启用
          </label>
          <p className="muted mt-0.5 text-[11px]">关闭时该规则完全不评估（内置规则默认关闭：装了但不吵）</p>
        </div>
      </div>

      {/* 阈值 */}
      {spec.threshold === 'fixed' ? (
        <div>
          <p className="label">阈值</p>
          <p className="muted text-[11px] leading-relaxed">
            固定为 0：非 0 退出码即触发（容器异常退出不设百分比阈值）
          </p>
        </div>
      ) : (
        <div>
          <label className="label" htmlFor={thresholdId}>
            阈值
          </label>
          <input
            id={thresholdId}
            className="input font-mono"
            type="number"
            step={spec.thresholdInteger ? 1 : 0.1}
            value={threshold}
            onChange={(event) => setThreshold(event.target.value)}
            aria-invalid={errorFor('threshold').length > 0}
            aria-describedby={`${thresholdId}-hint ${thresholdId}-error`}
          />
          <p id={`${thresholdId}-hint`} className="muted mt-1.5 text-[11px]">
            {spec.threshold === 'percent'
              ? '单位 %：必须 > 0 且 ≤ 100'
              : '连续失败次数：1–10 的整数（由健康状态机给出）'}
          </p>
          <FieldError id={`${thresholdId}-error`} messages={errorFor('threshold')} />
        </div>
      )}

      {/* 持续时长 */}
      {spec.duration ? (
        <div>
          <label className="label" htmlFor={durationId}>
            持续时长
          </label>
          <input
            id={durationId}
            className="input font-mono"
            type="number"
            step={1}
            value={durationSec}
            onChange={(event) => setDurationSec(event.target.value)}
            aria-invalid={errorFor('durationSec').length > 0}
            aria-describedby={`${durationId}-hint ${durationId}-error`}
          />
          <p id={`${durationId}-hint`} className="muted mt-1.5 text-[11px]">
            单位：秒（0–86400）。条件需持续这么久才判定为告警，短暂抖动不会告警
          </p>
          <FieldError id={`${durationId}-error`} messages={errorFor('durationSec')} />
        </div>
      ) : (
        <div>
          <p className="label">持续时长</p>
          <p className="muted text-[11px]">不适用：该规则是瞬时判定（事件本身已经说明发生了什么）</p>
        </div>
      )}

      {/* 静默周期 */}
      <div>
        <label className="label" htmlFor={silenceId}>
          静默周期
        </label>
        <input
          id={silenceId}
          className="input font-mono"
          type="number"
          step={1}
          value={silenceSec}
          onChange={(event) => setSilenceSec(event.target.value)}
          aria-invalid={errorFor('silenceSec').length > 0}
          aria-describedby={`${silenceId}-hint ${silenceId}-error`}
        />
        <p id={`${silenceId}-hint`} className="muted mt-1.5 text-[11px] leading-relaxed">
          单位：秒（60–604800）。同一故障在此时间内再次触发会重开同一条事件（累加重开次数），
          而不是刷出第二条 —— 这就是"一小时内不重复刷屏"的落地方式
        </p>
        <FieldError id={`${silenceId}-error`} messages={errorFor('silenceSec')} />
      </div>

      {/* 恢复通知 */}
      <div className="flex items-start gap-2.5">
        <input
          id={`alert-rule-${rule.id}-notify-recovery`}
          type="checkbox"
          className="mt-0.5 size-4"
          checked={notifyRecovery}
          onChange={(event) => setNotifyRecovery(event.target.checked)}
        />
        <div>
          <label className="text-xs font-medium" htmlFor={`alert-rule-${rule.id}-notify-recovery`}>
            恢复通知
          </label>
          <p className="muted mt-0.5 text-[11px]">条件解除时也记录一条恢复事件（本 Sprint 只有站内事件，无出站通知）</p>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-200/70 pt-3.5 dark:border-white/8">
        <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={submitting}>
          取消
        </button>
        <button type="submit" className="btn btn-primary" disabled={submitting || !canSubmit}>
          {submitting ? '保存中…' : '保存'}
        </button>
      </div>
    </form>
  );
}

/** 字段级错误（与 `ServiceForm` 的 `FieldError` 同一套视觉与 `role="alert"`）。 */
function FieldError({ id, messages }: { id: string; messages: string[] }): ReactNode {
  if (messages.length === 0) return null;
  return (
    <p
      id={id}
      role="alert"
      className="mt-2 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-600 ring-1 ring-rose-500/25 dark:text-rose-300"
    >
      {messages.join('；')}
    </p>
  );
}