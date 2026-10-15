/**
 * 展示格式化工具（前端侧）。
 *
 * 与后端 `util/format.ts` 的职责区分：后端负责把**原始数值**算准，
 * 前端负责把它变成**人类可读**的文案。两边都不重复实现对方的逻辑。
 */

/** 字节 → `1.50 GB`。 */
export function formatBytes(bytes: number | null | undefined, digits = 1): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : digits)} ${units[exponent]}`;
}

/** 百分比 → `48.1%`。 */
export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${value.toFixed(digits)}%`;
}

/** 秒 → 中文可读时长。 */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分`;
  return `${total} 秒`;
}

/** ISO → `2026-02-25 10:00`。 */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** ISO → 相对时间（`3 分钟前`）。 */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const diffSec = Math.round((Date.now() - then) / 1000);
  if (diffSec < 0) {
    const ahead = Math.abs(diffSec);
    if (ahead < 60) return `${ahead} 秒后`;
    if (ahead < 3600) return `${Math.round(ahead / 60)} 分钟后`;
    return formatDateTime(iso);
  }
  if (diffSec < 10) return '刚刚';
  if (diffSec < 60) return `${diffSec} 秒前`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)} 分钟前`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)} 小时前`;
  if (diffSec < 86400 * 30) return `${Math.round(diffSec / 86400)} 天前`;
  return formatDateTime(iso);
}

/** 延迟毫秒 → `12 ms` / `1.5 s`。 */
export function formatLatency(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/** 网络速率（字节/秒）→ `1.2 MB/s`。 */
export function formatRate(bytesPerSecond: number | null | undefined): string {
  if (bytesPerSecond === null || bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return '—';
  return `${formatBytes(bytesPerSecond, 1)}/s`;
}

/** 容器状态 → 中文与颜色语义。 */
export function describeContainerState(state: string): { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' } {
  switch (state) {
    case 'running':
      return { label: '运行中', tone: 'ok' };
    case 'exited':
      return { label: '已停止', tone: 'idle' };
    case 'paused':
      return { label: '已暂停', tone: 'warn' };
    case 'restarting':
      return { label: '重启中', tone: 'warn' };
    case 'created':
      return { label: '已创建', tone: 'idle' };
    case 'dead':
      return { label: '已失效', tone: 'bad' };
    case 'removing':
      return { label: '删除中', tone: 'warn' };
    default:
      return { label: state || '未知', tone: 'idle' };
  }
}

/** 健康检查状态 → 中文。 */
export function describeHealth(health: string | null): { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' } | null {
  if (!health) return null;
  switch (health) {
    case 'healthy':
      return { label: '健康', tone: 'ok' };
    case 'unhealthy':
      return { label: '不健康', tone: 'bad' };
    case 'starting':
      return { label: '启动中', tone: 'warn' };
    case 'none':
      return null;
    default:
      return { label: health, tone: 'idle' };
  }
}

/** 可达性 → 中文标签。 */
export function describeReachability(value: string): { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; hint: string } {
  switch (value) {
    case 'tailnet':
      return { label: 'tailnet 可达', tone: 'ok', hint: 'tailnet 内任意设备均可访问' };
    case 'lan':
      return { label: '仅局域网', tone: 'warn', hint: '绑定在局域网地址上，tailnet 设备需走子网路由' };
    case 'localhost-only':
      return { label: '仅本机', tone: 'warn', hint: '绑定在 127.0.0.1，远程无法直接访问' };
    default:
      return { label: '无入口', tone: 'idle', hint: '没有发布到宿主的端口' };
  }
}

/** OS 名称 → 友好展示。 */
export function describeOs(os: string): string {
  if (!os) return '未知';
  const map: Record<string, string> = {
    windows: 'Windows',
    macOS: 'macOS',
    linux: 'Linux',
    iOS: 'iOS',
    android: 'Android',
  };
  return map[os] ?? map[os.toLowerCase()] ?? os;
}

/** 连接方式 → 中文。 */
export function describeConnection(connection: string): string {
  switch (connection) {
    case 'direct':
      return '直连';
    case 'relay':
      return '中继';
    default:
      return '离线';
  }
}

/** 截断长文本。 */
export function truncate(input: string, max = 60): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

/** 把秒数差格式化为「距上次可见」。 */
export function formatSince(iso: string | null | undefined): string {
  return iso ? formatRelative(iso) : '从未';
}
