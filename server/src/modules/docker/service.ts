/**
 * F1 容器业务服务：把 Docker 原始数据映射为门户契约（含 tailnet 可达性与入口 URL）。
 *
 * 缓存：完整容器墙数据按 `all` 维度缓存 `config.cache.containersTtlMs`（默认 2s），
 * stats 不进缓存（开销独立且需要新鲜度）。
 */
import type { ContainerInspectInfo } from 'dockerode';
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { TtlCache } from '../../util/cache.js';
import { normalizeLines, parseDockerTime, round, toIso } from '../../util/format.js';
import {
  REACHABILITY_RANK,
  bestReachability,
  buildUrl,
  classifyBind,
  isTailscaleIp,
  parsePortKey,
  type Reachability,
} from '../../util/net.js';
import { redactEnvList, redactLines } from '../../util/redact.js';
import { buildHostContext, type PortalHostContext } from './hostContext.js';
import { DockerProvider, mapWithConcurrency, type DockerStatsRaw } from './provider.js';
import {
  TAILSCALE_IMAGE_RE,
  type ContainerDetail,
  type ContainerListQuery,
  type ContainerListResult,
  type ContainerLogsResult,
  type ContainerMountView,
  type ContainerNetworkView,
  type ContainerPortView,
  type ContainerStatsView,
  type ContainerSummary,
  type ServeRouteView,
  type ServeStatusView,
  type SourceStatus,
  type UrlCandidate,
} from './types.js';

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
    routes: Array<{
      host: string;
      port: number;
      scheme: 'https';
      path: string;
      url: string;
      proxy: string;
      targetHost: string | null;
      targetPort: number | null;
      funnel: boolean;
    }>;
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

const LOCALHOST_NOTE = '该端口仅绑定回环地址（127.0.0.1），tailnet 内其它设备无法直接访问';
const UNPUBLISHED_NOTE = '该端口未发布到宿主，容器网络内可见';

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

    let items = this.attachHostContext(cached.items, hostContext);
    const serve = await this.buildServeView(cached.items, hostContext);
    items = this.attachServePaths(items, serve.routes);

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
   * 2. 把目标端口匹配回容器，便于 UI 显示"这条 serve 指向哪个容器"。
   * 3. 标记 `coveredByContainerPort`：若该目标端口已经作为可达端口展示过
   *    （例如 worldforge 的 4173 已发布到宿主），就不再单独列一条，
   *    改为在容器卡上打 serve 标记，避免同一入口出现两次。
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

    // 已作为可达端口展示过的宿主端口（用于去重）
    const reachableHostPorts = new Set<number>();
    for (const container of containers) {
      for (const port of container.ports) {
        if (port.reachability === 'tailnet' || port.reachability === 'lan') {
          if (port.hostPort !== null) reachableHostPorts.add(port.hostPort);
        }
      }
    }

    const routes: ServeRouteView[] = result.routes.map((route) => {
      const owner =
        route.targetPort === null
          ? null
          : (containers.find((container) =>
              container.ports.some((port) => port.hostPort === route.targetPort),
            ) ?? null);
      return {
        host: route.host,
        port: route.port,
        scheme: route.scheme,
        path: route.path,
        url: route.url,
        proxy: route.proxy,
        targetHost: route.targetHost,
        targetPort: route.targetPort,
        containerName: owner?.name ?? null,
        containerId: owner?.id ?? null,
        coveredByContainerPort: route.targetPort !== null && reachableHostPorts.has(route.targetPort),
      };
    });

    return { available: result.available, mode: result.mode, detail: result.detail, routes };
  }

  /** 把 serve 路径写到对应容器上（卡片标记用）。 */
  private attachServePaths(
    items: readonly ContainerSummary[],
    routes: readonly ServeRouteView[],
  ): ContainerSummary[] {
    return items.map((item) => {
      const matched = routes.filter((route) => route.containerId === item.id);
      if (matched.length === 0) {
        return { ...item, servePaths: [], servedUrl: null };
      }
      return {
        ...item,
        servePaths: matched.map((route) => route.path),
        // 优先给容器自身的 serve 入口；没有则给第一条
        servedUrl: matched.find((route) => route.targetPort !== null)?.url ?? matched[0]?.url ?? null,
      };
    });
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

  /** 把缓存的容器条目与当前请求的 host 上下文结合，重新生成 URL。 */
  private attachHostContext(items: ContainerSummary[], hostContext: PortalHostContext): ContainerSummary[] {
    return items.map((item) => {
      const ports: ContainerPortView[] = item.ports.map((port) => rebuildPortUrls(port, hostContext, item.name));
      return {
        ...item,
        ports,
        reachability: ports.reduce<Reachability>((acc, port) => bestReachability(acc, port.reachability), 'none'),
        primaryUrl: pickPrimaryUrl(ports),
        urlCandidates: buildCandidates(ports, hostContext),
      };
    });
  }
}

