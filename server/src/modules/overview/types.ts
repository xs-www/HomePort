/**
 * 概览模块的应用层类型（HTTP 契约见 docs/static/04-api-contract.md §2）。
 */
import type { TailnetDevice } from '../tailscale/types.js';

export interface OverviewContainerStats {
  total: number;
  running: number;
  stopped: number;
  tailnetReachable: number;
  lanReachable: number;
  localhostOnly: number;
  attention: number;
}

export interface OverviewTailnetStats {
  self: TailnetDevice | null;
  peersTotal: number;
  peersOnline: number;
  peersOffline: number;
  backendState: string | null;
  /** 在线设备（最多 6 台，供概览展示） */
  onlinePeers: Array<{ id: string; hostname: string; os: string; ipv4: string | null; connection: string }>;
}

export interface OverviewSystemStats {
  cpuPercent: number | null;
  cpuModel: string;
  cpuCores: number;
  memPercent: number | null;
  memUsedBytes: number;
  memTotalBytes: number;
  diskPercent: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  diskLabel: string | null;
  gpuPercent: number | null;
  gpuName: string | null;
  gpuMemPercent: number | null;
  uptimeSec: number;
  hostname: string;
  osLabel: string;
}

export interface OverviewToolStats {
  total: number;
  up: number;
  down: number;
  unknown: number;
  /** 突出显示的工具（featured，最多 6 个） */
  featured: Array<{ id: string; name: string; state: string; url: string | null; latencyMs: number | null }>;
}

export interface OverviewSourceStatus {
  available: boolean;
  mode: string;
  detail: string | null;
}

export interface Overview {
  generatedAt: string;
  containers: OverviewContainerStats;
  tailnet: OverviewTailnetStats;
  system: OverviewSystemStats;
  tools: OverviewToolStats;
  sources: {
    docker: OverviewSourceStatus;
    tailscale: OverviewSourceStatus;
    system: OverviewSourceStatus;
    gpu: OverviewSourceStatus;
  };
  /** 聚合过程中出现的问题（例如某个数据源不可用） */
  warnings: string[];
}
