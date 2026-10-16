/**
 * 运行时设置注册表。
 *
 * ## 三层优先级
 *
 * ```
 * 数据库覆盖（管理员在界面里改的）  >  环境变量（.env / compose）  >  内置默认值
 * ```
 *
 * 未在数据库中覆盖的键走环境变量；环境变量也没设则用内置默认。
 * 这样 `.env` 部署方式完全不受影响，同时管理员能在界面里临时调整。
 *
 * ## 生效级别（这是容器架构的硬边界，必须诚实区分）
 *
 * | 级别 | 含义 |
 * | --- | --- |
 * | `live` | 下次读取即生效（TTL、超时、间隔、目录等纯数据项） |
 * | `reload` | 保存后自动重建对应数据源连接，立即生效（Tailscale / Docker） |
 * | `restart` | **改不了**，必须重建容器。因为它是容器创建参数或引导期配置 |
 *
 * `restart` 级别的键在 `applyTo()` 里被显式忽略 —— 界面只展示当前值并说明原因，
 * 不给出可编辑控件，避免误导用户以为改了就生效。
 */
import path from 'node:path';
import type { PortalConfig } from '../../config.js';
import type { SettingsStore } from '../../db/settings.js';

/** 生效级别。 */
export type SettingEffect = 'live' | 'reload' | 'restart';

/** 值的类型（用于前端渲染合适的控件）。 */
export type SettingValueType = 'string' | 'number' | 'boolean' | 'enum' | 'string-list';

/** 设置项所属分组（前端按此分区展示）。 */
export type SettingGroup = 'tailscale' | 'docker' | 'system' | 'tools' | 'performance' | 'boot';

export interface SettingDefinition {
  /** 稳定键名，等于环境变量名（便于对照） */
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  effect: SettingEffect;
  valueType: SettingValueType;
  /** 环境变量名（通常等于 key） */
  envVar: string;
  /** 内置默认值（与环境变量未设时的行为一致） */
  defaultValue: unknown;
  /** 可选值（valueType 为 enum 时必填） */
  choices?: Array<{ value: string; label: string }>;
  /** 最低值（number） */
  min?: number;
  /** 最高值（number） */
  max?: number;
  /** 单位（number，仅展示用） */
  unit?: string;
  /**
   * 值是否敏感（如 Token）。
   * 敏感项的读取会被打码，但允许写入。
   */
  sensitive?: boolean;
  /** `restart` 级别的键：说明为什么改不了 */
  restartReason?: string;
}

/** 传输给前端的一项设置。 */
export interface SettingView {
  key: string;
  group: SettingGroup;
  label: string;
  description: string;
  effect: SettingEffect;
  valueType: SettingValueType;
  envVar: string;
  /** 当前生效值（敏感项打码） */
  value: unknown;
  /** 是否被打码（前端据此用密码框/占位符） */
  masked: boolean;
  /** 当前值的来源 */
  source: 'default' | 'env' | 'database';
  /** 内置默认值 */
  defaultValue: unknown;
  /** 环境变量里的原始值（未设置则为 null） */
  envValue: string | null;
  /** 数据库覆盖值（敏感项打码；未覆盖为 null） */
  databaseValue: unknown;
  choices?: Array<{ value: string; label: string }>;
  min?: number;
  max?: number;
  unit?: string;
  sensitive?: boolean;
  restartReason?: string;
  /** 最后修改时间与修改者（仅数据库覆盖时存在） */
  updatedAt?: string;
  updatedBy?: string | null;
  /** 保存在界面里是否真的能生效（false = 需重建容器） */
  editable: boolean;
}

/** 敏感值的打码占位符。前端提交该值时表示"不要修改此项"。 */
export const MASK_TOKEN = '********';

/** 分组的中文标题与说明（前端直接使用）。 */
export const SETTING_GROUPS: ReadonlyArray<{ id: SettingGroup; label: string; description: string }> = [
  {
    id: 'tailscale',
    label: 'tailnet 数据源',
    description: '查询 tailnet 设备与在线状态。Windows 容器化部署必须用 API 模式（容器内无法执行 tailscale.exe）。',
  },
  {
    id: 'docker',
    label: 'Docker 数据源',
    description: '读取容器清单。容器内应使用 unix socket；Docker Desktop 会把 Windows named pipe 转发过来。',
  },
  {
    id: 'system',
    label: '系统指标',
    description: 'CPU / 内存 / 磁盘 / GPU 的采集方式与频率。',
  },
  {
    id: 'tools',
    label: '工具入口探测',
    description: 'Ollama / ComfyUI 等本机工具的可用性探测行为。',
  },
  {
    id: 'performance',
    label: '缓存与超时',
    description: '调大缓存可降低宿主机压力；调小则数据更新更快。',
  },
  {
    id: 'boot',
    label: '引导期配置（只读）',
    description: '这些是容器创建参数或启动前必须确定的项，改动需要重建容器，此处仅展示当前值。',
  },
];

