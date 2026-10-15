/**
 * 宿主 `/proc` 解析：CPU、内存、负载、运行时长。
 *
 * 存在意义：容器内的 `os.totalmem()` / `os.cpus()` 看到的是**容器自身**的限制视图，
 * 而非宿主真实值。要拿到宿主真实占用必须读挂载进来的宿主 `/proc`
 * （compose 里 `- /proc:/host/proc:ro`）。本模块把该差异收敛在一个地方。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CpuTimes {
  /** 自启动以来累计的各状态 jiffies */
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
  total: number;
  idleAll: number;
}

export interface MemoryInfo {
  totalBytes: number;
  availableBytes: number;
  freeBytes: number;
  usedBytes: number;
  cachedBytes: number;
  buffersBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
  swapUsedBytes: number;
}

export interface HostIdentity {
  hostname: string;
  platform: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  /** 宿主 OS 描述，如 `Windows (Docker Desktop)` / `Synology DSM` */
  osLabel: string;
}

/** 读取宿主的 `/etc/os-release` → `PRETTY_NAME`；失败返回 null。 */
export function readOsRelease(procRoot: string): { prettyName: string | null; isDockerDesktop: boolean } {
  // /etc/os-release 不属于 /proc，这里同时探测常见挂载位置
  const candidates = ['/host/etc/os-release', '/etc/os-release'];
  for (const candidate of candidates) {
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      const pretty = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(content)?.[1]?.trim() ?? null;
      const isDockerDesktop = /docker desktop/i.test(content) || /^ID=docker-desktop$/m.test(content);
      return { prettyName: pretty, isDockerDesktop };
    } catch {
      // 继续尝试下一个候选
    }
  }
  void procRoot;
  return { prettyName: null, isDockerDesktop: false };
}

/**
 * 解析 `/proc/stat` 的第一行 `cpu ...`。
 *
 * @param content /proc/stat 全文
 * @returns 累计时间；解析失败返回 null
 */
export function parseProcStat(content: string): CpuTimes | null {
  const line = content.split('\n').find((l) => l.startsWith('cpu '));
  if (!line) return null;
  const fields = line.trim().split(/\s+/).slice(1).map(Number);
  if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) return null;

  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  const idleAll = idle + iowait;
  const total = user + nice + system + idle + iowait + irq + softirq + steal;
  return { user, nice, system, idle, iowait, irq, softirq, steal, total, idleAll };
}

/**
 * 解析 `/proc/stat` 每个核心的 `cpuN` 行，返回各核心累计总量。
 *
 * @returns 形如 `[{ index: 0, total, idleAll }]`
 */
export function parseProcStatPerCore(content: string): Array<{ index: number; total: number; idleAll: number }> {
  const out: Array<{ index: number; total: number; idleAll: number }> = [];
  for (const line of content.split('\n')) {
    const match = /^cpu(\d+)\s+(.*)$/.exec(line.trim());
    if (!match) continue;
    const index = Number(match[1]);
    const fields = (match[2] ?? '').trim().split(/\s+/).map(Number);
    if (fields.length < 4 || fields.some((n) => !Number.isFinite(n))) continue;
    const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
    out.push({
      index,
      total: user + nice + system + idle + iowait + irq + softirq + steal,
      idleAll: idle + iowait,
    });
  }
  return out;
}

/**
 * 解析 `/proc/meminfo`。
 *
 * @param content /proc/meminfo 全文
 */
export function parseMemInfo(content: string): MemoryInfo | null {
  const values = new Map<string, number>();
  for (const line of content.split('\n')) {
    const match = /^(\w+(?:\(\w+\))?):\s+(\d+)(?:\s+kB)?/.exec(line.trim());
    if (!match) continue;
    values.set(match[1] ?? '', Number(match[2]));
  }
  const total = (values.get('MemTotal') ?? 0) * 1024;
  if (total <= 0) return null;

  const free = (values.get('MemFree') ?? 0) * 1024;
  const cached = ((values.get('Cached') ?? 0) + (values.get('SReclaimable') ?? 0)) * 1024;
  const buffers = (values.get('Buffers') ?? 0) * 1024;
  const available = values.has('MemAvailable')
    ? (values.get('MemAvailable') ?? 0) * 1024
    : free + cached + buffers;
  const swapTotal = (values.get('SwapTotal') ?? 0) * 1024;
  const swapFree = (values.get('SwapFree') ?? 0) * 1024;

  return {
    totalBytes: total,
    availableBytes: Math.min(available, total),
    freeBytes: free,
    usedBytes: Math.max(0, total - available),
    cachedBytes: cached,
    buffersBytes: buffers,
    swapTotalBytes: swapTotal,
    swapFreeBytes: swapFree,
    swapUsedBytes: Math.max(0, swapTotal - swapFree),
  };
}

