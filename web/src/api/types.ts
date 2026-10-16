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
  /** 是否已启用两步验证（TOTP）；界面据此显示徽标与"关闭"入口 */
  totpEnabled: boolean;
  /**
   * 两步验证绑定确认时间。
   *
   * 注意：冻结契约只承诺 `totpEnabled`，后端 `server/src/db/types.ts` 的 `User`
   * 已经带了这个字段，因此这里按**可选**声明：返回时界面显示真实绑定时间，
   * 未返回（`undefined`）时界面显示 `—`，不影响任何逻辑。
   */
  totpConfirmedAt?: string | null;
}

export interface SessionView {
  setupRequired: boolean;
  authenticated: boolean;
  csrfToken: string;
  user: SessionUser | null;
  expiresAt: string | null;
}

/** 登录成功（第一步即成功，或第二步验证通过）：会话 Cookie 已下发。 */
export interface LoginSuccessResponse {
  user: SessionUser;
  csrfToken: string;
  expiresAt: string;
}

/**
 * 登录第一步的"需要第二步"分支（账号已启用 TOTP）。
 *
 * **不设置会话 Cookie**：此时尚未登录成功，`challengeToken` 只是后续
 * `POST /api/auth/login/totp` 的一次性凭据（后端 TTL 默认 5 分钟）。
 */
export interface LoginTotpChallengeResponse {
  totpRequired: true;
  challengeToken: string;
  expiresAt: string;
}

/** `POST /api/auth/login` 的响应：判别联合，用 `totpRequired` 区分两步。 */
export type LoginResponse = LoginSuccessResponse | LoginTotpChallengeResponse;

/** `POST /api/auth/login/totp` 的请求体。 */
export interface LoginTotpRequest {
  challengeToken: string;
  /**
   * 6 位 TOTP 动态码，或恢复码（形如 `XXXX-XXXX`）。
   * 前端不做格式强校验，交给后端判定并返回 `TOTP_INVALID`。
   */
  code: string;
  remember?: boolean;
}

/** `POST /api/auth/login/totp` 成功后的响应（与普通登录一致）。 */
export type LoginTotpResponse = LoginSuccessResponse;

/** 判断登录第一步的响应是否要求第二步验证。 */
export function isTotpChallenge(response: LoginResponse): response is LoginTotpChallengeResponse {
  return 'totpRequired' in response && response.totpRequired === true;
}

// ---------------------------------------------------------------- 两步验证（TOTP）

/** `POST /api/users/me/totp/setup` —— 生成（或重新生成）**未确认**的种子。 */
export interface TotpSetupResponse {
  secret: string;
  otpauthUri: string;
  digits: 6;
  period: 30;
}

/** `POST /api/users/me/totp/enable` 的请求体。 */
export interface TotpEnableRequest {
  code: string;
}

/** `POST /api/users/me/totp/enable` —— 绑定成功，**一次性**返回恢复码。 */
export interface TotpEnableResponse {
  recoveryCodes: string[];
  user: SessionUser;
}

/** `POST /api/users/me/totp/disable` 的请求体；`code` 可选（后端可能要求二次确认）。 */
export interface TotpDisableRequest {
  password: string;
  code?: string;
}

/** `POST /api/users/me/totp/disable`。 */
export interface TotpDisableResponse {
  ok: true;
  user: SessionUser;
}

/** `POST /api/users/me/totp/recovery-codes` 的请求体。 */
export interface TotpRecoveryCodesRequest {
  code: string;
}

/** 恢复码列表（重新生成时旧的立即失效）。 */
export interface RecoveryCodesResponse {
  recoveryCodes: string[];
}

