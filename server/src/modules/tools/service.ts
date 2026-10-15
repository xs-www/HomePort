/**
 * F4 工具业务服务：目录 → 入口 URL → 可用性探测，并按 TTL 缓存探测结果。
 *
 * 缓存策略：`getStaleWhileRevalidate` —— 命中过期缓存时先返回旧状态（标记 `stale: true`），
 * 后台刷新。这样页面永远秒开，探测结果最多滞后一个 TTL（默认 10s）。
 */
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { TtlCache } from '../../util/cache.js';
import { buildUrl } from '../../util/net.js';
import type { PortalHostContext } from '../docker/hostContext.js';
import { loadCatalog, type ToolDefinition } from './catalog.js';
import { probeTool, type ProbeResult } from './probe.js';
import type { SourceStatus, ToolListResult, ToolListSummary, ToolStatusView, ToolUrlCandidate, ToolView } from './types.js';

export interface ToolsServiceDeps {
  config: PortalConfig;
  logger: Logger;
}

const UNKNOWN_STATUS: ToolStatusView = {
  state: 'unknown',
  latencyMs: null,
  httpStatus: null,
  checkedAt: null,
  detail: null,
  stale: false,
};

export class ToolsService {
  private readonly deps: ToolsServiceDeps;
  private readonly log: Logger;
  private readonly probeCache: TtlCache<ProbeResult>;

  constructor(deps: ToolsServiceDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ mod: 'tools' });
    this.probeCache = new TtlCache<ProbeResult>({
      ttlMs: deps.config.tools.probeTtlMs,
      maxEntries: 64,
      logger: this.log,
    });
  }

  /** 当前工具目录（每次调用重新读文件，便于用户改完 JSON 后刷新即可生效）。 */
  getCatalog(): { tools: ToolDefinition[]; warnings: string[] } {
    const { tools, warnings } = loadCatalog(this.deps.config, this.log);
    return { tools, warnings };
  }

  /**
   * 列出工具（含可选的可用性探测）。
   *
   * @param options.probe 是否探测；false 时秒返回静态目录
   * @param options.category 分类过滤
   * @param options.role 当前用户角色（过滤 visibleTo）
   * @param hostContext 门户对外主机上下文
   */
  async list(
    options: { probe: boolean; category?: string; role: 'admin' | 'viewer' },
    hostContext: PortalHostContext,
  ): Promise<ToolListResult> {
    const { tools, warnings } = this.getCatalog();
    const visible = tools.filter((tool) => tool.visibleTo.includes(options.role));
    const filtered = options.category ? visible.filter((tool) => tool.category === options.category) : visible;

    const items = await Promise.all(
      filtered.map(async (tool) => this.buildView(tool, hostContext, options.probe)),
    );

    return {
      items,
      summary: summarizeTools(items),
      warnings,
      source: { available: true, mode: 'catalog', detail: null },
    };
  }

  /** 单个工具视图（强制刷新探测）。 */
  async getOne(id: string, hostContext: PortalHostContext): Promise<ToolView | null> {
    const { tools } = this.getCatalog();
    const tool = tools.find((t) => t.id === id);
    if (!tool) return null;
    this.probeCache.delete(this.probeKey(tool, hostContext));
    return this.buildView(tool, hostContext, true);
  }

  /** 列出分类（前端做筛选器用）。 */
  categories(): string[] {
    const { tools } = this.getCatalog();
    return [...new Set(tools.map((tool) => tool.category))].sort();
  }

  private probeKey(tool: ToolDefinition, hostContext: PortalHostContext): string {
    return `${tool.id}:${hostContext.primaryHost}:${tool.port ?? 0}`;
  }

  private async buildView(tool: ToolDefinition, hostContext: PortalHostContext, probe: boolean): Promise<ToolView> {
    const urls = buildToolUrls(tool, hostContext);
    const status = probe ? await this.probe(tool, hostContext) : { ...UNKNOWN_STATUS };

    return {
      id: tool.id,
      name: tool.name,
      category: tool.category,
      icon: tool.icon,
      description: tool.description,
      url: urls.primary,
      urlCandidates: urls.candidates,
      exposed: tool.port !== null,
      hostPort: tool.port,
      deepLink: urls.deepLink,
      status,
      hint: tool.hint,
      featured: tool.featured,
      order: tool.order,
    };
  }

  /** 探测（带缓存与后台刷新）。 */
  private async probe(tool: ToolDefinition, hostContext: PortalHostContext): Promise<ToolStatusView> {
    if (tool.port === null) {
      return { ...UNKNOWN_STATUS, detail: '未配置宿主端口，无法探测' };
    }
    const key = this.probeKey(tool, hostContext);
    const { value, stale } = await this.probeCache.getStaleWhileRevalidate(
      key,
      () =>
        probeTool({
          host: hostContext.primaryHost,
          port: tool.port as number,
          scheme: tool.scheme,
          probePath: tool.probePath,
          expectedStatus: tool.expectedStatus,
          timeoutMs: this.deps.config.tools.probeTimeoutMs,
          fallbackHost: hostContext.primaryHost === '127.0.0.1' ? null : '127.0.0.1',
          logger: this.log,
        }),
      this.deps.config.tools.probeTtlMs,
    );

    if (!value) return { ...UNKNOWN_STATUS };
    return {
      state: value.state,
      latencyMs: value.latencyMs,
      httpStatus: value.httpStatus,
      checkedAt: value.checkedAt,
      detail: value.detail,
      stale,
    };
  }
}

export interface ToolUrls {
  primary: string | null;
  candidates: ToolUrlCandidate[];
  deepLink: { label: string; url: string } | null;
}

/**
 * 为工具生成入口 URL。
 *
 * 主入口使用 hostContext 的首选主机（与容器入口保持一致的策略）；
 * 候选列表覆盖 MagicDNS / tailnet IP / localhost，便于用户换网络环境时切换。
 */
export function buildToolUrls(tool: ToolDefinition, hostContext: PortalHostContext): ToolUrls {
  if (tool.port === null) return { primary: null, candidates: [], deepLink: null };

  const candidates: ToolUrlCandidate[] = [];
  const seen = new Set<string>();
  for (const candidate of hostContext.candidates) {
    const url = buildUrl({ scheme: tool.scheme, host: candidate.host, port: tool.port, path: tool.deepLinkPath });
    if (!url || seen.has(url)) continue;
    seen.add(url);
    candidates.push({ label: candidate.label, url, ...(candidate.display ? { display: candidate.display } : {}) });
  }

  const primary = buildUrl({
    scheme: tool.scheme,
    host: hostContext.primaryHost,
    port: tool.port,
    path: tool.deepLinkPath,
  });

  const deepLinkUrl = buildUrl({
    scheme: tool.scheme,
    host: hostContext.primaryHost,
    port: tool.port,
    path: tool.deepLinkPath,
  });

  return {
    primary,
    candidates,
    deepLink: deepLinkUrl ? { label: tool.name, url: deepLinkUrl } : null,
  };
}

/** 汇总工具状态计数。 */
export function summarizeTools(items: readonly ToolView[]): ToolListSummary {
  let up = 0;
  let down = 0;
  let unknown = 0;
  for (const item of items) {
    if (item.status.state === 'up') up += 1;
    else if (item.status.state === 'down') down += 1;
    else unknown += 1;
  }
  return { total: items.length, up, down, unknown };
}
