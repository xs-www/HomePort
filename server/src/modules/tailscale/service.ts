/**
 * F2 tailnet 业务服务。
 *
 * 职责：
 * 1. 缓存 tailnet 状态（默认 5s），避免每次请求都 fork 一个 tailscale 进程。
 * 2. 暴露本机 tailnet 地址/MagicDNS 名给容器模块（`HostInfoProvider`），
 *    用于判断容器端口是否可通过 tailnet 访问。
 * 3. 提供同步读取接口（`getTailscaleIpv4` 等）—— 这些方法**只读上一次缓存**，
 *    不触发命令执行，避免在渲染容器墙时产生隐式阻塞。
 */
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { TtlCache } from '../../util/cache.js';
import type { HostInfoProvider } from '../docker/service.js';
import { getCachedTailnetInfo, setCachedTailnetInfo } from './hostInfoCache.js';
import { runCommand } from '../../util/exec.js';
import type { CommandRunner, TailscaleProvider } from './provider.js';
import { unavailableStatus } from './provider.js';
import type { SourceStatus, TailnetStatus, TailnetStatusLite } from './types.js';
export interface TailscaleServiceDeps {
  provider: TailscaleProvider;
  config: PortalConfig;
  logger: Logger;
}

export class TailscaleService implements HostInfoProvider {
  private readonly deps: TailscaleServiceDeps;
  private readonly cache: TtlCache<TailnetStatus>;
  private lastStatus: TailnetStatus | null = null;

  constructor(deps: TailscaleServiceDeps) {
    this.deps = deps;
    this.cache = new TtlCache<TailnetStatus>({
      ttlMs: deps.config.cache.tailscaleTtlMs,
      maxEntries: 4,
      logger: deps.logger.child({ mod: 'tailscale' }),
    });
  }

  /** 数据源模式（cli / api / none）。 */
  get mode(): string {
    return this.deps.provider.mode;
  }

  /** 拉取状态（带缓存）。同时刷新给容器模块用的同步缓存。 */
  async getStatus(force = false): Promise<TailnetStatus> {
    if (force) this.cache.delete('status');
    const status = await this.cache.get('status', () => this.deps.provider.fetchStatus());
    this.remember(status);
    return status;
  }

  /** 精简版状态（顶栏/概览用）。 */
  async getStatusLite(force = false): Promise<TailnetStatusLite> {
    const status = await this.getStatus(force);
    return {
      self: status.self,
      summary: status.summary,
      backendState: status.backendState,
      source: status.source,
    };
  }

  /** 数据源可用性（供 /api/health）。 */
  async checkAvailability(): Promise<SourceStatus> {
    const status = await this.getStatus();
    return status.source;
  }

  /** 立即刷新一次（进程启动时预热，见 app.ts）。 */
  async warmup(): Promise<void> {
    try {
      await this.getStatus(true);
    } catch (error) {
      this.deps.logger.debug('tailnet 预热失败', { error });
    }
  }

  /** 本机 tailnet IPv4（同步，取最近一次成功结果）。 */
  getTailscaleIpv4(): string | null {
    return getCachedTailnetInfo()?.ipv4 ?? null;
  }

  /** 本机 MagicDNS 名。 */
  getTailscaleDnsName(): string | null {
    const info = getCachedTailnetInfo();
    if (info?.dnsName) return info.dnsName;
    const suffix = this.lastStatus?.tailnet.magicDnsSuffix;
    const hostname = this.lastStatus?.self?.hostname;
    if (suffix && hostname) return `${hostname}.${suffix}`;
    return null;
  }

  /** 本机全部 tailnet 地址。 */
  getTailscaleIps(): string[] {
    const ips: string[] = [];
    const info = getCachedTailnetInfo();
    if (info?.ipv4) ips.push(info.ipv4);
    if (info?.ipv6) ips.push(info.ipv6);
    return ips;
  }

  /** 供诊断接口使用的原始状态。 */
  getLastStatus(): TailnetStatus | null {
    return this.lastStatus;
  }

  private remember(status: TailnetStatus): void {
    this.lastStatus = status;
    // 数据源不可用时**保留**旧的 tailnet 地址：宁可用"稍旧的地址"判定可达性，
    // 也不要在 tailscale 命令偶发失败时把整面容器墙判成不可达。
    if (status.self) {
      setCachedTailnetInfo({
        ipv4: status.self.ipv4,
        ipv6: status.self.ipv6,
        dnsName: status.self.dnsName || null,
        hostname: status.self.hostname,
      });
    }
  }
}

/** 默认命令执行器（生产环境）。 */
export const defaultCommandRunner: CommandRunner = async (command, args) => {
  const result = await runCommand(command, args, { timeoutMs: 5000 });
  return {
    code: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    notFound: result.notFound,
  };
};

/** 便捷：构造一个"永久不可用"的服务（测试用）。 */
export function createUnavailableTailscaleService(config: PortalConfig, logger: Logger): TailscaleService {
  const provider: TailscaleProvider = {
    mode: 'none',
    isConfigured: () => false,
    fetchStatus: async () => unavailableStatus('none', '测试桩：tailnet 数据源不可用'),
  };
  return new TailscaleService({ provider, config, logger });
}
