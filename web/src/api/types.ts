/**
 * API 类型定义 —— 与后端契约逐字段对应。
 *
 * **契约来源**：docs/static/04-api-contract.md。
 * 后端改动接口时必须同步本文件与文档，否则前端会出现静默的类型漂移。
 */

export type Reachability = 'tailnet' | 'lan' | 'localhost-only' | 'none';
export type ProbeState = 'up' | 'down' | 'unknown';
export type Role = 'admin' | 'viewer';
export type ThemePreference = 'dark' | 'light' | 'system';
export type DensityPreference = 'comfortable' | 'compact';

export interface ApiErrorBody {
  error: { code: string; message: string; details: unknown };
}

export interface SourceStatus {
  available: boolean;
  mode: string;
  detail: string | null;
}

export interface UrlCandidate {
  label: 'tailnet' | 'magicdns' | 'localhost' | 'lan' | 'custom';
  url: string;
  display?: string;
}

// ---------------------------------------------------------------- 认证

export interface SessionUser {
  id: number;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface SessionView {
  setupRequired: boolean;
  authenticated: boolean;
  csrfToken: string;
  user: SessionUser | null;
  expiresAt: string | null;
}

export interface LoginResponse {
  user: SessionUser;
  csrfToken: string;
  expiresAt: string;
}

export interface UserPreferences {
  userId: number;
  theme: ThemePreference;
  density: DensityPreference;
  defaultPage: string;
  updatedAt: string;
}

export interface MeResponse {
  user: SessionUser;
  preferences: UserPreferences;
}

/** 会话诊断（GET /api/auth/session/activity）。 */
export interface SessionActivity {
  sessionId: string;
  createdAt: string;
  expiresAt: string;
  lastSeenAt: string;
  userAgent: string | null;
  remoteAddr: string | null;
}

// ---------------------------------------------------------------- 健康检查

export interface HealthResponse {
  status: string;
  version: string;
  revision: string;
  env: string;
  uptimeSec: number;
  startedAt: string;
  setupRequired: boolean;
  sources: {
    docker: SourceStatus;
    tailscale: SourceStatus;
    system: SourceStatus;
    disk: SourceStatus;
    gpu: SourceStatus;
  };
}

// ---------------------------------------------------------------- 容器

export interface ContainerPortView {
  containerPort: number;
  protocol: string;
  hostIp: string;
  hostPort: number | null;
  reachability: Reachability;
  url: string | null;
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
  reachability: Reachability;
  primaryUrl: string | null;
  ports: ContainerPortView[];
  urlCandidates: UrlCandidate[];
  tailscaleSidecar: boolean;
  /** 该容器被 `tailscale serve` 暴露的路径 */
  servePaths: string[];
  /** 经 serve 暴露的入口 URL */
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
  attention: number;
}

export interface ContainerListResponse {
  items: ContainerSummary[];
  total: number;
  summary: ContainerListSummary;
  source: SourceStatus;
  /** `tailscale serve` 暴露的路由（独立于容器端口映射） */
  serve: ServeStatusView;
}

/** 一条 `tailscale serve` 路由。 */
export interface ServeRouteView {
  host: string;
  port: number;
  scheme: 'https';
  path: string;
  /** 可直接点击的 tailnet 入口 */
  url: string;
  /** serve 的代理目标（宿主视角） */
  proxy: string;
  targetHost: string | null;
  targetPort: number | null;
  /** 提供该服务的容器名（能匹配到时） */
  containerName: string | null;
  containerId: string | null;
  /** 该目标端口已作为可达端口展示过（这类不重复列出） */
  coveredByContainerPort: boolean;
}

export interface ServeStatusView {
  available: boolean;
  mode: string;
  detail: string | null;
  routes: ServeRouteView[];
}

export interface ContainerDetailResponse {
  container: ContainerDetail;
}

export interface ContainerLogsResponse {
  lines: string[];
  truncated: boolean;
  stream: string;
  containerId: string;
  containerName: string;
}

// ---------------------------------------------------------------- tailnet

export interface TailnetDevice {
  id: string;
  hostname: string;
  dnsName: string;
  os: string;
  ipv4: string | null;
  ipv6: string | null;
  online: boolean;
  lastSeen: string | null;
  createdAt: string | null;
  exitNode: boolean;
  exitNodeOption: boolean;
  tags: string[];
  relay: string | null;
  isSelf: boolean;
  rxBytes: number | null;
  txBytes: number | null;
  connection: 'direct' | 'relay' | 'idle';
}

export interface TailnetStatusResponse {
  self: TailnetDevice | null;
  tailnet: { name: string | null; magicDnsSuffix: string | null };
  peers: TailnetDevice[];
  summary: { peersTotal: number; peersOnline: number; peersOffline: number };
  backendState: string | null;
  source: SourceStatus;
}

export interface TailnetStatusLite {
  self: TailnetDevice | null;
  summary: { peersTotal: number; peersOnline: number; peersOffline: number };
  backendState: string | null;
  source: SourceStatus;
}

// ---------------------------------------------------------------- 系统

export interface HostIdentityView {
  hostname: string;
  platform: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  uptimeSec: number;
  bootedAt: string;
  osLabel: string;
  hostIsLinux: boolean;
}

export interface CpuView {
  percent: number | null;
  perCore: number[];
  loadAvg: [number, number, number];
}

export interface MemoryView {
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  percent: number | null;
  cachedBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
}

export interface DiskView {
  mount: string;
  label: string;
  fsType: string | null;
  usedBytes: number | null;
  totalBytes: number | null;
  availableBytes: number | null;
  percent: number | null;
  error: string | null;
}

export interface GpuProcessView {
  pid: number;
  name: string;
  memoryUsedBytes: number | null;
}

export interface GpuView {
  available: boolean;
  index: number;
  name: string;
  percent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
  powerLimitWatts: number | null;
  fanPercent: number | null;
  processes: GpuProcessView[];
  detail: string | null;
}

export interface SystemSources {
  cpu: SourceStatus;
  memory: SourceStatus;
  disk: SourceStatus;
  gpu: SourceStatus;
}

export interface SystemSnapshotResponse {
  generatedAt: string;
  host: HostIdentityView;
  cpu: CpuView;
  memory: MemoryView;
  disks: DiskView[];
  gpu: GpuView | null;
  sources: SystemSources;
}

export interface SystemMetricsFrame {
  generatedAt: string;
  cpu: CpuView;
  memory: MemoryView;
  disks: DiskView[];
  gpu: GpuView | null;
  sources: Pick<SystemSources, 'cpu' | 'memory' | 'gpu'>;
}

// ---------------------------------------------------------------- 工具

export interface ToolStatusView {
  state: ProbeState;
  latencyMs: number | null;
  httpStatus: number | null;
  checkedAt: string | null;
  detail: string | null;
  stale: boolean;
  /** 实际探测成功的目标主机与端口（与入口主机可能不同） */
  target: { host: string; port: number } | null;
}

export interface ToolView {
  id: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  url: string | null;
  urlCandidates: UrlCandidate[];
  exposed: boolean;
  hostPort: number | null;
  deepLink: { label: string; url: string } | null;
  status: ToolStatusView;
  hint: string | null;
  featured: boolean;
  order: number;
}

export interface ToolListResponse {
  items: ToolView[];
  summary: { total: number; up: number; down: number; unknown: number };
  warnings: string[];
  source: SourceStatus;
}

// ---------------------------------------------------------------- 概览

export interface OverviewResponse {
  generatedAt: string;
  containers: ContainerListSummary;
  tailnet: {
    self: TailnetDevice | null;
    peersTotal: number;
    peersOnline: number;
    peersOffline: number;
    backendState: string | null;
    onlinePeers: Array<{ id: string; hostname: string; os: string; ipv4: string | null; connection: string }>;
  };
  system: {
    cpuPercent: number | null;
    cpuModel: string;
    cpuCores: number;
    memPercent: number | null;
    memUsedBytes: number;
    memTotalBytes: number;
    diskPercent: number | null;
    diskUsedBytes: number | null;
    diskTotalBytes: number | null;
    diskLabel: string | null;
    gpuPercent: number | null;
    gpuName: string | null;
    gpuMemPercent: number | null;
    uptimeSec: number;
    hostname: string;
    osLabel: string;
  };
  tools: {
    total: number;
    up: number;
    down: number;
    unknown: number;
    featured: Array<{ id: string; name: string; state: string; url: string | null; latencyMs: number | null }>;
  };
  sources: {
    docker: SourceStatus;
    tailscale: SourceStatus;
    system: SourceStatus;
    gpu: SourceStatus;
  };
  warnings: string[];
}

// ---------------------------------------------------------------- 用户管理

export interface UserListResponse {
  items: SessionUser[];
  total: number;
}

export interface AuditEntry {
  id: number;
  at: string;
  actorId: number | null;
  actorName: string | null;
  action: string;
  target: string | null;
  detail: string | null;
  ip: string | null;
}

export interface AuditListResponse {
  items: AuditEntry[];
  total: number;
}

// ---------------------------------------------------------------- 运行时设置

/**
 * 生效级别。
 *
 * - `live`：下次读取即生效
 * - `reload`：保存后自动重建对应数据源，立即生效
 * - `restart`：**改不了**，需重建容器（容器创建参数）
 */
export type SettingEffect = 'live' | 'reload' | 'restart';

export type SettingValueType = 'string' | 'number' | 'boolean' | 'enum' | 'string-list';

export type SettingGroup = 'tailscale' | 'docker' | 'system' | 'tools' | 'performance' | 'boot';

export interface SettingView {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  effect: SettingEffect;
  valueType: SettingValueType;
  envVar: string;
  /** 当前生效值（敏感项已打码） */
  value: unknown;
  /** 是否被打码（前端用密码框 + 占位符） */
  masked: boolean;
  source: 'default' | 'env' | 'database';
  defaultValue: unknown;
  envValue: string | null;
  databaseValue: unknown;
  choices?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
  sensitive?: boolean;
  restartReason?: string;
  updatedAt?: string;
  updatedBy?: string | null;
  /** false 表示需重建容器，界面不给编辑控件 */
  editable: boolean;
}

export interface SettingsResponse {
  groups: ReadonlyArray<{ id: SettingGroup; label: string; description: string }>;
  settings: SettingView[];
  version: string;
}

export interface UpdateSettingsResponse {
  updatedKeys: string[];
  rejectedRestartKeys: string[];
  invalid: Array<{ key: string; error: string }>;
  reloaded: { tailscale: boolean; docker: boolean };
  view: SettingsResponse;
}

export interface ResetSettingsResponse {
  removed: number;
  view: SettingsResponse;
}

export interface TailscaleDeviceSummary {
  hostname: string;
  os: string;
  online: boolean;
  ipv4: string | null;
}

export interface TailscaleTestResponse {
  ok: boolean;
  mode: 'cli' | 'api' | 'off';
  source: { available: boolean; mode: string; detail: string | null };
  deviceCount: number | null;
  onlineCount: number | null;
  devices: TailscaleDeviceSummary[];
  message: string;
}
