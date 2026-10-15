/**
 * 总览页：四个数据源的摘要卡片 + 在线设备 + 工具状态 + 数据源告警。
 *
 * 数据来自单个聚合接口 `/api/overview`（服务端并行取数），
 * 因此首屏只需一次请求；系统指标再由 SSE 增量更新。
 */
import { useCallback, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { Badge, Card, ErrorNotice, Icon, ProgressBar, Skeleton, SourceNotice, StatCard } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { useMetricsStream } from '../hooks/useMetricsStream.js';
import { Shell } from '../layout/Shell.js';
import { formatBytes, formatPercent, formatRelative, formatUptime, describeOs } from '../lib/format.js';

export function OverviewPage(): ReactNode {
  const { api, user } = useAuth();
  const load = useCallback(() => api.overview(), [api]);
  const { data, loading, error, reload } = useAsync(load, { refreshIntervalMs: 20_000 });

  // SSE 覆盖 cpu/mem/gpu 三项，避免总览数字 20 秒才动一次
  const stream = useMetricsStream(true);
  const live = stream.frame;

  const cpuPercent = live?.cpu.percent ?? data?.system.cpuPercent ?? null;
  const memPercent = live?.memory.percent ?? data?.system.memPercent ?? null;
  const memUsed = live?.memory.usedBytes ?? data?.system.memUsedBytes ?? 0;
  const memTotal = live?.memory.totalBytes ?? data?.system.memTotalBytes ?? 0;
  const gpuPercent = live?.gpu?.percent ?? data?.system.gpuPercent ?? null;

  return (
    <Shell
      topbarExtra={
        <div className="flex items-center gap-2">
          <Badge
            tone={stream.status === 'open' ? 'ok' : stream.status === 'error' ? 'bad' : 'idle'}
            dot
            pulse={stream.status === 'open'}
          >
            {stream.status === 'open' ? '指标实时' : stream.status === 'error' ? '指标断线' : '连接中'}
          </Badge>
          <button type="button" className="btn btn-ghost" onClick={() => void reload()} disabled={loading}>
            <Icon name="refresh" className="size-3.5" />
            刷新
          </button>
        </div>
      }
    >
      <div>
        <h2 className="text-base font-semibold">你好，{user?.displayName ?? user?.username}</h2>
        <p className="muted mt-0.5 text-xs">
          {data ? (
            <>
              {data.system.hostname} · {data.system.osLabel} · 已运行 {formatUptime(data.system.uptimeSec)}
            </>
          ) : (
            '正在读取本机状态…'
          )}
        </p>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}

      {/* 数据源与聚合告警 */}
      {data && data.warnings.length > 0 ? (
        <Card title="数据源提示" subtitle="以下内容不可用或有取数限制，其余功能不受影响">
          <ul className="space-y-1.5 text-xs">
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

      {/* 指标卡 */}
      {loading && !data ? (
        <Card>
          <Skeleton rows={4} />
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="容器"
            value={data ? `${data.containers.running} / ${data.containers.total}` : '—'}
            percent={data && data.containers.total > 0 ? (data.containers.running / data.containers.total) * 100 : null}
            tone={data && data.containers.attention > 0 ? 'warn' : 'ok'}
            icon={<Icon name="container" />}
            sub={
              data ? (
                <span className="flex flex-wrap items-center gap-2">
                  <span>tailnet 可达 {data.containers.tailnetReachable}</span>
                  <span className="opacity-40">·</span>
                  <span>仅本机 {data.containers.localhostOnly}</span>
                </span>
              ) : null
            }
            footer={
              <Link to="/containers" className="text-xs text-sky-600 hover:underline dark:text-sky-400">
                查看容器入口 →
              </Link>
            }
          />

          <StatCard
            label="tailnet 设备"
            value={data ? `${data.tailnet.peersOnline} / ${data.tailnet.peersTotal}` : '—'}
            percent={data && data.tailnet.peersTotal > 0 ? (data.tailnet.peersOnline / data.tailnet.peersTotal) * 100 : null}
            tone="brand"
            icon={<Icon name="devices" />}
            sub={data?.tailnet.self ? `本机 ${data.tailnet.self.hostname}` : null}
            footer={
              <Link to="/devices" className="text-xs text-sky-600 hover:underline dark:text-sky-400">
                查看设备列表 →
              </Link>
            }
          />

          <StatCard
            label="CPU"
            value={formatPercent(cpuPercent)}
            percent={cpuPercent}
            icon={<Icon name="cpu" />}
            sub={data ? `${data.system.cpuCores} 线程 · ${data.system.cpuModel}` : null}
          />

          <StatCard
            label="内存"
            value={formatPercent(memPercent)}
            percent={memPercent}
            icon={<Icon name="memory" />}
            sub={`${formatBytes(memUsed)} / ${formatBytes(memTotal)}`}
          />
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 硬件明细 */}
        <Card
          title="硬件占用"
          subtitle="数据源受限时会在下方标注原因"
          actions={
            <Link to="/system" className="text-xs text-sky-600 hover:underline dark:text-sky-400">
              详情 →
            </Link>
          }
        >
          <div className="space-y-4">
            <ProgressBar percent={cpuPercent} label="CPU" />
            <ProgressBar percent={memPercent} label="内存" hint={`${formatBytes(memUsed)} / ${formatBytes(memTotal)}`} />
            <ProgressBar
              percent={data?.system.diskPercent ?? null}
              label={`磁盘 ${data?.system.diskLabel ?? ''}`}
              hint={
                data?.system.diskTotalBytes
                  ? `${formatBytes(data.system.diskUsedBytes)} / ${formatBytes(data.system.diskTotalBytes)}`
                  : '—'
              }
            />
            <ProgressBar
              percent={gpuPercent}
              label={data?.system.gpuName ? `GPU · ${data.system.gpuName}` : 'GPU'}
              hint={gpuPercent === null ? '不可用' : formatPercent(gpuPercent)}
            />
          </div>

          <div className="mt-4 space-y-2">
            {data ? <SourceNotice status={data.sources.system} compact /> : null}
            {data ? <SourceNotice status={data.sources.gpu} compact /> : null}
          </div>
        </Card>

        {/* 在线设备 */}
        <Card
          title="在线设备"
          subtitle={data ? `共 ${data.tailnet.peersTotal} 台，在线 ${data.tailnet.peersOnline} 台` : undefined}
          actions={
            <Link to="/devices" className="text-xs text-sky-600 hover:underline dark:text-sky-400">
              全部 →
            </Link>
          }
          bodyClassName="pt-2"
        >
          {data && data.tailnet.onlinePeers.length > 0 ? (
            <ul className="divide-y divide-slate-200/70 dark:divide-white/6">
              {data.tailnet.onlinePeers.map((peer) => (
                <li key={peer.id} className="flex items-center justify-between gap-3 py-2.5">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <Badge tone="ok" dot pulse />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-medium">{peer.hostname}</span>
                      <span className="muted block truncate text-[11px]">
                        {describeOs(peer.os)}
                        {peer.ipv4 ? ` · ${peer.ipv4}` : ''}
                      </span>
                    </span>
                  </span>
                  <Badge tone={peer.connection === 'direct' ? 'ok' : 'warn'}>{peer.connection === 'direct' ? '直连' : '中继'}</Badge>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted py-6 text-center text-xs">
              {data?.sources.tailscale.available === false ? 'tailnet 数据源不可用' : '当前没有其它在线设备'}
            </p>
          )}
        </Card>
      </div>

      {/* 工具状态 */}
      <Card
        title="工具入口"
        subtitle={data ? `共 ${data.tools.total} 个，可用 ${data.tools.up} 个` : undefined}
        actions={
          <Link to="/tools" className="text-xs text-sky-600 hover:underline dark:text-sky-400">
            全部 →
          </Link>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data?.tools.featured.map((tool) => (
            <a
              key={tool.id}
              href={tool.url ?? '#'}
              target="_blank"
              rel="noreferrer noopener"
              className={`card card-hover flex items-center justify-between gap-3 px-4 py-3 ${
                tool.url ? '' : 'pointer-events-none opacity-60'
              }`}
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{tool.name}</span>
                <span className="muted block truncate text-[11px]">
                  {tool.state === 'up'
                    ? `可用 · ${tool.latencyMs ?? '—'} ms`
                    : tool.state === 'down'
                      ? '不可用'
                      : '未探测'}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <Badge tone={tool.state === 'up' ? 'ok' : tool.state === 'down' ? 'bad' : 'idle'} dot />
                <Icon name="external" className="size-3.5 opacity-50" />
              </span>
            </a>
          ))}
        </div>
        {data && data.tools.featured.length === 0 ? (
          <p className="muted py-6 text-center text-xs">暂无可用工具配置</p>
        ) : null}
      </Card>

      {data ? (
        <p className="muted text-center text-[11px]">数据更新于 {formatRelative(data.generatedAt)}</p>
      ) : null}
    </Shell>
  );
}
