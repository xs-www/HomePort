# 09 · 变更记录（按 git diff 归档）

> **规则**：每次开发任务结束时，必须依据 `git diff` 把**全量**修改按本文件的格式归档，
> 并同步更新受影响的其他静态文档。宁可重复记录，也不要漏记。

## 归档格式

```markdown
## [日期] 任务标题

### 变更概览
| 类型 | 文件 | 说明 |

### 逐项明细
#### 新增：<文件路径>
- `符号名(签名)` — 行为、参数、返回值、边界条件

#### 修改：<文件路径>
- `符号名` — 改动前 → 改动后，以及**为什么**

#### 删除：<文件路径>
- 删除原因与替代方案

### 配置/接口/数据模型影响
- 新增或变更的环境变量、HTTP 接口、DB 迁移

### 验证方式
- 实际执行的命令与结果

### 已知限制 / 后续
```

---

## [2026-10-16] 初始版本：从零搭建 Tailnet 动态门户（v0.1.0）

### 背景与决策

项目目标：部署在 Docker 内的动态门户，作为 Windows（测试）/ NAS（最终）上的控制面板。

四个方向性决策（经用户确认）：

| 决策 | 选定方案 | 理由 |
| --- | --- | --- |
| 后端技术栈 | Node.js 22 + TypeScript + Fastify | 与 DSH 生态一致，dockerode/tailscale 客户端成熟，单容器镜像小，Windows 与 NAS 一致 |
| 容器控制权限 | **只读展示 + 打开入口** | 最小权限。不提供 start/stop/restart，从类型层面就不存在写方法 |
| 部署方式 | 直接容器化（docker compose 一键起） | 避免"先本机调通再容器化"的返工，Windows 与 NAS 走同一条路径 |
| 账号体系 | 本地账号 + admin/viewer + 会话持久化 + 首启初始化 | 无外部依赖，NAS 离线可用 |

### 变更概览

