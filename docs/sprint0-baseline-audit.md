# Sprint 0 基线审计（S0-01）

> 审计对象：`D:\桌面\sisi_apps\HomePort`，只读审计，未修改任何源码、配置、容器或 `git` 状态。
> 基准：`docs/HomePort_2.0_Balanced_Development_Plan.md` §3 S0-01；工作区 HEAD = `9e8c13f`（分支 `master`，**有未提交改动**，见 §1-补）。

## 审计范围与方法

**读过的文件**（全文或指定区间）：

- 计划与索引：`docs/HomePort_2.0_Balanced_Development_Plan.md`、`README.md`、`todo.md`
- 静态文档：`docs/static/01-architecture.md`、`02-configuration.md`、`03-server-modules.md`（抽查）、`04-api-contract.md`（检索）、`05-web-modules.md`（检索）、`06-security.md`、`07-data-model.md`、`08-operations.md`（检索）、`09-changelog.md`（抽查）
- 后端源码：`config.ts`、`app.ts`、`index.ts`、`http/guards.ts`、`http/securityHeaders.ts`、`http/schemas.ts`、`api/index.ts`、`api/auth.ts`、`api/settings.ts`、`api/users.ts`、`db/settings.ts`、`modules/settings/{service,registry,secretBox}.ts`、`modules/tailscale/serveProvider.ts`、`modules/docker/service.ts`
- 测试：`server/tests/*.test.ts`（6 个）、`web/tests/harness.smoke.test.tsx`
- 容器与 CI：`Dockerfile`、`docker-compose.yml`、`docker-compose.nas.yml`、`.env.example`、`.github/workflows/docker-publish.yml`、`package.json`、`web/package.json`、`web/vitest.config.ts`

**用过的命令**（全部只读）：`git log --oneline -15`、`git status --short`、`git diff --stat`；`Get-ChildItem`/`Measure-Object` 统计行数；`Select-String` 与 `[regex]::Matches` 统计环境变量、测试用例数、审计动作、注册表条目数（计数方法见 §7）。

**未做的事**：未读取 `.env`（含真实密钥，按要求回避）；未运行 `docker`、`npm install`、`npm test`、`npm run typecheck`、`git push`；未启动任何服务。

**未验证项（含原因）**：

- 测试是否真的全部通过 —— 未运行 `npm test`（任务要求只读，且沙箱下 esbuild 需要 `spawn` 管道，`09-changelog.md:887` 已记录该限制）。
- NAS 真实部署与 `tailscale serve` 线上状态 —— 未部署（`todo.md:209` 明确"暂不部署"），未访问 NAS。
- `web/vitest.config.ts` 的实际运行结果 —— 仓库根无 `playwright.config.*`、`e2e/` 目录不存在，`package.json` 的 `test:e2e`/`e2e:serve` 脚本当前必然失败（未运行，按脚本与目录事实判定）。

---

## 1. 已完成：文档声称 vs 代码事实

对照 `todo.md` 勾选项抽查，**声明基本属实**，给出证据：

| 声称（todo.md） | 代码证据 | 结论 |
| --- | --- | --- |
| Docker 只读数据源，类型层无写方法 | `modules/docker/provider.ts`（356 行）仅 `listContainers`/`inspectContainer`/`stats`；`modules/docker/types.ts` 无 start/stop | ✅ 属实 |
| `tailscale serve` 路由关联 | `modules/tailscale/serveProvider.ts:80 parseServeStatus()` 解析 `Web[host:port].Handlers[path].Proxy`；`:201 fetchRoutes()` 用 `withSocket(['serve','status','--json'])`；`app.ts:98,106` 注入 `ContainerService` | ✅ 属实 |
| serve 标记 / 去重 | `modules/docker/service.ts:190 buildServeView()` 用 `reachableHostPorts` 标记 `coveredByContainerPort`（:217-224, :244）；`:252 attachServePaths()` 写 `servePaths`/`servedUrl`（:259-266） | ✅ 属实，与 `01-architecture.md:164` 描述一致 |
| `--socket` 参数位置修复 | `serveProvider.ts:216` 与 `tailscale/provider.ts` 的 `withSocket()`；回归测试 `server/tests/serve.test.ts:190` | ✅ 属实（有回归用例） |
| 运行时设置三层优先级 | `modules/settings/registry.ts:657 resolveSettings()`（database > env > default）、`:761 applyTo()`；`service.ts:99-101` | ✅ 属实 |
| `live`/`reload`/`restart` 语义 | `registry.ts` 28 项注册：`live` ×17、`reload` ×6、`restart` ×5；`restart` 在 `applyTo()`（:553）忽略且 `service.ts:158-161` 二次拒绝 | ✅ 属实 |
| 热重建数据源 | `app.ts:125-132 onReload` → `dockerProvider.reload()`、`containers.syncConfig()`、`system.syncConfig()`、`tailscale.reload()` | ✅ 属实 |
| 用户权限（admin/viewer） | `api/index.ts:26-36 PROTECTED_PREFIXES` 统一 `createRequireRoleHook('viewer')`（:58）；admin 接口逐个 `assertAdmin`（`api/users.ts` 8 处、`api/settings.ts` 4 处，`modules/users/service.ts:217`） | ✅ 属实 |
| 容器监控（stats/SSE） | `modules/docker/service.ts:163-167` stats 4 路并发；`modules/system/service.ts` + `api/system.ts` SSE；`app.ts:167-172` 全局限流（`global:false`） | ✅ 属实 |
| 审计日志 + 90 天清理 | `app.ts:279 pruneOlderThan(90d)`；动作数见 §4 | ✅ 属但动作数被夸大（§2） |
| 登录限流 10 次/分/IP | `api/auth.ts:13 LOGIN_RATE_LIMIT`，`:31` 按路由开启 | ✅ 属实 |

