/**
 * F3 系统指标路由：/api/system/*
 *
 * 契约见 docs/static/04-api-contract.md §5。
 * `/stream` 为 SSE 长连接：默认每 `PORTAL_METRICS_INTERVAL_MS` 推送一帧，
 * 每 30s 发送一次 ping 心跳，15 分钟后主动断开（由客户端 EventSource 自动重连）。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../http/guards.js';
import { securityHeadersFor } from '../http/securityHeaders.js';
import type { RouteContext } from './context.js';

/** 心跳间隔（ms）。 */
export const SSE_PING_INTERVAL_MS = 30_000;
/** 单连接最长存活时间（ms）。 */
export const SSE_MAX_LIFETIME_MS = 15 * 60 * 1000;

export function registerSystemRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** 完整快照。 */
  app.get('/snapshot', async (request) => {
    requireAuth(request);
    return ctx.system.snapshot();
  });

  /** 实时指标流。 */
  app.get('/stream', async (request, reply) => {
    requireAuth(request);

    reply.raw.writeHead(200, {
      // SSE 直接写 raw head，不走 Fastify 的发送流程，
      // 因此 app.ts 里 onRequest 钩子设置的安全头不会自动带上，这里显式补一份。
      ...securityHeadersFor(ctx.config.securityHeaders, request.protocol),
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    let frames = 0;

    function cleanup(): void {
      if (closed) return;
      closed = true;
      clearInterval(metricsTimer);
      clearInterval(pingTimer);
      clearTimeout(lifetimeTimer);
      try {
        reply.raw.end();
      } catch {
        // 连接已断开，忽略
      }
    }

    const write = (event: string, data: unknown): void => {
      if (closed) return;
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (error) {
        ctx.logger.debug('SSE 写入失败，连接将关闭', { error });
        cleanup();
      }
    };

    const sendFrame = async (): Promise<void> => {
      try {
        const frame = await ctx.system.metricsFrame();
        frames += 1;
        write('metrics', frame);
      } catch (error) {
        write('error', { message: error instanceof Error ? error.message : '指标采集失败' });
      }
    };

    const metricsTimer = setInterval(() => {
      void sendFrame();
    }, ctx.system.intervalMs);

    const pingTimer = setInterval(() => {
      write('ping', { at: new Date().toISOString(), frames });
    }, SSE_PING_INTERVAL_MS);

    const lifetimeTimer = setTimeout(() => {
      write('bye', { reason: 'max-lifetime' });
      cleanup();
    }, SSE_MAX_LIFETIME_MS);

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);

    // 立即推第一帧，避免用户看到 3 秒空白
    await sendFrame();
  });
}
