/**
 * Fastify 应用装配。
 *
 * 装配顺序即依赖方向：
 * config → logger → db → repositories → providers → services → routes → static。
 * 所有外部依赖（Docker / tailscale / 宿主 / 时钟）都在这里被"注入"一次，
 * 之后各模块不再自己创建连接，便于测试替换与生命周期管理。
 */
import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { config as defaultConfig, ensureDataDir, type PortalConfig } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { initDatabase, type Db } from './db/database.js';
import { AuditRepository, PreferencesRepository, UsersRepository } from './db/users.js';
import { SettingsRepository } from './db/settings.js';
import { ServicesRepository } from './db/services.js';
import { RecoveryCodesRepository, TotpChallengesRepository } from './db/totp.js';
import { handleError } from './http/errors.js';
import { createAuthHook } from './http/guards.js';
import { registerSecurityHeaders } from './http/securityHeaders.js';
import { AuthService } from './modules/auth/service.js';
import { SessionsRepository } from './modules/auth/sessions.js';
import { AlertEngine, createAlertSnapshotSource } from './modules/alerts/engine.js';
import { AlertsService } from './modules/alerts/service.js';
import { DockerProvider } from './modules/docker/provider.js';
import { ContainerService } from './modules/docker/service.js';
import { HealthMonitor } from './modules/health/monitor.js';
import { MetricsSampler } from './modules/metrics/sampler.js';
import { BackgroundScheduler } from './modules/metrics/scheduler.js';
import { OverviewService } from './modules/overview/service.js';
import { SettingsService } from './modules/settings/service.js';
import { createSecretBox, loadOrCreateKey, parsePreviousKeys } from './modules/settings/secretBox.js';
import { runHealthProbe } from './modules/services/healthProbe.js';
import { ServiceRegistryService } from './modules/services/service.js';
import { SystemProvider } from './modules/system/provider.js';
import { SystemService } from './modules/system/service.js';
import { selectTailscaleProvider } from './modules/tailscale/provider.js';
import { ServeProvider } from './modules/tailscale/serveProvider.js';
import { defaultCommandRunner, TailscaleService } from './modules/tailscale/service.js';
import { ToolsService } from './modules/tools/service.js';
import { UsersService } from './modules/users/service.js';
import { registerRoutes } from './api/index.js';
import type { RouteContext } from './api/context.js';

export interface BuildAppOptions {
  config?: PortalConfig;
  logger?: Logger;
  /** 覆盖数据库路径（测试常用 `:memory:`） */
  dbPath?: string;
  /** 是否注册静态文件服务（默认 true） */
  serveStatic?: boolean;
  /** 会话清理间隔（ms）；0 表示不启动定时器 */
  sessionCleanupIntervalMs?: number;
  /**
   * 是否启动后台任务（采样 / 健康监测 / 告警评估）。
   *
   * **默认 `false`**：`buildApp` 被大量测试 `inject` 复用，默认开定时器会让
   * 测试变慢、相互干扰（同一个库被多路 tick 写），而且进程会被定时器吊住。
   * 生产入口只有一个（`server/src/index.ts`），由它显式传 `backgroundJobs: true`。
   */
  backgroundJobs?: boolean;
}

export interface AppHandle {
  app: FastifyInstance;
  ctx: RouteContext;
  db: Db;
  config: PortalConfig;
  logger: Logger;
  /** 历史指标采样器（测试可直接调 `metrics.tick(now)`，无需等定时器） */
  metrics: MetricsSampler;
  /** 健康监视器与告警引擎/服务（Sprint 2 的另外两条线，装配由本文件统一负责） */
  health: HealthMonitor;
  alerts: AlertsService;
  /** 后台单例（测试调 `scheduler.tickOnce(now)` 做确定性推进） */
  scheduler: BackgroundScheduler;
  /** 优雅关闭：停止后台任务与定时器 + 关闭 Fastify + 关闭数据库 */
  close: () => Promise<void>;
}

