/**
 * 服务注册表业务服务（Sprint 1 的 S1-01 / S1-02 / S1-03 / S1-05）。
 *
 * 分层：**本文件只做编排**。
 * - 「发现什么、入口怎么排序、状态怎么判定」全在 `registry.ts`（纯函数，可单测）；
 * - 「怎么存、用户字段怎么保护」全在 `db/services.ts`（仓储）；
 * - 「探测能不能发出去」全在 `healthProbe.ts`（安全边界）。
 *
 * 三条实现纪律：
 * 1. **不在启动时拉数据**：构造函数不发起任何请求，第一次请求（或显式 discover）
 *    才触发 `sync()`。否则"设置还没生效就去读 Docker"会在冷启动时读到过期配置。
 * 2. **发现过程绝不覆盖用户字段**：只调用 `insert` / `upsertDiscovered` /
 *    `replaceBindings`，绝不自己写 UPDATE（用户字段的唯一入口是 `updateUserFields`）。
 * 3. **实时计算不落库**：候选入口、可达性、容器运行态、健康结果一律当场算，
 *    DB 里只留"上一次发现结果"的快照用于诊断。
 */
import { randomUUID } from 'node:crypto';
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import type { AuditRepository } from '../../db/users.js';
import type { ServicesRepository, UserFieldPatch } from '../../db/services.js';
import type { Service, ServiceBinding } from '../../db/types.js';
import { badRequest, notFound } from '../../http/errors.js';
import { TtlCache } from '../../util/cache.js';
import { buildHostContext, type PortalHostContext } from '../docker/hostContext.js';
import type { ContainerService, HostContextRequest } from '../docker/service.js';
import type { ContainerListResult, ContainerSummary, ServeRouteView } from '../docker/types.js';
import type { TailscaleService } from '../tailscale/service.js';
import { runHealthProbe, validateHealthTarget, type HealthProbeResult } from './healthProbe.js';
import {
  DEFAULT_CATEGORY,
  buildServiceEntries,
  findContainerForService,
  isBuiltinIcon,
  pickEntry,
  planDiscovery,
  resolveServiceStatus,
  serveRoutesForService,
  slugBaseFor,
  type DiscoveryPlan,
  type ServiceEntry,
} from './registry.js';
import type {
  ServiceDeleteResponse,
  ServiceDetailResponse,
  ServiceDiagnostics,
  ServiceDiscoveryState,
  ServiceHealthResponse,
  ServiceListResponse,
  ServiceView,
} from './types.js';

/** 角色只看这两档（与 db 的 UserRole 一致；写成字面量避免业务层依赖 db 类型）。 */
export type ServiceRole = 'admin' | 'viewer';

/** 写操作的执行者（审计用）。 */
export interface ServiceActor {
  userId: number;
  username: string;
  ip: string | null;
}

export interface ServiceRegistryServiceDeps {
  containers: ContainerService;
  tailscale: TailscaleService;
  repository: ServicesRepository;
  /** 写操作审计（与 `modules/users/service.ts` 同一套 AuditRepository）。 */
  audit: AuditRepository;
  config: PortalConfig;
  logger: Logger;
}

/** 一次发现的完整结果（含"什么时候发现的"与面向人的说明）。 */
export interface DiscoverySnapshot {
  plan: DiscoveryPlan;
  discoveredAt: string;
}

export interface ServiceListQuery {
  /** 标题/描述/分类/入口/容器名的子串匹配 */
  query?: string;
  /** 分类精确匹配（未分类用 `DEFAULT_CATEGORY`，即「未分类」） */
  category?: string;
  favorite?: boolean;
  /** **仅 admin 生效**：把 hidden 服务也返回（管理页用） */
  includeHidden?: boolean;
}

export interface ServiceCreateInput {
  displayName: string;
  description?: string | null;
  icon?: string | null;
  category?: string | null;
  preferredUrl?: string | null;
  healthTarget?: string | null;
  healthPath?: string | null;
  visibility?: 'visible' | 'hidden';
  sortOrder?: number;
  favorite?: boolean;
}

export type ServiceUpdateInput = Partial<ServiceCreateInput>;

export interface ServiceOrderEntry {
  id: string;
  sortOrder: number;
}

