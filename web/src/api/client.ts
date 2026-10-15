/**
 * 类型化 API 客户端。
 *
 * 职责：
 * 1. 统一 `fetch`：`credentials: 'same-origin'`、JSON 编解码、超时。
 * 2. **CSRF**：变更类请求自动附加 `X-CSRF-Token`（由 AuthProvider 注入）。
 * 3. 把后端的 `{ error: { code, message, details } }` 转成 `ApiError` 抛出，
 *    页面只需 `catch (e) { e.message }` 就能展示中文提示。
 * 4. 401 时触发全局"会话失效"回调（AuthProvider 借此跳转登录页）。
 */

import type {
  AuditListResponse,
  ContainerDetailResponse,
  ContainerListResponse,
  ContainerLogsResponse,
  HealthResponse,
  LoginResponse,
  MeResponse,
  OverviewResponse,
  SessionActivity,
  SessionUser,
  SessionView,
  SystemSnapshotResponse,
  TailnetStatusLite,
  TailnetStatusResponse,
  ToolListResponse,
  ToolView,
  UserListResponse,
  UserPreferences,
} from './types.js';

/** 请求失败时抛出的错误。 */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, code: string, status: number, details: unknown = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** 取字段级错误（表单直接使用）。 */
  get fieldErrors(): Record<string, string[]> {
    const details = this.details;
    if (details && typeof details === 'object' && 'fieldErrors' in details) {
      const raw = (details as { fieldErrors?: unknown }).fieldErrors;
      if (raw && typeof raw === 'object') return raw as Record<string, string[]>;
    }
    return {};
  }
}

