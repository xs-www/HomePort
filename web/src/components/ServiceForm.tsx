/**
 * 服务编辑/新建表单（管理页与首页的「新建服务 / 编辑」共用）。
 *
 * 三条硬要求：
 * 1. **输入 id 固定**（`#service-name` / `#service-description` / `#service-icon` / `#service-category` /
 *    `#service-url` / `#service-health-path` / `#service-health-target`），每个都有 `<label htmlFor>`
 *    —— E2E 与单测依赖这些选择器；
 * 2. **危险链接在本地就能看出来**：`preferredUrl` / `healthTarget` 只允许 http/https，
 *    `icon` 只允许内置键或 `https://`；非法值就地提示并禁用保存（后端仍会独立校验）；
 * 3. **后端字段错误必须显示出来**：`ApiError.fieldErrors` 逐个挂到对应输入上
 *    （`aria-invalid` + `aria-describedby`，范式照 `LoginPage`）。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import type { ServiceCreateRequest, ServiceUpdateRequest, ServiceView } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { useSubmit } from '../hooks/useAsync.js';
import { isServiceIconName, isServiceIconUrl, SERVICE_ICON_NAMES, ServiceIcon } from './ServiceIcon.js';
import { ErrorNotice } from './ui.js';

/** 分类建议值（自由文本，仅作候选）。 */
const CATEGORY_SUGGESTIONS = ['家庭', '开发', '媒体', '网络', '基础设施', '项目', '工具'];

/** 只接受 http/https：`javascript:`、`data:`、`file:` 等一律视为危险链接。 */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\/\S+$/i.test(value.trim());
}

const URL_HINT = '只允许 http/https 链接（javascript:、data:、file: 等会被后端拒绝）';

export interface ServiceFormProps {
  /** 编辑时传入现有服务；新建时为 `null` */
  service?: ServiceView | null;
  /** 保存成功后的回调（父组件负责 reload 与关闭弹窗） */
  onSaved: () => void | Promise<void>;
  /** 取消 */
  onCancel: () => void;
}

