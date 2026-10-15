/**
 * 运行时设置的单测。
 *
 * 重点覆盖「三层优先级」与「生效级别」这两条容易写错、且错了会让用户困惑的规则：
 * 1. 数据库 > 环境变量 > 内置默认
 * 2. `restart` 级键在服务端就被拒绝（不能只在界面上藏起来）
 * 3. 未覆盖的项**不能**把 `.env` 里配好的值清空（真实踩过的 bug）
 * 4. `applyTo` 幂等
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { initDatabase } from '../src/db/database.js';
import { SettingsRepository } from '../src/db/settings.js';
import {
  MASK_TOKEN,
  applyTo,
  buildSettingDefinitions,
  maskSecret,
  parseSettingValue,
  resolveSettings,
  serializeSettingValue,
  settingsToMap,
  validateSettingValue,
} from '../src/modules/settings/registry.js';
import { effectiveMode, summarizeApiDevices } from '../src/modules/settings/tailscaleProbe.js';

const MANAGED_ENV = [
  'PORTAL_TAILSCALE_MODE',
  'PORTAL_TAILSCALE_API_TOKEN',
  'PORTAL_TAILSCALE_TAILNET',
  'PORTAL_METRICS_INTERVAL_MS',
  'PORTAL_DISK_MOUNTS',
  'PORTAL_TOOLS_EXTRA',
  'PORTAL_TOOLS_PROBE_HOST',
  'PORTAL_CACHE_CONTAINERS_TTL_MS',
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

/** 造一份测试用的 config + 空设置库。 */
function makeFixture(overrides: Parameters<typeof loadConfig>[0] = {}) {
  const config = loadConfig({
    env: 'test',
    dataDir: '/tmp/hp-settings-test',
    dbPath: ':memory:',
    ...overrides,
  });
  const { db } = initDatabase({ file: ':memory:' });
  const repository = new SettingsRepository(db);
  return { config, repository, db };
}

describe('settings/registry · 三层优先级', () => {
  it('无覆盖时使用内置默认值', () => {
    const { config, repository } = makeFixture();
    const resolved = resolveSettings({ config, repository });
    const mode = resolved.find((item) => item.definition.key === 'PORTAL_TAILSCALE_MODE');
    expect(mode?.value).toBe('auto');
    expect(mode?.source).toBe('default');
  });

  it('环境变量压过默认值', () => {
    const { config, repository } = makeFixture();
    process.env.PORTAL_TAILSCALE_MODE = 'cli';
    process.env.PORTAL_METRICS_INTERVAL_MS = '12345';
    const resolved = resolveSettings({ config, repository });
    const mode = resolved.find((item) => item.definition.key === 'PORTAL_TAILSCALE_MODE');
    const interval = resolved.find((item) => item.definition.key === 'PORTAL_METRICS_INTERVAL_MS');
    expect(mode?.value).toBe('cli');
    expect(mode?.source).toBe('env');
    // 数字类型被正确解析
    expect(interval?.value).toBe(12345);
    expect(typeof interval?.value).toBe('number');
  });

  it('数据库覆盖压过环境变量', () => {
    const { config, repository } = makeFixture();
    process.env.PORTAL_TAILSCALE_MODE = 'cli';
    repository.upsertMany([{ key: 'PORTAL_TAILSCALE_MODE', value: 'api', updatedBy: 'admin' }]);
    const resolved = resolveSettings({ config, repository });
    const mode = resolved.find((item) => item.definition.key === 'PORTAL_TAILSCALE_MODE');
    expect(mode?.value).toBe('api');
    expect(mode?.source).toBe('database');
    // 同时能看到环境变量原值，便于界面展示"被覆盖了什么"
    expect(mode?.envValue).toBe('cli');
  });

  it('删除数据库覆盖后回退到环境变量', () => {
    const { config, repository } = makeFixture();
    process.env.PORTAL_TAILSCALE_MODE = 'cli';
    repository.upsertMany([{ key: 'PORTAL_TAILSCALE_MODE', value: 'api', updatedBy: 'admin' }]);
    repository.delete('PORTAL_TAILSCALE_MODE');
    const resolved = resolveSettings({ config, repository });
    const mode = resolved.find((item) => item.definition.key === 'PORTAL_TAILSCALE_MODE');
    expect(mode?.value).toBe('cli');
    expect(mode?.source).toBe('env');
  });

  it('环境变量里的非法值被忽略（回退默认，不污染配置）', () => {
    const { config, repository } = makeFixture();
    process.env.PORTAL_TAILSCALE_MODE = 'nonsense';
    const resolved = resolveSettings({ config, repository });
    const mode = resolved.find((item) => item.definition.key === 'PORTAL_TAILSCALE_MODE');
    expect(mode?.value).toBe('auto');
    expect(mode?.source).toBe('default');
  });

  it('数据库里的非法值被忽略（清掉脏数据不会让服务起不来）', () => {
    const { config, repository } = makeFixture();
    repository.upsertMany([{ key: 'PORTAL_METRICS_INTERVAL_MS', value: 'not-a-number', updatedBy: 'admin' }]);
    const resolved = resolveSettings({ config, repository });
    const interval = resolved.find((item) => item.definition.key === 'PORTAL_METRICS_INTERVAL_MS');
    expect(interval?.source).toBe('default');
    expect(interval?.value).toBe(3000);
  });
});