/** `POST /api/users/:id/totp/reset`（管理员强制重置）。 */
export interface TotpResetResponse {
  ok: true;
  /** 被连带吊销的会话数 —— 用户会直接掉线 */
  revokedSessions: number;
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

// ---------------------------------------------------------------- 服务注册表（Sprint 1）

/**
 * 服务相关的类型 —— 与 `server/src/modules/services/types.ts` **逐字段一致**。
 *
 * 三层的区分刻意保留（不要合并）：
 * - `ServiceView`：长期事实 + 用户配置（数据库那一行 + 实时算出的入口与状态）；
 * - `ServiceEntryView`：入口候选（实时计算，不落库），全部候选都保留供诊断；
 * - `ServiceStatusView`：容器 / 可达 / 健康三个**独立**维度，不允许退化成"服务挂了"。
 */

/** 入口类型（rank 越小越优先：用户指定 > Serve > Tailnet > LAN > 仅本机）。 */
export type ServiceEntryKind = 'user' | 'serve' | 'tailnet' | 'lan' | 'localhost';
/** 容器维度：`null` 表示没有容器绑定（纯 serve / 手工服务）。 */
export type ContainerState = 'running' | 'stopped' | 'absent';
/** 健康维度：`skipped` = 没配置健康检查（默认状态，不探测）。 */
export type ServiceHealth = 'ok' | 'fail' | 'unknown' | 'skipped';
export type ServiceSourceType = 'docker' | 'serve' | 'manual';
export type ServiceVisibility = 'visible' | 'hidden';
export type ServiceDeleteMode = 'deleted' | 'hidden' | 'reset';

/** 单个入口候选。 */
export interface ServiceEntryView {
  kind: ServiceEntryKind;
  label: string;
  url: string;
  /** 越小越优先（0 用户指定 / 1 Serve / 2 Tailnet / 3 LAN / 4 仅本机） */
  rank: number;
  /** 是否可从当前访问者之外到达；"仅本机"恒为 false */
  accessible: boolean;
  detail: string | null;
}

/** 三维状态：容器运行 / 入口可达 / 健康检查，**分开表示**。 */
export interface ServiceStatusView {
  container: ContainerState | null;
  reachable: boolean | null;
  health: ServiceHealth;
  reasons: string[];
}

/** 服务当前关联的容器（可空：纯 serve 路由或手工服务）。 */
export interface ServiceContainerRef {
  id: string;
  name: string;
  state: string;
  image: string;
}

export interface ServiceView {
  id: string;
  slug: string;
  displayName: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  sourceType: ServiceSourceType;
  /** 稳定来源标识（**不含容器 ID**） */
  sourceRef: string;
  bindingRefs: string[];
  visibility: ServiceVisibility;
  favorite: boolean;
  sortOrder: number;
  /** 管理员指定并验证过的首选入口（优先级最高，可空） */
  preferredUrl: string | null;
  /** 首选入口 = 第一个可达候选；一个都没有则 null */
  entry: string | null;
  entries: ServiceEntryView[];
  entryCount: number;
  status: ServiceStatusView;
  container: ServiceContainerRef | null;
  /** true = 用户改过展示属性（自动发现不再覆盖） */
  userEdited: boolean;
  healthTarget: string | null;
  healthPath: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 数据源可用性：服务墙必须把它透出，不能"静默为空"。 */
export interface ServiceDiscoveryState {
  dockerAvailable: boolean;
  serveAvailable: boolean;
  serveDetail: string | null;
  /** 本次发现的时间（ISO） */
  discoveredAt: string;
  /** 面向人的发现说明（降级原因等） */
  notes: string[];
}

export interface ServiceListResponse {
  items: ServiceView[];
  total: number;
  categories: string[];
  discovery: ServiceDiscoveryState;
  generatedAt: string;
}

/** 详情页的诊断数据：为什么这个服务是现在这个样子。 */
export interface ServiceDiagnostics {
  containerPorts: Array<{
    containerPort: number;
    protocol: string;
    hostIp: string;
    hostPort: number | null;
    reachability: string;
    url: string | null;
  }>;
  serveRoutes: Array<{
    host: string;
    port: number;
    path: string;
    url: string;
    proxy: string;
    targetPort: number | null;
  }>;
  notes: string[];
}

export interface ServiceDetailResponse {
  service: ServiceView;
  /** 全部候选入口（含不可达的） */
  candidates: ServiceEntryView[];
  diagnostics: ServiceDiagnostics;
}

export type ServiceSearchKind = 'service' | 'container' | 'device' | 'tool';

export interface ServiceSearchHit {
  kind: ServiceSearchKind;
  id: string;
  title: string;
  subtitle: string | null;
  url: string | null;
  keywords: string[];
}

export interface ServiceSearchResponse {
  items: ServiceSearchHit[];
  query: string;
}

/** 一次性健康探测结果（实时计算，不落库为信任）。 */
export interface ServiceHealthView {
  state: 'ok' | 'fail';
  statusCode: number | null;
  durationMs: number;
  detail: string | null;
  at: string;
}

export interface ServiceHealthResponse {
  service: ServiceView;
  health: ServiceHealthView;
}

export interface ServiceDeleteResponse {
  ok: true;
  mode: ServiceDeleteMode;
  service: ServiceView | null;
}

/** `GET /api/services` 的查询参数。 */
export interface ServiceListParams {
  query?: string;
  category?: string;
  /** 只看收藏 */
  favorite?: boolean;
  /** 含隐藏服务（仅 admin 生效） */
  includeHidden?: boolean;
}

/**
 * `POST /api/services` 请求体（新建手工服务）。
 *
 * 字段名与后端严格校验的键一一对应（`serviceCreateBodySchema`，`.strict()` + 未知字段拒绝）。
 * **注意**：创建时可选字段只接受 `string`（不接受 `null`）—— 空值必须**整个省略该键**，
 * 这一点与 `PATCH` 不同（PATCH 的 `null` 表示"清空该字段"）。
 */
export interface ServiceCreateRequest {
  displayName: string;
  description?: string;
  icon?: string;
  category?: string;
  preferredUrl?: string;
  healthTarget?: string;
  healthPath?: string;
}

/** `PATCH /api/services/:id` 请求体：上述展示属性任意子集 + 管理字段。 */
export interface ServiceUpdateRequest {
  displayName?: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  preferredUrl?: string | null;
  healthTarget?: string | null;
  healthPath?: string | null;
  visibility?: ServiceVisibility;
  sortOrder?: number;
  favorite?: boolean;
}

/** `POST /api/services/reorder` 请求体。 */
export interface ServiceReorderRequest {
  order: Array<{ id: string; sortOrder: number }>;
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
