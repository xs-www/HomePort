/**
 * 工具入口页（F4）。
 *
 * 展示 Ollama / DSH / ComfyUI 等本机工具的入口与可用性。
 * 每个工具提供多个候选入口（tailnet IP / MagicDNS / localhost），
 * 便于用户按当前网络环境选择；可用性由后端做 TCP+HTTP 探测并缓存。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import { Badge, Card, EmptyState, ErrorNotice, Icon, Skeleton } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { formatLatency, formatRelative } from '../lib/format.js';
import type { ToolView } from '../api/types.js';

type StateFilter = 'all' | 'up' | 'down' | 'unknown';

const STATE_FILTERS: Array<{ value: StateFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'up', label: '可用' },
  { value: 'down', label: '不可用' },
  { value: 'unknown', label: '未探测' },
];

export function ToolsPage(): ReactNode {
  const { api } = useAuth();
  const [filter, setFilter] = useState<StateFilter>('all');
  const [category, setCategory] = useState<string>('all');
  const [probing, setProbing] = useState<string | null>(null);

  const load = useCallback(() => api.tools({ probe: true }), [api]);
  const { data, loading, error, reload } = useAsync(load, { refreshIntervalMs: 30_000 });

  const categories = useMemo(() => {
    if (!data) return [];
    return [...new Set(data.items.map((tool) => tool.category))].sort();
  }, [data]);

  const visible = useMemo(() => {
    if (!data) return [];
    return data.items.filter((tool) => {
      if (filter !== 'all' && tool.status.state !== filter) return false;
      if (category !== 'all' && tool.category !== category) return false;
      return true;
    });
  }, [data, filter, category]);

  /** 单工具强制刷新探测。 */
  const probeOne = async (id: string): Promise<void> => {
    setProbing(id);
    try {
      await api.probeTool(id);
      await reload();
    } catch {
      // 探测失败也会由 reload 反映为 down 状态
    } finally {
      setProbing(null);
    }
  };

  return (
    <Shell>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-xs">
          {data
            ? `共 ${data.summary.total} 个工具 · 可用 ${data.summary.up} · 不可用 ${data.summary.down} · 未探测 ${data.summary.unknown}`
            : '正在探测本机工具…'}
        </p>
        <button type="button" className="btn btn-ghost" onClick={() => void reload()} disabled={loading}>
          <Icon name="refresh" className="size-3.5" />
          重新探测
        </button>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}

      {data && data.warnings.length > 0 ? (
        <Card title="目录配置提示">
          <ul className="space-y-1 text-xs">
            {data.warnings.map((warning, index) => (
              <li key={index} className="flex items-start gap-2">
                <span className="text-amber-500" aria-hidden>
                  ⚠
                </span>
                <span>{warning}</span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* 过滤 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {STATE_FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              onClick={() => setFilter(item.value)}
              className={`rounded-full px-3 py-1.5 text-xs transition ${
                filter === item.value
                  ? 'bg-sky-500/15 font-medium text-sky-600 ring-1 ring-sky-500/30 dark:text-sky-300'
                  : 'text-slate-600 hover:bg-slate-100 dark:text-ink-300 dark:hover:bg-white/6'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
        {categories.length > 1 ? (
          <select
            className="input w-auto px-2 py-1.5 text-xs"
            value={category}
            onChange={(event) => setCategory(event.target.value)}
          >
            <option value="all">全部分类</option>
            {categories.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        ) : null}
      </div>

      {loading && !data ? (
        <Card>
          <Skeleton rows={5} />
        </Card>
      ) : null}

      {data && visible.length === 0 ? (
        <Card>
          <EmptyState
            title="没有匹配的工具"
            description="调整筛选条件，或用 PORTAL_TOOLS_FILE / PORTAL_TOOLS_EXTRA 添加自定义工具"
            icon={<Icon name="tools" className="size-8" />}
          />
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {visible.map((tool) => (
          <ToolCard
            key={tool.id}
            tool={tool}
            probing={probing === tool.id}
            onProbe={() => void probeOne(tool.id)}
          />
        ))}
      </div>

      <p className="muted text-center text-[11px] leading-relaxed">
        可用性通过服务端 TCP 连接 + HTTP 健康检查判定（结果缓存 10 秒）。
        「可用」只代表端口能连上，不代表功能正常。
      </p>
    </Shell>
  );
}

/** 工具卡片。 */
function ToolCard({ tool, probing, onProbe }: { tool: ToolView; probing: boolean; onProbe: () => void }): ReactNode {
  const stateTone = tool.status.state === 'up' ? 'ok' : tool.status.state === 'down' ? 'bad' : 'idle';
  const stateLabel = tool.status.state === 'up' ? '可用' : tool.status.state === 'down' ? '不可用' : '未探测';

  return (
    <article className="card card-hover flex flex-col px-4 py-4">
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{tool.name}</h3>
          <p className="muted mt-0.5 line-clamp-2 text-[11px]" title={tool.description}>
            {tool.description || '—'}
          </p>
        </div>
        <Badge tone={stateTone} dot pulse={tool.status.state === 'up'}>
          {stateLabel}
        </Badge>
      </header>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone="idle">{tool.category}</Badge>
        {tool.hostPort ? <Badge tone="idle">端口 {tool.hostPort}</Badge> : <Badge tone="warn">未配置端口</Badge>}
        {tool.status.latencyMs !== null ? <Badge tone="idle">{formatLatency(tool.status.latencyMs)}</Badge> : null}
        {tool.status.stale ? <Badge tone="warn">缓存</Badge> : null}
      </div>

      {tool.status.detail ? (
        <p className="muted mt-2.5 rounded-xl bg-amber-500/8 px-3 py-2 text-[11px] leading-relaxed ring-1 ring-amber-500/20">
          {tool.status.detail}
        </p>
      ) : null}

      {tool.hint ? <p className="muted mt-2.5 text-[11px] leading-relaxed">{tool.hint}</p> : null}

      <div className="mt-3 flex-1" />

      {/* 入口 */}
      <div className="space-y-1.5">
        {tool.url ? (
          <a
            href={tool.url}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center justify-between gap-2 rounded-xl bg-sky-500/8 px-3 py-2 text-xs ring-1 ring-sky-500/20 transition hover:bg-sky-500/15"
            title={tool.url}
          >
            <span className="min-w-0 truncate font-mono">{tool.url}</span>
            <Icon name="external" className="size-3.5 shrink-0 opacity-60" />
          </a>
        ) : (
          <p className="muted rounded-xl bg-slate-500/8 px-3 py-2 text-[11px]">
            未配置宿主端口，无法生成入口（可通过 PORTAL_TOOLS_FILE 配置）
          </p>
        )}

        {tool.urlCandidates.length > 1 ? (
          <details className="text-[11px]">
            <summary className="muted cursor-pointer hover:text-sky-500">其它网络环境入口</summary>
            <ul className="mt-1.5 space-y-1">
              {tool.urlCandidates.map((candidate) => (
                <li key={candidate.url}>
                  <a
                    href={candidate.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center justify-between gap-2 rounded-lg px-2 py-1 hover:bg-slate-500/8"
                    title={candidate.url}
                  >
                    <span className="muted shrink-0">{candidate.display ?? candidate.label}</span>
                    <span className="min-w-0 truncate font-mono">{candidate.url}</span>
                  </a>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>

      <footer className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-2.5 dark:border-white/6">
        <span className="muted text-[10px]">
          {tool.status.checkedAt ? `探测于 ${formatRelative(tool.status.checkedAt)}` : '尚未探测'}
        </span>
        <button type="button" className="text-[11px] text-sky-600 hover:underline disabled:opacity-50 dark:text-sky-400" onClick={onProbe} disabled={probing}>
          {probing ? '探测中…' : '重新探测'}
        </button>
      </footer>
    </article>
  );
}