| 类型 | 范围 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/**`（49 文件） | 后端：基础设施 + 5 个功能模块 + 路由层 + 应用装配 |
| 新增 | `web/src/**`（22 文件） | 前端：React 19 + Vite 6 + Tailwind 4，7 个页面 |
| 新增 | `server/tests/**`（3 文件） | 129 个单测/集成测试 |
| 新增 | `docs/static/**`（9 文件） | 静态函数文档（本目录） |
| 新增 | `Dockerfile` `docker-compose.yml` `.env.example` | 容器化与配置样例 |
| 新增 | `package.json`（workspaces）`tsconfig*` `vite.config.ts` `vitest.config.ts` | 工程配置 |
| 新增 | `.gitignore` `.gitattributes` `README.md` `todo.md` | 仓库基础设施 |

### 逐项明细

#### 新增：`server/src/config.ts`

- `portalConfigSchema` 未使用 zod（手工解析），目的是让报错信息更贴近运维视角。
- `parseMounts(raw: string): MountConfig[]` — 解析 `PORTAL_DISK_MOUNTS`。
  语法 `展示路径=容器内路径[|标签[|statfs路径]]`，逗号分隔。
  **必须显式写 `=`**，只写一个路径时报错（无法判断是宿主路径还是容器路径）。
- `defaultMountLabel(displayPath): string` — 取最后一段并去掉 Windows 盘符冒号（`C:` → `C`）。
- `loadConfig(overrides?): PortalConfig` — 读取全部环境变量。非法值**抛错**而非静默取默认值。
- `SERVER_ROOT` / `REPO_ROOT` — 由 `import.meta.url` 推导，保证源码与构建后路径一致。
- `config: PortalConfig` — 进程级单例。

#### 新增：`server/src/logger.ts`

- `createLogger(options): Logger` — 极简结构化日志（不引入 pino）。
  `error`/`warn` 走 stderr，其余 stdout；`Error` 值自动序列化。
- `createSilentLogger(): Logger` — 测试用。

#### 新增：`server/src/db/*`

- `openDatabase(options): Db` — PRAGMA：WAL、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=NORMAL`。
- `runMigrations(db, migrations?, logger?): number[]` — 每个迁移独立事务，失败回滚并抛错。
- `MIGRATIONS` v1 `initial_auth_schema` — users / sessions / user_preferences / audit_log + 索引。
- `UsersRepository` / `PreferencesRepository` / `AuditRepository` — 全部同步方法。
- `db/types.ts` — Row ↔ 应用对象纯映射 + `normalizeRole`（非法值回退 `viewer`）。

#### 新增：`server/src/util/*`

| 文件 | 关键实现 |
| --- | --- |
| `net.ts` | `classifyBind(hostIp, tailscaleIps): Reachability` —— **F1 判定核心**：通配/tailnet IP → `tailnet`；回环 → `localhost-only`；私网 → `lan` |
| `redact.ts` | `isSensitiveKey` 覆盖 `password/secret/token/api_key/auth_key/credential/...`；`redactText` 额外命中 `sk-*`/`tskey-*`/`ghp_*`/`AKIA*`/`Bearer *` |
| `proc.ts` | `HostProcReader` —— 宿主 `/proc` 读取，全部方法带 `node:os` 降级；`osCpusToCpuTimes()` 用 `os.cpus().times` 合成累计值 |
| `dockerStream.ts` | `demuxDockerLogs(buffer, isTty)` —— 解析 8 字节多路复用头，分离 stdout/stderr；无有效帧时退化为纯文本；尾部残缺帧不丢 |
| `cache.ts` | `TtlCache<T>` —— TTL + **single-flight**（并发同 key 只执行一次 loader）；`getStaleWhileRevalidate` 供工具探测秒开 |
| `exec.ts` | `runCommand` —— **不抛异常**，结果通过 `{ code, timedOut, notFound }` 表达（调用方需按此降级） |

#### 新增：`server/src/modules/docker/*`（F1）

- `resolveDockerEndpoint(endpoint)` — 支持 npipe/unix/tcp/http/https。
  **`normalizeNamedPipe` 是关键修复**：URI 里 2~4 个斜杠都合法，但 dockerode 需要恰好
  `//./pipe/...`。早期实现 `raw.replace(/^npipe:/,'')` 会得到 `////./pipe/...`，
  被当作相对文件路径并报 `ENOENT`。
- `computeCpuPercent(stats)` — Docker 官方公式 `cpuDelta/systemDelta*onlineCpus*100`。
- `normalizeStats(stats)` — 内存扣除 `inactive_file`；网络与块设备求和；`limit=0` 视为未知。
- `mapWithConcurrency(items, n, worker)` — 有限并发，避免一次性 inspect 上百个容器。
- `DockerProvider` — 只读 API：`checkAvailability` / `listContainers` / `inspectContainer` /
  `getLogs` / `getStats` / `getInfo`。**不提供任何写方法**。
- `buildHostContext(input): PortalHostContext` — 从请求头 + tailnet 信息推导门户对外主机，
  候选顺序：`PORTAL_PUBLIC_HOST` → MagicDNS → tailnet IP → 访问者主机 → localhost。
- `mapContainer(inspect, hostContext, tailscaleIps, {skipUrls})` — 映射契约。
  `skipUrls: true` 时（缓存阶段）只算可达性、清空 URL；URL 由 `attachHostContext` 在
  响应阶段按当前访问者生成 —— 一份缓存服务多种访问方式。
- `summarize(items)` — 统计 running/stopped/tailnetReachable/lanReachable/localhostOnly/attention。

#### 新增：`server/src/modules/tailscale/*`（F2）

- `CliTailscaleProvider` — 执行 `tailscale status --json`。
- `ApiTailscaleProvider` — 调 `https://api.tailscale.com/api/v2/tailnet/{tailnet}/devices`。
- `selectTailscaleProvider(config, logger, run)` — `auto` 策略：有 API Token 走 API，否则 CLI。
- `mapCliStatus(json)` / `mapCliPeer(peer)` — 统一设备模型，含 `connection`（direct/relay/idle）
  与 `lastSeen`。
- `mapApiDevices(devices, selfHostname)` — API 侧设备映射并按主机名标记本机。
- `hostInfoCache.ts` — 单向"寄存器"，解开 `docker → tailscale → docker` 模块环。
- `TailscaleService` — 缓存 + **同步读接口**（`getTailscaleIpv4` 等不触发命令执行）。
  **数据源失败时保留旧地址**：否则 tailscale 偶发失败会让整面容器墙判成不可达。

#### 新增：`server/src/modules/system/*`（F3）

- `parseNvidiaSmiCsv` / `parseNvidiaSmiProcesses` / `parseNvidiaSmiUuids` — GPU 解析，
  处理 `[N/A]` 与 `[Not Supported]`，MiB → 字节。
- `parseNvidiaSmiProcesses` — 附带占用显存的进程列表。
- `SystemProvider.snapshot()` — 一次取全。
- `SystemProvider.readCpu()` — **采样间隔保护**：距上次不足 500ms 时复用上次结果。
  否则连续两次快照因分子分母都接近 0 而给出 0%/null 抖动。
- `SystemProvider.readDisks()` — 逐挂载点 `fs.statfs`；
  `used = (blocks-bfree)*bsize`，`percent = used/(used+available)`。
- `SystemProvider.readGpu()` — 3 秒缓存；支持 `PORTAL_NVIDIA_LD_LIBRARY_PATH`（WSL 需要）。
- `sources[].mode` — `host-proc` / `os-cpus` / `container-proc` / `statfs` / `nvidia-smi` / `none`，
  让"数据不准"与"服务坏了"在 UI 上可区分。

#### 新增：`server/src/modules/tools/*`（F4）

- `BUILTIN_TOOLS` — Ollama(11434) / DSH(3080) / ComfyUI(8188) / Open WebUI(3001) /
  Portainer(9000) / Jellyfin(8096) / qBittorrent(8081) / code-server(8443)。
- `loadCatalog(config, logger)` — 内置目录 → JSON 文件合并/替换 → `PORTAL_TOOLS_EXTRA` 追加。
- `normalizeTool` — 校验 id 正则与端口范围，补全路径前导斜杠。
- `probeTool(options)` — 两级探测：TCP → HTTP。
  TCP 通但 HTTP 不通仍判 `up`（可能纯 TCP 或需鉴权），只在 detail 说明。
  首选主机失败时用 `127.0.0.1` 复测，区分"服务没起来"与"从门户这条路不通"。

#### 新增：`server/src/modules/auth/*`（F5）

- `checkPasswordStrength(password)` — ≥10 位、≥2 类字符、拒绝常见弱口令、≤128 字节
  （bcrypt 只取前 72 字节，过长直接拒绝而不是静默截断）。
- `hashPassword` / `verifyPassword` — bcrypt cost 12（bcryptjs 纯 JS，避免多架构编译失败）。
- `dummyVerify()` — 用户不存在时执行等价耗时比较，抹平时间侧信道（防用户枚举）。
- `timingSafeEqual(a, b)` — 恒定时间比较。
- `generateSetupToken()` — 24 位易抄写字符集，`XXXXXX-XXXXXX-XXXXXX-XXXXXX` 格式。
- `SessionsRepository` — 令牌只存 SHA-256；`unrevoke` 用于"改密保留当前会话"。
- `AuthService` — `isSetupRequired` / `getSetupToken` / `bootstrap` / `login` / `logout` /
  `resolveSession` / `describeSession` / `changeOwnPassword` / `revokeOtherSessions` /
  `resetPassword` / `purgeExpiredSessions` / `invalidateUserCache`。

#### 新增：`server/src/api/*`

- 权限模型集中在 `registerRoutes`：`PROTECTED_PREFIXES` 为每个路由域统一挂
  `requireRole('viewer')` + CSRF 钩子 —— **默认安全**，新增路由忘记加守卫最坏也只是"需要登录"。
- `health.ts` — 无需登录，供 compose healthcheck。
- `system.ts` — SSE：立即推首帧、30s ping、15 分钟主动断开。

#### 新增：`server/src/app.ts`

- `buildApp(options): Promise<AppHandle>` — 装配全部依赖，**不监听端口**（便于 `inject` 测试）。
- `registerStatic(app, config, logger): string | null` — 只注册静态资源路由，返回 `index.html` 路径。
- `notFoundHandler` 在 `buildApp` 内**只注册一次**：`/api/*` 一律 JSON 404；
  其它 GET 在已构建前端时回退 `index.html`。
- 静态缓存：`/assets/*`（含 hash）`immutable` 长缓存；`index.html` 强制 `no-cache`。

#### 新增：`web/src/**`

- `api/client.ts` — `ApiClient`：`credentials: 'same-origin'`、变更类请求自动加 `X-CSRF-Token`、
  超时控制（默认 20s，慢接口 45s）、`ApiError` 携带 `fieldErrors`。
- `auth/AuthProvider.tsx` — 唯一持有会话状态处；把 CSRF 取值与 401 处理注入 client；
  主题在拉会话**之前**先从 `localStorage` 应用（防闪白）。
- `hooks/useAsync.ts` — `useAsync`（含并发保护、卸载保护、页面隐藏时跳过刷新）/
  `useSubmit` / `useLocalState`。
- `hooks/useMetricsStream.ts` — SSE 订阅，重连交给浏览器。
- `components/ui.tsx` — `Badge` / `Card` / `ProgressBar` / `StatCard` / `KeyValue` /
  `SourceNotice` / `EmptyState` / `Skeleton` / `Spinner` / `ErrorNotice` / `Icon`。
- `layout/AppShell.tsx` + `layout/Shell.tsx` — 侧栏 + 顶栏；抽屉式在 `< lg` 生效。
- 7 个页面 + 404，全部经 `Shell` 渲染以保证守卫分支不丢导航。

#### 新增：`Dockerfile` / `docker-compose.yml`

- 四阶段构建：`deps`（装 python3/make/g++ 供 better-sqlite3 编译）→ `web-build` →
  `server-build`（`npm prune --omit=dev`）→ `runtime`（alpine + tini，非 root 运行）。
- compose 用 `.env` 表达平台差异，同一份文件在 Windows 与 NAS 上都能跑。

### 开发过程中发现并修复的真实缺陷

按发现顺序，均为**实测或测试暴露**而非推测：

| # | 缺陷 | 影响 | 修复 |
| --- | --- | --- | --- |
| 1 | named pipe 路径归一化错误（`////./pipe/...`） | Windows 上完全读不到 Docker，报 `ENOENT` | 新增 `normalizeNamedPipe()` |
| 2 | `webDistDir` 用 `process.cwd()` 推导 | 从 `server/` 启动时指向 `server/web/dist`，前端 503 | 改用 `REPO_ROOT`（`import.meta.url` 推导） |
| 3 | Windows 无 `/proc` 导致 CPU 恒为 `null` | F3 核心指标不可用 | 新增 `osCpusToCpuTimes()` 兜底 + `os-cpus` 模式。**注**：后续部署实测发现 `os-cpus` 在 Windows *容器化* 下只能看到 WSL2 虚拟机资源，见本文件末尾的部署实测条目 |
| 4 | 连续快照 CPU 读数抖动（0%/null） | 指标不可信 | `MIN_CPU_SAMPLE_INTERVAL_MS = 500` 内复用上次结果 |
| 5 | `PORTAL_DISK_MOUNTS` 缺少 `=` 时静默猜测 | statfs 目标错误 | 改为直接抛错 |
| 6 | `defaultMountLabel` 保留盘符冒号 | 界面显示 `C:` 而非 `C` | 去掉尾部 `:` |
| 7 | `TS_AUTHKEY` 未被脱敏 | **密钥泄漏到前端** | 敏感 key 模式新增 `auth_key` |
| 8 | `/api` 404 返回 HTML | 前端 `JSON.parse` 报错难定位 | `notFoundHandler` 统一在 `buildApp` 注册 |
| 9 | `setNotFoundHandler` 重复注册 | 启用静态托管时**启动失败** | `registerStatic` 不再注册，只返回 index 路径 |
| 10 | 静态资源缓存头被 `maxAge` 覆盖 | hash 产物只缓存 1 小时 | `setHeaders` 里显式覆盖 `cache-control` |
| 11 | zod `.default()` 输出类型仍带 `| undefined` | 类型与运行时不一致，需到处写 `??` | 去掉全部 `.default()`，默认值移到路由层 |
| 12 | `parseOrThrow` 用 `z.ZodType<T>` 泛型 | 带 `.transform()` 的 schema 编译不过 | 改为 `z.ZodTypeAny` + `z.output<S>` |
| 13 | Fastify `disableRequestLogging` 废弃告警 | 日志噪声 | 移除该选项 |
| 14 | 测试用 `x-forwarded-for` 与限流互相干扰 | 限流用例把其它用例打成 429 | 测试开启 `trustProxy` 并为每个用例分配独立来源 IP |

### 配置/接口/数据模型影响

- **环境变量**：新增 40+ 项，全部有默认值。详见 `02-configuration.md`。
- **HTTP 接口**：新增 `/api/health`、`/api/auth/*`(6)、`/api/overview`、`/api/containers/*`(4)、
  `/api/tailscale/*`(2)、`/api/system/*`(2，含 SSE)、`/api/tools/*`(2)、`/api/users/*`(10)。
  详见 `04-api-contract.md`。
- **数据库**：迁移 v1 建立 5 张表。详见 `07-data-model.md`。

### 验证方式

```bash
# 类型检查（前后端）
npm run typecheck                          # exit 0

# 单元/集成测试
npm test                                   # 129 passed (3 files)

# 生产构建
npm run build                              # web 351 KB (gzip 107 KB) + server 49 文件

# 编译产物实测（Windows 宿主，真实 Docker + Tailscale）
node server/dist/index.js
curl /api/health          # docker=npipe 可用, tailscale=cli 可用, system=os-cpus
curl /api/containers      # total=5, tailnet 可达 2, 仅本机 3（与 docker ps 一致）
curl /api/tailscale/devices # 11 台设备，在线/离线/连接方式正确
curl /api/system/snapshot # cpu=2.3%, 20 线程, mem=56.6%, mode=os-cpus
curl /api/tools           # DSH up, 其余 down（与实际端口监听状态一致）
curl /api/overview        # 四源聚合正常
curl /api/nope            # JSON 404
curl /containers          # SPA 回退 200
```

真实数据交叉验证（与 `docker ps`、`tailscale status`、任务管理器对比）：

| 项目 | 门户结果 | 独立来源 | 一致 |
| --- | --- | --- | --- |
| 容器 | 5 个，cs22-backend/cs22-web 绑定 `0.0.0.0`，其余绑定 `127.0.0.1` | `docker ps` 端口映射 | ✅ |
| 容器日志 | cs22-web nginx access log | `docker logs` | ✅ |
| tailnet | 本机 `Sisi-Laptop`/`100.72.255.29`，11 台设备 | `tailscale status --json` | ✅ |
| GPU | 未挂载 `nvidia-smi` → 明确报"不可用"及原因 | — | ✅（不误报） |
| DSH | 3080 端口 up，延迟 13ms | `Test-NetConnection 3080` | ✅ |
| Ollama | 11434 端口 down | `Test-NetConnection 11434` | ✅ |

### 已知限制 / 后续

1. **Windows 上 tailscale CLI 模式不可用**：容器内无法执行 Windows PE 可执行文件。
   Windows 请用 API 模式（`PORTAL_TAILSCALE_MODE=api`）；或让门户跑在 WSL 内。
   文档已在 `08-operations.md` §3.1 说明。
2. **Windows 上 `/proc` 挂载会误导**：Docker Desktop 的 WSL2 里挂 `/proc` 得到的是
   虚拟机视图，与任务管理器对不上。当前代码优先用 `host-proc`，因此 Windows 用户
   需**主动不挂** `/proc` 才能走 `os-cpus` 路径。后续可改为按宿主平台自动判断。
3. **无 TOTP 二次验证**、**无安全响应头（CSP/HSTS）**：见 `06-security.md` §9 残余风险。
4. **无容器写操作**：当前为有意的产品边界（只读）。若后续需要启停，必须在
   `06-security.md` 重新评估威胁模型（拥有 `docker.sock` 等于拥有宿主 root）。
5. **未做镜像构建实测**：本机 Docker Desktop 可用，但尚未实际 `docker compose up --build`
   验证镜像（构建含原生模块编译，耗时较长）。`todo.md` 已列为待办。
6. **未验证 arm64 构建**：NAS 为 arm64 时应能成功（builder 阶段原生编译），但未实测。

### 新增文档

`docs/static/` 下新建 9 个文件：`README.md`（索引）、`01-architecture.md`、`02-configuration.md`、
`03-server-modules.md`、`04-api-contract.md`、`05-web-modules.md`、`06-security.md`、
`07-data-model.md`、`08-operations.md`、`09-changelog.md`（本文件），
以及仓库根的 `README.md` 与 `todo.md`。

---

## [2026-10-16] 首次容器化部署实测与修正

在 Windows 11 + Docker Desktop 上实跑 `docker compose up -d --build`，
镜像构建、容器启动、健康检查、登录、各功能接口全部验证通过，
并纠正了初版文档中关于 Windows 指标可得性的**错误描述**。

### 部署结果（实测）

```
$ docker compose up -d --build
 Image homepage-portal:local Built              # 首次构建成功，无编译错误
 Container homepage-portal Started
$ docker compose ps
 homepage-portal  Up (healthy)  0.0.0.0:8899->8899/tcp
```

`/api/health`：

| 数据源 | 结果 |
| --- | --- |
| docker | ✅ available，`mode: socket` |
| tailscale | ❌ `mode: api`，未配置 Token（预期） |
| system | ✅ available，`mode: os-cpus` |
| disk | ✅ available，`mode: statfs` → **952 GB / 已用 65%**，与资源管理器一致 |
| gpu | ❌ 不可用（预期，原因见下） |

功能区实测：容器 6 个（含门户自身），tailnet 可达 3 / 仅本机 3；
经 tailnet IP 访问时由 `os.cpus()` 读到 4 线程——见下方修正。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `.env.example` | Windows 段落重写：容器内必须用 unix socket；补充 3 个实测坑 |
| 修改 | `.env`（新增，gitignored） | 本机可用的实际配置 |
| 修改 | `docker-compose.yml` | 磁盘盘符改为带引号的 `"C:/:..."`；拆出 Windows 磁盘挂载段；修正 DOCKER_ENDPOINT 注释 |
| 修改 | `README.md` | 「指标为什么可能不准」改为实测结论表；平台配置要点重写；已知限制更新 |
| 修改 | `docs/static/01-architecture.md` | 部署形态图下补充 Windows 例外说明 |
| 修改 | `docs/static/08-operations.md` | §2 指标取数边界重写为实测表；§3.1 增加常见坑表与原生运行方案；§4 GPU 章节重写 |
| 修改 | `todo.md` | 更新已完成项与剩余待办 |

### 逐项明细

#### 修改：`docker-compose.yml`

- **磁盘盘符写法**：`${HOST_DISK_C:-C:}:/host/disk/C:ro` → `"C:/:/host/disk/C:ro"`。
  **原因**：`C:` 在 compose 变量替换后被当成**相对路径**，解析为
  `D:\桌面\sisi_apps\HomePage\C:`（实测 `docker compose config` 可见），挂载失败。
  必须写成 `"C:/"` 且加引号。
- **`DOCKER_ENDPOINT` 注释**：明确"容器内一律用 unix socket"。
- 新增说明：Windows 上不要挂 `/proc`，也不要试图挂 `nvidia-smi.exe`。

#### 修改：`docs/static/08-operations.md`（重要更正）

**原文错误**：声称"Windows 上挂载 `/proc` 会读到 WSL2 视图，应改为不挂让代码走 `os-cpus`"，
暗示 `os-cpus` 能拿到 Windows 真实值。

**实测结论**：两者**是同一个来源**，都只报 4 线程 / 3.9 GB：

```
容器内 os.cpus()              → 4 线程
容器内挂载 WSL 的 /proc        → 4 线程（grep -c ^processor /host/proc/cpuinfo）
原生 node（Windows）          → 20 线程 / 31.63 GB
```

因此挂载 `/proc` **无法**解决 Windows 的指标问题。已把该节重写为按部署方式
（容器化·Linux / 容器化·Windows / 原生·Windows）划分的实测表，
并给出两条可行路径：原生运行、或调大 `.wslconfig` 的 WSL2 配额。

同时新增「常见坑」表，收录本次实测踩到的所有问题及处理方式。

#### 修改：`README.md`

- 指标表改为实测数据（含具体数字对比），避免"应该准确"这类无法验证的表述。
- Windows 配置示例改为实测可用的版本，并标注两个必踩的坑（npipe、盘符）。
- 已知限制首条改为 Windows 容器化的指标局限。

#### 修改：`docs/static/01-architecture.md`

在部署形态图后加「实测修正」引用块，说明 Windows 下 `/proc` 与 GPU 两个例外，
并明确容器化部署在 Windows 上的定位是"容器入口 + 磁盘 + tailnet"。

### 本次实测确认的行为（非缺陷）

| 现象 | 判定 | 说明 |
| --- | --- | --- |
| 容器墙里出现 `homepage-portal` 自身 | ✅ 正确 | 它就是本机的一个容器，且 `0.0.0.0:8899` 绑定，因此判为 tailnet 可达 |
| 从 `localhost` 访问时入口显示 `http://localhost:3000/` | ✅ 正确 | URL 按**访问者视角**生成 |
| 从 `100.72.255.29` 访问时同一容器显示 `http://100.72.255.29:3000/` | ✅ 正确 | 同一份缓存服务不同访问者，这是两层 URL 生成设计的预期效果 |
| 磁盘显示 952 GB | ✅ 正确 | Docker Desktop 的 `statfs` 能读到 Windows 真实分区容量 |
| GPU 报不可用 | ✅ 正确 | 容器内看不到 `/usr/lib/wsl/lib`；不应伪造数字 |
| tailnet 报"未配置 API Token" | ✅ 正确 | 给出了明确指引而非静默失败 |

### 验证方式

```bash
docker compose up -d --build                  # 构建 + 启动，首次即成功
docker compose ps                             # Up (healthy)
curl http://127.0.0.1:8899/api/health         # 五个数据源状态符合预期
# 经 tailnet IP 访问并逐项核对容器/磁盘/工具数据
docker run --rm -v /proc:/host/proc:ro alpine:3.20 \
  sh -c "grep -c ^processor /host/proc/cpuinfo"   # → 4，证实与 os.cpus() 同源
```

### 剩余待办（已记入 todo.md）

- arm64（NAS）镜像构建实测
- 若确实需要 Windows 宿主真实硬件指标，考虑增加"原生运行"的部署文档与启动脚本

---

### 部署后的第一轮回归修复

首次部署跑通后立刻暴露了 3 个只有真跑才会发现的问题，已全部修复并重新验证。

#### 缺陷 15：工具探测在容器内选错了目标主机（**功能性 bug**）

- **现象**：8 个工具全部报"不可用"，但 DSH 实际正在 `3080` 监听。
- **根因**：探测用的是"门户的对外主机名"，从 `localhost` 访问门户时那就是 `localhost`
  —— 而容器内的 `localhost` 指向**容器自己**，不是宿主。
  实测确认：容器内 `127.0.0.1:3080` 与 `100.72.255.29:3080` 都不可达，
  只有 `host.docker.internal:3080` 可达。
- **修复**：
  - `probeTool` 改为**目标链**：首选主机 → `host.docker.internal` → `127.0.0.1`，任一成功即判 `up`
  - 新增 `defaultFallbackHosts()`；命中兜底时 `detail` 明确说明"经 xxx 探测"
  - `ToolStatusView` 新增 `target: { host, port }`，前端工具卡显示「探测目标 xxx」徽标
  - 新增环境变量 `PORTAL_TOOLS_PROBE_HOST` 供特殊拓扑强制指定
  - `docker-compose.yml` 增加 `extra_hosts: host.docker.internal:host-gateway`
    （Docker Desktop 自带该域名，Linux/NAS 需要这行）
- **验证**：修复后 DSH 正确显示 `up`（4ms，经 `host.docker.internal`），
  其余 7 个仍为 `down` 且原因为"连接被拒绝（端口未监听）"—— 与宿主实际监听状态一致。

#### 缺陷 16：磁盘文件系统类型显示为原始魔数

- **现象**：磁盘卡片 `fsType` 显示 `0x1021997`。
- **根因**：`describeFsType` 的已知魔数表未包含 WSL2/DrvFs 的 `9p`。
- **修复**：补齐常见魔数（`9p`/`virtiofs`/`overlayfs`/`fuse`/`sysfs`/`proc`/`devpts` 等）。
- **验证**：现显示 `fsType=9p`，与容器内 `df -T` 的实际输出一致。
  已加单测断言。

#### 缺陷 17：`docker-compose.yml` 磁盘盘符写法导致挂载失败

- **现象**：`docker compose config` 显示 source 为 `D:\桌面\sisi_apps\HomePage\C:`。
- **根因**：`C:` 在 compose 变量替换后被当成**相对路径**。
- **修复**：改为硬编码且带引号的 `"C:/:/host/disk/C:ro"`，并在注释里写明原因。
- **验证**：`docker compose config` 现在解析为 `C:/`，容器内 `df` 读到真实 952 GB。

### 本轮验证方式

```bash
docker compose up -d --build        # 重建（卷持久化，admin 账号与配置保留）
docker compose ps                   # Up (healthy)
curl /api/auth/login                # 登录成功（证明数据卷持久化生效）
curl /api/system/snapshot           # disk C: 618.9/952 GB = 65%, fsType=9p
curl /api/tools                     # dsh=up(4ms, host.docker.internal)，其余 7 个 down 且原因正确
curl /api/overview                  # warnings 仅剩 tailscale(未配 Token) 与 GPU(容器内不可用) 两条预期项
```

`typecheck` 两个 workspace 均 0 error，129 个测试用例通过。

---

## [2026-10-16] 管理员可在界面内修改运行时配置（免重建容器）

### 背景

用户反馈：为了填一个 Tailscale API Token 就要改 `.env` 再重建容器，太繁琐，
NAS 上更麻烦。要求把这类配置操作搬到界面里，管理员账号可直接修改。

### 方案与边界

采用 **数据库覆盖 > 环境变量 > 内置默认** 的三层优先级：`.env` 部署方式完全不受影响，
界面只覆盖被显式改过的项。同时明确划出**容器架构的硬边界**：

| 级别 | 含义 | 项数 |
| --- | --- | --- |
| `live` | 下次读取即生效 | 17 |
| `reload` | 保存后自动重建对应数据源 | 6 |
| `restart` | **改不了**，需重建容器（界面不给控件，服务端也拒绝写入） | 5 |

磁盘挂载点被明确标注为"半自动"：界面能改"显示哪些、怎么标注"，
但路径本身必须先挂进容器（这是容器创建参数，任何界面都改不了）。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/db/settings.ts` | `SettingsRepository`：settings 表的读写与批量操作 |
| 新增 | `server/src/modules/settings/registry.ts` | 设置定义表、三层解析、校验、`applyTo` 写回 |
| 新增 | `server/src/modules/settings/service.ts` | `SettingsService`：应用编排、视图、更新/重置、连通性测试 |
| 新增 | `server/src/modules/settings/tailscaleProbe.ts` | tailnet 连通性测试（可注入 fetch / 命令执行器） |
| 新增 | `server/src/modules/settings/types.ts` | `TailscaleTestResult` 等契约类型 |
| 新增 | `server/src/api/settings.ts` | `/api/settings/*` 四个 admin 接口 |
| 新增 | `web/src/pages/admin/SettingsPanel.tsx` | 系统设置面板（分组、生效级别、测试连接） |
| 新增 | `server/tests/settings.test.ts` | 27 个单测 |
| 修改 | `server/src/db/database.ts` | 迁移 v2 建 `settings` 表 |
| 修改 | `server/src/config.ts` | 新增 `tools.probeHost`；`docker`/`tools`/`tailscale` 字段改为可写 |
| 修改 | `server/src/modules/tailscale/service.ts` | provider 改为可变 + 新增 `reload()` |
| 修改 | `server/src/modules/docker/provider.ts` | 新增 `bindConfig()` / `reload()`；TTL 等改为每次读 config |
| 修改 | `server/src/modules/docker/service.ts` | 新增 `syncConfig()`（重建 TtlCache） |
| 修改 | `server/src/modules/system/provider.ts` | 新增 `syncConfig()`（重建 HostProcReader、清空 CPU 基线） |
| 修改 | `server/src/modules/system/service.ts` | 转发 `syncConfig()` |
| 修改 | `server/src/util/cache.ts` | 新增 `defaultTtlMs` getter |
| 修改 | `server/src/app.ts` | 装配 `SettingsRepository` / `SettingsService`，注入 `onReload` 热重建钩子 |
| 修改 | `server/src/api/{index,context}.ts` | 注册 `/api/settings` 域；`RouteContext` 增 `settings` |
| 修改 | `server/src/http/schemas.ts` | 新增 `updateSettingsBodySchema` / `resetSettingsBodySchema` / `testTailscaleBodySchema` |
| 修改 | `web/src/api/{types,client}.ts` | 设置相关类型与 5 个客户端方法 |
| 修改 | `web/src/pages/AdminPage.tsx` | 新增「系统设置」标签页 |
| 修改 | `docs/static/{02,03,04,05,06,07,09}.md`、`README.md` | 文档回归 |

### 逐项明细

#### 新增：`server/src/db/settings.ts`

- `SettingsRepository` — `list` / `toMap` / `get` / `upsert` / `upsertMany` / `delete` / `deleteMany` / `deleteAll`。
  **只存被显式覆盖过的键**；值统一以 TEXT 存储（布尔存 `'1'`/`'0'`），
  这样表结构不随配置项增减而迁移。`key` **等于环境变量名**，便于界面直接显示对应变量。

#### 新增：`server/src/modules/settings/registry.ts`

- `buildSettingDefinitions(config)` — 28 项设置的元数据（分组、生效级别、类型、默认值、
  范围、是否敏感、`restart` 原因）。
- `parseSettingValue` / `serializeSettingValue` — 字符串 ↔ 类型化值的双向转换。
- `validateSettingValue(definition, input)` — 逐类型校验，并对
  `DOCKER_ENDPOINT`（地址形式）、`PORTAL_DISK_MOUNTS`（复用 config 的 `=` 语法规则）、
  路径类字段（必须绝对路径）做专门检查。**`restart` 级一律返回不通过**。
- `maskSecret(value)` — 保留 `tskey-api-` 前缀便于确认身份，其余打码。
- `resolveSettings({ config, repository })` — 三层解析，每项返回
  `{ value, source, envValue, databaseValue, updatedAt, updatedBy }`。
- `applyTo(config, map, overriddenKeys)` — 就地改写 `PortalConfig`，返回
  `{ changedKeys, reloadTailscale, reloadDocker, skippedKeys }`。

**为什么 `overriddenKeys` 参数是必需的**（本任务发现并修复的 bug）：
`PORTAL_DISK_MOUNTS` 的默认值是空字符串，而 config 的初值来自 `.env`/平台默认。
最初实现无条件按"解析结果 vs 当前值"比对，导致**未设置该项时把 `.env` 里配好的挂载点清空**。
必须靠 `overriddenKeys` 区分"用户显式清空"与"从未设置"。已加回归测试。

#### 新增：`server/src/modules/settings/service.ts`

- `SettingsService.initialize()` — 启动时应用数据库覆盖值。**必须在任何数据源被使用前调用**。
- `ensureApplied(force?)` — 惰性幂等应用。版本标识为 settings 表的 `条数:最新updatedAt`，
  避免每个请求都跑一次完整 apply。
- `view()` — 组装前端视图（敏感项打码、附来源与生效级别、`editable` 由 effect 推导）。
- `update(input)` — 部分成功语义：合法项写入并**立即应用**，`restart` 级进
  `rejectedRestartKeys`，非法项进 `invalid`；写审计（敏感项只记键名）。
- `reset(keys | null, actor, ip)` — 删除覆盖值（恢复默认）。
- `testTailscale(candidateToken?)` — 连通性测试。

#### 新增：`server/src/modules/settings/tailscaleProbe.ts`

- `effectiveMode(mode, hasToken)` — 复现 `auto` 策略，供测试与 UI 说明。
- `probeTailscale(input)` — CLI 与 API 两条路径。**永不抛异常**，
  按 HTTP 状态给出可操作结论：401 → 重新生成 Token；403 → 检查 ACL；
  404 → tailnet 标识有误；超时 → 检查外网出口。
  `runCommand` 与 `fetchImpl` 可注入，便于单测。

#### 修改：`server/src/app.ts`

装配顺序调整：`SettingsService` 在数据源**之前**构造并 `initialize()`，
`onReload` 钩子在需要时重建 `DockerProvider` / `ContainerService` 缓存 /
`SystemProvider` 的 proc 读取器 / `TailscaleService` 数据源。
这样首次启动就按数据库里的最终配置构造数据源，不会先用旧配置再用新配置。

#### 修改：`server/src/modules/tailscale/service.ts`

- `provider` 由 `readonly` 改为可变私有字段；新增 `reload()`：
  按当前 config 重新 `selectTailscaleProvider`、清空缓存、预热一次。
  **填一个新的 API Token 无需重建容器即可生效**（这正是用户的核心诉求）。

### 配置/接口/数据模型影响

- **DB 迁移**：新增 v2 `runtime_settings`（建 `settings` 表）。老库自动升级，幂等。
- **HTTP 接口**：新增 `GET /api/settings`、`PATCH /api/settings`、
  `POST /api/settings/reset`、`POST /api/settings/test/tailscale`（均限 admin）。
- **环境变量**：新增 `PORTAL_TOOLS_PROBE_HOST`；**语义变化** ——
  Tailscale / Docker / 系统指标 / 工具 / 缓存这五组变量现在可被界面覆盖
  （未覆盖时行为与之前完全一致）。
- **审计动作**：新增 `settings.update` / `settings.reset`。

### 验证方式

```bash
npm test                          # 164 passed (4 files)，新增 27 个设置单测 + 8 个接口集成测试

docker compose up -d --build      # 重建成功，日志显示 "迁移已应用 version 2"
docker compose ps                 # Up (healthy)

# 1) 设置列表：分组与生效级别
GET /api/settings                 # groups=6 组，live 17 / reload 6 / restart 5，可编辑 23/28
# 2) 用错误 Token 测试连接（应给出可操作提示而非报错）
POST /api/settings/test/tailscale {"token":"tskey-api-wrong"}
#   → ok=false，"Token 无效、已过期或被吊销。请重新生成一个 access token…"
# 3) 界面改设置立即生效
PATCH /api/settings {"values":{"PORTAL_TOOLS_PROBE_TIMEOUT_MS":2500,"PORTAL_TOOLS_EXTRA":"immich:Immich:2283","PORTAL_PORT":9999}}
#   → updatedKeys=[PROBE_TIMEOUT, TOOLS_EXTRA]；rejectedRestartKeys=[PORTAL_PORT]；读数 source=database
GET /api/tools?probe=0            # → total=9，出现 immich（验证"立即生效"）
POST /api/settings/reset {"keys":[…]}  # → 恢复默认，total 回到 8
GET /api/users/audit/log          # → settings.update / settings.reset 已记录
```

### 过程中的自伤与修复

用 PowerShell 的 `Get-Content -Raw` + `WriteAllText` 改 `docs/static/02-configuration.md` 时，
PowerShell 5.1 按 ANSI（GBK）解码了 UTF-8 文件，导致**中文全部变成乱码、行结构被破坏**。
已 `git checkout` 恢复该文件，改用文件编辑工具重做，并对**全部文档**加了编码校验
（检查 U+FFFD 与典型 mojibake 特征），确认无残留损坏。

**教训**：改含中文的文本文件一律用文件编辑工具，不要用 PowerShell 文本管道。

### 已知限制 / 后续

1. `sensitive` 项（API Token）在数据库中**明文存储** —— 需要回读去调用外部 API，
   与密码哈希不同。已在 `06-security.md` §7 记录取舍与后续加密方向。
2. 界面暂不支持"工具目录 JSON 内容"的可视化编辑（只能填文件路径）；
   结构化编辑（增删改单条工具）留待后续。
3. 设置的并发写未做冲突检测（两个管理员同时改会后者覆盖）。
   当前单机场景风险可忽略，已记入 todo。
4. `restart` 级项在界面上是只读的，但**没有**提供"一键生成新 compose"之类的能力，
   仍需手工编辑 `docker-compose.yml`。

---

## [2026-10-16] 支持 `tailscale serve` 路由（修复 F1 的判定盲区）

### 背景

用户反馈：HomePage 看不到 `tailscale serve` 暴露的路由，而 TsController 能看到。
用户提供了 serve 路由截图，`/calendar`、`/worldforge`、`/salecapitai`、`/dsh` 等
都不在门户的容器墙里。

### 根因（两层）

1. **判定模型有盲区**：门户只按 Docker 的宿主端口绑定判定可达性。
   但 `tailscale serve` 能把**只绑在宿主 `127.0.0.1` 的服务**以路径形式暴露到 tailnet。
   实测确认这正是用户的场景：
   - `sisi-calendar` 的宿主端口 `443` 绑的是 `127.0.0.1` → 门户判为"仅本机、无入口"
   - 但经 serve 它其实在 `https://host.tailnet.ts.net/calendar` **tailnet 可达**
   - `/dsh → 3081` 更是宿主服务，完全没有对应的已发布容器端口

   也就是说：**只看端口映射会把一整类可达服务判成不可达**，这是功能性缺陷，
   不是显示问题。

2. **`withSocket()` 参数位置错误**（潜在 bug）：`--socket` 是 tailscale 的**全局** flag，
   必须放在子命令**之前**。原实现追加在之后，会报
   `flag provided but not defined: -socket`。
   Windows 用默认 socket 路径所以没暴露；但 **Linux/NAS 上显式配置 socket 是常规做法**，
   这个 bug 会在最终部署目标上直接让 tailnet 查询失效。

### 用户选择的范围

用户明确选择：**只做 Linux/NAS 主线**，Windows 先不管（后续可选让 TsController 暴露接口）。
本实现据此设计 —— Windows 上会如实报告不可用原因，而不是静默为空。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/modules/tailscale/serveProvider.ts` | `ServeProvider` + `parseServeStatus` 等纯函数 |
| 新增 | `server/tests/serve.test.ts` | 15 个单测（含真实 serve 输出的快照） |
| 修改 | `server/src/modules/tailscale/provider.ts` | **修复** `withSocket()` 的参数位置 |
| 修改 | `server/src/modules/docker/types.ts` | `ServeRouteView` / `ServeStatusView`；`ContainerSummary` 增加 `servePaths` / `servedUrl` |
| 修改 | `server/src/modules/docker/service.ts` | 接入 `ServeRoutesProvider`；`buildServeView()` / `attachServePaths()` |
| 修改 | `server/src/app.ts` | 装配 `ServeProvider` 并注入 `ContainerService` |
| 修改 | `web/src/api/types.ts` | 对应类型 |
| 修改 | `web/src/pages/ContainersPage.tsx` | `ServeRoutesCard` + 容器卡 serve 标记与入口 |
| 修改 | `server/tests/modules.test.ts` | 把旧测试里编码了错误顺序的断言改为正确顺序 |
| 修改 | `docs/static/{01,02,03,04,09}.md`、`README.md` | 文档回归 |

### 逐项明细

#### 新增：`server/src/modules/tailscale/serveProvider.ts`

- `parseServeStatus(json, allowHosts)` — 把
  `Web["<host>:<port>"].Handlers["<path>"] = { Proxy }` 展开为**每个路径一条路由**。
  **刻意不按端口合并**：同一端口常挂多个路径（`/`、`/calendar`、`/calendar.ics` 都在 443），
  按端口合并会丢掉路径信息。
- `parseHostPort` / `parseProxyTarget` / `normalizePath` — 解析小工具，
  兼容 IPv6 方括号、缺省端口按协议补全。
- `describeServeFailure(result, bin)` — 把命令失败翻译为可操作原因；成功返回 `null`。
- `ServeProvider` — `cliAvailable` getter 与 `fetchRoutes(allowHosts)`。
  与设备查询分开实现，因为**可用性不一致**（Windows 上设备可走 API，serve 只有 CLI 能读），
  分开才能给出准确原因。

#### 修改：`server/src/modules/docker/service.ts`

新增 `buildServeView()` 与 `attachServePaths()`：

| 处理 | 目的 |
| --- | --- |
| 用 `allowHosts` 限定本机 tailnet 名 | 排除别的节点或历史残留路由 |
| 按目标端口匹配回容器 | 让 UI 显示"这条 serve 指向哪个容器" |
| 计算 `coveredByContainerPort` | 目标端口已作为可达端口展示过时不重复列独立入口，改为在容器卡打标记 |
| 写回 `servePaths` / `servedUrl` | 容器卡展示 serve 标记与首选入口 |

`ServeRoutesProvider` 通过接口注入（而非直接 import），避免 `docker → tailscale` 模块环 ——
与既有的 `HostInfoProvider` 同一手法。

#### 修改：`server/src/modules/tailscale/provider.ts`

`withSocket()` 由**追加**改为**前插**：

```diff
- return [...args, '--socket', socket];
+ return ['--socket', socket, ...args];
```

### 接口影响

`GET /api/containers` 新增 `serve` 字段与 `items[].servePaths` / `items[].servedUrl`。
契约见 `04-api-contract.md` §3。**向后兼容**：只是新增字段。

### 验证方式

```bash
npm test                      # 179 passed (5 files)，新增 15 个 serve 单测

# 单元层面：用实测抓取的真实 serve 输出做快照
#   —— 8 条路由、443 省略端口 / 8443 保留、同端口多路径不合并、
#      主机过滤、无 Proxy 的 Text handler 跳过、非法 key 跳过

# 端到端（在容器内用假 tailscale 二进制喂真实 JSON）
docker compose exec homepage node /tmp/serve-e2e.mjs
# → available=true, routes=8
#   归属匹配与去重判定：
#     /                owner=homepage-portal   covered=true
#     /salecapitai     owner=cs22-web          covered=true
#     /worldforge      owner=worldforge        covered=true
#     /calendar        owner=sisi-calendar     covered=false  ← 独立入口（关键修复）
#     /calendar.ics    owner=sisi-calendar     covered=false
#     /api/addSchedule owner=sisi-calendar     covered=false
#     /dsh             owner=宿主服务            covered=false
#     / (8443)         owner=homepage-portal   covered=true

# Windows 上的预期行为（如实报告而非静默为空）
curl /api/containers | jq .serve
# → available=false, mode=api,
#   detail="serve 配置是节点本地状态，Tailscale REST API 不提供。需要读取 serve 路由请改用 CLI 模式（挂载宿主 tailscale 与 tailscaled.sock）"
```

### 已知限制 / 后续

1. **Windows 容器化下读不到 serve 路由**（用户已确认先不处理）。
   可选方案：让 TsController 暴露一个本地 HTTP 接口，门户作为 host-agent 读取。
   接口设计已预留（`ServeRoutesProvider` 是注入的，换实现即可）。
2. **funnel（公网暴露）与 serve 无法区分**：在 1.102.4 上 `serve status --json` 与
   `funnel status --json` 输出相同，因此 `ServeRoute.funnel` 恒为 `false`。
   如需区分要另行调用 `tailscale funnel status`。
3. serve 的 `Text` handler（静态文案）不生成入口，会被跳过。
4. 未实现 `tailscale serve` 的**写操作**（配置/取消路径）—— 与"只读展示"的产品边界一致。

---

## [2026-10-16] 项目改名为 HomePort（母港）

### 背景与决策

用户要求给项目起名。原命名 `HomePage` 过于通用（`package.json` 的 `homepage-portal`
与全网大量同名仓库无法区分），且没有表达产品实际在做的事。

定名 **HomePort（母港）**，理由：

1. **名副其实**：`port` 双关"端口 / 港口"。F1 的核心逻辑正是**端口可达性判定**
   （宿主端口绑定地址分类、`tailscale serve` 路径级暴露、工具端口探测），
   名字直接指涉产品最核心的能力，而不是硬凹的比喻。
2. **迁移成本最低**：与 `HomePage` 只差一个字母（`Page` → `Port`），老用户不会认不出。
3. **意象自洽**：容器 = 船只，宿主 = 母港，tailnet = 私有海域，符合"只读守望、不入港操舵"的产品边界。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `package.json` | 包名 `homepage-portal` → `homeport`；描述补上中文名"母港" |
| 修改 | `server/package.json` | workspace 名 `@homepage/server` → `@homeport/server` |
| 修改 | `web/package.json` | workspace 名 `@homepage/web` → `@homeport/web` |
| 修改 | `package-lock.json` | 同步 6 处包名（root ×2、两个 link 条目、两个 packages 条目） |
| 修改 | `docker-compose.yml` | 服务/镜像/容器/数据卷四项改名 + 升级迁移说明 |
| 修改 | `web/index.html` | `<title>` |
| 修改 | `web/src/layout/AppShell.tsx` | 侧边栏品牌区、页脚 |
| 修改 | `web/src/pages/LoginPage.tsx` | 登录页标题 |
| 修改 | `server/src/app.ts` | 前端未构建兜底页 `<title>` |
| 修改 | `server/src/modules/tools/probe.ts` | 探测 User-Agent |
| 修改 | `server/tests/modules.test.ts` | 补注释说明"产品名 ≠ 目录名" |
| 修改 | `.env` / `.env.example` | 文件头注释（`.env` 被 gitignore，不入库） |
| 修改 | `README.md` | 标题、取令牌命令、**新增「从旧名 HomePage 升级」节** |
| 修改 | `docs/static/README.md` | 文档定位句 |
| 修改 | `docs/static/01-architecture.md` | 架构图容器名、目录树 workspace 名 |
| 修改 | `docs/static/07-data-model.md` | 数据卷名 + 备份/恢复命令 |
| 修改 | `docs/static/08-operations.md` | 8 处实时运维命令 |
| 修改 | `todo.md` | 新增「品牌与命名」小节、环境备忘同步 |
| 修改 | `node_modules/@homepage/` → `@homeport/` | 构建产物（未纳入 git），见"验证方式" |

### 逐项明细

#### 修改：`package.json`

- `name` — `homepage-portal` → `homeport`。npm 包名不允许大写，故取全小写 `homeport`。
- `description` — 前置 `HomePort（母港）·`，让 `npm view`/仓库首页一眼看到产品名。

#### 修改：`server/package.json` / `web/package.json` / `package-lock.json`

- workspace 名 `@homepage/{server,web}` → `@homeport/{server,web}`。
- **依据**：全仓 grep `@homepage/` 在 `*.ts` 中**零命中** —— 两个 workspace 之间没有互相
  import（前端通过 HTTP 访问后端，不共享包），因此改 scope 不影响任何解析路径，属零风险改动。
- `package-lock.json` 手工同步 6 处（该文件由 npm 生成，未跑 `npm install` 以免触发
  `better-sqlite3` 原生模块重建）。注意 `"  name": "homepage-portal",` 是
  `"      name": ...` 的**子串**，首轮编辑因匹配到 2 处而失败，改为带上一行 `{` 定位才成功。

#### 修改：`docker-compose.yml`

- `services.homepage` → `services.homeport`
- `image: homepage-portal:local` → `homeport:local`
- `container_name: homepage-portal` → `homeport-portal`
- 数据卷 `homepage-data` → `homeport-data`（引用处 + `volumes:` 定义处的 `name:` 同时改）
- 文件头新增**升级迁移区块**：Compose 以服务名标识容器，改名后旧容器不会被接管，
  **且旧容器仍占用 8899 端口会让新容器启动失败**，故明确要求
  `docker compose up -d --build --remove-orphans`。
- 数据卷迁移采用**非破坏性**方案：`docker volume create` + 一次性 alpine 容器 `cp -a`，
  旧卷不删除，可随时回退；也明确写了"不迁移则重新初始化"的替代路径。

#### 修改：`server/src/app.ts`

- 前端产物缺失时的兜底 HTML `<title>HomePage Portal</title>` → `HomePort Portal`。
  该页在前端未构建/未挂载时展示，属用户可见文案。

#### 修改：`server/src/modules/tools/probe.ts`

- 工具可用性探测的 `user-agent` — `homepage-portal-probe/1.0` → `homeport-probe/1.0`。
  行为无变化，仅标识字符串，**不影响探测判定逻辑**。

#### 修改：`server/tests/modules.test.ts`

- `默认配置含有合理默认值` 用例**断言本身未改**（仍匹配 `/HomePage[\\/]web[\\/]dist$/`），
  仅补一行注释说明原因：**产品名是 HomePort，但仓库目录名仍是 `HomePage/`**，
  默认 `webDistDir` 由目录位置推导，故此处继续匹配 `HomePage`。
  不改断言是因为改的是产品名而非磁盘布局 —— 若强行改断言则测试会真的失败。

#### 修改：界面文案（`web/index.html` · `AppShell.tsx` · `LoginPage.tsx`）

- 页面标题 `HomePage · Tailnet 门户` → `HomePort · Tailnet 门户`
- 侧边栏品牌区 `HomePage` → `HomePort`（副标题"Tailnet 控制面板"不变）
- 页脚 `HomePage 门户 · 只读展示…` → `HomePort 门户 · 只读展示…`
- 登录页 `<h1>` `HomePage 门户` → `HomePort 门户`

#### 修改：文档（`README.md` · `docs/static/*` · `todo.md`）

**改写原则 —— 区分"实时操作文档"与"历史记录"**：

- **实时命令全部改**（不改则命令照抄会直接失败）：`README`、`01-architecture`、
  `07-data-model`（备份/恢复）、`08-operations`（取令牌、改密码、删卷、看日志等 8 处）。
- **`09-changelog.md` 既有历史条目一律不动**：那些条目记录的是当时的真实操作与真实输出
  （如 `Container homepage-portal Started`），改动等于篡改历史。本条新记录即分界线。
- **`todo.md` 的 admin 密码值已打码为 `********`**（原本是明文）：它本是已部署账号的事实记录，
  但本任务还要把仓库推送到公开 GitHub，而该明文已进入提交历史 `7f1d92a`，
  故工作区与历史一并清除，详见下方「密钥处理与公开推送」。
- `01-architecture.md` 目录树保留 `HomePage/` 并加注"仓库目录名（产品名为 HomePort，目录名保留历史值）"。
- `README.md` 新增「从旧名 HomePage 升级（改名后必看）」节，含迁移命令与
  "`.env` 不用改"的说明。

### 配置/接口/数据模型影响

- **环境变量：无变化。** 前缀仍是 `PORTAL_*`（`PORTAL_HOST_PORT`、`PORTAL_TAILSCALE_*` …），
  既有 `.env` 无需任何改动 —— 这次只改"名字"，不动配置键。
- **HTTP 接口：无变化**（路径、字段、错误码全部未动）。
- **数据模型：无变化**（表结构、迁移历史未动）。SQLite 文件名仍是 `portal.sqlite`。
- **会话 Cookie：无变化**，仍是 `hp_session`（`hp` 对新名 `HomePort` 同样成立）。
- **容器运行时标识变化（需部署侧配合）**：

  | 项 | 改名前 | 改名后 |
  | --- | --- | --- |
  | compose 服务名 | `homepage` | `homeport` |
  | 镜像名 | `homepage-portal:local` | `homeport:local` |
  | 容器名 | `homepage-portal` | `homeport-portal` |
  | 数据卷名 | `homepage-data` | `homeport-data` |

- **有意保留不改**：环境变量前缀、Cookie 名、DB 文件名、仓库目录 `HomePage/`。

### 验证方式

```bash
npm run typecheck
# → @homeport/server@0.1.0  tsc --noEmit  ✅ 通过
#   @homeport/web@0.1.0     tsc --noEmit  ✅ 通过
#   两个 workspace 均已按新包名解析，说明 package-lock 改名无误

npm test
# → Test Files  5 passed (5)
#   Tests       179 passed (179)   Duration 20.42s
#   （改名前后用例数一致，无新增/失败）

# 旧 workspace 软链悬空确认与修复（node_modules 为构建产物，未纳入 git）：
#   node_modules/@homepage/{server,web} 是改名前的 junction，改名后成为悬空软链
node -e "console.log(require.resolve('@homeport/server/package.json'))"
# → D:\桌面\sisi_apps\HomePage\server\package.json
node -e "console.log(require.resolve('@homeport/web/package.json'))"
# → D:\桌面\sisi_apps\HomePage\web\package.json
```

> `npm test` 在受限沙箱下会因 esbuild 需要 `spawn` 子进程并通过管道读输出而报
> `EPERM`（这是沙箱边界，不是代码问题），需放宽文件沙箱后才可执行。

**容器部署实测**（沙箱放宽到 danger-full-access 后执行，Docker 29.8.0）：

```bash
# 0) 改名前状态：旧容器在跑、只有旧卷
docker ps -a          # → homepage-portal | homepage-portal:local | Up 4 hours (healthy) | 0.0.0.0:8899->8899/tcp
docker volume ls      # → homepage-data（无 homeport-data）

# 1) 先在旧容器继续服务时构建，避免把停机时间耗在编译上
docker compose build
# → naming to docker.io/library/homeport:local done   ✅

# 2) 停旧容器：干净的 SIGTERM 让 SQLite 把 WAL 合并回主库（关键，见下方说明）
docker stop homepage-portal
docker run --rm -u 0 --entrypoint sh -v homepage-data:/from:ro alpine:latest -c "ls -la /from"
# → 停机后只剩 portal.sqlite (61440) + setup-token.txt，
#    运行中的 358KB portal.sqlite-wal / -shm 已消失（已 checkpoint）

# 3) 迁移数据卷（非破坏性，旧卷保留）
docker volume create homeport-data
docker run --rm -u 0 -v homepage-data:/from:ro -v homeport-data:/to alpine:latest sh -c "cp -a /from/. /to/"

# 4) 起新容器并清理孤儿旧容器
docker compose up -d --remove-orphans --wait
# → Container homepage-portal Removed
#   Container homeport-portal Started / Healthy
```

**上线后验证**：

```bash
docker ps --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}'
# → homeport-portal | homeport:local | Up (healthy) | 0.0.0.0:8899->8899/tcp

# 数据迁移是否真的保住账号（本次最关键的一项）
docker compose exec -T homeport node -e "…SELECT … FROM users / sessions / user_preferences…"
# → users: admin(admin), Sisi(admin) 两个账号都在；sessions: 11；prefs: 2
#   ✅ 未触发重新初始化，既有登录态与偏好全部保留

curl.exe -s http://127.0.0.1:8899/api/health
# → status:ok, setupRequired:false,
#   sources: docker/tailscale/system/disk 全 available，gpu 不可用（Windows 容器化预期行为）

(Invoke-WebRequest http://127.0.0.1:8899/).Content
# → <title>HomePort · Tailnet 门户</title>   ✅ 改名已在运行时生效
```

> **为什么必须"先停容器再拷卷"**：拷贝时容器仍在运行，源卷里有 358KB 未 checkpoint 的
> `portal.sqlite-wal`。此时直接 `cp` 会把主库与 WAL 在**不同时刻**的状态混在一起，
> 属于典型的 SQLite 撕裂备份。先 `docker stop` 让 WAL 合并，拷贝才是一致的单文件快照。
> 为压缩停机时间，构建（约 30s+）安排在停机之前完成，实际停机仅数秒。

### 密钥处理与公开推送

### 问题

推送到 `https://github.com/xs-www/HomePort.git`（公开仓库）前的审计发现：

- `.env` **从未被提交**（`git log --all -- .env` 为空），`.gitignore` 已覆盖 `.env`、`data/`、`*.sqlite` ✅
- 文档中所有 `tskey-*` 均为占位符（`xxxxxxxx` / `********`），测试密码为一次性夹具 ✅
- ❌ **`todo.md` 里含已部署门户的真实 admin 明文密码**，且已进入提交历史 `7f1d92a`
  （`git log -S` 命中），**只改工作区不足以阻止泄漏 —— 公开的是历史**

### 处理（经用户确认选择"重写历史清除密码"）

1. 工作区打码：`todo.md` 与本文档中的明文 → `********`。
2. 历史清除：环境无 `git-filter-repo`，改用内置 `git filter-branch` 对全部提交重写
   （仓库当时**无 remote、仅 5 个提交、无人拉取过**，改写 SHA 无外部影响，代价为零）：

   ```bash
   git filter-branch -f --tree-filter \
     "sed -i 's/<原密码>/********/g' todo.md 2>/dev/null || true" -- --all
   ```

3. 清理备份引用并回收对象（**必须做**，否则旧 blob 仍可经 `refs/original/` 读到）：

   ```bash
   git for-each-ref --format='%(refname)' refs/original/ | xargs -n1 git update-ref -d
   git reflog expire --expire=now --all && git gc --prune=now
   ```

4. 验证与推送：

   ```bash
   git log --all -S '<原密码>' --oneline          # → 空
   foreach ($c in git rev-list --all) { git grep -n '<原密码>' $c }   # → 逐个提交穷尽扫描，全空
   git fsck --unreachable                          # → 无不可达提交

   git remote add origin https://github.com/xs-www/HomePort.git
   git push -u origin master
   # → * [new branch] master -> master（远端原为空仓库）

   git fetch origin && git grep -n '<原密码>' origin/master   # → 空（远端复核）
   git rev-parse HEAD origin/master                # → 两者同为 37f27e0
   ```

### 推送结果

| 项 | 值 |
| --- | --- |
| 仓库 | `https://github.com/xs-www/HomePort.git`（推送前为空仓库） |
| 分支 | `master`（沿用既有本地分支名，未改 `main`） |
| 首推提交 | `37f27e0`（重写后的新 SHA） |
| 提交数 / 跟踪文件数 | 6 / 111 |
| 远端复核 | `origin/master` 中无明文密码；`.env` 未被上传（仅 `.env.example`） |

