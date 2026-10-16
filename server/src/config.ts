/**
 * 运行时配置：环境变量 → 强类型配置对象。
 *
 * 约定：本文件是**唯一**读取 process.env 的地方（`config.env` 用于调试输出）。
 * 其余模块只从 `config` 取值，便于测试时整体替换。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/**
 * `trustProxy` 的取值。
 *
 * Fastify 会把它原样交给 `proxy-addr`，因此可以是布尔、CIDR 字符串、
 * 预置名称（`loopback` / `linklocal` / `uniquelocal`）或它们的数组。
 */
export type TrustProxySetting = boolean | string | string[];

/**
 * 默认信任的代理范围：**仅回环**。
 *
 * 为什么不是 `true`：`true` 表示无条件相信任何来源的 `X-Forwarded-For` /
 * `X-Forwarded-Proto`，于是任意客户端都能伪造客户端 IP 绕过登录限流、
 * 并让门户以为自己在 HTTPS 后面（误发 `Secure` Cookie）。
 *
 * 为什么是 `loopback` 而不是 `false`：本项目的标准部署是
 * `tailscale serve → 127.0.0.1:8899`，代理连接必然来自回环地址；
 * 信任回环既拿到真实客户端 IP（限流键正确），又不会相信 tailnet 直连客户端
 * 自带的伪造头。
 */
export const DEFAULT_TRUST_PROXY: TrustProxySetting = 'loopback';

/**
 * 默认 CSP。
 *
 * - `script-src 'self'`：前端产物全部是本地静态文件，没有内联脚本，
 *   因此不需要 `'unsafe-inline'`（React 19 + Vite 产物满足该约束）。
 * - `style-src 'self' 'unsafe-inline'`：React 组件通过 `style` **属性**
 *   写少量内联样式（进度条宽度等），属性级内联无法用 nonce 覆盖。
 * - `connect-src 'self'`：允许同源 `fetch` 与 **SSE** 长连接。
 * - `frame-ancestors 'none'` + `object-src 'none'`：门户不允许被内嵌。
 */
export const DEFAULT_CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export interface MountConfig {
  /** 展示用路径（宿主视角） */
  path: string;
  /** 容器内读取路径；为空时等于 path */
  containerPath: string;
  /** UI 展示标签，为空时由 path 推导 */
  label: string;
  /** statfs 的目标路径（默认取 containerPath 的根） */
  statPath: string;
  readOnly: boolean;
}