export function ServiceForm({ service = null, onSaved, onCancel }: ServiceFormProps): ReactNode {
  const { api } = useAuth();
  const { submit, submitting, error, fieldErrors } = useSubmit();
  const editing = service !== null;

  const [displayName, setDisplayName] = useState(service?.displayName ?? '');
  const [description, setDescription] = useState(service?.description ?? '');
  const [icon, setIcon] = useState(service?.icon ?? '');
  const [category, setCategory] = useState(service?.category ?? '');
  const [preferredUrl, setPreferredUrl] = useState(service?.preferredUrl ?? '');
  const [healthPath, setHealthPath] = useState(service?.healthPath ?? '');
  const [healthTarget, setHealthTarget] = useState(service?.healthTarget ?? '');

  const iconValue = icon.trim();
  const iconIsBuiltin = iconValue === '' || isServiceIconName(iconValue);
  const iconIsUrl = isServiceIconUrl(iconValue);
  const iconInvalid = !iconIsBuiltin && !iconIsUrl;

  const preferredUrlInvalid = preferredUrl.trim() !== '' && !isHttpUrl(preferredUrl);
  const healthTargetInvalid = healthTarget.trim() !== '' && !isHttpUrl(healthTarget);

  const canSubmit = displayName.trim() !== '' && !iconInvalid && !preferredUrlInvalid && !healthTargetInvalid;

  const fieldError = (key: string): string[] => fieldErrors[key] ?? [];

  const onSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSubmit) return;

    const displayNameValue = displayName.trim();
    const descriptionValue = description.trim();
    const categoryValue = category.trim();
    const preferredUrlValue = preferredUrl.trim();
    const healthTargetValue = healthTarget.trim();
    const healthPathValue = healthPath.trim();

    void submit(async () => {
      if (editing && service) {
        // PATCH：`null` 表示"清空该字段"（与"没传"区分开），后端 schema 明确接受 null
        const patch: ServiceUpdateRequest = {
          displayName: displayNameValue,
          description: descriptionValue === '' ? null : descriptionValue,
          icon: iconValue === '' ? null : iconValue,
          category: categoryValue === '' ? null : categoryValue,
          preferredUrl: preferredUrlValue === '' ? null : preferredUrlValue,
          healthTarget: healthTargetValue === '' ? null : healthTargetValue,
          healthPath: healthPathValue === '' ? null : healthPathValue,
        };
        await api.updateService(service.id, patch);
      } else {
        // POST：后端创建 schema 的可选字段**不接受 null**，空值必须整个省略该键
        const payload: ServiceCreateRequest = { displayName: displayNameValue };
        if (descriptionValue !== '') payload.description = descriptionValue;
        if (iconValue !== '') payload.icon = iconValue;
        if (categoryValue !== '') payload.category = categoryValue;
        if (preferredUrlValue !== '') payload.preferredUrl = preferredUrlValue;
        if (healthTargetValue !== '') payload.healthTarget = healthTargetValue;
        if (healthPathValue !== '') payload.healthPath = healthPathValue;
        await api.createService(payload);
      }
      await onSaved();
    });
  };

  return (
    <form className="space-y-4" onSubmit={onSubmit} noValidate>
      {error ? <ErrorNotice message={error} /> : null}

      {/* 名称 */}
      <div>
        <label className="label" htmlFor="service-name">
          名称
        </label>
        <input
          id="service-name"
          className="input"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          placeholder="家庭日历"
          aria-invalid={fieldError('displayName').length > 0}
          aria-describedby="service-name-hint service-name-error"
        />
        <p id="service-name-hint" className="muted mt-1.5 text-[11px]">
          用户看到的服务名（自动发现的默认名可被覆盖）
        </p>
        <FieldError id="service-name-error" messages={fieldError('displayName')} />
      </div>

      {/* 描述 */}
      <div>
        <label className="label" htmlFor="service-description">
          描述
        </label>
        <input
          id="service-description"
          className="input"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="家庭共享日历"
          aria-invalid={fieldError('description').length > 0}
          aria-describedby="service-description-hint service-description-error"
        />
        <p id="service-description-hint" className="muted mt-1.5 text-[11px]">
          可选，显示在卡片名称下方
        </p>
        <FieldError id="service-description-error" messages={fieldError('description')} />
      </div>

      {/* 图标：内置键或 https 地址 */}
      <div>
        <label className="label" htmlFor="service-icon">
          图标
        </label>
        <div className="flex items-center gap-2">
          <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-sky-500/12 text-sky-600 dark:text-sky-300">
            <ServiceIcon icon={iconValue} className="size-5" />
          </span>
          <input
            id="service-icon"
            className="input"
            list="service-icon-options"
            value={icon}
            onChange={(event) => setIcon(event.target.value)}
            placeholder="calendar 或 https://example.com/icon.png"
            aria-invalid={iconInvalid || fieldError('icon').length > 0}
            aria-describedby="service-icon-hint service-icon-error"
          />
        </div>
        <datalist id="service-icon-options">
          {SERVICE_ICON_NAMES.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <p id="service-icon-hint" className="muted mt-1.5 text-[11px] leading-relaxed">
          内置图标键（如 <span className="font-mono">calendar</span>）或 <span className="font-mono">https://</span> 图标地址；
          外部图标需在 <span className="font-mono">PORTAL_CSP</span> 的 img-src 中放行其来源，否则会被浏览器拦截。
        </p>
        {iconInvalid ? (
          <p id="service-icon-error" role="alert" className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300">
            图标只能是内置键或 https:// 地址（http:、data:、javascript: 都不允许）
          </p>
        ) : (
          <FieldError id="service-icon-error" messages={fieldError('icon')} />
        )}
      </div>

      {/* 分类 */}
      <div>
        <label className="label" htmlFor="service-category">
          分类
        </label>
        <input
          id="service-category"
          className="input"
          list="service-category-options"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
          placeholder="家庭"
          aria-invalid={fieldError('category').length > 0}
          aria-describedby="service-category-hint service-category-error"
        />
        <datalist id="service-category-options">
          {CATEGORY_SUGGESTIONS.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <p id="service-category-hint" className="muted mt-1.5 text-[11px]">
          自由文本，留空即"未分类"（服务墙上排在最后）
        </p>
        <FieldError id="service-category-error" messages={fieldError('category')} />
      </div>

      {/* 首选入口 */}
      <div>
        <label className="label" htmlFor="service-url">
          首选入口
        </label>
        <input
          id="service-url"
          className="input font-mono"
          value={preferredUrl}
          onChange={(event) => setPreferredUrl(event.target.value)}
          placeholder="https://family-nas.tail585599.ts.net:8443/calendar"
          aria-invalid={preferredUrlInvalid || fieldError('preferredUrl').length > 0}
          aria-describedby="service-url-hint service-url-error"
        />
        <p id="service-url-hint" className="muted mt-1.5 text-[11px] leading-relaxed">
          最高优先级入口（rank 0），保存后显示在卡片顶部。
        </p>
        {preferredUrlInvalid ? (
          <p id="service-url-error" role="alert" className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300">
            {URL_HINT}
          </p>
        ) : (
          <FieldError id="service-url-error" messages={fieldError('preferredUrl')} />
        )}
      </div>

      {/* 健康路径 */}
      <div>
        <label className="label" htmlFor="service-health-path">
          健康路径
        </label>
        <input
          id="service-health-path"
          className="input font-mono"
          value={healthPath}
          onChange={(event) => setHealthPath(event.target.value)}
          placeholder="/healthz"
          aria-invalid={fieldError('healthPath').length > 0}
          aria-describedby="service-health-path-hint service-health-path-error"
        />
        <p id="service-health-path-hint" className="muted mt-1.5 text-[11px]">
          追加到首选入口后面的路径（如 <span className="font-mono">/healthz</span>）
        </p>
        <FieldError id="service-health-path-error" messages={fieldError('healthPath')} />
      </div>

      {/* 健康探测目标 */}
      <div>
        <label className="label" htmlFor="service-health-target">
          健康探测目标
        </label>
        <input
          id="service-health-target"
          className="input font-mono"
          value={healthTarget}
          onChange={(event) => setHealthTarget(event.target.value)}
          placeholder="http://127.0.0.1:36065/health"
          aria-invalid={healthTargetInvalid || fieldError('healthTarget').length > 0}
          aria-describedby="service-health-target-hint service-health-target-error"
        />
        <p id="service-health-target-hint" className="muted mt-1.5 text-[11px] leading-relaxed">
          可选。只在管理员点击"健康检查"时探测；云元数据地址（169.254.169.254 等）一律被拒绝。
        </p>
        {healthTargetInvalid ? (
          <p id="service-health-target-error" role="alert" className="mt-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300">
            {URL_HINT}
          </p>
        ) : (
          <FieldError id="service-health-target-error" messages={fieldError('healthTarget')} />
        )}
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

/** 字段级错误（后端 `fieldErrors`）：带 `role="alert"` 以便读屏立即播报。 */
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