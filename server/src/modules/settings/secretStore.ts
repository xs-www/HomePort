/**
 * 敏感设置的加解密层（叠在设置仓储的边界上）。
 *
 * ## 为什么是"装饰仓储"而不是"在 service 里手动加密"
 *
 * `settings` 表的读写路径不止一条：`update()` 写、`resolveSettings()` 读、
 * `currentVersion()` 也要读。如果把加解密散落在调用点上，漏掉任何一条就会出现
 * "把密文当 Token 发给外部 API"或"版本号把密文当成设置值"这类问题。
 * 这里把转换收敛到唯一入口 —— 凡是经由本类读写的敏感键，
 * **写库前加密、读库后解密**，其余代码完全不必知道加密的存在。
 *
 * ## 兼容与失败语义（三条硬规则）
 *
 * 1. **无 `enc:v1:` 前缀 = 迁移前的旧明文**：原样读出来继续用，
 *    并在**下一次写入该键**时自动升级为密文（惰性迁移）。
 *    首次启动还可以调用 `reencryptAll()` 一次性把存量明文全部升级。
 * 2. **解密失败不抛给调用方**：密钥不匹配/密文被改时，该键被视为"未设置"
 *    （从读取结果里剔除，回退到环境变量或内置默认），并记一条只含键名的告警。
 *    这样进程照常起、其它键照常用，用户重新填一次即可恢复。
 * 3. **非敏感键一律不加密**：保持可读，便于排障与人工修库。
 *
 * ## 绝不泄露到日志
 *
 * 所有日志只带**键名**，不带明文也不带密文（`warnOnce` 里的 `reason` 是
 * `SecretBoxError` 的固定文案，不含密钥片段）。
 */
import type { PortalConfig } from '../../config.js';
import {
  SettingsRepository,
  type SettingRecord,
  type SettingsStore,
  type UpsertSettingInput,
} from '../../db/settings.js';
import type { Logger } from '../../logger.js';
import { buildSettingDefinitions } from './registry.js';
import type { SecretBox } from './secretBox.js';

/** 注册表里被标记为 `sensitive` 的键集合（= 需要加密落库的范围）。 */
export function collectSensitiveKeys(config: PortalConfig): Set<string> {
  const keys = new Set<string>();
  for (const definition of buildSettingDefinitions(config)) {
    if (definition.sensitive === true) keys.add(definition.key);
  }
  return keys;
}

export interface SecretSettingsStoreOptions {
  /** 底层仓储（真正读写 SQLite） */
  base: SettingsRepository;
  /** 加密盒（当前密钥 + 可选 previousKeys） */
  secretBox: SecretBox;
  /** 需要加密的键集合，见 `collectSensitiveKeys()` */
  sensitiveKeys: ReadonlySet<string>;
  logger: Logger;
}

/** `reencryptAll()` 的结果。 */
export interface ReencryptUpgrade {
  /** 实际升级为"当前密钥密文"的行数（幂等：第二次调用为 0） */
  upgraded: number;
  /** 解不开、已按"未设置"处理、需人工重填的键 */
  failed: string[];
}

/**
 * 敏感值透明加解密的设置仓储。
 *
 * 对外与 `SettingsRepository` 同契约（`SettingsStore`），因此可以无缝传给
 * `resolveSettings()` / `SettingsService`。
 */
export class SecretSettingsStore implements SettingsStore {
  private readonly base: SettingsRepository;
  private readonly secretBox: SecretBox;
  private readonly sensitiveKeys: ReadonlySet<string>;
  private readonly logger: Logger;
  /** 已告警过的键：解密失败会被反复读到，避免每次都刷一条日志 */
  private readonly warnedKeys = new Set<string>();

  constructor(options: SecretSettingsStoreOptions) {
    this.base = options.base;
    this.secretBox = options.secretBox;
    this.sensitiveKeys = options.sensitiveKeys;
    this.logger = options.logger;
  }

  /** 当前主密钥指纹（非密钥本身，用于启动日志与排障）。 */
  keyFingerprint(): string {
    return this.secretBox.keyFingerprint();
  }

  // ------------------------------------------------------------ 读取

  /** 全部覆盖键，敏感项已解密；解不开的项被剔除（= 视为未设置）。 */
  list(): SettingRecord[] {
    const out: SettingRecord[] = [];
    for (const row of this.base.list()) {
      const decoded = this.decode(row.key, row.value);
      if (decoded === null) continue;
      out.push(decoded === row.value ? row : { ...row, value: decoded });
    }
    return out;
  }

