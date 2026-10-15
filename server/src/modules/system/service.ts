/**
 * F3 系统指标业务服务。
 *
 * 职责：把 provider 的原始采集结果转成 SSE 帧，并保证一个进程内只有一份
 * 采样序列（CPU 百分比依赖前后两次采样，多路复用同一序列才能得到稳定读数）。
 */
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { buildMetricsFrame } from './service.helpers.js';
import type { SystemProvider } from './provider.js';
import type { SourceStatus, SystemMetricsFrame, SystemSnapshot } from './types.js';

export interface SystemServiceDeps {
  provider: SystemProvider;
  config: PortalConfig;
  logger: Logger;
}

export class SystemService {
  private readonly deps: SystemServiceDeps;

  constructor(deps: SystemServiceDeps) {
    this.deps = deps;
  }

  /** 运行时设置变更后同步 provider 内部状态（如 /proc 路径）。 */
  syncConfig(): boolean {
    return this.deps.provider.syncConfig();
  }

  /** 完整快照（含宿主身份）。 */
  async snapshot(): Promise<SystemSnapshot> {
    return this.deps.provider.snapshot();
  }

  /** SSE 帧（省略 host 段，减小带宽）。 */
  async metricsFrame(): Promise<SystemMetricsFrame> {
    return buildMetricsFrame(await this.snapshot());
  }

  /** 推流间隔（ms）。 */
  get intervalMs(): number {
    return this.deps.config.system.metricsIntervalMs;
  }

  /** 数据源可用性汇总（供 /api/health）。 */
  async sourceSummary(): Promise<{ cpu: SourceStatus; memory: SourceStatus; disk: SourceStatus; gpu: SourceStatus }> {
    const snapshot = await this.snapshot();
    return snapshot.sources;
  }
}
