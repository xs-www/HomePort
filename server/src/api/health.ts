/**
 * 健康检查与版本信息：/api/health
 *
 * 该接口**无需登录**，用于 docker healthcheck 与排障。
 * 契约见 docs/static/04-api-contract.md §0.4。
 */
import type { FastifyInstance } from 'fastify';
import type { SourceStatus } from '../modules/system/types.js';
import type { RouteContext } from './context.js';

export function registerHealthRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/health', async () => {
    const [docker, tailscale, system] = await Promise.allSettled([
      ctx.containers.checkAvailability(),
      ctx.tailscale.checkAvailability(),
      ctx.system.sourceSummary(),
    ]);

    const dockerStatus =
      docker.status === 'fulfilled' ? docker.value : unavailable('docker', docker.reason);
    const tailscaleStatus =
      tailscale.status === 'fulfilled' ? tailscale.value : unavailable('tailscale', tailscale.reason);

    let cpu: SourceStatus;
    let disk: SourceStatus;
    let gpu: SourceStatus;
    if (system.status === 'fulfilled') {
      cpu = system.value.cpu;
      disk = system.value.disk;
      gpu = system.value.gpu;
    } else {
      cpu = unavailable('system', system.reason);
      disk = cpu;
      gpu = cpu;
    }

    // 只有进程本身无法服务时才算不健康；数据源缺失不算。
    return {
      status: 'ok',
      version: ctx.config.version,
      revision: ctx.config.buildRevision,
      env: ctx.config.env,
      uptimeSec: Math.floor(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      setupRequired: ctx.auth.isSetupRequired(),
      sources: { docker: dockerStatus, tailscale: tailscaleStatus, system: cpu, disk, gpu },
    };
  });
}

function unavailable(area: string, reason: unknown): SourceStatus {
  const detail = reason instanceof Error ? reason.message : String(reason);
  return { available: false, mode: 'none', detail: `${area}：${detail}` };
}