> **踩坑记录**：首次穷尽扫描时仍命中 3 个"旧 SHA" —— 因为当时 `refs/original/` 备份引用还在，
> `git rev-list --all` 依然能走到旧提交。**清理备份引用并 `gc` 之后重扫才为真正的空**。
> 只跑 `-S` 而不清引用会得到"已清除"的错觉。

### 影响与后续

- 历史的提交 SHA 已全部改变（`filter-branch` 的必然结果）；因从未推送，无协作者受影响。
- **建议仍轮换该密码**：它此前以明文存在于本机 git 对象库与磁盘上，
  且本会话中该值曾出现在工具输出里。轮换流程见 `08-operations.md` §5。
- 仓库尚无 `LICENSE` 文件，而 `package.json` 已声明 `"license": "MIT"` ——
  无 LICENSE 文件时默认"保留所有权利"，与声明不一致，建议补一份（已记入 `todo.md`）。

### 已知限制 / 后续

1. **数据卷归属告警（无害但会复现）**：`homeport-data` 由手工 `docker volume create` 建立，
   缺少 Compose 的归属标签，故每次 `docker compose up` 会打印
   `volume "homeport-data" already exists but was not created by Docker Compose`。
   容器挂载与数据一切正常。若要消除告警需重建该卷（重新拷数据），收益不抵风险，故保留；
   **不要**改用 `external: true`，那会让新机器上的首次 `docker compose up` 直接失败。
