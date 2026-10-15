/**
 * F3 系统指标模块的应用层类型（HTTP 契约见 docs/static/04-api-contract.md §5）。
 */

export interface SourceStatus {
  available: boolean;
  /** host-proc / container-proc / statfs / nvidia-smi / none */
  mode: string;
  detail: string | null;
}

export interface HostIdentityView {
  hostname: string;
  platform: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  uptimeSec: number;
  bootedAt: string;
  osLabel: string;
  /** 是否为 Linux 宿主（决定 /proc 与 df 是否可用） */
  hostIsLinux: boolean;
}

export interface CpuView {
  percent: number | null;
  perCore: number[];
  loadAvg: [number, number, number];
}

export interface MemoryView {
  usedBytes: number;
  totalBytes: number;
  availableBytes: number;
  percent: number | null;
  cachedBytes: number;
  swapUsedBytes: number;
  swapTotalBytes: number;
}

export interface DiskView {
  mount: string;
  label: string;
  fsType: string | null;
  usedBytes: number | null;
  totalBytes: number | null;
  availableBytes: number | null;
  percent: number | null;
  /** 读取失败原因 */
  error: string | null;
}

export interface GpuProcessView {
  pid: number;
  name: string;
  memoryUsedBytes: number | null;
}

export interface GpuView {
  available: boolean;
  index: number;
  name: string;
  percent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
  powerLimitWatts: number | null;
  fanPercent: number | null;
  processes: GpuProcessView[];
  detail: string | null;
}

export interface SystemSources {
  cpu: SourceStatus;
  memory: SourceStatus;
  disk: SourceStatus;
  gpu: SourceStatus;
}

export interface SystemSnapshot {
  generatedAt: string;
  host: HostIdentityView;
  cpu: CpuView;
  memory: MemoryView;
  disks: DiskView[];
  gpu: GpuView | null;
  sources: SystemSources;
}

/** SSE 帧（不含 host，减少带宽）。 */
export interface SystemMetricsFrame {
  generatedAt: string;
  cpu: CpuView;
  memory: MemoryView;
  disks: DiskView[];
  gpu: GpuView | null;
  sources: Pick<SystemSources, 'cpu' | 'memory' | 'gpu'>;
}
