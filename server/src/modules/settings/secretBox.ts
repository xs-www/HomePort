/**
 * 敏感值加密盒（AES-256-GCM）。
 *
 * 用途：`settings` 表里被标记为 `sensitive` 的项（例如 Tailscale API Token）
 * 与用户的 TOTP 种子，在**落库前**加密。数据库文件即使被拷走，
 * 没有主密钥也无法还原出明文。
 *
 * 设计要点：
 *
 * 1. **只做对称加密，不做密钥派生**：主密钥必须由外部提供（`PORTAL_SECRET_KEY`）
 *    或由本模块自动生成到 `<dataDir>/secret.key`（权限 `0600`）。
 *    不接受"用户口令当密钥" —— 那需要 KDF + 盐管理，收益与复杂度不成比例。
 * 2. **随机 IV 每次不同**：同一个明文加密两次得到不同密文（语义安全），
 *    因此**不能用密文做等值比较**。
 * 3. **格式自描述**：`enc:v1:<base64(iv|tag|cipher)>`。带版本前缀是为了
 *    将来换算法时能识别老数据；带前缀也让"明文遗留值"可被区分
 *    （没有前缀 = 迁移前的旧明文）。
 * 4. **认证加密**：GCM 的 tag 让密文被篡改时解密直接失败，而不是解出垃圾。
 * 5. **支持密钥轮换**：`previousKeys` 只用于解密，加密永远用当前密钥。
 *    `needsRotation()` 告诉调用方"这个值还是老密钥加的，下次写入时顺手升级"。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../logger.js';

/** 密文前缀：无此前缀的值一律视为旧版明文。 */
export const ENCRYPTED_PREFIX = 'enc:v1:';

/** AES-256-GCM 的 IV 长度（字节）。 */
const IV_BYTES = 12;
/** GCM 认证标签长度（字节）。 */
const TAG_BYTES = 16;
/** 主密钥长度（字节）。 */
export const KEY_BYTES = 32;

/** 加密/解密失败。消息刻意不含明文与密钥片段。 */
export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretBoxError';
  }
}

export interface SecretBox {
  /** 加密为 `enc:v1:…`。已加密的输入会被原样返回（幂等），避免二次加密。 */
  encrypt(plaintext: string): string;
  /**
   * 解密 `enc:v1:…`。
   *
   * @throws {SecretBoxError} 格式非法 / 密钥不匹配 / 密文被篡改
   */
  decrypt(value: string): string;
  /** 是否是本模块产生的密文。 */
  isEncrypted(value: string): boolean;
  /** 该值是否能用当前密钥解开（即无需轮换）；非密文返回 true。 */
  isCurrentKey(value: string): boolean;
  /** 当前密钥指纹（sha256 前 8 位十六进制）。用于审计与排障，**不是**密钥。 */
  keyFingerprint(): string;
}

/** 把 32 字节主密钥编码为 `hex` 或 `base64` 字符串。 */
export function encodeKey(key: Buffer): string {
  if (key.length !== KEY_BYTES) throw new SecretBoxError(`主密钥必须是 ${KEY_BYTES} 字节`);
  return key.toString('base64');
}

/**
 * 解析主密钥字符串。
 *
 * 接受：64 位十六进制、base64（32 字节）、或 `base64:` / `hex:` 显式前缀。
 */
export function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (!trimmed) throw new SecretBoxError('主密钥为空');

  let key: Buffer;
  if (/^hex:/i.test(trimmed)) {
    key = Buffer.from(trimmed.slice(4), 'hex');
  } else if (/^base64:/i.test(trimmed)) {
    key = Buffer.from(trimmed.slice(7), 'base64');
  } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    key = Buffer.from(trimmed, 'hex');
  } else {
    key = Buffer.from(trimmed, 'base64');
  }

  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError(
      `主密钥长度非法（解出 ${key.length} 字节，需要 ${KEY_BYTES} 字节）。` +
        '请提供 64 位十六进制或 base64 编码的 32 字节密钥，例如：openssl rand -base64 32',
    );
  }
  return key;
}