export interface ApiClientOptions {
  baseUrl?: string;
  /** 默认请求超时（ms） */
  timeoutMs?: number;
  /** 提供 CSRF 令牌 */
  getCsrfToken?: () => string | null;
  /** 收到 401 时调用 */
  onUnauthorized?: () => void;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined | null>;
  timeoutMs?: number;
  /** 跳过 401 回调（如登录请求本身） */
  skipUnauthorizedHandler?: boolean;
  signal?: AbortSignal;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** 指标采集等较慢接口使用更长的超时。 */
const SLOW_TIMEOUT_MS = 45_000;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly getCsrfToken: () => string | null;
  private readonly onUnauthorized: () => void;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '/api').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.getCsrfToken = options.getCsrfToken ?? (() => null);
    this.onUnauthorized = options.onUnauthorized ?? (() => {});
  }

  /** 底层请求。 */
  private async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const method = options.method ?? 'GET';
    const url = this.buildUrl(path, options.query);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? this.timeoutMs);
    // 外部 signal 与内部超时信号合并
    const onExternalAbort = (): void => controller.abort();
    options.signal?.addEventListener('abort', onExternalAbort);

    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    const isMutating = method !== 'GET';
    if (isMutating) {
      const csrf = this.getCsrfToken();
      if (csrf) headers['x-csrf-token'] = csrf;
    }

    try {
      const response = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        signal: controller.signal,
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      });

      if (response.status === 204) return undefined as T;

      const text = await response.text();
      const payload: unknown = text === '' ? null : safeJsonParse(text);

      if (!response.ok) {
        const error = toApiError(payload, response.status);
        if (response.status === 401 && !options.skipUnauthorizedHandler) this.onUnauthorized();
        throw error;
      }

      return payload as T;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new ApiError('请求超时或已取消', 'TIMEOUT', 0);
      }
      throw new ApiError(
        error instanceof Error ? `网络请求失败：${error.message}` : '网络请求失败',
        'NETWORK_ERROR',
        0,
      );
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  private buildUrl(path: string, query?: RequestOptions['query']): string {
    const base = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    if (!query) return base;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    return qs === '' ? base : `${base}?${qs}`;
  }

  // ------------------------------------------------------------ 健康检查

  health(): Promise<HealthResponse> {
    return this.request<HealthResponse>('/health', { skipUnauthorizedHandler: true });
  }

  // ------------------------------------------------------------ 认证

  session(): Promise<SessionView> {
    return this.request<SessionView>('/auth/session', { skipUnauthorizedHandler: true });
  }

  login(input: { username: string; password: string; remember: boolean }): Promise<LoginResponse> {
    return this.request<LoginResponse>('/auth/login', {
      method: 'POST',
      body: input,
      skipUnauthorizedHandler: true,
    });
  }

  logout(): Promise<void> {
    return this.request<void>('/auth/logout', { method: 'POST' });
  }

  bootstrap(input: { token: string; username: string; password: string; displayName: string }): Promise<{ user: SessionUser }> {
    return this.request<{ user: SessionUser }>('/auth/bootstrap', {
      method: 'POST',
      body: input,
      skipUnauthorizedHandler: true,
    });
  }

  changePassword(input: { currentPassword: string; newPassword: string }): Promise<void> {
    return this.request<void>('/auth/password', { method: 'POST', body: input });
  }

  sessionActivity(): Promise<SessionActivity> {
    return this.request<SessionActivity>('/auth/session/activity');
  }

  // ------------------------------------------------------------ 概览

  overview(): Promise<OverviewResponse> {
    return this.request<OverviewResponse>('/overview', { timeoutMs: SLOW_TIMEOUT_MS });
  }

  // ------------------------------------------------------------ 容器

  containers(params: { all?: boolean; stats?: boolean; reachability?: string; q?: string } = {}): Promise<ContainerListResponse> {
    return this.request<ContainerListResponse>('/containers', {
      query: {
        all: params.all === undefined ? undefined : params.all ? '1' : '0',
        stats: params.stats ? '1' : undefined,
        reachability: params.reachability,
        q: params.q,
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  container(id: string): Promise<ContainerDetailResponse> {
    return this.request<ContainerDetailResponse>(`/containers/${encodeURIComponent(id)}`, {
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  containerLogs(id: string, tail = 200): Promise<ContainerLogsResponse> {
    return this.request<ContainerLogsResponse>(`/containers/${encodeURIComponent(id)}/logs`, {
      query: { tail },
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  // ------------------------------------------------------------ tailnet

  tailnetDevices(refresh = false): Promise<TailnetStatusResponse> {
    return this.request<TailnetStatusResponse>('/tailscale/devices', {
      query: refresh ? { refresh: '1' } : undefined,
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  tailnetStatus(): Promise<TailnetStatusLite> {
    return this.request<TailnetStatusLite>('/tailscale/status');
  }

  // ------------------------------------------------------------ 系统

  systemSnapshot(): Promise<SystemSnapshotResponse> {
    return this.request<SystemSnapshotResponse>('/system/snapshot', { timeoutMs: SLOW_TIMEOUT_MS });
  }

  // ------------------------------------------------------------ 工具

  tools(params: { probe?: boolean; category?: string } = {}): Promise<ToolListResponse> {
    return this.request<ToolListResponse>('/tools', {
      query: {
        probe: params.probe === false ? '0' : undefined,
        category: params.category,
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  probeTool(id: string): Promise<{ tool: ToolView }> {
    return this.request<{ tool: ToolView }>(`/tools/${encodeURIComponent(id)}/probe`, {
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  // ------------------------------------------------------------ 用户

  me(): Promise<MeResponse> {
    return this.request<MeResponse>('/users/me');
  }

  updatePreferences(input: Partial<Pick<UserPreferences, 'theme' | 'density' | 'defaultPage'>>): Promise<{ preferences: UserPreferences }> {
    return this.request<{ preferences: UserPreferences }>('/users/me/preferences', {
      method: 'PATCH',
      body: input,
    });
  }

  users(): Promise<UserListResponse> {
    return this.request<UserListResponse>('/users');
  }

  createUser(input: { username: string; password: string; displayName: string; role: 'admin' | 'viewer' }): Promise<{ user: SessionUser }> {
    return this.request<{ user: SessionUser }>('/users', { method: 'POST', body: input });
  }

  updateUser(id: number, input: { displayName?: string; role?: 'admin' | 'viewer'; disabled?: boolean }): Promise<{ user: SessionUser }> {
    return this.request<{ user: SessionUser }>(`/users/${id}`, { method: 'PATCH', body: input });
  }

  deleteUser(id: number): Promise<void> {
    return this.request<void>(`/users/${id}`, { method: 'DELETE' });
  }

  resetUserPassword(id: number, newPassword: string): Promise<{ revoked: number }> {
    return this.request<{ revoked: number }>(`/users/${id}/password`, {
      method: 'POST',
      body: { newPassword },
    });
  }

  revokeUserSessions(id: number): Promise<{ revoked: number }> {
    return this.request<{ revoked: number }>(`/users/${id}/sessions/revoke`, { method: 'POST' });
  }

  auditLog(limit = 100): Promise<AuditListResponse> {
    return this.request<AuditListResponse>('/users/audit/log', { query: { limit } });
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把后端错误体转成 ApiError；无法识别时按状态码给兜底文案。 */
export function toApiError(payload: unknown, status: number): ApiError {
  if (payload && typeof payload === 'object' && 'error' in payload) {
    const raw = (payload as { error?: unknown }).error;
    if (raw && typeof raw === 'object') {
      const code = String((raw as { code?: unknown }).code ?? 'INTERNAL');
      const message = String((raw as { message?: unknown }).message ?? '请求失败');
      const details = (raw as { details?: unknown }).details ?? null;
      return new ApiError(message, code, status, details);
    }
  }
  const fallback: Record<number, string> = {
    400: '请求参数不合法',
    401: '未登录或会话已过期',
    403: '权限不足',
    404: '资源不存在',
    409: '操作冲突',
    429: '操作过于频繁，请稍后再试',
    500: '服务器内部错误',
    503: '依赖服务不可用',
  };
  return new ApiError(fallback[status] ?? `请求失败（HTTP ${status}）`, 'UNKNOWN', status);
}

/** 单例（AuthProvider 会在挂载时注入 CSRF 与 401 回调）。 */
export const api = new ApiClient();