/**
 * 发现缓存的兜底 TTL。
 *
 * 选择说明：优先跟随 `config.cache.containersTtlMs`（默认 2000ms）——
 * 底层 `containers.list` 本来就是这个 TTL，发现比它更频繁只会重复扫一遍同样的数据；
 * 而且该值可以在设置页热调，运营时"降压力/提新鲜度"只调一个旋钮。
 * 仅当配置值非法（NaN/负）时才回退到 5000ms。
 */
export const DISCOVERY_CACHE_TTL_FALLBACK_MS = 5000;

/** 内存里保留的健康探测结果上限（超出淘汰最早的一条；结果不落库）。 */
export const HEALTH_RESULT_LIMIT = 512;

export class ServiceRegistryService {
  private readonly deps: ServiceRegistryServiceDeps;
  private readonly log: Logger;
  private readonly discoveryCache: TtlCache<DiscoverySnapshot>;
  /** 健康探测结果：**只在内存**，key = serviceId（进程重启即清空，谁也不许把它当真相）。 */
  private readonly healthResults = new Map<string, HealthProbeResult>();

  constructor(deps: ServiceRegistryServiceDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ mod: 'services' });
    this.discoveryCache = new TtlCache<DiscoverySnapshot>({
      ttlMs: this.discoveryTtlMs(),
      maxEntries: 4,
      logger: this.log,
    });
  }

  /* ------------------------------------------------------------------ *
   * 发现（S1-01）
   * ------------------------------------------------------------------ */

  /**
   * 规划一次发现并落库（幂等）。
   *
   * 默认走 TTL 缓存：页面刷新、多个客户端同时打开不会各扫一遍 Docker。
   * `force: true` 用于 `POST /api/services/discover`（管理员显式要求重新发现）。
   */
  async sync(request?: HostContextRequest, options: { force?: boolean } = {}): Promise<DiscoverySnapshot> {
    if (options.force) this.discoveryCache.delete('discovery');
    return this.discoveryCache.get('discovery', () => this.runDiscovery(request), this.discoveryTtlMs());
  }

  /** 真正执行一次发现：规划 → 落库 → 重建绑定快照。 */
  private async runDiscovery(request?: HostContextRequest): Promise<DiscoverySnapshot> {
    const live = await this.loadLive(request ?? this.neutralRequest());
    const plan = planDiscovery({
      containers: live.items,
      serveRoutes: live.serve.routes,
      dockerAvailable: live.source.available,
      serveAvailable: live.serve.available,
      serveDetail: live.serve.detail,
    });

    for (const discovered of plan.services) {
      const existing = this.deps.repository.findBySource(discovered.sourceType, discovered.sourceRef);
      let serviceId: string;
      if (existing) {
        // 既有服务：只写自动字段（user_edited=1 时仓储内部保持用户值不动）
        serviceId = existing.id;
        this.deps.repository.upsertDiscovered(serviceId, {
          displayName: discovered.displayName,
          description: discovered.description,
          icon: discovered.icon,
          category: discovered.category,
          bindingRefs: discovered.bindingRefs,
        });
      } else {
        serviceId = randomUUID();
        this.deps.repository.insert({
          id: serviceId,
          slug: this.deps.repository.uniqueSlug(slugBaseFor(discovered.displayName, discovered.sourceRef)),
          displayName: discovered.displayName,
          description: discovered.description,
          icon: discovered.icon,
          category: discovered.category,
          sourceType: discovered.sourceType,
          sourceRef: discovered.sourceRef,
          bindingRefs: discovered.bindingRefs,
          userEdited: false,
        });
      }
      // 绑定是"上一次发现结果"的快照：整体重建，可丢可重算
      this.deps.repository.replaceBindings(serviceId, discovered.bindings);
    }

    this.log.debug('服务发现完成', {
      discovered: plan.services.length,
      dockerAvailable: plan.dockerAvailable,
      serveAvailable: plan.serveAvailable,
      notes: plan.notes.length,
    });

    return { plan, discoveredAt: new Date().toISOString() };
  }

  /** 发现缓存的 TTL；配置为 0 表示不缓存（与容器列表缓存语义一致）。 */
  private discoveryTtlMs(): number {
    const ttl = this.deps.config.cache.containersTtlMs;
    if (!Number.isFinite(ttl) || ttl < 0) return DISCOVERY_CACHE_TTL_FALLBACK_MS;
    return ttl;
  }

  /* ------------------------------------------------------------------ *
   * 读（列表 / 详情）
   * ------------------------------------------------------------------ */

  /**
   * 服务墙列表。
   *
   * @param request 用于推导门户对外主机（入口 URL 依赖它）
   * @param query   过滤条件
   * @param role    调用者角色：非 admin 永远只看到 `visibility='visible'`
   */
  async list(
    request: HostContextRequest,
    query: ServiceListQuery = {},
    role: ServiceRole = 'viewer',
  ): Promise<ServiceListResponse> {
    const snapshot = await this.sync(request);
    const live = await this.loadLive(request);
    const hostContext = this.buildHost(request);
    const bindingsByService = this.groupBindings(this.deps.repository.listBindings());

    const items: ServiceView[] = [];
    for (const service of this.deps.repository.listAll()) {
      if (!canSee(service, role, query.includeHidden)) continue;
      const view = this.buildView(service, bindingsByService.get(service.id) ?? [], live, hostContext);
      if (!matchesQuery(view, query)) continue;
      items.push(view);
    }

    return {
      items,
      total: items.length,
      categories: collectCategories(items),
      discovery: toDiscoveryState(snapshot),
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 服务详情：列表项 + 全部候选入口（含不可达）+ 诊断。
   *
   * hidden 服务对非 admin 一律 `notFound`（**不是 403**）：
   * 403 会泄露"这里确实有一个你看不到的服务"。
   */
  async detail(id: string, request: HostContextRequest, role: ServiceRole = 'viewer'): Promise<ServiceDetailResponse> {
    const snapshot = await this.sync(request);
    const live = await this.loadLive(request);
    const hostContext = this.buildHost(request);
    const service = this.requireVisible(id, role);
    const bindings = this.deps.repository.listBindings([id]);
    const context = this.computeContext(service, bindings, live, hostContext);

    const diagnostics: ServiceDiagnostics = {
      containerPorts: (context.container?.ports ?? []).map((port) => ({
        containerPort: port.containerPort,
        protocol: port.protocol,
        hostIp: port.hostIp,
        hostPort: port.hostPort,
        reachability: port.reachability,
        url: port.url,
      })),
      serveRoutes: context.serveRoutes.map((route) => ({
        host: route.host,
        port: route.port,
        path: route.path,
        url: route.url,
        proxy: route.proxy,
        targetPort: route.targetPort,
      })),
      notes: snapshot.plan.notes,
    };

    return { service: context.view, candidates: context.entries, diagnostics };
  }

  /* ------------------------------------------------------------------ *
   * 写（全部 admin + 审计）
   * ------------------------------------------------------------------ */

  /** 新建手工服务（`source_type='manual'`，身份随 `manual:<uuid>` 固定，永不被发现改写）。 */
  async create(input: ServiceCreateInput, actor: ServiceActor, request: HostContextRequest): Promise<ServiceView> {
    const displayName = input.displayName.trim();
    if (displayName === '') {
      throw badRequest('服务名称不能为空', { fieldErrors: { displayName: ['服务名称不能为空'] } });
    }
    const preferredUrl = cleanOptionalUrl(input.preferredUrl, 'preferredUrl');
    const healthTarget = cleanOptionalUrl(input.healthTarget, 'healthTarget');
    const healthPath = cleanHealthPath(input.healthPath);
    const icon = cleanIcon(input.icon);

    const sourceRef = `manual:${randomUUID()}`;
    const created = this.deps.repository.insert({
      id: randomUUID(),
      slug: this.deps.repository.uniqueSlug(slugBaseFor(displayName, sourceRef)),
      displayName,
      description: emptyToNull(input.description),
      icon,
      category: emptyToNull(input.category),
      preferredUrl,
      sourceType: 'manual',
      sourceRef,
      bindingRefs: [],
      visibility: input.visibility ?? 'visible',
      sortOrder: input.sortOrder ?? 100,
      favorite: input.favorite ?? false,
      healthTarget,
      healthPath,
      // 手工创建即"用户编辑过"：后续自动发现不应改写它
      userEdited: true,
      updatedBy: actor.username,
    });

    this.audit(actor, 'service.create', `service:${created.id}`, `新建手工服务「${displayName}」`);
    return this.viewOf(created, request);
  }

  /**
   * 更新展示属性 / 首选入口 / 可见性 / 排序 / 收藏 / 健康配置。
   *
   * URL 与路径校验在**落库之前**完成：非法值直接 400，什么都不写。
   */
  async update(
    id: string,
    patch: ServiceUpdateInput,
    actor: ServiceActor,
    request: HostContextRequest,
  ): Promise<ServiceView> {
    this.requireService(id, 'admin');

    const fields: UserFieldPatch = {};
    if (patch.displayName !== undefined) fields.displayName = patch.displayName.trim();
    if (patch.description !== undefined) fields.description = emptyToNull(patch.description);
    if (patch.icon !== undefined) fields.icon = cleanIcon(patch.icon);
    if (patch.category !== undefined) fields.category = emptyToNull(patch.category);
    if (patch.preferredUrl !== undefined) fields.preferredUrl = cleanOptionalUrl(patch.preferredUrl, 'preferredUrl');
    if (patch.healthTarget !== undefined) fields.healthTarget = cleanOptionalUrl(patch.healthTarget, 'healthTarget');
    if (patch.healthPath !== undefined) fields.healthPath = cleanHealthPath(patch.healthPath);
    if (patch.visibility !== undefined) fields.visibility = patch.visibility;
    if (patch.sortOrder !== undefined) fields.sortOrder = patch.sortOrder;
    if (patch.favorite !== undefined) fields.favorite = patch.favorite;

    const updated = this.deps.repository.updateUserFields(id, fields, actor.username);
    if (!updated) throw notFound(`服务 ${id} 不存在`);

    this.audit(actor, 'service.update', `service:${id}`, `更新 ${describePatch(fields)}`);
    return this.viewOf(updated, request);
  }

  /**
   * 删除 / 隐藏 / 重置（三种语义，见 spec §2.2）。
   *
   * - `mode='reset'`：清掉全部用户覆盖，交还给自动层；
   * - 手工服务：真删（它只存在于注册表里，没有"自动层"可回退）；
   * - 自动服务：置 `hidden` —— 容器临时消失不该抹掉用户的可见性决定。
   */
  async remove(
    id: string,
    mode: 'reset' | null,
    actor: ServiceActor,
    request: HostContextRequest,
  ): Promise<ServiceDeleteResponse> {
    const service = this.requireService(id, 'admin');

    if (mode === 'reset') {
      const updated = this.deps.repository.clearUserOverrides(id);
      this.healthResults.delete(id);
      this.audit(actor, 'service.reset', `service:${id}`, `清空用户覆盖「${service.displayName}」，交还给自动发现`);
      return { ok: true, mode: 'reset', service: updated ? await this.viewOf(updated, request) : null };
    }

    if (service.sourceType === 'manual') {
      this.deps.repository.delete(id);
      this.healthResults.delete(id);
      this.audit(actor, 'service.delete', `service:${id}`, `删除手工服务「${service.displayName}」`);
      return { ok: true, mode: 'deleted', service: null };
    }

    const updated = this.deps.repository.setVisibility(id, 'hidden', actor.username);
    this.audit(actor, 'service.hide', `service:${id}`, `隐藏自动服务「${service.displayName}」（配置保留，可随时恢复显示）`);
    return { ok: true, mode: 'hidden', service: updated ? await this.viewOf(updated, request) : null };
  }

  /** 批量排序（单事务）。返回重排后的完整列表，前端可直接替换本地状态。 */
  async reorder(
    entries: readonly ServiceOrderEntry[],
    actor: ServiceActor,
    request: HostContextRequest,
  ): Promise<ServiceListResponse> {
    for (const entry of entries) {
      if (!this.deps.repository.findById(entry.id)) throw notFound(`服务 ${entry.id} 不存在`);
    }
    this.deps.repository.reorder(entries, actor.username);
    this.audit(actor, 'service.reorder', null, `调整 ${entries.length} 个服务的排序`);
    return this.list(request, { includeHidden: true }, 'admin');
  }

  /* ------------------------------------------------------------------ *
   * 健康探测（S1-03）
   * ------------------------------------------------------------------ */

  /**
   * 一次性健康探测（管理员显式动作）。
   *
   * 目标优先级：请求显式覆盖 → 已保存的 `healthTarget` → `healthPath` + 首选入口。
   * 结果只放内存（key = serviceId）；**不落库为信任**，每次执行都重新校验。
   * 生产路径不注入 `fetchImpl`（测试注入只发生在 `runHealthProbe` 的纯函数单测里）。
   */
  async probeHealth(
    id: string,
    overrideTarget: string | null,
    actor: ServiceActor,
    request: HostContextRequest,
  ): Promise<ServiceHealthResponse> {
    const service = this.requireService(id, 'admin');
    const live = await this.loadLive(request);
    const hostContext = this.buildHost(request);
    const context = this.computeContext(service, this.deps.repository.listBindings([id]), live, hostContext);

    const target = resolveHealthTarget({
      overrideTarget,
      healthTarget: service.healthTarget,
      healthPath: service.healthPath,
      entry: context.view.entry,
    });
    if (target === null) throw badRequest('该服务未配置健康检查目标');

    const result = await runHealthProbe({ target });
    this.rememberHealth(service.id, result);
    this.audit(
      actor,
      'service.health',
      `service:${id}`,
      `健康探测 ${target} → ${result.state}${result.detail ? `（${result.detail}）` : ''}`,
    );

    const fresh = this.deps.repository.findById(id) ?? service;
    return { service: await this.viewOf(fresh, request), health: result };
  }

  /* ------------------------------------------------------------------ *
   * 内部：视图计算
   * ------------------------------------------------------------------ */

  /** 单个服务的视图（会重新拉一次实时容器数据；容器列表本身有 TTL 缓存）。 */
  private async viewOf(service: Service, request: HostContextRequest): Promise<ServiceView> {
    const live = await this.loadLive(request);
    const hostContext = this.buildHost(request);
    return this.buildView(service, this.deps.repository.listBindings([service.id]), live, hostContext);
  }

  /**
   * 计算一个服务的实时上下文。
   *
   * 关键点：入口与状态**每次请求都重算**，只用 DB 里的用户配置
   * （preferredUrl / healthTarget / healthPath / bindings 的稳定引用）。
   */
  private computeContext(
    service: Service,
    bindings: readonly ServiceBinding[],
    live: ContainerListResult,
    hostContext: PortalHostContext,
  ): { view: ServiceView; entries: ServiceEntry[]; container: ContainerSummary | null; serveRoutes: ServeRouteView[] } {
    const containerIds = bindings
      .filter((binding) => binding.kind === 'container' && binding.containerId)
      .map((binding) => binding.containerId as string);
    const containerNames = bindings
      .filter((binding) => binding.containerName)
      .map((binding) => binding.containerName as string);

    const container = findContainerForService({
      sourceRef: service.sourceRef,
      containerIds,
      containerNames,
      containers: live.items,
    });
    const serveRoutes = serveRoutesForService({
      bindingRefs: service.bindingRefs,
      container,
      serveRoutes: live.serve.routes,
    });
    const entries = buildServiceEntries({
      preferredUrl: service.preferredUrl,
      container,
      serveRoutes,
      hostContext,
    });
    const entry = pickEntry(entries);
    const health = this.healthResults.get(service.id) ?? null;
    const status = resolveServiceStatus({
      sourceType: service.sourceType,
      container,
      entries,
      health: health ? { state: health.state, detail: health.detail, at: health.at } : null,
      hasHealthTarget: hasHealthTarget(service),
      dockerAvailable: live.source.available,
      serveAvailable: live.serve.available,
    });

    const view: ServiceView = {
      id: service.id,
      slug: service.slug,
      displayName: service.displayName,
      description: service.description,
      icon: service.icon,
      category: service.category,
      sourceType: service.sourceType,
      sourceRef: service.sourceRef,
      bindingRefs: service.bindingRefs,
      visibility: service.visibility,
      favorite: service.favorite,
      sortOrder: service.sortOrder,
      preferredUrl: service.preferredUrl,
      entry: entry?.url ?? null,
      entries,
      entryCount: entries.length,
      status,
      container: container
        ? { id: container.id, name: container.name, state: container.state, image: container.image }
        : null,
      userEdited: service.userEdited,
      healthTarget: service.healthTarget,
      healthPath: service.healthPath,
      createdAt: service.createdAt,
      updatedAt: service.updatedAt,
    };

    return { view, entries, container, serveRoutes };
  }

  private buildView(
    service: Service,
    bindings: readonly ServiceBinding[],
    live: ContainerListResult,
    hostContext: PortalHostContext,
  ): ServiceView {
    return this.computeContext(service, bindings, live, hostContext).view;
  }

  /* ------------------------------------------------------------------ *
   * 内部：依赖与工具
   * ------------------------------------------------------------------ */

  private loadLive(request: HostContextRequest): Promise<ContainerListResult> {
    return this.deps.containers.list({ all: true, stats: false }, request);
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
      tailscaleIpv4: this.deps.tailscale.getTailscaleIpv4(),
      tailscaleDnsName: this.deps.tailscale.getTailscaleDnsName(),
    });
  }

  /** 无请求上下文时（例如后台/测试直接调 `sync()`）使用的中性主机上下文。 */
  private neutralRequest(): HostContextRequest {
    return { protocol: 'http', hostname: 'localhost', headers: {}, port: this.deps.config.port };
  }

  private groupBindings(bindings: readonly ServiceBinding[]): Map<string, ServiceBinding[]> {
    const map = new Map<string, ServiceBinding[]>();
    for (const binding of bindings) {
      const list = map.get(binding.serviceId);
      if (list) list.push(binding);
      else map.set(binding.serviceId, [binding]);
    }
    return map;
  }

  /** 取一个服务；不存在 → 404。 */
  private requireService(id: string, role: ServiceRole): Service {
    const service = this.deps.repository.findById(id);
    if (!service) throw notFound(`服务 ${id} 不存在`);
    if (service.visibility === 'hidden' && role !== 'admin') throw notFound(`服务 ${id} 不存在`);
    return service;
  }

  /** 读路径：hidden 对非 admin 等同不存在。 */
  private requireVisible(id: string, role: ServiceRole): Service {
    return this.requireService(id, role);
  }

  /** 健康结果入内存（超上限淘汰最早的一条）。 */
  private rememberHealth(serviceId: string, result: HealthProbeResult): void {
    if (!this.healthResults.has(serviceId) && this.healthResults.size >= HEALTH_RESULT_LIMIT) {
      const oldest = [...this.healthResults.entries()].sort((a, b) => a[1].at.localeCompare(b[1].at))[0];
      if (oldest) this.healthResults.delete(oldest[0]);
    }
    this.healthResults.set(serviceId, result);
  }

  /** 审计：失败只告警（写操作已经完成，不该因为审计而回滚或报 500）。 */
  private audit(actor: ServiceActor, action: string, target: string | null, detail: string): void {
    try {
      this.deps.audit.append({
        actorId: actor.userId,
        actorName: actor.username,
        action,
        target,
        detail,
        ip: actor.ip,
      });
    } catch (error) {
      this.log.warn('服务审计写入失败', { action, error });
    }
  }
}

