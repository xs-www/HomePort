/**
 * 网络相关纯函数：IP 分类、可达性判定、URL 构造。
 *
 * 这些函数是 F1「tailnet 可达性判定」的判定核心，必须保持纯函数以便单测。
 */

export type Reachability = 'tailnet' | 'lan' | 'localhost-only' | 'none';

/** Tailscale IPv4 CGNAT 段：100.64.0.0/10 */
const TS_V4_PREFIX = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
/** Tailscale IPv6 ULA 段：fd7a:115c:a1e0::/48 */
const TS_V6_PREFIX = /^fd7a:115c:a1e0:/i;

/** 判断是否为 Tailscale 分配地址（v4 CGNAT 段或 v6 ULA 段）。 */
export function isTailscaleIp(ip: string): boolean {
  return TS_V4_PREFIX.test(ip) || TS_V6_PREFIX.test(ip);
}

/** 判断是否为回环地址（含空主机名与 localhost 字面量）。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '' || h === 'localhost' || h === '::1' || h === '[::1]') return true;
  return h.startsWith('127.');
}

/** 判断是否为「监听全部接口」的绑定地址。 */
export function isWildcardHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  return h === '' || h === '0.0.0.0' || h === '::' || h === '[::]' || h === '*';
}

/** 判断是否为基础局域网地址（RFC1918 或链路本地）。 */
export function isPrivateLanIp(ip: string): boolean {
  if (/^10\./.test(ip)) return true;
  if (/^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  if (/^fe80:/i.test(ip)) return true;
  return false;
}

/**
 * 根据宿主绑定地址判定可达范围。
 *
 * @param hostIp Docker `HostIp` 字段（可能为空、`0.0.0.0`、具体 IP）
 * @param tailscaleIps 本机 tailnet 地址列表，用于识别「只绑到 tailnet IP」的情况
 */
export function classifyBind(hostIp: string, tailscaleIps: readonly string[] = []): Reachability {
  if (isWildcardHost(hostIp)) return 'tailnet';
  if (isLoopbackHost(hostIp)) return 'localhost-only';
  if (isTailscaleIp(hostIp)) return 'tailnet';
  if (tailscaleIps.includes(hostIp)) return 'tailnet';
  if (isPrivateLanIp(hostIp)) return 'lan';
  return 'lan';
}

/** 可达性排序权重，数字越小越优（用于挑选 primaryUrl）。 */
export const REACHABILITY_RANK: Record<Reachability, number> = {
  tailnet: 0,
  lan: 1,
  'localhost-only': 2,
  none: 3,
};

/** 取更优（更通用）的可达性等级。 */
export function bestReachability(a: Reachability, b: Reachability): Reachability {
  return REACHABILITY_RANK[a] <= REACHABILITY_RANK[b] ? a : b;
}

/**
 * IPv6 字面量加方括号。
 *
 * @example `hostForUrl('fd7a::1') → '[fd7a::1]'`；`hostForUrl('100.64.0.1') → '100.64.0.1'`
 */
export function hostForUrl(host: string): string {
  if (host.startsWith('[')) return host;
  return host.includes(':') ? `[${host}]` : host;
}

export interface BuildUrlInput {
  scheme?: string;
  host: string;
  port?: number | null;
  path?: string;
  /** 省略默认端口（http:80 / https:443） */
  omitDefaultPort?: boolean;
}

/**
 * 组装 URL，自动处理 IPv6 方括号与默认端口省略。
 *
 * @returns 合法 URL 字符串；host 为空时返回 `null`
 */
export function buildUrl(input: BuildUrlInput): string | null {
  const { scheme = 'http', host, port = null, path = '/', omitDefaultPort = true } = input;
  if (!host || host.trim() === '') return null;
  const normalizedScheme = scheme.replace(/:$/, '');
  const defaultPort = normalizedScheme === 'https' ? 443 : 80;
  const includePort = port !== null && port > 0 && !(omitDefaultPort && port === defaultPort);
  const authority = `${hostForUrl(host)}${includePort ? `:${port}` : ''}`;
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizedScheme}://${authority}${normalizedPath}`;
}

/**
 * 判断主机名是否只在本容器/宿主内部有意义，需要在浏览器侧替换为门户当前主机。
 *
 * @param host 候选 URL 主机
 * @param dockerHostAliases 需要替换的别名集合（如 `host.docker.internal`）
 */
export function isInternalHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackHost(h)) return true;
  return ['host.docker.internal', 'gateway.docker.internal', 'docker.for.win.localhost', 'host.containers.internal'].includes(h);
}

/** 从 Docker 端口键 `"8080/tcp"` 解析出端口号与协议；非法返回 null。 */
export function parsePortKey(key: string): { port: number; protocol: string } | null {
  const [portPart, protocol = 'tcp'] = key.split('/');
  const port = Number(portPart);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { port, protocol: protocol.toLowerCase() };
}

/**
 * 从容器网络设置中收集容器的 IPv4 地址。
 *
 * @param networks dockerode `NetworkSettings.Networks`
 */
export function collectContainerIps(networks: Record<string, { IPAddress?: string }> | undefined): string[] {
  if (!networks) return [];
  return Object.values(networks)
    .map((n) => n?.IPAddress ?? '')
    .filter((ip) => ip.length > 0);
}

/** 是否为 MagicDNS 域名（以 `.ts.net` 结尾）。 */
export function isMagicDnsName(host: string): boolean {
  return host.trim().toLowerCase().endsWith('.ts.net');
}

/** 从 MagicDNS FQDN 中提取 tailnet 名（`sisi-laptop.tail921448.ts.net` → `tail921448.ts.net`）。 */
export function tailnetFromDnsName(dnsName: string): string | null {
  const clean = dnsName.trim().replace(/\.$/, '');
  const parts = clean.split('.');
  if (parts.length < 4 || !isMagicDnsName(clean)) return null;
  return parts.slice(1).join('.');
}
