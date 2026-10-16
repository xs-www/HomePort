/**
 * 服务注册表的**纯逻辑**：把「容器 + 端口 + serve 路由」这层基础设施事实，
 * 归纳成用户看到的「服务」，并算出入口优先级与状态语义。
 *
 * 为什么单独一个纯函数文件：
 * - 这里是 Sprint 1 最容易被写错的地方（身份稳定性、入口优先级、可达性诚实），
 *   纯函数意味着可以用真实拓扑做夹具逐条断言，不必起 Docker、不必起 HTTP；
 * - 仓储只管存取，路由只管鉴权与校验，业务判断全在这里。
 *
 * 三条不可动摇的规则：
 * 1. **身份稳定**：服务身份来自 `sourceType + sourceRef`，`sourceRef` 里**没有容器 ID**
 *    （用 Compose 项目/服务名或规范化容器名）。容器重建 → 同一服务 → 用户配置不丢。
 * 2. **入口优先级**：用户指定并验证的 HTTPS > 已识别的 Serve HTTPS > Tailnet > LAN > 仅本机；
 *    首选入口只能从**可达**的候选里选，绝不把"仅本机"说成可达。
 * 3. **状态分离**：容器运行 / 入口可达 / 健康检查是三个独立维度，永远不合并成一句"挂了"。
 */
import { isLoopbackHost } from '../../util/net.js';
import type { PortalHostContext } from '../docker/hostContext.js';
import type { ContainerSummary, ServeRouteView } from '../docker/types.js';

/* ------------------------------------------------------------------ *
 * 入口类型与优先级
 * ------------------------------------------------------------------ */

export type EntryKind = 'user' | 'serve' | 'tailnet' | 'lan' | 'localhost';

/**
 * 入口优先级（数字越小越优先）。计划 §S1-02 的原文顺序：
 * 「用户指定并验证的 HTTPS 入口 > 已识别的 Tailscale Serve HTTPS > 可信 Tailnet TCP/HTTP >
 *   LAN 地址 > localhost」。
 */
export const ENTRY_RANK: Record<EntryKind, number> = {
  user: 0,
  serve: 1,
  tailnet: 2,
  lan: 3,
  localhost: 4,
};

export const ENTRY_LABEL: Record<EntryKind, string> = {
  user: '用户指定',
  serve: 'Serve HTTPS',
  tailnet: 'Tailnet',
  lan: '局域网',
  localhost: '仅本机',
};

export interface ServiceEntry {
  kind: EntryKind;
  label: string;
  url: string;
  rank: number;
  /** 是否可从当前访问者之外到达；`localhost` 恒为 false */
  accessible: boolean;
  /** 面向人的补充说明（serve 的代理目标、端口绑定情况等） */
  detail: string | null;
}

/* ------------------------------------------------------------------ *
 * 内置图标白名单（前端 `ServiceIcon` 必须与这里保持一致）
 * ------------------------------------------------------------------ */

export const BUILTIN_ICONS = [
  'homeport',
  'calendar',
  'git',
  'code',
  'container',
  'server',
  'disk',
  'network',
  'media',
  'music',
  'photo',
  'game',
  'book',
  'note',
  'dashboard',
  'monitoring',
  'backup',
  'mail',
  'chat',
  'cloud',
  'database',
  'shield',
  'tools',
  'link',
  'globe',
  'box',
] as const;

export type BuiltinIcon = (typeof BUILTIN_ICONS)[number];

const ICON_SET: ReadonlySet<string> = new Set<string>(BUILTIN_ICONS);

export function isBuiltinIcon(value: string): value is BuiltinIcon {
  return ICON_SET.has(value);
}

/** 图标兜底值：未知键一律当作容器图标，避免前端出现空白方块。 */
export const FALLBACK_ICON: BuiltinIcon = 'container';

/* ------------------------------------------------------------------ *
 * 稳定标识（S1-01 核心）
 * ------------------------------------------------------------------ */