**⚠ 重要前提：审计期间工作区在被并发修改（审计对象是移动靶）**

本次审计开始时 `git status`（快照 A）与结束时（快照 B，见文末"审计快照"）不同：审计过程中有**其他代理/进程持续写入本仓库**（新增 `server/src/modules/docker/mapper.ts`、`server/src/modules/settings/secretStore.ts`、`server/tests/securityHeaders.test.ts`、`web/tests/` 等）。因此：

- 本文所有"代码证据"以**文末快照 B**（`git status` 23 条、`server/tests` 7 文件 213 用例）为准；
- 凡涉及"是否接线"的结论，我都在快照 B 时刻**重新复核过**（见 §4.2、§4.3 的复核说明）；
- 基线 HEAD 仍是 `9e8c13f`，Sprint 0 的全部改动**均未提交**。

未跟踪/未提交的 Sprint 0 产出（快照 B）：`http/securityHeaders.ts`（114 行）、`settings/secretBox.ts`（217 行）、`settings/secretStore.ts`（198 行）、`docker/mapper.ts`（406 行）、`web/src/pages/admin/{AuditTab,SecurityTab,UsersTab}.tsx`、`web/vitest.config.ts`、测试 `secretBox.test.ts`（19）+ `securityHeaders.test.ts`（16）；`config.ts` +144 行（新增 `trustProxy`/`securityHeaders`/`secrets`/`totp` 解析）；`AdminPage.tsx` 651→73 行；`docker/service.ts` 已被 mapper 拆分。

---

## 2. 过期 / 不准确的描述

| # | 文档怎么说 | 代码实际是什么 |
| --- | --- | --- |
| 2.1 | `README.md:300`、`todo.md:96,180`、`09-changelog.md:56,238,448`："129 个测试用例（3 个文件）" | 快照 B 实测 **7 个后端测试文件、213 个 `it(`/`test(`**（计数方法见 §7）；`09-changelog.md:704` 自己也写了 "179 passed (5 files)"。README 的 129 已过期两轮 |
| 2.2 | `README.md:318` / `todo.md:152` / `06-security.md:143`："未设置 CSP/HSTS 等安全响应头" | 表述**结果正确、原因已过期**：`config.ts:404-409` 已定义 `securityHeaders`（默认 **enabled=true**）、`http/securityHeaders.ts` 已实现 7 个固定头 + CSP + HSTS 判定，且已有 `server/tests/securityHeaders.test.ts`（16 用例）。但 `app.ts` **没有** import/注册它 → 实际仍一个头都不发。文档需改成"实现已在仓库、有单测、但未接线" |
| 2.3 | `02-configuration.md:56`：`PORTAL_TRUST_PROXY` 默认 `1` | `config.ts:33,248`：默认 **`'loopback'`**（只信回环），且支持布尔/预置名/CIDR 列表（`parseTrustProxy`，:247-270）。文档的 `1` 与代码相反 |
| 2.4 | `02-configuration.md:23`：`restart` 级典型项包含"日志级别" | registry 中 `PORTAL_LOG_LEVEL` 归在 `live` 语义列（`02-configuration.md:22`）—— 但 `config.ts:347` 的 logger 在 `buildApp` 构造时读取，`live` 改值**不会**更换已建 logger，属文档与实现的语义空隙（未验证运行效果） |
| 2.5 | `todo.md:111` 数据卷告警"有意保留" | `docker-compose.yml:143-145` 与 `docker-compose.nas.yml:113-115` 均已写 `name: homeport-data`，Compose 归属标签问题已消除 → 该条应勾选 |
| 2.6 | `todo.md:177`："`docker/service.ts` 已 559 行，映射逻辑可拆 `mapper.ts`" | 快照 B 实测：`docker/service.ts` **333 行**、新增 `docker/mapper.ts` **406 行**且已被 `service.ts` 引用 → 该技术债**实际已完成**（未提交） |
| 2.7 | `todo.md:179`："`AdminPage.tsx` 已 651 行，三个标签页应各自拆文件" | 快照 B 实测 **73 行**，已拆出 `admin/{UsersTab,AuditTab,SecurityTab,SettingsPanel}.tsx` → 该技术债已完成（未提交） |
| 2.8 | `todo.md:180`："前端缺测试（当前只有后端 129 个用例）" | 已新增 `web/tests/harness.smoke.test.tsx`（1 用例）+ `web/vitest.config.ts`（`include: tests/**/*.test.{ts,tsx}`，jsdom）→ 部分过期 |
| 2.9 | `todo.md:62`："审计日志（16 种动作）" | 代码实际 **12 种**（§4.4 逐条列出）；`07-data-model.md:109-121` 列出的也是 12 种，两处自相矛盾 |
| 2.10 | `README.md:320` / `todo.md:209`："NAS 侧部署尚未实测" | 表述一致（确未部署），但 `docker-compose.nas.yml` 已存在且 `09-changelog` 记录了多架构构建。**非过期**，仅提示 Sprint 0 后需复测 |
| 2.11 | `README.md:69`："目录名也仍然是 `HomePage/`" | 实际工作目录是 `HomePort/`；仓库目录名未随改名调整，属文档残留 |
| 2.12 | `07-data-model.md:90`："敏感值以明文存储在数据库中" | 仍然正确（§4.3），但 `secretBox.ts` 已实现加密未接线 → 需补注"加密模块已存在但未启用" |

