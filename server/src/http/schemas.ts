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
 * 保存设置：`{ values: { KEY: value } }`。
 *
 * 值的类型不在此处约束（每种类型的规则由 `registry.validateSettingValue` 负责，
 * 因为规则依赖设置项定义）；这里只保证"是个非空对象"。
 */
export const updateSettingsBodySchema = z.object({
  values: z.record(z.union([z.string(), z.number(), z.boolean()])).refine((value) => Object.keys(value).length > 0, {
    message: '至少提供一个待保存的设置项',
  }),
});

/** 重置设置：`{ keys?: string[] }`，省略表示全部重置。 */
export const resetSettingsBodySchema = z.object({
  keys: z.array(z.string().trim().min(1).max(128)).max(200).optional(),
});

/** 测试 tailnet 连通性：可带尚未保存的候选 Token。 */
export const testTailscaleBodySchema = z.object({
  token: z.string().max(512).optional(),
});

// ---- 两步验证（TOTP）----

/**
 * 登录第二步：挑战令牌 + 验证码。
 *
 * `code` 同时接受 6 位 TOTP 码与 `XXXX-XXXX` 形式的恢复码，
 * 因此这里只做长度与字符集约束（具体判定在 service 层），
 * 且**不**把错误提示写成"验证码格式错误"以免暴露内部判定顺序。
 */
export const loginTotpBodySchema = z.object({
  challengeToken: z.string().trim().min(16, '缺少登录挑战令牌').max(256),
  code: z.string().trim().min(6, '请输入 6 位验证码').max(16),
  remember: z.boolean().optional(),
});

/** 确认启用两步验证：回填一次验证器生成的 6 位码。 */
export const totpEnableBodySchema = z.object({
  code: z.string().trim().min(6, '请输入 6 位验证码').max(16),
});

/** 重新生成恢复码：需要当前 TOTP 码作为"再次确认"。 */
export const totpRecoveryCodesBodySchema = z.object({
  code: z.string().trim().min(6, '请输入 6 位验证码').max(16),
});

/**
 * 关闭两步验证。
 *
 * 要求密码（证明是本人）并可再要求当前验证码；
 * 两步验证是"提高门槛"的功能，关掉它的门槛必须不低于打开它。
 */
export const totpDisableBodySchema = z.object({
  password: z.string().min(1, '请输入当前密码').max(PASSWORD_MAX_LENGTH),
  code: z.string().trim().min(6).max(16).optional(),
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

