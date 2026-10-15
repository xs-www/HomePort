/**
 * 请求体/查询参数校验 schema（zod）。
 *
 * 统一放在这里便于「改接口时只改一处」，并与 docs/static/04-api-contract.md 对照。
 */
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../modules/auth/crypto.js';
import { HttpError } from './errors.js';

/** 密码基础约束（强度细则由 checkPasswordStrength 在 service 层判定）。 */
export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `密码至少 ${PASSWORD_MIN_LENGTH} 位`)
  .max(PASSWORD_MAX_LENGTH, `密码最多 ${PASSWORD_MAX_LENGTH} 个字符`);

export const usernameSchema = z
  .string()
  .trim()
  .min(3, '用户名至少 3 位')
  .max(32, '用户名最多 32 位')
  .regex(/^[A-Za-z0-9_.-]+$/, '用户名只能包含字母、数字、下划线、点或短横线');

export const roleSchema = z.enum(['admin', 'viewer']);

export const loginBodySchema = z.object({
  username: z.string().trim().min(1, '请输入用户名').max(64),
  password: z.string().min(1, '请输入密码').max(PASSWORD_MAX_LENGTH),
  remember: z.boolean().optional(),
});

export const bootstrapBodySchema = z.object({
  token: z.string().trim().min(1, '请输入初始化令牌').max(128),
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(48).optional(),
});

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码').max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});

export const createUserBodySchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  displayName: z.string().trim().max(48).optional(),
  role: roleSchema.optional(),
});

export const updateUserBodySchema = z
  .object({
    displayName: z.string().trim().min(1, '显示名不能为空').max(48).optional(),
    role: roleSchema.optional(),
    disabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export const resetPasswordBodySchema = z.object({
  newPassword: passwordSchema,
});

export const preferencesBodySchema = z
  .object({
    theme: z.enum(['dark', 'light', 'system']).optional(),
    density: z.enum(['comfortable', 'compact']).optional(),
    defaultPage: z
      .enum(['overview', 'containers', 'devices', 'system', 'tools', 'admin'])
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: '至少提供一个待更新字段' });

export const containerListQuerySchema = z.object({
  all: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => (v === undefined ? true : v === '1' || v === 'true')),
  stats: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
  reachability: z.enum(['tailnet', 'lan', 'localhost-only', 'none']).optional(),
  q: z.string().trim().max(128).optional(),
});

export const containerLogsQuerySchema = z.object({
  tail: z.coerce.number().int().min(1).max(2000).optional(),
  timestamps: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === '1' || v === 'true'),
});

export const toolsQuerySchema = z.object({
  probe: z
    .union([z.literal('0'), z.literal('1'), z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => (v === undefined ? true : v === '1' || v === 'true')),
  category: z.string().trim().max(32).optional(),
});

export const idParamSchema = z.object({
  id: z.string().trim().min(1).max(128),
});

export const numericIdParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * 解析 + 校验；失败抛 `VALIDATION_FAILED`（含 `fieldErrors`）。
 *
 * 两处刻意的写法：
 * 1. 参数类型用 `z.ZodTypeAny` 而非 `z.ZodType<T>` —— 带 `.transform()` 的 schema
 *    其输入/输出类型不同，用 `ZodType<T>` 会导致逆变检查失败。
 * 2. 不使用 zod 的 `.default()` —— 生成的输出类型在该配置下仍带 `| undefined`，
 *    反而迫使调用方到处写 `??`。默认值统一在路由层显式给出。
 */
export function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, where = '请求参数'): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data as z.output<S>;
  const fieldErrors: Record<string, string[]> = {};
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_';
    (fieldErrors[key] ??= []).push(issue.message);
  }
  throw new HttpError('VALIDATION_FAILED', `${where}校验失败`, { fieldErrors });
}

