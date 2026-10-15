/**
 * F4 工具模块的应用层类型（HTTP 契约见 docs/static/04-api-contract.md §6）。
 */
import type { ProbeState } from './probe.js';

export interface SourceStatus {
  available: boolean;
  mode: string;
  detail: string | null;
}

export interface ToolStatusView {
  state: ProbeState;
  latencyMs: number | null;
  httpStatus: number | null;
  checkedAt: string | null;
  detail: string | null;
  /** 是否来自过期缓存（正在后台刷新） */
  stale: boolean;
}

export interface ToolUrlCandidate {
  label: 'tailnet' | 'magicdns' | 'localhost' | 'lan' | 'custom';
  url: string;
  display?: string;
}

export interface ToolView {
  id: string;
  name: string;
  category: string;
  icon: string;
  description: string;
  /** 首选入口 URL；未配置端口时为 null */
  url: string | null;
  urlCandidates: ToolUrlCandidate[];
  /** 是否配置了宿主端口 */
  exposed: boolean;
  hostPort: number | null;
  /** 深度链接（与 url 可能不同，如 Jellyfin 的 /web/） */
  deepLink: { label: string; url: string } | null;
  status: ToolStatusView;
  hint: string | null;
  featured: boolean;
  order: number;
}

export interface ToolListSummary {
  total: number;
  up: number;
  down: number;
  unknown: number;
}

export interface ToolListResult {
  items: ToolView[];
  summary: ToolListSummary;
  warnings: string[];
  source: SourceStatus;
}
