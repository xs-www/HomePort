import { defineConfig } from 'vitest/config';

/**
 * 前端单测配置。
 *
 * - `environment: 'jsdom'`：`api/client.ts`（依赖 `fetch`/`document`）与组件测试都需要 DOM。
 * - `globals: true`：让 `@testing-library/react` 能自动注册 `afterEach(cleanup)`；
 *   测试文件仍然显式 `import { describe, it, expect } from 'vitest'`，不依赖全局类型。
 * - 不引入 `@vitejs/plugin-react`：纯逻辑测试不需要 JSX 转换，
 *   组件测试用到的 `.tsx` 由 esbuild 处理，React 17+ 的自动 JSX runtime 已足够。
 */
export default defineConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    globals: true,
    restoreMocks: true,
    testTimeout: 10_000,
  },
});