/* ------------------------------------------------------------------ *
 * 纯辅助函数（导出以便直接单测）
 * ------------------------------------------------------------------ */

/**
 * 解析本次探测要用的目标。
 *
 * 优先级：显式覆盖 → 已保存的 `healthTarget` → `healthPath` 追加到首选入口。
 * 三者都没有（或 `healthPath` 有但没有可用入口）→ `null`，调用方据此报 400。
 */
export function resolveHealthTarget(input: {
  overrideTarget?: string | null;
  healthTarget?: string | null;
  healthPath?: string | null;
  entry?: string | null;
}): string | null {
  const override = (input.overrideTarget ?? '').trim();
  if (override !== '') return override;

  const stored = (input.healthTarget ?? '').trim();
  if (stored !== '') return stored;

  const path = (input.healthPath ?? '').trim();
  const base = (input.entry ?? '').trim();
  if (path === '' || base === '') return null;
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}

/** 服务是否配了健康检查（`health_target` 或 `health_path` 任一非空）。 */
export function hasHealthTarget(service: Pick<Service, 'healthTarget' | 'healthPath'>): boolean {
  return (service.healthTarget ?? '').trim() !== '' || (service.healthPath ?? '').trim() !== '';
}

/**
 * 校验并规范化一个可空的 http/https URL（`preferredUrl` 与 `healthTarget` 共用）。
 *
 * 刻意复用 `validateHealthTarget`：这正是 spec §4.2 的要求
 * （只允许 http/https、禁止内嵌凭据、长度上限 2048、拒绝云元数据与 Docker API 地址），
 * 这样"保存时"与"探测时"用的是同一套判定，不会出现"存得进去但探不出去"。
 */
