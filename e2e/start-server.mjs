/**
 * E2E 专用服务启动器（Sprint 0 · S0-05）。
 *
 * Playwright 的 `webServer.command` 指向本脚本（`npm run e2e:serve`），它负责三件事：
 *
 * 1. **生产构建先行**：先跑 `npm run build`（web → server），保证被测产物就是生产产物，
 *    而不是某次遗留的旧 dist。构建输出用 `stdio: 'inherit'` 直接透传到 Playwright 日志。
 * 2. **可重复的干净环境**：每次启动前**清空** `.e2e-data`，让「首启初始化」这条流程
 *    可以反复运行（否则第二次运行会撞上"系统已初始化"）。
 * 3. **进程生命周期**：把服务端子进程的退出码与 SIGTERM/SIGINT 双向转发，
 *    Playwright 结束后不残留 node 进程。
 *
 * 数据源刻意配成**故障状态**：
 * - `DOCKER_ENDPOINT` 指向一个不存在的 socket —— 冒烟测试要验证的正是
 *   「数据源不可用时仍显示降级提示而不是白屏」，所以这里不能连真 Docker；
 * - `PORTAL_TAILSCALE_MODE=off` —— 不依赖宿主是否装了 tailscale，结果可复现。
 *
 * 令牌是**固定的测试值**（可用 `PORTAL_E2E_SETUP_TOKEN` 覆盖），不是任何真实密钥。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根目录（本文件位于 <repo>/e2e/）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 服务端构建产物入口。 */
const SERVER_ENTRY = path.join(REPO_ROOT, 'server', 'dist', 'index.js');
/** E2E 专用数据目录（已在 .gitignore 中忽略）。 */
const DATA_DIR = path.join(REPO_ROOT, '.e2e-data');

const HOST = '127.0.0.1';
/**
 * E2E 端口：**刻意不是 8899**。
 *
 * 8899 是门户的生产端口，开发机上往往正跑着 `homeport-portal` 容器；
 * E2E 又要求 `reuseExistingServer: false`（绝不复用可能在跑的旧代码），
 * 两者相撞会让 `npm run test:e2e` 直接失败。因此默认取一个空闲端口，
 * 需要时用 `PORTAL_E2E_PORT` 覆盖。
 */
const PORT = Number(process.env.PORTAL_E2E_PORT ?? 8988);
/** 固定测试令牌；与 e2e/*.spec.ts 中的常量保持一致。 */
const SETUP_TOKEN = process.env.PORTAL_E2E_SETUP_TOKEN ?? 'E2E-TEST-TOKEN-0000-0000';
/** 不存在的 socket：验证 Docker 数据源故障时的降级展示。 */
const DOCKER_ENDPOINT = '/nonexistent/docker.sock';

/** 服务端子进程；退出后置回 null。 */
let serverChild = null;
/** 是否已进入主动关停流程（决定退出码语义）。 */
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[e2e] ${message}\n`);
}

/** 生产构建：`npm run build`（web 的 vite build + server 的 tsc build）。 */
function build() {
  return new Promise((resolve, reject) => {
    log('开始生产构建：npm run build（首次运行较慢，请等待）…');
    // 用 shell 执行命令字符串：Windows 需要 cmd.exe 才能解析 npm.cmd
    const child = spawn('npm run build', { cwd: REPO_ROOT, stdio: 'inherit', shell: true });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        log('构建完成');
        resolve();
        return;
      }
      reject(new Error(`npm run build 失败（code=${code} signal=${signal}）`));
    });
  });
}

/** 清空数据目录：保证每次运行都是"首启未初始化"的干净状态。 */
function resetDataDir() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  log(`已清空数据目录：${DATA_DIR}`);
}

/**
 * 转发退出信号给服务端子进程。
 *
 * Windows 上 Node 的 `child.kill('SIGTERM')` 等价于直接终止（POSIX 信号不存在），
 * 因此这里补一个 3 秒兜底强杀，避免子进程卡住时变成孤儿进程。
 */
function stopServer(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  const child = serverChild;
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    log(`收到 ${signal}，服务端子进程已退出，无需处理`);
    return;
  }

  log(`收到 ${signal}，转发给服务端子进程（pid=${child.pid}）`);
  try {
    child.kill(signal);
  } catch (error) {
    log(`转发 ${signal} 失败：${error instanceof Error ? error.message : String(error)}`);
  }

  const hardKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      log(`子进程未在 3 秒内退出，强制终止（pid=${child.pid}）`);
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出，忽略
      }
    }
  }, 3000);
  hardKill.unref();
}

async function main() {
  await build();
  resetDataDir();

  if (!fs.existsSync(SERVER_ENTRY)) {
    throw new Error(`未找到服务端构建产物：${SERVER_ENTRY}（npm run build 应当生成它）`);
  }

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    PORTAL_HOST: HOST,
    PORTAL_PORT: String(PORT),
    PORTAL_DATA_DIR: DATA_DIR,
    PORTAL_SETUP_TOKEN: SETUP_TOKEN,
    PORTAL_TAILSCALE_MODE: 'off',
    PORTAL_TRUST_PROXY: '0',
    PORTAL_LOG_LEVEL: 'warn',
    DOCKER_ENDPOINT,
  };

  // 直接用当前 node 可执行文件启动，不经 shell —— 少一层中间进程，退出时更干净
  serverChild = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
    windowsHide: true,
  });
  log(`服务端子进程已启动（pid=${serverChild.pid}）→ http://${HOST}:${PORT}`);

  serverChild.on('error', (error) => {
    log(`服务端子进程启动失败：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

  serverChild.on('exit', (code, signal) => {
    serverChild = null;
    log(`服务端子进程退出（code=${code} signal=${signal}）`);
    // 服务端自己挂掉要让 Playwright 看到失败；我们主动关停时则正常结束
    process.exit(shuttingDown ? 0 : code ?? 1);
  });
}

// ---- 信号与退出兜底
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => stopServer(signal));
}
// 同步兜底：无论以何种方式退出，都不留下服务端子进程
process.on('exit', () => {
  const child = serverChild;
  if (child && child.exitCode === null && child.signalCode === null) {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已退出，忽略
    }
  }
});

void main().catch((error) => {
  process.stderr.write(`[e2e] 启动失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});