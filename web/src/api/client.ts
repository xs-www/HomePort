/**
 * 类型化 API 客户端。
 *
 * 职责：
 * 1. 统一 `fetch`：`credentials: 'same-origin'`、JSON 编解码、超时。
 * 2. **CSRF**：变更类请求自动附加 `X-CSRF-Token`（由 AuthProvider 注入）。
 * 3. 把后端的 `{ error: { code, message, details } }` 转成 `ApiError` 抛出，
 *    页面只需 `catch (e) { e.message }` 就能展示中文提示。
 * 4. 401 时触发全局"会话失效"回调（AuthProvider 借此跳转登录页）。
 * 5. 401 的语义细分：`TOTP_INVALID` / `TOTP_CHALLENGE_EXPIRED` / `INVALID_CREDENTIALS`
 *    表示"凭据或验证码不对"而非"会话失效"，这类 401 **不触发**全局登出回调
 *    （否则用户输错一次验证码就会被踢回登录页）；真正的会话失效仍是 `UNAUTHORIZED`。
 *    登录/登录第二步这类"建立会话之前"的请求另用 `skipUnauthorizedHandler` 显式跳过。
 */

import type {
  AuditListResponse,
  ContainerDetailResponse,
  ContainerListResponse,
  ContainerLogsResponse,
  HealthResponse,
  LoginResponse,
  LoginTotpRequest,
  LoginTotpResponse,
  MeResponse,
  OverviewResponse,
  RecoveryCodesResponse,
  ResetSettingsResponse,
  ServiceCreateRequest,
  ServiceDeleteResponse,
  ServiceDetailResponse,
  ServiceHealthResponse,
  ServiceListParams,
  ServiceListResponse,
  ServiceSearchResponse,
  ServiceUpdateRequest,
  ServiceView,
  SessionActivity,
  SessionUser,
  SessionView,
  SettingsResponse,
  SystemSnapshotResponse,
  TailnetStatusLite,
  TailnetStatusResponse,
  TailscaleTestResponse,
  ToolListResponse,
  ToolView,
  TotpDisableRequest,
  TotpDisableResponse,
  TotpEnableRequest,
  TotpEnableResponse,
  TotpRecoveryCodesRequest,
  TotpResetResponse,
  TotpSetupResponse,
  UpdateSettingsResponse,
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

/**
 * 表示"这次提交的凭据/验证码不对"的 401 错误码 —— 它们**不是**会话失效。
 *
 * 若不排除，用户只是输错一次 TOTP 验证码（或当前密码）就会被全局登出，
 * 与"就地重试"的产品预期完全相反。排除后，真正的会话失效仍然返回
 * `UNAUTHORIZED`，照旧触发 `onUnauthorized` 跳登录页。
 */
const CREDENTIAL_FAILURE_CODES = new Set(['TOTP_INVALID', 'TOTP_CHALLENGE_EXPIRED', 'INVALID_CREDENTIALS']);

function isCredentialFailure(code: string): boolean {
  return CREDENTIAL_FAILURE_CODES.has(code);
}

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
        if (response.status === 401 && !options.skipUnauthorizedHandler && !isCredentialFailure(error.code)) {
          this.onUnauthorized();
        }
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

  /**
   * 登录第二步：提交 6 位动态码或恢复码，成功后才真正建立会话。
   *
   * 与 `login` 一样在**会话建立之前**调用，因此不假设已有 CSRF 令牌
   * （客户端会在令牌存在时才附加请求头），且 401 不当作"会话失效"。
   */
  loginTotp(body: LoginTotpRequest): Promise<LoginTotpResponse> {
    return this.request<LoginTotpResponse>('/auth/login/totp', {
      method: 'POST',
      body,
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

  // ------------------------------------------------------------ 服务注册表（Sprint 1）

  /**
   * 服务列表（聚合接口）。
   *
   * 只调这一个接口就够：候选入口、可达性、容器状态都由服务端实时算好后返回，
   * 前端**不要**再并行调 `/containers` 自行拼装（那会引入两套口径）。
   */
  services(params: ServiceListParams = {}): Promise<ServiceListResponse> {
    return this.request<ServiceListResponse>('/services', {
      query: {
        query: params.query,
        category: params.category,
        favorite: params.favorite ? '1' : undefined,
        includeHidden: params.includeHidden ? '1' : undefined,
      },
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  /** 服务详情：含**全部**候选入口（含不可达）与诊断数据。 */
  service(id: string): Promise<ServiceDetailResponse> {
    return this.request<ServiceDetailResponse>(`/services/${encodeURIComponent(id)}`, {
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  /**
   * 新建手工服务（admin）。
   *
   * 成功响应是**裸的 `ServiceView`**（HTTP 201，无信封）—— 与 `server/src/api/services.ts` 一致。
   */
  createService(input: ServiceCreateRequest): Promise<ServiceView> {
    return this.request<ServiceView>('/services', {
      method: 'POST',
      body: input,
    });
  }

  /** 修改展示属性 / 可见性 / 排序 / 收藏 / 健康配置（admin）；成功响应是裸的 `ServiceView`。 */
  updateService(id: string, patch: ServiceUpdateRequest): Promise<ServiceView> {
    return this.request<ServiceView>(`/services/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: patch,
    });
  }

  /**
   * 删除 / 隐藏 / 重置（admin）。
   *
   * `mode='reset'` 清空全部用户覆盖（`user_edited=0`，展示属性回到自动值）；
   * 不带 mode 时：`manual` 服务真删除，自动服务只隐藏。
   */
  deleteService(id: string, mode?: 'reset'): Promise<ServiceDeleteResponse> {
    return this.request<ServiceDeleteResponse>(`/services/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      query: mode ? { mode } : undefined,
    });
  }

  /** 批量排序（admin）。 */
  reorderServices(order: Array<{ id: string; sortOrder: number }>): Promise<ServiceListResponse> {
    return this.request<ServiceListResponse>('/services/reorder', {
      method: 'POST',
      body: { order },
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  /** 强制重新发现（admin）：返回最新列表与来源状态。 */
  discoverServices(): Promise<ServiceListResponse> {
    return this.request<ServiceListResponse>('/services/discover', {
      method: 'POST',
      body: {},
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  /**
   * 一次性健康探测（admin 显式授权动作）。
   *
   * 目标可以是已保存的 `healthTarget`（不传则该参数省略），或本次显式传入的 URL；
   * 两种都会在后端重新校验（拒绝云元数据地址等）。
   */
  probeServiceHealth(id: string, healthTarget?: string): Promise<ServiceHealthResponse> {
    return this.request<ServiceHealthResponse>(`/services/${encodeURIComponent(id)}/health`, {
      method: 'POST',
      body: healthTarget ? { healthTarget } : {},
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  // ------------------------------------------------------------ 聚合搜索

  /** 按角色过滤的聚合搜索（服务 / 容器 / 设备 / 工具）。 */
  search(q: string, limit?: number): Promise<ServiceSearchResponse> {
    return this.request<ServiceSearchResponse>('/search', { query: { q, limit } });
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

  // ------------------------------------------------------------ 两步验证（TOTP）

  /**
   * 生成一个**未确认**的 TOTP 种子。
   *
   * 重复调用会重新生成，并使上一次未确认的种子失效（界面必须就此提示用户）。
   */
  totpSetup(): Promise<TotpSetupResponse> {
    return this.request<TotpSetupResponse>('/users/me/totp/setup', { method: 'POST' });
  }

  /**
   * 用 6 位动态码确认绑定；成功时**一次性**返回恢复码。
   *
   * 失败时 401 是 `TOTP_INVALID`（验证码错误），由 `CREDENTIAL_FAILURE_CODES`
   * 保证它不会被误当作会话失效。
   */
  totpEnable(body: TotpEnableRequest): Promise<TotpEnableResponse> {
    return this.request<TotpEnableResponse>('/users/me/totp/enable', {
      method: 'POST',
      body,
    });
  }

  /**
   * 关闭两步验证。
   *
   * 后端要求的门槛不低于开启：需要密码，**且当前已启用时还需一次当前验证码或恢复码**
   * （缺验证码时后端按 `VALIDATION_FAILED` 返回 `fieldErrors.code`）。
   */
  totpDisable(body: TotpDisableRequest): Promise<TotpDisableResponse> {
    return this.request<TotpDisableResponse>('/users/me/totp/disable', {
      method: 'POST',
      body,
    });
  }

  /** 用当前动态码重新生成恢复码；旧恢复码立即失效。401 = `TOTP_INVALID`。 */
  totpRegenerateRecoveryCodes(body: TotpRecoveryCodesRequest): Promise<RecoveryCodesResponse> {
    return this.request<RecoveryCodesResponse>('/users/me/totp/recovery-codes', {
      method: 'POST',
      body,
    });
  }

  /**
   * 管理员强制重置某用户的两步验证（清除绑定 + 吊销其全部会话）。
   *
   * 这里的 401 只可能是会话真的失效，因此保留全局 401 回调。
   */
  resetUserTotp(id: number): Promise<TotpResetResponse> {
    return this.request<TotpResetResponse>(`/users/${id}/totp/reset`, { method: 'POST' });
  }

  auditLog(limit = 100): Promise<AuditListResponse> {
    return this.request<AuditListResponse>('/users/audit/log', { query: { limit } });
  }

  // ------------------------------------------------------------ 运行时设置（admin）

  /** 读取全部设置项（含来源与生效级别）。 */
  settings(): Promise<SettingsResponse> {
    return this.request<SettingsResponse>('/settings', { timeoutMs: SLOW_TIMEOUT_MS });
  }

  /** 保存设置项；返回被拒绝/非法的键与最新视图。 */
  updateSettings(values: Record<string, unknown>): Promise<UpdateSettingsResponse> {
    return this.request<UpdateSettingsResponse>('/settings', {
      method: 'PATCH',
      body: { values },
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  /** 重置设置项；`keys` 省略表示全部重置。 */
  resetSettings(keys?: string[]): Promise<ResetSettingsResponse> {
    return this.request<ResetSettingsResponse>('/settings/reset', {
      method: 'POST',
      body: keys ? { keys } : {},
      timeoutMs: SLOW_TIMEOUT_MS,
    });
  }

  /** 测试 tailnet 连通性；可带尚未保存的候选 Token。 */
  testTailscale(token?: string): Promise<TailscaleTestResponse> {
    return this.request<TailscaleTestResponse>('/settings/test/tailscale', {
      method: 'POST',
      body: token ? { token } : {},
      timeoutMs: SLOW_TIMEOUT_MS,
    });
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
