/**
 * Sprint 1 服务注册表测试的**共享夹具**（真实拓扑形状的假对象）。
 *
 * 为什么单独一个文件：四个测试文件（发现 / API / 搜索 / 迁移）都需要
 * "容器 + 端口 + serve 路由"的同一种形状，而 `ContainerSummary` 有 24 个字段 ——
 * 复制四遍必然漂移，且改一个字段就要改四处。
 *
 * 这里只有纯数据构造，不 import 任何会碰 Docker / Tailscale / 网络的实现。
 */
import { summarize } from '../../src/modules/docker/mapper.js';
import type {
  ContainerListResult,
  ContainerPortView,
  ContainerSummary,
  ServeRouteView,
} from '../../src/modules/docker/types.js';
import type { PortalHostContext } from '../../src/modules/docker/hostContext.js';
import type { TailnetDevice } from '../../src/modules/tailscale/types.js';
import type { ToolView } from '../../src/modules/tools/types.js';

/** 测试用的 MagicDNS 名（与 README 里的实测值一致，便于对照人工核对）。 */
export const TS_HOST = 'family-nas.tail585599.ts.net';

/** 门户自身的宿主端口。 */
export const PORTAL_HOST_PORT = 8899;

/** 主机上下文夹具：首选主机为 MagicDNS 名，`::` / `0.0.0.0` 会被归一到它。 */
export function makeHostContext(primaryHost: string = TS_HOST): PortalHostContext {
  return {
    scheme: 'https',
    host: primaryHost,
    port: null,
    candidates: [{ label: 'magicdns', host: primaryHost }],
    primaryHost,
    primaryScheme: 'https',
  };
}

export function makePort(partial: Partial<ContainerPortView> & { hostPort: number }): ContainerPortView {
  return {
    containerPort: partial.containerPort ?? partial.hostPort,
    protocol: 'tcp',
    hostIp: '0.0.0.0',
    reachability: 'tailnet',
    url: `http://${TS_HOST}:${partial.hostPort}/`,
    note: null,
    ...partial,
  };
}

export function makeContainer(partial: Partial<ContainerSummary> & { id: string; name: string }): ContainerSummary {
  return {
    shortId: partial.id.slice(0, 12),
    image: `${partial.name}:latest`,
    imageId: null,
    state: 'running',
    status: 'Up 3 hours',
    health: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    startedAt: '2026-10-15T00:00:01.000Z',
    finishedAt: null,
    composeProject: null,
    composeService: null,
    composeWorkingDir: null,
    labels: {},
    networks: [],
    mounts: [],
    reachability: 'tailnet',
    primaryUrl: null,
    ports: [],
    urlCandidates: [],
    tailscaleSidecar: false,
    servePaths: [],
    servedUrl: null,
    stats: null,
    ...partial,
  };
}

export function makeServeRoute(partial: Partial<ServeRouteView> & { path: string; targetPort: number }): ServeRouteView {
  const port = partial.port ?? 8443;
  const host = partial.host ?? TS_HOST;
  const path = partial.path;
  const authority = port === 443 ? host : `${host}:${port}`;
  return {
    host,
    port,
    scheme: 'https',
    // 与 "modules/tailscale/serveProvider.ts 的 url" 保持一致：路径原样保留（含尾斜杠）
    url: `https://${authority}${path.startsWith('/') ? path : `/${path}`}`,
    proxy: `http://127.0.0.1:${partial.targetPort}${path}`,
    targetHost: '127.0.0.1',
    containerName: null,
    containerId: null,
    coveredByContainerPort: false,
    ...partial,
  };
}

/** 组一个 `ContainerListResult`（`containers.list` 的返回值形状）。 */
export function makeContainerList(
  items: ContainerSummary[],
  options: { routes?: ServeRouteView[]; dockerAvailable?: boolean; serveAvailable?: boolean; serveDetail?: string | null } = {},
): ContainerListResult {
  return {
    items,
    total: items.length,
    summary: summarize(items),
    source: { available: options.dockerAvailable ?? true, mode: 'fake', detail: null },
    serve: {
      available: options.serveAvailable ?? true,
      mode: 'cli',
      detail: options.serveDetail ?? null,
      routes: options.routes ?? [],
    },
  };
}