/** 解析 `/proc/uptime` 第一列（秒）。 */
export function parseProcUptime(content: string): number | null {
  const first = content.trim().split(/\s+/)[0];
  const parsed = Number(first);
  return Number.isFinite(parsed) ? parsed : null;
}

/** 解析 `/proc/cpuinfo` 的 `model name`，失败返回 null。 */
export function parseCpuModel(content: string): string | null {
  const match = /^model name\s*:\s*(.+)$/m.exec(content) ?? /^Hardware\s*:\s*(.+)$/m.exec(content);
  return match?.[1]?.trim() ?? null;
}

/** 读取宿主 `/proc/loadavg` 的三个负载值。 */
export function parseLoadAvg(content: string): [number, number, number] | null {
  const parts = content.trim().split(/\s+/).slice(0, 3).map(Number);
  if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) return null;
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * 用 `os.cpus()` 的累计时间合成 `CpuTimes`（Windows/macOS 的兜底路径）。
 *
 * `node:os` 只提供 user/nice/sys/idle/irq 五项，且单位是**毫秒**而非 jiffies。
 * 这对「两次采样求差」的用法没有影响（单位一致即可），因此可以直接复用
 * 同一套使用率计算逻辑。
 *
 * @returns 无 CPU 信息时返回 null
 */
export function osCpusToCpuTimes(): CpuTimes | null {
  const cpus = os.cpus();
  if (cpus.length === 0) return null;

  let user = 0;
  let nice = 0;
  let system = 0;
  let idle = 0;
  let irq = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    user += t.user;
    nice += t.nice;
    system += t.sys;
    idle += t.idle;
    irq += t.irq;
  }
  const total = user + nice + system + idle + irq;
  return {
    user,
    nice,
    system,
    idle,
    // os 接口不区分 iowait/softirq/steal，统一归零
    iowait: 0,
    irq,
    softirq: 0,
    steal: 0,
    total,
    idleAll: idle,
  };
}

/**
 * 宿主 `/proc` 读取器。
 *
 * 所有方法在「宿主 /proc 未挂载」时**降级**到容器自身视图（`node:os`），
 * 并通过 `usingHostProc` 暴露当前实际数据源，供 `/api/system/snapshot` 的
 * `sources[].mode` 字段使用。
 */
export class HostProcReader {
  private readonly procRoot: string;

  constructor(procRoot: string) {
    this.procRoot = procRoot;
  }

  /** 宿主 /proc 是否可用（以 `/proc/stat` 是否可读为准）。 */
  get usingHostProc(): boolean {
    return this.readFile('stat') !== null;
  }

  /** 实际使用的 proc 根路径。 */
  get root(): string {
    return this.procRoot;
  }

  private readFile(name: string): string | null {
    try {
      return fs.readFileSync(path.join(this.procRoot, name), 'utf8');
    } catch {
      return null;
    }
  }

  /**
   * 读取累计 CPU 时间。
   *
   * 优先级：宿主 `/proc/stat` → `os.cpus()` 聚合。
   *
   * 为什么需要 `os.cpus()` 兜底：Windows 与 macOS 上没有 `/proc`，
   * 而 `node:os` 的 `cpus()[i].times` 返回的正是**整机**（宿主）累计 CPU 时间，
   * 因此这条路径得到的仍是宿主真实使用率，不是容器视图。
   */
  readCpuTimes(): CpuTimes | null {
    const content = this.readFile('stat');
    if (content) {
      const parsed = parseProcStat(content);
      if (parsed) return parsed;
    }
    return osCpusToCpuTimes();
  }