export function cleanOptionalUrl(value: string | null | undefined, field: 'preferredUrl' | 'healthTarget'): string | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  const validation = validateHealthTarget(raw);
  if (!validation.ok) {
    const label = field === 'preferredUrl' ? '首选入口' : '健康检查目标';
    throw badRequest(`${label}不可用：${validation.message}`, { fieldErrors: { [field]: [validation.message] } });
  }
  return validation.target.url;
}

/** `healthPath` 只允许以 `/` 开头的相对路径（否则会变成一个任意的跳转目标）。 */
export function cleanHealthPath(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  if (!raw.startsWith('/')) {
    throw badRequest('健康检查路径必须以 / 开头', {
      fieldErrors: { healthPath: ['健康检查路径必须以 / 开头（例如 /healthz）'] },
    });
  }
  if (raw.length > 512) {
    throw badRequest('健康检查路径过长（上限 512 字符）', {
      fieldErrors: { healthPath: ['健康检查路径过长（上限 512 字符）'] },
    });
  }
  return raw;
}

/** 图标：内置白名单键，或 https URL（复用同一套 URL 校验，拒绝其它 scheme）。 */
export function cleanIcon(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (raw === '') return null;
  if (isBuiltinIcon(raw)) return raw;
  const validation = validateHealthTarget(raw);
  if (validation.ok && validation.target.scheme === 'https') return validation.target.url;
  throw badRequest('图标只能是内置图标键或 https:// 地址', {
    fieldErrors: { icon: ['图标只能是内置图标键（如 calendar）或 https:// 地址'] },
  });
}

