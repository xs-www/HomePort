/**
 * F1 容器业务服务：缓存、数据源编排与 HTTP 契约装配。
 *
 * 映射/判定类**纯函数**已抽到 `./mapper.js`（S0-05 技术债拆分）：
 * 端口可达性判定、入口 URL、多候选入口、serve 路由覆盖标记都在那里，
 * 可以脱离真实 Docker 直接单测。本文件只保留有状态的编排逻辑。
 *
 * 缓存：完整容器墙数据按 `all` 维度缓存 `config.cache.containersTtlMs`（默认 2s），
 * stats 不进缓存（开销独立且需要新鲜度）。
 */
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { TtlCache } from '../../util/cache.js';
import { normalizeLines, round } from '../../util/format.js';
import { redactEnvList, redactLines } from '../../util/redact.js';
import { buildHostContext, type PortalHostContext } from './hostContext.js';
import {
  attachHostContext,
  attachServePaths,
  buildCandidates,
  cleanName,
  collectReachableHostPorts,
  dedupeIdenticalBindings,
  detectTailscaleSidecar,
  joinCommand,
  mapContainer,
  mapMounts,
  mapNetworks,
  mapPorts,
  mapServeRoutes,
  normalizeCommandList,
  pickPrimaryUrl,
  rebuildPortUrls,
  summarize,
  urlForBinding,
  type ServeRouteInput,
} from './mapper.js';
import { DockerProvider, mapWithConcurrency, type DockerStatsRaw } from './provider.js';
import type {
  ContainerDetail,
  ContainerListQuery,
  ContainerListResult,
  ContainerLogsResult,
  ContainerStatsView,
  ContainerSummary,
  ServeStatusView,
  SourceStatus,
} from './types.js';

/**
 * 兼容旧调用方：映射纯函数已迁至 `mapper.ts`。
 *
 * 这里保留同名 re-export，`import { mapPorts } from './docker/service.js'`
 * 之类的既有写法无需改动（`server/tests/modules.test.ts` 即依赖此约定）。
 */
export {
  attachHostContext,
  attachServePaths,
  buildCandidates,
  cleanName,
  collectReachableHostPorts,
  dedupeIdenticalBindings,
  detectTailscaleSidecar,
  joinCommand,
  mapContainer,
  mapMounts,
  mapNetworks,
  mapPorts,
  mapServeRoutes,
  normalizeCommandList,
  pickPrimaryUrl,
  rebuildPortUrls,
  summarize,
  urlForBinding,
};
export type { ServeRouteInput };

/** 提供门户主机上下文所需的 tailnet 信息（由 tailscale 模块满足）。 */
export interface HostInfoProvider {
  /** 本机 tailnet IPv4；未知返回 null */
  getTailscaleIpv4(): string | null;
  /** 本机 MagicDNS 名；未知返回 null */
  getTailscaleDnsName(): string | null;
  /** 本机全部 tailnet 地址（用于识别"只绑到 tailnet IP"的端口） */
  getTailscaleIps(): string[];
}

/** 路由层请求的最小形态（避免 service 直接依赖 FastifyRequest）。 */
export interface HostContextRequest {
  /** 与 Fastify 的 `request.protocol` 保持一致，只可能是 http/https */
  protocol: 'http' | 'https';
  hostname: string;
  /** Fastify 在无法确定端口时为 null */
  port: number | null;
  headers: Record<string, string | string[] | undefined>;
}

/** 提供 serve 路由的依赖（由 tailscale 模块满足）。 */
export interface ServeRoutesProvider {
  fetchRoutes(allowHosts: readonly string[]): Promise<{
    available: boolean;
    mode: string;
    detail: string | null;
    routes: ServeRouteInput[];
  }>;
}

export interface ContainerServiceDeps {
  provider: DockerProvider;
  hostInfo: HostInfoProvider;
  /** `tailscale serve` 路由读取（可选；不传则不展示 serve 路由） */
  serveRoutes?: ServeRoutesProvider;
  config: PortalConfig;
  logger: Logger;
}

export class ContainerService {
  private readonly deps: ContainerServiceDeps;
  private listCache: TtlCache<{ items: ContainerSummary[]; source: SourceStatus }>;
  private readonly log: Logger;

