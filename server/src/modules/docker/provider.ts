/**
 * Docker 数据源（只读）。
 *
 * 设计要点：
 * 1. 只调用读取类 API（list/inspect/logs/stats/version），**不提供任何写操作**。
 *    F1 的权限决定是"只读展示 + 打开入口"，因此写方法在类型层面就不存在。
 * 2. 端口与网络信息需要 `inspect` 才能拿到（`list` 只给端口字符串），
 *    因此列表流程是 list → 有限并发 inspect，结果由上层 TtlCache 缓存。
 * 3. 任何失败都降级为 `SourceStatus { available: false, detail }`，不抛给路由层，
 *    让前端能显示"未挂载 docker.sock"而不是 500。
 */
import Docker from 'dockerode';
import type { ContainerInfo, ContainerInspectInfo } from 'dockerode';
import type { PortalConfig } from '../../config.js';
import { createSilentLogger, type Logger } from '../../logger.js';
import { demuxDockerLogs } from '../../util/dockerStream.js';
import type { SourceStatus } from './types.js';

export interface DockerProviderOptions {
  config: PortalConfig;
  logger: Logger;
}

export interface DockerLogsOptions {
  tail: number;
  timestamps: boolean;
  /** stdout 上限字节，超出截断 */
  maxBytes?: number;
}

export interface DockerLogsRaw {
  text: string;
  truncated: boolean;
  /** 字节数 */
  bytes: number;
}

export interface DockerStatsRaw {
  cpuPercent: number | null;
  memUsedBytes: number | null;
  memLimitBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  blockReadBytes: number | null;
  blockWriteBytes: number | null;
  pids: number | null;
}

/**
 * 把 Docker endpoint 描述字符串解析为 dockerode 构造参数。
 *
 * 支持的形式：
 * - `npipe:////./pipe/dockerDesktopLinuxEngine`（Docker Desktop on Windows）
 * - `npipe://./pipe/dockerDesktopLinuxEngine`
 * - `unix:///var/run/docker.sock`、`/var/run/docker.sock`
 * - `tcp://host:2375`、`http://host:2375`、`https://host:2376`
 *
 * named pipe 的坑：URI 里出现 2~4 个斜杠都合法，但 dockerode 需要的是
 * **恰好以 `//` 开头**的 UNC 路径（`//./pipe/xxx`）。这里统一归一化，
 * 否则会退化成相对文件路径并报 ENOENT。
 */
