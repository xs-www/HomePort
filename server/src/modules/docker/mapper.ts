/**
 * F1 容器映射纯函数：把 Docker inspect 数据映射为门户契约
 * （端口可达性判定、入口 URL、多候选入口、serve 路由覆盖判定）。
 *
 * ## 分层铁律（S0-05 拆分自 `service.ts`）
 *
 * 本文件**只做纯计算**，是「外部数据 → 门户契约」的转换层：
 * 1. 不构造、不调用 dockerode（只以 `import type` 引用 inspect 的形状）；
 * 2. 不发任何请求、不读文件、不执行命令；
 * 3. 不读全局配置 —— `PortalConfig` 只由调用方经 `PortalHostContext` 传进来。
 *
 * 这样映射/判定逻辑可用固定输入直接断言，**不需要真实 Docker**。
 * 业务编排（缓存、数据源探活、过滤、stats、日志）留在 `service.ts`。
 *
 * 注意：`service.ts` 仍 re-export 本文件的所有映射函数，旧的
 * `import { mapPorts } from './service.js'` 调用方不受影响。
 */
import type { ContainerInspectInfo } from 'dockerode';
import { parseDockerTime, toIso } from '../../util/format.js';
import {
  REACHABILITY_RANK,
  bestReachability,
  buildUrl,
  classifyBind,
  isTailscaleIp,
  parsePortKey,
  type Reachability,
} from '../../util/net.js';
import type { PortalHostContext } from './hostContext.js';
import {
  TAILSCALE_IMAGE_RE,
  type ContainerListResult,
  type ContainerMountView,
  type ContainerNetworkView,
  type ContainerPortView,
  type ContainerSummary,
  type ServeRouteView,
  type UrlCandidate,
} from './types.js';

const LOCALHOST_NOTE = '该端口仅绑定回环地址（127.0.0.1），tailnet 内其它设备无法直接访问';
const UNPUBLISHED_NOTE = '该端口未发布到宿主，容器网络内可见';

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
 *
 * 去重：同一宿主端口上 Docker 会同时报 `0.0.0.0`（IPv4）与 `::`（IPv6 双栈），
 * 两条除 `hostIp` 外渲染结果完全一致，会让容器卡出现两条一模一样的入口。
 * 去重规则见 `dedupeIdenticalBindings`（刻意收窄，不会合并可达性不同的绑定）。
 */