// ---------------------------------------------------------------- 默认值

/** 默认工具目录文件路径：仓库根的 tools-catalog.json（若存在） */
function defaultToolsFile(config: PortalConfig): string {
  return config.tools.catalogFile ?? '';
}

/** 默认 nvidia-smi 路径。 */
const DEFAULT_NVIDIA_SMI = '/usr/local/bin/nvidia-smi';

/**
 * 设置定义表。**顺序即界面展示顺序**。
 *
 * 新增设置项时：
 * 1. 在此表登记（含 effect 与默认值）
 * 2. 若是 `live`/`reload` 级别，在 `applyTo()` 里写到 config 上
 * 3. 同步更新 docs/static/02-configuration.md
 */
export function buildSettingDefinitions(config: PortalConfig): SettingDefinition[] {
  return [
    // ---------------------------------------------------------- tailscale
    {
      key: 'PORTAL_TAILSCALE_MODE',
      group: 'tailscale',
      label: '数据源模式',
      description:
        'auto = 有 API Token 就用 API，否则用 CLI。Windows 容器化部署请选 api（容器内执行不了 tailscale.exe）。',
      effect: 'reload',
      valueType: 'enum',
      envVar: 'PORTAL_TAILSCALE_MODE',
      defaultValue: 'auto',
      choices: [
        { value: 'auto', label: '自动（推荐）' },
        { value: 'api', label: 'API（云端查询，需要 Token）' },
        { value: 'cli', label: 'CLI（调用宿主 tailscale，Linux/NAS）' },
        { value: 'off', label: '关闭' },
      ],
    },
    {
      key: 'PORTAL_TAILSCALE_API_TOKEN',
      group: 'tailscale',
      label: 'API Token',
      description:
        '在 Tailscale 管理后台 → Settings → Keys → Generate access token 生成，形如 tskey-api-xxx，只显示一次。保存后立即生效，无需重建容器。',
      effect: 'reload',
      valueType: 'string',
      envVar: 'PORTAL_TAILSCALE_API_TOKEN',
      defaultValue: '',
      sensitive: true,
    },
    {
      key: 'PORTAL_TAILSCALE_TAILNET',
      group: 'tailscale',
      label: 'tailnet 标识',
      description: 'API 模式下的 tailnet，默认 - 表示当前 Token 所属的 tailnet。',
      effect: 'reload',
      valueType: 'string',
      envVar: 'PORTAL_TAILSCALE_TAILNET',
      defaultValue: '-',
    },
    {
      key: 'PORTAL_TAILSCALE_BIN',
      group: 'tailscale',
      label: 'CLI 路径',
      description: 'CLI 模式下 tailscale 可执行文件在容器内的路径。',
      effect: 'reload',
      valueType: 'string',
      envVar: 'PORTAL_TAILSCALE_BIN',
      defaultValue: 'tailscale',
    },
    {
      key: 'PORTAL_TAILSCALE_SOCKET',
      group: 'tailscale',
      label: 'tailscaled socket',
      description: '非默认值时会给 tailscale 命令追加 --socket 参数。',
      effect: 'reload',
      valueType: 'string',
      envVar: 'PORTAL_TAILSCALE_SOCKET',
      defaultValue: '/var/run/tailscale/tailscaled.sock',
    },
    {
      key: 'PORTAL_TAILSCALE_TIMEOUT_MS',
      group: 'tailscale',
      label: '查询超时',
      description: 'CLI 命令或 API 请求的超时时间。',
      effect: 'live',
      valueType: 'number',
      envVar: 'PORTAL_TAILSCALE_TIMEOUT_MS',
      defaultValue: 5000,
      min: 500,
      max: 30000,
      unit: 'ms',
    },

    // ------------------------------------------------------------- docker
    {
      key: 'DOCKER_ENDPOINT',
      group: 'docker',
      label: '引擎地址',
      description:
        '容器内应保持 unix:///var/run/docker.sock。Docker Desktop 会把 Windows named pipe 转发为这个 socket；写成 npipe:// 会报 ENOENT。',
      effect: 'reload',
      valueType: 'string',
      envVar: 'DOCKER_ENDPOINT',
      defaultValue: '/var/run/docker.sock',
    },
    {
      key: 'PORTAL_DOCKER_INCLUDE_STOPPED',
      group: 'docker',
      label: '默认包含已停止容器',
      description: '仅影响接口默认值，页面上仍可临时切换。',
      effect: 'live',
      valueType: 'boolean',
      envVar: 'PORTAL_DOCKER_INCLUDE_STOPPED',
      defaultValue: true,
    },
    {
      key: 'PORTAL_DOCKER_STATS_TIMEOUT_MS',
      group: 'docker',
      label: 'stats 超时',
      description: '读取容器实时占用（docker stats）的超时时间。',
      effect: 'live',
      valueType: 'number',
      envVar: 'PORTAL_DOCKER_STATS_TIMEOUT_MS',
      defaultValue: 4000,
      min: 500,
      max: 30000,
      unit: 'ms',
    },

    // ------------------------------------------------------------- system
    {
      key: 'PORTAL_HOST_PROC',
      group: 'system',
      label: '宿主 /proc 挂载点',
      description:
        'Linux/NAS 挂载宿主 /proc 到该路径以获得真实 CPU/内存。Windows 上挂载 /proc 无效（与 os.cpus() 同源）。',
      effect: 'live',
      valueType: 'string',
      envVar: 'PORTAL_HOST_PROC',
      defaultValue: '/host/proc',
    },
    {
      key: 'PORTAL_METRICS_INTERVAL_MS',
      group: 'system',
      label: '指标推送间隔',
      description: 'SSE 实时指标的推送频率。NAS 性能弱时可调大。',
      effect: 'live',
      valueType: 'number',
      envVar: 'PORTAL_METRICS_INTERVAL_MS',
      defaultValue: 3000,
      min: 500,
      max: 60000,
      unit: 'ms',
    },
    {
      key: 'PORTAL_NVIDIA_SMI',
      group: 'system',
      label: 'nvidia-smi 路径',
      description:
        '容器内的 nvidia-smi 路径。Windows 容器化下无法读取 GPU（看不到 /usr/lib/wsl/lib，也不能执行 .exe）。',
      effect: 'live',
      valueType: 'string',
      envVar: 'PORTAL_NVIDIA_SMI',
      defaultValue: DEFAULT_NVIDIA_SMI,
    },
    {
      key: 'PORTAL_NVIDIA_LD_LIBRARY_PATH',
      group: 'system',
      label: 'GPU 库搜索路径',
      description: '追加到 LD_LIBRARY_PATH，WSL 下通常为 /usr/lib/wsl/lib。',
      effect: 'live',
      valueType: 'string',
      envVar: 'PORTAL_NVIDIA_LD_LIBRARY_PATH',
      defaultValue: '',
    },
    {
      key: 'PORTAL_COMMAND_TIMEOUT_MS',
      group: 'system',
      label: '外部命令超时',
      description: 'nvidia-smi、df 等外部命令的超时时间。',
      effect: 'live',
      valueType: 'number',
      envVar: 'PORTAL_COMMAND_TIMEOUT_MS',
      defaultValue: 5000,
      min: 500,
      max: 30000,
      unit: 'ms',
    },
    {
      key: 'PORTAL_DISK_MOUNTS',
      group: 'system',
      label: '磁盘挂载点',
      description:
        '语法：展示路径=容器内路径[|标签[|statfs路径]]，逗号分隔。注意：这里只能调整"显示哪些/怎么标注"，路径本身必须已经挂进容器。',
      effect: 'live',
      valueType: 'string-list',
      envVar: 'PORTAL_DISK_MOUNTS',
      defaultValue: '',
    },

    // -------------------------------------------------------------- tools
    {
      key: 'PORTAL_TOOLS_FILE',
      group: 'tools',
      label: '工具目录 JSON 路径',
      description: '容器内的 JSON 文件路径，用于覆盖内置工具目录。留空则只用内置目录与下方追加项。',
      effect: 'live',
      valueType: 'string',
      envVar: 'PORTAL_TOOLS_FILE',
      defaultValue: defaultToolsFile(config),
    },
    {
      key: 'PORTAL_TOOLS_EXTRA',
      group: 'tools',
      label: '追加工具',
      description: '格式 id:名称:端口，逗号分隔。例如 immich:Immich:2283,jellyfin:Jellyfin:8096',
      effect: 'live',
      valueType: 'string-list',
      envVar: 'PORTAL_TOOLS_EXTRA',
      defaultValue: '',
    },
    {
      key: 'PORTAL_TOOLS_PROBE_HOST',
      group: 'tools',
      label: '强制探测目标主机',
      description:
        '一般不用填。留空时自动按「门户对外主机名 → host.docker.internal → 127.0.0.1」依次尝试。',
      effect: 'live',
      valueType: 'string',
      envVar: 'PORTAL_TOOLS_PROBE_HOST',
      defaultValue: '',
    },
    {
      key: 'PORTAL_TOOLS_PROBE_TIMEOUT_MS',
      group: 'tools',
      label: '探测超时',
      description: '单个工具的 TCP/HTTP 探测超时。',
      effect: 'live',
      valueType: 'number',
      envVar: 'PORTAL_TOOLS_PROBE_TIMEOUT_MS',
      defaultValue: 1500,
      min: 200,
      max: 15000,
      unit: 'ms',
    },
    {
      key: 'PORTAL_TOOLS_PROBE_TTL_MS',
      group: 'tools',
      label: '探测结果缓存',
      description: '调小则状态更新更快，但探测更频繁。',
      effect: 'live',
      valueType: 'number',
      envVar: 'PORTAL_TOOLS_PROBE_TTL_MS',
      defaultValue: 10000,
      min: 1000,
      max: 300000,
      unit: 'ms',
    },

    // -------------------------------------------------------- performance
    {
      key: 'PORTAL_CACHE_CONTAINERS_TTL_MS',
      group: 'performance',
      label: '容器列表缓存',
      description: '容器多（>30）时可调大以减少 docker inspect 次数。',
      effect: 'live',
      valueType: 'number',
      envVar: 'PORTAL_CACHE_CONTAINERS_TTL_MS',
      defaultValue: 2000,
      min: 0,
      max: 60000,
      unit: 'ms',
    },
    {
      key: 'PORTAL_CACHE_TAILSCALE_TTL_MS',
      group: 'performance',
      label: 'tailnet 状态缓存',
      description: '避免频繁调用 tailscale 命令或 API。',
      effect: 'live',
      valueType: 'number',
      envVar: 'PORTAL_CACHE_TAILSCALE_TTL_MS',
      defaultValue: 5000,
      min: 0,
      max: 120000,
      unit: 'ms',
    },
    {
      key: 'PORTAL_LOG_LEVEL',
      group: 'performance',
      label: '日志级别',
      description: '改为 debug 可查看探测与数据源的详细过程，用于排障。',
      effect: 'restart',
      valueType: 'enum',
      envVar: 'PORTAL_LOG_LEVEL',
      defaultValue: 'info',
      choices: [
        { value: 'debug', label: 'debug' },
        { value: 'info', label: 'info' },
        { value: 'warn', label: 'warn' },
        { value: 'error', label: 'error' },
      ],
      restartReason: '日志器在进程启动时创建，改为 debug 需重建容器（docker compose up -d --force-recreate）。',
    },

    // --------------------------------------------------------------- boot
    {
      key: 'PORTAL_PORT',
      group: 'boot',
      label: '容器内监听端口',
      description: '容器内监听端口。改变它与宿主端口的映射需要重建容器。',
      effect: 'restart',
      valueType: 'number',
      envVar: 'PORTAL_PORT',
      defaultValue: 8899,
      restartReason: '监听端口属于容器创建参数，需修改 compose 的 ports 并重建容器。',
    },
    {
      key: 'PORTAL_SESSION_TTL_HOURS',
      group: 'boot',
      label: '会话有效期',
      description: '常规登录会话的有效小时数。',
      effect: 'restart',
      valueType: 'number',
      envVar: 'PORTAL_SESSION_TTL_HOURS',
      defaultValue: 12,
      restartReason: '会话策略在启动时读取，改动需重建容器。',
    },
    {
      key: 'PORTAL_SECURE_COOKIES',
      group: 'boot',
      label: 'HTTPS Cookie',
      description: '部署在 HTTPS 反代之后时置 1，会话 Cookie 会带 Secure 属性。',
      effect: 'restart',
      valueType: 'boolean',
      envVar: 'PORTAL_SECURE_COOKIES',
      defaultValue: false,
      restartReason: 'Cookie 属性在启动时确定，改动需重建容器。',
    },
    {
      key: 'PORTAL_PUBLIC_HOST',
      group: 'boot',
      label: '门户公开主机名',
      description: '留空时按访问者请求头自动推导，通常无需设置。',
      effect: 'live',
      valueType: 'string',
      envVar: 'PORTAL_PUBLIC_HOST',
      defaultValue: '',
    },
    {
      key: 'PORTAL_DATA_DIR',
      group: 'boot',
      label: '数据目录',
      description: 'SQLite 与首启令牌所在目录（容器内）。',
      effect: 'restart',
      valueType: 'string',
      envVar: 'PORTAL_DATA_DIR',
      defaultValue: '/data',
      restartReason: '数据库连接在启动时建立，改动需重建容器并迁移数据。',
    },
  ];
}