/** 会话清理与审计清理的默认周期：1 小时。 */
export const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 构建应用（不监听端口）。
 *
 * @example
 * const { app, close } = await buildApp({ dbPath: ':memory:' });
 * await app.ready();
 * await app.inject({ method: 'GET', url: '/api/health' });
 * await close();
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<AppHandle> {
  const config = options.config ?? defaultConfig;
  const logger =
    options.logger ??
    createLogger({
      level: config.logLevel,
      pretty: config.env !== 'production' && config.env !== 'test',
    });

  if (config.env !== 'test') ensureDataDir(config);

  const { db } = initDatabase({
    file: options.dbPath ?? config.dbPath,
    logger,
  });

  const usersRepo = new UsersRepository(db);
  const sessionsRepo = new SessionsRepository(db);
  const preferencesRepo = new PreferencesRepository(db);
  const auditRepo = new AuditRepository(db);
  const settingsRepo = new SettingsRepository(db);
  const servicesRepo = new ServicesRepository(db);
  const recoveryCodesRepo = new RecoveryCodesRepository(db);
  const totpChallengesRepo = new TotpChallengesRepository(db);

  // ---- 敏感数据加密主密钥 ----
  // 优先 `PORTAL_SECRET_KEY`，否则读取/生成 `<dataDir>/secret.key`（0600）。
  // 同一个 secretBox 同时服务两件事：settings 表的敏感项、用户的 TOTP 种子。
  const loadedKey = loadOrCreateKey({
    explicit: config.secrets.key,
    keyFile: config.secrets.keyFile,
    logger,
  });
  const secretBox = createSecretBox({
    key: loadedKey.key,
    previousKeys: parsePreviousKeys(config.secrets.previousKeys.join(',')),
  });
  logger.info('敏感数据加密已启用', {
    keySource: loadedKey.source,
    keyFingerprint: secretBox.keyFingerprint(),
    previousKeys: config.secrets.previousKeys.length,
  });

  const tailscaleProvider = await selectTailscaleProvider(config, logger, defaultCommandRunner);
  const tailscale = new TailscaleService({ provider: tailscaleProvider, config, logger });

  // `tailscale serve` 路由：与设备查询独立，因为可用性不一致
  // （Windows 上设备查询可走 API，但 serve 配置只有 CLI 能读）
  const serveRoutes = new ServeProvider({ config, logger });

  const dockerProvider = new DockerProvider({ config, logger });
  // 让 provider 跟随可变的 config（includeStopped / statsTimeout 每次读取取最新值）
  dockerProvider.bindConfig(config);
  const containers = new ContainerService({
    provider: dockerProvider,
    hostInfo: tailscale,
    serveRoutes,
    config,
    logger,
  });

  const systemProvider = new SystemProvider({ config, logger });
  const system = new SystemService({ provider: systemProvider, config, logger });

  const tools = new ToolsService({ config, logger });
  const overview = new OverviewService({ containers, tailscale, system, tools, config, logger });

  // 服务注册表（Sprint 1）。**构造期不拉数据**：第一次请求（或管理员 discover）才 sync，
  // 保证「settings.initialize() 之后才读 Docker」这条顺序不会被这里破坏。
  const serviceRegistry = new ServiceRegistryService({
    containers,
    tailscale,
    repository: servicesRepo,
    audit: auditRepo,
    config,
    logger,
  });

  // ---- 运行时设置服务 ----
  // 构造一次即可：`initialize()` 内部会先应用数据库覆盖值，
  // 再触发 onReload 重建数据源，顺序由 SettingsService.ensureApplied 保证。
  const settings = new SettingsService({
    config,
    repository: settingsRepo,
    audit: auditRepo,
    logger,
    secretBox,
    onReload: async ({ tailscale: reloadTs, docker: reloadDocker }) => {
      if (reloadDocker) dockerProvider.reload();
      // 缓存 TTL 与 /proc 路径属构造期读取的值，这里同步一次
      containers.syncConfig();
      system.syncConfig();
      if (reloadTs) await tailscale.reload();
    },
  });
  // 存量明文敏感值一次性升级为密文（幂等；失败只告警不中断启动）。
  // 必须早于 initialize()：让数据库里的覆盖值在解密后立刻生效。
  const reencrypted = await settings.reencryptAll();
  if (reencrypted > 0) logger.info('敏感设置已从明文升级为加密存储', { count: reencrypted });
  // **必须在任何数据源被使用之前**：让数据库里的覆盖值先生效
  await settings.initialize();
  // 预热一次，让容器模块立刻能拿到本机 tailnet 地址（否则首次渲染全部容器都判为不可达）
  await tailscale.warmup();

  const auth = new AuthService({
    users: usersRepo,
    sessions: sessionsRepo,
    preferences: preferencesRepo,
    audit: auditRepo,
    config,
    logger,
    secretBox,
    totp: { recoveryCodes: recoveryCodesRepo, challenges: totpChallengesRepo },
  });

  const users = new UsersService({
    users: usersRepo,
    sessions: sessionsRepo,
    preferences: preferencesRepo,
    audit: auditRepo,
    logger,
    onUserChanged: (userId) => auth.invalidateUserCache(userId),
  });

  const app = Fastify({
    // 用自定义 logger（见 logger.ts），因此关闭 Fastify 内置日志。
    // 注意：不要再设置 `disableRequestLogging`，该选项在 Fastify 5 已废弃。
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: 256 * 1024,
    // 生成请求 ID，便于把日志与响应关联
    genReqId: () => `r-${Math.random().toString(36).slice(2, 10)}`,
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  // 安全响应头（CSP / nosniff / HSTS…）。放在鉴权钩子之前注册：
  // 这样连 401/403 之类的错误响应也会带上头，不会出现"报错页没防护"的缝。
  registerSecurityHeaders(app, config.securityHeaders, logger);

  // 请求日志：只记录出错的 API 请求，避免噪声
  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/api/') && reply.statusCode >= 400) {
      logger.warn('请求异常', {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        ms: Math.round(reply.elapsedTime),
        ip: request.ip,
        reqId: request.id,
      });
    }
  });

  // 全局鉴权：解析会话（不拒绝）
  app.addHook(
    'onRequest',
    createAuthHook({ resolveSession: (input) => auth.resolveSession(input), cookieName: config.session.cookieName }),
  );

  const ctx: RouteContext = {
    config,
    logger,
    auth,
    users,
    containers,
    tailscale,
    system,
    tools,
    overview,
    settings,
    services: serviceRegistry,
    audit: auditRepo,
  };

  // ---- Sprint 2：历史采样 / 健康监测 / 告警（后台单例，全进程各一份）----
  //
  // 装配顺序即依赖方向：health → metrics（指标里的 service.health.up_ratio
  // 要用**本 tick 刚更新**的判定）→ alerts（评估**本 tick 刚写入**的样本）。
  // 三者都挂在同一个 `BackgroundScheduler` 上，执行顺序由它保证。
  //
  // 探测入口复用 Sprint 1 的 `runHealthProbe`（SSRF 防护、3s 超时、16KB 上限
  // 都在它里面），这里只把"对象参数"适配成规格 §4.2 的 `(target, options)`。
  const health = new HealthMonitor({
    config,
    logger,
    registry: serviceRegistry,
    containers,
    probe: (target: string, options?: { timeoutMs?: number }) =>
      runHealthProbe({ target, ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }),
    // 闭包读取（而不是装配期取一次值）：设置页改完立刻生效（live 级），无需重启。
    // 不接这两个闭包的话，`PORTAL_HEALTH_PROBE_INTERVAL_SEC` / `…_CONCURRENCY`
    // 在界面上"能改、能保存、看起来生效了"，但监视器仍按 300s/4 跑 —— 静默失效。
    intervalSec: () => config.health.probeIntervalSec,
    concurrency: () => config.health.probeConcurrency,
  });

  const metrics = new MetricsSampler({
    db,
    config,
    logger,
    system,
    containers,
    registry: serviceRegistry,
    health,
  });

  const alerts = new AlertsService({ db, config, logger, audit: auditRepo });
  const alertEngine = new AlertEngine({
    db,
    config,
    logger,
    audit: auditRepo,
    // **必须接快照来源**：不接的话引擎每轮拿到空快照，
    // 四条内置规则会永远 `evaluated = 0` —— 所有单测照样全绿，但生产上任何告警都不触发。
    // 这是"装配缺口"而非"逻辑错误"的典型：模块自己完全正确，缺的是把它接到真实世界。
    // （判别力已验证：只撤掉这几行，`schedulerIntegration.test.ts` 的告警端到端用例
    //   就会红在那条 `evaluated > 0` 的断言上。）
    snapshot: createAlertSnapshotSource({
      config,
      system,
      containers,
      registry: serviceRegistry,
      health,
      logger,
    }),
    // 把每轮结果回灌给服务层，`GET /api/alerts/summary` 的 suppressed/evaluatedAt 才是真值
    onTick: (result) => alerts.recordTick(result),
  });
  // 幂等补齐四条内置规则（默认 `enabled = 0`：装了但不吵）。
  // 放在装配期而不是迁移里：迁移只建结构，业务数据由业务层负责。
  // 失败只告警不阻断启动（规则表为空时告警页显示空列表，比整个门户起不来好）。
  await Promise.resolve(alerts.ensureBuiltinRules()).catch((error: unknown) => {
    logger.warn('补齐内置告警规则失败', { error });
  });

  const scheduler = new BackgroundScheduler({
    health,
    metrics,
    alerts: alertEngine,
    logger,
    // 每次排期都重新求值 → 设置页改了采样间隔，下一个周期即生效（live 级）
    intervalMs: () => config.metrics.sampleIntervalSec * 1000,
  });
  if (options.backgroundJobs === true) scheduler.start();

  registerRoutes(app, ctx, {
    metrics,
    scheduler,
    // 健康监视器：与调度器共用同一个实例（判定只算一次）
    health,
    // 告警域的路由依赖形状由 alerts 模块定义（见 api/index.ts），这里只负责把
    // 已经装配好的对象传过去：服务（读规则/事件、确认）、引擎与调度器（状态透出）。
    alerts: { alerts, engine: alertEngine, scheduler },
  });

  // 统一错误处理
  app.setErrorHandler((error, request, reply) => {
    handleError({
      request,
      reply,
      error,
      log: (httpError, original) => {
        const level = httpError.statusCode >= 500 ? 'error' : 'warn';
        logger[level]('请求处理失败', {
          code: httpError.code,
          status: httpError.statusCode,
          method: request.method,
          url: request.url,
          reqId: request.id,
          message: httpError.message,
          original: original instanceof Error ? original.message : String(original),
        });
      },
    });
  });

  // 静态托管（可选）：只注册资源路由，不注册 notFoundHandler ——
  // 后者由下方统一注册一次（Fastify 同一前缀只允许一个 notFoundHandler）。
  let staticIndexFile: string | null = null;
  if (options.serveStatic !== false) {
    staticIndexFile = registerStatic(app, config, logger);
  }

  // 未匹配路径的兜底：**只注册一次**。
  //
  // 规则：
  // - `/api/*` 一律返回 JSON 404（绝不能被 SPA 的 index.html 吞掉，
  //   否则前端拿到 HTML 再 JSON.parse 会报出难以定位的错误）；
  // - 其它 GET 请求在前端已构建时回退到 index.html，由 React Router 处理；
  // - 非 GET 的未知路径返回 JSON 404。
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) {
      void reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `接口 ${request.method} ${request.url} 不存在`, details: null },
      });
      return;
    }
    if (staticIndexFile && (request.method === 'GET' || request.method === 'HEAD')) {
      try {
        void reply
          .type('text/html; charset=utf-8')
          .header('cache-control', 'no-cache')
          .send(fs.readFileSync(staticIndexFile));
        return;
      } catch (error) {
        logger.error('读取 index.html 失败', { error });
        void reply.status(500).send({ error: { code: 'INTERNAL', message: '无法读取前端入口文件', details: null } });
        return;
      }
    }
    void reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `路径 ${request.method} ${request.url} 不存在`, details: null },
    });
  });

  // 定时清理过期会话与陈旧审计
  let cleanupTimer: NodeJS.Timeout | null = null;
  const cleanupIntervalMs = options.sessionCleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL_MS;
  if (cleanupIntervalMs > 0) {
    cleanupTimer = setInterval(() => {
      try {
        const purged = auth.purgeExpiredSessions();
        if (purged > 0) logger.debug('已清理过期会话', { purged });
        // 过期的两步验证挑战（含尝试次数用尽的）
        auth.purgeExpiredTotpState();
        // 审计日志保留 90 天
        auditRepo.pruneOlderThan(new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString());
      } catch (error) {
        logger.warn('清理过期数据失败', { error });
      }
    }, cleanupIntervalMs);
    cleanupTimer.unref();
  }

  const close = async (): Promise<void> => {
    // 后台任务先停：否则关闭 db 之后还可能有一轮 tick 在写库
    scheduler.stop();
    if (cleanupTimer) clearInterval(cleanupTimer);
    await app.close();
    db.close();
  };

  return { app, ctx, db, config, logger, metrics, health, alerts, scheduler, close };
}

