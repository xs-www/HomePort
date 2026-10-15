/**
 * 系统设置面板（管理员）。
 *
 * 设计要点：
 * 1. **诚实标注生效级别**：`立即生效` / `需重建容器`。后者不给编辑控件，
 *    只展示当前值并说明原因 —— 否则管理员会改了一个改不动的值还以为生效了。
 * 2. **先测再存**：Tailscale Token 可以点「测试连接」验证后再保存，
 *    避免把错值写进数据库后只看到"数据源不可用"。
 * 3. **局部编辑**：只提交被改动过的项，未动的项不进入请求体，
 *    这样"清空某字段"与"从未修改该字段"语义分明。
 * 4. 敏感项显示打码值；不修改时不会被提交（服务端也把占位符视为"不修改"）。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthProvider.js';
import { Badge, Card, ErrorNotice, Icon, Skeleton } from '../../components/ui.js';
import { useAsync } from '../../hooks/useAsync.js';
import { formatRelative } from '../../lib/format.js';
import type { SettingView, TailscaleTestResponse } from '../../api/types.js';

/** 生效级别 → 徽标。 */
const EFFECT_BADGE: Record<SettingView['effect'], { tone: 'ok' | 'warn' | 'idle'; label: string; hint: string }> = {
  live: { tone: 'ok', label: '立即生效', hint: '保存后下次读取即生效，无需任何额外操作' },
  reload: { tone: 'ok', label: '立即生效', hint: '保存后会自动重建对应数据源连接' },
  restart: { tone: 'warn', label: '需重建容器', hint: '属于容器创建参数，无法在界面中修改' },
};

/** 来源 → 展示文案。 */
const SOURCE_LABEL: Record<SettingView['source'], string> = {
  default: '内置默认',
  env: '环境变量',
  database: '界面设置',
};

/** 表单里的原始字符串值（提交前按类型转换）。 */
type DraftValue = string | boolean;