---

## 3. 未完成项（`todo.md` 未勾选 且属 Sprint 0 范围）

按 `docs/HomePort_2.0_Balanced_Development_Plan.md` §3 归类：

- **S0-02 CI 质量门禁**：`.github/workflows/docker-publish.yml` 无 typecheck/test（§6）。`todo.md:185-186` 已自述，仍未做。
- **S0-03 安全补强**：安全响应头未接线（§4.2）；TOTP 完全不存在（§4.3）；敏感值加密未接线（§4.3）；`trustProxy` 文档默认值纠偏（§2.3）。
- **S0-04 Docker 最小权限**：无只读 socket proxy（`docker-socket-proxy`），两份 compose 均直接挂 `docker.sock`；主 compose 还是**读写**（§5）。
- **S0-05 技术债**：`docker/service.ts` 映射逻辑**已拆** `mapper.ts`（快照 B，未提交）；`AdminPage.tsx` **已拆**（同上）；前端仅补了 1 个 harness 冒烟（`api/client.ts`、`lib/format.ts` 单测仍缺失）；**无 `e2e/` 目录、无 `playwright.config.*`**，`npm run test:e2e` 会失败；**无 `LICENSE` 文件**（`package.json:6` 已声明 `"license": "MIT"`，`todo.md:171-172` 已记录）。
- **S0-01 自身**：本报告即交付物。

仍挂在 `todo.md` 但**不属于** Sprint 0（记录以免误判为缺口）：Windows 原生硬件指标、WSL2 视图提示、首次部署引导页、工具目录可视化编辑、设置乐观锁、历史趋势图、i18n、主题色板、审计 CSV 导出、容器写操作、内嵌反代。

---

## 4. 风险项：`06-security.md` 残余风险 vs 代码现状

### 4.1 `trustProxy` 与限流键（结论：当前是**安全**的，文档需纠偏）

- **现状**：`config.ts:33 DEFAULT_TRUST_PROXY = 'loopback'`；`:348 trustProxy: parseTrustProxy(process.env['PORTAL_TRUST_PROXY'])`；`app.ts:160 trustProxy: config.trustProxy` 交给 Fastify/proxy-addr。限流键为 `app.ts:171 keyGenerator: (request) => request.ip`，登录限流 `api/auth.ts:13,31`。
- **后果分析**：`'loopback'` 下，只有来自 127.0.0.1 的连接其 `X-Forwarded-For` 才被采信。tailnet 直连客户端伪造的 XFF **被忽略**，`request.ip` 仍是真实来源 → 限流不可绕过。本项目标准部署是 `tailscale serve → 127.0.0.1:8899`（`config.ts:28-31` 注释），回环信任恰好正确。
- **具体改动点**：若运维按 `02-configuration.md:56` 的旧文档设 `PORTAL_TRUST_PROXY=1`，则任意客户端可伪造 XFF → **登录限流 10/分/IP 可被绕过**（每次换头即新桶），并可能让 `request.protocol` 变 `https` 从而错误下发 HSTS（见 4.2）。改动：① 修 `02-configuration.md:56` 默认值；② 在 `06-security.md:98-99` 的说明中补"默认 `loopback`，`1` 仅在不可绕过的反代后使用，且反代必须重写而非追加 XFF"；③ 建议 `app.ts` 在 `trustProxy === true` 且 `NODE_ENV=production` 时打一条 warn 日志。

