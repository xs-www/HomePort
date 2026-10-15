/**
 * 系统指标页（F3）。
 *
 * 展示宿主 CPU/内存/磁盘/GPU 占用，并通过 SSE 实时刷新。
 * 每个数据源都会标注 `mode`：`host-proc` 表示宿主真实值，其余会给出取数限制说明。
 */
import { useCallback, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import { Badge, Card, ErrorNotice, Icon, KeyValue, ProgressBar, Skeleton, SourceNotice } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { useMetricsStream } from '../hooks/useMetricsStream.js';
import { formatBytes, formatPercent, formatRelative, formatUptime } from '../lib/format.js';

export function SystemPage(): ReactNode {
  const { api } = useAuth();
  const load = useCallback(() => api.systemSnapshot(), [api]);
  const { data, loading, error, reload } = useAsync(load, { refreshIntervalMs: 30_000 });
  const stream = useMetricsStream(true);

  const live = stream.frame;
  const cpu = live?.cpu ?? data?.cpu;
  const memory = live?.memory ?? data?.memory;
  const disks = live?.disks ?? data?.disks ?? [];
  const gpu = live?.gpu ?? data?.gpu ?? null;
  const host = data?.host;

  /** 数据源模式 → 中文说明。 */
  const modeLabel = (mode: string): string => {
    switch (mode) {
      case 'host-proc':
        return '宿主 /proc（真实值）';
      case 'os-cpus':
        return 'Node os 接口（宿主整机）';
      case 'container-proc':
        return '容器视图（受 cgroup 限制）';
      case 'statfs':
        return 'statfs';
      case 'nvidia-smi':
        return 'nvidia-smi';
      default:
        return '不可用';
    }
  };

  return (
    <Shell>
      {/* 顶栏 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">{host ? `${host.hostname} · ${host.osLabel}` : '宿主资源'}</p>
          <p className="muted mt-0.5 text-xs">
            {host ? `${host.cpuModel} · ${host.cpuCores} 线程 · ${host.arch} · 内核 ${host.kernel}` : '正在读取…'}
            {host ? ` · 已运行 ${formatUptime(host.uptimeSec)}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge tone={stream.status === 'open' ? 'ok' : stream.status === 'error' ? 'bad' : 'idle'} dot pulse={stream.status === 'open'}>
            {stream.status === 'open' ? `实时推送 · ${stream.frames} 帧` : stream.status === 'error' ? '指标断线' : '连接中'}
          </Badge>
          <button type="button" className="btn btn-ghost" onClick={() => void reload()} disabled={loading}>
            <Icon name="refresh" className="size-3.5" />
            刷新
          </button>
        </div>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}
      {stream.lastError && stream.status === 'error' ? <ErrorNotice message={stream.lastError} /> : null}

      {loading && !data ? (
        <Card>
          <Skeleton rows={6} />
        </Card>
      ) : null}

      {/* 主要指标 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          title="CPU"
          subtitle={data ? `数据源：${modeLabel(data.sources.cpu.mode)}` : undefined}
          actions={<span className="text-2xl font-semibold tabular-nums">{formatPercent(cpu?.percent)}</span>}
        >
          <ProgressBar percent={cpu?.percent ?? null} height={10} />
          <div className="mt-3 divide-y divide-slate-200/70 dark:divide-white/6">
            <KeyValue label="1 分钟负载">{cpu ? cpu.loadAvg[0].toFixed(2) : '—'}</KeyValue>
            <KeyValue label="5 分钟负载">{cpu ? cpu.loadAvg[1].toFixed(2) : '—'}</KeyValue>
            <KeyValue label="15 分钟负载">{cpu ? cpu.loadAvg[2].toFixed(2) : '—'}</KeyValue>
          </div>
          {data ? <div className="mt-3">{<SourceNotice status={data.sources.cpu} compact />}</div> : null}

          {cpu && cpu.perCore.length > 0 ? (
            <div className="mt-4">
              <h3 className="muted mb-2 text-[11px] font-medium tracking-wide">各核心占用</h3>
              <div className="grid grid-cols-4 gap-1.5 sm:grid-cols-6 lg:grid-cols-8">
                {cpu.perCore.map((value, index) => (
                  <div key={index} className="rounded-lg bg-slate-500/8 px-1.5 py-1 text-center" title={`核心 ${index}: ${value}%`}>
                    <div className="muted text-[9px]">#{index}</div>
                    <div className="font-mono text-[11px] tabular-nums">{value.toFixed(0)}%</div>
                    <div className="mt-0.5 h-0.5 w-full overflow-hidden rounded-full bg-slate-400/20">
                      <div
                        className={`h-full ${value >= 80 ? 'bg-rose-500' : value >= 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                        style={{ width: `${Math.min(100, value)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </Card>

        <Card
          title="内存"
          subtitle={data ? `数据源：${modeLabel(data.sources.memory.mode)}` : undefined}
          actions={<span className="text-2xl font-semibold tabular-nums">{formatPercent(memory?.percent)}</span>}
        >
          <ProgressBar percent={memory?.percent ?? null} height={10} />
          <div className="mt-3 divide-y divide-slate-200/70 dark:divide-white/6">
            <KeyValue label="已用">{formatBytes(memory?.usedBytes)}</KeyValue>
            <KeyValue label="可用">{formatBytes(memory?.availableBytes)}</KeyValue>
            <KeyValue label="总计">{formatBytes(memory?.totalBytes)}</KeyValue>
            {memory && memory.cachedBytes > 0 ? <KeyValue label="缓存">{formatBytes(memory.cachedBytes)}</KeyValue> : null}
            {memory && memory.swapTotalBytes > 0 ? (
              <KeyValue label="交换分区">
                {formatBytes(memory.swapUsedBytes)} / {formatBytes(memory.swapTotalBytes)}
              </KeyValue>
            ) : null}
          </div>
          {data ? <div className="mt-3">{<SourceNotice status={data.sources.memory} compact />}</div> : null}
        </Card>
      </div>

      {/* GPU */}
      <Card
        title="GPU"
        subtitle={data ? `数据源：${modeLabel(data.sources.gpu.mode)}` : undefined}
        actions={
          gpu?.available ? <span className="text-2xl font-semibold tabular-nums">{formatPercent(gpu.percent)}</span> : null
        }
      >
        {gpu?.available ? (
          <>
            <p className="mb-3 text-sm font-medium">{gpu.name}</p>
            <ProgressBar percent={gpu.percent} label="核心占用" height={10} />
            <div className="mt-3">
              <ProgressBar
                percent={
                  gpu.memoryTotalBytes && gpu.memoryUsedBytes !== null
                    ? (gpu.memoryUsedBytes / gpu.memoryTotalBytes) * 100
                    : null
                }
                label="显存占用"
                hint={`${formatBytes(gpu.memoryUsedBytes)} / ${formatBytes(gpu.memoryTotalBytes)}`}
                height={10}
              />
            </div>
            <div className="mt-3 grid gap-x-6 sm:grid-cols-2">
              <div className="divide-y divide-slate-200/70 dark:divide-white/6">
                <KeyValue label="温度">{gpu.temperatureC === null ? '—' : `${gpu.temperatureC} °C`}</KeyValue>
                <KeyValue label="风扇">{gpu.fanPercent === null ? '—' : `${gpu.fanPercent}%`}</KeyValue>
              </div>
              <div className="divide-y divide-slate-200/70 dark:divide-white/6">
                <KeyValue label="功耗">
                  {gpu.powerWatts === null ? '—' : `${gpu.powerWatts.toFixed(1)} W`}
                  {gpu.powerLimitWatts ? ` / ${gpu.powerLimitWatts.toFixed(0)} W` : ''}
                </KeyValue>
                <KeyValue label="显存总计">{formatBytes(gpu.memoryTotalBytes)}</KeyValue>
              </div>
            </div>

            {gpu.processes.length > 0 ? (
              <div className="mt-4">
                <h3 className="muted mb-2 text-[11px] font-medium tracking-wide">占用显存的进程</h3>
                <ul className="space-y-1.5">
                  {gpu.processes.map((process) => (
                    <li key={process.pid} className="flex items-center justify-between gap-3 text-xs">
                      <span className="truncate font-mono">
                        <span className="muted mr-2">PID {process.pid}</span>
                        {process.name}
                      </span>
                      <span className="muted shrink-0 font-mono">{formatBytes(process.memoryUsedBytes)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : (
          <div className="space-y-3">
            <p className="muted text-xs">未检测到可用的 GPU 数据。</p>
            {data ? <SourceNotice status={data.sources.gpu} /> : null}
          </div>
        )}
      </Card>

      {/* 磁盘 */}
      <Card
        title="磁盘"
        subtitle={data ? `数据源：${modeLabel(data.sources.disk.mode)}` : undefined}
        actions={
          <span className="muted text-[11px]">挂载点由环境变量 PORTAL_DISK_MOUNTS 配置</span>
        }
      >
        {disks.length > 0 ? (
          <div className="space-y-4">
            {disks.map((disk) => (
              <div key={`${disk.mount}-${disk.label}`}>
                <div className="mb-1.5 flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-medium">
                    {disk.label}
                    <span className="muted ml-2 font-mono text-[11px]">{disk.mount}</span>
                    {disk.fsType ? <span className="muted ml-2 text-[11px]">{disk.fsType}</span> : null}
                  </span>
                  <span className="muted font-mono text-xs tabular-nums">
                    {disk.totalBytes === null
                      ? '—'
                      : `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}（${formatPercent(disk.percent)}）`}
                  </span>
                </div>
                {disk.error ? (
                  <p className="rounded-xl bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300">
                    {disk.error}
                  </p>
                ) : (
                  <ProgressBar percent={disk.percent} height={8} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted text-xs">未配置磁盘挂载点</p>
        )}
        {data ? <div className="mt-3">{<SourceNotice status={data.sources.disk} />}</div> : null}
      </Card>

      {data ? (
        <p className="muted text-center text-[11px]">
          快照生成于 {formatRelative(data.generatedAt)} · 实时帧更新于 {live ? formatRelative(live.generatedAt) : '—'}
        </p>
      ) : null}
    </Shell>
  );
}