2. **升级必须两步走，不能只 `up`**：旧容器不移除会继续占用 8899 端口，新容器启动即失败。
3. 仓库目录名仍是 `HomePage/`，未随改名调整 —— 重命名目录会影响本机 `.env`、
   文档中的绝对路径，以及 `modules.test.ts` 中基于目录名的断言，风险大于收益，故有意保留。
4. 若日后要开源对外发布，`HomePort` 与 `Tailscale` 无品牌绑定，但仍建议先做一次同名检索。

---

## [2026-10-16] 远程构建：GitHub Actions 产出 arm64 镜像并推送 GHCR

### 背景与决策

需求："在远程编译一个 docker 镜像"。先做环境勘察，避免猜错方向：

| 勘察项 | 结果 |
| --- | --- |
| 远程 Docker context | 无（只有 `default` 与 `desktop-linux`，均本机） |
| 远程 buildx builder | 无（`default` / `desktop-linux` 两个 docker driver） |
| 已登录 registry | 无（`~/.docker/config.json` 无 `auths`） |
| 仓库 CI | 无 `.github/` |
| 目标机 NAS | `family-nas` / `100.103.230.37` / Linux 6.18.15 / Tailscale 1.104.1；tailnet 直连（ping 294ms），22 与 443 开放，2375/2376 未开放 |