### 4.2 安全响应头（结论：**运行时确实一个头都不发**，代码已备但未接线）

- **现状（快照 B 复核）**：`app.ts:120` 一带的装配代码**没有** `securityHeaders` / `registerSecurityHeaders` 的任何 import 或调用（`Select-String app.ts -Pattern "securityHeaders"` → 无命中，且 `server/src/app.ts` 全文无 `@fastify/helmet`）。`securityHeaders.ts:44 STATIC_SECURITY_HEADERS`、`:63 securityHeadersFor()`、`:90 registerSecurityHeaders()` 仍是**未接线代码**（已有 16 个单测覆盖其纯逻辑，但没有任何调用方）。
- **具体改动点**：在 `app.ts` 的 `registerRoutes(app, ctx)` **之前**调用 `registerSecurityHeaders(app, config.securityHeaders, logger)`；`api/system.ts` 的 SSE 处理器**必须**自行调用 `securityHeadersFor()`（`securityHeaders.ts:83-85` 已说明 SSE 直接 `reply.raw.writeHead()`，不走 Fastify 发送流程）—— 目前 `api/system.ts` 未调用；另需把 4 个新键补进 `.env.example`（§5）。

### 4.3 敏感值明文落库 + TOTP（结论：加密"代码已备、运行时未启用"；TOTP 仍为零）

- **`settings.value` 明文（快照 B 复核）**：`modules/settings/secretStore.ts`（198 行）已实现装饰器式 `SecretSettingsStore`，`modules/settings/service.ts:38-39,55,86-105` 已接入——**但仅在调用方传入 `secretBox` 时才生效**（`service.ts:105 this.repository = this.secretStore ?? deps.repository`，`:97` 未传则为 null）。而 `app.ts:120 new SettingsService({...})` **没有**创建/注入 `secretBox`（`Select-String app.ts -Pattern "secretBox|SecretBox"` → 无命中，无 `createSecretBox` 调用）→ **实际运行时敏感值仍以明文写入 `value` 列**。
- **改动点**：在 `app.ts` 里用 `config.secrets`（`key` / `keyFile` / `previousKeys`，`config.ts:410-417`）调 `createSecretBox()`，注入 `SettingsService`；启动时调用已实现的 `settings.reencryptAll()`（`service.ts:124-131`）做存量明文迁移；`secret.key` 必须随 `homeport-data` 卷一起备份（`secretBox.ts:203` 已警告丢失即不可解）。当前 `sensitive: true` 只有 **1 项**（Tailscale API Token，`registry.ts:185`）→ 迁移面极小。
- **TOTP**：`config.ts:171-181,418-423` 只有 4 个配置键（`PORTAL_TOTP_ENABLED` 默认 `true`、`ISSUER`、`WINDOW`、`CHALLENGE_TTL_SECONDS`）；快照 B 全仓检索 `totp|TOTP`（`server/src` + `web/src`）仅命中 `config.ts` 与 `secretBox.ts` 的一句注释 → 无种子生成/校验、无恢复码、无登录第二步挑战、无 UI。改动点：`secretBox` 加密种子落库（`06-security.md §9.1` 已设计）+ 登录流程插入挑战（`api/auth.ts:31`）+ 管理员强制重置（新增 `user.totp_reset` 审计动作）。

### 4.4 审计日志覆盖范围（结论：12 种动作，覆盖面**无缺口但无告警**）

代码中出现的 `action` 字面量共 **12 种**（`Select-String "action: '"` 去重）：

- 认证（`modules/auth/service.ts`）：`auth.bootstrap`(:155)、`auth.login_failed`(:186)、`auth.login`(:211)、`auth.logout`(:227)、`auth.password_changed`(:298)、`user.password_reset`(:336)
- 用户管理（`modules/users/service.ts`）：`user.create`(:112)、`user.update`(:156)、`user.delete`(:179)、`user.sessions_revoked`(:193)
- 设置（`modules/settings/service.ts`）：`settings.update`(:190)、`settings.reset`(:228)

与 `07-data-model.md:109-121` 的 12 行表格逐条一致。**缺口**：① `todo.md:62` 的"16 种"是错的；② 敏感设置写入只记键名（`service.ts:193-198`，正确）；③ 没有任何"读取敏感数据"的审计（如导出、查看容器环境变量）；④ 无审计告警/通知（`06-security.md:152` 已列为残余风险 3）。

---

## 5. 容器化与部署事实核对（只读文件）

