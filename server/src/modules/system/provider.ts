/**
 * 系统指标数据源：CPU / 内存 / 磁盘 / GPU / 宿主身份。
 *
 * ## 指标取数边界（重要）
 *
 * 容器内的 `os.cpus()` / `os.totalmem()` 看到的是**容器自身**的视图，
 * 而门户要展示的是**宿主**占用。因此：
 *
 * - Linux 宿主（含 NAS）：读挂载进来的宿主 `/proc`（`PORTAL_HOST_PROC=/host/proc`）
 *   → `mode: 'host-proc'`，数据即宿主真实值。
 * - Windows 宿主：Docker Desktop 的 WSL2 虚拟机里，**没有 Windows 的 /proc**。
 *   挂载宿主 `/proc` 拿到的是 WSL2 发行版（`docker-desktop`）的视图，
 *   它反映的是**虚拟机**而非 Windows 主机的内存/CPU 占用。
 *   此时 `mode: 'container-proc'`，响应中的 `detail` 会明确写出该限制，
 *   前端据此显示警告角标。GPU 通过 nvidia-smi（WSL GPU 直通）仍可拿到真实值。
 *
 * 这段逻辑全部集中在本文件，是为了让"数据不准"与"服务坏了"在 UI 上可区分。
 */
import fs from 'node:fs';
import os from 'node:os';
import type { PortalConfig, MountConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { formatBytes, percentOf, round, unixSecondsToIso, toIso } from '../../util/format.js';
import {
  HostProcReader,
  cpuPercentBetween,
  type CpuTimes,
} from '../../util/proc.js';
import { isSuccess, runCommand } from '../../util/exec.js';
import type {
  CpuView,
  DiskView,
  GpuProcessView,
  GpuView,
  HostIdentityView,
  MemoryView,
  SourceStatus,
  SystemSnapshot,
  SystemSources,
} from './types.js';

/** `statfs` 结果（避免直接依赖 Node 类型版本差异）。 */
interface StatfsLike {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
  type?: number;
}

export interface SystemProviderOptions {
  config: PortalConfig;
  logger: Logger;
}

/** nvidia-smi 查询字段（顺序即解析顺序）。 */
export const NVIDIA_QUERY_FIELDS = [
  'index',
  'name',
  'utilization.gpu',
  'memory.used',
  'memory.total',
  'temperature.gpu',
  'power.draw',
  'power.limit',
  'fan.speed',
] as const;

/**
 * 解析 nvidia-smi 的 CSV 输出。
 *
 * @param stdout `nvidia-smi --query-gpu=... --format=csv,noheader,nounits` 的输出
 * @returns 每张 GPU 一行；无法解析的行被跳过
 */
export function parseNvidiaSmiCsv(stdout: string): GpuView[] {
  const out: GpuView[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const fields = line.split(',').map((f) => f.trim());
    if (fields.length < 5) continue;
    const [indexStr = '', name = '', utilStr = '', memUsedStr = '', memTotalStr = '', tempStr = '', powerStr = '', powerLimitStr = '', fanStr = ''] = fields;
    const index = Number(indexStr);
    if (!Number.isInteger(index)) continue;
    const memUsed = toMiB(memUsedStr);
    const memTotal = toMiB(memTotalStr);
    out.push({
      available: true,
      index,
      name,
      percent: toNumber(utilStr),
      memoryUsedBytes: memUsed === null ? null : memUsed * 1024 * 1024,
      memoryTotalBytes: memTotal === null ? null : memTotal * 1024 * 1024,
      temperatureC: toNumber(tempStr),
      powerWatts: toNumber(powerStr),
      powerLimitWatts: toNumber(powerLimitStr),
      fanPercent: toNumber(fanStr),
      processes: [],
      detail: null,
    });
  }
  return out;
}

/**
 * 解析 `nvidia-smi --query-compute-apps=gpu_uuid,pid,process_name,used_memory` 输出。
 *
 * @returns `gpuUuid → 进程列表`
 */
export function parseNvidiaSmiProcesses(stdout: string): Map<string, GpuProcessView[]> {
  const map = new Map<string, GpuProcessView[]>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const parts = line.split(',').map((p) => p.trim());
    const [uuid = '', pidStr = '', name = '', memStr = ''] = parts;
    const pid = Number(pidStr);
    if (!uuid || !Number.isInteger(pid)) continue;
    const mem = toMiB(memStr);
    const list = map.get(uuid) ?? [];
    list.push({ pid, name, memoryUsedBytes: mem === null ? null : mem * 1024 * 1024 });
    map.set(uuid, list);
  }
  return map;
}

