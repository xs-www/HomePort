/**
 * `tailscale serve` 路由读取。
 *
 * ## 为什么需要它
 *
 * `tailscale serve` 把本机服务以「路径」形式挂在 tailnet 域名下
 * （如 `https://host.tailnet.ts.net/calendar → http://127.0.0.1:443/calendar`）。
 * 这类服务的特点是：
 *
 * 1. **可能没有发布到宿主的端口**（例如 DSH 只在宿主 3081 上监听），
 *    因此仅靠 Docker 的 `PortBindings` 判定可达性会**完全看不到它们**。
 * 2. serve 本身就是"已暴露到 tailnet"的声明，所以路由的存在性等价于可达性 ——
 *    这正是 F1 要展示的东西。
 *
 * ## 数据来源与平台限制
 *
 * 来源是节点**本地**状态：`tailscale serve status --json`。
 * 因此需要容器内能执行 tailscale CLI：
 *
 * | 宿主 | 可用性 |
 * | --- | --- |
 * | Linux / NAS | ✅ 挂载 `tailscale` 二进制 + `tailscaled.sock` 即可 |
 * | Windows（容器化） | ❌ 容器是 Linux 环境，无法执行 `tailscale.exe`（WSL interop 不可用），
 *   且 Windows 的 tailscaled 走 named pipe，容器够不着 |
 *
 * Tailscale 的 REST API 只覆盖设备/用户/ACL/DNS，**不含** serve 配置，
 * 所以 API 模式下这条路读不到数据（会如实报告原因，而不是静默为空）。
 */
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { runCommand, type RunCommandResult } from '../../util/exec.js';
import { withSocket } from './provider.js';

/** 一条 serve 路由（= 一个路径 handler）。 */
export interface ServeRoute {
  /** 绑定的主机名（来自 serve 配置的 key），如 `sisi-laptop.tail921448.ts.net` */
  host: string;
  /** 监听端口，通常 443 或 8443 */
  port: number;
  /** 协议：serve 总是 HTTPS；funnel 也是 */
  scheme: 'https';
  /** 挂载路径，如 `/`、`/calendar` */
  path: string;
  /** 代理目标地址，如 `http://127.0.0.1:443/calendar` */
  proxy: string;
  /** 目标主机（通常 127.0.0.1） */
  targetHost: string | null;
  /** 目标端口 */
  targetPort: number | null;
  /** 目标路径（可能带前缀，用于匹配需要重写的路由） */
  targetPath: string | null;
  /** 可直接点击的入口 URL */
  url: string;
  /** 是否只监听 tailnet（serve）还是公开到公网（funnel）。当前 CLI 不区分，恒为 false */
  funnel: boolean;
}

export interface ServeStatusResult {
  available: boolean;
  mode: string;
  detail: string | null;
  routes: ServeRoute[];
}

/** `tailscale serve status --json` 的响应结构。 */
export interface ServeStatusJson {
  TCP?: Record<string, { HTTPS?: boolean; HTTP?: boolean }>;
  Web?: Record<string, { Handlers?: Record<string, { Proxy?: string; Text?: string }> }>;
}

/**
 * 解析 serve 配置 JSON。
 *
 * 结构：`Web["<host>:<port>"].Handlers["<path>"] = { Proxy: "http://host:port/path" }`
 *
 * @param allowHosts 只保留这些主机名的路由；为空表示全部保留。
 *   用途：`tailscale serve status` 的 key 用的是节点自身的 MagicDNS 名，
 *   与门户配置的对外主机名可能不同（大小写、尾随点），需要归一化后过滤。
 */
export function parseServeStatus(json: ServeStatusJson, allowHosts: readonly string[] = []): ServeRoute[] {
  const normalizedAllow = new Set(
    allowHosts.map((host) => host.trim().toLowerCase().replace(/\.$/, '')).filter((host) => host !== ''),
  );
  const routes: ServeRoute[] = [];

  for (const [hostPort, entry] of Object.entries(json.Web ?? {})) {
    const parsed = parseHostPort(hostPort);
    if (!parsed) continue;
    const hostKey = parsed.host.toLowerCase().replace(/\.$/, '');
    if (normalizedAllow.size > 0 && !normalizedAllow.has(hostKey)) continue;

    for (const [path, handler] of Object.entries(entry?.Handlers ?? {})) {
      const proxy = (handler?.Proxy ?? '').trim();
      // Text handler（serve 静态文案）没有 Proxy，门户无法生成入口，跳过
      if (proxy === '') continue;

      const target = parseProxyTarget(proxy);
      routes.push({
        host: parsed.host,
        port: parsed.port,
        scheme: 'https',
        path: normalizePath(path),
        proxy,
        targetHost: target?.host ?? null,
        targetPort: target?.port ?? null,
        targetPath: target?.path ?? null,
        url: `https://${parsed.host}${parsed.port === 443 ? '' : `:${parsed.port}`}${normalizePath(path)}`,
        funnel: false,
      });
    }
  }

  // 排序：主机 → 端口 → 路径（`/` 优先，其余按字典序）
  routes.sort((a, b) => {
    if (a.host !== b.host) return a.host.localeCompare(b.host);
    if (a.port !== b.port) return a.port - b.port;
    if (a.path === b.path) return 0;
    if (a.path === '/') return -1;
    if (b.path === '/') return 1;
    return a.path.localeCompare(b.path);
  });

  return routes;
}

