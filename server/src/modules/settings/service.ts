/**
 * 运行时设置服务。
 *
 * 职责：
 * 1. **启动时应用**一次（让数据库里的覆盖值先生效，再创建各数据源）。
 * 2. **每次变更后重新应用**，并在需要时热重建 Tailscale / Docker 数据源。
 * 3. 向管理接口提供「当前值 + 来源 + 生效级别」的视图，以及校验与重置能力。
 * 4. 提供 Tailscale 连通性测试（保存前先验证 Token，避免存进一个错值）。
 * 5. 注入 `secretBox` 时，注册表标了 `sensitive` 的键**落库前加密、读出后解密**，
 *    并提供存量明文的一次性升级入口 `reencryptAll()`（见 `secretStore.ts`）。
 *
 * ## 为什么用"版本号 + 惰性应用"
 *
 * 设置的消费方（各 service）在构造时就拿到了 `config` 对象引用，
 * 因此只要能**就地改写**这个对象就能让新值生效。
 * 版本号来自 `settings` 表的 `MAX(updated_at)`，变更后版本变化 → 触发一次 apply，
 * 这样多个进程/多个请求都无需各自缓存设置。
 */
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import type { SettingsRepository, SettingsStore } from '../../db/settings.js';
import type { AuditRepository } from '../../db/users.js';
import {
  MASK_TOKEN,
  SETTING_GROUPS,
  applyTo,
  buildSettingDefinitions,
  maskSecret,
  parseSettingValue,
  resolveSettings,
  serializeSettingValue,
  settingsToMap,
  validateSettingValue,
  type SettingDefinition,
  type SettingGroup,
  type SettingView,
  type ValidationResult,
} from './registry.js';
import { SecretSettingsStore, collectSensitiveKeys } from './secretStore.js';
import type { SecretBox } from './secretBox.js';
import { probeTailscale } from './tailscaleProbe.js';
import type { TailscaleTestResult } from './types.js';

export interface SettingsServiceDeps {
  config: PortalConfig;
  repository: SettingsRepository;
  audit: AuditRepository;
  logger: Logger;
  /**
   * 敏感值加密盒（AES-256-GCM）。
   *
   * **可选**：不传时完全保持"明文存储"的旧行为 —— 无密钥场景与既有测试不受影响。
   * 传入后，注册表里标记为 `sensitive` 的键会在**写库前加密、读库后解密**，
   * 服务内部（如 Tailscale 探测）拿到的始终是明文。
   */
  secretBox?: SecretBox;
  /** 应用设置后触发的数据源重建钩子（由 app.ts 注入，避免模块环） */
  onReload?: (hint: { tailscale: boolean; docker: boolean }) => Promise<void> | void;
}

export interface SettingsView {
  groups: ReadonlyArray<{ id: SettingGroup; label: string; description: string }>;
  settings: SettingView[];
  /** 当前生效的版本（settings 表的最后修改时间），便于前端判断是否需刷新 */
  version: string;
}

export interface UpdateSettingsInput {
  /** 键 → 值。值可以是字符串/数字/布尔 */
  values: Record<string, unknown>;
  actor: { id: number; username: string };
  ip: string | null;
}

export interface UpdateSettingsResult {
  updatedKeys: string[];
  /** 需要重建容器才能生效、因此被拒绝的键 */
  rejectedRestartKeys: string[];
  /** 值非法被拒绝的键与原因 */
  invalid: Array<{ key: string; error: string }>;
  reloaded: { tailscale: boolean; docker: boolean };
}

export class SettingsService {
  private readonly deps: SettingsServiceDeps;
  /**
   * 实际使用的设置仓储：传了 `secretBox` 时是"读写自动加解密"的装饰器，
   * 否则就是原始仓储（明文）。
   */
  private readonly repository: SettingsStore;
  /** 加密层（未启用为 null，`reencryptAll()` 因此是安全的空操作） */
  private readonly secretStore: SecretSettingsStore | null;
  private appliedVersion: string | null = null;
  private applying: Promise<void> | null = null;

  constructor(deps: SettingsServiceDeps) {
    this.deps = deps;
    this.secretStore = deps.secretBox
      ? new SecretSettingsStore({
          base: deps.repository,
          secretBox: deps.secretBox,
          sensitiveKeys: collectSensitiveKeys(deps.config),
          logger: deps.logger,
        })
      : null;
    this.repository = this.secretStore ?? deps.repository;
  }

  /** 启动时调用：把数据库覆盖值应用到 config。 */
  async initialize(): Promise<void> {
    await this.ensureApplied(true);
  }