  /** 数据源标识：`host-proc` | `os-cpus` | `none`。 */
  cpuSource(): 'host-proc' | 'os-cpus' | 'none' {
    if (this.readFile('stat') !== null) return 'host-proc';
    return os.cpus().length > 0 ? 'os-cpus' : 'none';
  }

  /** 读取各核心累计时间。 */
  readPerCoreTimes(): Array<{ index: number; total: number; idleAll: number }> {
    const content = this.readFile('stat');
    if (content) {
      const perCore = parseProcStatPerCore(content);
      if (perCore.length > 0) return perCore;
    }
    return os.cpus().map((cpu, index) => {
      const t = cpu.times;
      const idle = t.idle;
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      return { index, total, idleAll: idle };
    });
  }

  /** 读取内存信息；失败时用 `os` 降级。 */
  readMemory(): { info: MemoryInfo; fromHostProc: boolean } {
    const content = this.readFile('meminfo');
    if (content) {
      const parsed = parseMemInfo(content);
      if (parsed) return { info: parsed, fromHostProc: true };
    }
    const total = os.totalmem();
    const free = os.freemem();
    const available = free;
    return {
      info: {
        totalBytes: total,
        availableBytes: available,
        freeBytes: free,
        usedBytes: Math.max(0, total - available),
        cachedBytes: 0,
        buffersBytes: 0,
        swapTotalBytes: 0,
        swapFreeBytes: 0,
        swapUsedBytes: 0,
      },
      fromHostProc: false,
    };
  }

  /** 读取运行时长（秒）；失败降级到 `os.uptime()`。 */
  readUptime(): { seconds: number; fromHostProc: boolean } {
    const content = this.readFile('uptime');
    if (content) {
      const parsed = parseProcUptime(content);
      if (parsed !== null) return { seconds: parsed, fromHostProc: true };
    }
    return { seconds: os.uptime(), fromHostProc: false };
  }

  /** 读取负载均值；容器内为宿主负载（Linux），Windows 上为 [0,0,0]。 */
  readLoadAvg(): [number, number, number] {
    const content = this.readFile('loadavg');
    if (content) {
      const parsed = parseLoadAvg(content);
      if (parsed) return parsed;
    }
    const [a = 0, b = 0, c = 0] = os.loadavg();
    return [a, b, c];
  }

  /** 读取 CPU 型号；优先宿主 `/proc/cpuinfo`，否则 `os.cpus()[0].model`。 */
  readCpuModel(): string {
    const content = this.readFile('cpuinfo');
    if (content) {
      const parsed = parseCpuModel(content);
      if (parsed) return parsed;
    }
    return os.cpus()[0]?.model?.trim() ?? 'unknown';
  }

  /** 宿主 CPU 逻辑核心数。 */
  readCpuCores(): number {
    const perCore = this.readPerCoreTimes();
    if (perCore.length > 0) return perCore.length;
    return os.cpus().length;
  }

  /** 汇总宿主身份信息。 */
  readIdentity(): HostIdentity {
    const { prettyName, isDockerDesktop } = readOsRelease(this.procRoot);
    const platform = os.platform();
    let osLabel: string;
    if (isDockerDesktop) osLabel = 'Docker Desktop (WSL2)';
    else if (prettyName) osLabel = prettyName;
    else osLabel = `${platform} ${os.release()}`;
    return {
      hostname: os.hostname(),
      platform,
      kernel: os.release(),
      arch: os.arch(),
      cpuModel: this.readCpuModel(),
      cpuCores: this.readCpuCores(),
      osLabel,
    };
  }
}

/**
 * 由前后两次 CPU 累计值计算使用率（%）。
 *
 * @returns 使用率百分比；无有效增量（间隔过短）返回 null
 */
export function cpuPercentBetween(prev: CpuTimes, next: CpuTimes): number | null {
  const totalDelta = next.total - prev.total;
  const idleDelta = next.idleAll - prev.idleAll;
  if (totalDelta <= 0) return null;
  const busy = Math.max(0, totalDelta - idleDelta);
  return (busy / totalDelta) * 100;
}