/** 去掉副本后缀：`sisi-calendar-1` → `sisi-calendar`。 */
export function normalizeContainerName(name: string): string {
  return name.trim().toLowerCase().replace(/([-_]\d+)+$/, '');
}

/**
 * 容器的稳定服务标识。
 *
 * 有 Compose 标签时用 `项目/服务`（最稳，与容器 ID、副本序号都无关）；
 * 否则退化为规范化容器名。**任何情况下都不包含容器 ID。**
 */
export function containerServiceRef(input: {
  name: string;
  composeProject?: string | null;
  composeService?: string | null;
}): string {
  const project = (input.composeProject ?? '').trim();
  const service = (input.composeService ?? '').trim();
  if (service !== '') {
    return project !== '' ? `docker:${project}/${service}` : `docker:${service}`;
  }
  return `docker:${normalizeContainerName(input.name)}`;
}

/** serve 路由的稳定标识：`serve:<host>:<port><path>`（host 小写、去尾点）。 */
export function serveServiceRef(input: { host: string; port: number; path: string }): string {
  const host = input.host.trim().toLowerCase().replace(/\.$/, '');
  return `serve:${host}:${input.port}${normalizePath(input.path)}`;
}

/** 路径规范化：空 → `/`；确保以 `/` 开头；去尾斜杠（根路径除外）。 */
export function normalizePath(path: string): string {
  const trimmed = (path ?? '').trim();
  if (trimmed === '') return '/';
  const withSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (withSlash === '/') return '/';
  return withSlash.replace(/\/+$/, '');
}

/* ------------------------------------------------------------------ *
 * 自动展示属性（仅作初值，用户改过就不再覆盖）
 * ------------------------------------------------------------------ */

export interface Presentation {
  displayName: string;
  icon: BuiltinIcon;
  category: string;
  description: string | null;
}

interface PresentationRule {
  test: RegExp;
  displayName: string;
  icon: BuiltinIcon;
  category: string;
}

/**
 * 名称/镜像 → 默认展示属性。**顺序即优先级，命中即停。**
 *
 * 这张表存在的意义：新部署、新容器被自动发现时，首页立刻是一堵可读的墙，
 * 而不是一串 `cs22-backend` 之类的主机名。用户随时可以改，改过之后本表不再生效。
 */
const PRESENTATION_RULES: readonly PresentationRule[] = [
  { test: /calendar/, displayName: '家庭日历', icon: 'calendar', category: '家庭' },
  { test: /gitea|(^|[^a-z])git([^a-z]|$)/, displayName: 'Gitea', icon: 'git', category: '开发' },
  { test: /worldforge/, displayName: 'WorldForge', icon: 'game', category: '开发' },
  { test: /homeport|(^|[^a-z])portal([^a-z]|$)/, displayName: 'HomePort', icon: 'homeport', category: '基础设施' },
  { test: /jellyfin|plex|emby/, displayName: '影音库', icon: 'media', category: '媒体' },
  { test: /navidrome|music|airsonic/, displayName: '音乐', icon: 'music', category: '媒体' },
  { test: /immich|photo|gallery/, displayName: '相册', icon: 'photo', category: '媒体' },
  { test: /pihole|adguard|(^|[^a-z])dns([^a-z]|$)/, displayName: 'DNS 过滤', icon: 'network', category: '网络' },
  { test: /portainer|docker/, displayName: 'Docker', icon: 'container', category: '基础设施' },
  { test: /code-server|(^|[^a-z])dsh([^a-z]|$)|vscode/, displayName: '代码服务', icon: 'code', category: '开发' },
  { test: /postgres|mysql|mariadb|mongo|redis|sqlite|(^|[^a-z])db([^a-z]|$)/, displayName: '数据库', icon: 'database', category: '基础设施' },
  { test: /uptime|grafana|prometheus|monitor/, displayName: '监控', icon: 'monitoring', category: '基础设施' },
  { test: /duplicati|restic|backup|syncthing/, displayName: '备份同步', icon: 'backup', category: '基础设施' },
  { test: /cs22/, displayName: 'CS22', icon: 'box', category: '项目' },
];

