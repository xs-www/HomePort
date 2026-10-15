/**
 * 运行时设置路由：/api/settings/*
 *
 * 契约见 docs/static/04-api-contract.md §10。**全部接口仅管理员可用。**
 *
 * 设计要点：
 * - 每个设置项都返回 `effect`（立即生效 / 需重建容器）与 `source`（默认 / 环境变量 / 数据库），
 *   前端据此决定给不给编辑控件 —— 而不是让管理员改了一个改不动的值。
 * - `restart` 级键在服务端也会拒绝写入（双重保险）。
 * - 保存后**立即生效**：服务会重建受影响的 Tailscale / Docker 数据源。
 */
import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../http/guards.js';
import { parseOrThrow, resetSettingsBodySchema, updateSettingsBodySchema } from '../http/schemas.js';
import type { RouteContext } from './context.js';

export function registerSettingsRoutes(app: FastifyInstance, ctx: RouteContext): void {
  /** 读取全部设置项（含来源与生效级别）。 */
  app.get('/', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    return ctx.settings.view();
  });

  /**
   * 测试 tailnet 连通性。
   *
   * 支持带上**尚未保存**的候选 Token（`?token=` 或请求体），
   * 让管理员"先测再存"，避免把一个错值写进数据库。
   */
  app.post('/test/tailscale', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const body = (request.body ?? {}) as { token?: unknown };
    const candidate = typeof body.token === 'string' ? body.token : undefined;
    const result = await ctx.settings.testTailscale(candidate);
    ctx.logger.info('测试 tailnet 连通性', {
      actor: session.user.username,
      ok: result.ok,
      mode: result.mode,
      devices: result.deviceCount,
    });
    return result;
  });

  /**
   * 保存设置。
   *
   * 部分成功语义：合法项写入并生效，非法项在 `invalid` 中返回原因，
   * `restart` 级项在 `rejectedRestartKeys` 中返回（前端本不该提交它们）。
   */
  app.patch('/', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const body = parseOrThrow(updateSettingsBodySchema, request.body, '设置参数');

    const result = await ctx.settings.update({
      values: body.values,
      actor: { id: session.user.id, username: session.user.username },
      ip: request.ip,
    });

    ctx.logger.info('运行时设置已更新', {
      actor: session.user.username,
      updated: result.updatedKeys,
      invalid: result.invalid.map((item) => item.key),
      rejected: result.rejectedRestartKeys,
    });

    // 返回最新视图，前端可直接用响应刷新界面，避免二次请求
    return { ...result, view: await ctx.settings.view() };
  });

  /**
   * 重置设置项为默认值。
   *
   * 请求体 `{ keys: [...] }` 只重置指定项；`{}` 或省略表示重置全部。
   */
  app.post('/reset', async (request) => {
    const session = requireAuth(request);
    ctx.users.assertAdmin(session.user);
    const body = parseOrThrow(resetSettingsBodySchema, request.body ?? {}, '重置参数');
    const keys = body.keys ?? null;

    const removed = await ctx.settings.reset(keys, { id: session.user.id, username: session.user.username }, request.ip);
    ctx.logger.info('运行时设置已重置', { actor: session.user.username, keys: keys ?? 'all', removed });

    return { removed, view: await ctx.settings.view() };
  });
}
