/**
 * 概览聚合服务：首屏一次请求拿到四个数据源的摘要。
 *
 * 容错原则：任一数据源失败**不影响**其它数据源，失败信息进入 `warnings`
 * 并把对应 `sources.*.available` 置 false，前端照常渲染其余卡片。
 */
import type { Logger } from '../../logger.js';
import type { ContainerService, HostContextRequest } from '../docker/service.js';
import type { PortalHostContext } from '../docker/hostContext.js';
import { buildHostContext } from '../docker/hostContext.js';
import type { SystemService } from '../system/service.js';
import type { TailscaleService } from '../tailscale/service.js';
import type { ToolsService } from '../tools/service.js';
import { percentOf, round } from '../../util/format.js';
import type { Overview, OverviewSourceStatus } from './types.js';
import type { PortalConfig } from '../../config.js';

export interface OverviewServiceDeps {
  containers: ContainerService;
  tailscale: TailscaleService;
  system: SystemService;
  tools: ToolsService;
  config: PortalConfig;
  logger: Logger;
}

/** 概览中在线设备最多展示的数量。 */
export const ONLINE_PEER_LIMIT = 6;
/** 概览中 featured 工具最多展示的数量。 */
export const FEATURED_TOOL_LIMIT = 6;

export class OverviewService {
  private readonly deps: OverviewServiceDeps;
  private readonly log: Logger;