/** 由给定密钥构造加密盒。 */
export function createSecretBox(options: { key: Buffer; previousKeys?: Buffer[] }): SecretBox {
  const { key } = options;
  if (key.length !== KEY_BYTES) throw new SecretBoxError(`主密钥必须是 ${KEY_BYTES} 字节`);
  const previous = options.previousKeys ?? [];
  const fingerprint = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);

  function decryptWith(candidate: Buffer, value: string): string | null {
    const body = value.slice(ENCRYPTED_PREFIX.length);
    const blob = Buffer.from(body, 'base64');
    if (blob.length < IV_BYTES + TAG_BYTES) return null;
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', candidate, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  return {
    isEncrypted(value: string): boolean {
      return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX);
    },

    encrypt(plaintext: string): string {
      if (this.isEncrypted(plaintext)) return plaintext;
      const iv = crypto.randomBytes(IV_BYTES);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ENCRYPTED_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
    },

    decrypt(value: string): string {
      if (!this.isEncrypted(value)) {
        throw new SecretBoxError('值不是密文（缺少 enc:v1: 前缀），拒绝解密');
      }
      const withCurrent = decryptWith(key, value);
      if (withCurrent !== null) return withCurrent;
      for (const candidate of previous) {
        const withPrevious = decryptWith(candidate, value);
        if (withPrevious !== null) return withPrevious;
      }
      throw new SecretBoxError('解密失败：主密钥不匹配或密文已被篡改');
    },

    isCurrentKey(value: string): boolean {
      if (!this.isEncrypted(value)) return true;
      return decryptWith(key, value) !== null;
    },

    keyFingerprint(): string {
      return fingerprint;
    },
  };
}

export interface LoadKeyOptions {
  /** 显式密钥（`PORTAL_SECRET_KEY`）；为空则回退到密钥文件 */
  explicit: string | null;
  /** 密钥文件路径（`PORTAL_SECRET_KEY_FILE`） */
  keyFile: string;
  logger?: Logger;
}

export interface LoadedKey {
  key: Buffer;
  /** 来源：环境变量 / 既有文件 / 现场新生成 */
  source: 'env' | 'file' | 'generated';
  file: string;
}

/**
 * 取得主密钥：优先环境变量，其次密钥文件，最后**生成**一个。
 *
 * 自动生成时写入 `0600` 权限的文件。这是"零配置也能加密"的关键：
 * 用户什么都不填时，敏感值依然是加密存储的，只是主密钥和数据库在同一个卷里
 * （威胁模型上等同于"防数据库文件单独泄露"，不等同于"防主机失陷"）。
 * 需要更高强度时显式提供 `PORTAL_SECRET_KEY`。
 */
export function loadOrCreateKey(options: LoadKeyOptions): LoadedKey {
  const { explicit, keyFile, logger } = options;

  if (explicit) {
    return { key: parseKey(explicit), source: 'env', file: keyFile };
  }

  if (fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile, 'utf8').trim();
    if (!raw) throw new SecretBoxError(`主密钥文件为空：${keyFile}`);
    return { key: parseKey(raw), source: 'file', file: keyFile };
  }

  const key = crypto.randomBytes(KEY_BYTES);
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, encodeKey(key), { mode: 0o600, encoding: 'utf8' });
  // Windows 上 mode 会被忽略，这里补一次显式收紧（失败不致命）
  try {
    fs.chmodSync(keyFile, 0o600);
  } catch {
    /* 忽略：某些文件系统不支持 */
  }
  logger?.warn('已生成新的主密钥文件，请随数据库卷一起备份；丢失后敏感设置与 TOTP 种子将无法解密', {
    file: keyFile,
  });
  return { key, source: 'generated', file: keyFile };
}

/** 解析 `PORTAL_SECRET_KEY_PREVIOUS`（逗号分隔，用于密钥轮换）。 */
export function parsePreviousKeys(raw: string | null | undefined): Buffer[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => parseKey(s));
}