// ---------------------------------------------------------------- 解析

/** 把字符串解析为设置项对应的类型。解析失败返回 null。 */
export function parseSettingValue(definition: SettingDefinition, raw: string): unknown {
  const trimmed = raw.trim();
  switch (definition.valueType) {
    case 'number': {
      if (trimmed === '') return null;
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed)) return null;
      if (definition.min !== undefined && parsed < definition.min) return null;
      if (definition.max !== undefined && parsed > definition.max) return null;
      return parsed;
    }
    case 'boolean': {
      const lowered = trimmed.toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
      if (['0', 'false', 'no', 'off', ''].includes(lowered)) return false;
      return null;
    }
    case 'enum': {
      const allowed = (definition.choices ?? []).map((c) => c.value);
      return allowed.includes(trimmed) ? trimmed : null;
    }
    case 'string-list':
      return trimmed;
    default:
      return raw;
  }
}

/** 把类型化值序列化为数据库/环境变量用的字符串。 */
export function serializeSettingValue(definition: SettingDefinition, value: unknown): string {
  switch (definition.valueType) {
    case 'boolean':
      return value === true || value === 'true' || value === '1' ? '1' : '0';
    case 'number':
      return String(value);
    default:
      return typeof value === 'string' ? value : String(value ?? '');
  }
}