/** 汇总统计。 */
export function summarize(items: readonly ContainerSummary[]): ContainerListResult['summary'] {
  let running = 0;
  let stopped = 0;
  let tailnetReachable = 0;
  let lanReachable = 0;
  let localhostOnly = 0;
  let attention = 0;

  for (const item of items) {
    const isRunning = item.state === 'running';
    if (isRunning) running += 1;
    else stopped += 1;

    if (item.reachability === 'tailnet') tailnetReachable += 1;
    else if (item.reachability === 'lan') lanReachable += 1;
    else if (item.reachability === 'localhost-only') localhostOnly += 1;

    const unhealthy = item.health !== null && item.health !== 'healthy' && item.health !== 'none';
    if (!isRunning || unhealthy || (isRunning && item.reachability === 'none')) attention += 1;
  }

  return { total: items.length, running, stopped, tailnetReachable, lanReachable, localhostOnly, attention };
}

/** 容器名去掉前导斜杠。 */
export function cleanName(name: string | undefined): string {
  return (name ?? '').replace(/^\//, '');
}

/**
 * 把 Docker inspect 结果映射为容器摘要。
 *
 * @param skipUrls 为 true 时（缓存阶段）不生成 URL，URL 由 attachHostContext 在响应阶段生成
 */
export function mapContainer(
  inspect: ContainerInspectInfo,
  hostContext: PortalHostContext,
  tailscaleIps: readonly string[],
  options: { skipUrls?: boolean } = {},
): ContainerSummary {
  const name = cleanName(inspect.Name) || inspect.Id.slice(0, 12);
  const labels = (inspect.Config?.Labels ?? {}) as Record<string, string>;
  const networks = mapNetworks(inspect);
  const ports = mapPorts(inspect, hostContext, tailscaleIps, name);
  const tailscaleSidecar = detectTailscaleSidecar(inspect);

  const health = inspect.State?.Health?.Status ?? (inspect.Config?.Healthcheck ? 'starting' : null);

  const summary: ContainerSummary = {
    id: inspect.Id,
    shortId: inspect.Id.slice(0, 12),
    name,
    image: inspect.Config?.Image ?? '',
    imageId: inspect.Image ?? null,
    state: inspect.State?.Status ?? 'unknown',
    status: inspect.State?.Status ?? 'unknown',
    health,
    createdAt: toIso(parseDockerTime(inspect.Created)),
    startedAt: toIso(parseDockerTime(inspect.State?.StartedAt)),
    finishedAt: toIso(parseDockerTime(inspect.State?.FinishedAt)),
    composeProject: labels['com.docker.compose.project'] ?? null,
    composeService: labels['com.docker.compose.service'] ?? null,
    composeWorkingDir: labels['com.docker.compose.project.working_dir'] ?? null,
    labels,
    networks,
    mounts: mapMounts(inspect),
    reachability: ports.reduce<Reachability>((acc, port) => bestReachability(acc, port.reachability), 'none'),
    primaryUrl: pickPrimaryUrl(ports),
    ports,
    urlCandidates: buildCandidates(ports, hostContext),
    tailscaleSidecar,
    servePaths: [],
    servedUrl: null,
    stats: null,
  };

  if (options.skipUrls) {
    // 缓存阶段：保留可达性判定（与 host 无关），但清空 URL 相关字段
    return {
      ...summary,
      ports: summary.ports.map((port) => ({ ...port, url: null })),
      primaryUrl: null,
      urlCandidates: [],
    };
  }
  return summary;
}

/** 映射网络信息。 */
export function mapNetworks(inspect: ContainerInspectInfo): ContainerNetworkView[] {
  const entries = Object.entries(inspect.NetworkSettings?.Networks ?? {});
  return entries.map(([networkName, network]) => {
    // dockerode 的 EndpointSettings.Aliases 在部分版本中类型缺失（隐式 any），
    // 这里显式收窄为 unknown 再判断，避免依赖其声明。
    const aliasSource: unknown = network?.Aliases;
    const aliases = Array.isArray(aliasSource) ? aliasSource.filter((a): a is string => typeof a === 'string') : [];
    const ipv4 = network?.IPAddress;
    return {
      name: networkName,
      ipv4: ipv4 && ipv4 !== '' ? ipv4 : null,
      aliases,
    };
  });
}

/** 映射挂载点（过滤 docker.sock 等自动注入项？不 —— 展示真实情况更有诊断价值）。 */
export function mapMounts(inspect: ContainerInspectInfo): ContainerMountView[] {
  return (inspect.Mounts ?? []).map((mount) => ({
    type: mount.Type ?? 'unknown',
    source: mount.Source ?? '',
    destination: mount.Destination ?? '',
    readOnly: mount.RW === false,
  }));
}

/**
 * 映射端口并判定可达性。
 *
 * Docker 数据模型：`NetworkSettings.Ports["80/tcp"]` 给出**实际生效**的宿主绑定列表
 * （未发布则为 null），`HostConfig.PortBindings` 给出**声明**的绑定（可能被运行时覆盖）。
 * 以 `NetworkSettings.Ports` 为准，缺失时回退到 `PortBindings`。
 */
export function mapPorts(
  inspect: ContainerInspectInfo,
  hostContext: PortalHostContext,
  tailscaleIps: readonly string[],
  containerName: string,
): ContainerPortView[] {
  const effective = inspect.NetworkSettings?.Ports ?? {};
  const declared = (inspect.HostConfig?.PortBindings ?? {}) as Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  const out: ContainerPortView[] = [];

  const keys = new Set<string>([...Object.keys(effective), ...Object.keys(declared)]);

  for (const key of keys) {
    const parsed = parsePortKey(key);
    if (!parsed) continue;
    const bindings = effective[key] ?? declared[key] ?? null;

    if (!bindings || bindings.length === 0) {
      out.push({
        containerPort: parsed.port,
        protocol: parsed.protocol,
        hostIp: '',
        hostPort: null,
        reachability: 'none',
        url: null,
        note: UNPUBLISHED_NOTE,
      });
      continue;
    }

    for (const binding of bindings) {
      const hostIp = binding.HostIp ?? '';
      const hostPort = binding.HostPort ? Number(binding.HostPort) : null;
      const reachability = classifyBind(hostIp, tailscaleIps);
      if (hostPort === null || !Number.isInteger(hostPort)) {
        out.push({
          containerPort: parsed.port,
          protocol: parsed.protocol,
          hostIp,
          hostPort: null,
          reachability: 'none',
          url: null,
          note: '宿主端口未分配',
        });
        continue;
      }

      const url = urlForBinding(parsed.protocol, hostIp, hostPort, hostContext, reachability);
      out.push({
        containerPort: parsed.port,
        protocol: parsed.protocol,
        hostIp,
        hostPort,
        reachability,
        url,
        note: reachability === 'localhost-only' ? LOCALHOST_NOTE : null,
      });
    }
  }

  void containerName;

  // 排序：可达性优先，其次宿主端口升序
  out.sort((a, b) => {
    const byReach = REACHABILITY_RANK[a.reachability] - REACHABILITY_RANK[b.reachability];
    if (byReach !== 0) return byReach;
    return (a.hostPort ?? 0) - (b.hostPort ?? 0);
  });
  return out;
}

/** 为单个端口绑定生成 URL。仅 http 协议有可直接点击的 URL。 */
function urlForBinding(
  protocol: string,
  hostIp: string,
  hostPort: number,
  hostContext: PortalHostContext,
  reachability: Reachability,
): string | null {
  if (reachability === 'none' || reachability === 'localhost-only') return null;
  if (protocol !== 'tcp') return null; // udp 无 HTTP 入口
  const host = isTailscaleIp(hostIp) ? hostIp : hostContext.primaryHost;
  const scheme = isTailscaleIp(hostIp) && hostContext.primaryScheme === 'https' ? 'https' : 'http';
  return buildUrl({ scheme, host, port: hostPort, path: '/' });
}

/** 从缓存的端口条目重建 URL（同一份数据服务不同访问者）。 */
function rebuildPortUrls(port: ContainerPortView, hostContext: PortalHostContext, containerName: string): ContainerPortView {
  void containerName;
  if (port.reachability === 'none' || port.reachability === 'localhost-only' || port.hostPort === null) {
    return { ...port, url: null };
  }
  const host = isTailscaleIp(port.hostIp) ? port.hostIp : hostContext.primaryHost;
  const url = buildUrl({ scheme: hostContext.primaryScheme, host, port: port.hostPort, path: '/' });
  return { ...port, url };
}

/** 选择首选入口：可达性最优且有 URL 的端口。 */
export function pickPrimaryUrl(ports: readonly ContainerPortView[]): string | null {
  const reachable = ports
    .filter((p) => p.url !== null)
    .sort((a, b) => REACHABILITY_RANK[a.reachability] - REACHABILITY_RANK[b.reachability]);
  return reachable[0]?.url ?? null;
}

/** 为容器生成全部候选入口（去重）。 */
export function buildCandidates(ports: readonly ContainerPortView[], hostContext: PortalHostContext): UrlCandidate[] {
  const chosen = ports.filter((p) => p.url !== null).sort((a, b) => REACHABILITY_RANK[a.reachability] - REACHABILITY_RANK[b.reachability])[0];
  if (!chosen || chosen.hostPort === null) return [];

  const out: UrlCandidate[] = [];
  const seen = new Set<string>();
  const push = (label: UrlCandidate['label'], host: string, display?: string): void => {
    const url = buildUrl({ scheme: hostContext.primaryScheme, host, port: chosen.hostPort, path: '/' });
    if (!url || seen.has(url)) return;
    seen.add(url);
    out.push({ label, url, ...(display ? { display } : {}) });
  };

  for (const candidate of hostContext.candidates) {
    push(candidate.label, candidate.host, candidate.display);
  }
  return out;
}

/** 判断容器是否像 tailscale sidecar。 */
export function detectTailscaleSidecar(inspect: ContainerInspectInfo): boolean {
  const image = inspect.Config?.Image ?? '';
  if (TAILSCALE_IMAGE_RE.test(image)) return true;
  const env = inspect.Config?.Env ?? [];
  const tailscaleEnvKeys = ['TS_AUTHKEY', 'TS_STATE_DIR', 'TS_HOSTNAME', 'TS_CERT_DOMAIN', 'TS_USERSPACE', 'TS_ROUTES'];
  return env.some((entry) => tailscaleEnvKeys.some((key) => entry.startsWith(`${key}=`)));
}

/** 把 Cmd/Entrypoint 数组拼为字符串。 */
export function joinCommand(parts: string[] | undefined | null): string | null {
  if (!parts || parts.length === 0) return null;
  return parts.join(' ');
}

/**
 * 规范化 Entrypoint：Docker 的 `Config.Entrypoint` 可能是字符串
 * （镜像元数据里写成单个字符串时），统一为数组。
 */
export function normalizeCommandList(value: string | string[] | undefined | null): string[] | null {
  if (value === undefined || value === null) return null;
  return Array.isArray(value) ? value : [value];
}

/** 列表失败时的可展示原因。 */
function describeListError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `读取容器列表失败：${message}`;
}