经用户确认的两项决策：

1. **构建载体**：GitHub Actions 构建 → 推 GHCR（NAS 只是部署目标，不适合当构建机；
   且其 Docker API 未暴露，本机也无 SSH 配置）。
2. **目标架构**：只构建 `linux/arm64`。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `.github/workflows/docker-publish.yml` | 在 GitHub runner 上构建 arm64 镜像并推 GHCR |
| 新增 | `.dockerignore` | 缩小构建上下文，并阻止 `.env` 上传到构建器 |
| 修改 | `docs/static/08-operations.md` | 新增 §1.1「用预构建镜像」；§7 升级拆成 A/B 两种方式 |
| 修改 | `todo.md` | arm64 实测项转为已完成；CI 项拆分更新 |

### 逐项明细

#### 新增：`.github/workflows/docker-publish.yml`

- 触发：`push` 到 `master`、`v*` tag，以及 `workflow_dispatch`（便于手动出图/换架构）。
- `concurrency` 按 ref 分组并 `cancel-in-progress`，避免排队堆积。
- `permissions`：`contents: read` + `packages: write`（推 GHCR 必需）。
- 步骤：checkout → setup-qemu → setup-buildx → login(GHCR) → metadata → build-push。
- **镜像名写 `ghcr.io/${{ github.repository_owner }}/homeport`，不写 `${{ github.repository }}`** ——
  后者会展开成 `xs-www/HomePort`，含大写字母，Docker 会直接报
  `repository name must be lowercase` 而构建失败。这是本 workflow 最容易踩的坑。
