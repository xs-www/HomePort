/**
 * 密码哈希与随机令牌。
 *
 * 密码：bcrypt（bcryptjs 纯 JS 实现）。选它而非 argon2 是为了避免容器内的原生模块编译，
 * 在多架构（amd64/arm64 NAS）构建时不会失败。代价是抗 GPU 破解略弱，因此强制
 * 最小长度与复杂度，并在登录处限流。
 *
 * 令牌：一律 `crypto.randomBytes`，DB 中只存 SHA-256 摘要。
 */
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

/** bcrypt cost。12 轮 ≈ 250ms/次（现代 x86），对登录场景可接受。 */
export const BCRYPT_ROUNDS = 12;

/** 密码最小长度（bootstrap 与新建用户共用）。 */
export const PASSWORD_MIN_LENGTH = 10;
/** 密码最大长度：bcrypt 只取前 72 字节，过长直接拒绝避免"静默截断"带来的误导。 */
export const PASSWORD_MAX_LENGTH = 128;

export interface PasswordStrengthResult {
  ok: boolean;
  /** 中文错误提示，ok=false 时非空 */
  reason: string | null;
}

/**
 * 校验密码强度：长度 + 至少两类字符 + 非常见弱口令。
 *
 * @param password 明文密码
 */
export function checkPasswordStrength(password: string): PasswordStrengthResult {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return { ok: false, reason: `密码至少 ${PASSWORD_MIN_LENGTH} 位` };
  }
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX_LENGTH) {
    return { ok: false, reason: `密码最多 ${PASSWORD_MAX_LENGTH} 字节` };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 2) {
    return { ok: false, reason: '密码需包含小写字母、大写字母、数字、符号中的至少两类' };
  }
  const weak = ['password', '12345678', 'qwerty', 'admin123', 'letmein', 'iloveyou'];
  const lowered = password.toLowerCase();
  if (weak.some((w) => lowered.includes(w))) {
    return { ok: false, reason: '密码包含常见弱口令片段' };
  }
  return { ok: true, reason: null };
}

/** 生成 bcrypt 哈希。 */
export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

/**
 * 校验密码。
 *
 * @param password 明文
 * @param hash 数据库中的 bcrypt 哈希
 * @returns 是否匹配；hash 非法时返回 false（不抛异常）
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (!hash || !hash.startsWith('$2')) return false;
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    return false;
  }
}

/**
 * 对已知不存在的用户执行一次等价耗时的哈希比较，抵消时间侧信道。
 *
 * 未登录攻击者可据响应时间区分「用户不存在」与「密码错误」。
 */
export async function dummyVerify(): Promise<void> {
  await bcrypt.compare('timing-equalizer', '$2b$12$C6UzMDM.H6dfI/f/IKcEe.6EOxLhxT0Yc8o/8YyU0nOaQxJ4bK9Zu');
}

/** 生成 URL 安全随机令牌（base64url，无填充）。 */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** 令牌摘要（存库用）。 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * 恒定时间比较两个字符串，避免 CSRF/令牌比对的时间侧信道。
 *
 * @returns 长度不等或内容不同均返回 false
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** 生成人类可输入的首启初始化令牌（易于抄写，去掉了易混字符）。 */
export function generateSetupToken(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(24);
  let out = '';
  for (let i = 0; i < 24; i += 1) {
    out += alphabet[(bytes[i] ?? 0) % alphabet.length];
    if (i % 6 === 5 && i < 23) out += '-';
  }
  return out;
}