/** 校验并规范化一个待写入的值。 */
export interface ValidationResult {
  ok: boolean;
  /** 规范化后的字符串值（ok 时存在） */
  serialized?: string;
  /** 错误信息 */
  error?: string;
}

export function validateSettingValue(definition: SettingDefinition, input: unknown): ValidationResult {
  if (definition.effect === 'restart') {
    return { ok: false, error: '该项需要重建容器才能生效，不支持在界面中修改' };
  }

  if (definition.valueType === 'boolean') {
    if (typeof input === 'boolean') return { ok: true, serialized: input ? '1' : '0' };
    const parsed = parseSettingValue(definition, String(input));
    if (parsed === null) return { ok: false, error: '必须是布尔值（true/false 或 1/0）' };
    return { ok: true, serialized: serializeSettingValue(definition, parsed) };
  }

  if (definition.valueType === 'number') {
    const parsed = Number(input);
    if (!Number.isFinite(parsed)) return { ok: false, error: '必须是数字' };
    if (definition.min !== undefined && parsed < definition.min) {
      return { ok: false, error: `不能小于 ${definition.min}${definition.unit ?? ''}` };
    }
    if (definition.max !== undefined && parsed > definition.max) {
      return { ok: false, error: `不能大于 ${definition.max}${definition.unit ?? ''}` };
    }
    if (!Number.isInteger(parsed)) return { ok: false, error: '必须是整数' };
    return { ok: true, serialized: String(parsed) };
  }

  if (definition.valueType === 'enum') {
    const value = String(input ?? '').trim();
    const allowed = (definition.choices ?? []).map((c) => c.value);
    if (!allowed.includes(value)) {
      return { ok: false, error: `只能是：${allowed.join(' / ')}` };
    }
    return { ok: true, serialized: value };
  }

  // string / string-list
  const value = String(input ?? '');
  if (value.length > 4096) return { ok: false, error: '内容过长（上限 4096 字符）' };

  // endpoint 形式的基本校验，避免填错后整块功能静默失效
  if (definition.key === 'DOCKER_ENDPOINT') {
    const ok =
      value.startsWith('unix://') ||
      value.startsWith('npipe://') ||
      value.startsWith('tcp://') ||
      value.startsWith('http://') ||
      value.startsWith('https://') ||
      value.startsWith('/') ||
      value.startsWith('//');
    if (!ok) {
      return { ok: false, error: '必须是 unix:// 或 npipe:// 或 tcp:// 开头的地址，或绝对路径' };
    }
  }
  if (definition.key === 'PORTAL_DISK_MOUNTS' && value.trim() !== '') {
    // 复用 config.parseMounts 的校验规则：必须显式写 =
    for (const entry of value.split(',').map((s) => s.trim()).filter(Boolean)) {
      const pair = entry.split('|')[0] ?? '';
      if (!pair.includes('=')) {
        return { ok: false, error: `条目 "${entry}" 缺少 "="，应为 展示路径=容器内路径` };
      }
      const [left, right] = pair.split('=');
      if (!(left ?? '').trim() || !(right ?? '').trim()) {
        return { ok: false, error: `条目 "${entry}" 的展示路径或容器内路径为空` };
      }
    }
  }
  if (definition.key === 'PORTAL_NVIDIA_SMI' && value.trim() !== '' && !value.startsWith('/')) {
    return { ok: false, error: '应是容器内的绝对路径，例如 /usr/local/bin/nvidia-smi' };
  }
  if (definition.key === 'PORTAL_TOOLS_FILE' && value.trim() !== '' && !value.startsWith('/')) {
    return { ok: false, error: '应是容器内的绝对路径，例如 /config/tools.json' };
  }

  return { ok: true, serialized: value };
}