- **`provenance: false` + `sbom: false`（有意关闭）**：这两项会产出 attestation manifest，
  较老的 Docker（如 NAS 上的 20.10、未启用 containerd 镜像存储）拉取时报
  `no match for platform in manifest`。本镜像的消费方正是这类设备，故关闭。
- `cache-from/to: type=gha`：避免每次都在 QEMU 下重编 `better-sqlite3`。
- 架构由 `env.PLATFORMS` 单点控制，多架构改成 `linux/amd64,linux/arm64` 即可。
- 末尾输出 `$GITHUB_STEP_SUMMARY`，在 Actions 页面直接看到标签与拉取命令。

#### 新增：`.dockerignore`

排除 `node_modules/`、`dist/`、`.env`、`data/`、`docs/`、`.git/` 等。

- **不是为了缩小镜像** —— Dockerfile 只显式 `COPY package.json / server/ / web/`，
  本来就不会把 `.env` 装进镜像。
- 真正的收益有两个：构建上下文从 144 MB（`node_modules`）降到 KB 级；
  以及 `.env` 不再被**上传到构建守护进程**（本地构建上下文里它此前是包含的）。

#### 修改：`docs/static/08-operations.md`

- 新增 §1.1：`docker pull ghcr.io/xs-www/homeport:latest`、compose 改用 `image:`、
  标签含义表、只构建 arm64 的说明、attestation 关闭的原因。
