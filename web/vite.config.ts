import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * 前端构建配置。
 *
 * - 开发（`npm run dev:web`）：`/api` 与 `/api/system/stream` 由 Vite 代理到后端，
 *   因此开发期前后端同源，Cookie / SSE 行为与生产一致。
 * - 生产：产物输出到 `web/dist`，由后端 Fastify 静态托管（同源，无 CORS）。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: '0.0.0.0',
    port: 5273,
    proxy: {
      '/api': {
        target: process.env.PORTAL_DEV_API ?? 'http://127.0.0.1:8899',
        changeOrigin: false,
        ws: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    chunkSizeWarningLimit: 900,
  },
});
