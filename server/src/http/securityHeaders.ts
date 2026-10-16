/**
 * 浏览器侧安全响应头（S0-03）。
 *
 * 为什么自己写而不用 `@fastify/helmet`：
 *
 * 1. 门户只需要**六个固定头 + 一个可配 CSP**，引一个插件换来的是它的一整套默认值，
 *    其中 `coep`/`coop`/`origin-agent-cluster` 等对本场景没有收益，
 *    却要逐个去关（关错一个就可能让 SSE 或静态资源失效）。
 * 2. HSTS 的判定逻辑必须和本项目的 `trustProxy` 边界对齐（只在**确为 HTTPS** 时下发），
 *    自己写才能把"谁说了算"写清楚，而不是依赖插件默认值。
 * 3. 少一个运行时依赖 = 少一份供应链风险，且 arm64/amd64 构建不需要额外的安装步骤。
 *
 * 关键约束（来自 Sprint 0 验收标准）：
 * - **不能阻断** HomePort 自己的 JS/CSS、SSE、登录流程与既有 Serve 路由；
 * - **不能把内网 HTTP 标成 HSTS**（内网 HTTP 下发 HSTS 会把用户浏览器
 *   锁死在一个不存在的 HTTPS 站点上，是真实的可用性事故）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from '../logger.js';

export interface SecurityHeaderConfig {
  /** 总开关 */
  enabled: boolean;
  /** CSP 内容；空字符串表示不下发 */
  csp: string;
  /** 是否允许下发 HSTS */
  hsts: boolean;
  /** HSTS max-age（秒） */
  hstsMaxAge: number;
}

/**
 * 与请求无关的固定头。
 *
 * - `x-content-type-options: nosniff`：禁止浏览器嗅探类型，配合下面的 CSP 一起
 *   压制"上传内容被当脚本执行"这一类问题。
 * - `x-frame-options: DENY` + CSP `frame-ancestors 'none'`：双份声明，
 *   覆盖不支持 CSP 的老浏览器。门户是管理界面，绝不该被任何页面内嵌。
 * - `referrer-policy: no-referrer`：门户 URL 里含主机名/端口，跳转到外部服务时
 *   不应泄漏来源。
 * - `cross-origin-*-policy`：把门户与外部页面彻底隔离。
 * - `permissions-policy`：门户不需要任何设备能力，全部关掉。
 */
export const STATIC_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'x-permitted-cross-domain-policies': 'none',
  'permissions-policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
});

/**
 * 计算本次响应应下发的安全头。
 *
 * @param protocol 该请求实际的协议（**已经过 trustProxy 判定**）。
 *   HSTS 只在 `https` 时下发：Tailscale Serve 终止 TLS 后回源到
 *   `http://127.0.0.1:8899`，只有 `X-Forwarded-Proto: https` 才能说明
 *   浏览器那一侧确实是 HTTPS；直连 HTTP 场景绝不能下发。
 */
export function securityHeadersFor(config: SecurityHeaderConfig, protocol: string): Record<string, string> {
  if (!config.enabled) return {};

  const headers: Record<string, string> = { ...STATIC_SECURITY_HEADERS };

  if (config.csp) headers['content-security-policy'] = config.csp;

  if (config.hsts && protocol === 'https' && config.hstsMaxAge > 0) {
    // 刻意**不加** `includeSubDomains`：生产主机名形如
    // `family-nas.tail585599.ts.net`，`includeSubDomains` 会波及同域下的其它名字，
    // 而那不是本门户能替用户做的决定；`preload` 同理。
    headers['strict-transport-security'] = `max-age=${config.hstsMaxAge}`;
  }

  return headers;
}

/**
 * 注册 `onRequest` 钩子，为所有响应补上安全头。
 *
 * 用 `onRequest`（而不是 `onSend`）的原因：越早设置越不容易被下游处理器覆盖，
 * 且 SSE 处理器直接写 `reply.raw.writeHead()`，不走 Fastify 的发送流程 ——
 * 它自己会调用 `securityHeadersFor()` 补头（见 `api/system.ts`）。
 *
 * `/api/*` 额外加 `cache-control: no-store`：接口响应可能含容器环境变量快照、
 * 设备清单等敏感内容，不应被浏览器或中间代理缓存。
 */
export function registerSecurityHeaders(
  app: FastifyInstance,
  config: SecurityHeaderConfig,
  logger?: Logger,
): void {
  if (!config.enabled) {
    logger?.warn('安全响应头已被 PORTAL_SECURITY_HEADERS 关闭，仅应在排障时使用');
    return;
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    const headers = securityHeadersFor(config, request.protocol);
    for (const [name, value] of Object.entries(headers)) {
      if (!reply.hasHeader(name)) reply.header(name, value);
    }
    if (request.url.startsWith('/api/') && !reply.hasHeader('cache-control')) {
      reply.header('cache-control', 'no-store');
    }
  });

  logger?.debug('安全响应头已启用', {
    csp: config.csp ? 'custom' : 'off',
    hsts: config.hsts ? config.hstsMaxAge : 'off',
  });
}