- §7 升级拆成 A) 本机构建（`up -d --build`）与 B) 预构建镜像（`compose pull` + `up -d`）。

### 配置/接口/数据模型影响

- 环境变量、HTTP 接口、数据模型**均无变化**。
- 新增外部产物依赖：`ghcr.io/xs-www/homeport`（公开可匿名拉取）。
- 未改动 `docker-compose.yml` —— 本机部署仍走 `build:`；
  改用镜像的写法记录在文档中，由部署方按需替换。

### 验证方式

```bash
# 1) 本机 arm64 预检（QEMU），先于 CI 排除"架构下编译不过"的风险
docker buildx build --platform linux/arm64 -t homeport:arm64-preflight --load .
# → better-sqlite3 在 QEMU 下从源码编译成功（约 77s），web/server 构建正常，
#   镜像导出成功。此前 todo.md 记录"arm64 尚未实测"，此项已转为实测通过

# 2) 触发 CI 并观察
git push origin master                      # run #1
# → completed / success，耗时 5 分 48 秒，全部步骤（含 Log in / Build and push）通过
# run #2（改 workflow 加 paths-ignore 后）同样 success，且有 gha 缓存后明显更快

# 3) 匿名拉取（验证包可见性，未使用任何凭据）
docker pull ghcr.io/xs-www/homeport:latest
# → 成功。说明 GHCR 包对匿名用户可读，无需在包设置里手动改可见性

# 4) 架构校验（关键：必须是 arm64）
docker image inspect ghcr.io/xs-www/homeport:latest --format '{{.Os}} {{.Architecture}} {{.Size}}'
# → linux arm64 283999337

# 5) 启动冒烟（光"构建成功"不等于"能跑"）
docker run -d --name homeport-ci-smoke -p 18899:8899 ghcr.io/xs-www/homeport:latest
docker ps --filter name=homeport-ci-smoke
# → Up (healthy)   ← 镜像自带 HEALTHCHECK 通过
curl -s http://127.0.0.1:18899/api/health
# → status:ok
#   docker/tailscale/disk/gpu 均 available:false 并给出具体原因
#   （未挂载 socket/tailscale/磁盘所致，属设计内的降级说明，非故障）
(Invoke-WebRequest http://127.0.0.1:18899/).Content
# → <title>HomePort · Tailnet 门户</title>   ✅ CI 产物含改名后的前端
```

