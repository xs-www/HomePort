/**
 * 请求主机上下文解析：决定「门户的对外主机是谁」，容器入口 URL 据此生成。
 *
 * 背景：同一份容器数据在三种访问场景下需要不同的 URL
 * （同机浏览器用 localhost、tailnet 内用 100.x 或 MagicDNS）。
 * 策略是**以访问者看到的门户地址为准**，再用配置的 `PORTAL_PUBLIC_HOST` 与
 * 本机 tailnet 地址补充候选，前端可选择切换。
 */
import type { PortalConfig } from '../../config.js';
import { isInternalHost, isLoopbackHost, isMagicDnsName, isTailscaleIp } from '../../util/net.js';

export interface HostCandidate {
  label: 'tailnet' | 'magicdns' | 'localhost' | 'lan' | 'custom';
  host: string;
  /** 展示名（可选） */
  display?: string;
}

export interface PortalHostContext {
  /** 访问者实际使用的协议 */
  scheme: string;
  /** 访问者实际使用的主机名（可能带端口） */
  host: string;
  /** 访问者实际使用的端口（无显式端口则为 null） */
  port: number | null;
  candidates: HostCandidate[];
  /** 用于生成容器 URL 的"首选主机" */
  primaryHost: string;
  /** 首选协议 */
  primaryScheme: string;
}

export interface BuildHostContextInput {
  config: PortalConfig;
  request: {
    protocol: string;
    hostname: string;
    headers: Record<string, string | string[] | undefined>;
    port: number | null;
  };
  /** 本机 tailnet IPv4 地址（来自 Tailscale 模块，可能为空） */
  tailscaleIpv4: string | null;
  /** 本机 MagicDNS 名（来自 Tailscale 模块，可能为空） */
  tailscaleDnsName: string | null;
}

/** 从 Host 头解析主机与端口（兼容 IPv6 字面量）。 */
export function splitHostPort(hostHeader: string | undefined, fallbackPort: number | null): { host: string; port: number | null } {
  if (!hostHeader) return { host: '', port: fallbackPort };
  const trimmed = hostHeader.trim();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    const host = trimmed.slice(1, end === -1 ? undefined : end);
    const rest = end === -1 ? '' : trimmed.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : null;
    return { host, port: Number.isFinite(port) ? port : fallbackPort };
  }
  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) return { host: trimmed, port: fallbackPort };
  const maybePort = Number(trimmed.slice(idx + 1));
  if (!Number.isInteger(maybePort) || maybePort <= 0 || maybePort > 65535) {
    return { host: trimmed, port: fallbackPort };
  }
  return { host: trimmed.slice(0, idx), port: maybePort };
}

/**
 * 构造主机上下文。
 *
 * 候选顺序（前端下拉按此顺序展示）：
 * 1. 配置的 `PORTAL_PUBLIC_HOST`（若设置，作为首选）
 * 2. MagicDNS 名
 * 3. tailnet IPv4
 * 4. 访问者实际使用的主机（若不在上述之列）
 * 5. localhost
 */
export function buildHostContext(input: BuildHostContextInput): PortalHostContext {
  const { config, request, tailscaleIpv4, tailscaleDnsName } = input;
  const forwardedHost = config.trustProxy ? firstHeader(request.headers['x-forwarded-host']) : undefined;
  const hostHeader = forwardedHost ?? firstHeader(request.headers.host);
  // Fastify 的 request.port 可能为 null（无法从 Host 头推断时），回退到监听端口
  const fallbackPort = Number.isFinite(request.port as number) ? (request.port as number) : config.port;
  const { host: requestHost, port: requestPort } = splitHostPort(hostHeader, fallbackPort);

  const scheme = config.forwardedProtoTrusted
    ? (firstHeader(request.headers['x-forwarded-proto']) ?? request.protocol ?? 'http')
    : (request.protocol ?? 'http');

  const candidates: HostCandidate[] = [];
  const seen = new Set<string>();
  const push = (label: HostCandidate['label'], host: string | null, display?: string): void => {
    if (!host) return;
    const key = host.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ label, host, ...(display ? { display } : {}) });
  };

  const configuredHost = config.publicHost.trim();
  const configuredPort = config.publicPort > 0 ? config.publicPort : null;

  push('custom', configuredHost || null, configuredHost ? '自定义公开主机' : undefined);
  push('magicdns', tailscaleDnsName, 'MagicDNS');
  push('tailnet', tailscaleIpv4, 'Tailnet IP');
  // 访问者自己的主机：如果是回环或容器内部别名，浏览器实际可用，但仍标为 localhost
  if (requestHost && !isInternalHost(requestHost) && !isLoopbackHost(requestHost)) {
    push(isTailscaleIp(requestHost) ? 'tailnet' : isMagicDnsName(requestHost) ? 'magicdns' : 'lan', requestHost);
  }
  push('localhost', 'localhost', '本机');

  const primaryHost = configuredHost || tailscaleDnsName || tailscaleIpv4 || (isInternalHost(requestHost) ? 'localhost' : requestHost) || 'localhost';
  const primaryScheme = configuredHost ? config.publicScheme : scheme;

  return {
    scheme,
    host: requestHost,
    port: configuredHost && configuredPort !== null ? configuredPort : requestPort,
    candidates,
    primaryHost,
    primaryScheme,
  };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

/** 生成指定主机的门户地址（用于诊断与日志）。 */
export function portalUrl(ctx: PortalHostContext, host: string, port: number | null): string {
  const scheme = ctx.primaryScheme;
  const defaultPort = scheme === 'https' ? 443 : 80;
  const effectivePort = port ?? ctx.port;
  const includePort = effectivePort !== null && effectivePort > 0 && effectivePort !== defaultPort;
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${scheme}://${authority}${includePort ? `:${effectivePort}` : ''}`;
}