export interface PortalConfig {
  env: string;
  /**
   * `process.env` 的快照。
   *
   * 存在的意义：**本文件是唯一读取 `process.env` 的模块**（见文件头约定）。
   * 需要"继承父进程环境"或"展示某个环境变量的原值"的模块从这里取，
   * 而不是各自去碰 `process.env` —— 否则环境依赖会散落各处，
   * 测试也会因为宿主机恰好设了某个变量而走进不同分支。
   *
   * 键名由使用方（如设置注册表的 `envVar`）声明，这里只负责提供值。
   */
  envVars: Readonly<Record<string, string | undefined>>;
  host: string;
  port: number;
  version: string;
  logLevel: LogLevel;
  /**
   * 可信代理范围。见 `DEFAULT_TRUST_PROXY`：默认只信回环。
   *
   * 设为 `true` 等于"相信任何人伪造的 `X-Forwarded-*`"，仅在门户前面确实有
   * 一个**不可绕过**的反代时才应这么配（此时反代也必须重写而不是追加头）。
   */
  trustProxy: TrustProxySetting;
  /** 部署在 HTTPS 反代之后时置 true，会话 Cookie 将带 Secure */
  secureCookies: boolean;
  /** 门户对外的公开主机名（MagicDNS 名或 tailnet IP）；空则运行时从请求头推导 */
  publicHost: string;
  /** 门户对外公开的端口；0 表示与监听端口一致 */
  publicPort: number;
  publicScheme: 'http' | 'https';
  dataDir: string;
  dbPath: string;
  webDistDir: string;
  /** 一并镜像到 /api/health 的构建期提交号 */
  buildRevision: string;
  session: {
    ttlHours: number;
    rememberTtlHours: number;
    cookieName: string;
  };
  bootstrap: {
    /** 首启初始化令牌；为空则自动生成并写入 dataDir/setup-token.txt */
    token: string | null;
    tokenFile: string;
  };
  docker: {
    /** socket 路径或 tcp://host:port 或 npipe:////./pipe/xxx */
    endpoint: string;
    includeStopped: boolean;
    statsTimeoutMs: number;
  };
  tailscale: {
    mode: 'auto' | 'cli' | 'api' | 'off';
    bin: string;
    socket: string;
    apiToken: string;
    tailnet: string;
    timeoutMs: number;
  };
  system: {
    /** 宿主 /proc 的容器内挂载点 */
    procPath: string;
    /** nvidia-smi 可执行文件路径 */
    nvidiaSmi: string;
    /** 额外库搜索路径（WSL 下为 /usr/lib/wsl/lib） */
    ldLibraryPath: string;
    mounts: MountConfig[];
    metricsIntervalMs: number;
    commandTimeoutMs: number;
  };
  tools: {
    catalogFile: string | null;
    probeTimeoutMs: number;
    probeTtlMs: number;
    /**
     * 是否把探测结果同时展示给前端（预留）。
     *
     * 强制指定探测目标主机。为空时用门户的对外主机名，
     * 失败后自动兜底尝试 `host.docker.internal` 与 `127.0.0.1`。
     * 容器化部署下宿主服务通常只能经 `host.docker.internal` 连上。
     */
    probeHost: string;
    /** 追加的自定义工具，形如 id:label:port 的逗号分隔列表 */
    extra: string[];
  };
  cache: {
    containersTtlMs: number;
    tailscaleTtlMs: number;
  };
  /** 是否信任 X-Forwarded-* 判断请求协议 */
  forwardedProtoTrusted: boolean;
  /** 浏览器侧安全响应头（CSP / HSTS / X-Frame-Options …） */
  securityHeaders: {
    /** 总开关；关闭后一个头都不发（仅在排障时用） */
    enabled: boolean;
    /** CSP 内容；空字符串表示不下发 CSP */
    csp: string;
    /** 是否允许下发 HSTS（只在请求确为 HTTPS 时才真正下发） */
    hsts: boolean;
    /** HSTS max-age（秒） */
    hstsMaxAge: number;
  };
  /** 敏感数据加密（AES-256-GCM）主密钥来源 */
  secrets: {
    /** 显式提供的主密钥（hex 64 位或 base64 32 字节）；为空则用 keyFile */
    key: string | null;
    /** 未提供 key 时自动生成并读取的密钥文件（权限 0600） */
    keyFile: string;
    /** 轮换期间保留的旧密钥（只用于解密），来自 `PORTAL_SECRET_KEY_PREVIOUS` */
    previousKeys: string[];
  };
  /** 两步验证（TOTP） */
  totp: {
    /** 是否允许用户启用 TOTP；关闭后所有 TOTP 接口返回不可用 */
    enabled: boolean;
    /** otpauth:// URI 里的签发者名 */
    issuer: string;
    /** 校验时允许的时间窗口（±N 个 30s 周期） */
    window: number;
    /** 登录第二步挑战令牌的有效期（秒） */
    challengeTtlSeconds: number;
  };
  /**
   * 历史指标采样与保留（Sprint 2 / S2-01）。
   *
   * 与 `system.metricsIntervalMs`（SSE 实时推送频率）**是两件事**：
   * 那一个面向"人正在看的页面"，这一个面向"落库的历史曲线"。
   */
  metrics: {
    /** 后台采样 tick 间隔（秒）；同时是 minute 桶期望样本数的基准 */
    sampleIntervalSec: number;
    /** minute 桶保留小时数（超过即删，稳态行数由此封顶，不随时间累积） */
    minuteRetentionHours: number;
    /** hour 桶保留天数 */
    hourRetentionDays: number;
    /** 采集容器的数量上限（0 = 完全不采容器） */
    containerLimit: number;
  };
  /** 健康监测（Sprint 2 / S2-03）。 */
  health: {
    /** 自动 HTTP 探测间隔（秒）；**0 = 关闭自动探测**（只在手动探测时更新状态） */
    probeIntervalSec: number;
    /** 全局在飞探测并发上限 */
    probeConcurrency: number;
  };
}

const DEFAULT_MOUNTS = 'C:=/host/disk/C,D:=/host/disk/D';

function str(name: string, fallback: string): string {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  return trimmed === '' ? fallback : trimmed;
}

