/**
 * F4 工具目录（catalog）与用户自定义覆盖。
 *
 * 目录内置了常见本机工具（Ollama / DSH / ComfyUI / …）的默认端口与健康检查路径。
 * 用户可以：
 * 1. 用 `PORTAL_TOOLS_FILE` 挂载一份 JSON 来做增删改；
 * 2. 用 `PORTAL_TOOLS_EXTRA="id:名称:端口"` 快速追加。
 *
 * JSON 文件结构：
 * ```json
 * {
 *   "replace": false,
 *   "tools": [
 *     { "id": "jellyfin", "name": "Jellyfin", "port": 8096, "category": "media",
 *       "probePath": "/health", "deepLinkPath": "/web/", "description": "媒体服务器" },
 *     { "id": "ollama", "port": 11435 }
 *   ]
 * }
 * ```
 * `replace: true` 表示完全以文件内容替代内置目录；默认 `false` 表示按 `id` 合并/追加。
 */
import fs from 'node:fs';
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';

export type ToolCategory = 'ai' | 'dev' | 'media' | 'storage' | 'monitor' | 'other';

export interface ToolDefinition {
  id: string;
  name: string;
  category: ToolCategory;
  /** 宿主端口；null 表示未设置（工具将无法探测） */
  port: number | null;
  /** 健康检查路径（相对根） */
  probePath: string;
  /** 期望的 HTTP 状态码；null 表示任意 <500 都算可用 */
  expectedStatus: number | null;
  /** 深度链接路径（如 ComfyUI 的 `/`、Jellyfin 的 `/web/`） */
  deepLinkPath: string;
  /** 展示用图标标识（前端映射到内联 SVG） */
  icon: string;
  description: string;
  /** 协议：http 或 https */
  scheme: 'http' | 'https';
  /** 是否在概览页突出显示 */
  featured: boolean;
  /** 最低可见角色 */
  visibleTo: Array<'admin' | 'viewer'>;
  /** 排序权重（越小越靠前） */
  order: number;
  /** 附加提示（如"需要先启动 ollama serve"） */
  hint: string | null;
}

const ALL_ROLES: Array<'admin' | 'viewer'> = ['admin', 'viewer'];

function defineTool(
  partial: Pick<ToolDefinition, 'id' | 'name' | 'port'> & Partial<Omit<ToolDefinition, 'id' | 'name' | 'port'>>,
): ToolDefinition {
  return {
    category: 'other',
    probePath: '/',
    expectedStatus: null,
    deepLinkPath: '/',
    icon: 'generic',
    description: '',
    scheme: 'http',
    featured: false,
    visibleTo: ALL_ROLES,
    order: 100,
    hint: null,
    ...partial,
  };
}

/** 内置工具目录。 */
export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  defineTool({
    id: 'ollama',
    name: 'Ollama',
    category: 'ai',
    port: 11434,
    probePath: '/api/version',
    deepLinkPath: '/',
    icon: 'ollama',
    description: '本地大模型推理服务，提供 OpenAI 兼容 API',
    featured: true,
    order: 10,
    hint: '纯 API 服务，无网页界面；可在 DSH 或其它客户端中配置为模型后端',
  }),
  defineTool({
    id: 'dsh',
    name: 'DSH',
    category: 'ai',
    port: 3080,
    probePath: '/',
    deepLinkPath: '/',
    icon: 'dsh',
    description: 'DeepSeek Harness 控制台（本机开发/代理入口）',
    featured: true,
    order: 20,
  }),
  defineTool({
    id: 'comfyui',
    name: 'ComfyUI',
    category: 'ai',
    port: 8188,
    probePath: '/',
    deepLinkPath: '/',
    icon: 'comfyui',
    description: '节点式 AI 绘图工作流',
    featured: true,
    order: 30,
  }),
  defineTool({
    id: 'open-webui',
    name: 'Open WebUI',
    category: 'ai',
    port: 3001,
    probePath: '/health',
    deepLinkPath: '/',
    icon: 'chat',
    description: 'ChatGPT 风格的本地模型对话界面（常与 Ollama 搭配）',
    order: 40,
  }),
  defineTool({
    id: 'portainer',
    name: 'Portainer',
    category: 'dev',
    port: 9000,
    probePath: '/api/status',
    deepLinkPath: '/',
    icon: 'container',
    description: 'Docker 可视化管理界面',
    order: 50,
  }),
  defineTool({
    id: 'jellyfin',
    name: 'Jellyfin',
    category: 'media',
    port: 8096,
    probePath: '/health',
    deepLinkPath: '/web/',
    icon: 'media',
    description: '开源媒体服务器',
    order: 60,
  }),
  defineTool({
    id: 'qbit',
    name: 'qBittorrent',
    category: 'media',
    port: 8081,
    probePath: '/api/v2/app/version',
    deepLinkPath: '/',
    icon: 'download',
    description: 'BT 下载管理',
    order: 70,
  }),
  defineTool({
    id: 'code-server',
    name: 'code-server',
    category: 'dev',
    port: 8443,
    probePath: '/healthz',
    deepLinkPath: '/',
    icon: 'code',
    description: '浏览器中的 VS Code',
    order: 80,
  }),
];

