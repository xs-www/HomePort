/**
 * 敏感设置加密存储的单测（S0-03）。
 *
 * 覆盖 `secretStore.ts` 加解密层与 `SettingsService` 的集成行为：
 *
 * 1. 敏感键**落库即为密文**（直接查 `settings` 表断言原始字符串不含明文），服务读出是明文；
 * 2. 非敏感键**一律不加密**（保持可读，便于排障与人工修库）；
 * 3. 老库里的**旧明文**照常可读，并在下一次写入时惰性升级为密文；
 * 4. `reencryptAll()` 一次性升级存量明文，**数量正确且幂等**；
 * 5. 密钥轮换（`previousKeys`）后仍能读，并能升级到当前密钥；
 * 6. 密钥错误 / 密文被篡改时**降级为"未设置"**，不崩进程、不影响其它键，
 *    也绝不把解不开的值当有效 Token 用；
 * 7. 审计与日志里不出现敏感值的明文或密文；
 * 8. 不传 `secretBox` 时行为与今天完全一致（无密钥场景 / 既有测试）。
 *
 * 说明：测试直接对**原始** `SettingsRepository` 读库，以验证"库里到底存了什么"，
 * 而服务侧一律走 `SettingsService`（内部是自动加解密的装饰仓储）。
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { initDatabase, type Db } from '../src/db/database.js';
import { SettingsRepository } from '../src/db/settings.js';
import { AuditRepository } from '../src/db/users.js';
import { createLogger, createSilentLogger, type Logger } from '../src/logger.js';
import { createSecretBox, ENCRYPTED_PREFIX, KEY_BYTES, type SecretBox } from '../src/modules/settings/secretBox.js';
import { SecretSettingsStore, collectSensitiveKeys } from '../src/modules/settings/secretStore.js';
import { SettingsService } from '../src/modules/settings/service.js';
import { MASK_TOKEN } from '../src/modules/settings/registry.js';

/** 会被测试读到的环境变量：统一清空，保证结果只取决于数据库。 */
const MANAGED_ENV = [
  'PORTAL_TAILSCALE_MODE',
  'PORTAL_TAILSCALE_API_TOKEN',
  'PORTAL_TAILSCALE_TAILNET',
  'PORTAL_METRICS_INTERVAL_MS',
  'PORTAL_TOOLS_PROBE_HOST',
  'DOCKER_ENDPOINT',
];

const savedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of MANAGED_ENV) {
    savedEnv.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
});

/** 敏感键：注册表里唯一标了 `sensitive` 的项。 */
const TOKEN_KEY = 'PORTAL_TAILSCALE_API_TOKEN';
/** 非敏感键（数字），用于验证"不受影响"。 */
const INTERVAL_KEY = 'PORTAL_METRICS_INTERVAL_MS';

const ACTOR = { id: 1, username: 'admin' };

const newBox = (): SecretBox => createSecretBox({ key: crypto.randomBytes(KEY_BYTES) });

interface FixtureOptions {
  /** 复用同一份库：密钥轮换 / 换错密钥的场景必须落在同一批数据上 */
  db?: Db;
  /** 不传 = 旧行为（明文） */
  secretBox?: SecretBox;
  /** 需要断言日志内容时传入带 sink 的 logger */
  logger?: Logger;
}

interface Fixture {
  db: Db;
  config: PortalConfig;
  repository: SettingsRepository;
  audit: AuditRepository;
  logger: Logger;
  service: SettingsService;
}

/** 造一份测试用的 config + 设置库 + 服务。 */
function makeFixture(options: FixtureOptions = {}): Fixture {
  const db = options.db ?? initDatabase({ file: ':memory:' }).db;
  const config = loadConfig({ env: 'test', dataDir: '/tmp/hp-settings-crypto', dbPath: ':memory:' });
  const repository = new SettingsRepository(db);
  const audit = new AuditRepository(db);
  const logger = options.logger ?? createSilentLogger();
  const service = new SettingsService({
    config,
    repository,
    audit,
    logger,
    ...(options.secretBox ? { secretBox: options.secretBox } : {}),
  });
  return { db, config, repository, audit, logger, service };
}