### `Dockerfile`（73 行）

- **阶段数 4**：`deps`(node:22-alpine, 装 python3/make/g++/sqlite-dev → `npm ci`) → `web-build` → `server-build`（`npm prune --omit=dev`）→ `runtime`（:13,22,28,36）
- **运行时用户**：`USER node`（:64）；`RUN mkdir -p /data && chown -R node:node /data /app`（:62）→ **非 root，数据目录已 chown**
- **tini**：`apk add tini`（:43）+ `ENTRYPOINT ["/sbin/tini","--"]`（:72）
- **healthcheck**：Dockerfile 内 `HEALTHCHECK`（:69-70，30s/5s/15s/3 次），compose 里另有等价定义（见下）
- **数据目录**：`/data`（`ENV PORTAL_DATA_DIR=/data`，:48），SQLite = `/data/portal.sqlite`（config 默认）
- **注意**：`COPY --from=server-build /app/node_modules`（:55）—— 依赖不是从 `deps` 阶段拷的，而是 prune 后的 `server-build`，正确但意味着 web 的 devDeps 不会进镜像

### `docker-compose.yml`（145 行，Windows 开发机用）

- 卷：`homeport-data:/data`（:89）+ `${DOCKER_SOCKET:-/var/run/docker.sock}:/var/run/docker.sock`（:92，**无 `:ro`，即读写**）+ 硬编码 `"C:/:/host/disk/C:ro"`（:98，**Linux/NAS 上会挂载失败**）
- `docker.sock`：**读写**。:90-91 只注释了 Windows 的 `//var/run/...` 写法，未提只读约束
- Tailscale socket/二进制：**全部注释掉**（:107-108），默认走 API 模式
- `extra_hosts: host.docker.internal:host-gateway`（:117-118）✅
- 端口映射：`${PORTAL_BIND_ADDR:-0.0.0.0}:${PORTAL_HOST_PORT:-8899}:8899`（:34）；`group_add: ${DOCKER_GID:-0}`（:122-123）
- healthcheck：:125-134（30s/5s/20s/3 次）；日志轮转 10m×3（:137-141）

### `docker-compose.nas.yml`（115 行，NAS 用）

- 用预构建镜像 `ghcr.io/xs-www/homeport:latest`（:17），非 `build:`
- `docker.sock`：`/var/run/docker.sock:/var/run/docker.sock:ro`（:74）—— **`:ro` 只是挂载属性**，:71-73 注释已正确说明"不等于只读 API 权限"
- `/proc:/host/proc:ro`（:77）、`/volume1:/host/volume1:ro`（:80，**硬编码**，与 `PORTAL_DISK_MOUNTS:/volume1=/host/volume1` :53 对应，但 NAS 多卷时需手改）
- Tailscale socket/二进制：API 模式默认，CLI 挂载注释掉（:82-85）
- `extra_hosts`（:93-94）、端口（:24）、`group_add`（:89-90）、healthcheck（:96-105）与主 compose 等价
- **结论**：`docker.sock` 权限在两份文件里**不一致**（主 compose 读写、NAS 只读），且都无 socket proxy

### `.env.example`（124 行）与 `config.ts` 同步性

同步性核对方法：`[regex]::Matches` 分别抽取 `config.ts` 中的大写键名与 `.env.example` 的行首键名（含注释行）后求差集。

**代码里有、`.env.example` 完全没写**（按类别）：

- 安全组（**全新、完全缺失**）：`PORTAL_TRUST_PROXY`、`PORTAL_CSP`、`PORTAL_HSTS`、`PORTAL_HSTS_MAX_AGE`、`PORTAL_SECURITY_HEADERS`、`PORTAL_FORWARDED_PROTO_TRUSTED`
- 加密与 TOTP（**全新、完全缺失**）：`PORTAL_SECRET_KEY`、`PORTAL_SECRET_KEY_FILE`、`PORTAL_SECRET_KEY_PREVIOUS`、`PORTAL_TOTP_ENABLED`、`PORTAL_TOTP_ISSUER`、`PORTAL_TOTP_WINDOW`、`PORTAL_TOTP_CHALLENGE_TTL_SECONDS`
- 其他缺失：`PORTAL_PUBLIC_PORT`、`PORTAL_PUBLIC_SCHEME`、`PORTAL_SESSION_COOKIE`、`PORTAL_VERSION`、`PORTAL_BUILD_REVISION`、`PORTAL_DB_PATH`、`PORTAL_WEB_DIST`、`PORTAL_DOCKER_INCLUDE_STOPPED`、`PORTAL_TAILSCALE_SOCKET`、`PORTAL_TAILSCALE_TAILNET`、`PORTAL_TAILSCALE_TIMEOUT_MS`、`PORTAL_TOOLS_PROBE_TIMEOUT_MS`、`PORTAL_DATA_DIR`、`PORTAL_HOST`、`PORTAL_PORT`、`NODE_ENV`
  （其中 `PORTAL_HOST/PORT/PORTAL_DATA_DIR/PORTAL_HOST_PROC/PORTAL_SETUP_TOKEN` 等在 `.env.example` 里以注释形式出现但未被我的键名正则命中或被 compose 固化，实际"是否向用户暴露"需按上表逐条复核）