export const DEFAULT_CATEGORY = '未分类';

/**
 * 派生默认展示属性。
 *
 * @param input.name 容器名或 serve 路径片段
 * @param input.image 容器镜像（可空）
 */
export function defaultPresentation(input: { name: string; image?: string | null }): Presentation {
  const haystack = `${input.name} ${input.image ?? ''}`.toLowerCase();
  for (const rule of PRESENTATION_RULES) {
    if (rule.test.test(haystack)) {
      return { displayName: rule.displayName, icon: rule.icon, category: rule.category, description: null };
    }
  }
  return {
    displayName: humanizeName(input.name),
    icon: FALLBACK_ICON,
    category: DEFAULT_CATEGORY,
    description: null,
  };
}

/** 把 `sisi-calendar-1` 这类标识变成可读的标题（保留原词，只做分隔与首字母大写）。 */
export function humanizeName(name: string): string {
  const cleaned = name.trim().replace(/([-_]\d+)+$/, '').replace(/[-_]+/g, ' ').trim();
  if (cleaned === '') return name.trim();
  return cleaned
    .split(/\s+/)
    .map((word) => (word.length <= 3 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

/* ------------------------------------------------------------------ *
 * 发现（容器 + serve → 服务）
 * ------------------------------------------------------------------ */

export interface DiscoveredBinding {
  kind: 'container' | 'serve';
  ref: string;
  containerId: string | null;
  containerName: string | null;
  composeProject: string | null;
  composeService: string | null;
  scheme: string | null;
  host: string | null;
  port: number | null;
  path: string | null;
  url: string | null;
  reachability: string | null;
  accessible: boolean;
  rank: number;
}

export interface DiscoveredService {
  sourceType: 'docker' | 'serve';
  sourceRef: string;
  /** slug 基名（实际落库时由仓储保证唯一） */
  slugBase: string;
  displayName: string;
  description: string | null;
  icon: string;
  category: string;
  bindingRefs: string[];
  bindings: DiscoveredBinding[];
}

export interface DiscoveryInput {
  containers: readonly ContainerSummary[];
  serveRoutes: readonly ServeRouteView[];
  dockerAvailable: boolean;
  serveAvailable: boolean;
  serveDetail: string | null;
}

export interface DiscoveryPlan {
  services: DiscoveredService[];
  /** 面向人的发现说明（UI 降级提示 / 状态 reasons 用） */
  notes: string[];
  dockerAvailable: boolean;
  serveAvailable: boolean;
  serveDetail: string | null;
}

/**
 * 规划一次发现：返回"服务应该长什么样"的纯数据，落库与否由调用方决定。
 *
 * serve 路由的容器归属**复用 `mapServeRoutes` 已算好的 `containerName/containerId`**
 * （它按 `targetPort` 匹配容器端口），因此这里不再重复实现匹配逻辑。
 */
export function planDiscovery(input: DiscoveryInput): DiscoveryPlan {
  const services = new Map<string, DiscoveredService>();
  const notes: string[] = [];
  /** 已解释过的独立 serve 路由（同一条 serve 只解释一次，避免 notes 里重复）。 */
  const explainedServeRefs = new Set<string>();

  const containerRefByName = new Map<string, string>();
  for (const container of input.containers) {
    containerRefByName.set(container.name, containerServiceRef(container));
    if (container.id) containerRefByName.set(container.id, containerServiceRef(container));
  }

  /**
   * 有多少个容器"声称"占用了某个宿主端口。
   *
   * 为什么要自己数一遍：`mapServeRoutes` 是按 `port.hostPort === route.targetPort` 用
   * `containers.find(...)` 归属的，**冲突时取第一个匹配**（既有行为，本函数不改它）。
   * 而"两个容器都报告同一宿主端口"在真实数据里会出现 —— 典型是**已停止的容器仍报告
   * 自己配置过的端口绑定**，而门户默认连停止的容器一起列（`all: true`）。
   * 这种情况下 mapper 给的 owner 就是猜的，而计划 §4 明确要求"多容器端口冲突不猜"，
   * 所以这里用实时容器列表自己判一次唯一性，宁可作为独立 serve 服务列出 + 说明原因，
   * 也不把入口挂到错的容器卡片上（挂错比不挂更难排查）。
   */
  const countHostPortClaimants = (targetPort: number | null): number => {
    if (targetPort === null) return 0;
    let claimants = 0;
    for (const container of input.containers) {
      if (container.ports.some((port) => port.hostPort === targetPort)) claimants += 1;
    }
    return claimants;
  };

  for (const container of input.containers) {
    const sourceRef = containerServiceRef(container);
    const presentation = defaultPresentation({ name: container.name, image: container.image });
    const existing = services.get(sourceRef);
    const binding: DiscoveredBinding = {
      kind: 'container',
      ref: sourceRef,
      containerId: container.id,
      containerName: container.name,
      composeProject: container.composeProject,
      composeService: container.composeService,
      scheme: null,
      host: null,
      port: null,
      path: null,
      url: container.primaryUrl,
      reachability: container.reachability,
      accessible: container.reachability === 'tailnet' || container.reachability === 'lan',
      rank:
        container.reachability === 'tailnet'
          ? ENTRY_RANK.tailnet
          : container.reachability === 'lan'
            ? ENTRY_RANK.lan
            : ENTRY_RANK.localhost,
    };

    if (existing) {
      // 同 sourceRef 的副本容器：合并到同一个服务（只保留一份绑定记录，避免重复卡片）
      if (!existing.bindings.some((item) => item.ref === binding.ref && item.containerId === binding.containerId)) {
        existing.bindings.push(binding);
      }
      continue;
    }

    services.set(sourceRef, {
      sourceType: 'docker',
      sourceRef,
      slugBase: container.composeService ?? container.name,
      displayName: presentation.displayName,
      description: presentation.description,
      icon: presentation.icon,
      category: presentation.category,
      bindingRefs: [sourceRef],
      bindings: [binding],
    });
  }

  for (const route of input.serveRoutes) {
    const serveRef = serveServiceRef(route);
    /** 端口被多个容器占用 → mapper 的 owner 是"第一个匹配"，不可信（见上）。 */
    const claimants = countHostPortClaimants(route.targetPort);
    const ambiguous = claimants > 1;

    const ownerRef = ambiguous
      ? undefined
      : route.containerName
        ? containerRefByName.get(route.containerName) ?? containerRefByName.get(route.containerId ?? '')
        : route.containerId
          ? containerRefByName.get(route.containerId)
          : undefined;

    const owner = ownerRef ? services.get(ownerRef) : undefined;
    const binding: DiscoveredBinding = {
      kind: 'serve',
      ref: serveRef,
      // 归属不可信时快照里也不记 owner：快照是用来"下次找回关联"的，记错了会一路错下去
      containerId: ambiguous ? null : route.containerId ?? null,
      containerName: ambiguous ? null : route.containerName ?? null,
      composeProject: null,
      composeService: null,
      scheme: route.scheme,
      host: route.host,
      port: route.port,
      path: normalizePath(route.path),
      url: route.url,
      reachability: 'tailnet',
      // Serve 入口是 tailnet 内可达的 HTTPS 入口 —— 这正是它优先级高于 LAN 的原因
      accessible: true,
      rank: ENTRY_RANK.serve,
    };

    if (owner) {
      if (!owner.bindingRefs.includes(serveRef)) owner.bindingRefs.push(serveRef);
      owner.bindings.push(binding);
      continue;
    }

    // 归属不到唯一容器：作为独立服务列出，并**如实说明原因**（spec §2.2 第 2 步）。
    // 两种情形：端口被多个容器占用（明确不猜），或该目标根本不是容器。
    if (!explainedServeRefs.has(serveRef)) {
      explainedServeRefs.add(serveRef);
      notes.push(
        ambiguous
          ? `Serve 路由 ${normalizePath(route.path)} 的目标端口 ${route.targetPort} 有 ${claimants} 个容器同时报告占用，无法确定归属，作为独立服务列出（不做猜测）。`
          : `Serve 路由 ${normalizePath(route.path)} 未归属到唯一容器，作为独立服务列出（可能是多容器端口冲突，或该目标不是容器）。`,
      );
    }

    const existing = services.get(serveRef);
    if (existing) {
      existing.bindings.push(binding);
      continue;
    }

    const pathSegment = normalizePath(route.path).split('/').filter(Boolean).pop() ?? 'root';
    const name = pathSegment === 'root' ? route.host.split('.')[0] ?? route.host : pathSegment;
    const presentation = defaultPresentation({ name: `${name} serve`, image: null });
    services.set(serveRef, {
      sourceType: 'serve',
      sourceRef: serveRef,
      slugBase: `${route.host.split('.')[0] ?? route.host}-${route.port}${normalizePath(route.path)}`,
      displayName: normalizePath(route.path) === '/' ? humanizeName(route.host.split('.')[0] ?? route.host) : humanizeName(pathSegment),
      description: presentation.description,
      icon: presentation.icon,
      category: presentation.category,
      bindingRefs: [serveRef],
      bindings: [binding],
    });
  }

  if (!input.dockerAvailable) {
    notes.push('Docker 不可达：容器状态与端口入口暂时无法判定。');
  }
  if (!input.serveAvailable) {
    notes.push(
      input.serveDetail
        ? `未读到 Tailscale Serve 配置：${input.serveDetail}（Serve 入口可能缺失，CLI 模式才可读取。）`
        : '未读到 Tailscale Serve 配置（Serve 入口可能缺失，CLI 模式才可读取）。',
    );
  }
  for (const service of services.values()) {
    const kinds = new Set(service.bindings.map((binding) => binding.kind));
    if (kinds.size === 0) notes.push(`服务 ${service.sourceRef} 没有任何绑定。`);
  }

  return {
    services: [...services.values()],
    notes,
    dockerAvailable: input.dockerAvailable,
    serveAvailable: input.serveAvailable,
    serveDetail: input.serveDetail,
  };
}

/* ------------------------------------------------------------------ *
 * 入口计算（S1-02）
 * ------------------------------------------------------------------ */

/**
 * URL 规范化（**只用于去重与比较**，不用于展示）：
 * - host 小写、去尾点、去方括号；
 * - `0.0.0.0` / `::` / 空主机 → 替换为 host 上下文的主机名
 *   （这条对应"同一容器的 `::` 与 `0.0.0.0` 映射不得重复出现"）；
 * - 去默认端口（https:443 / http:80）；
 * - 路径去尾斜杠（根路径保留），丢弃 query/hash。
 *
 * 解析失败时返回 trim 后的小写原值（保证"同一个坏 URL"仍能相互去重）。
 */
export function normalizeUrl(raw: string, hostContext?: PortalHostContext | null): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return '';
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return trimmed.toLowerCase();
  }
  const protocol = parsed.protocol.toLowerCase();
  const host = normalizeHost(parsed.hostname, hostContext);
  const port = parsed.port;
  const dropPort = (protocol === 'https:' && port === '443') || (protocol === 'http:' && port === '80');
  const path = normalizePath(parsed.pathname);
  return `${protocol}//${host}${dropPort || port === '' ? '' : `:${port}`}${path}`;
}

/** 主机规范化：`0.0.0.0` / `::` / `[::]` 这类"监听全部"的写法统一成主访问主机。 */
export function normalizeHost(host: string, hostContext?: PortalHostContext | null): string {
  const bare = host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase().replace(/\.$/, '');
  if (bare === '' || bare === '0.0.0.0' || bare === '::' || bare === '*') {
    const primary = hostContext?.primaryHost?.trim().toLowerCase().replace(/\.$/, '') ?? '';
    return primary !== '' ? primary : 'localhost';
  }
  return bare;
}

function isWildcardHost(host: string): boolean {
  const bare = host.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  return bare === '0.0.0.0' || bare === '::' || bare === '*' || bare === '';
}

/** `host` 是否"仅本机"（127.0.0.1 / localhost / ::1）。 */
export function isLocalhostUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

export interface BuildEntriesInput {
  preferredUrl: string | null;
  container: ContainerSummary | null;
  /** 该服务绑定的 serve 路由（已按服务过滤） */
  serveRoutes: readonly ServeRouteView[];
  hostContext?: PortalHostContext | null;
}

/**
 * 计算一个服务的全部候选入口（含不可达的，供"查看所有候选入口"）。
 *
 * 返回已排序：rank 升序 → 路径浅者优先 → 端口升序 → URL 字典序（稳定、可断言）。
 */
export function buildServiceEntries(input: BuildEntriesInput): ServiceEntry[] {
  const raw: ServiceEntry[] = [];

  const preferred = (input.preferredUrl ?? '').trim();
  if (preferred !== '') {
    raw.push({
      kind: 'user',
      label: ENTRY_LABEL.user,
      url: preferred,
      rank: ENTRY_RANK.user,
      // 管理员显式保存并验证过的入口，按定义视为可达；健康检查负责证伪。
      accessible: true,
      detail: '管理员指定并保存的入口',
    });
  }

  for (const route of input.serveRoutes) {
    raw.push({
      kind: 'serve',
      label: ENTRY_LABEL.serve,
      url: route.url,
      rank: ENTRY_RANK.serve,
      accessible: true,
      detail: route.proxy ? `serve → ${route.proxy}` : null,
    });
  }

  for (const port of input.container?.ports ?? []) {
    if (port.hostPort === null) continue;
    const reachable = port.reachability === 'tailnet' || port.reachability === 'lan';
    const kind: EntryKind =
      port.reachability === 'tailnet' ? 'tailnet' : port.reachability === 'lan' ? 'lan' : 'localhost';
    // mapper 对 localhost-only 端口刻意不给 url（不给可点击链接）；
    // 但服务层需要把它们列出来做诊断与"仅本机"提示，所以这里补一个 localhost 地址。
    const url = port.url ?? `http://localhost:${port.hostPort}/`;
    if (!reachable && port.reachability !== 'localhost-only') continue;
    raw.push({
      kind,
      label: ENTRY_LABEL[kind],
      url,
      rank: ENTRY_RANK[kind],
      accessible: reachable,
      detail: `容器端口 ${port.containerPort}/${port.protocol} → 宿主 ${port.hostIp}:${port.hostPort}`,
    });
  }

  return dedupeEntries(raw, input.hostContext);
}

/**
 * 去重 + 排序。
 *
 * 去重键是规范化 URL；同一个 URL 只保留**优先度最高**的那条（例如同一入口既是 LAN
 * 又被 serve 覆盖时保留 serve）。`127.0.0.1` 与 `localhost` 由 `normalizeHost` 之外的
 * 循环等价处理（见下）。
 */
export function dedupeEntries(entries: readonly ServiceEntry[], hostContext?: PortalHostContext | null): ServiceEntry[] {
  const byUrl = new Map<string, ServiceEntry>();
  const loopbackKey = (url: string): boolean => isLocalhostUrl(url);

  for (const entry of entries) {
    const key = normalizeUrl(entry.url, hostContext);
    if (key === '') continue;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, entry);
      continue;
    }
    // 同 URL 取优先度更高者；同 rank 时"可达"优先
    if (entry.rank < existing.rank || (entry.rank === existing.rank && entry.accessible && !existing.accessible)) {
      byUrl.set(key, entry);
    }
  }

  // `127.0.0.1:8080` 与 `localhost:8080` 视为同一主机：保留先出现（rank 更优）的那条
  const byHostPort = new Map<string, ServiceEntry>();
  for (const entry of byUrl.values()) {
    let key = normalizeUrl(entry.url, hostContext);
    if (loopbackKey(entry.url)) {
      try {
        const parsed = new URL(entry.url);
        key = `loopback:${parsed.port}${normalizePath(parsed.pathname)}`;
      } catch {
        /* 保底：用原 key */
      }
    }
    const existing = byHostPort.get(key);
    if (!existing || entry.rank < existing.rank) byHostPort.set(key, entry);
  }

  return [...byHostPort.values()].sort(compareEntries(hostContext));
}