  /** 键 → 明文值（敏感项已解密）。 */
  toMap(): Map<string, string> {
    const map = new Map<string, string>();
    for (const row of this.list()) map.set(row.key, row.value);
    return map;
  }

  /** 单个键的明文值；未覆盖或解不开返回 null。 */
  get(key: string): string | null {
    const raw = this.base.get(key);
    if (raw === null) return null;
    return this.decode(key, raw);
  }

  // ------------------------------------------------------------ 写入

  /** 单条 upsert，敏感项先加密。返回的记录里 `value` 仍是明文，便于调用方直接使用。 */
  upsert(input: UpsertSettingInput): SettingRecord {
    const record = this.base.upsert({ ...input, value: this.encode(input.key, input.value) });
    return { ...record, value: input.value };
  }

  /** 批量 upsert（单事务），敏感项先加密。 */
  upsertMany(inputs: readonly UpsertSettingInput[]): string[] {
    return this.base.upsertMany(inputs.map((item) => ({ ...item, value: this.encode(item.key, item.value) })));
  }

  // ------------------------------------------------- 删除（无需转换）

  delete(key: string): boolean {
    return this.base.delete(key);
  }

  deleteMany(keys: readonly string[]): number {
    return this.base.deleteMany(keys);
  }

  deleteAll(): number {
    return this.base.deleteAll();
  }

  // ------------------------------------------------------------ 迁移

  /**
   * 一次性把库里**所有仍为明文**（或仍是旧密钥加密）的敏感值升级为
   * 当前密钥的密文。供启动装配调用一次，之后靠"写入即加密"维持。
   *
   * - 幂等：全部升完后再调返回 0，且不产生任何数据库写入；
   * - 解不开的行跳过并计入 `failed`，不抛错、不中断启动；
   * - 非敏感键完全不动。
   *
   * @returns 升级条数与失败键名
   */
  reencryptAll(): ReencryptUpgrade {
    const upgrades: UpsertSettingInput[] = [];
    const failed: string[] = [];
    let upgraded = 0;

    // 必须读**原始行**：走 this.list() 会把解不开的行过滤掉，那样永远修不回来
    for (const row of this.base.list()) {
      if (!this.sensitiveKeys.has(row.key)) continue;
      if (row.value === '') continue;

      if (!this.secretBox.isEncrypted(row.value)) {
        // 迁移前的旧明文 → 升级为密文
        upgrades.push({ key: row.key, value: this.secretBox.encrypt(row.value), updatedBy: row.updatedBy });
        upgraded += 1;
        continue;
      }

      // 已是密文：能解开但用的是旧密钥 → 顺手升级到当前密钥
      if (this.secretBox.isCurrentKey(row.value)) continue;
      try {
        const plain = this.secretBox.decrypt(row.value);
        upgrades.push({ key: row.key, value: this.secretBox.encrypt(plain), updatedBy: row.updatedBy });
        upgraded += 1;
      } catch (error) {
        failed.push(row.key);
        this.warnOnce(row.key, error);
      }
    }

    if (upgrades.length > 0) this.base.upsertMany(upgrades);
    return { upgraded, failed };
  }

  // ------------------------------------------------------------ 内部

  /**
   * 读出转换：密文 → 明文。
   *
   * @returns 明文；解密失败返回 null（调用方按"未设置"处理）
   */
  private decode(key: string, value: string): string | null {
    if (!this.sensitiveKeys.has(key)) return value;
    // 空值 / 无前缀（迁移前旧明文）都原样返回：惰性迁移留给下一次写入
    if (value === '' || !this.secretBox.isEncrypted(value)) return value;
    try {
      return this.secretBox.decrypt(value);
    } catch (error) {
      this.warnOnce(key, error);
      return null;
    }
  }

  /** 写入转换：明文 → 密文（非敏感键与空值原样落库）。 */
  private encode(key: string, value: string): string {
    if (!this.sensitiveKeys.has(key)) return value;
    // 空值没有可保护的内容，保持可读；已是密文则幂等返回，避免二次加密
    if (value === '' || this.secretBox.isEncrypted(value)) return value;
    return this.secretBox.encrypt(value);
  }

  /** 每个键只告警一次（解密失败会被反复读到）。只记键名，不记值。 */
  private warnOnce(key: string, error: unknown): void {
    if (this.warnedKeys.has(key)) return;
    this.warnedKeys.add(key);
    this.logger.warn('敏感设置解密失败，已按“未设置”处理，请在界面重新填写', {
      key,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}