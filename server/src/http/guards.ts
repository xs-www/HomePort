/**
 * 鉴权与 CSRF 守卫（Fastify 钩子工厂）。
 *
 * 使用方式（app.ts）：
 * ```
 * app.addHook('onRequest', createAuthHook(deps));           // 全局：解析会话并挂到 request
 * app.addHook('onRequest', createCsrfHook());                // 全局：变更类请求校验 CSRF
 * app.addHook('onRequest', createRequireRoleHook('viewer')); // 需要登录的路由
 * ```
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HttpError, forbidden, unauthenticated } from './errors.js';
import type { Session } from '../db/types.js';
import type { User, UserRole } from '../db/types.js';
import { timingSafeEqual } from '../modules/auth/crypto.js';

/** 挂在 request 上的鉴权上下文。 */
export interface AuthContext {
  user: User;
  session: Session;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** 已认证上下文；未登录为 null */
    auth: AuthContext | null;
  }
}

/** 只读方法集合：这些方法豁免 CSRF 校验。 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 豁免 CSRF 的路径（登录与首启初始化在建立会话之前，无法携带会话 CSRF）。 */
const CSRF_EXEMPT_PATHS = new Set(['/api/auth/login', '/api/auth/login/totp', '/api/auth/bootstrap']);

export interface ResolveSessionInput {
  token: string | null;
  userAgent: string | null;
  remoteAddr: string | null;
}

/** 由 auth service 提供的会话解析函数签名。 */
export type SessionResolver = (input: ResolveSessionInput) => AuthContext | null;

export interface AuthHookDeps {
  resolveSession: SessionResolver;
  cookieName: string;
}

/** 从 Cookie 头中取出指定名称的值（不依赖 @fastify/cookie，便于单测）。 */
export function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key !== name) continue;
    return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/**
 * 全局鉴权钩子：解析会话 Cookie 并填充 `request.auth`。
 *
 * 解析失败（令牌无效/过期/用户被禁用）不抛错，只是把 `auth` 置 null，
 * 由后续的 requireRole 钩子决定是否拒绝 —— 这样 `/api/auth/session` 能对
 * 过期会话返回 `authenticated: false` 而不是 401。
 */
export function createAuthHook(deps: AuthHookDeps) {
  return async function authHook(request: FastifyRequest): Promise<void> {
    const token = readCookie(request.headers.cookie, deps.cookieName);
    request.auth = deps.resolveSession({
      token,
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
      remoteAddr: request.ip ?? null,
    });
  };
}

/**
 * CSRF 钩子：变更类请求必须携带与会话匹配的 `X-CSRF-Token`。
 *
 * 双层校验（cookie 与 header 必须一致，且与库中记录一致）：
 * 即使攻击者能让浏览器发出跨站请求，也无法读取到 token（httpOnly 会话 + 同源策略）。
 */
export function createCsrfHook() {
  return async function csrfHook(request: FastifyRequest): Promise<void> {
    if (SAFE_METHODS.has(request.method)) return;
    if (CSRF_EXEMPT_PATHS.has(request.routeOptions.url ?? request.url.split('?')[0] ?? '')) return;

    const auth = request.auth;
    if (!auth) return; // 未登录由 requireRole 处理，这里不重复报错

    const header = request.headers['x-csrf-token'];
    const headerValue = typeof header === 'string' ? header : Array.isArray(header) ? header[0] : undefined;
    if (!headerValue) {
      throw new HttpError('CSRF_MISMATCH', '缺少 X-CSRF-Token 请求头');
    }
    if (!timingSafeEqual(headerValue, auth.session.csrfToken)) {
      throw new HttpError('CSRF_MISMATCH', 'CSRF 令牌不匹配，请刷新页面后重试');
    }
  };
}

const ROLE_RANK: Record<UserRole, number> = { viewer: 1, admin: 2 };

/**
 * 角色守卫：要求 `request.auth` 已建立且角色不低于 `required`。
 *
 * @param required 'viewer' 表示"任意已登录用户"，'admin' 表示管理员
 */
export function createRequireRoleHook(required: UserRole) {
  return async function requireRoleHook(request: FastifyRequest): Promise<void> {
    const auth = request.auth;
    if (!auth) throw unauthenticated();
    if (ROLE_RANK[auth.user.role] < ROLE_RANK[required]) {
      throw forbidden(`该操作需要 ${required === 'admin' ? '管理员' : '登录用户'} 权限`);
    }
  };
}

/**
 * 从请求上下文提取「已认证用户」，未认证时抛 401。
 *
 * 用于 handler 内部（钩子已保证时会走快路径）。
 */
export function requireAuth(request: FastifyRequest): AuthContext {
  if (!request.auth) throw unauthenticated();
  return request.auth;
}

/** 从请求上下文提取用户，未认证返回 null（不抛错）。 */
export function optionalAuth(request: FastifyRequest): AuthContext | null {
  return request.auth;
}

export interface ClientHints {
  userAgent: string | null;
  ip: string | null;
}

/** 收集客户端信息用于会话与审计。 */
export function clientHints(request: FastifyRequest): ClientHints {
  return {
    userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    ip: request.ip ?? null,
  };
}

/** 计算会话 Cookie 的 `Set-Cookie` 字符串。 */
export interface SessionCookieInput {
  name: string;
  value: string;
  /** 过期时间；null 表示会话 Cookie（浏览器关闭即失效） */
  expires: Date | null;
  secure: boolean;
  maxAgeSeconds?: number;
}

/**
 * 构造会话 Cookie。属性选择：
 * - `HttpOnly`：防 XSS 窃取
 * - `SameSite=Lax`：既防 CSRF 又允许从其它站点点击链接进入
 * - `Path=/`
 */
export function buildSessionCookie(input: SessionCookieInput): string {
  const parts = [`${input.name}=${encodeURIComponent(input.value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (input.expires) parts.push(`Expires=${input.expires.toUTCString()}`);
  if (input.maxAgeSeconds !== undefined) parts.push(`Max-Age=${input.maxAgeSeconds}`);
  if (input.secure) parts.push('Secure');
  return parts.join('; ');
}

/** 构造清除 Cookie（用于登出）。 */
export function buildClearCookie(name: string, secure: boolean): string {
  return buildSessionCookie({ name, value: '', expires: new Date(0), secure, maxAgeSeconds: 0 });
}

/** 供 reply 使用的快捷设置（避免各处重复拼字符串）。 */
export function setSessionCookie(reply: FastifyReply, cookie: string): void {
  reply.header('set-cookie', cookie);
}