/** 排序：rank → 路径深度 → 端口 → URL。 */
export function compareEntries(
  hostContext?: PortalHostContext | null,
): (a: ServiceEntry, b: ServiceEntry) => number {
  void hostContext;
  return (a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const depthA = pathDepth(a.url);
    const depthB = pathDepth(b.url);
    if (depthA !== depthB) return depthA - depthB;
    const portA = urlPort(a.url);
    const portB = urlPort(b.url);
    if (portA !== portB) return portA - portB;
    return a.url.localeCompare(b.url);
  };
}

function pathDepth(url: string): number {
  try {
    return normalizePath(new URL(url).pathname).split('/').filter(Boolean).length;
  } catch {
    return 99;
  }
}

function urlPort(url: string): number {
  try {
    const parsed = new URL(url);
    if (parsed.port !== '') return Number(parsed.port);
    return parsed.protocol === 'https:' ? 443 : 80;
  } catch {
    return 9999;
  }
}

/** 首选入口：第一个**可达**的候选；一个都没有则 null（UI 显示"无可达入口"）。 */
export function pickEntry(entries: readonly ServiceEntry[]): ServiceEntry | null {
  return entries.find((entry) => entry.accessible) ?? null;
}

/* ------------------------------------------------------------------ *
 * 状态语义（S1-05）
 * ------------------------------------------------------------------ */