function optionalStr(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

function num(name: string, fallback: number, min?: number, max?: number): number {
  const raw = optionalStr(name);
  if (raw === null) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`环境变量 ${name} 必须是数字，当前为 "${raw}"`);
  }
  if (min !== undefined && parsed < min) {
    throw new Error(`环境变量 ${name} 必须 >= ${min}，当前为 ${parsed}`);
  }
  if (max !== undefined && parsed > max) {
    throw new Error(`环境变量 ${name} 必须 <= ${max}，当前为 ${parsed}`);
  }
  return parsed;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = optionalStr(name);
  if (raw === null) return fallback;
  const lowered = raw.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;
  throw new Error(`环境变量 ${name} 必须是布尔值（1/0/true/false），当前为 "${raw}"`);
}

function oneOf<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const raw = optionalStr(name);
  if (raw === null) return fallback;
  if (!(allowed as readonly string[]).includes(raw)) {
    throw new Error(`环境变量 ${name} 必须是 ${allowed.join('|')} 之一，当前为 "${raw}"`);
  }
  return raw as T;
}

/**
 * 解析 `PORTAL_TRUST_PROXY`。
 *
 * | 取值 | 含义 |
 * | --- | --- |
 * | 未设置 | `loopback`（只信回环代理，安全默认） |
 * | `1`/`true`/`on`/`yes` | `true` —— 无条件相信 `X-Forwarded-*`（有反代且不可绕过时才用） |
 * | `0`/`false`/`off`/`no` | `false` —— 完全不信任 |
 * | `127.0.0.1/8,::1` | 逗号分隔的 IP / CIDR 白名单 |
 * | `loopback`/`linklocal`/`uniquelocal` | proxy-addr 的预置名称 |
 *
 * 非法值直接抛错（启动即失败），避免静默退化成"信任所有人"。
 */
export function parseTrustProxy(raw: string | undefined | null): TrustProxySetting {
  if (raw === undefined || raw === null || raw.trim() === '') return DEFAULT_TRUST_PROXY;
  const trimmed = raw.trim();
  const lowered = trimmed.toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lowered)) return true;
  if (['0', 'false', 'no', 'off'].includes(lowered)) return false;

  const parts = trimmed
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length === 0) return DEFAULT_TRUST_PROXY;

  const named = new Set(['loopback', 'linklocal', 'uniquelocal']);
  for (const part of parts) {
    if (named.has(part.toLowerCase())) continue;
    if (!/^[0-9a-fA-F.:]+\/\d{1,3}$/.test(part) && !/^[0-9a-fA-F.:]+$/.test(part)) {
      throw new Error(
        `环境变量 PORTAL_TRUST_PROXY 非法："${part}"。应为布尔值、预置名（loopback/linklocal/uniquelocal）或 IP/CIDR 列表`,
      );
    }
  }
  return parts.length === 1 ? parts[0]! : parts;
}

/**
 * 解析 `PORTAL_DISK_MOUNTS`。
 *
 * 语法：逗号分隔的 `展示路径=容器内路径` 或仅 `路径`。
 * 可选用 `|` 追加标签与 statfs 路径：`C:=/host/disk/C|系统盘|/host/disk/C`。
 *
 * @example `PORTAL_DISK_MOUNTS="C:=/host/disk/C,D:=/host/disk/D"`（Windows 默认）
 * @example `PORTAL_DISK_MOUNTS="/volume1=/host/volume1"`（NAS 默认）
 */
export function parseMounts(raw: string): MountConfig[] {
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return entries.map((entry) => {
    const [pairPart, ...rest] = entry.split('|');
    const pair = (pairPart ?? '').trim();
    const eq = pair.indexOf('=');
    if (eq === -1) {
      // 必须显式写出「展示路径=容器内路径」：单写一个路径时无法判断
      // 它是宿主路径还是容器路径，静默猜测会得到错误的 statfs 目标。
      throw new Error(`PORTAL_DISK_MOUNTS 条目格式非法："${entry}"，应为 "展示路径=容器内路径"`);
    }
    const displayPath = pair.slice(0, eq).trim();
    const containerPath = pair.slice(eq + 1).trim();
    if (!displayPath || !containerPath) {
      throw new Error(`PORTAL_DISK_MOUNTS 条目格式非法："${entry}"，应为 "展示路径=容器内路径"`);
    }
    const label = (rest[0] ?? '').trim() || defaultMountLabel(displayPath);
    const statPath = (rest[1] ?? '').trim() || containerPath;
    return { path: displayPath, containerPath, label, statPath, readOnly: true };
  });
}