describe('settings/registry · 校验', () => {
  it('拒绝修改 restart 级键，并给出原因', () => {
    const { config } = makeFixture();
    const definitions = buildSettingDefinitions(config);
    for (const key of ['PORTAL_LOG_LEVEL', 'PORTAL_PORT', 'PORTAL_SECURE_COOKIES', 'PORTAL_DATA_DIR']) {
      const definition = definitions.find((item) => item.key === key);
      expect(definition, `${key} 应存在于注册表`).toBeDefined();
      expect(definition?.effect).toBe('restart');
      const result = validateSettingValue(definition!, 'x');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('重建容器');
    }
  });

  it('数字范围校验', () => {
    const { config } = makeFixture();
    const definitions = buildSettingDefinitions(config);
    const interval = definitions.find((item) => item.key === 'PORTAL_METRICS_INTERVAL_MS')!;
    expect(validateSettingValue(interval, 100).ok).toBe(false); // < 500
    expect(validateSettingValue(interval, 999999).ok).toBe(false); // > 60000
    expect(validateSettingValue(interval, 5000)).toEqual({ ok: true, serialized: '5000' });
    expect(validateSettingValue(interval, 5000.5).ok).toBe(false); // 非整数
    expect(validateSettingValue(interval, 'abc').ok).toBe(false);
  });

  it('布尔值接受多种写法', () => {
    const { config } = makeFixture();
    const definition = buildSettingDefinitions(config).find((item) => item.key === 'PORTAL_DOCKER_INCLUDE_STOPPED')!;
    expect(validateSettingValue(definition, true)).toEqual({ ok: true, serialized: '1' });
    expect(validateSettingValue(definition, false)).toEqual({ ok: true, serialized: '0' });
    expect(validateSettingValue(definition, 'true')).toEqual({ ok: true, serialized: '1' });
    expect(validateSettingValue(definition, 'no')).toEqual({ ok: true, serialized: '0' });
    expect(validateSettingValue(definition, 'maybe').ok).toBe(false);
  });

  it('枚举只接受声明过的值', () => {
    const { config } = makeFixture();
    const definition = buildSettingDefinitions(config).find((item) => item.key === 'PORTAL_TAILSCALE_MODE')!;
    expect(validateSettingValue(definition, 'api').ok).toBe(true);
    expect(validateSettingValue(definition, 'API').ok).toBe(false); // 大小写敏感
    expect(validateSettingValue(definition, 'bogus').ok).toBe(false);
  });

  it('DOCKER_ENDPOINT 校验地址形式', () => {
    const { config } = makeFixture();
    const definition = buildSettingDefinitions(config).find((item) => item.key === 'DOCKER_ENDPOINT')!;
    expect(validateSettingValue(definition, 'unix:///var/run/docker.sock').ok).toBe(true);
    expect(validateSettingValue(definition, 'npipe:////./pipe/x').ok).toBe(true);
    expect(validateSettingValue(definition, '/var/run/docker.sock').ok).toBe(true);
    expect(validateSettingValue(definition, 'docker.sock').ok).toBe(false); // 缺协议与绝对路径
  });

  it('PORTAL_DISK_MOUNTS 复用了 config 的语法规则', () => {
    const { config } = makeFixture();
    const definition = buildSettingDefinitions(config).find((item) => item.key === 'PORTAL_DISK_MOUNTS')!;
    expect(validateSettingValue(definition, 'C:=/host/disk/C').ok).toBe(true);
    expect(validateSettingValue(definition, 'C:=/host/disk/C,D:=/host/disk/D').ok).toBe(true);
    // 缺少 = 必须被拒（与 config.parseMounts 一致）
    const missingEq = validateSettingValue(definition, 'onlypath');
    expect(missingEq.ok).toBe(false);
    expect(missingEq.error).toContain('=');
    expect(validateSettingValue(definition, '=/host/x').ok).toBe(false);
    // 空值合法 = 清空挂载点
    expect(validateSettingValue(definition, '').ok).toBe(true);
  });

  it('路径类字段要求绝对路径', () => {
    const { config } = makeFixture();
    const definitions = buildSettingDefinitions(config);
    expect(validateSettingValue(definitions.find((d) => d.key === 'PORTAL_NVIDIA_SMI')!, 'nvidia-smi').ok).toBe(false);
    expect(validateSettingValue(definitions.find((d) => d.key === 'PORTAL_NVIDIA_SMI')!, '/usr/bin/nvidia-smi').ok).toBe(true);
    expect(validateSettingValue(definitions.find((d) => d.key === 'PORTAL_TOOLS_FILE')!, 'tools.json').ok).toBe(false);
    expect(validateSettingValue(definitions.find((d) => d.key === 'PORTAL_TOOLS_FILE')!, '/config/tools.json').ok).toBe(true);
  });
});

