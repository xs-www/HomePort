/**
 * Playwright E2E 配置（Sprint 0 · S0-05 冒烟）。
 *
 * 关键取舍：
 * - **串行执行**（`workers: 1` + `fullyParallel: false`）：所有用例共用同一个
 *   SQLite 库与同一个服务进程，且「首启初始化」全流程只能执行一次，并行会互相污染。
 * - **`reuseExistingServer: false`**：宁可失败也不复用本机可能在跑的 8899 服务，
 *   否则测试可能打在旧代码/旧数据上，结论不可信。
 * - **超时给足**：首次运行时 `webServer` 要先跑完整生产构建（web + server），
 *   因此启动超时放到 5 分钟，单用例 60 秒。
 * - **`trace: 'retain-on-failure'`**：只在失败时保留 trace，避免 CI 产物过大。
 *
 * 服务端由 `e2e/start-server.mjs` 启动（见该文件的注释：清空数据目录、指向故障数据源）。
 *
 * ⚠️ **端口选择**：默认 **8988**，刻意避开门户的生产端口 8899。
 * 开发机上通常正跑着 `homeport-portal` 容器（`docker compose up`）占用 8899，
 * 而本配置要求 `reuseExistingServer: false`（不复用旧服务），
 * 两者相撞会让 `npm run test:e2e` 直接报 "…/api/health is already used"。
 * 需要换端口时用 `PORTAL_E2E_PORT=9001 npm run test:e2e`
 * （PowerShell：`$env:PORTAL_E2E_PORT='9001'; npm run test:e2e`），
 * 配置会把该端口显式透传给启动脚本，保证两侧一致。
 */
import { defineConfig, devices } from '@playwright/test';

/** E2E 专用端口；与 e2e/start-server.mjs 的默认值保持一致。 */
const PORT = Number(process.env.PORTAL_E2E_PORT ?? 8988);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const IS_CI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  // 单用例预算：登录含 bcrypt(cost 12)，页面含 20~30 秒轮询，给足余量
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: IS_CI,
  retries: IS_CI ? 1 : 0,
  // 至少 list；CI 上额外产出 html 报告（playwright-report/ 已被 .gitignore 忽略）
  reporter: IS_CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  outputDir: 'test-results',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run e2e:serve',
    url: `${BASE_URL}/api/health`,
    // 把端口显式传给启动脚本：确保"配置里算出来的端口"与"服务端实际监听的端口"永远一致
    env: { PORTAL_E2E_PORT: String(PORT) },
    // 绝不复用已有服务：本机 8899 上跑着的可能是旧代码或已初始化的库
    reuseExistingServer: false,
    // 首次要跑完整构建，超时必须给足
    timeout: 300_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});