export function makeDevice(partial: Partial<TailnetDevice> & { id: string; hostname: string }): TailnetDevice {
  return {
    dnsName: `${partial.hostname}.tail585599.ts.net`,
    os: 'linux',
    ipv4: '100.64.0.10',
    ipv6: null,
    online: true,
    lastSeen: '2026-10-16T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    exitNode: false,
    exitNodeOption: false,
    tags: [],
    relay: null,
    isSelf: false,
    rxBytes: null,
    txBytes: null,
    connection: 'direct',
    ...partial,
  };
}

export function makeTool(partial: Partial<ToolView> & { id: string; name: string }): ToolView {
  return {
    category: 'tools',
    icon: 'tools',
    description: '',
    url: `http://${TS_HOST}:9999/`,
    urlCandidates: [],
    exposed: true,
    hostPort: 9999,
    deepLink: null,
    status: { state: 'unknown', latencyMs: null, httpStatus: null, checkedAt: null, detail: null, stale: false, target: null },
    hint: null,
    featured: false,
    order: 100,
    ...partial,
  };
}

export interface Topology {
  containers: ContainerSummary[];
  serveRoutes: ServeRouteView[];
}

/**
 * 真实验收拓扑（对应 spec §7 的三条验收用例）：
 *
 * - `homeport-portal`（Compose 项目/服务名 `homeport/homeport`）只绑 127.0.0.1:8899，
 *   经 serve `443 /` 暴露 → 首选 `https://<host>/`；
 * - `sisi-calendar` 只绑 127.0.0.1:36065，经 serve `8443 /calendar` 暴露
 *   → 首选 serve 而不是 `:36065`；
 * - `gitea` 发布 0.0.0.0:3000（tailnet 可达），经 serve `8443 /git/` 暴露
 *   → 首选 `https://<host>:8443/git/`。
 *
 * @param options.containerIdSuffix 容器 ID 后缀（模拟"容器被重建"：ID 变、Compose 名不变）
 */
export function realTopology(options: { containerIdSuffix?: string } = {}): Topology {
  const suffix = options.containerIdSuffix ?? 'a1';
  const portal = makeContainer({
    id: `c-portal-${suffix}`,
    name: 'homeport-portal',
    image: 'ghcr.io/xs-www/homeport:latest',
    composeProject: 'homeport',
    composeService: 'homeport',
    reachability: 'localhost-only',
    primaryUrl: null,
    ports: [
      makePort({
        containerPort: PORTAL_HOST_PORT,
        hostPort: PORTAL_HOST_PORT,
        hostIp: '127.0.0.1',
        reachability: 'localhost-only',
        url: null,
        note: '仅绑定回环',
      }),
    ],
  });
  const calendar = makeContainer({
    id: `c-calendar-${suffix}`,
    name: 'sisi-calendar',
    image: 'sisi-calendar:latest',
    reachability: 'localhost-only',
    primaryUrl: null,
    ports: [
      makePort({
        containerPort: 36065,
        hostPort: 36065,
        hostIp: '127.0.0.1',
        reachability: 'localhost-only',
        url: null,
        note: '仅绑定回环',
      }),
    ],
  });
  const gitea = makeContainer({
    id: `c-gitea-${suffix}`,
    name: 'gitea',
    image: 'gitea/gitea:latest',
    reachability: 'tailnet',
    primaryUrl: `http://${TS_HOST}:3000/`,
    ports: [makePort({ containerPort: 3000, hostPort: 3000, hostIp: '0.0.0.0' })],
  });

  const serveRoutes = [
    makeServeRoute({
      path: '/',
      port: 443,
      targetPort: PORTAL_HOST_PORT,
      proxy: `http://127.0.0.1:${PORTAL_HOST_PORT}`,
      containerName: 'homeport-portal',
      containerId: portal.id,
    }),
    makeServeRoute({
      path: '/calendar',
      targetPort: 36065,
      containerName: 'sisi-calendar',
      containerId: calendar.id,
    }),
    makeServeRoute({
      path: '/git/',
      targetPort: 3000,
      proxy: 'http://127.0.0.1:3000/git/',
      containerName: 'gitea',
      containerId: gitea.id,
    }),
  ];

  return { containers: [portal, calendar, gitea], serveRoutes };
}