export type ContainerState = 'running' | 'stopped' | 'absent';
export type ServiceHealth = 'ok' | 'fail' | 'unknown' | 'skipped';

export interface ServiceStatus {
  container: ContainerState | null;
  reachable: boolean | null;
  health: ServiceHealth;
  reasons: string[];
}

export interface ResolveStatusInput {
  sourceType: 'docker' | 'serve' | 'manual';
  container: ContainerSummary | null;
  entries: readonly ServiceEntry[];
  health: { state: 'ok' | 'fail'; detail: string | null; at: string } | null;
  hasHealthTarget: boolean;
  dockerAvailable: boolean;
  serveAvailable: boolean;
}

/**
 * 三维状态：容器 / 可达 / 健康。
 *
 * 刻意**不做**的一件事：把三者合并成"服务挂了"。用户需要知道的是
 * "容器在跑但入口不通"还是"容器没跑"，这两者的处理方式完全不同。
 */
export function resolveServiceStatus(input: ResolveStatusInput): ServiceStatus {
  const reasons: string[] = [];

  let container: ContainerState | null = null;
  if (input.container) {
    container = input.container.state === 'running' ? 'running' : 'stopped';
    if (container === 'stopped') reasons.push(`容器未运行（${input.container.state}）`);
  } else if (input.sourceType === 'docker') {
    container = 'absent';
    reasons.push('未找到对应容器（可能已删除或尚未启动）');
  }

  const anyAccessible = input.entries.some((entry) => entry.accessible);
  let reachable: boolean | null;
  if (anyAccessible) {
    reachable = true;
  } else if (!input.dockerAvailable && !input.serveAvailable) {
    // 数据源都不可用 → 不确定 ≠ 不可达
    reachable = null;
    reasons.push('数据源不可用，无法判定入口可达性');
  } else {
    reachable = false;
    if (input.entries.length === 0) reasons.push('没有发现任何入口');
    else reasons.push('所有候选入口都只能在宿主机本机访问');
  }

  // S1-05 的典型误报：容器端口只绑 127.0.0.1，但经 Serve 有 tailnet 入口。
  if (input.container && input.container.reachability === 'localhost-only') {
    const serveEntry = input.entries.find((entry) => entry.kind === 'serve');
    if (serveEntry) {
      reasons.push('容器端口仅绑本机，经 Serve 提供 tailnet 入口');
    } else if (container === 'running') {
      reasons.push('容器端口仅绑 127.0.0.1，局域网与 tailnet 都访问不到');
    }
  }

  let health: ServiceHealth;
  if (!input.hasHealthTarget) {
    health = 'skipped';
    reasons.push('未配置健康检查（默认不探测）');
  } else if (!input.health) {
    health = 'unknown';
    reasons.push('尚未执行健康检查');
  } else {
    health = input.health.state;
    if (input.health.state === 'fail') reasons.push(input.health.detail ?? '健康检查未通过');
  }

  if (!input.serveAvailable && input.entries.every((entry) => entry.kind !== 'serve')) {
    reasons.push('Serve 配置读不到，Serve 入口可能缺失');
  }

  return { container, reachable, health, reasons };
}