  constructor(deps: ContainerServiceDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ mod: 'containers' });
    this.listCache = this.createCache();
  }

  /** 建立容器墙缓存（TTL 取自 config，运行时可变）。 */
  private createCache(): TtlCache<{ items: ContainerSummary[]; source: SourceStatus }> {
    return new TtlCache({
      ttlMs: this.deps.config.cache.containersTtlMs,
      maxEntries: 16,
      logger: this.log,
    });
  }

  /**
   * 运行时设置变更后同步内部状态。
   *
   * 目前处理 `PORTAL_CACHE_CONTAINERS_TTL_MS`：TTL 是构造时读取的，
   * 因此需要重建缓存对象（旧缓存清空，下一次请求重新拉取）。
   *
   * @returns 是否有实际变化
   */
  syncConfig(): boolean {
    const ttl = this.deps.config.cache.containersTtlMs;
    if (this.listCache.defaultTtlMs === ttl) return false;
    this.listCache = this.createCache();
    this.log.debug('容器列表缓存 TTL 已更新', { ttlMs: ttl });
    return true;
  }

  /** 数据源状态（供 /api/health 与前端角标使用）。 */
  async checkAvailability(): Promise<SourceStatus> {
    return this.deps.provider.checkAvailability();
  }

  /**
   * 容器列表（含可达性与入口 URL）。
   *
   * @param query 过滤条件
   * @param request 用于推导门户对外主机
   */
  async list(query: ContainerListQuery, request: HostContextRequest): Promise<ContainerListResult> {
    const cached = await this.loadAll(query.all);
    const hostContext = this.buildHost(request);

    let items = attachHostContext(cached.items, hostContext);
    const serve = await this.buildServeView(cached.items, hostContext);
    items = attachServePaths(items, serve.routes);

    if (query.reachability) {
      items = items.filter((item) => item.reachability === query.reachability);
    }
    if (query.q) {
      const needle = query.q.toLowerCase();
      items = items.filter(
        (item) =>
          item.name.toLowerCase().includes(needle) ||
          item.image.toLowerCase().includes(needle) ||
          item.shortId.toLowerCase().includes(needle) ||
          (item.composeProject ?? '').toLowerCase().includes(needle),
      );
    }

    if (query.stats) {
      const withStats = await mapWithConcurrency(items, 4, async (item) => {
        const stats = await this.loadStats(item.id);
        return { ...item, stats };
      });
      items = withStats;
    }

    return {
      items,
      total: items.length,
      summary: summarize(items),
      source: cached.source,
      serve,
    };
  }

  /**
   * 组装 serve 路由视图。
   *
   * 关键处理：
   * 1. 把路由的监听主机限定为"本机 tailnet 名"（serve 配置里的 key 就是它），
   *    避免把别的节点或历史残留的路由混进来。
   * 2. 目标端口匹配回容器、`coveredByContainerPort` 去重标记由
   *    `mapper.mapServeRoutes` 完成（纯函数，可单测）。
   */
  private async buildServeView(
    containers: readonly ContainerSummary[],
    hostContext: PortalHostContext,
  ): Promise<ServeStatusView> {
    const provider = this.deps.serveRoutes;
    if (!provider) {
      return { available: false, mode: 'none', detail: '未接入 serve 路由读取', routes: [] };
    }

    const allowHosts = [this.deps.hostInfo.getTailscaleDnsName(), hostContext.primaryHost].filter(
      (host): host is string => typeof host === 'string' && host.trim() !== '',
    );

    let result;
    try {
      result = await provider.fetchRoutes(allowHosts);
    } catch (error) {
      this.log.warn('读取 serve 路由失败', { error });
      return {
        available: false,
        mode: 'cli',
        detail: `读取 serve 路由失败：${error instanceof Error ? error.message : String(error)}`,
        routes: [],
      };
    }

    return {
      available: result.available,
      mode: result.mode,
      detail: result.detail,
      routes: mapServeRoutes(result.routes, containers),
    };
  }

  /** 单个容器详情（`:id` 支持完整 ID / 短 ID / 名称）。 */
  async detail(idOrName: string, request: HostContextRequest): Promise<ContainerDetail | null> {
    const resolvedId = await this.resolveId(idOrName);
    if (!resolvedId) return null;

    const inspect = await this.deps.provider.inspectContainer(resolvedId);
    if (!inspect) return null;

    const hostContext = this.buildHost(request);
    const tailscaleIps = this.deps.hostInfo.getTailscaleIps();
    const summary = mapContainer(inspect, hostContext, tailscaleIps);
    const stats = summary.state === 'running' ? await this.loadStats(inspect.Id) : null;

    return {
      ...summary,
      stats,
      command: joinCommand(inspect.Config?.Cmd),
      entrypoint: joinCommand(normalizeCommandList(inspect.Config?.Entrypoint)),
      env: redactEnvList(inspect.Config?.Env),
      restartPolicy: inspect.HostConfig?.RestartPolicy?.Name ?? null,
      networkMode: inspect.HostConfig?.NetworkMode ?? null,
      privileged: inspect.HostConfig?.Privileged === true,
      platform: inspect.Platform ?? null,
      workingDir: inspect.Config?.WorkingDir || null,
      user: inspect.Config?.User || null,
    };
  }

  /** 容器日志（已脱敏）。 */
  async logs(idOrName: string, options: { tail: number; timestamps: boolean }, request: HostContextRequest): Promise<ContainerLogsResult | null> {
    void request;
    const resolvedId = await this.resolveId(idOrName);
    if (!resolvedId) return null;
    const inspect = await this.deps.provider.inspectContainer(resolvedId);
    if (!inspect) return null;

    const isTty = inspect.Config?.Tty === true;
    const raw = await this.deps.provider.getLogs(inspect.Id, { tail: options.tail, timestamps: options.timestamps }, isTty);
    const { lines, truncated } = normalizeLines(raw.text, options.tail);

    return {
      lines: redactLines(lines),
      truncated: truncated || raw.truncated,
      stream: 'stdout+stderr',
      containerId: inspect.Id,
      containerName: cleanName(inspect.Name),
    };
  }

  /**
   * 把 `:id` 解析为可用的容器标识。
   *
   * 顺序：完整/短 ID 直接命中 → 名称匹配 → 名称前缀匹配（唯一时）。
   */
  async resolveId(idOrName: string): Promise<string | null> {
    const cache = await this.loadAll(true);
    const needle = idOrName.trim().replace(/^\//, '');
    if (needle === '') return null;

    const byId = cache.items.find((item) => item.id === needle || item.shortId === needle);
    if (byId) return byId.id;

    const byName = cache.items.find((item) => item.name === needle);
    if (byName) return byName.id;

    const prefixMatches = cache.items.filter((item) => item.id.startsWith(needle) || item.name.startsWith(needle));
    return prefixMatches.length === 1 ? (prefixMatches[0]?.id ?? null) : null;
  }

  /** 组装的「容器墙」数据（已缓存）。 */
  private async loadAll(all: boolean): Promise<{ items: ContainerSummary[]; source: SourceStatus }> {
    const key = `all:${all ? 1 : 0}`;
    return this.listCache.get(key, async () => {
      const source = await this.deps.provider.checkAvailability();
      if (!source.available) {
        return { items: [], source };
      }
      try {
        const inspections = await this.deps.provider.listContainers(all);
        const tailscaleIps = this.deps.hostInfo.getTailscaleIps();
        // hostContext 在响应阶段才注入，这里先用"中性"上下文（localhost），
        // 保证缓存的是与访问者无关的数据。
        const neutral = this.neutralHostContext();
        const items = inspections.map((inspect) => mapContainer(inspect, neutral, tailscaleIps, { skipUrls: true }));
        return { items, source };
      } catch (error) {
        this.log.warn('容器列表获取失败', { error });
        return {
          items: [],
          source: { available: false, mode: source.mode, detail: describeListError(error) },
        };
      }
    });
  }

  private async loadStats(id: string): Promise<ContainerStatsView | null> {
    const raw: DockerStatsRaw | null = await this.deps.provider.getStats(id);
    if (!raw) return null;
    const memPercent =
      raw.memUsedBytes !== null && raw.memLimitBytes !== null && raw.memLimitBytes > 0
        ? round((raw.memUsedBytes / raw.memLimitBytes) * 100, 2)
        : null;
    return {
      cpuPercent: round(raw.cpuPercent, 2),
      memUsedBytes: raw.memUsedBytes,
      memLimitBytes: raw.memLimitBytes,
      memPercent,
      netRxBytes: raw.netRxBytes,
      netTxBytes: raw.netTxBytes,
      blockReadBytes: raw.blockReadBytes,
      blockWriteBytes: raw.blockWriteBytes,
      pids: raw.pids,
      collectedAt: new Date().toISOString(),
    };
  }

  private buildHost(request: HostContextRequest): PortalHostContext {
    return buildHostContext({
      config: this.deps.config,
      request: {
        protocol: request.protocol,
        hostname: request.hostname,
        headers: request.headers,
        port: request.port,
      },
      tailscaleIpv4: this.deps.hostInfo.getTailscaleIpv4(),
      tailscaleDnsName: this.deps.hostInfo.getTailscaleDnsName(),
    });
  }

  private neutralHostContext(): PortalHostContext {
    return buildHostContext({
      config: this.deps.config,
      request: { protocol: 'http', hostname: 'localhost', headers: {}, port: this.deps.config.port },
      tailscaleIpv4: this.deps.hostInfo.getTailscaleIpv4(),
      tailscaleDnsName: this.deps.hostInfo.getTailscaleDnsName(),
    });
  }
}

/** 列表失败时的可展示原因。 */
function describeListError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `读取容器列表失败：${message}`;
}