  /**
   * 一次性把库里仍是明文的敏感值全部升级为密文（**首次启动装配时调用**）。
   *
   * 惰性迁移已经覆盖了"用户下次写入该键"的场景，这个方法是给存量老库兜底：
   * 启动即可把历史明文敏感值收进密文，顺带把 `previousKeys` 加密的老密文
   * 升级到当前密钥。幂等：没有可升级的行时返回 0 且不写库。
   *
   * 解密失败的键会被跳过（记警告、按"未设置"处理），**不会中止启动**。
   *
   * @returns 升级条数；未启用加密时恒为 0
   */
  async reencryptAll(): Promise<number> {
    if (!this.secretStore) return 0;
    const { upgraded, failed } = this.secretStore.reencryptAll();
    if (upgraded > 0) {
      // 只记条数与密钥指纹（非密钥本身），不记任何值
      this.deps.logger.info('敏感设置已加密存储（存量明文 → 密文）', {
        upgraded,
        keyFingerprint: this.secretStore.keyFingerprint(),
      });
    }
    if (failed.length > 0) {
      this.deps.logger.warn('部分敏感设置无法解密，已按“未设置”处理，请重新填写', { keys: failed });
    }
    return upgraded;
  }

  /**
   * 若设置已变更则重新应用（惰性、幂等）。
   *
   * @param force 忽略版本比对，强制重新应用
   */
  async ensureApplied(force = false): Promise<void> {
    if (this.applying) {
      await this.applying;
      return;
    }
    const version = this.currentVersion();
    if (!force && this.appliedVersion === version) return;

    this.applying = (async () => {
      const resolved = resolveSettings({ config: this.deps.config, repository: this.repository });
      const overridden = new Set(this.repository.list().map((item) => item.key));
      const result = applyTo(this.deps.config, settingsToMap(resolved), overridden);

      // 设置项变化会影响已建立的连接/客户端，这里显式重建
      if (result.reloadTailscale || result.reloadDocker) {
        await this.deps.onReload?.({ tailscale: result.reloadTailscale, docker: result.reloadDocker });
      }

      this.appliedVersion = version;
      if (result.changedKeys.length > 0) {
        this.deps.logger.info('运行时设置已应用', {
          changed: result.changedKeys,
          reloadTailscale: result.reloadTailscale,
          reloadDocker: result.reloadDocker,
          ...(result.skippedKeys.length > 0 ? { skipped: result.skippedKeys } : {}),
        });
      }
    })().finally(() => {
      this.applying = null;
    });

    await this.applying;
  }

  /** 当前设置视图（含每项的来源与生效级别）。 */
  async view(): Promise<SettingsView> {
    await this.ensureApplied();
    const resolved = resolveSettings({ config: this.deps.config, repository: this.repository });
    const groups = groupList();
    return {
      groups,
      settings: resolved.map((item) => this.toView(item)),
      version: this.currentVersion(),
    };
  }

  /**
   * 写入设置。
   *
   * 规则：
   * - `restart` 级键直接拒绝（`rejectedRestartKeys`），界面本就不该提交它们；
   * - 敏感项提交 `********` 或空字符串表示"保持不变"；
   * - 逐项校验，非法项进入 `invalid`，合法项仍然写入（部分成功）。
   */
  async update(input: UpdateSettingsInput): Promise<UpdateSettingsResult> {
    const definitions = this.definitions();
    const byKey = new Map(definitions.map((d) => [d.key, d]));

    const toWrite: Array<{ key: string; serialized: string }> = [];
    const rejectedRestartKeys: string[] = [];
    const invalid: Array<{ key: string; error: string }> = [];

    for (const [key, rawValue] of Object.entries(input.values)) {
      const definition = byKey.get(key);
      if (!definition) {
        invalid.push({ key, error: '未知设置项' });
        continue;
      }
      if (definition.effect === 'restart') {
        rejectedRestartKeys.push(key);
        continue;
      }
      // 敏感项占位符 = 不修改
      if (definition.sensitive && typeof rawValue === 'string' && (rawValue === MASK_TOKEN || rawValue.trim() === '')) {
        continue;
      }

      const result: ValidationResult = validateSettingValue(definition, rawValue);
      if (!result.ok || result.serialized === undefined) {
        invalid.push({ key, error: result.error ?? '值不合法' });
        continue;
      }
      toWrite.push({ key, serialized: result.serialized });
    }

    if (toWrite.length > 0) {
      // 敏感项在这里被加密后才落库（由 secretStore 装饰层处理）；
      // 审计与日志下面只记键名，明文/密文都不外泄。
      this.repository.upsertMany(
        toWrite.map((item) => ({ key: item.key, value: item.serialized, updatedBy: input.actor.username })),
      );
      // 写后立即应用，让本次请求的响应就能反映新值
      await this.ensureApplied(true);

      const reloaded = {
        tailscale: toWrite.some((item) => item.key.startsWith('PORTAL_TAILSCALE_') && item.key !== 'PORTAL_TAILSCALE_TIMEOUT_MS'),
        docker: toWrite.some((item) => item.key === 'DOCKER_ENDPOINT'),
      };

      this.deps.audit.append({
        actorId: input.actor.id,
        actorName: input.actor.username,
        action: 'settings.update',
        target: 'settings',
        // 敏感项只记键名，不记值
        detail: toWrite
          .map((item) => {
            const def = byKey.get(item.key);
            return def?.sensitive ? `${item.key}=***` : `${item.key}=${item.serialized}`;
          })
          .join(', '),
        ip: input.ip,
      });

      return {
        updatedKeys: toWrite.map((item) => item.key),
        rejectedRestartKeys,
        invalid,
        reloaded,
      };
    }

    return { updatedKeys: [], rejectedRestartKeys, invalid, reloaded: { tailscale: false, docker: false } };
  }

