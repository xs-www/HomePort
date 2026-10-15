/**
 * 统一 HTTP 错误。
 *
 * 全部 API 错误都以 `HttpError` 抛出，由 `app.ts` 的 errorHandler 序列化为
 * `{ error: { code, message, details } }`（契约见 docs/static/04-api-contract.md §0.3）。
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

export type ApiErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'CSRF_MISMATCH'
  | 'SETUP_REQUIRED'
  | 'ALREADY_INITIALIZED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'RATE_LIMITED'
  | 'UPSTREAM_UNAVAILABLE'
  | 'INTERNAL';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  INVALID_CREDENTIALS: 401,
  FORBIDDEN: 403,
  CSRF_MISMATCH: 403,
  SETUP_REQUIRED: 409,
  ALREADY_INITIALIZED: 409,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class HttpError extends Error {
  readonly code: ApiErrorCode;
  readonly statusCode: number;
  readonly details: unknown;

  constructor(code: ApiErrorCode, message: string, details: unknown = null, statusCode?: number) {
    super(message);
    this.name = 'HttpError';
    this.code = code;
    this.statusCode = statusCode ?? STATUS_BY_CODE[code];
    this.details = details;
  }

  /** 序列化为响应体。 */
  toBody(): { error: { code: ApiErrorCode; message: string; details: unknown } } {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError('VALIDATION_FAILED', message, details ?? null);
export const unauthenticated = (message = '未登录或会话已过期'): HttpError =>
  new HttpError('UNAUTHENTICATED', message);
export const forbidden = (message = '权限不足'): HttpError => new HttpError('FORBIDDEN', message);
export const notFound = (message = '资源不存在'): HttpError => new HttpError('NOT_FOUND', message);
export const conflict = (message: string, details?: unknown): HttpError =>
  new HttpError('CONFLICT', message, details ?? null);
export const upstreamUnavailable = (message: string, details?: unknown): HttpError =>
  new HttpError('UPSTREAM_UNAVAILABLE', message, details ?? null);
export const internal = (message = '服务器内部错误'): HttpError => new HttpError('INTERNAL', message);

/** zod 校验失败的 details 结构。 */
export interface FieldIssues {
  fieldErrors: Record<string, string[]>;
}

/**
 * 把 zod 的 `issues` 转换为前端友好的 `fieldErrors`。
 *
 * @param issues zod `error.issues`
 */
export function toFieldIssues(issues: ReadonlyArray<{ path: ReadonlyArray<string | number | symbol>; message: string }>): FieldIssues {
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  return { fieldErrors };
}

/** 供 Fastify 统一错误处理使用：从任意异常提取 HttpError 形态。 */
export function asHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error && typeof error === 'object' && 'statusCode' in error) {
    const statusCode = Number((error as { statusCode?: unknown }).statusCode);
    const message = (error as { message?: string }).message ?? '请求失败';
    if (statusCode === 401) return new HttpError('UNAUTHENTICATED', message);
    if (statusCode === 403) return new HttpError('FORBIDDEN', message);
    if (statusCode === 404) return new HttpError('NOT_FOUND', message);
    if (statusCode === 429) return new HttpError('RATE_LIMITED', message);
    if (statusCode >= 400 && statusCode < 500) return new HttpError('VALIDATION_FAILED', message);
  }
  return internal(error instanceof Error ? error.message : '未知错误');
}

export interface ErrorHandlerContext {
  request: FastifyRequest;
  reply: FastifyReply;
  error: unknown;
  /** 记录日志（含 requestId） */
  log: (error: HttpError, original: unknown) => void;
}

/**
 * Fastify errorHandler 的实现体（在 app.ts 里注册）。
 *
 * 规则：4xx 记 warn，5xx 记 error 并隐藏内部细节。
 */
export function handleError(context: ErrorHandlerContext): void {
  const { request, reply, error, log } = context;
  const httpError = asHttpError(error);

  if (httpError.statusCode >= 500) {
    log(httpError, error);
    const body = httpError.toBody();
    // 非 HttpError 的内部异常不泄漏堆栈细节
    if (!(error instanceof HttpError)) {
      body.error.message = '服务器内部错误';
    }
    void reply.status(httpError.statusCode).send(body);
    return;
  }

  if (httpError.statusCode !== 401) {
    log(httpError, error);
  }
  void reply.status(httpError.statusCode).send(httpError.toBody());
}