/** 解析 `nvidia-smi --query-gpu=index,uuid --format=csv,noheader` → index → uuid。 */
export function parseNvidiaSmiUuids(stdout: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const rawLine of stdout.split('\n')) {
    const parts = rawLine.trim().split(',').map((p) => p.trim());
    const [indexStr = '', uuid = ''] = parts;
    const index = Number(indexStr);
    if (!Number.isInteger(index) || !uuid) continue;
    map.set(index, uuid);
  }
  return map;
}

function toNumber(value: string): number | null {
  if (!value || value === '[N/A]' || value === 'N/A' || value === '[Not Supported]') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toMiB(value: string): number | null {
  const parsed = toNumber(value);
  return parsed === null ? null : parsed;
}

/** 转成可展示的容量字符串（供 detail 使用）。 */
export function humanBytes(bytes: number | null): string {
  return bytes === null ? '未知' : formatBytes(bytes);
}

export class SystemProvider {
  private readonly config: PortalConfig;
  private readonly log: Logger;
  private readonly proc: HostProcReader;
  private prevCpu: CpuTimes | null = null;
  private prevPerCore: Array<{ index: number; total: number; idleAll: number }> = [];
  /** 上次采样时间：两次采样间隔过短时复用量值，避免出现 null / 抖动 */
  private prevCpuAt = 0;
  private lastCpuView: CpuView | null = null;
  private cachedGpu: { view: GpuView | null; status: SourceStatus; at: number } | null = null;

  /** CPU 使用率计算所需的最小采样间隔（宿主 /proc/stat 的 jiffies 精度约 10ms）。 */
  static readonly MIN_CPU_SAMPLE_INTERVAL_MS = 500;

  constructor(options: SystemProviderOptions) {
    this.config = options.config;
    this.log = options.logger.child({ mod: 'system' });
    this.proc = new HostProcReader(options.config.system.procPath);
  }

  /** 宿主 /proc 是否可用。 */
  get usingHostProc(): boolean {
    return this.proc.usingHostProc;
  }

  /**
   * 采集一次完整快照。
   *
   * CPU 使用率需要两次采样，因此本方法会保存上次采样值；
   * 首次调用（或间隔过短）时 `cpu.percent` 为 null，前端显示"采样中"。
   */
  async snapshot(): Promise<SystemSnapshot> {
    const host = this.readHost();
    const cpu = this.readCpu();
    const memory = this.readMemory();
    const disks = await this.readDisks();
    const { gpu, status: gpuStatus } = await this.readGpu();

    const cpuSource = this.proc.cpuSource();
    const cpuStatus: SourceStatus =
      cpuSource === 'host-proc'
        ? { available: true, mode: 'host-proc', detail: null }
        : cpuSource === 'os-cpus'
          ? { available: true, mode: 'os-cpus', detail: describeOsCpuMode() }
          : { available: false, mode: 'none', detail: '无法获取 CPU 计时信息（既无宿主 /proc，os.cpus() 也为空）' };

    const memFromHost = this.proc.readMemory().fromHostProc;
    const memoryStatus: SourceStatus = memFromHost
      ? { available: true, mode: 'host-proc', detail: null }
      : { available: true, mode: 'container-proc', detail: describeProcFallback(this.config.system.procPath) };

    const diskOk = disks.some((d) => d.totalBytes !== null);
    const diskStatus: SourceStatus = {
      available: diskOk,
      mode: 'statfs',
      detail: diskOk
        ? null
        : this.config.system.mounts.length === 0
          ? '未配置磁盘挂载点（PORTAL_DISK_MOUNTS）'
          : `无法读取已配置的磁盘挂载点：${this.config.system.mounts.map((m) => m.containerPath).join(', ')}`,
    };

    const sources: SystemSources = { cpu: cpuStatus, memory: memoryStatus, disk: diskStatus, gpu: gpuStatus };

    return {
      generatedAt: new Date().toISOString(),
      host,
      cpu,
      memory,
      disks,
      gpu,
      sources,
    };
  }

  /** 宿主身份与运行时长。 */
  readHost(): HostIdentityView {
    const identity = this.proc.readIdentity();
    const uptime = this.proc.readUptime();
    return {
      hostname: identity.hostname,
      platform: identity.platform,
      kernel: identity.kernel,
      arch: identity.arch,
      cpuModel: identity.cpuModel,
      cpuCores: identity.cpuCores,
      uptimeSec: Math.floor(uptime.seconds),
      bootedAt: unixSecondsToIso(Date.now() / 1000 - uptime.seconds) ?? new Date().toISOString(),
      osLabel: identity.osLabel,
      hostIsLinux: identity.platform === 'linux',
    };
  }

  /**
   * CPU 使用率：与上次采样做差。
   *
   * 首次调用返回 `percent: null`（无基线）；若距上次采样不足
   * `MIN_CPU_SAMPLE_INTERVAL_MS`，则**复用上次结果**而不是重新采样 ——
   * 否则连续两次快照会因分子分母都接近 0 而给出 0% 或 null 的抖动读数。
   */
  readCpu(): CpuView {
    const now = Date.now();
    const fresh = now - this.prevCpuAt >= SystemProvider.MIN_CPU_SAMPLE_INTERVAL_MS;
    if (!fresh && this.lastCpuView) return this.lastCpuView;

    const current = this.proc.readCpuTimes();
    const currentPerCore = this.proc.readPerCoreTimes();
    let percent: number | null = null;
    const perCore: number[] = [];

    if (current && this.prevCpu) {
      percent = cpuPercentBetween(this.prevCpu, current);
    }
    if (currentPerCore.length > 0 && this.prevPerCore.length === currentPerCore.length) {
      for (let i = 0; i < currentPerCore.length; i += 1) {
        const prev = this.prevPerCore[i];
        const next = currentPerCore[i];
        if (!prev || !next) continue;
        const totalDelta = next.total - prev.total;
        const idleDelta = next.idleAll - prev.idleAll;
        if (totalDelta <= 0) continue;
        perCore.push(round(((totalDelta - Math.max(0, idleDelta)) / totalDelta) * 100, 1) ?? 0);
      }
    }

    if (current) {
      this.prevCpu = current;
      this.prevCpuAt = now;
    }
    if (currentPerCore.length > 0) this.prevPerCore = currentPerCore;

    const view: CpuView = {
      percent: round(percent, 1),
      perCore,
      loadAvg: this.proc.readLoadAvg(),
    };
    this.lastCpuView = view;
    return view;
  }

  /** 内存占用。 */
  readMemory(): MemoryView {
    const { info } = this.proc.readMemory();
    return {
      usedBytes: info.usedBytes,
      totalBytes: info.totalBytes,
      availableBytes: info.availableBytes,
      percent: percentOf(info.usedBytes, info.totalBytes, 1),
      cachedBytes: info.cachedBytes,
      swapUsedBytes: info.swapUsedBytes,
      swapTotalBytes: info.swapTotalBytes,
    };
  }

  /**
   * 磁盘占用：对每个配置的挂载点调用 `statfs`。
   *
   * 注意 `used = (blocks - bfree) * bsize`（`statfs` 的 `bfree` 语义与 Node 的
   * `fs.statfs` 的 `bfree` 一致，均为"总空闲块含保留块"）。
   */
  async readDisks(): Promise<DiskView[]> {
    const mounts: MountConfig[] = this.config.system.mounts;
    const results: DiskView[] = [];

    for (const mount of mounts) {
      const base: DiskView = {
        mount: mount.path,
        label: mount.label,
        fsType: null,
        usedBytes: null,
        totalBytes: null,
        availableBytes: null,
        percent: null,
        error: null,
      };
      try {
        const stats = (await fs.promises.statfs(mount.statPath)) as unknown as StatfsLike;
        const bsize = Number(stats.bsize);
        const blocks = Number(stats.blocks);
        const bfree = Number(stats.bfree);
        const bavail = Number(stats.bavail);
        if (!Number.isFinite(blocks) || !Number.isFinite(bsize) || blocks <= 0) {
          results.push({ ...base, error: 'statfs 返回无效的块数' });
          continue;
        }
        const totalBytes = blocks * bsize;
        const availableBytes = bavail * bsize;
        const usedBytes = Math.max(0, (blocks - bfree) * bsize);
        results.push({
          ...base,
          fsType: describeFsType(stats.type),
          totalBytes,
          availableBytes,
          usedBytes,
          percent: percentOf(usedBytes, usedBytes + availableBytes, 1),
        });
      } catch (error) {
        results.push({ ...base, error: describeStatfsError(error, mount) });
      }
    }

    return results;
  }

  /** GPU 信息（带 3s 缓存，nvidia-smi 调用较重）。 */
  async readGpu(): Promise<{ gpu: GpuView | null; status: SourceStatus }> {
    const ttl = 3000;
    if (this.cachedGpu && Date.now() - this.cachedGpu.at < ttl) {
      return { gpu: this.cachedGpu.view, status: this.cachedGpu.status };
    }

    const result = await this.queryGpu();
    this.cachedGpu = { view: result.gpu, status: result.status, at: Date.now() };
    return result;
  }

  /**
   * 直接调用 nvidia-smi 查询。
   *
   * 支持通过 `PORTAL_NVIDIA_LD_LIBRARY_PATH` 注入 WSL 的库路径
   * （Docker Desktop 下为 `/usr/lib/wsl/lib`）。
   */
  private async queryGpu(): Promise<{ gpu: GpuView | null; status: SourceStatus }> {
    const bin = this.config.system.nvidiaSmi;
    const env = { ...process.env };
    if (this.config.system.ldLibraryPath) {
      env.LD_LIBRARY_PATH = `${this.config.system.ldLibraryPath}:${env.LD_LIBRARY_PATH ?? ''}`.replace(/:$/, '');
    }

    const query = await runCommand(
      bin,
      [`--query-gpu=${NVIDIA_QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
      { timeoutMs: this.config.system.commandTimeoutMs, env },
    );

    if (query.notFound) {
      return {
        gpu: null,
        status: {
          available: false,
          mode: 'none',
          detail: `未找到 nvidia-smi（${bin}）。若宿主有 NVIDIA GPU，请将其挂载进容器并设置 PORTAL_NVIDIA_SMI`,
        },
      };
    }
    if (query.timedOut) {
      return { gpu: null, status: { available: false, mode: 'nvidia-smi', detail: 'nvidia-smi 执行超时' } };
    }
    if (!isSuccess(query)) {
      const stderr = query.stderr.trim().split('\n')[0] ?? '';
      return {
        gpu: null,
        status: {
          available: false,
          mode: 'nvidia-smi',
          detail: `nvidia-smi 执行失败（退出码 ${query.code}）${stderr ? `：${stderr}` : ''}`,
        },
      };
    }

    const gpus = parseNvidiaSmiCsv(query.stdout);
    if (gpus.length === 0) {
      return { gpu: null, status: { available: false, mode: 'nvidia-smi', detail: 'nvidia-smi 未返回任何 GPU' } };
    }

    // 附带进程信息（失败不影响主流程）
    const processes = await this.queryGpuProcesses(env);
    const primary = gpus[0];
    if (!primary) {
      return { gpu: null, status: { available: false, mode: 'nvidia-smi', detail: 'nvidia-smi 输出解析失败' } };
    }
    if (processes.size > 0) {
      primary.processes = processes.get(String(primary.index)) ?? firstValue(processes) ?? [];
    }

    return { gpu: primary, status: { available: true, mode: 'nvidia-smi', detail: null } };
  }

  private async queryGpuProcesses(env: NodeJS.ProcessEnv): Promise<Map<string, GpuProcessView[]>> {
    const bin = this.config.system.nvidiaSmi;
    const byIndex = await runCommand(
      bin,
      ['--query-gpu=index,uuid', '--format=csv,noheader'],
      { timeoutMs: this.config.system.commandTimeoutMs, env },
    );
    const byProcess = await runCommand(
      bin,
      ['--query-compute-apps=gpu_uuid,pid,process_name,used_memory', '--format=csv,noheader,nounits'],
      { timeoutMs: this.config.system.commandTimeoutMs, env },
    );

    if (!isSuccess(byProcess) || byProcess.stdout.trim() === '') return new Map();

    const uuidToIndex = isSuccess(byIndex) ? parseNvidiaSmiUuids(byIndex.stdout) : new Map<number, string>();
    const raw = parseNvidiaSmiProcesses(byProcess.stdout);
    const result = new Map<string, GpuProcessView[]>();
    for (const [uuid, list] of raw) {
      const index = [...uuidToIndex.entries()].find(([, value]) => value === uuid)?.[0];
      result.set(index === undefined ? uuid : String(index), list);
    }
    return result;
  }
}

/** 采集宿主 /proc 失败时的说明文案。 */
export function describeProcFallback(procPath: string): string {
  return `未能读取宿主 ${procPath}，内存占用取自运行门户的宿主/进程视图。Linux 与 NAS 请把宿主 /proc 挂载到该路径以获得宿主真实内存占用`;
}

/**
 * 走了 `os.cpus()` 兜底路径时的说明。
 *
 * 该路径在 Windows/macOS 上得到的是**宿主整机** CPU 时间（非容器视图），
 * 因此不需要警告，只需说明各核心数据可用、负载均值为 0 的原因。
 */
export function describeOsCpuMode(): string | null {
  return null;
}

/** 描述 statfs 失败原因。 */
export function describeStatfsError(error: unknown, mount: MountConfig): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return `路径 ${mount.statPath} 不存在，请确认 compose 中已把宿主 ${mount.path} 挂载到该路径`;
  }
  if (code === 'EACCES') return `无权访问 ${mount.statPath}`;
  return `读取 ${mount.statPath} 失败：${error instanceof Error ? error.message : String(error)}`;
}

/**
 * 由 statfs 的 `type` 魔数粗判文件系统名（仅用于展示）。
 *
 * 魔数常量来自各内核的 `include/uapi/linux/magic.h`。
 * `9p` 与 `virtiofs` 是 WSL2 / Docker Desktop 访问 Windows 盘时的实际类型
 * （实测：挂载 `C:/` 后 statfs 报 `0x01021997`，`df -T` 显示 `9p`）。
 */
export function describeFsType(type: number | undefined): string | null {
  if (type === undefined) return null;
  const known: Record<number, string> = {
    0x01021994: 'tmpfs',
    0x01021997: '9p', // WSL2 / DrvFs：Windows 盘挂进 Linux 时的类型
    0x65735546: 'fuse',
    0x65735543: 'fusectl',
    0x794c7630: 'overlayfs',
    0x58465342: 'xfs',
    0x9123683e: 'btrfs',
    0xef53: 'ext4',
    0x6969: 'nfs',
    0xff534d42: 'cifs',
    0x4d44: 'fat',
    0x5346544e: 'ntfs',
    0x2fc12fc1: 'zfs',
    0xde5e81e4: 'vfat',
    0x1cd1: 'devpts',
    0xf97cff8c: 'selinux',
    0x6e736673: 'nsfs',
    0x62656572: 'sysfs',
    0x9fa0: 'proc',
    0x01021996: 'hugetlbfs',
    0x958458f6: 'virtiofs',
  };
  return known[type] ?? `0x${type.toString(16)}`;
}

function firstValue<V>(map: Map<string, V>): V | undefined {
  for (const value of map.values()) return value;
  return undefined;
}

/** 计算磁盘百分比（供测试直接使用）。 */
export function diskPercent(usedBytes: number, availableBytes: number): number | null {
  return percentOf(usedBytes, usedBytes + availableBytes, 1);
}

/** 当前时间 ISO（供测试）。 */
export function nowIso(): string {
  return toIso(new Date()) ?? new Date().toISOString();
}