describe('settings/registry · applyTo', () => {
  it('把值写回 config 并报告变更键', () => {
    const { config, repository } = makeFixture();
    repository.upsertMany([
      { key: 'PORTAL_TAILSCALE_MODE', value: 'api', updatedBy: 'admin' },
      { key: 'PORTAL_TAILSCALE_API_TOKEN', value: 'tskey-api-secret', updatedBy: 'admin' },
      { key: 'PORTAL_METRICS_INTERVAL_MS', value: '7000', updatedBy: 'admin' },
    ]);
    const resolved = resolveSettings({ config, repository });
    const result = applyTo(config, settingsToMap(resolved), new Set(repository.list().map((r) => r.key)));

    expect(config.tailscale.mode).toBe('api');
    expect(config.tailscale.apiToken).toBe('tskey-api-secret');
    expect(config.system.metricsIntervalMs).toBe(7000);
    expect(result.changedKeys).toContain('PORTAL_TAILSCALE_MODE');
    expect(result.changedKeys).toContain('PORTAL_TAILSCALE_API_TOKEN');
    expect(result.changedKeys).toContain('PORTAL_METRICS_INTERVAL_MS');
    // 改了 Token/模式 → 需要重建 tailnet 数据源
    expect(result.reloadTailscale).toBe(true);
  });

  it('DOCKER_ENDPOINT 变化时要求重建 Docker 连接', () => {
    const { config, repository } = makeFixture();
    repository.upsertMany([{ key: 'DOCKER_ENDPOINT', value: 'tcp://other:2375', updatedBy: 'admin' }]);
    const resolved = resolveSettings({ config, repository });
    const result = applyTo(config, settingsToMap(resolved), new Set(repository.list().map((r) => r.key)));
    expect(config.docker.endpoint).toBe('tcp://other:2375');
    expect(result.reloadDocker).toBe(true);
  });

  it('restart 级键被跳过，不写回 config', () => {
    const { config, repository } = makeFixture();
    repository.upsertMany([{ key: 'PORTAL_PORT', value: '9999', updatedBy: 'admin' }]);
    const resolved = resolveSettings({ config, repository });
    const result = applyTo(config, settingsToMap(resolved), new Set(repository.list().map((r) => r.key)));
    expect(config.port).toBe(8899);
    expect(result.skippedKeys).toContain('PORTAL_PORT');
  });

  it('**未覆盖 PORTAL_DISK_MOUNTS 时不清空已配置的挂载点**（回归 bug）', () => {
    // .env / 平台默认给了 C:=/host/disk/C
    const { config, repository } = makeFixture({ system: {
      procPath: '/host/proc',
      nvidiaSmi: '/usr/local/bin/nvidia-smi',
      ldLibraryPath: '',
      mounts: [{ path: 'C:', containerPath: '/host/disk/C', label: 'C', statPath: '/host/disk/C', readOnly: true }],
      metricsIntervalMs: 3000,
      commandTimeoutMs: 5000,
    } });
    expect(config.system.mounts).toHaveLength(1);

    const resolved = resolveSettings({ config, repository });
    applyTo(config, settingsToMap(resolved), new Set());
    // 关键断言：没有被未设置的空默认值清空
    expect(config.system.mounts).toHaveLength(1);
    expect(config.system.mounts[0]?.path).toBe('C:');
  });

  it('显式覆盖 PORTAL_DISK_MOUNTS 为空字符串才清空', () => {
    const { config, repository } = makeFixture();
    repository.upsertMany([{ key: 'PORTAL_DISK_MOUNTS', value: '', updatedBy: 'admin' }]);
    const resolved = resolveSettings({ config, repository });
    applyTo(config, settingsToMap(resolved), new Set(repository.list().map((r) => r.key)));
    expect(config.system.mounts).toEqual([]);
  });

  it('覆盖 PORTAL_DISK_MOUNTS 为具体路径时正确解析（含标签）', () => {
    const { config, repository } = makeFixture();
    repository.upsertMany([
      { key: 'PORTAL_DISK_MOUNTS', value: '/volume1=/host/volume1|存储池1', updatedBy: 'admin' },
    ]);
    const resolved = resolveSettings({ config, repository });
    applyTo(config, settingsToMap(resolved), new Set(repository.list().map((r) => r.key)));
    expect(config.system.mounts).toHaveLength(1);
    expect(config.system.mounts[0]).toMatchObject({
      path: '/volume1',
      containerPath: '/host/volume1',
      label: '存储池1',
      statPath: '/host/volume1',
    });
  });

  it('applyTo 幂等：第二次调用不报告任何变更', () => {
    const { config, repository } = makeFixture();
    repository.upsertMany([
      { key: 'PORTAL_TAILSCALE_MODE', value: 'api', updatedBy: 'admin' },
      { key: 'PORTAL_METRICS_INTERVAL_MS', value: '4321', updatedBy: 'admin' },
      { key: 'PORTAL_DISK_MOUNTS', value: 'C:=/host/disk/C', updatedBy: 'admin' },
    ]);
    const overridden = new Set(repository.list().map((r) => r.key));
    const resolved = resolveSettings({ config, repository });

    const first = applyTo(config, settingsToMap(resolved), overridden);
    const second = applyTo(config, settingsToMap(resolved), overridden);
    expect(first.changedKeys.length).toBeGreaterThan(0);
    expect(second.changedKeys).toEqual([]);
    expect(second.reloadTailscale).toBe(false);
    expect(second.reloadDocker).toBe(false);
  });
});

