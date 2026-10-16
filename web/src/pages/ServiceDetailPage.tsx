/**
 * 服务详情页 `/services/:id`（viewer 可看）。
 *
 * 为什么需要它：服务墙上的卡片只能给结论（三个状态点 + 首选入口），
 * 但"为什么这个服务是现在这个样子"必须能查 —— 因此这里把 `status.reasons`、
 * **全部**候选入口（含不可达）、以及诊断数据（容器端口 / serve 路由 / notes）逐条列出。
 *
 * 数据来源：`GET /api/services/:id`（hidden 服务对非管理员返回 404，这里如实显示错误，不白屏）。
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ServiceDetailResponse, ServiceHealthView } from '../api/types.js';
import { useAuth } from '../auth/AuthProvider.js';
import { Modal } from '../components/Modal.js';
import { ServiceStatusBadges, describeSourceType } from '../components/ServiceCard.js';
import { ServiceForm } from '../components/ServiceForm.js';
import { ServiceIcon } from '../components/ServiceIcon.js';
import { UrlCandidateList } from '../components/UrlCandidateList.js';
import { Badge, Card, ErrorNotice, Icon, KeyValue, Skeleton } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { formatLatency, formatRelative } from '../lib/format.js';

export function ServiceDetailPage(): ReactNode {
  const { id = '' } = useParams<{ id: string }>();
  const { api, isAdmin } = useAuth();

  const load = useCallback(() => api.service(id), [api, id]);
  const { data, loading, error, reload, loaded } = useAsync<ServiceDetailResponse>(load, { refreshIntervalMs: 30_000 });

  const [editing, setEditing] = useState(false);
  const [probing, setProbing] = useState(false);
  const [health, setHealth] = useState<ServiceHealthView | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const service = data?.service ?? null;

  const probe = async (): Promise<void> => {
    if (!service) return;
    setProbing(true);
    setProbeError(null);
    try {
      const response = await api.probeServiceHealth(service.id);
      setHealth(response.health);
      await reload();
    } catch (err) {
      setProbeError(err instanceof Error ? err.message : '健康探测失败');
    } finally {
      setProbing(false);
    }
  };

  return (
    <Shell title="服务详情">
      {loading && !loaded ? (
        <Card>
          <Skeleton rows={6} />
        </Card>
      ) : null}

      {error && !service ? (
        <>
          <ErrorNotice message={error} onRetry={() => void reload()} />
          <Card>
            <p className="muted text-xs leading-relaxed">
              该服务可能不存在，或它处于隐藏状态而当前账号不是管理员（隐藏服务对非管理员返回 404）。
            </p>
            <Link to="/" className="mt-3 inline-flex text-xs text-sky-600 hover:underline dark:text-sky-400">
              ← 返回服务墙
            </Link>
          </Card>
        </>
      ) : null}

      {service ? (
        <>
          {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}

          {/* 头部：图标 / 名称 / 分类 / 归属 / 状态点 */}
          <Card>
            <div className="flex items-start gap-4">
              <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-sky-500/12 text-sky-600 dark:text-sky-300">
                <ServiceIcon icon={service.icon} className="size-6" />
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-base font-semibold">{service.displayName}</h2>
                <p className="muted mt-1 text-xs">
                  {(service.category ?? '').trim() || '未分类'}
                  {service.description ? ` · ${service.description}` : ''}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <Badge tone="idle" title={describeSourceType(service.sourceType)}>
                    {service.sourceType}
                  </Badge>
                  {service.container ? (
                    <Link to={`/containers/${encodeURIComponent(service.container.id)}`}>
                      <Badge tone="brand" title={`容器 ${service.container.id}`}>
                        容器 {service.container.name}
                      </Badge>
                    </Link>
                  ) : (
                    <Badge tone="idle" title="该服务没有容器绑定">
                      无容器绑定
                    </Badge>
                  )}
                  {service.favorite ? <Badge tone="warn">已收藏</Badge> : null}
                  {service.visibility === 'hidden' ? <Badge tone="warn">已隐藏</Badge> : null}
                  {service.userEdited ? <Badge tone="brand">已定制</Badge> : null}
                </div>
              </div>
              {isAdmin ? (
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>
                    编辑
                  </button>
                  <button type="button" className="btn btn-ghost" onClick={() => void probe()} disabled={probing}>
                    <Icon name="refresh" className="size-3.5" />
                    {probing ? '检查中…' : '健康检查'}
                  </button>
                </div>
              ) : null}
            </div>
          </Card>

          {/* 三个独立状态点 + 原因 */}
          <Card title="状态" subtitle="容器运行 / 入口可达 / 健康检查是三个独立维度，不合并成一句“挂了”">
            <ServiceStatusBadges status={service.status} />
            {service.status.reasons.length > 0 ? (
              <ul className="mt-3 space-y-1 text-xs leading-relaxed">
                {service.status.reasons.map((reason, index) => (
                  <li key={`${index}-${reason}`} className="flex items-start gap-2">
                    <span aria-hidden className="muted mt-px">
                      ·
                    </span>
                    <span>{reason}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted mt-3 text-xs">没有额外说明。</p>
            )}

            {health ? (
              <p
                role="status"
                className={`mt-3 rounded-xl px-3 py-2 text-xs ring-1 ${
                  health.state === 'ok'
                    ? 'bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300'
                    : 'bg-rose-500/10 text-rose-700 ring-rose-500/25 dark:text-rose-300'
                }`}
              >
                健康探测结果：{health.state === 'ok' ? '通过' : '失败'}
                {health.statusCode !== null ? ` · HTTP ${health.statusCode}` : ''} · 耗时 {formatLatency(health.durationMs)}
                {health.detail ? ` · ${health.detail}` : ''}
              </p>
            ) : null}
            {probeError ? <div className="mt-3"><ErrorNotice message={probeError} /></div> : null}
          </Card>

          {/* 首选入口 */}
          <Card title="首选入口" subtitle="只从可达候选里选；一个都没有时为空">
            {service.entry ? (
              <a
                href={service.entry}
                target="_blank"
                rel="noreferrer"
                className="flex items-center justify-between gap-2 rounded-xl bg-sky-500/12 px-3 py-2 text-xs ring-1 ring-sky-500/25 transition hover:bg-sky-500/20"
              >
                <span className="min-w-0 break-all font-mono">{service.entry}</span>
                <Icon name="external" className="size-3.5 shrink-0 opacity-60" />
              </a>
            ) : (
              <p className="muted text-xs">
                暂无可达入口 —— 所有候选入口都只能在宿主机本机访问（见下方列表与诊断信息）。
              </p>
            )}
            {service.preferredUrl ? (
              <p className="muted mt-3 text-[11px]">
                管理员指定并保存的入口：<span className="font-mono">{service.preferredUrl}</span>
              </p>
            ) : null}
          </Card>

          {/* 全部候选入口（含不可达） */}
          <Card title="全部候选入口" subtitle={`候选 ${data?.candidates.length ?? service.entryCount} 个（含不可达，按优先级排序）`}>
            <UrlCandidateList entries={data?.candidates ?? service.entries} />
            <p className="muted mt-3 text-[11px] leading-relaxed">
              优先级：用户指定 &gt; Serve HTTPS &gt; Tailnet &gt; 局域网 &gt; 仅本机。
              标注"仅本机/不可达"的入口不会作为首选入口，但仍保留以便诊断。
            </p>
          </Card>

          {/* 诊断 */}
          <Card title="诊断信息" subtitle="这些是实时计算出来的原始事实，用来解释上面的结论">
            {data?.diagnostics.notes.length ? (
              <ul className="mb-3 space-y-1 text-xs">
                {data.diagnostics.notes.map((note, index) => (
                  <li key={`${index}-${note}`} className="flex items-start gap-2">
                    <span aria-hidden className="muted mt-px">
                      ·
                    </span>
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            ) : null}

            <p className="label">容器端口</p>
            {data && data.diagnostics.containerPorts.length > 0 ? (
              <div className="divide-y divide-slate-200/70 dark:divide-white/6">
                {data.diagnostics.containerPorts.map((port, index) => (
                  <KeyValue key={`${port.containerPort}-${port.protocol}-${index}`} label={`${port.containerPort}/${port.protocol}`}>
                    <span className="font-mono">
                      {port.hostIp}:{port.hostPort ?? '—'}
                    </span>
                    <span className="muted ml-1.5">{port.reachability}</span>
                    {port.url ? <span className="muted ml-1.5 font-mono">{port.url}</span> : null}
                  </KeyValue>
                ))}
              </div>
            ) : (
              <p className="muted text-xs">没有容器端口信息（无容器绑定或 Docker 数据源不可用）。</p>
            )}

            <p className="label mt-4">Serve 路由</p>
            {data && data.diagnostics.serveRoutes.length > 0 ? (
              <div className="divide-y divide-slate-200/70 dark:divide-white/6">
                {data.diagnostics.serveRoutes.map((route, index) => (
                  <KeyValue key={`${route.host}:${route.port}${route.path}-${index}`} label={`${route.host}:${route.port}${route.path}`}>
                    <span className="font-mono">{route.url}</span>
                    <span className="muted ml-1.5">→ {route.proxy}</span>
                    {route.targetPort !== null ? <span className="muted ml-1.5">目标端口 {route.targetPort}</span> : null}
                  </KeyValue>
                ))}
              </div>
            ) : (
              <p className="muted text-xs">没有匹配到的 serve 路由（Serve 数据源不可用时也会为空）。</p>
            )}
          </Card>

          <p className="muted text-center text-[11px]">
            更新于 {formatRelative(service.updatedAt)} ·{' '}
            <Link to="/" className="underline hover:no-underline">
              返回服务墙
            </Link>
          </p>

          {/* admin 编辑 */}
          <Modal open={editing} onClose={() => setEditing(false)} title="编辑服务" description={service.displayName} size="lg">
            <ServiceForm
              key={service.id}
              service={service}
              onCancel={() => setEditing(false)}
              onSaved={async () => {
                setEditing(false);
                await reload();
              }}
            />
          </Modal>
        </>
      ) : null}
    </Shell>
  );
}