/**
 * 注册前端静态资源。
 *
 * 只做两件事：
 * - 若前端产物不存在，注册一个 `/` 占位页说明如何构建，并返回 `null`；
 * - 否则注册 `@fastify/static`，并返回入口 `index.html` 的绝对路径
 *   （交由 `buildApp` 的 notFoundHandler 做 SPA 回退）。
 *
 * 这里**不注册** `setNotFoundHandler` —— Fastify 对同一前缀只允许注册一次，
 * 由 `buildApp` 统一负责，避免重复注册导致的启动失败。
 *
 * 缓存规则：带 hash 的 `/assets/*` 长缓存；`index.html` 不缓存。
 */
export function registerStatic(app: FastifyInstance, config: PortalConfig, logger: Logger): string | null {
  const distDir = config.webDistDir;
  const indexFile = path.join(distDir, 'index.html');

  if (!fs.existsSync(indexFile)) {
    logger.warn('未找到前端构建产物，门户将只提供 API（请先执行 npm run build:web）', { distDir });
    app.get('/', async (_request, reply) => {
      return reply
        .status(503)
        .type('text/html; charset=utf-8')
        .send(
          [
            '<!doctype html><meta charset="utf-8"><title>HomePort Portal</title>',
            '<body style="font-family:system-ui;padding:2rem;line-height:1.8">',
            '<h1>前端尚未构建</h1>',
            `<p>未找到 <code>${escapeHtml(indexFile)}</code>。</p>`,
            '<p>开发模式请运行 <code>npm run dev:web</code>；生产镜像请执行 <code>npm run build</code> 后重启容器。</p>',
            '<p>API 健康检查：<a href="/api/health">/api/health</a></p>',
            '</body>',
          ].join(''),
        );
    });
    return null;
  }

  void app.register(fastifyStatic, {
    root: distDir,
    prefix: '/',
    index: ['index.html'],
    cacheControl: true,
    maxAge: '1h',
    setHeaders: (response, filePath) => {
      // 注意：`@fastify/static` 会在本回调之后应用 `maxAge`，因此这里必须
      // 显式覆盖 cache-control，否则带 hash 的产物只会缓存 1 小时。
      const normalized = filePath.split(path.sep).join('/');
      if (normalized.endsWith('/index.html')) {
        response.setHeader('cache-control', 'no-cache');
      } else if (normalized.includes('/assets/')) {
        // 文件名含内容 hash，可安全长缓存
        response.setHeader('cache-control', 'public, max-age=31536000, immutable');
      }
    },
  });

  return indexFile;
}

/** 最小 HTML 转义（仅用于错误页）。 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
