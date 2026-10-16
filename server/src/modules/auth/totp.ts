/**
 * TOTP 两步验证纯函数核心（RFC 6238 / RFC 4226）。
 *
 * 设计取舍：
 *
 * 1. **HMAC-SHA1 + 6 位 + 30 秒**：这是 Google Authenticator、1Password、Aegis、
 *    Microsoft Authenticator 全都默认支持的"兼容档"。选 SHA-256/512 更"现代"，
 *    但会让一部分 App 扫码后算出错误的码 —— 对一个家庭门户来说，
 *    兼容性带来的实际安全收益远大于哈希强度差异。
 * 2. **种子必须加密存储**：TOTP 种子等价于"第二把钥匙"，明文落库等于把
 *    两步验证降级成一步。本模块只负责生成明文种子，加密由调用方
 *    （auth service + settings/secretBox.ts）负责，两者职责分离。
 * 3. **默认时间窗 ±1 个周期**（`window = 1`）：手机时钟与服务端有几秒到几十秒
 *    漂移是常态，窗口为 0 会让真实用户频繁被拒。窗口放宽的代价是
 *    "码的有效期从 30s 变成最长 90s"，配合防重放（见下）可接受。
 * 4. **防重放靠 `lastCounter`**：GCM/窗口都防不住"同一个码在有效期内被用两次"，
 *    因此校验成功后调用方要把命中的 `counter` 写回用户行；下次同一个
 *    （或更早的）时间步再出现就判 `replayed`。
 * 5. 本文件是**纯函数**：不读配置、不碰数据库、不写日志，便于用 RFC 官方向量测试。
 */
import crypto from 'node:crypto';

/** 时间步长度（秒）。 */
export const TOTP_PERIOD_SECONDS = 30;
/** 默认位数。 */
export const TOTP_DIGITS = 6;
/** 恢复码个数。 */
export const RECOVERY_CODE_COUNT = 10;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/**
 * 恢复码字符集：故意去掉 `0 O 1 I L` 这些易混字符。
 * 恢复码是人工抄写/手打的，混字符会直接变成"抄错一次就用不了"的客服问题。
 */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface TotpVerifyOptions {
  /** 允许的时间窗偏移（±N 个周期），默认 1 */
  window?: number;
  /** 当前时间（ms），默认 `Date.now()`。测试注入用 */
  now?: number;
  /** 该用户上次成功使用的时间步，用于防重放；null/undefined 表示无记录 */
  lastCounter?: number | null;
}

export type TotpFailReason = 'malformed' | 'mismatch' | 'replayed';

export interface TotpVerifyResult {
  ok: boolean;
  /** 命中的时间步（HOTP counter）；失败时为 null */
  counter: number | null;
  /** 失败原因；成功时为 undefined */
  reason?: TotpFailReason;
}

/** Base32 编码（RFC 4648 字母表，大写、**无 padding**）。 */
export function encodeBase32(input: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of input) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

/**
 * Base32 解码。
 *
 * 容忍空格、连字符与 `=` padding（用户从界面上复制种子时经常带上这些），
 * 但**不静默忽略非法字符** —— 混入 `0`/`1` 这类不在字母表里的字符时抛错，
 * 否则会把一个抄错的种子解成一个"能算出码但永远对不上"的种子。
 */