/** 直接读 settings 表里的**原始字符串**（绕过解密层）。 */
function rawValue(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

/** 反转一位密文字节，模拟"密文被改"。 */
function tamper(cipher: string): string {
  const blob = Buffer.from(cipher.slice(ENCRYPTED_PREFIX.length), 'base64');
  blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
  return ENCRYPTED_PREFIX + blob.toString('base64');
}

// ---------------------------------------------------------------- 落库与读取

describe('settingsCrypto · 敏感键加密落库', () => {
  it('数据库里的原始字符串不含明文，且服务读出的是明文', async () => {
    const box = newBox();
    const { db, config, service } = makeFixture({ secretBox: box });
    const secret = 'tskey-api-super-secret-abcdef123456';

    await service.update({ values: { [TOKEN_KEY]: secret }, actor: ACTOR, ip: null });

    const raw = rawValue(db, TOKEN_KEY);
    expect(raw).toBeDefined();
    expect(raw!.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect(box.isEncrypted(raw!)).toBe(true);
    // 原始字符串里既没有完整明文，也没有明文片段
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain('super-secret');

    // 读出后是明文：applyTo 已把它写回 config，供外部 API 真正调用
    expect(config.tailscale.apiToken).toBe(secret);
    // 用密钥直接解库也能还原（证明是可逆加密而非哈希）
    expect(box.decrypt(raw!)).toBe(secret);
  });

  it('接口视图里敏感项仍打码，且视图 JSON 不含明文', async () => {
    const box = newBox();
    const { service } = makeFixture({ secretBox: box });
    const secret = 'tskey-api-viewcheck-9876543210';

    await service.update({ values: { [TOKEN_KEY]: secret }, actor: ACTOR, ip: null });
    const view = await service.view();
    const item = view.settings.find((entry) => entry.key === TOKEN_KEY)!;

    expect(item.source).toBe('database');
    expect(item.masked).toBe(true);
    expect(item.value).toBe(`tskey-api-${MASK_TOKEN}`);
    expect(item.databaseValue).toBe(`tskey-api-${MASK_TOKEN}`);
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it('同一明文两次写入得到不同密文（随机 IV），但都能解回同一明文', async () => {
    const box = newBox();
    const { db, service } = makeFixture({ secretBox: box });
    const secret = 'tskey-api-same-value';

    await service.update({ values: { [TOKEN_KEY]: secret }, actor: ACTOR, ip: null });
    const first = rawValue(db, TOKEN_KEY)!;
    await service.update({ values: { [TOKEN_KEY]: secret }, actor: ACTOR, ip: null });
    const second = rawValue(db, TOKEN_KEY)!;

    expect(second).not.toBe(first);
    expect(box.decrypt(first)).toBe(secret);
    expect(box.decrypt(second)).toBe(secret);
  });
});

// ---------------------------------------------------------------- 非敏感键

describe('settingsCrypto · 非敏感键不加密', () => {
  it('数字与字符串类非敏感键保持明文入库', async () => {
    const box = newBox();
    const { db, service } = makeFixture({ secretBox: box });

    await service.update({
      values: { [INTERVAL_KEY]: 9000, DOCKER_ENDPOINT: 'tcp://other:2375' },
      actor: ACTOR,
      ip: null,
    });

    expect(rawValue(db, INTERVAL_KEY)).toBe('9000');
    expect(rawValue(db, 'DOCKER_ENDPOINT')).toBe('tcp://other:2375');
  });

  it('非敏感键的值即使长得像密文也原样读写，不会被误解密', async () => {
    const box = newBox();
    const { db, service } = makeFixture({ secretBox: box });
    const lookalike = `${ENCRYPTED_PREFIX}not-a-real-cipher`;

    await service.update({ values: { PORTAL_TOOLS_PROBE_HOST: lookalike }, actor: ACTOR, ip: null });

    expect(rawValue(db, 'PORTAL_TOOLS_PROBE_HOST')).toBe(lookalike);
    const view = await service.view();
    expect(view.settings.find((entry) => entry.key === 'PORTAL_TOOLS_PROBE_HOST')?.value).toBe(lookalike);
  });

  it('collectSensitiveKeys 只收集注册表里标了 sensitive 的键', () => {
    const config = loadConfig({ env: 'test', dataDir: '/tmp/hp-settings-crypto', dbPath: ':memory:' });
    const keys = collectSensitiveKeys(config);
    expect(keys.has(TOKEN_KEY)).toBe(true);
    expect(keys.has('PORTAL_TAILSCALE_MODE')).toBe(false);
    expect(keys.has('DOCKER_ENDPOINT')).toBe(false);
  });
});

// ------------------------------------------------------- 旧明文兼容与惰性迁移

describe('settingsCrypto · 旧明文兼容与惰性迁移', () => {
  it('老库里的明文敏感值照常读出并生效（无前缀 = 旧明文）', async () => {
    const box = newBox();
    const { db, config, repository, service } = makeFixture({ secretBox: box });
    repository.upsertMany([{ key: TOKEN_KEY, value: 'tskey-api-legacy-plain', updatedBy: 'legacy' }]);
    expect(rawValue(db, TOKEN_KEY)).toBe('tskey-api-legacy-plain');

    await service.initialize();

    expect(config.tailscale.apiToken).toBe('tskey-api-legacy-plain');
  });

  it('下一次写入该键时自动升级为密文，旧明文被彻底覆盖', async () => {
    const box = newBox();
    const { db, repository, service } = makeFixture({ secretBox: box });
    repository.upsertMany([{ key: TOKEN_KEY, value: 'tskey-api-legacy-plain', updatedBy: 'legacy' }]);

    await service.update({ values: { [TOKEN_KEY]: 'tskey-api-upgraded' }, actor: ACTOR, ip: null });

    const raw = rawValue(db, TOKEN_KEY)!;
    expect(box.isEncrypted(raw)).toBe(true);
    expect(box.decrypt(raw)).toBe('tskey-api-upgraded');
    expect(raw).not.toContain('legacy-plain');
    // 惰性迁移后仍能正常读出
    expect((await service.view()).settings.find((entry) => entry.key === TOKEN_KEY)?.source).toBe('database');
  });

  it('reencryptAll() 升级存量明文，数量正确且幂等', async () => {
    const box = newBox();
    const { db, repository, service } = makeFixture({ secretBox: box });
    // 模拟老库：敏感键明文 + 非敏感键明文
    repository.upsertMany([
      { key: TOKEN_KEY, value: 'tskey-api-legacy', updatedBy: 'legacy' },
      { key: INTERVAL_KEY, value: '6000', updatedBy: 'legacy' },
    ]);

    expect(await service.reencryptAll()).toBe(1);

    const raw = rawValue(db, TOKEN_KEY)!;
    expect(box.isEncrypted(raw)).toBe(true);
    expect(box.decrypt(raw)).toBe('tskey-api-legacy');
    // 非敏感键不动
    expect(rawValue(db, INTERVAL_KEY)).toBe('6000');

    // 幂等：第二次没有可升级的行，且不重写（密文字节完全相同）
    expect(await service.reencryptAll()).toBe(0);
    expect(rawValue(db, TOKEN_KEY)).toBe(raw);
  });

  it('未传 secretBox 时 reencryptAll() 是空操作', async () => {
    const { db, repository, service } = makeFixture();
    repository.upsertMany([{ key: TOKEN_KEY, value: 'tskey-api-plain', updatedBy: 'legacy' }]);
    expect(await service.reencryptAll()).toBe(0);
    expect(rawValue(db, TOKEN_KEY)).toBe('tskey-api-plain');
  });
});

// ------------------------------------------------------------ 密钥轮换

describe('settingsCrypto · 密钥轮换', () => {
  it('previousKeys 轮换后仍能读，并能升级到新密钥', async () => {
    const oldKey = crypto.randomBytes(KEY_BYTES);
    const newKey = crypto.randomBytes(KEY_BYTES);
    const { db } = initDatabase({ file: ':memory:' });

    // 1) 老密钥写入 → 库里是"老密钥的密文"
    const before = makeFixture({ db, secretBox: createSecretBox({ key: oldKey }) });
    await before.service.update({ values: { [TOKEN_KEY]: 'tskey-api-rotate' }, actor: ACTOR, ip: null });
    const legacyCipher = rawValue(db, TOKEN_KEY)!;
    expect(legacyCipher.startsWith(ENCRYPTED_PREFIX)).toBe(true);

    // 2) 换新密钥，previousKeys 保住老数据：读得出来，但标记为"需要轮换"
    const rotatedBox = createSecretBox({ key: newKey, previousKeys: [oldKey] });
    const after = makeFixture({ db, secretBox: rotatedBox });
    expect(rotatedBox.isCurrentKey(legacyCipher)).toBe(false);

    await after.service.initialize();
    expect(after.config.tailscale.apiToken).toBe('tskey-api-rotate');

    // 3) 升级到当前密钥
    expect(await after.service.reencryptAll()).toBe(1);
    const currentCipher = rawValue(db, TOKEN_KEY)!;
    expect(currentCipher).not.toBe(legacyCipher);
    expect(rotatedBox.isCurrentKey(currentCipher)).toBe(true);

    // 4) 只用新密钥（不带 previousKeys）也能解开 → 证明确实换过密钥了
    const strict = makeFixture({ db, secretBox: createSecretBox({ key: newKey }) });
    await strict.service.initialize();
    expect(strict.config.tailscale.apiToken).toBe('tskey-api-rotate');
  });

  it('只给新密钥（无 previousKeys）时老密文降级为未设置，而不是崩掉', async () => {
    const { db } = initDatabase({ file: ':memory:' });
    const before = makeFixture({ db, secretBox: createSecretBox({ key: crypto.randomBytes(KEY_BYTES) }) });
    await before.service.update({ values: { [TOKEN_KEY]: 'tskey-api-lost' }, actor: ACTOR, ip: null });

    const after = makeFixture({ db, secretBox: createSecretBox({ key: crypto.randomBytes(KEY_BYTES) }) });
    await expect(after.service.initialize()).resolves.toBeUndefined();
    expect(after.config.tailscale.apiToken).toBe('');
  });
});

// -------------------------------------------------------- 密钥错误 / 密文损坏

describe('settingsCrypto · 解密失败降级', () => {
  it('密钥不匹配时该键按“未设置”处理，其它键与进程不受影响', async () => {
    const { db } = initDatabase({ file: ':memory:' });
    const right = makeFixture({ db, secretBox: newBox() });
    await right.service.update({
      values: { [TOKEN_KEY]: 'tskey-api-secret', [INTERVAL_KEY]: 8000 },
      actor: ACTOR,
      ip: null,
    });
    const cipher = rawValue(db, TOKEN_KEY)!;

    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const wrong = makeFixture({ db, secretBox: newBox(), logger });

    // 1) 不抛错、不崩：initialize 正常完成
    await expect(wrong.service.initialize()).resolves.toBeUndefined();
    // 2) 脏值不会被当成有效 Token 传给外部 API
    expect(wrong.config.tailscale.apiToken).toBe('');
    // 3) 其它（非敏感）键照常生效
    expect(wrong.config.system.metricsIntervalMs).toBe(8000);

    // 4) 视图里这一项就是"未设置"
    const view = await wrong.service.view();
    const token = view.settings.find((entry) => entry.key === TOKEN_KEY)!;
    expect(token.source).toBe('default');
    expect(token.value).toBe('');
    expect(view.settings.find((entry) => entry.key === INTERVAL_KEY)?.value).toBe(8000);

    // 5) 日志只出现键名与原因，不含明文也不含密文
    const logged = lines.join('\n');
    expect(logged).toContain(TOKEN_KEY);
    expect(logged).toContain('解密失败');
    expect(logged).not.toContain('tskey-api-secret');
    expect(logged).not.toContain(cipher);
    expect(logged).not.toContain(ENCRYPTED_PREFIX);
  });

  it('密文被篡改（GCM 认证失败）时同样降级为未设置', async () => {
    const box = newBox();
    const { db } = initDatabase({ file: ':memory:' });
    const writer = makeFixture({ db, secretBox: box });
    await writer.service.update({ values: { [TOKEN_KEY]: 'tskey-api-tampered' }, actor: ACTOR, ip: null });

    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(tamper(rawValue(db, TOKEN_KEY)!), TOKEN_KEY);

    const reader = makeFixture({ db, secretBox: box });
    await expect(reader.service.initialize()).resolves.toBeUndefined();
    expect(reader.config.tailscale.apiToken).toBe('');
  });

  it('读不到值时不影响之后重新写入（用户重填即可恢复）', async () => {
    const { db } = initDatabase({ file: ':memory:' });
    const boxA = newBox();
    const boxB = newBox();
    const writer = makeFixture({ db, secretBox: boxA });
    await writer.service.update({ values: { [TOKEN_KEY]: 'tskey-api-old' }, actor: ACTOR, ip: null });

    const wrong = makeFixture({ db, secretBox: boxB });
    await wrong.service.initialize();
    expect(wrong.config.tailscale.apiToken).toBe('');

    // 用错密钥的一方重新填写 → 新值用当前（错的那把）密钥加密，从此可读
    await wrong.service.update({ values: { [TOKEN_KEY]: 'tskey-api-refilled' }, actor: ACTOR, ip: null });
    expect(wrong.config.tailscale.apiToken).toBe('tskey-api-refilled');
    expect(boxB.decrypt(rawValue(db, TOKEN_KEY)!)).toBe('tskey-api-refilled');
  });
});

// ------------------------------------------------------- 审计与日志不泄露

describe('settingsCrypto · 审计与日志', () => {
  it('审计只记键名（=***），日志与审计都不含明文/密文', async () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });
    const box = newBox();
    const { db, service } = makeFixture({ secretBox: box, logger });
    const secret = 'tskey-api-auditcheck-1234567890';

    await service.update({
      values: { [TOKEN_KEY]: secret, PORTAL_TAILSCALE_MODE: 'api' },
      actor: ACTOR,
      ip: '127.0.0.1',
    });

    const rows = db.prepare('SELECT detail FROM audit_log').all() as Array<{ detail: string | null }>;
    const auditText = rows.map((row) => row.detail ?? '').join(' | ');
    const cipher = rawValue(db, TOKEN_KEY)!;

    expect(auditText).toContain(`${TOKEN_KEY}=***`);
    expect(auditText).not.toContain(secret);
    expect(auditText).not.toContain(cipher);

    const logged = lines.join('\n');
    expect(logged).not.toContain(secret);
    expect(logged).not.toContain(cipher);
  });
});

// --------------------------------------------------------- 不传 secretBox

describe('settingsCrypto · 不传 secretBox（向后兼容）', () => {
  it('完全保持明文行为：落库即明文、读出即明文', async () => {
    const { db, config, service } = makeFixture();

    await service.update({ values: { [TOKEN_KEY]: 'tskey-api-plain' }, actor: ACTOR, ip: null });

    expect(rawValue(db, TOKEN_KEY)).toBe('tskey-api-plain');
    expect(config.tailscale.apiToken).toBe('tskey-api-plain');
    // 视图仍然打码（打码逻辑与加密无关）
    const view = await service.view();
    expect(view.settings.find((entry) => entry.key === TOKEN_KEY)?.value).toBe(`tskey-api-${MASK_TOKEN}`);
  });
});

// --------------------------------------------------- 装饰仓储的直测

describe('settingsCrypto · SecretSettingsStore', () => {
  it('多个敏感键的升级数量正确，非敏感键不参与；读出/写入双向透明', () => {
    const { db } = initDatabase({ file: ':memory:' });
    const base = new SettingsRepository(db);
    base.upsertMany([
      { key: 'TEST_SECRET_A', value: 'a-value', updatedBy: null },
      { key: 'TEST_SECRET_B', value: 'b-value', updatedBy: null },
      { key: 'TEST_PLAIN_C', value: 'c-value', updatedBy: null },
    ]);

    const box = newBox();
    const store = new SecretSettingsStore({
      base,
      secretBox: box,
      sensitiveKeys: new Set(['TEST_SECRET_A', 'TEST_SECRET_B']),
      logger: createSilentLogger(),
    });

    expect(store.reencryptAll()).toEqual({ upgraded: 2, failed: [] });
    expect(box.decrypt(base.get('TEST_SECRET_A')!)).toBe('a-value');
    expect(box.decrypt(base.get('TEST_SECRET_B')!)).toBe('b-value');
    expect(base.get('TEST_PLAIN_C')).toBe('c-value');

    // 读出侧透明：拿到的还是明文
    expect(store.get('TEST_SECRET_A')).toBe('a-value');
    expect(store.toMap().get('TEST_SECRET_B')).toBe('b-value');

    // 写入侧透明：落库是密文，返回给调用方的是明文
    const record = store.upsert({ key: 'TEST_SECRET_A', value: 'a2', updatedBy: 'admin' });
    expect(record.value).toBe('a2');
    expect(box.isEncrypted(base.get('TEST_SECRET_A')!)).toBe(true);
    expect(box.decrypt(base.get('TEST_SECRET_A')!)).toBe('a2');

    // 幂等
    expect(store.reencryptAll()).toEqual({ upgraded: 0, failed: [] });
  });

  it('解不开的行被读取侧剔除（视为未设置），但 reencryptAll 仍能看见它并记为失败', () => {
    const { db } = initDatabase({ file: ':memory:' });
    const base = new SettingsRepository(db);
    base.upsertMany([{ key: 'TEST_SECRET_A', value: 'plain-a', updatedBy: null }]);

    const writer = new SecretSettingsStore({
      base,
      secretBox: newBox(),
      sensitiveKeys: new Set(['TEST_SECRET_A']),
      logger: createSilentLogger(),
    });
    writer.upsert({ key: 'TEST_SECRET_A', value: 'encrypted-with-other-key', updatedBy: null });
    const cipherOfOtherKey = base.get('TEST_SECRET_A')!;

    const reader = new SecretSettingsStore({
      base,
      secretBox: newBox(),
      sensitiveKeys: new Set(['TEST_SECRET_A']),
      logger: createSilentLogger(),
    });

    expect(reader.get('TEST_SECRET_A')).toBeNull();
    expect(reader.list()).toEqual([]);
    expect(reader.reencryptAll()).toEqual({ upgraded: 0, failed: ['TEST_SECRET_A'] });
    // 失败不覆盖原值：数据仍留在库里，等密钥恢复或用户重填
    expect(base.get('TEST_SECRET_A')).toBe(cipherOfOtherKey);
  });
});