  constructor(deps: OverviewServiceDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ mod: 'overview' });
  }

  /** 聚合一屏数据。 */
  async build(request: HostContextRequest, role: 'admin' | 'viewer'): Promise<Overview> {
    const hostContext = this.buildHost(request);
    const warnings: string[] = [];

    const [containersResult, tailnetResult, systemResult, toolsResult] = await Promise.allSettled([
      this.deps.containers.list({ all: true, stats: false }, request),
      this.deps.tailscale.getStatus(),
      this.deps.system.snapshot(),
      this.deps.tools.list({ probe: true, role }, hostContext),
    ]);

    const sources: Overview['sources'] = {
      docker: { available: false, mode: 'none', detail: null },
      tailscale: { available: false, mode: 'none', detail: null },
      system: { available: false, mode: 'none', detail: null },
      gpu: { available: false, mode: 'none', detail: null },
    };

    // 容器
    let containers: Overview['containers'] = {
      total: 0,
      running: 0,
      stopped: 0,
      tailnetReachable: 0,
      lanReachable: 0,
      localhostOnly: 0,
      attention: 0,
    };
    if (containersResult.status === 'fulfilled') {
      containers = containersResult.value.summary;
      sources.docker = containersResult.value.source;
      if (!containersResult.value.source.available && containersResult.value.source.detail) {
        warnings.push(`容器：${containersResult.value.source.detail}`);
      }
    } else {
      sources.docker = describeFailure('docker', containersResult.reason, warnings);
    }

    // tailnet
    let tailnet: Overview['tailnet'] = {
      self: null,
      peersTotal: 0,
      peersOnline: 0,
      peersOffline: 0,
      backendState: null,
      onlinePeers: [],
    };
    if (tailnetResult.status === 'fulfilled') {
      const status = tailnetResult.value;
      sources.tailscale = status.source;
      tailnet = {
        self: status.self,
        peersTotal: status.summary.peersTotal,
        peersOnline: status.summary.peersOnline,
        peersOffline: status.summary.peersOffline,
        backendState: status.backendState,
        onlinePeers: status.peers
          .filter((peer) => peer.online)
          .slice(0, ONLINE_PEER_LIMIT)
          .map((peer) => ({
            id: peer.id,
            hostname: peer.hostname,
            os: peer.os,
            ipv4: peer.ipv4,
            connection: peer.connection,
          })),
      };
      if (!status.source.available && status.source.detail) warnings.push(`tailnet：${status.source.detail}`);
    } else {
      sources.tailscale = describeFailure('tailscale', tailnetResult.reason, warnings);
    }

    // 系统
    let system: Overview['system'] = {
      cpuPercent: null,
      cpuModel: '未知',
      cpuCores: 0,
      memPercent: null,
      memUsedBytes: 0,
      memTotalBytes: 0,
      diskPercent: null,
      diskUsedBytes: null,
      diskTotalBytes: null,
      diskLabel: null,
      gpuPercent: null,
      gpuName: null,
      gpuMemPercent: null,
      uptimeSec: 0,
      hostname: '未知',
      osLabel: '未知',
    };
    if (systemResult.status === 'fulfilled') {
      const snapshot = systemResult.value;
      const primaryDisk = pickPrimaryDisk(snapshot.disks);
      sources.system = snapshot.sources.cpu;
      sources.gpu = snapshot.sources.gpu;
      system = {
        cpuPercent: snapshot.cpu.percent,
        cpuModel: snapshot.host.cpuModel,
        cpuCores: snapshot.host.cpuCores,
        memPercent: snapshot.memory.percent,
        memUsedBytes: snapshot.memory.usedBytes,
        memTotalBytes: snapshot.memory.totalBytes,
        diskPercent: primaryDisk?.percent ?? null,
        diskUsedBytes: primaryDisk?.usedBytes ?? null,
        diskTotalBytes: primaryDisk?.totalBytes ?? null,
        diskLabel: primaryDisk?.label ?? null,
        gpuPercent: snapshot.gpu?.percent ?? null,
        gpuName: snapshot.gpu?.name ?? null,
        gpuMemPercent: percentOf(snapshot.gpu?.memoryUsedBytes ?? 0, snapshot.gpu?.memoryTotalBytes ?? 0, 1),
        uptimeSec: snapshot.host.uptimeSec,
        hostname: snapshot.host.hostname,
        osLabel: snapshot.host.osLabel,
      };
      if (snapshot.sources.cpu.detail) warnings.push(`CPU/内存：${snapshot.sources.cpu.detail}`);
      if (!snapshot.sources.disk.available && snapshot.sources.disk.detail) warnings.push(`磁盘：${snapshot.sources.disk.detail}`);
      if (!snapshot.sources.gpu.available && snapshot.sources.gpu.detail) warnings.push(`GPU：${snapshot.sources.gpu.detail}`);
    } else {
      sources.system = describeFailure('system', systemResult.reason, warnings);
    }

    // 工具
    let tools: Overview['tools'] = { total: 0, up: 0, down: 0, unknown: 0, featured: [] };
    if (toolsResult.status === 'fulfilled') {
      const result = toolsResult.value;
      tools = {
        total: result.summary.total,
        up: result.summary.up,
        down: result.summary.down,
        unknown: result.summary.unknown,
        featured: result.items
          .filter((item) => item.featured)
          .slice(0, FEATURED_TOOL_LIMIT)
          .map((item) => ({
            id: item.id,
            name: item.name,
            state: item.status.state,
            url: item.url,
            latencyMs: item.status.latencyMs,
          })),
      };
    } else {
      warnings.push(`工具目录：${describeReason(toolsResult.reason)}`);
    }

    return {
      generatedAt: new Date().toISOString(),
      containers,
      tailnet,
      system,
      tools,
      sources,
      warnings,
    };
  }

  private buildHost(request: HostContextRequest): PortalHostContext {
    return buildHostContext({
      config: this.deps.config,
      request: {
        protocol: request.protocol,
        hostname: request.hostname,
        headers: request.headers,
        port: request.port,
      },
      tailscaleIpv4: this.deps.tailscale.getTailscaleIpv4(),
      tailscaleDnsName: this.deps.tailscale.getTailscaleDnsName(),
    });
  }
}

/** 选择"主磁盘"：优先挂载点最短且可读的第一个（通常是系统盘）。 */
export function pickPrimaryDisk(disks: readonly import('../system/types.js').DiskView[]): import('../system/types.js').DiskView | null {
  const readable = disks.filter((disk) => disk.totalBytes !== null && disk.totalBytes > 0);
  if (readable.length === 0) return null;
  return [...readable].sort((a, b) => a.mount.length - b.mount.length)[0] ?? null;
}

/** 计算内存百分比（导出供测试）。 */
export function memoryPercent(used: number, total: number): number | null {
  return round(percentOf(used, total, 1), 1);
}

function describeFailure(
  area: string,
  reason: unknown,
  warnings: string[],
): OverviewSourceStatus {
  const message = describeReason(reason);
  warnings.push(`${area}：${message}`);
  return { available: false, mode: 'none', detail: message };
}

function describeReason(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}