export function SettingsPanel(): ReactNode {
  const { api } = useAuth();
  const load = useCallback(() => api.settings(), [api]);
  const { data, loading, error, reload } = useAsync(load);

  /** 只有被改动过的项才进入这里 */
  const [draft, setDraft] = useState<Record<string, DraftValue>>({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TailscaleTestResponse | null>(null);

  // 数据刷新后清空草稿（服务端已是权威值）
  useEffect(() => {
    setDraft({});
    setInvalid({});
    setSaveMessage(null);
  }, [data?.version]);

  const byGroup = useMemo(() => {
    const map = new Map<string, SettingView[]>();
    for (const setting of data?.settings ?? []) {
      const list = map.get(setting.group) ?? [];
      list.push(setting);
      map.set(setting.group, list);
    }
    return map;
  }, [data]);

  const dirtyKeys = Object.keys(draft);

  /** 取某设置项当前应显示的值（草稿优先）。 */
  const displayValue = (setting: SettingView): DraftValue => {
    const drafted = draft[setting.key];
    if (drafted !== undefined) return drafted;
    if (setting.valueType === 'boolean') return setting.value === true;
    if (setting.valueType === 'string-list') {
      // 数组/对象统一转成逗号分隔文本展示
      if (Array.isArray(setting.value)) return (setting.value as string[]).join(',');
      return setting.value === null || setting.value === undefined ? '' : String(setting.value);
    }
    return setting.value === null || setting.value === undefined ? '' : String(setting.value);
  };

  const setValue = (setting: SettingView, value: DraftValue): void => {
    setDraft((prev) => ({ ...prev, [setting.key]: value }));
    setInvalid((prev) => {
      if (!(setting.key in prev)) return prev;
      const next = { ...prev };
      delete next[setting.key];
      return next;
    });
  };

  /** 把草稿按设置项类型转换成提交值。 */
  const buildPayload = (): Record<string, unknown> => {
    const payload: Record<string, unknown> = {};
    for (const key of dirtyKeys) {
      const setting = data?.settings.find((item) => item.key === key);
      if (!setting) continue;
      const raw = draft[key];
      if (setting.valueType === 'boolean') payload[key] = raw === true;
      else if (setting.valueType === 'number') payload[key] = Number(raw);
      else payload[key] = String(raw ?? '');
    }
    return payload;
  };

  const save = async (): Promise<void> => {
    if (dirtyKeys.length === 0) return;
    setSaving(true);
    setSaveError(null);
    setSaveMessage(null);
    setInvalid({});
    try {
      const result = await api.updateSettings(buildPayload());
      if (result.invalid.length > 0) {
        setInvalid(Object.fromEntries(result.invalid.map((item) => [item.key, item.error])));
      }
      if (result.rejectedRestartKeys.length > 0) {
        setSaveError(`以下项需要重建容器，已忽略：${result.rejectedRestartKeys.join(', ')}`);
      }
      const appliedParts: string[] = [];
      if (result.updatedKeys.length > 0) appliedParts.push(`已保存 ${result.updatedKeys.length} 项`);
      if (result.reloaded.tailscale) appliedParts.push('tailnet 数据源已重建');
      if (result.reloaded.docker) appliedParts.push('Docker 连接已重建');
      setSaveMessage(appliedParts.length > 0 ? appliedParts.join('，') : null);
      // 用响应里的最新视图更新界面（避免二次请求）
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (): Promise<void> => {
    setTesting(true);
    setTestResult(null);
    try {
      // 带上草稿里的 Token（若已填写且未被打码），实现"先测再存"
      const drafted = draft['PORTAL_TAILSCALE_API_TOKEN'];
      const candidate = typeof drafted === 'string' && drafted !== '' ? drafted : undefined;
      setTestResult(await api.testTailscale(candidate));
    } catch (err) {
      setTestResult({
        ok: false,
        mode: 'api',
        source: { available: false, mode: 'none', detail: null },
        deviceCount: null,
        onlineCount: null,
        devices: [],
        message: err instanceof Error ? err.message : '测试失败',
      });
    } finally {
      setTesting(false);
    }
  };

  const resetAll = async (): Promise<void> => {
    if (!confirm('确认把所有设置恢复为环境变量或内置默认值？界面里保存过的内容会丢失。')) return;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await api.resetSettings();
      setSaveMessage(`已重置 ${result.removed} 项，界面已刷新`);
      await reload();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '重置失败');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <Card title="系统设置">
        <Skeleton rows={6} />
      </Card>
    );
  }

  return (
    <>
      {/* 顶部操作条 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-xs">
          这里的修改保存在数据库中，优先级高于 <code className="font-mono">.env</code>。
          未修改的项仍按 <code className="font-mono">.env</code> 或内置默认值生效。
        </p>
        <div className="flex items-center gap-2">
          {dirtyKeys.length > 0 ? <Badge tone="warn">{dirtyKeys.length} 项待保存</Badge> : null}
          <button type="button" className="btn btn-ghost" onClick={() => void resetAll()} disabled={saving}>
            恢复默认
          </button>
          <button type="button" className="btn btn-primary" onClick={() => void save()} disabled={saving || dirtyKeys.length === 0}>
            {saving ? '保存中…' : '保存修改'}
          </button>
        </div>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}
      {saveError ? <ErrorNotice message={saveError} /> : null}
      {saveMessage ? (
        <p className="rounded-xl bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 ring-1 ring-emerald-500/25 dark:text-emerald-300">
          {saveMessage}
        </p>
      ) : null}

      {/* 生效级别的说明 */}
      <Card title="哪些能改、哪些不能" subtitle="容器架构的硬边界，先说清楚免得白折腾">
        <ul className="space-y-2 text-xs">
          <li className="flex items-start gap-2">
            <Badge tone="ok">立即生效</Badge>
            <span>
              <strong>数据源连接</strong>（Tailscale Token / 模式、Docker 地址）、
              <strong>缓存与超时</strong>、<strong>工具端口</strong>、<strong>指标间隔</strong> ——
              保存后服务会自动重建受影响的连接，刷新页面即可看到效果。
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Badge tone="warn">需重建容器</Badge>
            <span>
              <strong>端口映射</strong>、<strong>数据卷</strong>、<strong>新的磁盘挂载路径</strong>、
              HTTPS Cookie 等 —— 它们是容器创建参数。任何网页界面都改不了这些，
              必须编辑 <code className="font-mono">docker-compose.yml</code> 后
              <code className="ml-1 font-mono">docker compose up -d</code>。
            </span>
          </li>
          <li className="flex items-start gap-2">
            <Badge tone="idle">半自动</Badge>
            <span>
              <strong>磁盘挂载点</strong> 可以改"显示哪些、怎么标注"，但路径本身必须已经挂进容器。
              想新增一个盘，仍要改 compose 的 volumes。
            </span>
          </li>
        </ul>
      </Card>

      {/* 分组设置 */}
      {(data?.groups ?? []).map((group) => {
        const settings = byGroup.get(group.id) ?? [];
        if (settings.length === 0) return null;
        return (
          <Card key={group.id} title={group.label} subtitle={group.description}>
            <div className="space-y-4">
              {settings.map((setting) => (
                <SettingRow
                  key={setting.key}
                  setting={setting}
                  value={displayValue(setting)}
                  dirty={setting.key in draft}
                  error={invalid[setting.key] ?? null}
                  onChange={(value) => setValue(setting, value)}
                  extra={
                    setting.key === 'PORTAL_TAILSCALE_API_TOKEN' ? (
                      <TailscaleTestBlock
                        testing={testing}
                        result={testResult}
                        onTest={() => void testConnection()}
                      />
                    ) : null
                  }
                />
              ))}
            </div>
          </Card>
        );
      })}
    </>
  );
}

/** 单项设置行。 */
function SettingRow({
  setting,
  value,
  dirty,
  error,
  onChange,
  extra,
}: {
  setting: SettingView;
  value: DraftValue;
  dirty: boolean;
  error: string | null;
  onChange: (value: DraftValue) => void;
  extra?: ReactNode;
}): ReactNode {
  const badge = EFFECT_BADGE[setting.effect];

  return (
    <div className="border-b border-slate-200/60 pb-4 last:border-b-0 last:pb-0 dark:border-white/6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{setting.label}</span>
            <Badge tone={badge.tone} title={badge.hint}>
              {badge.label}
            </Badge>
            <Badge tone={setting.source === 'database' ? 'brand' : 'idle'} title={`当前值来源：${SOURCE_LABEL[setting.source]}`}>
              {SOURCE_LABEL[setting.source]}
            </Badge>
            {dirty ? <Badge tone="warn">已修改</Badge> : null}
          </div>
          <p className="muted mt-1 text-[11px] leading-relaxed">{setting.description}</p>
          <p className="muted mt-0.5 font-mono text-[10px]">{setting.envVar}</p>
        </div>
      </div>

      <div className="mt-2.5">
        {setting.effect === 'restart' ? (
          <div className="rounded-xl bg-amber-500/8 px-3 py-2 text-[11px] leading-relaxed ring-1 ring-amber-500/20">
            <p>
              当前值：<span className="font-mono">{String(setting.value ?? '')}</span>
            </p>
            {setting.restartReason ? <p className="mt-1">{setting.restartReason}</p> : null}
          </div>
        ) : setting.valueType === 'boolean' ? (
          <label className="flex cursor-pointer items-center gap-2 text-xs">
            <input
              type="checkbox"
              className="size-3.5 accent-sky-500"
              checked={value === true}
              onChange={(event) => onChange(event.target.checked)}
            />
            {value === true ? '已启用' : '已禁用'}
          </label>
        ) : setting.valueType === 'enum' ? (
          <select className="input max-w-md" value={String(value)} onChange={(event) => onChange(event.target.value)}>
            {(setting.choices ?? []).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        ) : setting.valueType === 'number' ? (
          <div className="flex items-center gap-2">
            <input
              type="number"
              className="input max-w-[10rem]"
              value={String(value)}
              min={setting.min}
              max={setting.max}
              step={1}
              onChange={(event) => onChange(event.target.value)}
            />
            {setting.unit ? <span className="muted text-xs">{setting.unit}</span> : null}
            {setting.min !== undefined || setting.max !== undefined ? (
              <span className="muted text-[10px]">
                范围 {setting.min ?? '—'} ~ {setting.max ?? '—'}
              </span>
            ) : null}
          </div>
        ) : setting.sensitive ? (
          <div className="max-w-xl">
            <input
              type="password"
              className="input font-mono"
              value={String(value)}
              placeholder={setting.masked ? '已保存（留空不修改）' : '粘贴 Token'}
              autoComplete="off"
              onChange={(event) => onChange(event.target.value)}
            />
            <p className="muted mt-1 text-[10px]">
              {setting.masked
                ? '已保存过。不改动时保持原值；填入新值会覆盖它。'
                : '在 Tailscale 管理后台 → Settings → Keys → Generate access token 生成，形如 tskey-api-xxx。'}
            </p>
          </div>
        ) : (
          <div className="max-w-xl">
            <input
              className="input font-mono"
              value={String(value)}
              onChange={(event) => onChange(event.target.value)}
            />
            {setting.valueType === 'string-list' ? (
              <p className="muted mt-1 text-[10px]">
                多个值用英文逗号分隔。
                {setting.key === 'PORTAL_DISK_MOUNTS'
                  ? '语法：展示路径=容器内路径，例如 C:=/host/disk/C'
                  : null}
              </p>
            ) : null}
          </div>
        )}

        {error ? <p className="mt-1.5 text-[11px] text-rose-500">{error}</p> : null}
        {extra}
      </div>

      {setting.updatedAt ? (
        <p className="muted mt-1.5 text-[10px]">
          上次修改：{formatRelative(setting.updatedAt)}
          {setting.updatedBy ? ` · ${setting.updatedBy}` : ''}
        </p>
      ) : null}
    </div>
  );
}

/** Tailscale「测试连接」区块。 */
function TailscaleTestBlock({
  testing,
  result,
  onTest,
}: {
  testing: boolean;
  result: TailscaleTestResponse | null;
  onTest: () => void;
}): ReactNode {
  return (
    <div className="mt-3 rounded-xl bg-slate-500/6 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-ghost px-2.5 py-1.5 text-[11px]" onClick={onTest} disabled={testing}>
          <Icon name="refresh" className="size-3" />
          {testing ? '测试中…' : '测试连接'}
        </button>
        <span className="muted text-[10px]">
          建议先测试再保存 —— 可验证尚未保存的 Token，避免存进一个错值
        </span>
      </div>

      {result ? (
        <div className="mt-2.5">
          <div className="flex items-center gap-2">
            <Badge tone={result.ok ? 'ok' : 'bad'} dot>
              {result.ok ? '连通' : '不通'}
            </Badge>
            <span className="muted text-[10px]">模式 {result.mode}</span>
            {result.deviceCount !== null ? (
              <span className="muted text-[10px]">
                设备 {result.deviceCount} 台 · 在线 {result.onlineCount ?? 0} 台
              </span>
            ) : null}
          </div>
          <p
            className={`mt-1.5 text-[11px] leading-relaxed ${
              result.ok ? 'text-emerald-700 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'
            }`}
          >
            {result.message}
          </p>
          {result.devices.length > 0 ? (
            <ul className="muted mt-1.5 space-y-0.5 text-[10px]">
              {result.devices.map((device) => (
                <li key={`${device.hostname}-${device.ipv4 ?? ''}`} className="font-mono">
                  {device.online ? '●' : '○'} {device.hostname} {device.os ? `(${device.os})` : ''}{' '}
                  {device.ipv4 ?? ''}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