**`.env.example` 写了、`config.ts` 不读**：`DOCKER_GID`、`DOCKER_SOCKET` —— 这两项由 `docker-compose*.yml` 消费（`group_add` / 卷路径），**不是死键**，但 `.env.example` 未说明"这两项不经过 `config.ts`"，容易在排障时误判。

### `.github/workflows/docker-publish.yml`（124 行）

- **触发条件**：`push` 到 `master` 或 tag `v*`（:22-25）+ `workflow_dispatch`（:37）。**没有 `pull_request` 触发** → 外部 PR 不会跑任何东西（也就不会泄露 `secrets.GITHUB_TOKEN`，计划 S0-02 的"避免对外部 PR 暴露密钥"天然满足）
- **是否跑测试**：**完全不跑**。唯一 job `build-and-push`（:53-124）的步骤只有 checkout / QEMU / buildx / login / metadata / `docker/build-push-action` / summary。无 `npm ci`、无 `npm run typecheck`、无 `npm test`
- `paths-ignore` ★风险：`'**.md'`、`'docs/**'`、`'LICENSE'`、`'.gitignore'`、`'.gitattributes'`、`'docker-compose*.yml'`（:28-35）→ **纯文档 PR/push 完全不触发 workflow**。注意 `Dockerfile`、`server/**`、`web/**`、`package*.json`、`.github/**` **不在**忽略列表内
- 其余：`permissions: contents:read + packages:write`（:56-60）；`PLATFORMS: linux/amd64,linux/arm64`（:51）；`provenance:false`、`sbom:false`（:105-106，为兼容 NAS 老 Docker）

---

## 6. CI 现状（结论：**没有任何工作流运行 typecheck / test**）

- 事实：`.github/workflows/` 下**只有** `docker-publish.yml` 一个文件（已枚举目录）。该文件不包含任何 typecheck/test 步骤（§5）。
- 后果：一个 typecheck 失败或单测失败的 PR 合入 `master` 后，`docker/build-push-action` 仍会构建并**推送**镜像到 GHCR（`push: true`，:99）—— 直接违背计划 §3 验收标准"CI 在含故意失败测试的 PR 上阻止镜像发布"。当前唯一的防线是"Dockerfile 里的 `npm run build` 会因类型错误失败"（`server-build` 阶段 `RUN npm run build --workspace server`），但**这只覆盖 server 的类型检查，不覆盖 web typecheck，也不覆盖任何测试**。
- **新增质量门禁应落在哪个文件**：`.github/workflows/docker-publish.yml`（新增一个在 `build-and-push` 之前、`needs:` 关系为前置的 `verify` job）。计划 S0-02 要求"PR/push 阶段运行"，而现有文件**没有 `pull_request` 触发**，因此必须同时新增：
  - `on.pull_request: branches: [master]`（或默认全分支）
  - 该 job 内 `npm ci` → `npm run typecheck` → `npm test` → `npm run build`
  - `build-and-push` 增加 `needs: [verify]`
- **`paths-ignore` 陷阱（必须显式处理）**：若把 `verify` 写进同一个 workflow，它会**继承** `paths-ignore: ['**.md','docs/**', ...]` → 纯文档 PR 连 typecheck/test 都跳过。两种正确写法：① 把 `verify` 拆到**另一个** workflow 文件（如 `.github/workflows/ci.yml`），只对代码路径设置 `paths-ignore`（甚至不设）；② 保留在同一文件但接受"文档 PR 不跑门禁"（若将来开启 branch protection 的 required check，**文档 PR 会永远卡在 pending**，因为被忽略的 workflow 不会产生 check —— 这是最有杀伤力的后果，务必避免）。
- 另需注意：`test:e2e`/`e2e:serve` 已在 `package.json` 声明但 `e2e/` 与 playwright 配置不存在，**不能**把 `npm run test:e2e` 直接写进 CI。

---

## 7. 未覆盖的测试

**计数方法与结果（快照 B）**：