/** 打码：只保留前缀，便于用户确认填的是哪个令牌。 */
export function maskSecret(value: string): string {
  if (value === '') return '';
  const prefixMatch = /^(tskey-[a-z]+-)/.exec(value);
  if (prefixMatch) return `${prefixMatch[1]}${MASK_TOKEN}`;
  if (value.length <= 8) return MASK_TOKEN;
  return `${value.slice(0, 4)}${MASK_TOKEN}`;
}

export interface ResolvedSetting {
  definition: SettingDefinition;
  /** 当前生效值（已类型化） */
  value: unknown;
  source: 'default' | 'env' | 'database';
  envValue: string | null;
  databaseValue: string | null;
  updatedAt?: string;
  updatedBy?: string | null;
}

export interface ResolveOptions {
  config: PortalConfig;
  /**
   * 设置来源仓储。
   *
   * 用接口而非具体类，是为了能传入"读出即解密"的装饰器
   * （`modules/settings/secretStore.ts`）—— 敏感项在这里拿到的必须是明文，
   * 否则解出来的密文会被当成 Token 传给外部 API。
   */
  repository: SettingsStore;
}

/**
 * 解析全部设置项的三层值。
 *
 * @returns 每项的当前值、来源与元数据
 */
export function resolveSettings(options: ResolveOptions): ResolvedSetting[] {
  const { config, repository } = options;
  const definitions = buildSettingDefinitions(config);
  const overrides = repository.toMap();

  return definitions.map((definition) => {
    const envRaw = readEnv(definition.envVar);
    const dbRaw = overrides.get(definition.key) ?? null;

    let value: unknown = definition.defaultValue;
    let source: ResolvedSetting['source'] = 'default';

    if (envRaw !== null) {
      const parsed = parseSettingValue(definition, envRaw);
      if (parsed !== null) {
        value = parsed;
        source = 'env';
      }
    }

    if (dbRaw !== null) {
      const parsed = parseSettingValue(definition, dbRaw);
      if (parsed !== null) {
        value = parsed;
        source = 'database';
      }
    }

    const record = repository.list().find((item) => item.key === definition.key);
    return {
      definition,
      value,
      source,
      envValue: envRaw,
      databaseValue: dbRaw,
      ...(record ? { updatedAt: record.updatedAt, updatedBy: record.updatedBy } : {}),
    };
  });
}

