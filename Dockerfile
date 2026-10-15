# syntax=docker/dockerfile:1.7
#
# 多阶段构建：web 产物 → 后端编译 → 精简运行时。
#
# 设计要点：
# 1. 用 `npm ci` + 仓库根 lockfile，保证可复现。
# 2. 运行时镜像不含源码与 devDependencies，镜像更小。
# 3. better-sqlite3 在 alpine 上需要编译工具，因此 builder 阶段装 python3/make/g++，
#    运行时只保留 .node 产物（见下方拷贝）。
# 4. 支持 amd64 与 arm64（NAS 常见），故不使用 `--platform` 硬编码。

# ---------------------------------------------------------------- 1. 依赖
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 make g++ sqlite-dev
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci --no-audit --no-fund

# ---------------------------------------------------------------- 2. 前端构建
FROM deps AS web-build
WORKDIR /app
COPY web ./web
RUN npm run build --workspace web

# ---------------------------------------------------------------- 3. 后端编译
FROM deps AS server-build
WORKDIR /app
COPY server ./server
RUN npm run build --workspace server
# 只保留生产依赖，减小最终镜像
RUN npm prune --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------- 4. 运行时
FROM node:22-alpine AS runtime
WORKDIR /app

# 运行期依赖：
# - tini：作为 PID 1 正确转发信号（容器优雅退出）
# - nvidia-smi 的依赖库在执行时才需要，这里不预装（由宿主挂载提供）
# - docker-cli 不安装：门户只通过 socket API 读取数据，不需要 CLI
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORTAL_PORT=8899 \
    PORTAL_HOST=0.0.0.0 \
    PORTAL_DATA_DIR=/data \
    PORTAL_WEB_DIST=/app/web/dist \
    PORTAL_HOST_PROC=/host/proc \
    PORTAL_DISK_MOUNTS="" \
    PORTAL_NVIDIA_SMI=/usr/local/bin/nvidia-smi

# 生产依赖（含 better-sqlite3 原生绑定）
COPY --from=server-build /app/node_modules ./node_modules
COPY --from=server-build /app/package.json ./package.json
COPY --from=server-build /app/server/package.json ./server/package.json
COPY --from=server-build /app/server/dist ./server/dist
COPY --from=web-build /app/web/dist ./web/dist

# 数据目录（SQLite + 首启令牌）。建议挂载卷持久化。
RUN mkdir -p /data && chown -R node:node /data /app

USER node

EXPOSE 8899

# 健康检查：只探测进程与路由是否可服务，不依赖外部数据源
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORTAL_PORT||8899)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server/dist/index.js"]
