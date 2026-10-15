/**
 * 展示格式化与解析工具：字节、百分比、时长，以及 Docker 时间戳解析。
 */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * 字节数转人类可读字符串（二进制单位，保留 `digits` 位小数）。
 *
 * @example `formatBytes(1536) → '1.50 KB'`
 */
export function formatBytes(bytes: number, digits = 2): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes === 0) return '0 B';
  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : digits)} ${BYTE_UNITS[exponent]}`;
}

/** 数值保留小数位；非有限值返回 `null`。 */
export function round(value: number | null | undefined, digits = 1): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** 百分比：`used/total*100`，total<=0 时返回 null。 */
export function percentOf(used: number, total: number, digits = 1): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  return round((used / total) * 100, digits);
}

/** 时长（秒）转 `3天 4小时 5分` 形式。 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '-';
  const total = Math.floor(seconds);
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}天`);
  if (hours > 0) parts.push(`${hours}小时`);
  if (minutes > 0 && days === 0) parts.push(`${minutes}分`);
  if (parts.length === 0) parts.push(`${secs}秒`);
  return parts.join(' ');
}

/** Docker 的纳秒级时间戳（`StartedAt` 等）解析为 Date；无效返回 null。 */
export function parseDockerTime(value: string | undefined | null): Date | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('0001-01-01')) return null;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** ISO 字符串（无效返回 null）。 */
export function toIso(value: Date | null | undefined): string | null {
  if (!value) return null;
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

/** Unix 秒 → ISO 字符串。 */
export function unixSecondsToIso(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * 折叠文本行：去除 ANSI 转义与行尾 `\r`，过滤空行。
 *
 * @param limit 最多保留的行数（从**末尾**保留，即最近的日志）
 */
export function normalizeLines(input: string, limit?: number): { lines: string[]; truncated: boolean } {
  // eslint-disable-next-line no-control-regex
  const ansiRe = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
  const all = input
    .replace(ansiRe, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim().length > 0);
  if (limit !== undefined && all.length > limit) {
    return { lines: all.slice(all.length - limit), truncated: true };
  }
  return { lines: all, truncated: false };
}

/** 生成短 ID（用于会话/CSRF 等非加密用途请改用 crypto）。 */
export function shortId(length = 8): string {
  return Math.random().toString(36).slice(2, 2 + length);
}