/** 解析 `host:port` 形式的 key（兼容 IPv6 方括号）。 */
export function parseHostPort(value: string): { host: string; port: number } | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end === -1) return null;
    const host = trimmed.slice(1, end);
    const rest = trimmed.slice(end + 1);
    const port = rest.startsWith(':') ? Number(rest.slice(1)) : Number.NaN;
    return Number.isInteger(port) && port > 0 ? { host, port } : null;
  }

  const idx = trimmed.lastIndexOf(':');
  if (idx === -1) return null;
  const host = trimmed.slice(0, idx);
  const port = Number(trimmed.slice(idx + 1));
  if (host === '' || !Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return { host, port };
}

/** 解析代理目标 `http://127.0.0.1:443/calendar`。 */
export function parseProxyTarget(proxy: string): { host: string; port: number; path: string } | null {
  try {
    const url = new URL(proxy);
    const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
    if (!Number.isInteger(port) || port <= 0) return null;
    return { host: url.hostname, port, path: url.pathname === '' ? '/' : url.pathname };
  } catch {
    return null;
  }
}

/** 规范化路径：保证以 `/` 开头；空前缀视为 `/`。 */
export function normalizePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === '') return '/';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export interface ServeProviderOptions {
  config: PortalConfig;
  logger: Logger;
}

/**
 * serve 路由读取器。
 *
 * 与 `CliTailscaleProvider` 分开实现的原因：这两条查询的可用性**并不一致** ——
 * 在 Windows 上 `status --json` 可能通过 API 模式拿到，但 serve 配置只有 CLI 才有。
 * 因此需要独立报告可用性，UI 才能给出准确的原因。
 */
export class ServeProvider {
  private readonly config: PortalConfig;
  private readonly log: Logger;

  constructor(options: ServeProviderOptions) {
    this.config = options.config;
    this.log = options.logger.child({ mod: 'tailscale-serve' });
  }

  /** 当前是否为 CLI 模式（只有 CLI 能读 serve 配置）。 */
  get cliAvailable(): boolean {
    const mode = this.config.tailscale.mode;
    if (mode === 'off') return false;
    if (mode === 'api') return false;
    return true;
  }

  /**
   * 拉取 serve 路由。
   *
   * `--socket` 通过 `withSocket` 放在**子命令之前**（全局 flag）。
   */
  async fetchRoutes(allowHosts: readonly string[] = []): Promise<ServeStatusResult> {
    if (this.config.tailscale.mode === 'off') {
      return { available: false, mode: 'off', detail: 'tailnet 查询已关闭', routes: [] };
    }
    if (this.config.tailscale.mode === 'api') {
      return {
        available: false,
        mode: 'api',
        detail:
          'serve 配置是节点本地状态，Tailscale REST API 不提供。需要读取 serve 路由请改用 CLI 模式（挂载宿主 tailscale 与 tailscaled.sock）',
        routes: [],
      };
    }

    const bin = this.config.tailscale.bin;
    const args = withSocket(['serve', 'status', '--json'], this.config.tailscale.socket);
    const result = await runCommand(bin, args, { timeoutMs: this.config.tailscale.timeoutMs });

    const failure = describeServeFailure(result, bin);
    if (failure) {
      this.log.debug('serve 状态读取失败', { detail: failure.detail });
      return failure;
    }

    try {
      const json = JSON.parse(result.stdout) as ServeStatusJson;
      const routes = parseServeStatus(json, allowHosts);
      return { available: true, mode: 'cli', detail: null, routes };
    } catch (error) {
      this.log.warn('serve 输出解析失败', { error });
      return { available: false, mode: 'cli', detail: 'tailscale serve 输出不是合法 JSON', routes: [] };
    }
  }
}

/** 把命令失败翻译成可展示的原因。 */
export function describeServeFailure(
  result: Pick<RunCommandResult, 'code' | 'stderr' | 'timedOut' | 'notFound'>,
  bin: string,
): ServeStatusResult | null {
  if (result.notFound) {
    return {
      available: false,
      mode: 'cli',
      detail: `未找到 tailscale 可执行文件（${bin}）。读取 serve 路由需要把宿主 tailscale 与 tailscaled.sock 挂进容器`,
      routes: [],
    };
  }
  if (result.timedOut) {
    return { available: false, mode: 'cli', detail: 'tailscale serve status 执行超时', routes: [] };
  }
  if (result.code !== 0) {
    const stderr = (result.stderr ?? '').trim().split('\n')[0] ?? '';
    return {
      available: false,
      mode: 'cli',
      detail: `tailscale serve status 失败（退出码 ${result.code}）${stderr ? `：${stderr}` : ''}`,
      routes: [],
    };
  }
  return null;
}
