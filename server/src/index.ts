/**
 * 进程入口：装配应用、监听端口、优雅关闭。
 *
 * 启动时若系统尚未初始化，会把首启令牌打印到日志（NAS 场景下 `docker logs` 是
 * 最方便的获取渠道），同时写入 `data/setup-token.txt`。
 */
import { buildApp } from './app.js';
import { config } from './config.js';

async function main(): Promise<void> {
  const handle = await buildApp();
  const { app, config: cfg, logger } = handle;
  const auth = handle.ctx.auth;

  const close = async (signal: string): Promise<void> => {
    logger.info('收到退出信号，正在关闭…', { signal });
    try {
      await handle.close();
      logger.info('已安全退出');
      process.exit(0);
    } catch (error) {
      logger.error('关闭过程出错', { error });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error('未处理的 Promise 拒绝', { reason });
  });
  process.on('uncaughtException', (error) => {
    logger.error('未捕获异常，进程将退出', { error });
    process.exit(1);
  });

  try {
    await app.listen({ host: cfg.host, port: cfg.port });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      logger.error(`端口 ${cfg.port} 已被占用，请修改 PORTAL_PORT 或释放该端口`);
    } else {
      logger.error('监听端口失败', { error });
    }
    process.exit(1);
  }

  const shownHost = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host;
  logger.info('门户已启动', {
    url: `http://${shownHost}:${cfg.port}`,
    env: cfg.env,
    version: cfg.version,
    dataDir: cfg.dataDir,
  });

  if (auth.isSetupRequired()) {
    const token = auth.getSetupToken();
    // 用 console 直接输出，保证在 JSON 日志里也醒目
    console.log('');
    console.log('=========================================================');
    console.log('  首次启动：系统尚未初始化');
    console.log('  请在浏览器打开门户，按提示创建管理员账号。');
    console.log(`  初始化令牌：${token}`);
    console.log(`  亦可读取文件：${cfg.bootstrap.tokenFile}`);
    console.log('=========================================================');
    console.log('');
  }
}

void main();