export function decodeBase32(input: string): Buffer {
  const cleaned = input
    .replace(/[\s-]/g, '')
    .replace(/=+$/, '')
    .toUpperCase();
  if (cleaned === '') return Buffer.alloc(0);

  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) throw new Error(`Base32 种子含非法字符 "${char}"`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 生成新种子：20 字节（160 位）随机 → Base32。 */
export function generateTotpSecret(): string {
  return encodeBase32(crypto.randomBytes(20));
}

/** 恒定时间字符串比较（长度不同直接返回 false，不泄漏长度信息之外的时序）。 */
function timingSafeEqualStr(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** HOTP：给定时间步算出 `digits` 位码（RFC 4226 动态截断）。 */
export function totpCodeAt(secret: string, counter: number, digits: number = TOTP_DIGITS): string {
  const key = decodeBase32(secret);
  if (key.length === 0) throw new Error('TOTP 种子为空');
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error(`TOTP 时间步非法：${counter}`);

  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', key).update(message).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    (digest[offset + 1]! << 16) |
    (digest[offset + 2]! << 8) |
    digest[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** 当前时间对应的码。 */
export function totpCode(secret: string, now: number = Date.now(), digits: number = TOTP_DIGITS): string {
  return totpCodeAt(secret, Math.floor(now / 1000 / TOTP_PERIOD_SECONDS), digits);
}

/**
 * 校验验证码。
 *
 * 尝试顺序为「当前步 → ±1 → ±2 …」，即**优先接受最接近当前时间**的码，
 * 这样配合 `lastCounter` 的重放判定语义最直观（用户刚用过的码被判重放，
 * 而不是指到一个更远的窗口上去）。
 */
export function verifyTotp(secret: string, code: string, options: TotpVerifyOptions = {}): TotpVerifyResult {
  const { window = 1, now = Date.now(), lastCounter = null } = options;
  const normalized = code.trim();

  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(normalized)) {
    return { ok: false, counter: null, reason: 'malformed' };
  }

  let key: Buffer;
  try {
    key = decodeBase32(secret);
  } catch {
    return { ok: false, counter: null, reason: 'malformed' };
  }
  if (key.length === 0) return { ok: false, counter: null, reason: 'malformed' };

  const current = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  const candidates: number[] = [current];
  for (let distance = 1; distance <= window; distance += 1) {
    candidates.push(current + distance);
    candidates.push(current - distance);
  }

  for (const counter of candidates) {
    if (counter < 0) continue;
    const expected = totpCodeAt(secret, counter);
    if (!timingSafeEqualStr(expected, normalized)) continue;
    // 码本身正确，但该时间步（或更早的）已经用过 → 判重放
    if (lastCounter !== null && lastCounter !== undefined && counter <= lastCounter) {
      return { ok: false, counter, reason: 'replayed' };
    }
    return { ok: true, counter };
  }

  return { ok: false, counter: null, reason: 'mismatch' };
}

/**
 * 生成 otpauth:// URI（验证器 App 扫码/粘贴用）。
 *
 * 标签部分按规范写成 `Issuer:account` 并整体 URL 编码；
 * query 里再带一次 `issuer`（部分 App 只读 query）。
 * 用手工拼接而不是 `URLSearchParams`：后者把空格编码成 `+`，
 * 而 otpauth 生态普遍期望 `%20`。
 */
export function buildOtpauthUri(input: {
  secret: string;
  issuer: string;
  account: string;
  digits?: number;
  period?: number;
}): string {
  const digits = input.digits ?? TOTP_DIGITS;
  const period = input.period ?? TOTP_PERIOD_SECONDS;
  // 标签里的分隔冒号必须是**字面量** `:`（App 靠它切分 issuer/account），
  // 但分隔符两侧各自要 URL 编码 —— 整体编码会把冒号变成 %3A，部分 App 解析不出来。
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = [
    `secret=${encodeURIComponent(input.secret)}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    'algorithm=SHA1',
    `digits=${digits}`,
    `period=${period}`,
  ].join('&');
  return `otpauth://totp/${label}?${query}`;
}

/** 生成恢复码（默认 10 个），形如 `XXXX-XXXX`，同批内不重复。 */
export function generateRecoveryCodes(count: number = RECOVERY_CODE_COUNT): string[] {
  const codes = new Set<string>();
  // 兜底上限：字符集 31^8 远大于 10，正常循环几次就够；
  // 这里仍给一个上限，避免调用方传入荒唐的 count 时死循环。
  const maxAttempts = count * 50 + 100;
  let attempts = 0;
  while (codes.size < count && attempts < maxAttempts) {
    attempts += 1;
    let raw = '';
    for (let i = 0; i < 8; i += 1) {
      raw += RECOVERY_ALPHABET[crypto.randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.add(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return [...codes];
}

/** 归一化恢复码：去分隔符/空白、转大写。用于"用户抄写时不带连字符"的场景。 */
export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * 恢复码摘要（sha256 十六进制）。
 *
 * 恢复码是 8 位随机字符（约 40 bit 熵），足够抵抗离线爆破，
 * 因此用不带盐的 sha256 即可 —— 与密码（必须 bcrypt）不同：
 * 加盐会让"按摘要查找并消费"变成全表扫描，得不偿失。
 */
export function hashRecoveryCode(code: string): string {
  return crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');
}