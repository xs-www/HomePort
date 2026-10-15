/**
 * tailnet 设备页（F2）。
 *
 * 展示本机所在 tailnet 的全部设备：在线状态、OS、tailnet IP、连接方式（直连/中继）、
 * 最后可见时间。支持搜索与「只看在线」过滤，并提供一键复制 IP。
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import { Badge, Card, EmptyState, ErrorNotice, Icon, Skeleton } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { describeConnection, describeOs, formatBytes, formatRelative } from '../lib/format.js';
import type { TailnetDevice } from '../api/types.js';

type SortKey = 'status' | 'hostname' | 'os' | 'lastSeen';

export function DevicesPage(): ReactNode {
  const { api } = useAuth();
  const [query, setQuery] = useState('');
  const [onlineOnly, setOnlineOnly] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('status');
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(() => api.tailnetDevices(), [api]);
  const { data, loading, error, reload } = useAsync(load, { refreshIntervalMs: 30_000 });

  const devices: TailnetDevice[] = useMemo(() => {
    if (!data) return [];
    const all = data.self ? [data.self, ...data.peers] : [...data.peers];
    return all;
  }, [data]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    let list = devices.filter((device) => {
      if (onlineOnly && !device.online) return false;
      if (!needle) return true;
      return (
        device.hostname.toLowerCase().includes(needle) ||
        device.dnsName.toLowerCase().includes(needle) ||
        (device.ipv4 ?? '').includes(needle) ||
        device.os.toLowerCase().includes(needle)
      );
    });

    list = [...list].sort((a, b) => {
      if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
      switch (sortKey) {
        case 'hostname':
          return a.hostname.localeCompare(b.hostname, 'zh-Hans-CN');
        case 'os':
          return a.os.localeCompare(b.os);
        case 'lastSeen': {
          const at = a.lastSeen ? Date.parse(a.lastSeen) : 0;
          const bt = b.lastSeen ? Date.parse(b.lastSeen) : 0;
          return bt - at;
        }
        default:
          if (a.online !== b.online) return a.online ? -1 : 1;
          return a.hostname.localeCompare(b.hostname, 'zh-Hans-CN');
      }
    });
    return list;
  }, [devices, query, onlineOnly, sortKey]);

  const copy = async (value: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(value);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      // 剪贴板不可用（非 HTTPS 或权限被拒）时静默失败
    }
  };

  const source = data?.source;

  return (
    <Shell>
      {/* 概要 */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">
            {data?.self ? `${data.self.hostname} 的 tailnet` : 'tailnet'}
            {data?.tailnet.magicDnsSuffix ? (
              <span className="muted ml-2 font-mono text-xs">{data.tailnet.magicDnsSuffix}</span>
            ) : null}
          </p>
          <p className="muted mt-0.5 text-xs">
            {data
              ? `共 ${data.summary.peersTotal} 台设备，在线 ${data.summary.peersOnline} 台，离线 ${data.summary.peersOffline} 台`
              : '正在读取 tailnet 状态…'}
            {data?.backendState ? ` · 后端 ${data.backendState}` : ''}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="muted text-[11px]">数据源：{source?.mode ?? '—'}</span>
          <button type="button" className="btn btn-ghost" onClick={() => void reload()} disabled={loading}>
            <Icon name="refresh" className="size-3.5" />
            刷新
          </button>
        </div>
      </div>

      {error ? <ErrorNotice message={error} onRetry={() => void reload()} /> : null}

      {source && !source.available ? (
        <Card title="tailnet 数据源不可用">
          <p className="text-xs">{source.detail}</p>
          <div className="muted mt-2 space-y-1 text-[11px] leading-relaxed">
            <p>两种可选方案（详见 README）：</p>
            <p>
              1. <strong>CLI 模式</strong>：把宿主的 tailscale 可执行文件挂载进容器
              （Linux/NAS：<code className="font-mono">/usr/bin/tailscale</code> 与{' '}
              <code className="font-mono">/var/run/tailscale</code>；Windows：{
                <code className="font-mono">C:\Program Files\Tailscale\tailscale.exe</code>
              }）。
            </p>
            <p>
              2. <strong>API 模式</strong>：设置 <code className="font-mono">PORTAL_TAILSCALE_MODE=api</code> 与
              <code className="ml-1 font-mono">PORTAL_TAILSCALE_API_TOKEN</code>（只读 scope 即可）。
            </p>
          </div>
        </Card>
      ) : null}

      {/* 过滤与排序 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 sm:max-w-xs">
          <Icon name="search" className="muted pointer-events-none absolute top-2.5 left-3 size-4" />
          <input
            className="input pl-9"
            placeholder="搜索主机名、IP 或系统"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            className="size-3.5 accent-sky-500"
            checked={onlineOnly}
            onChange={(event) => setOnlineOnly(event.target.checked)}
          />
          只看在线
        </label>
        <select
          className="input w-auto px-2 py-1.5 text-xs"
          value={sortKey}
          onChange={(event) => setSortKey(event.target.value as SortKey)}
        >
          <option value="status">按在线状态</option>
          <option value="hostname">按主机名</option>
          <option value="os">按系统</option>
          <option value="lastSeen">按最后可见</option>
        </select>
      </div>

      {loading && !data ? (
        <Card>
          <Skeleton rows={5} />
        </Card>
      ) : null}

      {data && visible.length === 0 ? (
        <Card>
          <EmptyState
            title="没有匹配的设备"
            description={query || onlineOnly ? '试试清空搜索或取消「只看在线」' : '该 tailnet 下暂无其它设备'}
            icon={<Icon name="devices" className="size-8" />}
          />
        </Card>
      ) : null}

      {/* 设备表 */}
      {visible.length > 0 ? (
        <Card bodyClassName="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="muted border-b border-slate-200/70 dark:border-white/6">
                <tr>
                  <th className="px-5 py-2.5 font-medium">设备</th>
                  <th className="px-3 py-2.5 font-medium">状态</th>
                  <th className="px-3 py-2.5 font-medium">系统</th>
                  <th className="px-3 py-2.5 font-medium">tailnet IP</th>
                  <th className="px-3 py-2.5 font-medium">连接</th>
                  <th className="px-3 py-2.5 font-medium">流量</th>
                  <th className="px-5 py-2.5 font-medium">最后可见</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-white/5">
                {visible.map((device) => (
                  <tr key={device.id || device.dnsName} className="transition hover:bg-sky-500/5">
                    <td className="px-5 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{device.hostname || '—'}</span>
                        {device.isSelf ? <Badge tone="brand">本机</Badge> : null}
                        {device.exitNode ? <Badge tone="warn">出口节点</Badge> : null}
                        {device.tags.map((tag) => (
                          <Badge key={tag} tone="idle">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                      {device.dnsName ? <p className="muted mt-0.5 font-mono text-[10px]">{device.dnsName}</p> : null}
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge tone={device.online ? 'ok' : 'idle'} dot pulse={device.online}>
                        {device.online ? '在线' : '离线'}
                      </Badge>
                    </td>
                    <td className="px-3 py-2.5">{describeOs(device.os)}</td>
                    <td className="px-3 py-2.5">
                      {device.ipv4 ? (
                        <button
                          type="button"
                          className="font-mono hover:text-sky-500"
                          onClick={() => void copy(device.ipv4 ?? '')}
                          title="点击复制"
                        >
                          {device.ipv4}
                          {copied === device.ipv4 ? <span className="muted ml-1.5">已复制</span> : null}
                        </button>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {device.online ? (
                        <Badge tone={device.connection === 'direct' ? 'ok' : 'warn'}>
                          {describeConnection(device.connection)}
                          {device.relay && device.connection === 'relay' ? ` · ${device.relay}` : ''}
                        </Badge>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 font-mono text-[11px]">
                      {device.rxBytes === null && device.txBytes === null
                        ? '—'
                        : `↓${formatBytes(device.rxBytes)} ↑${formatBytes(device.txBytes)}`}
                    </td>
                    <td className="px-5 py-2.5 whitespace-nowrap">{formatRelative(device.lastSeen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <p className="muted text-center text-[11px]">
        在线状态来自 tailscale 控制面，通常有数十秒延迟；「离线」表示控制面无法确认该设备可达。
      </p>
    </Shell>
  );
}
