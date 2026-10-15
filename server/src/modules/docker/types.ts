/**
 * F1 容器模块的应用层类型。
 *
 * 这些类型同时是 HTTP 响应契约（见 docs/static/04-api-contract.md §3）与前端类型来源，
 * 变更时必须同步前端 `web/src/api/types.ts`。
 */
import type { Reachability } from '../../util/net.js';

export interface SourceStatus {
  available: boolean;
  /** 数据源模式：socket / tcp / none 等 */
  mode: string;
  /** 不可用原因（中文，可直接展示给用户） */
  detail: string | null;
}

export interface UrlCandidate {
  label: 'tailnet' | 'magicdns' | 'localhost' | 'lan' | 'custom';
  url: string;
  display?: string;
}

export interface ContainerPortView {
  containerPort: number;
  protocol: string;
  /** 宿主绑定 IP；空字符串表示未显式指定 */
  hostIp: string;
  hostPort: number | null;
  reachability: Reachability;
  /** 可点击入口；不可达时为 null */
  url: string | null;
  /** 附加提示，如"仅绑定回环，需 SSH 隧道" */
  note: string | null;
}

export interface ContainerNetworkView {
  name: string;
  ipv4: string | null;
  aliases: string[];
}

export interface ContainerMountView {
  type: string;
  source: string;
  destination: string;
  readOnly: boolean;
}

export interface ContainerStatsView {
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  memPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  pids: number | null;
  collectedAt: string;
}

export interface ContainerSummary {
  id: string;
  shortId: string;
  name: string;
  image: string;
  imageId: string | null;
  state: string;
  status: string;
  health: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  composeProject: string | null;
  composeService: string | null;
  composeWorkingDir: string | null;
  labels: Record<string, string>;
  networks: ContainerNetworkView[];
  mounts: ContainerMountView[];
  /** 容器整体可达性（取所有端口中最佳者） */
  reachability: Reachability;
  /** 首选入口；无可达端口时为 null */
  primaryUrl: string | null;
  ports: ContainerPortView[];
  urlCandidates: UrlCandidate[];
  /** 是否像 tailscale sidecar（含 TS_* 环境变量或 tailscale 相关镜像） */
  tailscaleSidecar: boolean;
  /** 该容器被 `tailscale serve` 暴露的路径（如 ['/worldforge']） */
  servePaths: string[];
  /** 经 serve 暴露的入口 URL（取第一个匹配路由） */
  servedUrl: string | null;
  stats: ContainerStatsView | null;
}

export interface ContainerDetail extends ContainerSummary {
  command: string | null;
  entrypoint: string | null;
  env: Record<string, string>;
  restartPolicy: string | null;
  networkMode: string | null;
  privileged: boolean;
  platform: string | null;
  workingDir: string | null;
  user: string | null;
}

export interface ContainerListSummary {
  total: number;
  running: number;
  stopped: number;
  tailnetReachable: number;
  lanReachable: number;
  localhostOnly: number;
  /** 需要关注的容器数（未运行 或 不可达 或 非 healthy） */
  attention: number;
}

export interface ContainerListResult {
  items: ContainerSummary[];
  total: number;
  summary: ContainerListSummary;
  source: SourceStatus;
  /** `tailscale serve` 暴露的路由；CLI 不可用时 available=false 并说明原因 */
  serve: ServeStatusView;
}

/** serve 路由的视图（含与容器的关联）。 */
export interface ServeRouteView {
  host: string;
  port: number;
  scheme: 'https';
  path: string;
  /** 可直接点击的 tailnet 入口 URL */
  url: string;
  /** serve 的代理目标（宿主视角） */
  proxy: string;
  targetHost: string | null;
  targetPort: number | null;
  /** 提供该服务的容器名（能匹配到时） */
  containerName: string | null;
  containerId: string | null;
  /** 是否被某个已展示的可达端口覆盖（这类不再单独列出，改在容器卡上打标记） */
  coveredByContainerPort: boolean;
}

export interface ServeStatusView {
  available: boolean;
  mode: string;
  detail: string | null;
  routes: ServeRouteView[];
}

export interface ContainerListQuery {
  all: boolean;
  stats: boolean;
  reachability?: Reachability;
  q?: string;
}

export interface ContainerLogsResult {
  lines: string[];
  truncated: boolean;
  stream: 'stdout+stderr';
  containerId: string;
  containerName: string;
}

/** 命中该正则的镜像视为 tailscale 相关镜像。 */
export const TAILSCALE_IMAGE_RE = /(^|[/:])tailscale([/:]|$)|tailscale\/|ts-sidecar/i;