/* ------------------------------------------------------------------ *
 * 与实时容器对接
 * ------------------------------------------------------------------ */

/**
 * 找出某个服务当前对应的容器。
 *
 * 顺序：绑定里的容器 ID（可能已过期）→ 绑定的容器名 → 由 `sourceRef` 反推的稳定标识。
 * 之所以不能只看 ID：容器重建后 ID 会变，而 `sourceRef` 不变 —— 这正是身份稳定的价值。
 */
export function findContainerForService(input: {
  sourceRef: string;
  containerIds: readonly string[];
  containerNames: readonly string[];
  containers: readonly ContainerSummary[];
}): ContainerSummary | null {
  const byId = new Map(input.containers.map((container) => [container.id, container]));
  for (const id of input.containerIds) {
    const found = byId.get(id);
    if (found) return found;
  }
  const names = new Set(input.containerNames);
  for (const container of input.containers) {
    if (names.has(container.name)) return container;
  }
  for (const container of input.containers) {
    if (containerServiceRef(container) === input.sourceRef) return container;
  }
  return null;
}

/** 过滤出属于某个服务的 serve 路由（按稳定 ref 或容器归属匹配）。 */
export function serveRoutesForService(input: {
  bindingRefs: readonly string[];
  container: ContainerSummary | null;
  serveRoutes: readonly ServeRouteView[];
}): ServeRouteView[] {
  const refs = new Set(input.bindingRefs);
  const out: ServeRouteView[] = [];
  const seen = new Set<string>();
  for (const route of input.serveRoutes) {
    const ref = serveServiceRef(route);
    const ownedByContainer =
      input.container !== null &&
      (route.containerId === input.container.id || route.containerName === input.container.name);
    if (!refs.has(ref) && !ownedByContainer) continue;
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(route);
  }
  return out;
}

/** 生成 slug 基名（中文会被 slugify 剥空，因此用 ref 兜底）。 */
export function slugBaseFor(displayName: string, sourceRef: string): string {
  const fromName = displayName.trim();
  const fromRef = sourceRef.replace(/^(docker|serve|manual):/, '').replace(/[^a-zA-Z0-9]+/g, '-');
  return fromName !== '' ? `${fromName} ${fromRef}` : fromRef || 'service';
}