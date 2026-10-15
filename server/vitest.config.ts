import { defineConfig } from 'vitest/config';

/**
 * 测试配置。
 *
 * - `testTimeout` 放宽到 30s：认证用例内部使用 bcrypt cost 12（约 250ms/次），
 *   限流用例需要连续十余次失败登录，默认 5s 会超时。
 * - `pool: 'forks'`：better-sqlite3 是原生模块，进程隔离比线程隔离更稳。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: 'forks',
    reporters: ['default'],
  },
});