function readEnv(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** 解析结果为「键 → 值」的映射，供 applyTo 使用。 */
export function settingsToMap(resolved: readonly ResolvedSetting[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const item of resolved) map.set(item.definition.key, item.value);
  return map;
}

/** 便捷取值（带类型断言辅助）。 */
function pick<T>(map: Map<string, unknown>, key: string, fallback: T): T {
  const value = map.get(key);
  return value === undefined || value === null ? fallback : (value as T);
}

function pickNumber(map: Map<string, unknown>, key: string, fallback: number): number {
  const value = map.get(key);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function pickBoolean(map: Map<string, unknown>, key: string, fallback: boolean): boolean {
  const value = map.get(key);
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
  return fallback;
}

function pickString(map: Map<string, unknown>, key: string, fallback: string): string {
  const value = map.get(key);
  return typeof value === 'string' ? value : fallback;
}

/**
 * 把解析后的设置**就地写回** `PortalConfig`。
 *
 * 只处理 `live` 与 `reload` 级别的键；`restart` 级别的键被显式跳过
 * （它们代表容器创建参数，进程内改动没有意义）。
 *
 * @param overriddenKeys 数据库里**显式覆盖过**的键。
 *   个别设置的"默认值"是空值（如 `PORTAL_DISK_MOUNTS`），而 config 的初值来自
 *   `.env` 或平台默认。对这种项必须靠本参数区分"用户清空"与"从未设置"，
 *   否则会把 `.env` 配好的值误清空。
 * @returns 变更摘要：哪些键被改动、是否需要重建数据源
 */
export interface ApplyResult {
  changedKeys: string[];
  /** 需要重建 Tailscale 数据源 */
  reloadTailscale: boolean;
  /** 需要重建 Docker 连接 */
  reloadDocker: boolean;
  /** 被跳过的 restart 级键（值无效或本就不该在运行时改） */
  skippedKeys: string[];
}

export function applyTo(
  config: PortalConfig,
  map: Map<string, unknown>,
  overriddenKeys: ReadonlySet<string> = new Set(),
): ApplyResult {
  const changedKeys: string[] = [];
  const skippedKeys: string[] = [];

  const setIfChanged = (key: string, before: unknown, after: unknown, apply: () => void): void => {
    if (Object.is(before, after)) return;
    apply();
    changedKeys.push(key);
  };

  // ---------------------------------------------------------- tailscale
  const tsModeRaw = pickString(map, 'PORTAL_TAILSCALE_MODE', config.tailscale.mode);
  const tsMode: PortalConfig['tailscale']['mode'] =
    tsModeRaw === 'api' || tsModeRaw === 'cli' || tsModeRaw === 'off' || tsModeRaw === 'auto'
      ? tsModeRaw
      : config.tailscale.mode;
  setIfChanged('PORTAL_TAILSCALE_MODE', config.tailscale.mode, tsMode, () => {
    config.tailscale.mode = tsMode;
  });

  const tsToken = pickString(map, 'PORTAL_TAILSCALE_API_TOKEN', config.tailscale.apiToken);
  setIfChanged('PORTAL_TAILSCALE_API_TOKEN', config.tailscale.apiToken, tsToken, () => {
    config.tailscale.apiToken = tsToken;
  });

  const tsTailnet = pickString(map, 'PORTAL_TAILSCALE_TAILNET', config.tailscale.tailnet);
  setIfChanged('PORTAL_TAILSCALE_TAILNET', config.tailscale.tailnet, tsTailnet, () => {
    config.tailscale.tailnet = tsTailnet;
  });

  const tsBin = pickString(map, 'PORTAL_TAILSCALE_BIN', config.tailscale.bin);
  setIfChanged('PORTAL_TAILSCALE_BIN', config.tailscale.bin, tsBin, () => {
    config.tailscale.bin = tsBin;
  });

  const tsSocket = pickString(map, 'PORTAL_TAILSCALE_SOCKET', config.tailscale.socket);
  setIfChanged('PORTAL_TAILSCALE_SOCKET', config.tailscale.socket, tsSocket, () => {
    config.tailscale.socket = tsSocket;
  });

  const tsTimeout = pickNumber(map, 'PORTAL_TAILSCALE_TIMEOUT_MS', config.tailscale.timeoutMs);
  setIfChanged('PORTAL_TAILSCALE_TIMEOUT_MS', config.tailscale.timeoutMs, tsTimeout, () => {
    config.tailscale.timeoutMs = tsTimeout;
  });

  const reloadTailscale =
    changedKeys.includes('PORTAL_TAILSCALE_MODE') ||
    changedKeys.includes('PORTAL_TAILSCALE_API_TOKEN') ||
    changedKeys.includes('PORTAL_TAILSCALE_TAILNET') ||
    changedKeys.includes('PORTAL_TAILSCALE_BIN') ||
    changedKeys.includes('PORTAL_TAILSCALE_SOCKET');

  // ------------------------------------------------------------- docker
  const dockerEndpoint = pickString(map, 'DOCKER_ENDPOINT', config.docker.endpoint);
  setIfChanged('DOCKER_ENDPOINT', config.docker.endpoint, dockerEndpoint, () => {
    config.docker.endpoint = dockerEndpoint;
  });

  const dockerStopped = pickBoolean(map, 'PORTAL_DOCKER_INCLUDE_STOPPED', config.docker.includeStopped);
  setIfChanged('PORTAL_DOCKER_INCLUDE_STOPPED', config.docker.includeStopped, dockerStopped, () => {
    config.docker.includeStopped = dockerStopped;
  });

  const dockerStatsTimeout = pickNumber(map, 'PORTAL_DOCKER_STATS_TIMEOUT_MS', config.docker.statsTimeoutMs);
  setIfChanged('PORTAL_DOCKER_STATS_TIMEOUT_MS', config.docker.statsTimeoutMs, dockerStatsTimeout, () => {
    config.docker.statsTimeoutMs = dockerStatsTimeout;
  });

  const reloadDocker = changedKeys.includes('DOCKER_ENDPOINT');

  // ------------------------------------------------------------- system
  const hostProc = pickString(map, 'PORTAL_HOST_PROC', config.system.procPath);
  setIfChanged('PORTAL_HOST_PROC', config.system.procPath, hostProc, () => {
    config.system.procPath = hostProc;
  });

  const metricsInterval = pickNumber(map, 'PORTAL_METRICS_INTERVAL_MS', config.system.metricsIntervalMs);
  setIfChanged('PORTAL_METRICS_INTERVAL_MS', config.system.metricsIntervalMs, metricsInterval, () => {
    config.system.metricsIntervalMs = metricsInterval;
  });

  const nvidiaSmi = pickString(map, 'PORTAL_NVIDIA_SMI', config.system.nvidiaSmi);
  setIfChanged('PORTAL_NVIDIA_SMI', config.system.nvidiaSmi, nvidiaSmi, () => {
    config.system.nvidiaSmi = nvidiaSmi;
  });

  const ldPath = pickString(map, 'PORTAL_NVIDIA_LD_LIBRARY_PATH', config.system.ldLibraryPath);
  setIfChanged('PORTAL_NVIDIA_LD_LIBRARY_PATH', config.system.ldLibraryPath, ldPath, () => {
    config.system.ldLibraryPath = ldPath;
  });

  const commandTimeout = pickNumber(map, 'PORTAL_COMMAND_TIMEOUT_MS', config.system.commandTimeoutMs);
  setIfChanged('PORTAL_COMMAND_TIMEOUT_MS', config.system.commandTimeoutMs, commandTimeout, () => {
    config.system.commandTimeoutMs = commandTimeout;
  });

  // 磁盘挂载点：只调整"显示哪些/怎么标注"。路径必须已挂进容器，
  // 这一点无法在运行时改变（容器创建参数），界面会明确提示。
  //
  // 注意：**只有数据库里显式覆盖过才改写**。`PORTAL_DISK_MOUNTS` 的"默认值"是空字符串，
  // 而 config 的初值来自 `.env`/平台默认；若无条件按"解析结果 vs 当前值"比对，
  // 未设置该项时会把 `.env` 里配好的挂载点清空 —— 这是真实踩到的 bug。
  const diskOverride = overriddenKeys.has('PORTAL_DISK_MOUNTS') ? map.get('PORTAL_DISK_MOUNTS') : undefined;
  if (typeof diskOverride === 'string') {
    const diskSignature = config.system.mounts.map((m) => `${m.path}=${m.containerPath}`).join(',');
    if (diskOverride !== diskSignature) {
      const parsed = parseMountsLoose(diskOverride);
      if (parsed) {
        config.system.mounts = parsed;
        changedKeys.push('PORTAL_DISK_MOUNTS');
      } else {
        skippedKeys.push('PORTAL_DISK_MOUNTS');
      }
    }
  }

  // -------------------------------------------------------------- tools
  const toolsFile = pickString(map, 'PORTAL_TOOLS_FILE', '');
  setIfChanged('PORTAL_TOOLS_FILE', config.tools.catalogFile, toolsFile === '' ? null : toolsFile, () => {
    config.tools.catalogFile = toolsFile === '' ? null : toolsFile;
  });

  const toolsExtraRaw = pickString(map, 'PORTAL_TOOLS_EXTRA', '');
  const toolsExtra = toolsExtraRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  setIfChanged(
    'PORTAL_TOOLS_EXTRA',
    config.tools.extra.join(','),
    toolsExtra.join(','),
    () => {
      config.tools.extra = toolsExtra;
    },
  );

  const probeHost = pickString(map, 'PORTAL_TOOLS_PROBE_HOST', '');
  setIfChanged('PORTAL_TOOLS_PROBE_HOST', config.tools.probeHost, probeHost, () => {
    config.tools.probeHost = probeHost;
  });

  const probeTimeout = pickNumber(map, 'PORTAL_TOOLS_PROBE_TIMEOUT_MS', config.tools.probeTimeoutMs);
  setIfChanged('PORTAL_TOOLS_PROBE_TIMEOUT_MS', config.tools.probeTimeoutMs, probeTimeout, () => {
    config.tools.probeTimeoutMs = probeTimeout;
  });

  const probeTtl = pickNumber(map, 'PORTAL_TOOLS_PROBE_TTL_MS', config.tools.probeTtlMs);
  setIfChanged('PORTAL_TOOLS_PROBE_TTL_MS', config.tools.probeTtlMs, probeTtl, () => {
    config.tools.probeTtlMs = probeTtl;
  });

  // -------------------------------------------------------- performance
  const containersTtl = pickNumber(map, 'PORTAL_CACHE_CONTAINERS_TTL_MS', config.cache.containersTtlMs);
  setIfChanged('PORTAL_CACHE_CONTAINERS_TTL_MS', config.cache.containersTtlMs, containersTtl, () => {
    config.cache.containersTtlMs = containersTtl;
  });

  const tailscaleTtl = pickNumber(map, 'PORTAL_CACHE_TAILSCALE_TTL_MS', config.cache.tailscaleTtlMs);
  setIfChanged('PORTAL_CACHE_TAILSCALE_TTL_MS', config.cache.tailscaleTtlMs, tailscaleTtl, () => {
    config.cache.tailscaleTtlMs = tailscaleTtl;
  });

  const publicHost = pickString(map, 'PORTAL_PUBLIC_HOST', config.publicHost);
  setIfChanged('PORTAL_PUBLIC_HOST', config.publicHost, publicHost, () => {
    config.publicHost = publicHost;
  });

  // ------------------------------------------------- restart 级：显式跳过
  for (const key of [
    'PORTAL_LOG_LEVEL',
    'PORTAL_PORT',
    'PORTAL_SESSION_TTL_HOURS',
    'PORTAL_SECURE_COOKIES',
    'PORTAL_DATA_DIR',
  ]) {
    if (map.has(key)) skippedKeys.push(key);
  }

  return { changedKeys, reloadTailscale, reloadDocker, skippedKeys };
}

/**
 * 宽松解析磁盘挂载点字符串。
 *
 * 与 `config.parseMounts` 的差别：解析失败返回 null 而不是抛错，
 * 以便运行时设置热更新路径能把"无效值"记为 skipped 而不中断请求。
 */
function parseMountsLoose(raw: string): PortalConfig['system']['mounts'] | null {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: PortalConfig['system']['mounts'] = [];
  for (const entry of entries) {
    const [pairPart, ...rest] = entry.split('|');
    const pair = (pairPart ?? '').trim();
    const eq = pair.indexOf('=');
    if (eq === -1) return null;
    const displayPath = pair.slice(0, eq).trim();
    const containerPath = pair.slice(eq + 1).trim();
    if (!displayPath || !containerPath) return null;
    const rawLabel = (rest[0] ?? '').trim();
    const statPath = (rest[1] ?? '').trim() || containerPath;
    const fallbackLabel = path.basename(containerPath) || containerPath;
    out.push({
      path: displayPath,
      containerPath,
      label: (rawLabel || fallbackLabel).replace(/:$/, '') || fallbackLabel,
      statPath,
      readOnly: true,
    });
  }
  return out;
}