- 后端：`server/tests/*.test.ts` 共 **7 个文件**（`Get-ChildItem`）；用例数用 `[regex]::Matches($raw, '(?m)^\s*(it|test)\(')` 逐文件计数后求和，得 **213**：
  `modules.test.ts` 53、`util.test.ts` 45、`auth.test.ts` 38、`settings.test.ts` 27、`secretBox.test.ts` 19、`securityHeaders.test.ts` 16、`serve.test.ts` 15。
  该方法只数源码里 `it(`/`test(` 的字面量（`.each` 按 1 行计，未按运行时展开），因此 213 是"源码用例声明数"的**下界**；审计开始时快照 A 是 6 文件 / 197（差集 = 新增的 `securityHeaders.test.ts` 16 个）。
- 前端：`web/tests/harness.smoke.test.tsx` **1 个文件、1 个用例**（渲染 `Badge`/`EmptyState`/`Skeleton` 三个原子组件）。`web/vitest.config.ts` 已配 jsdom + globals，`web/package.json` 已有 `test: vitest run`。
- E2E：**0**。`e2e/` 目录不存在，仓库根无 `playwright.config.*`，尽管 `package.json` 声明了 `test:e2e` 与 `e2e:serve`（`@playwright/test ^1.64.1` 已在 devDependencies）。

**已覆盖（按 describe 块）**：`config` 环境变量解析、`docker/provider` endpoint 解析 / stats 归一化 / 有限并发、`docker/service` 容器映射、`docker/hostContext`、`tailscale/provider` 设备映射、`system/provider` nvidia-smi 解析、`system/service.helpers` SSE 帧、`tools/catalog` 与 `tools/service`、认证流程 / 会话与 CSRF / 角色与账号管理 / 接口契约、`util/{net,redact,format,proc,dockerStream,cache}`、`settings/registry` 三层优先级/校验/applyTo/序列化打码 + tailscale 连通性纯逻辑、`serveProvider` 解析与小工具函数 + `--socket` 位置回归、`secretBox` 加密解密/轮换/密钥解析/密钥文件、`securityHeaders` 头集合与 HSTS 条件（快照 B 新增）。

**明确缺失**：

1. **CI 不跑这些测试**（§6）→ 213 个用例目前只有人工执行时才有价值。
2. **前端几乎无覆盖**：`api/client.ts`（CSRF 注入、401 回调、超时）、`lib/format.ts`、`SessionContext`、路由守卫、`SettingsPanel` 的 effect/source 徽标渲染 —— 全部 0 用例。
3. **SSE 端到端**：只有 `system/service.helpers` 的帧构造单测，无"订阅 → 收到 N 帧 → 断线重连"的集成测试。
4. **安全头接线本身**：`securityHeadersFor()` 有纯逻辑单测，但**没有**"经由真实 `buildApp()` 发一个请求并断言响应头"的集成用例 —— 这正是本次"实现存在但未接线"能被漏过的原因。
5. **设置热更新的端到端效果**：有 `applyTo` 纯逻辑单测，但无"PATCH /api/settings → Tailscale/Docker provider 真被重建"的集成用例。
6. **权限矩阵回归**：`assertAdmin` 的逐路由覆盖无参数化用例（改路由时容易漏）。
7. **无 E2E / 无迁移幂等性测试 / 无备份恢复演练**（计划 §1.4 要求"SQLite 迁移幂等、兼容旧数据"，`db/database.ts` 的迁移框架自身未见用例）。

---

## 结论：Sprint 0 必须补的缺口清单（按优先级）