  /**
   * 删除覆盖值（恢复为环境变量或内置默认）。
   *
   * @param keys 省略则重置全部
   */
  async reset(keys: readonly string[] | null, actor: { id: number; username: string }, ip: string | null): Promise<number> {
    const definitions = this.definitions();
    const allowed = keys === null ? null : keys.filter((key) => definitions.some((d) => d.key === key));
    const removed = allowed === null ? this.repository.deleteAll() : this.repository.deleteMany(allowed);

    await this.ensureApplied(true);

    this.deps.audit.append({
      actorId: actor.id,
      actorName: actor.username,
      action: 'settings.reset',
      target: 'settings',
      detail: allowed === null ? '重置全部设置为默认值' : `重置：${allowed.join(', ')}`,
      ip,
    });

    return removed;
  }

  /**
   * 测试 Tailscale 连通性。
   *
   * @param candidateToken 未提供时用当前生效的 Token（保存前预检可传入新值）
   */
  async testTailscale(candidateToken?: string): Promise<TailscaleTestResult> {
    const config = this.deps.config;
    const token = (candidateToken ?? '').trim() || config.tailscale.apiToken.trim();
    return probeTailscale({
      mode: config.tailscale.mode,
      apiToken: token,
      tailnet: config.tailscale.tailnet,
      bin: config.tailscale.bin,
      socket: config.tailscale.socket,
      timeoutMs: config.tailscale.timeoutMs,
      logger: this.deps.logger,
    });
  }

  /** 当前版本标识（settings 表最后修改时间）。 */
  private currentVersion(): string {
    const list = this.repository.list();
    if (list.length === 0) return 'empty';
    // updatedAt 为 ISO 字符串，字典序即时间序
    let latest = '';
    for (const item of list) {
      if (item.updatedAt > latest) latest = item.updatedAt;
    }
    return `${list.length}:${latest}`;
  }

  private definitions(): SettingDefinition[] {
    return buildSettingDefinitions(this.deps.config);
  }

  /** 把解析结果转为前端视图（敏感项打码）。 */
  private toView(item: ReturnType<typeof resolveSettings>[number]): SettingView {
    const { definition } = item;
    const envValue = definition.sensitive && item.envValue !== null ? maskSecret(item.envValue) : item.envValue;
    const databaseRaw = item.databaseValue;
    const databaseValue =
      definition.sensitive && databaseRaw !== null ? maskSecret(databaseRaw) : this.parseForDisplay(definition, databaseRaw);

    const currentValue = definition.sensitive
      ? typeof item.value === 'string' && item.value !== ''
        ? maskSecret(item.value)
        : ''
      : item.value;

    return {
      key: definition.key,
      group: definition.group,
      label: definition.label,
      description: definition.description,
      effect: definition.effect,
      valueType: definition.valueType,
      envVar: definition.envVar,
      value: currentValue,
      masked: definition.sensitive === true && typeof item.value === 'string' && item.value !== '',
      source: item.source,
      defaultValue: definition.defaultValue,
      envValue,
      databaseValue,
      ...(definition.choices ? { choices: definition.choices } : {}),
      ...(definition.min !== undefined ? { min: definition.min } : {}),
      ...(definition.max !== undefined ? { max: definition.max } : {}),
      ...(definition.unit ? { unit: definition.unit } : {}),
      ...(definition.sensitive ? { sensitive: true } : {}),
      ...(definition.restartReason ? { restartReason: definition.restartReason } : {}),
      ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}),
      ...(item.updatedBy !== undefined ? { updatedBy: item.updatedBy } : {}),
      editable: definition.effect !== 'restart',
    };
  }

  private parseForDisplay(definition: SettingDefinition, raw: string | null): unknown {
    if (raw === null) return null;
    const parsed = parseSettingValue(definition, raw);
    if (parsed !== null) return parsed;
    // 无法解析（例如历史脏数据）时原样展示，便于用户发现并修正
    return serializeSettingValue(definition, raw);
  }
}

/**
 * 分组列表。
 *
 * **必须直接返回 `SETTING_GROUPS`**：这里曾经是一份手抄的副本，Sprint 2 新增
 * `metrics` / `health` 两组时只改了 registry，于是设置接口返回的 `groups` 少了这两组，
 * `tests/auth.test.ts` 的"每一项的 group 必须在 groups 里声明过，否则前端会漏渲染"
 * 立刻抓到了用户可见的缺陷。同源之后，新增分组只可能改一处。
 */
function groupList(): SettingsView['groups'] {
  return SETTING_GROUPS;
}
