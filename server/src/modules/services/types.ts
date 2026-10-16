/**
 * 服务注册表的 **HTTP 契约类型**（同时是前端 `web/src/api/types.ts` 的镜像来源）。
 *
 * 与 `modules/docker/types.ts` 同样的约定：这里既被路由层直接返回，也被前端逐字段对应，
 * 因此**改字段必须同步三处**：本文件、`docs/static/04-api-contract.md`、`web/src/api/types.ts`。
 *
 * 设计上刻意区分三层，不要合并：
 * - `ServiceView`：**长期事实 + 用户配置**（数据库里那一行 + 实时算出来的入口与状态）；
 * - `ServiceEntryView`：入口候选（实时计算，不落库），永远保留全部候选供诊断；
 * - `ServiceStatusView`：三个独立维度（容器 / 可达 / 健康），任何一处都不允许退化成"服务挂了"。
 */
import type { ContainerState, EntryKind, ServiceHealth } from './registry.js';

/** 单个入口候选。 */
export interface ServiceEntryView {
  kind: EntryKind;
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
  sourceType: 'docker' | 'serve' | 'manual';
  /** 稳定来源标识（**不含容器 ID**），见 modules/services/registry.ts */
  sourceRef: string;
  bindingRefs: string[];
  visibility: 'visible' | 'hidden';
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
  /** 1 = 用户改过展示属性（自动发现不再覆盖） */
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
  mode: 'deleted' | 'hidden' | 'reset';
  service: ServiceView | null;
}