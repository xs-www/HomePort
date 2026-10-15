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
  host: string;
  port: number;
  version: string;
  logLevel: LogLevel;
  trustProxy: boolean;
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

  const config: PortalConfig = {
    env: str('NODE_ENV', 'production'),
    host: str('PORTAL_HOST', '0.0.0.0'),
    port: num('PORTAL_PORT', 8899, 1, 65535),
    version: str('PORTAL_VERSION', '0.1.0'),
    logLevel: oneOf<LogLevel>('PORTAL_LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
    trustProxy: bool('PORTAL_TRUST_PROXY', true),
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
  };

  return { ...config, ...overrides };
}

/** 确保 dataDir 存在（含父目录）。 */
export function ensureDataDir(config: PortalConfig): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

export const config: PortalConfig = loadConfig();
