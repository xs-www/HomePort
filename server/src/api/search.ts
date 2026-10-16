/**
 * 聚合搜索路由：`GET /api/search?q=&limit=`（spec §4.3）。
 *
 * 两条不可动摇的规则：
 * 1. **只索引调用者有权查看的内容** —— 服务走 `ServiceRegistryService.list`（按角色过滤），
 *    容器/设备沿用现有只读权限，工具按现有 `visibleTo`；设置 / 用户 / 审计 / Token
 *    **一律不进索引**（这里连它们的数据源都不 import）。
 * 2. **搜索不产生副作用** —— 工具探测用 `probe: false`（搜索框每敲一个字就发一次 HTTP 探测
 *    是不可接受的），容器与设备也都走各自的既有缓存。
 *
 * 匹配规则（纯函数，见 `buildSearchHits`）：标题与 keywords 的大小写不敏感**子串**匹配；
 * 分组顺序 服务 → 容器 → 设备 → 工具，同组内"标题命中"排在"keywords 命中"之前。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../http/guards.js';
import { parseOrThrow, searchQuerySchema } from '../http/schemas.js';
import { buildHostContext } from '../modules/docker/hostContext.js';
import type { ContainerSummary } from '../modules/docker/types.js';
import type { TailnetDevice } from '../modules/tailscale/types.js';
import type { ToolView } from '../modules/tools/types.js';
import { DEFAULT_CATEGORY } from '../modules/services/registry.js';
import type { ServiceSearchHit, ServiceSearchKind, ServiceSearchResponse, ServiceView } from '../modules/services/types.js';
import type { RouteContext } from './context.js';
import { toHostContextRequest } from './context.js';

/** 默认返回条数。 */
export const SEARCH_DEFAULT_LIMIT = 8;
/** 上限（再多也没人看，且会让前端弹层滚动成负担）。 */
export const SEARCH_MAX_LIMIT = 20;

/** 分组顺序：服务 → 容器 → 设备 → 工具。 */
const KIND_ORDER: Record<ServiceSearchKind, number> = { service: 0, container: 1, device: 2, tool: 3 };

/** 搜索索引的输入（四类内容，已经各自按角色过滤过）。 */
export interface SearchIndexInput {
  services: readonly ServiceView[];
  containers: readonly ContainerSummary[];
  devices: readonly TailnetDevice[];
  tools: readonly ToolView[];
}

interface ScoredHit {
  hit: ServiceSearchHit;
  /** 标题命中优先于 keywords 命中 */
  titleHit: boolean;
}

/**
 * 构建搜索结果（**纯函数**，路由只负责取数与鉴权）。
 *
 * @param index 已按角色过滤的四类内容
 * @param query 关键词（调用方保证非空；空串直接返回空数组而不是全量）
 * @param limit 返回条数上限
 */
export function buildSearchHits(index: SearchIndexInput, query: string, limit: number): ServiceSearchHit[] {
  const needle = query.trim().toLowerCase();
  if (needle === '' || limit <= 0) return [];

  const scored: ScoredHit[] = [];
  const push = (hit: ServiceSearchHit, titleHit: boolean): void => {
    scored.push({ hit, titleHit });
  };

  for (const service of index.services) {
    const keywords = [
      service.slug,
      service.sourceRef,
      service.sourceType,
      service.category ?? '',
      service.container?.name ?? '',
      service.container?.image ?? '',
    ].filter((keyword) => keyword !== '');
    const titleHit = includes(service.displayName, needle);
    if (!titleHit && !keywords.some((keyword) => includes(keyword, needle))) continue;
    push(
      {
        kind: 'service',
        id: service.id,
        title: service.displayName,
        subtitle: serviceSubtitle(service),
        url: service.entry,
        keywords,
      },
      titleHit,
    );
  }

  for (const container of index.containers) {
    const keywords = [
      container.image,
      container.shortId,
      container.composeProject ?? '',
      container.composeService ?? '',
      ...container.ports.map((port) => (port.hostPort === null ? '' : String(port.hostPort))),
    ].filter((keyword) => keyword !== '');
    const titleHit = includes(container.name, needle);
    if (!titleHit && !keywords.some((keyword) => includes(keyword, needle))) continue;
    push(
      {
        kind: 'container',
        id: container.id,
        title: container.name,
        subtitle: `${container.state} · ${container.image}`,
        url: container.primaryUrl,
        keywords,
      },
      titleHit,
    );
  }

  for (const device of index.devices) {
    const keywords = [device.dnsName, device.ipv4 ?? '', device.ipv6 ?? '', device.os, ...device.tags].filter(
      (keyword) => keyword !== '',
    );
    const titleHit = includes(device.hostname, needle);
    if (!titleHit && !keywords.some((keyword) => includes(keyword, needle))) continue;
    push(
      {
        kind: 'device',
        id: device.id,
        title: device.hostname,
        subtitle: `${device.os} · ${device.online ? '在线' : '离线'}`,
        // 设备没有"可点击入口"：给一个 URL 会诱导用户点开一个打不开的地址
        url: null,
        keywords,
      },
      titleHit,
    );
  }

  for (const tool of index.tools) {
    const keywords = [tool.id, tool.category, tool.description, String(tool.hostPort ?? '')].filter(
      (keyword) => keyword !== '',
    );
    const titleHit = includes(tool.name, needle);
    if (!titleHit && !keywords.some((keyword) => includes(keyword, needle))) continue;
    push(
      {
        kind: 'tool',
        id: tool.id,
        title: tool.name,
        subtitle: tool.status.state === 'unknown' ? tool.category : `${tool.category} · ${toolStatusLabel(tool.status.state)}`,
        url: tool.url,
        keywords,
      },
      titleHit,
    );
  }

  return dedupe(scored)
    .sort(
      (a, b) =>
        KIND_ORDER[a.hit.kind] - KIND_ORDER[b.hit.kind] ||
        (a.titleHit === b.titleHit ? 0 : a.titleHit ? -1 : 1) ||
        a.hit.title.localeCompare(b.hit.title),
    )
    .slice(0, limit)
    .map((item) => item.hit);
}