describe('settings/registry · 序列化与打码', () => {
  it('字符串值解析与序列化往返', () => {
    const { config } = makeFixture();
    const definition = buildSettingDefinitions(config).find((item) => item.key === 'PORTAL_HOST_PROC')!;
    expect(parseSettingValue(definition, '/host/proc')).toBe('/host/proc');
    expect(serializeSettingValue(definition, '/host/proc')).toBe('/host/proc');
  });

  it('布尔值序列化为 1/0（与环境变量写法一致）', () => {
    const { config } = makeFixture();
    const definition = buildSettingDefinitions(config).find((item) => item.key === 'PORTAL_DOCKER_INCLUDE_STOPPED')!;
    expect(serializeSettingValue(definition, true)).toBe('1');
    expect(serializeSettingValue(definition, false)).toBe('0');
  });

  it('敏感值打码保留可识别前缀', () => {
    expect(maskSecret('tskey-api-k1234567890abcdef')).toBe(`tskey-api-${MASK_TOKEN}`);
    expect(maskSecret('short')).toBe(MASK_TOKEN);
    expect(maskSecret('')).toBe('');
    // 非 tskey 前缀的长值只留前 4 位
    expect(maskSecret('abcdefghijklmnop')).toBe(`abcd${MASK_TOKEN}`);
  });

  it('打码后的值不会再包含原密钥内容', () => {
    const secret = 'tskey-api-verysecretvalue123';
    const masked = maskSecret(secret);
    expect(masked).not.toContain('verysecretvalue123');
  });
});

describe('settings · tailscale 连通性测试的纯逻辑', () => {
  it('auto 模式按是否有 Token 决定走 api 还是 cli', () => {
    expect(effectiveMode('auto', true)).toBe('api');
    expect(effectiveMode('auto', false)).toBe('cli');
    expect(effectiveMode('off', true)).toBe('off');
    expect(effectiveMode('cli', true)).toBe('cli');
    expect(effectiveMode('api', false)).toBe('api');
  });

  it('设备摘要只取前 N 台并挑出 IPv4', () => {
    const devices = Array.from({ length: 8 }, (_, index) => ({
      hostname: `host-${index}`,
      os: 'linux',
      connectedToControl: index % 2 === 0,
      addresses: ['fd7a::1', `100.64.0.${index + 1}`],
    }));
    const summary = summarizeApiDevices(devices, 5);
    expect(summary).toHaveLength(5);
    expect(summary[0]).toEqual({ hostname: 'host-0', os: 'linux', online: true, ipv4: '100.64.0.1' });
    expect(summary[1]?.online).toBe(false);
  });

  it('缺少 hostname 时回退到 MagicDNS 名的第一段', () => {
    const summary = summarizeApiDevices([{ name: 'my-nas.tail123.ts.net', addresses: ['100.1.1.1'] }]);
    expect(summary[0]?.hostname).toBe('my-nas');
  });
});
