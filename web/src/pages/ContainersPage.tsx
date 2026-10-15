/**
 * 容器墙（F1）。
 *
 * 展示本机所有容器，并突出「是否可经 tailnet 访问」：
 * - 可达容器 → 卡片主体是可点击入口（新标签页打开）
 * - 仅本机/未发布 → 明确标注原因，避免"点了打不开"的困惑
 */
import { useCallback, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { Badge, Card, EmptyState, ErrorNotice, Icon, Skeleton } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { useLocalState } from '../hooks/useAsync.js';
import { describeContainerState, describeHealth, describeReachability, truncate } from '../lib/format.js';
import type { ContainerSummary, Reachability, ServeRouteView, ServeStatusView } from '../api/types.js';

type ReachabilityFilter = Reachability | 'all';

const REACHABILITY_FILTERS: Array<{ value: ReachabilityFilter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'tailnet', label: 'tailnet 可达' },
  { value: 'lan', label: '仅局域网' },
  { value: 'localhost-only', label: '仅本机' },
  { value: 'none', label: '无入口' },
];

export function ContainersPage(): ReactNode {
  const { api } = useAuth();
  const [query, setQuery] = useLocalState<string>('hp-containers-q', '');
  const [filter, setFilter] = useLocalState<ReachabilityFilter>('hp-containers-filter', 'all');
  const [showStopped, setShowStopped] = useLocalState<boolean>('hp-containers-stopped', true);
  const [showStats, setShowStats] = useLocalState<boolean>('hp-containers-stats', false);

  const load = useCallback(
    () =>
      api.containers({
        all: showStopped,
        stats: showStats,
        ...(filter === 'all' ? {} : { reachability: filter }),
        ...(query.trim() ? { q: query.trim() } : {}),
      }),
    [api, showStopped, showStats, filter, query],
  );

  const { data, loading, error, reload } = useAsync(load, { refreshIntervalMs: 15_000 });
  const summary = data?.summary;

  return (
    <Shell>
      {/* 顶栏操作区 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="muted text-xs">
          {summary
            ? `共 ${summary.total} 个容器 · 运行 ${summary.running} · tailnet 可达 ${summary.tailnetReachable} · 仅本机 ${summary.localhostOnly}`
            : '正在读取容器…'}
        </p>
        <div className="flex items-center gap-2">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              className="size-3.5 accent-sky-500"
              checked={showStopped}
              onChange={(event) => setShowStopped(event.target.checked)}
            />
            含已停止
          </label>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs" title="读取 docker stats，会略慢">
            <input
              type="checkbox"
              className="size-3.5 accent-sky-500"
              checked={showStats}
              onChange={(event) => setShowStats(event.target.checked)}
            />
            实时占用
          </label>
          <button type="button" className="btn btn-ghost" onClick={() => void reload()} disabled={loading}>
            <Icon name="refresh" className="size-3.5" />
            刷新
          </button>
        </div>
      </div>

      {/* 过滤器 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Icon name="search" className="muted pointer-events-none absolute top-2.5 left-3 size-4" />
          <input
            className="input pl-9"
            placeholder="按名称、镜像或 compose 项目搜索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {REACHABILITY_FILTERS.map((item) => (
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
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}

      {data && !data.source.available ? (
        <Card title="Docker 数据源不可用">
          <p className="text-xs">{data.source.detail}</p>
          <p className="muted mt-2 text-[11px] leading-relaxed">
            在 Docker 内部署时，请确认 compose 中已挂载引擎 socket：
            <code className="ml-1 font-mono">/var/run/docker.sock:/var/run/docker.sock:ro</code>
            （Windows 上为 named pipe，见 README 的部署矩阵）。
          </p>
        </Card>
      ) : null}

      {/* tailscale serve 路由：这类服务可能完全没有发布宿主端口 */}
      {data?.serve ? <ServeRoutesCard serve={data.serve} /> : null}

      {loading && !data ? (
        <Card>
          <Skeleton rows={5} />
        </Card>
      ) : null}

      {data && data.items.length === 0 && data.source.available ? (
        <Card>
          <EmptyState
            title="没有匹配的容器"
            description={query ? '试试清空搜索条件或切换过滤器' : '当前宿主机上没有容器'}
            icon={<Icon name="container" className="size-8" />}
          />
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.items.map((container) => (
          <ContainerCard key={container.id} container={container} />
        ))}
      </div>
    </Shell>
  );
}

/** 单个容器卡片。 */
function ContainerCard({ container }: { container: ContainerSummary }): ReactNode {
  const state = describeContainerState(container.state);
  const health = describeHealth(container.health);
  const reach = describeReachability(container.reachability);
  const reachablePorts = container.ports.filter((port) => port.url !== null);
  const localhostPorts = container.ports.filter((port) => port.reachability === 'localhost-only' || port.note !== null);
  const hasServe = container.servePaths.length > 0;

  return (
    <article className="card card-hover flex flex-col px-4 py-4">
      {/* 标题行 */}
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            to={`/containers/${encodeURIComponent(container.name)}`}
            className="block truncate text-sm font-semibold hover:text-sky-500"
            title={container.name}
          >
            {container.name}
          </Link>
          <p className="muted mt-0.5 truncate text-[11px]" title={container.image}>
            {truncate(container.image, 42)}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={state.tone} dot pulse={container.state === 'running'}>
            {state.label}
          </Badge>
          {health ? <Badge tone={health.tone}>{health.label}</Badge> : null}
        </div>
      </header>

      {/* 标签行 */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Badge tone={reach.tone} dot title={reach.hint}>
          {reach.label}
        </Badge>
        {container.composeProject ? (
          <Badge tone="idle" title={`compose 项目 ${container.composeProject}`}>
            {container.composeProject}
            {container.composeService ? `/${container.composeService}` : ''}
          </Badge>
        ) : null}
        {container.tailscaleSidecar ? <Badge tone="brand">tailscale</Badge> : null}
        {hasServe ? (
          <Badge tone="brand" title={`经 tailscale serve 暴露：${container.servePaths.join('、')}`}>
            serve {container.servePaths.join(' ')}
          </Badge>
        ) : null}
      </div>

      {/* 可选占用 */}
      {container.stats ? (
        <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
          <div className="flex justify-between">
            <dt className="muted">CPU</dt>
            <dd className="font-mono tabular-nums">
              {container.stats.cpuPercent === null ? '—' : `${container.stats.cpuPercent.toFixed(1)}%`}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt className="muted">内存</dt>
            <dd className="font-mono tabular-nums">
              {container.stats.memPercent === null ? '—' : `${container.stats.memPercent.toFixed(1)}%`}
            </dd>
          </div>
        </dl>
      ) : null}

      {/* 入口 */}
      <div className="mt-3 flex-1 space-y-1.5">
        {hasServe && container.servedUrl ? (
          <a
            href={container.servedUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="flex items-center justify-between gap-2 rounded-xl bg-sky-500/15 px-3 py-2 text-xs ring-1 ring-sky-500/30 transition hover:bg-sky-500/25"
            title={container.servedUrl}
          >
            <span className="min-w-0 truncate">
              <span className="muted mr-1.5">tailnet</span>
              <span className="font-mono">{container.servedUrl}</span>
            </span>
            <Icon name="external" className="size-3.5 shrink-0 opacity-60" />
          </a>
        ) : null}

        {reachablePorts.length > 0 ? (
          reachablePorts.slice(0, 3).map((port) => (
            <a
              key={`${port.hostPort}-${port.hostIp}-${port.protocol}`}
              href={port.url ?? '#'}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center justify-between gap-2 rounded-xl bg-sky-500/8 px-3 py-2 text-xs ring-1 ring-sky-500/20 transition hover:bg-sky-500/15"
              title={port.url ?? ''}
            >
              <span className="min-w-0 truncate font-mono">
                {port.hostIp && port.hostIp !== '0.0.0.0' && port.hostIp !== '::' ? `${port.hostIp}:` : ':'}
                {port.hostPort}
                <span className="muted ml-1.5 opacity-70">→ {port.containerPort}/{port.protocol}</span>
              </span>
              <Icon name="external" className="size-3.5 shrink-0 opacity-60" />
            </a>
          ))
        ) : (
          <p className="muted rounded-xl bg-slate-500/8 px-3 py-2 text-[11px] leading-relaxed">
            {container.state !== 'running'
              ? '容器未运行，暂无访问入口'
              : (localhostPorts[0]?.note ?? '没有可经 tailnet 访问的端口')}
          </p>
        )}
        {reachablePorts.length > 3 ? (
          <p className="muted text-[11px]">另有 {reachablePorts.length - 3} 个入口，见详情页</p>
        ) : null}
      </div>

      {/* 底部信息 */}
      <footer className="mt-3 flex items-center justify-between border-t border-slate-200/70 pt-2.5 dark:border-white/6">
        <span className="muted font-mono text-[10px]">{container.shortId}</span>
        <Link
          to={`/containers/${encodeURIComponent(container.name)}`}
          className="text-[11px] text-sky-600 hover:underline dark:text-sky-400"
        >
          详情与日志 →
        </Link>
      </footer>
    </article>
  );
}

/**
 * `tailscale serve` 路由卡片。
 *
 * 为什么需要独立卡片：serve 是个**路径级**反向代理，多个路径常常指向同一个
 * 宿主端口（例如 `/`、`/calendar`、`/calendar.ics` 都在 443）。按"宿主端口"展示
 * 会把它们压成一条，丢掉路径信息；这里按「主机:端口」分组、逐路径列出。
 *
 * 与容器卡片的去重规则：若某条 serve 的目标端口已经作为可达端口出现在容器卡上
 * （例如 worldforge 的 4173 已发布到宿主），就不再重复列为"独立入口"，
 * 但仍会在 `covered` 分组里展示，保证信息完整。
 */
function ServeRoutesCard({ serve }: { serve: ServeStatusView }): ReactNode {
  const independent = serve.routes.filter((route) => !route.coveredByContainerPort);

  // 按 主机:端口 分组
  const groups = useMemo(() => {
    const map = new Map<string, ServeRouteView[]>();
    for (const route of serve.routes) {
      const key = `${route.host}:${route.port}`;
      const list = map.get(key) ?? [];
      list.push(route);
      map.set(key, list);
    }
    return [...map.entries()];
  }, [serve.routes]);

  const title = 'tailnet 路由（tailscale serve）';

  if (!serve.available) {
    return (
      <Card title={title} subtitle="读取不到 serve 配置 —— 这类服务没有发布宿主端口，因此不会出现在按端口判定的容器墙里">
        <p className="muted text-xs leading-relaxed">{serve.detail}</p>
        <div className="muted mt-2 text-[11px] leading-relaxed">
          <p>
            读取 serve 路由需要容器内能执行 <code className="font-mono">tailscale serve status</code>：
          </p>
          <p className="mt-1">
            · <strong>Linux / NAS</strong>：在 compose 里挂载宿主的{' '}
            <code className="font-mono">tailscale</code> 与{' '}
            <code className="font-mono">/var/run/tailscale</code>，并把{' '}
            <code className="font-mono">PORTAL_TAILSCALE_MODE</code> 设为 <code className="font-mono">cli</code> 或{' '}
            <code className="font-mono">auto</code>。
          </p>
          <p className="mt-1">
            · <strong>Windows（容器化）</strong>：暂不支持 —— 容器是 Linux 环境，无法执行{' '}
            <code className="font-mono">tailscale.exe</code>，且 Windows 的 tailscaled 走 named pipe。
            Tailscale 的 REST API 也不提供 serve 配置。
          </p>
        </div>
      </Card>
    );
  }

  if (serve.routes.length === 0) {
    return (
      <Card title={title}>
        <EmptyState
          title="当前没有 serve 路由"
          description="用 tailscale serve 把本机服务挂到 tailnet 域名后，这里会列出路径映射"
          icon={<Icon name="devices" className="size-7" />}
        />
      </Card>
    );
  }

  return (
    <Card
      title={title}
      subtitle={`共 ${serve.routes.length} 条路径映射 · 独立入口 ${independent.length} 条 · 与容器端口重复 ${serve.routes.length - independent.length} 条`}
    >
      <div className="space-y-4">
        {groups.map(([hostPort, routes]) => (
          <div key={hostPort}>
            <p className="mb-2 font-mono text-xs font-medium">{hostPort}</p>
            <ul className="space-y-1.5">
              {routes.map((route) => (
                <li
                  key={`${route.host}:${route.port}${route.path}`}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-xl px-3 py-2 text-xs ring-1 ${
                    route.coveredByContainerPort
                      ? 'bg-slate-500/6 ring-slate-400/15'
                      : 'bg-sky-500/8 ring-sky-500/20'
                  }`}
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <a
                      href={route.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="flex min-w-0 items-center gap-1.5 hover:text-sky-500"
                      title={route.url}
                    >
                      <span className="font-mono font-medium">{route.path}</span>
                      <Icon name="external" className="size-3 shrink-0 opacity-60" />
                    </a>
                    <span className="muted font-mono text-[10px]">→ {route.proxy}</span>
                  </span>
                  <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                    {route.containerName ? (
                      <Link to={`/containers/${encodeURIComponent(route.containerName)}`}>
                        <Badge tone="idle" title="该 serve 路由指向的容器">
                          {route.containerName}
                        </Badge>
                      </Link>
                    ) : (
                      <Badge tone="idle" title="目标是宿主上的服务，不属于任何容器">
                        宿主服务
                      </Badge>
                    )}
                    {route.coveredByContainerPort ? (
                      <Badge tone="idle" title="该端口已作为可达端口显示在容器卡上，此处仅作完整记录">
                        与容器端口重复
                      </Badge>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <p className="muted mt-3 text-[11px] leading-relaxed">
        serve 路由本身就是"已暴露到 tailnet"的声明，因此这里列出的入口在 tailnet 内可直接打开。
        没有发布宿主端口的服务（如只在宿主 <code className="font-mono">127.0.0.1</code> 上监听的服务）
        只能通过这种方式访问。
      </p>
    </Card>
  );
}