export function resolveDockerEndpoint(endpoint: string): Docker.DockerOptions {
  const raw = endpoint.trim();

  if (raw.startsWith('npipe:')) {
    return { socketPath: normalizeNamedPipe(raw.slice('npipe:'.length)) };
  }
  if (raw.startsWith('unix://')) {
    return { socketPath: `/${raw.slice('unix://'.length).replace(/^\/+/, '')}` };
  }
  if (raw.startsWith('tcp://') || raw.startsWith('http://') || raw.startsWith('https://')) {
    const isHttps = raw.startsWith('https://');
    const withoutScheme = raw.replace(/^(tcp|http|https):\/\//, '');
    const [hostPart, portPart] = withoutScheme.split(':');
    const port = Number(portPart ?? (isHttps ? 2376 : 2375));
    return {
      host: hostPart || 'localhost',
      port: Number.isFinite(port) ? port : 2375,
      protocol: isHttps ? 'https' : 'http',
    };
  }
  if (raw.startsWith('\\\\') || raw.startsWith('//')) {
    return { socketPath: normalizeNamedPipe(raw) };
  }
  // 裸路径视为 unix socket
  return { socketPath: raw };
}

/** 归一化 named pipe 路径为 `//./pipe/name` 形式。 */
export function normalizeNamedPipe(value: string): string {
  const body = value.replace(/^[/\\]+/, '').replace(/\\/g, '/');
  return `//${body}`;
}

/** 从 `Docker.DockerOptions` 反推可读的模式名。 */
export function endpointMode(options: Docker.DockerOptions): string {
  if (options.socketPath) {
    return String(options.socketPath).startsWith('//') ? 'npipe' : 'socket';
  }
  return options.protocol === 'https' ? 'tcp+tls' : 'tcp';
}

/**
 * CPU 百分比计算（Docker 官方公式）。
 *
 * `cpuDelta / systemDelta * cpuCount * 100`，其中 cpuCount 由 `online_cpus` 优先。
 */
export function computeCpuPercent(stats: RawDockerStats): number | null {
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  if (systemDelta <= 0 || cpuDelta < 0) return null;
  const onlineCpus = stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  return (cpuDelta / systemDelta) * onlineCpus * 100;
}

/** dockerode stats 响应的最小结构（只声明用到的字段）。 */
export interface RawDockerStats {
  cpu_stats?: {
    cpu_usage?: { total_usage?: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats?: {
    cpu_usage?: { total_usage?: number };
    system_cpu_usage?: number;
  };
  memory_stats?: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: { io_service_bytes_recursive?: Array<{ op?: string; value?: number }> | null };
  pids_stats?: { current?: number };
}

/** 把原始 stats 归一化。 */
export function normalizeStats(stats: RawDockerStats): DockerStatsRaw {
  const memUsageRaw = stats.memory_stats?.usage ?? null;
  // Docker 的 usage 含 page cache，减去 inactive_file 更贴近 `docker stats` 的显示
  const inactiveFile = stats.memory_stats?.stats?.inactive_file ?? stats.memory_stats?.stats?.total_inactive_file ?? 0;
  const memUsed = memUsageRaw === null ? null : Math.max(0, memUsageRaw - inactiveFile);
  const memLimit = stats.memory_stats?.limit ?? null;

  let netRx: number | null = null;
  let netTx: number | null = null;
  if (stats.networks) {
    netRx = 0;
    netTx = 0;
    for (const iface of Object.values(stats.networks)) {
      netRx += iface.rx_bytes ?? 0;
      netTx += iface.tx_bytes ?? 0;
    }
  }

  let blockRead: number | null = null;
  let blockWrite: number | null = null;
  const ioEntries = stats.blkio_stats?.io_service_bytes_recursive;
  if (ioEntries && ioEntries.length > 0) {
    blockRead = 0;
    blockWrite = 0;
    for (const entry of ioEntries) {
      const op = (entry.op ?? '').toLowerCase();
      if (op === 'read') blockRead += entry.value ?? 0;
      else if (op === 'write') blockWrite += entry.value ?? 0;
    }
  }

  return {
    cpuPercent: computeCpuPercent(stats),
    memUsedBytes: memUsed,
    memLimitBytes: memLimit && memLimit > 0 ? memLimit : null,
    netRxBytes: netRx,
    netTxBytes: netTx,
    blockReadBytes: blockRead,
    blockWriteBytes: blockWrite,
    pids: stats.pids_stats?.current ?? null,
  };
}

export class DockerProvider {
  private docker: Docker;
  private readonly logger: Logger;
  private readonly includeStopped: boolean;
  private readonly statsTimeoutMs: number;
  private mode: string;
  /** 构造时用的 endpoint，用于判断是否需要重建连接 */
  private endpoint: string;
  /** 运行时可变配置的来源（enableRuntimeConfig 后启用） */
  private configRef: PortalConfig | null = null;

  /**
   * @param options 配置与日志；或直接注入一个已构造的 dockerode 实例（测试/高级用法）
   */
  constructor(options: DockerProviderOptions | Docker) {
    if (options instanceof Docker) {
      this.docker = options;
      this.logger = createSilentLogger().child({ mod: 'docker' });
      this.includeStopped = true;
      this.statsTimeoutMs = 4000;
      this.mode = 'injected';
      this.endpoint = '';
      return;
    }
    const dockerOptions = resolveDockerEndpoint(options.config.docker.endpoint);
    this.docker = new Docker(dockerOptions);
    this.logger = options.logger.child({ mod: 'docker' });
    this.includeStopped = options.config.docker.includeStopped;
    this.statsTimeoutMs = options.config.docker.statsTimeoutMs;
    this.mode = endpointMode(dockerOptions);
    this.endpoint = options.config.docker.endpoint;
  }

  /**
   * 让 provider 跟随一份可变的 config（运行时设置热更新用）。
   *
   * 调用后 `includeStopped` / `statsTimeoutMs` 每次读取都会从 config 取最新值；
   * endpoint 变化需要调用 `reload()` 重建连接。
   */
  bindConfig(config: PortalConfig): void {
    this.configRef = config;
  }

  /** 当前生效的 stats 超时（运行时可变）。 */
  private statsTimeout(): number {
    return this.configRef?.docker.statsTimeoutMs ?? this.statsTimeoutMs;
  }

  /** 当前生效的"是否含已停止容器"默认值（运行时可变）。 */
  private defaultAll(): boolean {
    return this.configRef?.docker.includeStopped ?? this.includeStopped;
  }

  /**
   * 按当前 config 重建 dockerode 连接。
   *
   * 调用时机：管理员改了 `DOCKER_ENDPOINT` 之后。
   *
   * @returns 是否真的发生了重建（endpoint 未变时为 false）
   */
  reload(): boolean {
    if (!this.configRef) return false;
    const endpoint = this.configRef.docker.endpoint;
    if (endpoint === this.endpoint) return false;

    const dockerOptions = resolveDockerEndpoint(endpoint);
    this.docker = new Docker(dockerOptions);
    this.mode = endpointMode(dockerOptions);
    this.endpoint = endpoint;
    this.logger.info('Docker 连接已重建', { mode: this.mode });
    return true;
  }

  /** dockerode 实例（仅供测试/诊断）。 */
  get client(): Docker {
    return this.docker;
  }

  /** 探活：daemon 是否可达。 */
  async checkAvailability(): Promise<SourceStatus> {
    try {
      await this.docker.version();
      return { available: true, mode: this.mode, detail: null };
    } catch (error) {
      const detail = describeDockerError(error);
      this.logger.warn('docker daemon 不可达', { detail });
      return { available: false, mode: this.mode, detail };
    }
  }

  /**
   * 拉取容器清单（含端口/网络/标签）。
   *
   * @param all 是否包含已停止容器；默认取配置
   * @returns 容器原始数据；daemon 不可达时抛错（由 service 转成 SourceStatus）
   */
  async listContainers(all: boolean = this.defaultAll()): Promise<ContainerInspectInfo[]> {
    const list: ContainerInfo[] = await this.docker.listContainers({ all });
    const sorted = [...list].sort((a, b) => {
      const stateRank = (state: string): number => (state === 'running' ? 0 : 1);
      const byState = stateRank(a.State) - stateRank(b.State);
      if (byState !== 0) return byState;
      return firstName(a.Names).localeCompare(firstName(b.Names), 'zh-Hans-CN');
    });

    const inspections = await mapWithConcurrency(sorted, 8, async (item) => {
      try {
        return await this.docker.getContainer(item.Id).inspect();
      } catch (error) {
        this.logger.warn('容器 inspect 失败，已跳过', { id: item.Id.slice(0, 12), error });
        return null;
      }
    });

    return inspections.filter((x): x is ContainerInspectInfo => x !== null);
  }

  /** 精确 inspect 单个容器。 */
  async inspectContainer(id: string): Promise<ContainerInspectInfo | null> {
    try {
      return await this.docker.getContainer(id).inspect();
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /**
   * 拉取容器日志。
   *
   * Docker 对非 TTY 容器返回带 8 字节头部的多路复用流，这里统一解码为文本。
   */
  async getLogs(id: string, options: DockerLogsOptions, isTty: boolean): Promise<DockerLogsRaw> {
    const maxBytes = options.maxBytes ?? 512 * 1024;
    const stream = (await this.docker.getContainer(id).logs({
      stdout: true,
      stderr: true,
      tail: options.tail,
      timestamps: options.timestamps,
      follow: false,
    })) as unknown as Buffer;

    const buffer = Buffer.isBuffer(stream) ? stream : Buffer.from(String(stream), 'utf8');
    const truncated = buffer.length > maxBytes;
    const effective = truncated ? buffer.subarray(buffer.length - maxBytes) : buffer;
    const demuxed = demuxDockerLogs(effective, isTty);
    return { text: demuxed.combined, truncated, bytes: effective.length };
  }

  /**
   * 取一次性 stats（非流式）。
   *
   * 注意：Docker 需要两次采样才能算出 CPU%，`stream: false` 时 daemon 会自行处理。
   */
  async getStats(id: string): Promise<DockerStatsRaw | null> {
    try {
      const stats = (await withTimeout(
        this.docker.getContainer(id).stats({ stream: false }),
        this.statsTimeout(),
        'docker stats 超时',
      )) as unknown as RawDockerStats;
      return normalizeStats(stats);
    } catch (error) {
      this.logger.debug('容器 stats 获取失败', { id: id.slice(0, 12), error });
      return null;
    }
  }

  /** daemon 概览（用于排障：容器数、引擎版本、GPU 运行时等）。 */
  async getInfo(): Promise<Record<string, unknown> | null> {
    try {
      return (await this.docker.info()) as unknown as Record<string, unknown>;
    } catch (error) {
      this.logger.debug('docker info 获取失败', { error });
      return null;
    }
  }
}

/** 取容器第一个名字并去掉前导 `/`。 */
export function firstName(names: string[] | undefined): string {
  const first = names?.[0] ?? '';
  return first.replace(/^\//, '');
}

/** 判断错误是否为 404（容器不存在）。 */
export function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const statusCode = (error as { statusCode?: number }).statusCode;
  return statusCode === 404;
}

/** 把 dockerode 错误转成可展示的中文原因。 */
export function describeDockerError(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error);
  const err = error as { code?: string; message?: string; statusCode?: number; reason?: string };
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'EACCES') {
    return `无法连接 Docker 守护进程（${err.code}）。请确认已挂载 docker.sock 或设置了正确的 DOCKER_ENDPOINT`;
  }
  if (err.statusCode === 404) return 'Docker 资源不存在（404）';
  if (err.statusCode === 403) return 'Docker 守护进程拒绝访问（403），请检查 socket 权限';
  return err.reason ?? err.message ?? '未知 Docker 错误';
}

/** 有限并发 map，避免一次性 inspect 上百个容器打爆 daemon。 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));
  const runners = Array.from({ length: size }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

/** Promise 超时包装。 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