/** 由展示路径推导标签：取最后一段并去掉 Windows 盘符的冒号。 */
function defaultMountLabel(displayPath: string): string {
  const normalized = displayPath.replace(/[\\/]+$/, '');
  const base = normalized.split(/[\\/]/).filter(Boolean).pop();
  const label = base ?? normalized;
  return label.replace(/:$/, '') || label;
}

function defaultDataDir(): string {
  return path.resolve(process.cwd(), 'data');
}

/**
 * server 包根目录。
 *
 * 用 `import.meta.url` 推导而非 `process.cwd()`：开发时源码在 `<server>/src/`、
 * 构建后在 `<server>/dist/`，两种情况下「上一级」都是 server 包根，
 * 因此派生路径（默认数据库、默认前端产物）稳定。
 */
export const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 仓库根目录（server 的上一级）。 */
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..');

/**
 * 构建配置。仅在进程启动或测试 setUp 时调用一次。
 *
 * @param overrides 测试用：浅层覆盖部分字段（嵌套对象需整体给出）
 */
export function loadConfig(overrides: Partial<PortalConfig> = {}): PortalConfig {
  const dataDir = path.resolve(str('PORTAL_DATA_DIR', defaultDataDir()));
  const diskMounts = parseMounts(
    str('PORTAL_DISK_MOUNTS', process.platform === 'win32' ? DEFAULT_MOUNTS.replace('D:=/host/disk/D', '') : '/=/host/root'),
  );
  // 环境变量快照：测试可通过 overrides.envVars 追加，不必去改 process.env
  const envVars: Readonly<Record<string, string | undefined>> = { ...process.env, ...(overrides.envVars ?? {}) };

  const config: PortalConfig = {
    env: str('NODE_ENV', 'production'),
    envVars,
    host: str('PORTAL_HOST', '0.0.0.0'),
    port: num('PORTAL_PORT', 8899, 1, 65535),
    version: str('PORTAL_VERSION', '0.1.0'),
    logLevel: oneOf<LogLevel>('PORTAL_LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
    trustProxy: parseTrustProxy(process.env['PORTAL_TRUST_PROXY']),
    secureCookies: bool('PORTAL_SECURE_COOKIES', false),
    publicHost: str('PORTAL_PUBLIC_HOST', ''),
    publicPort: num('PORTAL_PUBLIC_PORT', 0, 0, 65535),
    publicScheme: oneOf<'http' | 'https'>('PORTAL_PUBLIC_SCHEME', 'http', ['http', 'https']),
    dataDir,
    dbPath: path.resolve(str('PORTAL_DB_PATH', path.join(dataDir, 'portal.sqlite'))),
    webDistDir: path.resolve(str('PORTAL_WEB_DIST', path.join(REPO_ROOT, 'web', 'dist'))),
    buildRevision: str('PORTAL_BUILD_REVISION', 'dev'),
    session: {
      ttlHours: num('PORTAL_SESSION_TTL_HOURS', 12, 1, 24 * 90),
      rememberTtlHours: num('PORTAL_SESSION_REMEMBER_TTL_HOURS', 24 * 30, 1, 24 * 365),
      cookieName: str('PORTAL_SESSION_COOKIE', 'hp_session'),
    },
    bootstrap: {
      token: optionalStr('PORTAL_SETUP_TOKEN'),
      tokenFile: path.join(dataDir, 'setup-token.txt'),
    },
    docker: {
      endpoint: str('DOCKER_ENDPOINT', process.platform === 'win32'
        ? 'npipe:////./pipe/dockerDesktopLinuxEngine'
        : '/var/run/docker.sock'),
      includeStopped: bool('PORTAL_DOCKER_INCLUDE_STOPPED', true),
      statsTimeoutMs: num('PORTAL_DOCKER_STATS_TIMEOUT_MS', 4000, 500, 30000),
    },
    tailscale: {
      mode: oneOf<'auto' | 'cli' | 'api' | 'off'>('PORTAL_TAILSCALE_MODE', 'auto', ['auto', 'cli', 'api', 'off']),
      bin: str('PORTAL_TAILSCALE_BIN', 'tailscale'),
      socket: str('PORTAL_TAILSCALE_SOCKET', '/var/run/tailscale/tailscaled.sock'),
      apiToken: str('PORTAL_TAILSCALE_API_TOKEN', ''),
      tailnet: str('PORTAL_TAILSCALE_TAILNET', '-'),
      timeoutMs: num('PORTAL_TAILSCALE_TIMEOUT_MS', 5000, 500, 30000),
    },
    system: {
      procPath: str('PORTAL_HOST_PROC', '/host/proc'),
      nvidiaSmi: str('PORTAL_NVIDIA_SMI', '/usr/local/bin/nvidia-smi'),
      ldLibraryPath: str('PORTAL_NVIDIA_LD_LIBRARY_PATH', ''),
      mounts: diskMounts,
      metricsIntervalMs: num('PORTAL_METRICS_INTERVAL_MS', 3000, 500, 60000),
      commandTimeoutMs: num('PORTAL_COMMAND_TIMEOUT_MS', 5000, 500, 30000),
    },
    tools: {
      catalogFile: optionalStr('PORTAL_TOOLS_FILE'),
      probeTimeoutMs: num('PORTAL_TOOLS_PROBE_TIMEOUT_MS', 1500, 200, 15000),
      probeTtlMs: num('PORTAL_TOOLS_PROBE_TTL_MS', 10000, 1000, 300000),
      probeHost: str('PORTAL_TOOLS_PROBE_HOST', ''),
      extra: str('PORTAL_TOOLS_EXTRA', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    cache: {
      containersTtlMs: num('PORTAL_CACHE_CONTAINERS_TTL_MS', 2000, 0, 60000),
      tailscaleTtlMs: num('PORTAL_CACHE_TAILSCALE_TTL_MS', 5000, 0, 120000),
    },
    forwardedProtoTrusted: bool('PORTAL_FORWARDED_PROTO_TRUSTED', true),
    securityHeaders: {
      enabled: bool('PORTAL_SECURITY_HEADERS', true),
      csp: str('PORTAL_CSP', DEFAULT_CSP),
      hsts: bool('PORTAL_HSTS', true),
      hstsMaxAge: num('PORTAL_HSTS_MAX_AGE', 180 * 24 * 3600, 0, 63072000),
    },
    secrets: {
      key: optionalStr('PORTAL_SECRET_KEY'),
      keyFile: path.resolve(str('PORTAL_SECRET_KEY_FILE', path.join(dataDir, 'secret.key'))),
      previousKeys: str('PORTAL_SECRET_KEY_PREVIOUS', '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    },
    totp: {
      enabled: bool('PORTAL_TOTP_ENABLED', true),
      issuer: str('PORTAL_TOTP_ISSUER', 'HomePort'),
      window: num('PORTAL_TOTP_WINDOW', 1, 0, 5),
      challengeTtlSeconds: num('PORTAL_TOTP_CHALLENGE_TTL_SECONDS', 300, 60, 1800),
    },
    // 非法值在启动时抛错（与 parseTrustProxy 同风格）：静默截断会让人以为
    // "保留 3 天"真的生效了，而实际上库里留的是别的东西。
    metrics: {
      sampleIntervalSec: num('PORTAL_METRICS_SAMPLE_INTERVAL_SEC', 30, 5, 3600),
      minuteRetentionHours: num('PORTAL_METRICS_RETENTION_MINUTE_HOURS', 24, 1, 168),
      hourRetentionDays: num('PORTAL_METRICS_RETENTION_HOUR_DAYS', 30, 1, 3650),
      containerLimit: num('PORTAL_METRICS_CONTAINER_LIMIT', 10, 0, 100),
    },
    health: {
      // 0 是合法值（= 关闭自动探测），因此下界为 0
      probeIntervalSec: num('PORTAL_HEALTH_PROBE_INTERVAL_SEC', 300, 0, 86400),
      probeConcurrency: num('PORTAL_HEALTH_PROBE_CONCURRENCY', 4, 1, 32),
    },
  };

  return { ...config, ...overrides, envVars };
}

/**
 * 读取原始环境变量（去空白；空串按"未设置"处理）。
 *
 * 供设置注册表等需要展示"环境变量层原值"的模块使用 —— 它是本文件之外
 * 唯一被允许触达 `process.env` 的入口，因此调用方不需要（也不应该）
 * 自己去读 `process.env`。
 */
export function readEnvVar(name: string): string | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** 确保 dataDir 存在（含父目录）。 */
export function ensureDataDir(config: PortalConfig): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export const config: PortalConfig = loadConfig();
