/**
 * 服务相关前端测试的**公共夹具与假 fetch**（Sprint 1）。
 *
 * 注意：本文件**不是**测试文件（不匹配 `tests/**\/*.test.{ts,tsx}`），因此不会被 vitest 收集；
 * 它只提供三样东西：假响应工具、会话夹具、服务夹具。
 * 所有测试都通过 `vi.stubGlobal('fetch', …)` 造假响应，**绝不发真实请求**。
 */
import { vi } from 'vitest';
import type {
  ServiceDiscoveryState,
  ServiceEntryView,
  ServiceListResponse,
  ServiceView,
  SessionUser,
} from '../src/api/types.js';

// ---------------------------------------------------------------- 假响应

/** 造一个 JSON 响应（假 Response 只需 `status` / `ok` / `text()`）。 */
export function jsonResponse(payload: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** 造一个后端错误响应（`{ error: { code, message, details } }`）。 */
export function errorResponse(code: string, message: string, status = 400, details: unknown = null): Response {
  return jsonResponse({ error: { code, message, details } }, status);
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
  /** 已解析的请求体（无 body 时为 undefined） */
  body: unknown;
  headers: Record<string, string>;
}

export type Handler = (init: RequestInit) => Response;

/** 安装 fetch 假实现：按**精确 URL** 分发并记录每次调用；漏配的 URL 返回 500 + 明确文案。 */
export function stubFetch(routes: Record<string, Handler>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({ url, init, body, headers: (init.headers ?? {}) as Record<string, string> });
      const handler = routes[url];
      if (!handler) {
        return Promise.resolve(jsonResponse({ error: { code: 'NOT_STUBBED', message: `未定义假响应：${url}` } }, 500));
      }
      return Promise.resolve(handler(init));
    }),
  );
  return calls;
}

/** 取指定 URL 的所有调用。 */
export function callsTo(calls: RecordedCall[], url: string): RecordedCall[] {
  return calls.filter((call) => call.url === url);
}

// ---------------------------------------------------------------- 会话夹具

export function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 1,
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    disabled: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastLoginAt: null,
    totpEnabled: false,
    totpConfirmedAt: null,
    ...overrides,
  };
}

export function sessionPayload(user: SessionUser | null): unknown {
  return {
    setupRequired: false,
    authenticated: user !== null,
    csrfToken: user ? 'csrf-1' : '',
    user,
    expiresAt: null,
  };
}

/** 会话探测 + 健康检查 + 偏好（任何渲染 AuthProvider 的测试都需要）。 */
export function baseRoutes(user: SessionUser | null): Record<string, Handler> {
  return {
    '/api/auth/session': () => jsonResponse(sessionPayload(user)),
    '/api/health': () => jsonResponse({ version: 'test' }),
    '/api/users/me': () => jsonResponse({ user, preferences: null }),
  };
}

// ---------------------------------------------------------------- 服务夹具

export function entry(overrides: Partial<ServiceEntryView> = {}): ServiceEntryView {
  return {
    kind: 'serve',
    label: 'Serve HTTPS',
    url: 'https://family-nas.tail585599.ts.net:8443/calendar',
    rank: 1,
    accessible: true,
    detail: 'serve → http://127.0.0.1:36065/calendar',
    ...overrides,
  };
}

/** 典型的"仅本机"候选入口（不可达，UI 必须标注）。 */
export const LOCALHOST_ENTRY: ServiceEntryView = entry({
  kind: 'localhost',
  label: '仅本机',
  url: 'http://localhost:36065/',
  rank: 4,
  accessible: false,
  detail: '容器端口 8080/tcp → 宿主 127.0.0.1:36065',
});

export function serviceView(overrides: Partial<ServiceView> = {}): ServiceView {
  return {
    id: 'svc-calendar',
    slug: 'sisi-calendar',
    displayName: '家庭日历',
    description: '家庭共享日历',
    icon: 'calendar',
    category: '家庭',
    sourceType: 'docker',
    sourceRef: 'docker:sisi-calendar',
    bindingRefs: ['docker:sisi-calendar'],
    visibility: 'visible',
    favorite: false,
    sortOrder: 10,
    preferredUrl: 'https://family-nas.tail585599.ts.net:8443/calendar',
    entry: 'https://family-nas.tail585599.ts.net:8443/calendar',
    entries: [
      entry(),
      LOCALHOST_ENTRY,
    ],
    entryCount: 2,
    status: {
      container: 'running',
      reachable: true,
      health: 'skipped',
      reasons: ['未配置健康检查（默认不探测）'],
    },
    container: { id: 'cid-1', name: 'sisi-calendar', state: 'running', image: 'sisi-calendar:latest' },
    userEdited: true,
    healthTarget: null,
    healthPath: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}

export function discoveryState(overrides: Partial<ServiceDiscoveryState> = {}): ServiceDiscoveryState {
  return {
    dockerAvailable: true,
    serveAvailable: true,
    serveDetail: null,
    discoveredAt: '2026-01-02T00:00:00.000Z',
    notes: [],
    ...overrides,
  };
}

export function listResponse(items: ServiceView[], overrides: Partial<ServiceListResponse> = {}): ServiceListResponse {
  const categories = [...new Set(items.map((item) => (item.category ?? '').trim()).filter((name) => name !== ''))];
  return {
    items,
    total: items.length,
    categories,
    discovery: discoveryState(),
    generatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  };
}