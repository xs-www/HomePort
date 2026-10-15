/**
 * 容器详情页：基础信息、全部端口与候选入口、挂载、环境变量（脱敏）、日志。
 */
import { useCallback, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { Badge, Card, EmptyState, ErrorNotice, Icon, KeyValue, Skeleton } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { formatBytes, formatDateTime, formatRelative, describeContainerState, describeHealth, describeReachability } from '../lib/format.js';

/** 日志可选行数。 */
const LOG_TAIL_OPTIONS = [100, 200, 500, 1000, 2000];

export function ContainerDetailPage(): ReactNode {
  const { api } = useAuth();
  const params = useParams<{ id: string }>();
  const id = params.id ?? '';
  const [logTail, setLogTail] = useState(200);

  const loadDetail = useCallback(() => api.container(id), [api, id]);
  const detail = useAsync(loadDetail);

  const loadLogs = useCallback(() => api.containerLogs(id, logTail), [api, id, logTail]);
  const logs = useAsync(loadLogs, { refreshIntervalMs: 0 });

  const container = detail.data?.container;

  if (!id) {
    return (
      <Card>
        <EmptyState title="缺少容器标识" />
      </Card>
    );
  }

  if (detail.loading && !container) {
    return (
      <Card>
        <Skeleton rows={6} />
      </Card>
    );
  }

  if (detail.error && !container) {
    return (
      <Card title="无法读取容器">
        <ErrorNotice message={detail.error} onRetry={() => void detail.reload()} />
        <Link to="/containers" className="mt-3 inline-block text-xs text-sky-600 hover:underline dark:text-sky-400">
          ← 返回容器列表
        </Link>
      </Card>
    );
  }

  if (!container) return null;

  const state = describeContainerState(container.state);
  const health = describeHealth(container.health);
  const reach = describeReachability(container.reachability);

  return (
    <Shell>
      {/* 面包屑与标题 */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link to="/containers" className="muted text-[11px] hover:underline">
            ← 容器列表
          </Link>
          <h2 className="mt-1 truncate text-base font-semibold">{container.name}</h2>
          <p className="muted mt-0.5 truncate font-mono text-[11px]" title={container.image}>
            {container.image}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={state.tone} dot pulse={container.state === 'running'}>
            {state.label}
          </Badge>
          {health ? <Badge tone={health.tone}>{health.label}</Badge> : null}
          <Badge tone={reach.tone} dot title={reach.hint}>
            {reach.label}
          </Badge>
          <button type="button" className="btn btn-ghost" onClick={() => void detail.reload()} disabled={detail.loading}>
            <Icon name="refresh" className="size-3.5" />
            刷新
          </button>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* 基础信息 */}
        <Card title="基础信息" className="lg:col-span-2">
          <div className="divide-y divide-slate-200/70 dark:divide-white/6">
            <KeyValue label="容器 ID">{container.id}</KeyValue>
            <KeyValue label="状态">{container.status}</KeyValue>
            <KeyValue label="创建时间">{formatDateTime(container.createdAt)}</KeyValue>
            <KeyValue label="启动时间">{formatDateTime(container.startedAt)}</KeyValue>
            <KeyValue label="Compose 项目">
              {container.composeProject ?? '—'}
              {container.composeService ? ` / ${container.composeService}` : ''}
            </KeyValue>
            <KeyValue label="重启策略">{container.restartPolicy ?? '—'}</KeyValue>
            <KeyValue label="网络模式">{container.networkMode ?? '—'}</KeyValue>
            <KeyValue label="特权模式">{container.privileged ? '是' : '否'}</KeyValue>
            <KeyValue label="运行用户">{container.user ?? '—'}</KeyValue>
            <KeyValue label="工作目录">{container.workingDir ?? '—'}</KeyValue>
            <KeyValue label="启动命令">
              <span className="font-mono">{container.command ?? '—'}</span>
            </KeyValue>
            <KeyValue label="Entrypoint">
              <span className="font-mono">{container.entrypoint ?? '—'}</span>
            </KeyValue>
          </div>
        </Card>

        {/* 实时占用 */}
        <Card title="实时占用" subtitle={container.stats ? `采集于 ${formatRelative(container.stats.collectedAt)}` : undefined}>
          {container.stats ? (
            <div className="divide-y divide-slate-200/70 dark:divide-white/6">
              <KeyValue label="CPU">
                {container.stats.cpuPercent === null ? '—' : `${container.stats.cpuPercent.toFixed(2)}%`}
              </KeyValue>
              <KeyValue label="内存">
                {formatBytes(container.stats.memUsedBytes)}
                {container.stats.memLimitBytes ? ` / ${formatBytes(container.stats.memLimitBytes)}` : ''}
              </KeyValue>
              <KeyValue label="网络接收">{formatBytes(container.stats.netRxBytes)}</KeyValue>
              <KeyValue label="网络发送">{formatBytes(container.stats.netTxBytes)}</KeyValue>
              <KeyValue label="磁盘读">{formatBytes(container.stats.blockReadBytes)}</KeyValue>
              <KeyValue label="磁盘写">{formatBytes(container.stats.blockWriteBytes)}</KeyValue>
              <KeyValue label="进程数">{container.stats.pids ?? '—'}</KeyValue>
            </div>
          ) : (
            <p className="muted text-xs">{container.state === 'running' ? '暂无占用数据' : '容器未运行'}</p>
          )}

          <div className="mt-4 space-y-2">
            <h3 className="muted text-[11px] font-medium tracking-wide">网络</h3>
            {container.networks.length > 0 ? (
              container.networks.map((network) => (
                <div key={network.name} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate font-mono">{network.name}</span>
                  <span className="muted font-mono">{network.ipv4 ?? '—'}</span>
                </div>
              ))
            ) : (
              <p className="muted text-xs">—</p>
            )}
          </div>
        </Card>
      </div>

      {/* 端口与入口 */}
      <Card
        title="访问入口"
        subtitle="只有绑定到 tailnet 可达地址的端口才会生成可点击入口"
      >
        {container.ports.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="muted border-b border-slate-200/70 dark:border-white/6">
                <tr>
                  <th className="py-2 pr-3 font-medium">容器端口</th>
                  <th className="py-2 pr-3 font-medium">宿主绑定</th>
                  <th className="py-2 pr-3 font-medium">可达性</th>
                  <th className="py-2 font-medium">入口</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-white/5">
                {container.ports.map((port) => {
                  const portReach = describeReachability(port.reachability);
                  return (
                    <tr key={`${port.hostPort}-${port.hostIp}-${port.protocol}`}>
                      <td className="py-2 pr-3 font-mono">
                        {port.containerPort}/{port.protocol}
                      </td>
                      <td className="py-2 pr-3 font-mono">
                        {port.hostPort === null ? '—' : `${port.hostIp || '0.0.0.0'}:${port.hostPort}`}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge tone={portReach.tone} dot title={port.note ?? portReach.hint}>
                          {portReach.label}
                        </Badge>
                      </td>
                      <td className="py-2">
                        {port.url ? (
                          <a
                            href={port.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="inline-flex items-center gap-1 text-sky-600 hover:underline dark:text-sky-400"
                          >
                            {port.url}
                            <Icon name="external" className="size-3" />
                          </a>
                        ) : (
                          <span className="muted">{port.note ?? '不可直接访问'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted text-xs">该容器未发布任何端口</p>
        )}

        {container.urlCandidates.length > 1 ? (
          <div className="mt-4">
            <h3 className="muted mb-2 text-[11px] font-medium tracking-wide">备选入口（按你的网络环境选择）</h3>
            <div className="flex flex-wrap gap-2">
              {container.urlCandidates.map((candidate) => (
                <a
                  key={candidate.url}
                  href={candidate.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="rounded-xl bg-slate-500/8 px-3 py-1.5 text-[11px] ring-1 ring-slate-400/15 transition hover:bg-sky-500/12"
                  title={candidate.url}
                >
                  <span className="muted mr-1.5">{candidate.display ?? candidate.label}</span>
                  <span className="font-mono">{candidate.url}</span>
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* 挂载 */}
        <Card title="挂载点" subtitle="只读展示，门户不提供修改能力">
          {container.mounts.length > 0 ? (
            <ul className="space-y-2.5">
              {container.mounts.map((mount) => (
                <li key={`${mount.source}-${mount.destination}`} className="text-xs">
                  <div className="flex items-center gap-2">
                    <Badge tone={mount.readOnly ? 'idle' : 'warn'}>{mount.readOnly ? '只读' : '读写'}</Badge>
                    <span className="muted text-[11px]">{mount.type}</span>
                  </div>
                  <p className="mt-1 font-mono break-all">{mount.source}</p>
                  <p className="muted font-mono break-all">→ {mount.destination}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted text-xs">无挂载</p>
          )}
        </Card>

        {/* 环境变量 */}
        <Card title="环境变量" subtitle="敏感字段已自动打码（***）">
          {Object.keys(container.env).length > 0 ? (
            <div className="scroll-thin max-h-72 overflow-y-auto">
              <div className="divide-y divide-slate-200/70 dark:divide-white/6">
                {Object.entries(container.env).map(([key, value]) => (
                  <KeyValue key={key} label={<span className="font-mono">{key}</span>}>
                    <span className="font-mono">{value}</span>
                  </KeyValue>
                ))}
              </div>
            </div>
          ) : (
            <p className="muted text-xs">未设置环境变量</p>
          )}
        </Card>
      </div>

      {/* 日志 */}
      <Card
        title="日志"
        subtitle="tail 最近的输出，敏感信息已脱敏"
        actions={
          <>
            <select
              className="input w-auto px-2 py-1 text-xs"
              value={logTail}
              onChange={(event) => setLogTail(Number(event.target.value))}
            >
              {LOG_TAIL_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  最近 {option} 行
                </option>
              ))}
            </select>
            <button type="button" className="btn btn-ghost" onClick={() => void logs.reload()} disabled={logs.loading}>
              <Icon name="refresh" className="size-3.5" />
              刷新
            </button>
          </>
        }
      >
        {logs.error ? <ErrorNotice message={logs.error} onRetry={() => void logs.reload()} /> : null}
        {logs.loading && !logs.data ? <Skeleton rows={6} /> : null}
        {logs.data ? (
          logs.data.lines.length > 0 ? (
            <>
              <pre className="scroll-thin max-h-96 overflow-auto rounded-xl bg-slate-900/95 p-3 font-mono text-[11px] leading-relaxed text-slate-200">
                {logs.data.lines.join('\n')}
              </pre>
              {logs.data.truncated ? <p className="muted mt-2 text-[11px]">输出较长，已截断显示最近的部分</p> : null}
            </>
          ) : (
            <p className="muted text-xs">暂无日志输出</p>
          )
        ) : null}
      </Card>
    </Shell>
  );
}