| P | 缺口 | 落点 | 验收方式 |
| --- | --- | --- | --- |
| **P0** | CI 无 typecheck/test，失败代码仍会推镜像 | `.github/workflows/docker-publish.yml` 新增前置 `verify` job + `on.pull_request` + `needs`；**或**拆出独立 `.github/workflows/ci.yml` 以免被 `paths-ignore` 吞掉 | 含故意失败测试的 PR 必须红且不推镜像；文档 PR 不能永远 pending |
| **P0** | 安全响应头"实现了、有单测、但没接线"，实际零头 | `app.ts` 注册 `registerSecurityHeaders(app, config.securityHeaders, logger)`；`api/system.ts` 的 SSE 补 `securityHeadersFor()` | 抓响应头断言 CSP/`X-Frame-Options`/`Referrer-Policy`/`nosniff`；HTTP 直连**不得**出现 HSTS；SSE 响应含头；补 `buildApp()` 级集成用例防再次漏接线 |
| **P0** | `settings.value` 敏感值仍明文落库（加密层已写好但未注入） | `app.ts` 创建 `createSecretBox(config.secrets)` 并注入 `SettingsService`；启动调 `settings.reencryptAll()` 迁移存量明文；`secret.key` 纳入备份说明 | 单测 + 直接读 SQLite 文件确认 `value` 以 `enc:v1:` 开头；界面读取仍打码；旧值可解 |
| **P1** | TOTP 完全不存在（仅 4 个配置键） | 新增种子存储（加密）+ 登录第二步挑战（`api/auth.ts:31`）+ 恢复码 + 管理员强制重置（新增审计动作）+ UI | 开关与恢复码有自动测试（计划 §3 验收标准明确要求） |
| **P1** | `02-configuration.md:56` 写 `PORTAL_TRUST_PROXY` 默认 `1`，实为 `loopback` | 改文档；`06-security.md:98-99` 补"`1` 仅在不可绕过反代后使用、必须重写 XFF"；生产环境 `trustProxy===true` 时打 warn | 文档与 `config.ts:33` 一致；`request.ip` 在伪造 XFF 下不变（补测试） |
| **P1** | `docker-compose.yml` 硬编码 `C:/`，与"Windows 与 NAS 同一份"矛盾；主 compose 的 `docker.sock` 是读写 | 把磁盘挂载改为可选/`.env` 驱动（如经 `COMPOSE_FILE` 或 profile）；主 compose 也加 `:ro`；两份对齐 | `docker-compose.yml` 在 Linux 上可启动（或文档明确声明它只面向 Windows） |
| **P2** | `.env.example` 缺 13 个新增键（安全组 6 + 加密/TOTP 7），另有 16 个键缺失或未说明 | 按 `config.ts` 全量补齐；标注 `DOCKER_GID`/`DOCKER_SOCKET` 由 compose 消费而非 `config.ts` | 用本次的差集脚本复跑，差异为空 |
| **P2** | README/todo/changelog 的测试数量过期（129 → 213）；`todo.md:111` 卷告警、`:177` mapper、`:179` AdminPage 均已过期 | 更新 `README.md:300`、`todo.md:62,96,111,177-180`、`docs/static/09-changelog.md` | 文档数字与 `server/tests` 实际计数一致 |
| **P2** | 无 socket proxy（S0-04）；`docker.sock` 拥有宿主 root 等价能力 | 评估引入只读 socket proxy（仅放行 GET），作为 NAS 可选部署（不强制改现有 NAS） | 代理模式下容器列表可读、写接口不可用 |
| **P2** | 无 E2E；`test:e2e`/`e2e:serve` 脚本悬空 | 新增 `e2e/` + `playwright.config.*`，或先移除悬空脚本避免 CI 误用 | 首启初始化 → 登录 → 各页面加载冒烟通过 |
| **P3** | 无 `LICENSE`（`package.json` 已声明 MIT）；`api/client.ts`/`lib/format.ts` 无单测；`service.ts`/`AdminPage.tsx` 拆分已完成但无测试守护（mapper 无独立单测） | 按 `todo.md:171-172,180` 处理；LICENSE 须由仓库所有者确认授权 | 文件存在；单测覆盖 CSRF 注入与错误转换 |

**一句话结论**：计划 §1.1 声称的基线（Serve 关联、运行时设置、用户权限、容器监控）**在代码里确实存在且实现完整**，可以放心复用；Sprint 0 的真实缺口集中在 **CI 门禁（0%）、安全响应头接线（0%）、加密注入（0%）、TOTP（0%）、compose 一致性、.env.example 同步与文档数字**——其中"代码已写好、有单测、但没接进 `app.ts`"是本次审计最容易误判为"已完成"的陷阱（`securityHeaders.ts`、`secretStore.ts` 属此类，TOTP 则连实现都没有）。

## 审计快照（可复现性）

- **快照 A（审计开始）**：HEAD `9e8c13f`，`git status` 11 条（`M .gitignore, package-lock.json, package.json, server/src/config.ts, web/package.json, web/src/pages/AdminPage.tsx` + 6 个未跟踪）；`server/tests` 6 文件，197 用例（`it/test` 字面量）。
- **快照 B（审计结束，报告结论以此为准）**：HEAD 仍 `9e8c13f`，`git status` **23 条**（新增 `M server/src/db/settings.ts`、`M server/src/modules/docker/service.ts`、`M server/src/modules/settings/{registry,service}.ts`；新增未跟踪 `docker/mapper.ts`(406)、`settings/secretStore.ts`(198)、`tests/securityHeaders.test.ts`(190)、`web/tests/`）；`server/tests` **7 文件、213 用例**。
- **复现命令**（全部只读）：`git status --short`；`git log --oneline`；`(Get-ChildItem server/tests/*.test.ts | ForEach-Object { ([regex]::Matches((Get-Content $_.FullName -Raw), '(?m)^\s*(it|test)\(')).Count } | Measure-Object -Sum).Sum`；`Select-String -Path server/src/app.ts -Pattern "securityHeaders|secretBox"`；`Select-String -Path server/src -Pattern "action: '"`；`.env.example` 与 `config.ts` 键名差集脚本（§5）。
- **未验证项**（重申）：测试实际是否通过、NAS 线上 Serve 状态、`npm run typecheck`/`build` 结果 —— 均未运行，原因见"审计范围与方法"。