export function mapPorts(
  inspect: ContainerInspectInfo,
  hostContext: PortalHostContext,
  tailscaleIps: readonly string[],
  containerName: string,
): ContainerPortView[] {
  const effective = inspect.NetworkSettings?.Ports ?? {};
  const declared = (inspect.HostConfig?.PortBindings ?? {}) as Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  const collected: ContainerPortView[] = [];

  const keys = new Set<string>([...Object.keys(effective), ...Object.keys(declared)]);

  for (const key of keys) {
    const parsed = parsePortKey(key);
    if (!parsed) continue;
    const bindings = effective[key] ?? declared[key] ?? null;

    if (!bindings || bindings.length === 0) {
      collected.push({
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
        collected.push({
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
      collected.push({
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

  // 先去重（双栈重复绑定），再排序：可达性优先，其次宿主端口升序
  const out = dedupeIdenticalBindings(collected);
  out.sort((a, b) => {
    const byReach = REACHABILITY_RANK[a.reachability] - REACHABILITY_RANK[b.reachability];
    if (byReach !== 0) return byReach;
    return (a.hostPort ?? 0) - (b.hostPort ?? 0);
  });
  return out;
}

/**
 * 去掉「除 `hostIp` 外渲染结果完全一致」的重复端口绑定。
 *
 * 为什么需要：Docker 在同一宿主端口上会同时报 IPv4 与 IPv6 两条绑定
 * （`0.0.0.0:8080` + `::8080`），本机实测 `docker inspect cs22-web` 就是这种形态：
 *
 * ```json
 * {"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"},{"HostIp":"::","HostPort":"8080"}]}
 * ```
 *
 * 这两条在容器墙上会渲染成**两条一模一样的入口**（可达性、URL、提示都相同），
 * 属于真实的可用性缺陷（与 2.0 计划 S1-02「相同容器的 `::` 与 `0.0.0.0` 映射应去重」一致）。
 *
 * 判定刻意收窄 —— 只有下面这些字段全部相同才视为重复，保留**先出现**的一条：
 * `protocol` + `containerPort` + `hostPort` + `reachability` + `url` + `note`。
 * 因此下列情形**不会**被合并：
 * - `127.0.0.1` 与 `0.0.0.0` 绑同一端口 → 可达性不同（`localhost-only` vs `tailnet`），两条都保留；
 * - 容器端口不同（`80/tcp` 与 `81/tcp`）→ 即便宿主端口相同也各自保留；
 * - UDP 与 TCP、可达与未发布的条目同理，键中已包含协议与可达性。
 *
 * @param entries 端口绑定列表（顺序即优先级，先出现者胜出）
 * @returns 去重后的新数组；不修改入参
 */
export function dedupeIdenticalBindings(entries: readonly ContainerPortView[]): ContainerPortView[] {
  const seen = new Set<string>();
  const out: ContainerPortView[] = [];

  for (const entry of entries) {
    // 渲染等价键：刻意**不含** hostIp —— 它正是双栈重复里唯一不同的字段
    const key = [
      entry.protocol,
      entry.containerPort,
      entry.hostPort ?? 'none',
      entry.reachability,
      entry.url ?? '',
      entry.note ?? '',
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }

  return out;
}

/** 为单个端口绑定生成 URL。仅 http 协议有可直接点击的 URL。 */
export function urlForBinding(
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
export function rebuildPortUrls(port: ContainerPortView, hostContext: PortalHostContext, containerName: string): ContainerPortView {
  void containerName;
  if (port.reachability === 'none' || port.reachability === 'localhost-only' || port.hostPort === null) {
    return { ...port, url: null };
  }
  const host = isTailscaleIp(port.hostIp) ? port.hostIp : hostContext.primaryHost;
  const url = buildUrl({ scheme: hostContext.primaryScheme, host, port: port.hostPort, path: '/' });
  return { ...port, url };
}

/** 把缓存的容器条目与当前请求的 host 上下文结合，重新生成 URL。 */
export function attachHostContext(items: ContainerSummary[], hostContext: PortalHostContext): ContainerSummary[] {
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

/** serve 路由的原始输入（与 `ServeRoutesProvider` 返回的条目结构一致）。 */
export interface ServeRouteInput {
  host: string;
  port: number;
  scheme: 'https';
  path: string;
  url: string;
  proxy: string;
  targetHost: string | null;
  targetPort: number | null;
}

/** 收集「已作为可达端口展示过」的宿主端口（serve 路由去重用）。 */
export function collectReachableHostPorts(containers: readonly ContainerSummary[]): Set<number> {
  const out = new Set<number>();
  for (const container of containers) {
    for (const port of container.ports) {
      if (port.reachability === 'tailnet' || port.reachability === 'lan') {
        if (port.hostPort !== null) out.add(port.hostPort);
      }
    }
  }
  return out;
}

/**
 * 把 serve 路由映射为视图。
 *
 * 1. 把目标端口匹配回容器，便于 UI 显示"这条 serve 指向哪个容器"。
 * 2. 标记 `coveredByContainerPort`：若该目标端口已经作为可达端口展示过
 *    （例如 worldforge 的 4173 已发布到宿主），就不再单独列一条，
 *    改为在容器卡上打 serve 标记，避免同一入口出现两次。
 *
 * 注意：这里**逐字段**构造输出，不展开原始路由 —— 否则 `funnel` /
 * `targetPath` 会混进 HTTP 响应契约。
 */
export function mapServeRoutes(
  routes: readonly ServeRouteInput[],
  containers: readonly ContainerSummary[],
): ServeRouteView[] {
  const reachableHostPorts = collectReachableHostPorts(containers);

  return routes.map((route) => {
    const owner =
      route.targetPort === null
        ? null
        : (containers.find((container) => container.ports.some((port) => port.hostPort === route.targetPort)) ?? null);
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
}

/** 把 serve 路径写到对应容器上（卡片标记用）。 */
export function attachServePaths(
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