export function registerSearchRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** 聚合搜索（服务 / 容器 / 设备 / 工具）。 */
  app.get('/', async (request) => {
    const session = requireAuth(request);
    const query = parseOrThrow(searchQuerySchema, request.query, '搜索参数');
    const limit = Math.min(query.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
    const hostRequest = toHostContextRequest(request);
    const hostContext = buildHostContext({
      config: ctx.config,
      request: hostRequest,
      tailscaleIpv4: ctx.tailscale.getTailscaleIpv4(),
      tailscaleDnsName: ctx.tailscale.getTailscaleDnsName(),
    });

    // 四个数据源互不依赖：任何一个失败都不该让搜索整体 500（降级为空结果即可）
    const [services, containers, status, tools] = await Promise.allSettled([
      ctx.services.list(hostRequest, { includeHidden: session.user.role === 'admin' }, session.user.role),
      ctx.containers.list({ all: true, stats: false }, hostRequest),
      ctx.tailscale.getStatus(),
      ctx.tools.list({ probe: false, role: session.user.role }, hostContext),
    ]);

    if (services.status === 'rejected') ctx.logger.warn('搜索：服务索引不可用', { error: services.reason });
    if (containers.status === 'rejected') ctx.logger.warn('搜索：容器索引不可用', { error: containers.reason });
    if (status.status === 'rejected') ctx.logger.warn('搜索：设备索引不可用', { error: status.reason });
    if (tools.status === 'rejected') ctx.logger.warn('搜索：工具索引不可用', { error: tools.reason });

    const devices: TailnetDevice[] =
      status.status === 'fulfilled'
        ? [...(status.value.self ? [status.value.self] : []), ...status.value.peers]
        : [];

    const response: ServiceSearchResponse = {
      items: buildSearchHits(
        {
          services: services.status === 'fulfilled' ? services.value.items : [],
          containers: containers.status === 'fulfilled' ? containers.value.items : [],
          devices,
          tools: tools.status === 'fulfilled' ? tools.value.items : [],
        },
        query.q,
        limit,
      ),
      query: query.q,
    };
    return response;
  });
}

function includes(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle);
}

/** 副标题与 spec §4.3 的示例一致：`家庭 · Serve HTTPS`。 */
function serviceSubtitle(service: ServiceView): string {
  const parts = [(service.category ?? '').trim() || DEFAULT_CATEGORY];
  const entry = service.entries.find((candidate) => candidate.url === service.entry);
  if (entry) parts.push(entry.label);
  return parts.join(' · ');
}

function toolStatusLabel(state: ToolView['status']['state']): string {
  if (state === 'up') return '可用';
  if (state === 'down') return '不可用';
  return '未知';
}

/** 同一 `kind:id` 只保留第一条（避免同源数据被索引两次）。 */
function dedupe(items: readonly ScoredHit[]): ScoredHit[] {
  const seen = new Set<string>();
  const out: ScoredHit[] = [];
  for (const item of items) {
    const key = `${item.hit.kind}:${item.hit.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}