### 已知限制 / 后续

1. **CI 只构建镜像，不跑测试**：`typecheck` + `test` 尚未纳入 CI（已记入 `todo.md`）。
2. **只构建 arm64**：在 amd64 机器上需把 `PLATFORMS` 改成
   `linux/amd64,linux/arm64`（或 `linux/amd64`），再手动触发一次 workflow。
3. **NAS 侧部署尚未执行**：本次只验证到"镜像可拉取、可运行"，
   `family-nas` 上的实际部署与 NAS 环境的指标取数边界未实测。
4. `.dockerignore` 排除了 `docs/`，若日后 Dockerfile 需要把文档打进镜像，需同步调整。
5. GHCR 包的标签列表接口需鉴权，故标签核对以本地 `docker pull` 结果为准。

---

## [2026-10-16] 改为多架构构建 + NAS 部署就绪

### 背景：一次架构误判的纠正

上一条记录里"目标架构"被定为 `linux/arm64`（基于当时用户的选择）。随后用户指出：
**目标 NAS 是绿联 DX4600 Pro，CPU 为 x86-64**，因此 arm64-only 镜像无法在 NAS 上原生运行
（会以 `exec format error` 失败）。

结论：原有判断确实有缺陷，改为同时构建 `linux/amd64` 与 `linux/arm64`，
产出 manifest list，让 x86 主机与 ARM 设备拉同一标签各取所需架构。

> **教训**：NAS 的 CPU 架构不能凭"NAS 常见是 arm64"的印象推断 ——
> 群晖/绿联等中高端机型多为 x86-64。部署前应实测 `uname -m` 确认。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `.github/workflows/docker-publish.yml` | `PLATFORMS` → `linux/amd64,linux/arm64`；`paths-ignore` 增加 compose |
| 新增 | `docker-compose.nas.yml` | NAS 专用部署文件（用镜像、API 模式、Linux 宿主挂载） |
| 修改 | `docs/static/08-operations.md` | §1.1 改多架构说明；§3.2 重写为完整的 NAS 部署流程 |
| 修改 | `README.md` | 镜像说明改多架构；已知限制同步 |
| 修改 | `todo.md` | 环境备忘新增「目标部署机（NAS）」表；多架构实测项 |

### 逐项明细

#### 修改：`.github/workflows/docker-publish.yml`

- `PLATFORMS: linux/arm64` → `linux/amd64,linux/arm64`。
- 注释补充关键约束：**多架构 manifest list 本身对老 Docker 没问题，但必须同时保持
  `provenance: false` / `sbom: false`**，否则 attestation manifest 依旧会让较老的
  Docker（如 NAS 上的 20.10）挑不中平台。这个组合陷阱容易只改一半。
- `paths-ignore` 增加 `docker-compose*.yml` —— Dockerfile 不会 `COPY` compose 文件，
  改它们不该触发一次约 10 分钟的多架构重建。

#### 新增：`docker-compose.nas.yml`

面向 NAS 的独立部署文件，与仓库根 `docker-compose.yml` 的差异：

- `image: ghcr.io/xs-www/homeport:latest` 而非 `build:` —— NAS 上不需要 Node 与编译工具链。
- 面向 Linux 宿主：挂 `/proc`（真实 CPU/内存）、挂磁盘卷。
- **tailnet 默认 API 模式**：只需一个只读 Token，不必挂 tailscale 二进制与 socket。
  NAS 上 Tailscale 多为套件/系统包安装，路径与权限差异大，挂载常失败。
- 所有需要按 NAS 实际情况修改的地方都标了 `TODO`。

#### 修改：`docs/static/08-operations.md`

- §1.1 从"只构建 arm64"改为多架构说明，补充 `docker image inspect` 确认架构的命令，
  以及"多架构必须同时关 attestation"的约束。
- §3.2 由一小段 `.env` 示例重写为完整 NAS 部署流程，新增：
  - **部署前必须确认的四项**（`uname -m` / docker GID / `df -h` 存储卷 / tailscale 路径）
    及"发现结果 → 改哪里"的对应表 —— 绿联 UGOS、群晖套件的路径差异无法凭空假定。
  - tailnet **优先 API 模式**的理由与配置。
  - 绿联 DX4600 Pro 是 amd64 的明确提示。
  - 保留传统 `.env` 写法供使用根 compose 的场景。

### 配置/接口/数据模型影响

- 应用侧（环境变量、HTTP 接口、DB）**无变化**。
- CI 产物由单架构镜像变为 manifest list：`latest` 等标签现在指向 index，
  内含 `linux/amd64` 与 `linux/arm64` 两个 manifest。
- 新增 `docker-compose.nas.yml`（不影响本机 `docker compose up` 的行为）。

### 验证方式

```bash
# 1) 多架构构建
git push origin master                      # run #3
# → completed / success，全部步骤通过

# 2) manifest list 是否真的含两个平台
docker buildx imagetools inspect ghcr.io/xs-www/homeport:latest
# → MediaType: application/vnd.oci.image.index.v1+json
#   Platform: linux/amd64
#   Platform: linux/arm64          ✅ 两份都在

# 3) 本机（amd64）拉取是否自动选对架构
docker pull ghcr.io/xs-www/homeport:latest
docker image inspect ghcr.io/xs-www/homeport:latest --format '{{.Os}}/{{.Architecture}} {{.Size}}'
# → linux/amd64 288235170        ✅ 自动匹配，不再需要 QEMU 模拟

# 4) amd64 产物冒烟（与 NAS 将要运行的是同一架构产物）
docker run -d --name homeport-amd64-smoke -p 18899:8899 ghcr.io/xs-www/homeport:latest
docker ps --filter name=homeport-amd64-smoke
# → Up (healthy)
curl -s http://127.0.0.1:18899/api/health      # → status:ok
(Invoke-WebRequest http://127.0.0.1:18899/).Content
# → <title>HomePort · Tailnet 门户</title>   ✅
```

### 已知限制 / 后续

1. **NAS 部署按用户决定暂缓（非技术阻塞）**：本机确实够不到 NAS（无 ssh config、
   2375/2376 未开放），但用户在 2026-10-16 明确选择"暂不部署，先把镜像备好"。
   镜像已多架构就绪并验证可拉取、可运行；`docker-compose.nas.yml` 与四步发现脚本均已交付，
   待要部署时按 `08-operations.md` §3.2 执行即可，无前置条件缺失。
2. `docker-compose.nas.yml` 里的默认路径（`/volume1`、tailscale 路径）是**占位值**，
   必须按发现脚本的实际结果修改；绿联 UGOS 的卷路径可能与群晖不同。
3. 多架构构建耗时明显上升（QEMU 下 arm64 需重编 `better-sqlite3`），
   仅需单架构时应临时把 `PLATFORMS` 收窄。
4. 仍然只构建镜像、不跑测试（`typecheck` / `test` 未纳入 CI）。