/** 空串/空白 → null（"清空字段"的统一语义）。 */
export function emptyToNull(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  return raw === '' ? null : raw;
}

/** 可见性过滤：`includeHidden` 只对 admin 生效。 */
export function canSee(service: Pick<Service, 'visibility'>, role: ServiceRole, includeHidden?: boolean): boolean {
  if (service.visibility !== 'hidden') return true;
  return role === 'admin' && includeHidden === true;
}

/** 列表过滤（标题/描述/分类/入口/容器名子串；分类精确匹配）。 */
export function matchesQuery(view: ServiceView, query: ServiceListQuery): boolean {
  const needle = (query.query ?? '').trim().toLowerCase();
  if (needle !== '') {
    const haystack = [
      view.displayName,
      view.slug,
      view.description ?? '',
      view.category ?? '',
      view.sourceRef,
      view.entry ?? '',
      view.container?.name ?? '',
    ]
      .join('\n')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if (query.category !== undefined) {
    const category = (view.category ?? '').trim() || DEFAULT_CATEGORY;
    if (category !== query.category) return false;
  }
  if (query.favorite === true && !view.favorite) return false;
  return true;
}

/**
 * 去重分类，顺序 = `services` 的顺序（因为 `items` 已按 sort_order/display_name 排好）。
 * 未分类（NULL / 空串）统一显示为 `DEFAULT_CATEGORY` 并**排在最后**。
 */
export function collectCategories(items: readonly ServiceView[]): string[] {
  const named: string[] = [];
  const seen = new Set<string>();
  let hasUncategorized = false;
  for (const item of items) {
    const category = (item.category ?? '').trim();
    if (category === '') {
      hasUncategorized = true;
      continue;
    }
    if (seen.has(category)) continue;
    seen.add(category);
    named.push(category);
  }
  if (hasUncategorized) named.push(DEFAULT_CATEGORY);
  return named;
}

/** 发现状态 → HTTP 契约里的 `discovery`。 */
export function toDiscoveryState(snapshot: DiscoverySnapshot): ServiceDiscoveryState {
  return {
    dockerAvailable: snapshot.plan.dockerAvailable,
    serveAvailable: snapshot.plan.serveAvailable,
    serveDetail: snapshot.plan.serveDetail,
    discoveredAt: snapshot.discoveredAt,
    notes: snapshot.plan.notes,
  };
}

/** 审计详情里描述这次改了哪些字段（不写值，避免把 URL 之类写进日志噪声）。 */
function describePatch(fields: UserFieldPatch): string {
  const changed = Object.keys(fields);
  return changed.length === 0 ? '无字段变化' : `字段 ${changed.join('、')}`;
}