/** 文件覆盖配置结构。 */
export interface ToolsFileConfig {
  replace?: boolean;
  tools?: Array<Partial<ToolDefinition> & { id: string }>;
}

export interface LoadCatalogResult {
  tools: ToolDefinition[];
  /** 加载过程中的问题（非致命），用于 UI 提示 */
  warnings: string[];
}

/** 校验并补全目录项。 */
export function normalizeTool(raw: Partial<ToolDefinition> & { id: string }, warnings: string[], source: string): ToolDefinition | null {
  const id = String(raw.id ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/i.test(id)) {
    warnings.push(`${source}：工具 id "${raw.id}" 非法（只允许字母数字与短横线）`);
    return null;
  }
  const port = raw.port === null ? null : Number(raw.port);
  if (port !== null && (!Number.isInteger(port) || port <= 0 || port > 65535)) {
    warnings.push(`${source}：工具 ${id} 的 port 非法`);
    return null;
  }
  const base = defineTool({
    id,
    name: String(raw.name ?? id),
    port,
  });
  const merged: ToolDefinition = {
    ...base,
    ...raw,
    id,
    port,
    name: String(raw.name ?? base.name),
    visibleTo: (raw.visibleTo ?? base.visibleTo).filter((r): r is 'admin' | 'viewer' => r === 'admin' || r === 'viewer'),
  };
  if (merged.visibleTo.length === 0) merged.visibleTo = ALL_ROLES;
  if (!merged.probePath.startsWith('/')) merged.probePath = `/${merged.probePath}`;
  if (!merged.deepLinkPath.startsWith('/')) merged.deepLinkPath = `/${merged.deepLinkPath}`;
  return merged;
}

/** 解析 `PORTAL_TOOLS_EXTRA` 的 `id:名称:端口` 条目。 */
export function parseExtraTools(entries: readonly string[], warnings: string[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const entry of entries) {
    const parts = entry.split(':').map((p) => p.trim());
    const [id, name, portStr] = parts;
    if (!id || !portStr) {
      warnings.push(`PORTAL_TOOLS_EXTRA 条目 "${entry}" 非法，应为 id:名称:端口`);
      continue;
    }
    const port = Number(portStr);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      warnings.push(`PORTAL_TOOLS_EXTRA 条目 "${entry}" 的端口非法`);
      continue;
    }
    const normalized = normalizeTool(
      { id, name: name || id, port, category: 'other', description: '通过 PORTAL_TOOLS_EXTRA 自定义' },
      warnings,
      'PORTAL_TOOLS_EXTRA',
    );
    if (normalized) out.push(normalized);
  }
  return out;
}

/**
 * 加载最终工具目录：内置 → 文件合并/替换 → 额外条目。
 *
 * 合并规则：按 `id` 匹配，文件中的字段覆盖内置字段（未提供的字段保留内置值）。
 */
export function loadCatalog(config: PortalConfig, logger: Logger): LoadCatalogResult {
  const warnings: string[] = [];
  let tools: ToolDefinition[] = BUILTIN_TOOLS.map((tool) => ({ ...tool, visibleTo: [...tool.visibleTo] }));

  const catalogFile = config.tools.catalogFile;
  if (catalogFile) {
    try {
      const content = fs.readFileSync(catalogFile, 'utf8');
      const parsed = JSON.parse(content) as ToolsFileConfig;
      const entries = Array.isArray(parsed.tools) ? parsed.tools : [];
      if (parsed.replace === true) {
        const replaced: ToolDefinition[] = [];
        for (const entry of entries) {
          const normalized = normalizeTool(entry, warnings, catalogFile);
          if (normalized) replaced.push(normalized);
        }
        tools = replaced;
      } else {
        for (const entry of entries) {
          const normalized = normalizeTool(entry, warnings, catalogFile);
          if (!normalized) continue;
          const index = tools.findIndex((tool) => tool.id === normalized.id);
          if (index === -1) {
            tools.push(normalized);
          } else {
            const existing = tools[index];
            tools[index] = existing
              ? { ...existing, ...entry, id: normalized.id, port: normalized.port, visibleTo: normalized.visibleTo }
              : normalized;
          }
        }
      }
      logger.info('已加载自定义工具目录', { file: catalogFile, count: tools.length, replace: parsed.replace === true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`读取工具目录文件失败（${catalogFile}）：${message}`);
      logger.warn('工具目录文件读取失败，回退到内置目录', { error, file: catalogFile });
    }
  }

  tools.push(...parseExtraTools(config.tools.extra, warnings));
  tools.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'zh-Hans-CN'));

  return { tools, warnings };
}
