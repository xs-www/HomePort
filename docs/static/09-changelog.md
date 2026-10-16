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

---

## [2026-10-16] S0-05 技术债：拆分 Docker 映射逻辑 + 补「服务入口解析」单测

### 背景

`server/src/modules/docker/service.ts` 已 700 行，其中端口映射与 tailnet 可达性判定等
**纯函数**与「缓存 / 数据源编排」混在一个文件里，导致：

1. 想单测映射逻辑只能从业务服务文件里 import，边界不清；
2. serve 路由的覆盖去重标记（`coveredByContainerPort`）藏在 `ContainerService` 私有方法里，
   无法不起 Docker 就断言 —— 而它决定「同一条入口会不会出现两次」。

本次按 S0-05 拆分，并补齐入口解析的纯函数单测。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/modules/docker/mapper.ts`（430 行） | 「Docker inspect → 门户契约」纯函数层 |
| 修改 | `server/src/modules/docker/service.ts`（700 → 370 行） | 只留缓存/数据源/装配编排；原导出全部 re-export |
| 新增 | `server/tests/dockerMapper.test.ts`（498 行 / 24 用例） | 服务入口解析单测（纯函数，不起 Docker） |
| 修改 | `docs/static/03-server-modules.md` | `docker/` 表新增 `mapper.ts` 行，补分层说明 |
| 修改 | `todo.md` | 技术债勾掉「service.ts 拆分」项，补测试计数 |

### 逐项明细

#### 新增：`server/src/modules/docker/mapper.ts`

分层铁律：只做纯计算 —— 不构造/调用 dockerode（仅 `import type` 引用 inspect 形状）、
不发请求、不读文件、不读全局配置（`PortalConfig` 只经 `PortalHostContext` 传入）。

- `summarize(items)` — 容器墙汇总统计（原样迁移）。
- `cleanName(name)` — 容器名去前导斜杠。
- `mapContainer(inspect, hostContext, tailscaleIps, { skipUrls? })` — 映射为 `ContainerSummary`；
  `skipUrls` 时保留可达性、清空 URL 字段。
- `mapNetworks(inspect)` / `mapMounts(inspect)` — 网络与挂载映射。
- `mapPorts(inspect, hostContext, tailscaleIps, containerName)` — 端口映射 + 可达性判定 + 排序；
  去重由下面的 `dedupeIdenticalBindings` 完成（先收集、去重、再排序）。
- `dedupeIdenticalBindings(entries)` — **独立命名的纯函数**（S0-05 新增去重）：
  去掉「除 `hostIp` 外渲染结果完全一致」的重复绑定，保留先出现的一条。
  判定键 = `protocol` + `containerPort` + `hostPort` + `reachability` + `url` + `note`，
  刻意不含 `hostIp`（它正是双栈重复里唯一不同的字段）；可达性不同的绑定不会被合并。
- `urlForBinding(protocol, hostIp, hostPort, hostContext, reachability)` — 单绑定 URL
  （原为模块私有函数，为可测性导出；`none` / `localhost-only` / 非 tcp 返回 `null`）。
- `rebuildPortUrls(port, hostContext, containerName)` — 从缓存条目按访问者重建 URL
  （原为 `service.ts` 私有函数，现导出）。
- `attachHostContext(items, hostContext)` — 原 `ContainerService` 私有方法，现为纯函数：
  重算 `ports[].url` / `reachability` / `primaryUrl` / `urlCandidates`。
- `pickPrimaryUrl(ports)` / `buildCandidates(ports, hostContext)` — 首选入口与候选入口（按 URL 去重）。
- `detectTailscaleSidecar(inspect)` / `joinCommand(parts)` / `normalizeCommandList(value)` — 原样迁移。
- `collectReachableHostPorts(containers)` — **新抽出的纯函数**：收集已作为 tailnet/lan 端口展示过的
  宿主端口集合（serve 去重的判定依据）。
- `mapServeRoutes(routes, containers)` — **新抽出的纯函数**（原 `ContainerService.buildServeView` 内联逻辑）：
  回填路由所属容器，并标记 `coveredByContainerPort`；**逐字段构造**输出，
  避免 `funnel` / `targetPath` 混进 HTTP 契约。
- `attachServePaths(items, routes)` — 原 `ContainerService` 私有方法，现为纯函数：把 serve 路径写到容器卡上。
- `ServeRouteInput` — serve 路由输入类型（与 `ServeRoutesProvider` 返回条目结构一致）。

#### 修改：`server/src/modules/docker/service.ts`

- 行数 700 → 368；只保留 `ContainerService`（缓存、`list`/`detail`/`logs`/`resolveId`、
  serve 视图装配、stats）、`HostInfoProvider` / `HostContextRequest` / `ServeRoutesProvider` /
  `ContainerServiceDeps` 与 `describeListError`。
- `buildServeView` — 覆盖判定由内联实现改为调用 `mapServeRoutes`（行为不变）。
- `attachHostContext` / `attachServePaths` 私有方法 → 调用 `mapper.ts` 同名纯函数。
- 新增 re-export 块：`summarize` `cleanName` `mapContainer` `mapNetworks` `mapMounts` `mapPorts`
  `pickPrimaryUrl` `buildCandidates` `detectTailscaleSidecar` `joinCommand` `normalizeCommandList`
  （拆分前就从本文件导出）以及新增的 `attachHostContext` `attachServePaths` `mapServeRoutes`
  `collectReachableHostPorts` `rebuildPortUrls` `urlForBinding` `ServeRouteInput`。
  **旧调用方 `import { mapPorts } from './docker/service.js'` 无需改动**
  （`server/tests/modules.test.ts` 即依赖此约定，已加守护用例）。

#### 新增：`server/tests/dockerMapper.test.ts`

24 个纯函数用例，输入形态对齐真实 `docker inspect`：
通配/空 `HostIp` → tailnet；双栈去重（含 `dedupeIdenticalBindings` 的收窄边界：
`127.0.0.1` 与 `0.0.0.0` 绑同端口**不合并**、不同容器端口**不合并**、协议/宿主端口/URL 不同**不合并**）；
`100.x` / `fd7a:…` → tailnet；LAN IP → lan；
`127.0.0.1` / `::1` → localhost-only 且无入口；未发布 / 宿主端口未分配 → 无入口；
排序（可达性优先 + 宿主端口升序）；多候选入口（MagicDNS / tailnet / localhost）；
`skipUrls` 缓存阶段与响应阶段重建；serve 路由覆盖与独立入口、路径回填；
边界（空端口表、非法端口键、`PortBindings` 回退、network mode = host）；`service.ts` re-export 守护。

### 接口/行为影响

- **HTTP 响应契约无变化**：字段、顺序、`serve` 覆盖标记语义、`localhost-only` 判定均保持原样；
  无新增环境变量、无 DB 迁移。
- **唯一的输出变化（有意）**：同一容器端口在宿主上的 `0.0.0.0` 与 `::` 双栈重复绑定现在会去重，
  只保留先出现的一条。实测依据（本机真实输出）：

  ```bash
  docker inspect cs22-web --format '{{json .NetworkSettings.Ports}}'
  # → {"80/tcp":[{"HostIp":"0.0.0.0","HostPort":"8080"},{"HostIp":"::","HostPort":"8080"}]}
  ```

  拆分前去重缺失，容器卡上会出现两条**一模一样**的入口；现在只留一条。前后对比：

  | | 拆分前（HEAD） | 拆分后 |
  | --- | --- | --- |
  | `ports` 条目数 | 2（`0.0.0.0:8080` + `::8080`） | **1**（`0.0.0.0:8080`） |
  | 可点击入口数 | 2 条相同 URL | **1** 条 |
  | `reachability` / `primaryUrl` / `urlCandidates` | tailnet / `http://…:8080/` / 3 个候选 | **完全相同** |

  去重规则刻意收窄到「协议 + 容器端口 + 宿主端口 + 可达性 + URL + 提示」全部相同
  （见 `dedupeIdenticalBindings`），因此不会吞掉任何一条有区分度的绑定：
  `127.0.0.1` 与 `0.0.0.0` 绑同端口（可达性不同）、不同容器端口、不同协议都各自保留。
  与 2.0 计划 S1-02「相同容器的 `::` 与 `0.0.0.0` 映射应去重」一致。

### 验证方式

```bash
npx vitest run --root server tests/dockerMapper.test.ts
# → 24 passed（1 文件）

npx vitest run --root server
# → 265 用例 / 265 passed / 10 文件全绿
#   （拆分完成时 modules.test.ts 的 webDistDir 路径断言曾因本机仓库目录改名 HomePort 而失败，
#    已由主代理改成断言相对结构 —— 绝对路径 + 末段 dist + 父目录名 web —— 本任务未改该文件）

npm run typecheck --workspace server
# → 通过（无输出）

# 行为不变的机器化证据：以 git HEAD 的 service.ts 作旧实现，与 mapper.ts 对比同一批输入
# （14 类 inspect 形态 × 3 种访问者上下文 × 有/无 tailnet 网段 × 是否 skipUrls）
# → 168 次输出比较，差异 24 处，全部集中在 dualStack / real 两个「双栈重复绑定」fixture，
#   其余 12 类形态（含回环、LAN、tailnet IP、UDP、未发布、host 网络、非法键）逐字节一致。
```

### 已知限制 / 后续

1. `mapper.ts` 仍以 `import type { ContainerInspectInfo } from 'dockerode'` 引用阈值类型，
   以便签名与拆分前一致；这是纯类型依赖，不引入运行时耦合。
2. 双栈去重按「容器端口级」生效，尚未做到 S1-02 的「服务级去重」（跨容器的同一服务聚合），
   那属于服务注册表阶段的工作。


## [2026-10-16] S0-03 敏感设置加密存储（AES-256-GCM）

### 背景

`settings` 表里的 Tailscale API Token 原先**以明文落库**（因为要回读去调用外部 API）。
数据库文件（或它的备份）被拷走即等于泄露 Token。底座 `secretBox.ts` 与
`config.secrets` 已由用户写好并通过测试，本次把它接进设置存储：

1. 注册表标 `sensitive` 的键**写库前加密、读出后解密**，服务内部拿到的仍是明文；
2. 非敏感键一律不加密（保持可读，便于排障与人工修库）；
3. **向后兼容**：老库明文照常可读，并在下次写入时自动升级（惰性迁移）；
   首启提供一次性 `reencryptAll()` 兜底升级（含 `previousKeys` 轮换后的老密文）；
4. 解密失败**不崩进程**：该键按「未设置」处理，绝不把解不开的值当有效 Token 用。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/modules/settings/secretStore.ts` | 加解密装饰仓储 + `collectSensitiveKeys()` + `reencryptAll()` |
| 修改 | `server/src/modules/settings/service.ts` | 构造函数新增**可选** `secretBox`；新增 `reencryptAll()`；读写改走装饰仓储 |
| 修改 | `server/src/db/settings.ts` | 新增 `SettingsStore` 接口（`SettingsRepository implements`） |
| 修改 | `server/src/modules/settings/registry.ts` | `ResolveOptions.repository` 改依赖 `SettingsStore` 接口（而非带 `private` 的类） |
| 新增 | `server/tests/settingsCrypto.test.ts`（19 用例） | 落库/读取、惰性迁移、`reencryptAll` 幂等、密钥轮换、解密失败降级、审计日志不泄露 |
| 修改 | `docs/static/02-configuration.md` `06-security.md` `07-data-model.md` `03-server-modules.md` | 主密钥配置、安全模型、数据模型、模块与方法表 |
| 修改 | `todo.md` | F6 勾掉「敏感项加密存储」 |

### 逐项明细

#### 新增：`server/src/modules/settings/secretStore.ts`

- `collectSensitiveKeys(config): Set<string>` — 从 `buildSettingDefinitions()` 里收集
  `sensitive === true` 的键（当前只有 `PORTAL_TAILSCALE_API_TOKEN`）。**加密范围唯一来源**，
  新增加密项只需在注册表打标。
- `SecretSettingsStore implements SettingsStore` — 把加解密收敛到仓储边界，
  避免散落在 `update()` / `resolveSettings()` / `currentVersion()` 多个读点上：
  - `list()` / `toMap()` / `get()` — 敏感项密文 → 明文；
    **解不开的行被剔除**（等价于「未设置」→ 回退环境变量/内置默认）；
  - `upsert()` / `upsertMany()` — 敏感项明文 → 密文后再写库，
    `upsert()` 返回给调用方的仍是明文；`delete*` 原样透传；
  - `reencryptAll(): { upgraded, failed }` — 读**原始行**（`base.list()`，不能走 `this.list()`，
    否则解不开的行被过滤掉就永远修不回来）：
    无 `enc:v1:` 前缀的明文 → 加密；`isCurrentKey()` 为 false 的老密文 → 用 `previousKeys` 解出后
    重新加密；`upgraded` 计数、`failed` 记键名。幂等（全部升级完再调返回 0 且不写库）。
  - `keyFingerprint()` — 透出当前密钥指纹（非密钥），供启动日志与排障。
- **边界规则**：空字符串不加密（没有可保护的内容，且保持「已清空」可读）；
  非敏感键即使值长得像 `enc:v1:…` 也原样读写（不会被误解密）；
  解密失败只告警一次/键（`warnedKeys`），日志只带键名与固定原因文案。

#### 修改：`server/src/modules/settings/service.ts`

- `SettingsServiceDeps.secretBox?: SecretBox` — **可选**。不传 = 完全保持明文行为，
  现有 `tests/settings.test.ts`（27 用例）与无密钥场景不受影响。
- 构造函数 — 传了 `secretBox` 时用 `SecretSettingsStore` 包住 `deps.repository`，
  字段 `repository: SettingsStore`；未传则直接引用原仓储。
- `reencryptAll(): Promise<number>` — 委托给 `secretStore`，返回升级条数；
  有升级时记一条 `info`（条数 + 密钥指纹），有失败键时记一条 `warn`（仅键名）。
  未启用加密时返回 0（安全空操作）。
- `ensureApplied()` / `view()` / `update()`（`upsertMany`）/ `reset()` / `currentVersion()`
  — 全部由 `this.deps.repository` 改为 `this.repository`，即**读写都经过加解密层**。
  审计逻辑不变：敏感项仍写 `键=***`。

#### 修改：`server/src/db/settings.ts`

- 新增 `SettingsStore` 接口（`list` / `toMap` / `get` / `upsert` / `upsertMany` / `delete` /
  `deleteMany` / `deleteAll`），`SettingsRepository implements SettingsStore`。
  **原因**：TS 里带 `private` 成员的类是名义类型，装饰器无法被当作 `SettingsRepository` 传递；
  抽成接口后 `resolveSettings()` 可以直接吃「已解密」的数据，且旧调用方零改动。

#### 修改：`server/src/modules/settings/registry.ts`

- `ResolveOptions.repository: SettingsRepository` → `SettingsStore`（仅类型与注释，行为不变）。

#### 新增：`server/tests/settingsCrypto.test.ts`

19 个用例（直接查 `settings` 表的**原始字符串**做断言）：
密文落库且不含明文片段 + 服务读出明文并写回 `config.tailscale.apiToken`；
视图仍打码且 JSON 无明文；随机 IV（两次写入密文不同）；
非敏感键（数字/字符串/像密文的字符串）保持明文；
旧明文可读 + 下次写入惰性升级 + `reencryptAll()` 数量正确且幂等；
`previousKeys` 轮换后可读并升级到新密钥、只用新密钥也能解开；
错密钥 / GCM 篡改 → 降级为未设置、其它键与进程不受影响；重新填写即恢复；
审计只记 `键=***` 且日志/审计都不含明文与密文；不传 `secretBox` 时明文行为；
装饰仓储直测（多键计数、解不开的行被剔除且 `reencryptAll` 记为失败并不覆盖原值）。

### 配置/接口/数据模型影响

- **无新增环境变量**（`PORTAL_SECRET_KEY` / `PORTAL_SECRET_KEY_FILE` /
  `PORTAL_SECRET_KEY_PREVIOUS` 与 `config.secrets` 已存在）；**无 DB 迁移**。
- `settings.value` 对 `sensitive` 键改为存 `enc:v1:<base64(iv|tag|cipher)>`；
  无前缀 = 旧明文，仍可读。
- HTTP 契约不变：视图里的敏感项仍是打码值，写入 `********` / 空串仍表示「不修改」。
- **装配方接线点**（`app.ts` 本次未改，由用户接）：
  `loadOrCreateKey()` → `createSecretBox({ key, previousKeys: config.secrets.previousKeys.map(parseKey) })`
  → 传 `secretBox` 给 `SettingsService` → 启动时 `await settings.reencryptAll()`（在 `initialize()` 前后皆可，
  建议紧邻 `initialize()`）→ `await settings.initialize()`。

### 验证方式

```bash
npx vitest run --root server tests/settingsCrypto.test.ts
# → 19 passed（1 文件）

npx vitest run --root server
# → 263 passed（10 文件，含并行任务的用例）
#   注：本次验证期间 tests/modules.test.ts 的 HomePage 路径断言被并行任务改为
#   目录名无关的写法，该既有失败已消失

npx vitest run --root server tests/settings.test.ts
# → 27 passed（不传 secretBox 的既有场景）

npm run typecheck --workspace server
# → 通过（无输出）
```

### 已知限制 / 后续

1. `secret.key` 默认与数据库同卷：防「数据库文件单独泄露」，**不防主机失陷**；
   需要更强隔离请显式设 `PORTAL_SECRET_KEY` 并把密钥与数据卷分开存放。
2. 主密钥丢失后已加密值不可逆（界面显示未设置，重填即恢复）——
   备份数据卷时须一并备份密钥文件。
3. 明文值若恰好以 `enc:v1:` 开头会被误判为密文（解密失败 → 视为未设置）。
   实际 Token 不会长这样，未做额外转义。
4. 解密失败回退到**环境变量**（若该键配了 `.env`）——这是三层优先级的既有语义，
   并非"脏值被启用"；测试里已清空相关环境变量以保证断言确定性。
5. 后续用户 TOTP 种子可复用同一 `SecretSettingsStore`/`createSecretBox`（`secretBox.ts` 已预留用途）。

---

## [2026-10-16] S0-03 前端：两步验证（TOTP）登录与自助管理

### 背景

S0-03 要求在管理登录上增加可选的两步验证（含恢复码、丢失设备流程、管理员强制重置）。
后端接口契约已冻结（`POST /api/auth/login` 的 `totpRequired` 分支、`POST /api/auth/login/totp`、
`POST /api/users/me/totp/*`、`POST /api/users/:id/totp/reset`），本次交付**前端**：
登录第二步、自助绑定/关闭/恢复码、管理员强制重置，以及配套组件测试。
验收方式：`npm run typecheck --workspace web`、`npm run test:web`、`npm run build:web`
（后端可能尚未运行，因此不联调，以类型检查 + 单测 + 构建为准）。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `web/src/api/types.ts` | 新增 TOTP 请求/响应类型与 `LoginResponse` 判别联合；`SessionUser` 加 `totpEnabled` |
| 修改 | `web/src/api/client.ts` | 新增 `loginTotp` / `totpSetup` / `totpEnable` / `totpDisable` / `totpRegenerateRecoveryCodes` / `resetUserTotp`；修正 401 语义 |
| 修改 | `web/src/auth/AuthProvider.tsx` | `login()` 返回判别联合；新增 `completeTotpLogin()`；抽出 `establishSession()` |
| 修改 | `web/src/pages/LoginPage.tsx` | 两步登录界面 + 完整无障碍写法 |
| 修改 | `web/src/pages/admin/SecurityTab.tsx` | 新增「两步验证（TOTP）」区块（绑定 / 一次性恢复码 / 重新生成 / 关闭） |
| 修改 | `web/src/pages/admin/UsersTab.tsx` | `totpEnabled` 徽标 + 「重置两步验证」（二次确认，展示吊销会话数） |
| 新增 | `web/tests/totp.test.tsx`（14 用例） | 两步登录切换、`TOTP_INVALID`、`TOTP_CHALLENGE_EXPIRED`、一次性恢复码、强制重置、接口契约与 401 语义 |
| 修改 | `docs/static/04-api-contract.md` | 补 `login/totp`、`users/me/totp/*`、`users/:id/totp/reset`、新错误码与权限矩阵 |
| 修改 | `docs/static/05-web-modules.md` | 补类型/客户端方法/AuthProvider 两步登录/页面说明/测试清单 |
| 修改 | `docs/static/06-security.md` | 新增「两步验证（TOTP）」小节，改写残余风险第 1 条 |
| 修改 | `docs/static/09-changelog.md` | 本节 |

未新增任何 npm 依赖；`web/vitest.config.ts` 与既有测试文件均未改动。

### 逐项明细

#### `web/src/api/types.ts`

- `SessionUser` 新增 `totpEnabled: boolean`（契约要求）与可选 `totpConfirmedAt?: string | null`
  （后端 `User` 已带该字段，用于显示"启用时间"；契约未承诺，故可选、缺失显示 `—`）。
- 登录响应拆成 `LoginSuccessResponse`（会话成功）与 `LoginTotpChallengeResponse`
  （`totpRequired: true` + `challengeToken` + `expiresAt`，**不设 Cookie**），
  联合为 `LoginResponse`；导出类型守卫 `isTotpChallenge()` 供 UI 分支。
- 新增 `LoginTotpRequest`（`code` 兼容 6 位码与 `XXXX-XXXX` 恢复码）、`TotpSetupResponse`、
  `TotpEnableRequest/Response`、`TotpDisableRequest/Response`、
  `TotpRecoveryCodesRequest`、`RecoveryCodesResponse`、`TotpResetResponse`。

#### `web/src/api/client.ts`

- `loginTotp()` 走 `/auth/login/totp`：与 `login` 同样在**建立会话之前**调用，
  因此 `skipUnauthorizedHandler: true`、不假设已有 CSRF 令牌。
- 自助方法 `totpSetup()` / `totpEnable()` / `totpDisable()` / `totpRegenerateRecoveryCodes()`
  与管理员 `resetUserTotp(id)`：路径、方法、请求体严格对齐冻结契约；变更类请求自动带 CSRF。
- **既有实现的一处真实缺陷（本次最小化修正）**：`request()` 原先对**任何** 401 都触发
  `onUnauthorized`。TOTP 的 `TOTP_INVALID` / `TOTP_CHALLENGE_EXPIRED` 与关闭两步验证时的
  密码错误都是 401，于是"输错一次验证码"会被当成"会话失效"而强制登出。
  改为新增 `CREDENTIAL_FAILURE_CODES = { TOTP_INVALID, TOTP_CHALLENGE_EXPIRED, INVALID_CREDENTIALS }`，
  这些码的 401 不触发全局登出回调；真正的会话失效仍是 `UNAUTHORIZED`，行为不变。

#### `web/src/auth/AuthProvider.tsx`

- `login()` 返回 `LoginOutcome = { status: 'ok' } | { status: 'totp'; challengeToken; expiresAt }`。
- 新增 `completeTotpLogin({ challengeToken, code, remember })`，成功后走同一条
  `establishSession()`（写 CSRF、`user`、偏好）。
- **不持久化 `challengeToken`**：只经返回值交给登录页，由组件状态持有，刷新即失效。
- `bootstrap()` 仍直接登录；若意外收到 `totp` 分支则抛错（不假装登录成功）。

#### `web/src/pages/LoginPage.tsx`

- 第一步沿用原表单；收到 `totp` 后切第二步：标题「两步验证」、验证码输入
  （`inputMode="numeric"`、`autoComplete="one-time-code"`、`maxLength=9`）、
  "使用恢复码"提示、「返回上一步」、本次验证失效时间。
- `TOTP_INVALID` → 就地 `role="alert"` 提示"验证码不正确，请重试"并**保留输入**；
  `TOTP_CHALLENGE_EXPIRED` → 清挑战与密码、保留用户名，退回第一步并用 `role="status"`
  提示"验证已过期，请重新登录"。
- 无障碍：`<label htmlFor>`、`aria-invalid`、`aria-describedby`（指向 `totp-code-error`）、
  提交中 `disabled`、验证码不足 6 位禁用提交。

#### `web/src/pages/admin/SecurityTab.tsx`

- 新增 `TotpSection`（置于标签页顶部，跨两列）：未启用时「启用两步验证」→ `setup` →
  展示 `secret`（可选中复制 + 复制按钮）与 `otpauthUri`，说明"手动输入密钥或粘贴 otpauth 链接"，
  再输入 6 位码 → `enable` → **一次性恢复码弹窗**（等宽逐条、警告"只显示这一次，请立即保存"、
  复制全部、必须勾选"我已保存恢复码"才能关闭）。
- 已启用时显示状态与"启用时间"，提供「重新生成恢复码」（需当前动态码）与
  「关闭两步验证」（需密码 **+ 当前验证码或恢复码**，后端 `fieldErrors` 就地显示）。
- `setup` 重复调用要二次确认，并提示"会使上一次未确认的种子立即失效"。
- 刻意**不引入二维码库**（不加依赖）：密钥文本 + otpauth 链接即可，文案里也这么说。
- 绑定/关闭成功后 `refresh()` 同步 `user.totpEnabled`。

#### `web/src/pages/admin/UsersTab.tsx`

- 对 `totpEnabled` 用户显示 `两步验证已启用` 徽标。
- 「重置两步验证」按钮：`window.confirm` 明确"清除绑定 + 吊销全部会话 → 用户会掉线、
  需重新登录并重新绑定"，成功后提示带 `revokedSessions` 的文案并刷新列表。
- `act()` 的 `successMessage` 参数扩展为 `string | ((result: T) => string)`（原本只能是字符串，
  无法把响应里的 `revokedSessions` 写进提示），既有调用点不受影响。

#### `web/tests/totp.test.tsx`（新增，14 用例）

沿用 `client.test.ts` 的假 fetch 写法（`vi.stubGlobal('fetch', …)`、按精确 URL 分发、
未定义路由返回 500 + 明确文案），RTL + jsdom，表单提交用 `fireEvent.submit(form)`：

1. 两步登录切换（含 `inputMode`/`autoComplete`/`maxLength`、label 关联、恢复码文案）；
2. `challengeToken` 不写入 localStorage/sessionStorage；
3. 第二步请求体为 `{ challengeToken, code, remember }`（`code` 已 trim）；
4. 验证码不足 6 位禁用提交；
5. `TOTP_INVALID` 就地报错 + 保留输入 + `aria-invalid`/`aria-describedby`；
6. `TOTP_CHALLENGE_EXPIRED` 退回第一步（用户名保留、密码清空）+ `role="status"`；
7. 启用流程：`setup` 展示密钥/otpauth → `enable` → 一次性恢复码弹窗（等宽、逐条）→
   未勾选不能关闭 → 关闭后切到"已启用"视图；
8. 管理员强制重置：徽标、二次确认文案（含"掉线/重新绑定"）、提示带吊销会话数、刷新列表；
9. `ApiClient` 层的 TOTP 接口契约与 401 语义（凭据类 401 不触发全局登出、
   `UNAUTHORIZED` 仍触发、CSRF 头、`fieldErrors` 可读）。

### 验证

```bash
npm run typecheck --workspace web   # 通过
npm run test:web                    # 4 个文件 / 106 用例全部通过（新增 14）
npm run build:web                   # 构建成功（dist/assets/index-*.js ≈ 382 kB）
```

### 已知限制 / 与冻结契约的差异

1. **关闭两步验证的密码错误返回码**：契约写 `401 INVALID_CREDENTIALS`，
   实际后端（`badRequest()`）返回 `400 VALIDATION_FAILED` + `fieldErrors.password`；
   界面两种都能正确提示（`useSubmit` 同时读 `message` 与 `fieldErrors`）。
   若要对齐契约需改后端。
2. **`POST /api/users/me/totp/disable` 的 `code` 实际上是必填**（已启用时），
   契约标为可选；界面据此把它标成必填并给出 `XXXX-XXXX` 输入位（`maxLength=9`）。
3. 契约只承诺 `user.totpEnabled`；界面"启用时间"依赖 `totpConfirmedAt`（后端已返回）。
   若后端不返回该字段，界面显示 `—`，不影响任何逻辑。
4. 登录第二步的尝试次数超限同样返回 `TOTP_CHALLENGE_EXPIRED`（后端文案"尝试次数过多"），
   前端统一显示"验证已过期，请重新登录"。
5. 客户端把 `INVALID_CREDENTIALS` 一并列入"不触发全局登出"的码集合：
   这也顺带修掉了「修改密码时输错当前密码会被踢下线」的既有隐患。


---

## [2026-10-16] Sprint 0 汇总：安全加固 + CI 质量门 + 技术债（S0-01…S0-05）

### 背景

Sprint 0 的目标是"把地基补硬"：安全默认值收紧、把质量门搬进 CI、清掉几处已经影响
可维护性的技术债。任务分解 S0-01…S0-05 的**逐项明细**已分别归档在本文件里
（S0-03 敏感设置加密、S0-03 前端 TOTP、S0-05 docker mapper 拆分三条），
因此本条是**汇总索引 + 尚未单独归档的部分**：安全响应头、`trustProxy` 默认收紧、
CI 质量门与 E2E、AdminPage 拆分、web 单测、LICENSE、容器最小权限。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `docs/sprint0-baseline-audit.md` | S0-01 基线审计：源码与 `todo.md` 的过期描述、未完成项、风险分级与只读复现命令 |
| 新增 | `server/src/http/securityHeaders.ts` | 手写安全响应头：固定头 + CSP + HSTS 条件判定 + `/api/*` no-store |
| 新增 | `server/src/modules/settings/secretBox.ts` `secretStore.ts` | AES-256-GCM 加密盒与加密装饰仓储（明细见 S0-03 条目） |
| 新增 | `server/src/modules/auth/totp.ts` `server/src/db/totp.ts` | TOTP 纯函数核心 + 恢复码/挑战仓储（明细见 S0-03 条目） |
| 新增 | `server/src/modules/docker/mapper.ts` | Docker inspect → 门户契约纯函数层（明细见 S0-05 条目） |
| 新增 | `.github/workflows/ci.yml` | 质量门 + E2E 冒烟；PR 与 master push 触发，无 `paths-ignore` |
| 新增 | `playwright.config.ts` `e2e/` | Playwright 配置、E2E 用例与专用服务启动器 |
| 新增 | `docker-compose.socket-proxy.yml` | **可选**的只读 Docker socket 代理覆盖文件 |
| 新增 | `LICENSE` | MIT，Copyright (c) 2026 xs-www |
| 新增 | `web/tests/` `web/vitest.config.ts` | web 工作区单测套件（client / format / components / totp）+ jsdom/RTL 测试环境 |
| 新增 | `web/src/pages/admin/{UsersTab,AuditTab,SecurityTab}.tsx` | 从 `AdminPage.tsx` 拆出的标签页 |
| 修改 | `server/src/config.ts` | `trustProxy` 默认由"信任全部"改为 `loopback`；新增 `securityHeaders`/`secrets`/`totp` 配置段与 `DEFAULT_CSP` |
| 修改 | `server/src/app.ts` | 装配主密钥与 `secretBox`、启动时 `reencryptAll()`、注入 TOTP 仓储、注册安全响应头 |
| 修改 | `server/src/api/system.ts` | SSE 端点手动补安全头（`reply.raw.writeHead` 绕过 `onRequest` 钩子） |
| 修改 | `docker-compose.yml` | `docker.sock` 改 `:ro`、`cap_drop: ALL`、`no-new-privileges:true`、去掉硬编码 Windows 磁盘挂载 |
| 修改 | `.github/workflows/docker-publish.yml` | 新增 `quality` job，`build-and-push` 依赖它 |
| 修改 | `README.md` `todo.md` `docs/static/06-security.md` `08-operations.md` 等 | 同步归档（README 的测试数量改为范围描述） |

### 逐项明细

#### 安全：新增 `server/src/http/securityHeaders.ts`

- `STATIC_SECURITY_HEADERS` — 与请求无关的固定头（冻结常量）：
  `x-content-type-options: nosniff`、`x-frame-options: DENY`、`referrer-policy: no-referrer`、
  `cross-origin-opener-policy: same-origin`、`cross-origin-resource-policy: same-origin`、
  `x-permitted-cross-domain-policies: none`、以及把设备能力全关的 `permissions-policy`。
- `securityHeadersFor(config, protocol): Record<string, string>` — 纯函数。
  总开关关掉即返回 `{}`；HSTS 仅在 `config.hsts && protocol === 'https' && hstsMaxAge > 0`
  三者同时成立时加入，且**不带** `includeSubDomains` / `preload`。
- `registerSecurityHeaders(app, config, logger)` — 注册 `onRequest` 钩子：
  逐头下发（已存在同名头时**不覆盖**，用 `reply.hasHeader` 判定）；
  `request.url` 以 `/api/` 开头时补 `cache-control: no-store`；开关关闭时打一条 `warn`。
- `SecurityHeaderConfig` — `{ enabled, csp, hsts, hstsMaxAge }`。

**为什么手写而不用 `@fastify/helmet`**：

1. 门户只需要"六个固定头 + 一个可配 CSP"，引插件换来的是它的一整套默认值
   （`coep` / `origin-agent-cluster` 等对本场景没有收益），却要逐个去关 ——
   关错一个就可能让 SSE 或静态资源失效；
2. HSTS 的判定必须与本项目的 `trustProxy` 边界对齐（只在**确为 HTTPS** 时下发），
   自己写才能把"谁说了算"写清楚，而不是依赖插件默认值；
3. 少一个运行时依赖 = 少一份供应链风险，arm64/amd64 多架构构建也不需要额外的安装步骤。

**HSTS 不带 `includeSubDomains` / `preload` 的原因**：宿主是
`family-nas.tail585599.ts.net` 这类 `*.ts.net` **共享域名**，带上 `includeSubDomains`
会波及同域下不属于本门户的其它服务 —— 那不是本门户能替用户做的决定。
`preload` 同理，且一旦进 preload 列表几乎不可撤销。

**踩到的坑（已修）**：SSE 端点 `/api/system/stream` 用 `reply.raw.writeHead()` 直接写原始
响应头，**绕过了 Fastify 的正常发送流程，因此 `onRequest` 钩子里设置的安全头不会自动带上**。
该处理器显式调用一次 `securityHeadersFor(ctx.config.securityHeaders, request.protocol)`
并展开进 head。以后再新增"直接写 raw head"的端点（长连接、文件流）必须照做，
否则会出现"普通接口有头、长连接没头"的隐形缺口。

#### 安全：修改 `server/src/config.ts`（`trustProxy` 默认收紧）

- `DEFAULT_TRUST_PROXY: TrustProxySetting = 'loopback'`（新增导出）。
  默认值从"信任全部"（`true`）改为**只信回环**：标准部署是
  `tailscale serve → 127.0.0.1:8899`，代理连接必然来自回环 ——
  既拿到真实客户端 IP（登录限流键正确），又**忽略** tailnet 直连客户端自带的伪造
  `X-Forwarded-For` / `X-Forwarded-Proto`（后者还会让门户误以为在 HTTPS 后面而误发 `Secure` Cookie）。
- `parseTrustProxy(raw)` — 支持 `0/1`、布尔词、预置名（`loopback` / `linklocal` / `uniquelocal`）
  与 IP/CIDR 列表；**非法值启动即抛错**，不静默退化成"信任所有人"。
- 新增 `DEFAULT_CSP` 与 `securityHeaders` 配置段（`PORTAL_SECURITY_HEADERS` /
  `PORTAL_CSP` / `PORTAL_HSTS` / `PORTAL_HSTS_MAX_AGE`，默认开启、HSTS 开、maxAge = 180 天）；
  `secrets` 与 `totp` 配置段（明细见 S0-03 条目）。

#### 安全：敏感数据加密与两步验证（汇总口径）

逐项明细见本文件的 S0-03 两条。汇总：

- **加密**：`settings` 表标 `sensitive` 的键 **+ 用户 TOTP 种子**统一走 AES-256-GCM，
  密文 `enc:v1:<base64(iv|tag|cipher)>`；主密钥来源优先级
  `PORTAL_SECRET_KEY` → `PORTAL_SECRET_KEY_FILE`（默认 `<dataDir>/secret.key`，0600）→ 自动生成；
  `PORTAL_SECRET_KEY_PREVIOUS`（逗号分隔）用于轮换，启动时 `reencryptAll()` 幂等升级存量明文。
- **两步验证**：密码通过后**不签发会话**，只给 5 分钟挑战令牌（默认 300s，库里只存摘要）；
  挑战最多 5 次尝试；`/api/auth/login` 与 `/api/auth/login/totp` **共用** 10 次/分钟/IP 限流；
  防重放（`users.totp_last_counter`）**只作用于登录路径**，会话内的再次确认
  （关闭两步验证、重新生成恢复码）**不消费**计数器 —— 否则"绑定完立刻退出再登录"
  会在同一个 30 秒窗口里被自己的防重放挡住，属于自伤式安全（**有意的取舍**）；
  恢复码 10 个 `XXXX-XXXX`（字符集剔除易混的 `0 O 1 I L`）、入库仅 sha256 摘要、
  一次性核销、重新生成即作废旧码；验证码用 `timingSafeEqual` 比较、时间窗默认 ±1 周期；
  关闭门槛 = 当前密码（+ 已启用时的一次验证码或恢复码）；
  管理员可强制重置（清绑定 + 删除恢复码 + 吊销该用户全部会话 + 记 `auth.totp_reset`）。
  TOTP 接口挂在 `/api/users/me/*`：`/api/auth/*` 是匿名作用域，没有角色守卫也没有 CSRF 钩子，
  而绑定/关闭是登录后的变更操作，必须同时满足「已登录 + CSRF」两层。

#### CI / 质量：新增 `.github/workflows/ci.yml`

- 触发：`pull_request`、`master` 的 push、`workflow_dispatch`；
  `permissions: contents: read`（**不引用任何 secret**，外部 fork 的 PR 也会跑到）；
  `concurrency` 取消同分支上仍在跑的旧 CI。
- `quality` job：`npm ci` → `npm run typecheck`（server + web）→ `npm test`（server + web）→
  `npm run build` → 校验 `web/dist/index.html` 与 `server/dist/index.js` 存在。
- `e2e` job（`needs: quality`）：`npx playwright install --with-deps chromium` →
  `npm run test:e2e` → 失败时上传 `playwright-report/`。
- **刻意没有 `paths-ignore`**：若 CI 只在代码变动时跑，纯文档 PR 就不产生任何 check，
  而一旦分支保护要求"check 必须通过"，这类 PR 会永久停在 pending。

#### CI / 质量：修改 `.github/workflows/docker-publish.yml`

- 新增 `quality` job（与 `ci.yml` 相同的 typecheck / test / build），并把 `build-and-push`
  改为 `needs: quality` —— **测试不过就没有镜像被推送**。
- 重复而不复用 `ci.yml` 的步骤：两个工作流触发条件不同
  （本文件有 `paths-ignore`），且发布门禁必须**自证**，依赖另一个工作流的结论会引入
  "那个工作流被跳过或改名后门禁静默失效"的风险。`server/tests/ciWorkflow.test.ts` 守卫两边一致。
- 本文件**没有** `pull_request` 触发，因此 fork 的 PR 拿不到 `secrets.GITHUB_TOKEN`
  与 `packages: write`。

#### CI / 质量：新增 `playwright.config.ts` + `e2e/`

- `playwright.config.ts` — 串行（`workers: 1` + `fullyParallel: false`）、
  `reuseExistingServer: false`（绝不复用本机可能在跑的 8899 旧服务）、
  `trace: 'retain-on-failure'`、超时给足（`webServer` 5 分钟 / 单用例 60 秒）、
  默认端口 **8988**（`PORTAL_E2E_PORT` 可覆盖）。
- `e2e/start-server.mjs` — 启动前跑完整 `npm run build`、**每次清空** `.e2e-data`、
  `DOCKER_ENDPOINT` 指向不存在的 socket、`PORTAL_TAILSCALE_MODE=off`、固定测试令牌；
  双向转发退出信号，Windows 上补 3 秒强制终止兜底。
- `e2e/smoke.spec.ts` + `e2e/security-headers.spec.ts` — 覆盖首启初始化（错误令牌被拒 /
  正确令牌创建管理员）、登录登出与受保护路由回跳、Docker 与 tailnet 均不可用时的降级提示
  （不是白屏）、viewer/admin 权限边界、首页安全响应头与"CSP 不阻断门户自身前端产物"。

#### 技术债

- `web/src/pages/AdminPage.tsx` 651 → 82 行：只保留路由级取数、标签页骨架与 props 分发；
  三个标签页各自成文件 —— `web/src/pages/admin/UsersTab.tsx`（用户与权限）、
  `AuditTab.tsx`（审计日志）、`SecurityTab.tsx`（安全与偏好，含 TOTP 区块）；
  `SettingsPanel.tsx` 原已独立。行数下降不是目的，**取数与渲染分离**才是（回调经 props 传入）。
- `server/src/modules/docker/service.ts` 拆出 `mapper.ts`（明细见 S0-05 条目）。
- web 工作区新增单测与 `vitest.config.ts`：`web/tests/client.test.ts`（CSRF 注入、错误转换、
  401 语义）、`format.test.ts`、`components.test.tsx`、`totp.test.tsx`；
  根 `npm test` 现在按顺序跑 server 与 web 两个工作区。
- 根 `LICENSE`（MIT，Copyright (c) 2026 xs-www），与 `package.json` 的 `"license": "MIT"` 对齐
  （此前"声明 MIT 但无 LICENSE 文件"等于保留所有权利，公开仓库尤其明显）。

#### 部署

- `docker-compose.yml`：`docker.sock` 从可写改为 **`:ro`**；新增 `cap_drop: [ALL]` 与
  `security_opt: [no-new-privileges:true]`；**移除**硬编码的 Windows 磁盘挂载
  （默认挂 `C:/` 会让 Linux/NAS 上 `docker compose` 直接起不来），改为注释示例 +
  要求同步 `PORTAL_DISK_MOUNTS`。
- 新增**可选**覆盖文件 `docker-compose.socket-proxy.yml`：

  ```bash
  docker compose -f docker-compose.yml -f docker-compose.socket-proxy.yml up -d --build
  ```

  用 `tecnativa/docker-socket-proxy` 只放行 `CONTAINERS` / `INFO` / `VERSION` / `PING`
  （按 `docker/provider.ts` 实际用到的接口列），写接口（`POST` / `EXEC` / `BUILD` /
  `SECRETS` / `SYSTEM` …）显式关闭；代理不 publish 到宿主端口，门户改连
  `tcp://docker-socket-proxy:2375`。
  **为什么 `:ro` 不够**：`ro` 只是**挂载层面**只读，Docker 的 HTTP API 看不到挂载选项，
  容器内的进程依然能对 socket 发 `POST /containers/{id}/stop` 这类写请求；
  只有在代理层拒绝，才是与门户代码是否有漏洞无关的**结构性**保证。

### 配置/接口/数据模型影响

- **行为变更（部署时需要注意）**：`PORTAL_TRUST_PROXY` 未设置时的语义从"信任全部"
  变为 `loopback`。直连（无反代）部署不受影响；反代部署若代理**不在回环**上需显式配置，
  否则所有请求会被归到同一个限流桶。
- 新增环境变量：`PORTAL_SECURITY_HEADERS`、`PORTAL_CSP`、`PORTAL_HSTS`、
  `PORTAL_HSTS_MAX_AGE`、`PORTAL_SECRET_KEY`、`PORTAL_SECRET_KEY_FILE`、
  `PORTAL_SECRET_KEY_PREVIOUS`、`PORTAL_TOTP_ENABLED`、`PORTAL_TOTP_ISSUER`、
  `PORTAL_TOTP_WINDOW`、`PORTAL_TOTP_CHALLENGE_TTL_SECONDS`（逐项语义见 `02-configuration.md`）。
- DB 迁移 v3 `totp_two_factor`：`users` 增加 `totp_secret` / `totp_enabled` /
  `totp_confirmed_at` / `totp_last_counter`，并新建 `totp_recovery_codes` 与 `totp_challenges`。
- 新增接口：`POST /api/auth/login/totp`、
  `POST /api/users/me/totp/{setup,enable,disable,recovery-codes}`、
  `POST /api/users/:id/totp/reset`（契约见 `04-api-contract.md`）。
- HTTP 响应新增安全响应头（CSP / nosniff / X-Frame-Options / COOP / CORP / Referrer-Policy /
  Permissions-Policy，HTTPS 下加 HSTS）；`/api/*` 新增 `cache-control: no-store`。

### 验证方式

```bash
npm run typecheck      # server + web 两个工作区
npm test               # 单测：先 server 工作区、再 web 工作区（Vitest）
npm run build          # web（vite build）→ server（tsc）
npm run test:e2e       # Playwright 冒烟：首启初始化 → 登录/登出 → 关键页面降级 →
                       # 权限边界 → 安全响应头（默认端口 8988，PORTAL_E2E_PORT 可覆盖）

# 手工核对安全响应头（HTTPS 下应有 hsts，HTTP 直连不应有）
curl -sI http://127.0.0.1:8899/ | grep -iE 'content-security-policy|x-content-type-options|strict-transport-security'
```

CI 上同一组命令由 `.github/workflows/ci.yml` 执行（`quality` + `e2e`）；
`docker-publish.yml` 的 `quality` job 跑同样的 typecheck / test / build，通过后才构建并推送镜像。

本轮实测结果（供后续对照）：

```text
npm run typecheck   → exit 0
npm test            → server 15 文件 / 333 用例 + web 4 文件 / 106 用例 = 439 全绿
npm run build       → web (vite) + server (tsc) 均成功
npm run test:e2e    → 7 passed（2 个 spec）
```

另有两条**升级路径/部署硬化**专项测试：`server/tests/migrationV3.test.ts`
（把库真实退回 v2 再升级，验证管理员/设置/已加密敏感值无损、迁移可重放）与
`server/tests/composeHardening.test.ts`（静态钉住 socket `:ro`、`cap_drop: ALL`、
代理只放行 4 个读接口且写接口全 0）。

### 已知限制 / 未做项

1. **`read_only: true` 根文件系统默认不开**：NAS 上的 Docker/Compose 版本对
   `read_only` + 命名卷 + `group_add` 的组合处理不一致，个别版本会直接起不来，
   而收益小于这个风险。`docker-compose.yml` 里留了注释示例（开启时需给 `/tmp` 挂 tmpfs，
   `/data` 必须保持可写）。
2. **E2E 不是发布前置**：`docker-publish.yml` 的 `build-and-push` 只依赖同文件的 `quality`。
   要让 E2E 也卡住发布，需要在该文件里**也定义 `e2e` job**，并把依赖写成
   `needs: [quality, e2e]` —— `needs` 只能引用同一工作流文件内的 job，不能跨工作流。
3. **`:ro` 的 `docker.sock` 仍不等于最小权限**：只读代理是**可选**覆盖文件，不是默认开启，
   因此"门户进程被攻破即可控制宿主 Docker"这条最大风险默认仍然存在。
4. **两步验证是可选而非强制**：未绑定的账号仍是"密码即可登录"；
   唯一管理员丢失验证器时只能走离线重置（绕过审计，见 `08-operations.md` §5）。
5. **主密钥默认与数据库同卷**：防"数据库文件被单独拷走"，不防主机失陷；
   备份必须把 `secret.key` 与 `portal.sqlite` 一起保存（`08-operations.md` §10）。
6. **CSP 静默无报告**：未接 `report-uri` / `report-to`，策略改严后的违规只能靠界面表现发现；
   默认策略还为 React 的内联 `style` 属性保留了 `style-src 'unsafe-inline'`。
7. **HTTPS 下的 HSTS 与反代绑定**：只有 `X-Forwarded-Proto: https` 被 `trustProxy` 采信时才会下发，
   反代配置不对就会出现"以为开了 HSTS 其实没开"。

---

## [2026-10-16] 修复：tailnet 连通性用例的宿主依赖 + 环境变量边界收紧

### 背景

`npm test` 出现 **332/333**：失败用例 `接口契约 > 测试 tailnet 连通性：无 Token 时给出可操作的提示而非报错`。
排查后发现不是"某台机器的问题"，而是这条用例**从来没有控制住自己的输入**，
于是结论取决于跑测试的机器 —— 属于典型的"能过，但过得毫无意义"。

### 变更概览

| 变更 | 文件 |
| --- | --- |
| 用例不再复用它前面用例写下的 Token（新增 `afterEach` 清理 + 用例内显式钉住模式与 Token） | `server/tests/auth.test.ts` |
| 用例期间清空会影响设置解析的环境变量（结束后恢复），与 `settings.test.ts` 既有约定一致 | `server/tests/auth.test.ts` |
| 连通性探针不再读 `process.env` | `server/src/modules/settings/tailscaleProbe.ts` |
| 环境变量读取点收敛：新增 `config.envVars` 快照与 `config.readEnvVar()`，其余模块不再直接读 | `server/src/config.ts`、`modules/settings/registry.ts`、`modules/tailscale/provider.ts`、`modules/system/provider.ts`、`util/exec.ts` |
| 新增"环境变量边界"用例：扫描源码钉住唯一读取点 + 直接验证探针不看环境变量 | `server/tests/envBoundary.test.ts` |

### 逐项明细

**1. 失败的真实原因（三层叠加）**

这条用例原本的假设是"没配 Token 就应当返回报错提示"，但它既没有清理前一个用例写入的设置，
也没有固定模式，更没有隔离环境变量：

- 前一个用例（`保存设置：敏感项提交占位符不覆盖原值`）把 `PORTAL_TAILSCALE_API_TOKEN`
  写进运行时设置且**不清理** → 后续用例读到它；
- `PORTAL_TAILSCALE_MODE` 未固定，默认 `auto` → 有 Token 走 api、没有则走 cli；
- 于是 `auto + 有 Token` 会**真的访问 `api.tailscale.com`**（网络不可达或 401 时给的是
  完全不同的消息），`auto + 无 Token` 又会**真的执行宿主上的 `tailscale` 命令**——
  本机装了 Tailscale 且已登录时，探针会正常读到十几台设备返回 `ok: true`，用例直接失败。

即：同一条用例在 CI 上走 A 分支、在开发机上走 B 分支，而两条分支的断言完全不同。

**2. 用例改为自证前提**

`api` 模式 + 清空 Token 后再断言，不再依赖宿主机是否装了 Tailscale CLI：

```ts
// 先把环境钉成确定状态：api 模式 + 哪里都没有 Token
PATCH /api/settings   { PORTAL_TAILSCALE_MODE: 'api' }
POST  /api/settings/reset { keys: ['PORTAL_TAILSCALE_API_TOKEN'] }
POST  /api/settings/test/tailscale {}
expect(body.ok).toBe(false)
expect(body.mode).toBe('api')
expect(body.source.detail).toContain('Token')   // 缺 Token，而不是"网络不可达"
expect(body.message).toMatch(/Token|令牌|Keys/i)
```

同时给该文件加上 `beforeEach/afterEach` 的环境变量清理（`MANAGED_ENV`，结束后恢复原值），
并在 `接口契约` 这个 describe 上加了 `afterEach`：把 `PORTAL_TAILSCALE_API_TOKEN`
与 `PORTAL_TAILSCALE_MODE` 复位，避免"写设置的用例"污染后续用例。

**3. 探针不再读 `process.env`**

```ts
// 旧：mode = effectiveMode(input.mode, token !== '' || process.env.PORTAL_TAILSCALE_API_TOKEN !== undefined)
const mode = effectiveMode(input.mode, token !== '');
```

传进来的 `apiToken` 已经是三层优先级（数据库 > 环境变量 > 默认值）解析后的生效值，
环境变量那一层由 `config.ts` 负责；探针再看一眼 `process.env` 只会让结论与生效配置不一致。

**4. 环境变量边界变成可执行约定**

`config.ts` 一直是"唯一读取 `process.env` 的模块"，但此前 `modules/settings/registry.ts`、
`modules/tailscale/provider.ts`、`modules/system/provider.ts`、`util/exec.ts` 都在直接读，
约定实际上已经失效。现在：

- `config.envVars`：进程环境快照（测试可用 `loadConfig({ envVars })` 注入，不必改 `process.env`）；
- `config.readEnvVar(name)`：单个取值（去空白、空串视为未设置），设置注册表展示"环境变量层原值"用它；
- `util/exec.ts` 改为**不传 `env` 即继承父进程环境**（Node 默认行为），连"继承"都不再需要读 `process.env`；
- 本机主机名改用 `os.hostname()`，不再依赖 `process.env.HOSTNAME`。

`envBoundary.test.ts` 扫描 `src/**/*.ts`（去注释）断言除 `config.ts` 外不出现 `process.env`，
并直接验证"宿主环境里有 Token 时 `auto` 模式仍按无 Token 处理、且不发网络请求"。

### 配置 / 接口 / 数据模型影响

- **无**：不改变任何环境变量语义、接口契约与数据库结构。`config.envVars` 是新增的内部字段，
  唯一对外的可观察差异是"探针判定不再受宿主环境变量影响"（这本身就是修复目标）。

### 验证方式

```bash
npm run typecheck                    # exit 0
npm test                             # server 16 文件 / 339 用例 + web 4 文件 / 106 用例 = 445 全绿
npm run build                        # web (vite) + server (tsc) 均成功

# 关键：把宿主机搞成"污染态"也必须全绿（修复前该状态下必失败）
$env:PORTAL_TAILSCALE_API_TOKEN='tskey-api-ambient-pollution'; $env:PORTAL_TAILSCALE_MODE='api'
npx vitest run --root server         # 339 passed
```

### 已知限制 / 后续

1. `auth.test.ts` 里仍有一条用例（`保存设置：敏感项提交占位符不覆盖原值`）依赖真实写入敏感项，
   靠 `afterEach` 复位；若将来新增"写设置"的用例，仍需把键名加进这个复位列表。
2. `envBoundary.test.ts` 的源码扫描按文件判断，无法识别"通过间接包装读环境变量"的写法；
   它拦的是最常见、也最容易发生的直接读取。
3. `settings.test.ts` / `settingsCrypto.test.ts` 仍在用例内直接改 `process.env`（已有
   `MANAGED_ENV` + 保存/恢复）。它们验的正是"环境变量层"，保留这种写法；后续可改用
   `loadConfig({ envVars })` 注入，进一步减少对全局状态的依赖。

---

## [2026-10-16] Sprint 1：服务注册表 + 服务墙 + `Ctrl/Cmd+K` 聚合搜索（S1-01…S1-05）

### 背景与目标

首页此前"看不懂"：门户把**容器**当成入口单位展示，于是"家庭日历"是一个容器 + 一条
`127.0.0.1:36065` 的端口 + 三条 `tailscale serve` 路径，用户得自己拼出"到底该点哪个"。
Sprint 1 在容器之上引入**服务**这一层：把容器与 serve 路由归纳成用户认得的东西，
每个服务给**唯一首选入口**，但**永远保留全部候选**（含不可达），并让"为什么不可达"可解释。

设计契约冻结在 `docs/sprint1-implementation-spec.md`（字段名与行为不改，发现契约有问题先改契约），
索引级实施/升级/验收说明在 `IMPLEMENTATION_REPORT_S1.md`。本条是**逐文件逐符号**的归档：
仓库其它静态文档已在本轮同步（`01` 架构分层、`03` 模块函数表、`04` §6.5/§6.6、
`05` 首页/详情/管理页与组件、`06` SSRF 与图标 CSP、`07` 迁移 v4 三表、`08` §7.1/§10），
这里只**引用**不重复抄录。本轮**没有新增任何运行时依赖**（未引图标库 / react-query /
headlessui，后端未加新包）。

三条贯穿全 Sprint 的纪律（后面每个文件都在服务这三条）：

1. **身份稳定**：服务身份 = `source_type + source_ref`，`source_ref` 里**没有容器 ID**。
   容器重建换 ID 后仍命中同一行 `services`，用户改过的名称/图标/排序/收藏/首选入口全部保留。
2. **自动发现不得覆盖用户配置**：这是 **SQL 结构保证**，不是"开发者记得别覆盖"的纪律
   （见下文 `upsertDiscovered()` 的 `CASE WHEN user_edited = 0`）。
3. **状态诚实**：容器运行 / 入口可达 / 健康检查是**三个独立维度**，永远不合并成"服务挂了"；
   首选入口只从**可达**候选里取，一个都没有就 `entry: null` 并给出原因 —— 界面宁可不给链接，
   也不给一个点了打不开的死链。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `IMPLEMENTATION_REPORT_S1.md` | 索引级实施报告：交付概览、升级/回滚、真实库演练与实机验收记录（升级前必读） |
| 新增 | `docs/sprint1-implementation-spec.md` | Sprint 1 冻结设计契约（数据模型/发现规则/入口优先级/状态语义/API/UI/测试要求） |
| 修改 | `server/src/db/database.ts` | 迁移 **v4 `services_registry`**：纯追加 `services` / `service_bindings` / `service_preferences` 三表 + 三个索引 |
| 新增 | `server/src/db/services.ts` | `ServicesRepository`（服务注册表仓储）+ `slugify`；用户字段保护全在这里 |
| 修改 | `server/src/db/types.ts` | 新增 `ServiceRow` / `ServiceBindingRow` / `ServicePreferenceRow` 与 `Service` / `ServiceBinding` 及映射函数 |
| 新增 | `server/src/modules/services/types.ts` | 服务注册表 **HTTP 契约类型**（`ServiceView` / `ServiceListResponse` / `ServiceDetailResponse` / 搜索与健康响应） |
| 新增 | `server/src/modules/services/registry.ts` | S1-01/S1-02/S1-05 的**纯逻辑**：稳定身份、发现规划、入口优先级与去重、三维状态 |
| 新增 | `server/src/modules/services/service.ts` | `ServiceRegistryService` 编排（发现落库、列表/详情视图、写操作校验与审计、健康探测）+ 可单测辅助函数 |
| 新增 | `server/src/modules/services/healthProbe.ts` | 健康探测的 SSRF 拒绝清单、URL 校验与请求纪律（`validateHealthTarget` / `runHealthProbe`） |
| 新增 | `server/src/api/services.ts` | `registerServiceRoutes`：`/api/services/*`，写操作 handler 内 `assertAdmin` |
| 新增 | `server/src/api/search.ts` | `registerSearchRoutes` + 纯函数 `buildSearchHits`；`GET /api/search` 四类聚合、按角色过滤 |
| 修改 | `server/src/http/schemas.ts` | 新增 7 个 `.strict()` zod schema（服务查询/创建/更新/删除/排序/健康、搜索查询） |
| 修改 | `server/src/api/index.ts` | `PROTECTED_PREFIXES` 增加 `/api/services` 与 `/api/search`（前缀守卫 = 登录 + CSRF） |
| 修改 | `server/src/api/context.ts` | `RouteContext` 增加 `services: ServiceRegistryService` |
| 修改 | `server/src/app.ts` | 装配 `ServicesRepository` 与 `ServiceRegistryService`（**构造期不拉数据**） |
| 新增 | `server/tests/support/serviceFixtures.ts` | 真实拓扑夹具（`realTopology()` / `makeContainer` / `makeServeRoute` / `makePort` …），`servicesDiscovery.test.ts` 的地基 |
| 新增 | `server/tests/servicesDiscovery.test.ts` | 22 用例：稳定身份、serve 归属、入口优先级与去重、三维状态、构造时机、100 服务性能 |
| 新增 | `server/tests/servicesApi.test.ts` | 22 用例：鉴权/CSRF、校验与危险 URL、hidden 过滤、reorder、DELETE 三种语义、健康探测 |
| 新增 | `server/tests/servicesHealthProbe.test.ts` | 17 用例：拒绝清单、注入 fetch 的请求纪律（不跟随跳转/超时/零请求）、探测目标优先级 |
| 新增 | `server/tests/servicesSearch.test.ts` | 12 用例：分组顺序与命中优先级、limit 上限、角色过滤、绝不索引设置/用户/审计 |
| 新增 | `server/tests/migrationV4.test.ts` | 9 用例：v3→v4 无损、幂等、发现后服务行与用户覆盖保留、空发现不删行 |
| 修改 | `server/tests/migrationV3.test.ts` | 回落脚本同时抹掉 v4 三表并删 `version IN (3,4)`；断言改为"迁移链末端"而非硬编码 3 |
| 修改 | `e2e/smoke.spec.ts` | 登录落点断言从总览改为服务墙、总览用例改走 `/overview`；末尾追加 2 条 Sprint 1 用例 |
| 修改 | `web/src/App.tsx` | 路由：`/` = 服务墙、新增 `/overview`（总览原样迁移）、`/services/:id`、`/admin/services`（adminOnly） |
| 修改 | `web/src/layout/AppShell.tsx` | 侧栏新增「服务」「服务管理」两项；挂 `CommandPaletteProvider`；`end` 精确高亮 |
| 修改 | `web/src/api/client.ts` | 新增 9 个方法：`services` / `service` / `createService` / `updateService` / `deleteService` / `reorderServices` / `discoverServices` / `probeServiceHealth` / `search` |
| 修改 | `web/src/api/types.ts` | 服务与搜索契约类型的**逐字段镜像**（含 `ServiceListParams` / `ServiceCreateRequest` / `ServiceUpdateRequest` / `ServiceReorderRequest`） |
| 修改 | `web/src/components/ui.tsx` | `Icon` 新增 `dashboard` 与 `server` 两个内联图形（侧栏用） |
| 新增 | `web/src/components/Modal.tsx` | 可复用模态框：焦点陷阱、`initialFocusRef`、关闭后归还焦点、Esc/遮罩关闭 |
| 新增 | `web/src/components/ServiceIcon.tsx` | 图标白名单 + `https://` 图片渲染 + 未知键兜底 |
| 新增 | `web/src/components/UrlCandidateList.tsx` | 候选入口列表（卡片抽屉与详情页共用），不可达项照列并标注 |
| 新增 | `web/src/components/ServiceCard.tsx` | 服务卡片 + `ServiceStatusBadges`（三个独立状态点）+ `describeSourceType` |
| 新增 | `web/src/components/ServiceForm.tsx` | 新建/编辑表单（E2E 依赖的稳定 `#service-*` id、危险 URL 前端拦截、后端 `fieldErrors` 回填） |
| 新增 | `web/src/components/CommandPalette.tsx` | `Ctrl/Cmd+K` 命令面板（Provider / 面板 / hook），150ms 防抖 + 递增序号竞态保护 |
| 新增 | `web/src/pages/ServicesPage.tsx` | 首页服务墙 + 导出纯函数 `buildServiceGroups` / `discoveryMessages` |
| 新增 | `web/src/pages/ServiceDetailPage.tsx` | `/services/:id`：三个状态点、`status.reasons` 逐条、全部候选、诊断信息 |
| 新增 | `web/src/pages/AdminServicesPage.tsx` | `/admin/services`：排序/收藏/可见性/编辑/新建/删除与隐藏/重置为自动/重新发现/健康探测 |
| 新增 | `web/tests/serviceTestUtils.ts` | web 单测夹具：fetch 桩（`stubFetch` / `callsTo`）、会话桩、`serviceView` / `listResponse` 等 |
| 新增 | `web/tests/services.test.tsx` | 12 用例：卡片与分组、降级提示与空态、viewer 无管理入口、详情页 404 不白屏 |
| 新增 | `web/tests/adminServices.test.tsx` | 6 用例：管理页按钮契约与可见名、排序 payload、重新发现、编辑 Modal 固定 id、可见性/收藏、重置为自动的二次确认 |
| 修改 | `docs/static/09-changelog.md` | **本条归档自身**（只追加，未改动任何历史条目） |
| 新增 | `web/tests/serviceForm.test.tsx` | 9 用例：label/id 契约、危险 scheme 拦截、提交体逐字段符合契约、400 fieldErrors 呈现 |
| 新增 | `web/tests/commandPalette.test.tsx` | 8 用例：Ctrl/Meta+K、Esc 归还焦点、防抖请求、aria-selected、四类 Enter 行为 |
| 修改 | `docs/static/01-architecture.md` | 服务层在数据流中的位置（事实层 / 注册表层 / 派生层）与 F0 能力 |
| 修改 | `docs/static/02-configuration.md` | 明确本轮**无新增环境变量** |
| 修改 | `docs/static/03-server-modules.md` | 服务注册表模块与 `ServicesRepository` 的方法签名表 |
| 修改 | `docs/static/04-api-contract.md` | 新增 §6.5 服务注册表、§6.6 聚合搜索、入口与状态语义表、鉴权矩阵 |
| 修改 | `docs/static/05-web-modules.md` | 首页/详情页/管理页职责与组件导出表（`data-status`、稳定 id 等契约） |
| 修改 | `docs/static/06-security.md` | 出站探测授权边界（SSRF）与残余风险、外部图标 CSP 说明 |
| 修改 | `docs/static/07-data-model.md` | 迁移 v4 三张表逐列说明与"什么不落库"的理由 |
| 修改 | `docs/static/08-operations.md` | §7.1 升级/回滚步骤；**§10 备份改为方案 A（`VACUUM INTO`）+ 方案 B（停容器整卷打包）** |
| 修改 | `README.md` | 能力表新增 F0 服务墙；"只读设计"补充唯一例外（服务配置只写门户自己的库） |
| 修改 | `todo.md` | F0 勾选项（含 WAL 备份修正）+ 三条技术债（Modal 迁移、图标 CSP、NAS 复核） |

> 上表 53 行覆盖 `git status --porcelain` 的**全部 50 个条目**（含本条归档自身
> `docs/static/09-changelog.md`），所以行数比条目数多 3：`server/src/modules/services/`
> 是**一个**目录条目，这里展开为 4 行（`types.ts` / `registry.ts` / `service.ts` / `healthProbe.ts`）；
> 另一个目录条目 `server/tests/support/` 只有 1 个文件（`serviceFixtures.ts`），一行即可；
> 其余条目一行一个。合计 53 个文件 = 53 行。

### 逐项明细

#### 新增：`server/src/modules/services/types.ts`（HTTP 契约）

- `ServiceEntryView` — `{ kind: EntryKind; label: string; url: string; rank: number; accessible: boolean; detail: string | null }`。
  单个入口候选；`accessible=false` 的条目**仍然返回**（诊断要靠它）。
- `ServiceStatusView` — `{ container: ContainerState | null; reachable: boolean | null; health: ServiceHealth; reasons: string[] }`。
  三个维度分开；`container=null` 表示无容器绑定的纯 serve/手工服务，`reachable=null` 表示**数据源不可用（不确定 ≠ 不可达）**。
- `ServiceContainerRef` — `{ id; name; state; image }`，只描述"当前关联的那个容器"，不参与身份。
- `ServiceView` — 服务墙/详情共用的主体：数据库长期事实（`id`/`slug`/`displayName`/`sourceType`/`sourceRef`/
  `visibility`/`sortOrder`/`favorite`/`userEdited`/`healthTarget`/`healthPath`/时间戳）+ 用户配置
  （`preferredUrl`）+ 实时派生（`entry`/`entries`/`entryCount`/`status`/`container`）。
- `ServiceDiscoveryState` — `{ dockerAvailable; serveAvailable; serveDetail; discoveredAt; notes[] }`；
  **降级必须透出**，界面不许"静默为空"。
- `ServiceListResponse` — `{ items; total; categories; discovery; generatedAt }`。
- `ServiceDiagnostics` — `{ containerPorts[]; serveRoutes[]; notes[] }`，详情页"为什么是这个结论"的原始事实。
- `ServiceDetailResponse` — `{ service; candidates（全部候选含不可达）; diagnostics }`。
- `ServiceSearchKind` / `ServiceSearchHit` / `ServiceSearchResponse` — 搜索契约（`kind` 四类、
  `url` 可为 null：设备没有可点击入口）。
- `ServiceHealthView` / `ServiceHealthResponse` — `{ state: 'ok' | 'fail'; statusCode; durationMs; detail; at }`。
- `ServiceDeleteResponse` — `{ ok: true; mode: 'deleted' | 'hidden' | 'reset'; service: ServiceView | null }`。
- 文件头写明**改字段必须同步三处**：本文件、`docs/static/04-api-contract.md`、`web/src/api/types.ts`
  （前端逐字段镜像，不做运行时转换）。

#### 修改：`server/src/db/database.ts`（迁移 v4）

- 新增迁移项 `{ version: 4, name: 'services_registry', up }`，追加在 `MIGRATIONS` 末尾（append-only，无 `down`）。
- **纯追加**：只 `CREATE TABLE` / `CREATE INDEX`，既有表（`users`/`sessions`/`preferences`/`settings`/
  `audit_log`/TOTP 两张表）**一列未改**，升级不改写任何既有行。
- `services`：`id TEXT PRIMARY KEY`、`slug TEXT NOT NULL UNIQUE`、`display_name`、`description`、`icon`、
  `category`、`preferred_url`、`source_type`、`source_ref`、`binding_refs TEXT NOT NULL DEFAULT '[]'`、
  `visibility TEXT NOT NULL DEFAULT 'visible'`、`sort_order INTEGER NOT NULL DEFAULT 100`、
  `favorite INTEGER NOT NULL DEFAULT 0`、`health_target`、`health_path`、
  `user_edited INTEGER NOT NULL DEFAULT 0`、`created_at`/`updated_at`/`updated_by`，
  以及 **`UNIQUE (source_type, source_ref)`** —— 稳定身份在 schema 层就被钉住。
- `service_bindings`：自增主键，`service_id ... REFERENCES services(id) ON DELETE CASCADE`，
  `kind`（`container`/`serve`）、`ref`、`container_id`、`container_name`、`compose_project`、`compose_service`、
  `scheme`/`host`/`port`/`path`/`url`、`reachability`、`accessible`、`rank`、时间戳，
  **`UNIQUE (service_id, kind, ref)`**；索引 `idx_service_bindings_service`。
- `service_preferences`：`key TEXT PRIMARY KEY` / `value TEXT NOT NULL` / `updated_at TEXT NOT NULL`
  （统一 TEXT，避免"加一项偏好就迁移一次"）。
- 索引：`idx_service_bindings_service`、**`idx_services_sort(visibility, sort_order, display_name)`**
  （服务墙的主查询形状）、`idx_services_source(source_type, source_ref)`。
- 文件内注释写明"候选入口、可达性、运行态、健康结果一律实时计算不落库"，以及
  `service_bindings` 只是"上一次发现结果的快照，可丢可重算"。

#### 新增：`server/src/db/services.ts`（S1-01 仓储）

只做存取：**不知道 Docker、不知道 serve、不知道入口优先级**，因此能被迁移测试与 API 测试单独驱动。

- `slugify(value: string): string` — 小写、非字母数字转 `-`、折叠、去首尾、截断 60 字符；
  中文会被剥空，**由调用方兜底**（`slugBaseFor` 用 `sourceRef` 保证不空）。
- `NewServiceInput` / `DiscoveryUpdateInput` / `UserFieldPatch` / `BindingInput` —
  三类写入输入显式分开：`DiscoveryUpdateInput` **在类型里就没有用户字段**
  （`preferredUrl`/`visibility`/`sortOrder`/`favorite`/`health_*` 根本不存在），
  这是"发现不可能改用户配置"的第一层保证。
- `class ServicesRepository`
  - `listAll(): Service[]` — `ORDER BY sort_order ASC, display_name ASC`。
  - `findById(id)` / `findBySource(sourceType, sourceRef)` / `findBySlug(slug)` — 后两者分别是稳定身份查重与 slug 冲突检测。
  - `listBindings(serviceIds?: readonly string[]): ServiceBinding[]` — **单条 SQL** 取回绑定
    （`WHERE service_id IN (...)`），避免 100 个服务时 N+1；传空数组直接返回 `[]` 而不发 SQL。
  - `uniqueSlug(base: string): string` — 规范化后冲突则追加 `-2`、`-3`…（上限 500 次，兜底加时间戳）；
    空基名回退 `'service'`。
  - `insert(input: NewServiceInput): Service` — 写入后**读回**，读不回来直接抛错
    （宁可立刻失败，也不要返回一个"看起来成功"的幽灵行）。
  - `upsertDiscovered(id, input: DiscoveryUpdateInput): void` — **S1-01 的核心**：
    `SET display_name = CASE WHEN user_edited = 0 THEN ? ELSE display_name END`，
    `description`/`icon`/`category` 同理；`binding_refs` 始终更新（它是发现结果的映射，不是用户字段）。
    **SQL 里根本没有写 `preferred_url`/`visibility`/`sort_order`/`favorite`/`health_*` 的赋值** ——
    想误覆盖也写不出来。
  - `updateUserFields(id, patch: UserFieldPatch, updatedBy): Service | null` — **唯一**能改展示属性的入口；
    动态拼 `SET`，**必然追加 `user_edited = 1`**；空 patch 直接返回当前行（不发无意义的 UPDATE）。
  - `clearUserOverrides(id): Service | null` — 管理员显式"重置为自动"：`user_edited = 0`，
    清 `description`/`icon`/`category`/`preferred_url`/`health_*`，`favorite = 0`、`sort_order = 100`；
    **刻意保留 `display_name`**（等下一次发现按 `user_edited = 0` 覆盖，避免出现空名卡片）。
  - `setVisibility(id, visibility, updatedBy)` — 走 `updateUserFields`，因此隐藏动作同样置 `user_edited = 1`
    （"用户决定隐藏"必须活过下一次发现）。
  - `reorder(entries, updatedBy): void` — 单事务批量 UPDATE，**同时置 `user_edited = 1`**
    （排序是用户决定，自动发现不许覆盖）。
  - `delete(id): void` — 事务内**先显式删绑定再删服务**：虽然 `ON DELETE CASCADE` 够用，
    但显式删一次不依赖 `foreign_keys` pragma 的开启状态。
  - `replaceBindings(serviceId, bindings): void` — 单事务 `DELETE` + 批量 `INSERT`，整体替换快照
    （快照永不越攒越脏）。
  - `getPreference(key)` / `setPreference(key, value)` — `ON CONFLICT(key) DO UPDATE` 的 KV 单例偏好。
  - `count(): number` — 计数（测试与摘要用）。

#### 修改：`server/src/db/types.ts`

- 新增 `ServiceSourceType = 'docker' | 'serve' | 'manual'`、`ServiceVisibility = 'visible' | 'hidden'`、
  `ServiceBindingKind = 'container' | 'serve'`。
- 新增 `ServiceRow` / `ServiceBindingRow` / `ServicePreferenceRow`（**snake_case，与列一一对应**）
  与 `Service` / `ServiceBinding`（camelCase，业务层用），两者之间只经过映射函数，不做隐式转换。
- 新增 `normalizeSourceType(value)` / `normalizeVisibility(value)`（非法值回退默认，
  避免旧库里的意外字符串把类型污染到业务层）、`parseBindingRefs(raw)`（JSON 列解析，
  **坏 JSON 退回 `[]` 而不是抛**，防止一行脏数据让整个服务墙 500）。
- 新增 `mapServiceRow` / `mapServiceBindingRow` — 行 → 领域对象，`favorite`/`accessible`/`userEdited`
  在这里从 INTEGER 转 boolean。

#### 新增：`server/src/modules/services/registry.ts`（S1-02 纯逻辑核心）

**不认识数据库、不发任何请求**，因此可以用真实拓扑做夹具逐条断言（不起 Docker、不起 HTTP）。

- `type EntryKind = 'user' | 'serve' | 'tailnet' | 'lan' | 'localhost'`。
- `ENTRY_RANK: Record<EntryKind, number>` — `user: 0`、`serve: 1`、`tailnet: 2`、`lan: 3`、`localhost: 4`。
  这就是验收"日历首选 `/calendar`（rank 1）而不是 `:36065`（rank 3）"的全部依据。
- `ENTRY_LABEL` — UI 文案：用户指定 / Serve HTTPS / Tailnet / 局域网 / 仅本机。
- `interface ServiceEntry` — `{ kind; label; url; rank; accessible; detail }`；`localhost` 恒 `accessible=false`。
- `BUILTIN_ICONS`（26 个键，`as const`）、`type BuiltinIcon`、`isBuiltinIcon(value): value is BuiltinIcon`、
  `FALLBACK_ICON = 'container'`。前端 `ServiceIcon` 必须与这张白名单保持一致（未知键不出现空白方块）。
- `normalizeContainerName(name): string` — 小写 + 剥副本后缀 `([-_]\d+)+$`（`sisi-calendar-1` → `sisi-calendar`）。
- `containerServiceRef({ name, composeProject?, composeService? }): string` — 有 Compose 服务名时
  `docker:<项目>/<服务>`（无项目名则 `docker:<服务>`），否则 `docker:<规范化容器名>`。
  **任何分支都不含容器 ID**，这是"容器重建配置不丢"的唯一实现方式。
- `serveServiceRef({ host, port, path }): string` — `serve:<host 小写去尾点>:<port><规范化路径>`。
- `normalizePath(path): string` — 空 → `/`；补前导 `/`；去尾斜杠（根路径保留）。
- `Presentation` + 私有的 `PRESENTATION_RULES`（顺序即优先级，命中即停）+
  `defaultPresentation({ name, image? }): Presentation` — 按容器名/镜像派生"初值"
  （日历→家庭日历/家庭/calendar、gitea|git→Gitea、homeport|portal→HomePort、cs22→CS22……）；
  只作初值，用户改过后永不再生效。`humanizeName(name)` 剥后缀、分隔符转空格、短词大写。
- `DEFAULT_CATEGORY = '未分类'`。
- `DiscoveredBinding` / `DiscoveredService` / `DiscoveryInput` / `DiscoveryPlan` — 发现的中间数据形状。
- `planDiscovery(input: DiscoveryInput): DiscoveryPlan` — 发现规划（纯函数，落库与否交给调用方）：
  1. 每个容器按 `containerServiceRef` 归并；同 `sourceRef` 的**副本容器合并成一个服务**
     （同一 `ref + containerId` 只保留一份绑定，避免重复卡片）；容器绑定的
     `accessible` 只认 `tailnet`/`lan`，`rank` 由可达性映射。
  2. serve 路由复用 `mapServeRoutes` 已算好的 `containerName/containerId` 归属（**不重复实现匹配**）；
     serve 绑定 `accessible` 恒 `true`、`rank = ENTRY_RANK.serve`。
  3. 归属不到唯一容器 → **不猜**：作为独立 serve 服务列出，并在 `notes` 里写明
     "未归属到唯一容器（可能是多容器端口冲突，或该目标不是容器）"；同一 serve 只解释一次。
  4. 独立 serve 服务的展示名：根路径用主机名首段，否则用路径末段（带 `serve` 提示）。
  5. `dockerAvailable === false` / `serveAvailable === false` 各自写入一条面向人的 `notes`
     （后者带上 `serveDetail`），并把可用性原样透传到 `DiscoveryPlan`。
- `normalizeUrl(raw, hostContext?): string` — **只用于去重与比较**，不用于展示：host 小写去尾点去方括号、
  默认端口省略（https:443 / http:80）、路径去尾斜杠、丢弃 query/hash；
  **`0.0.0.0` / `::` / 空主机 → host 上下文的主机名**（对应"同一容器的 `::` 与 `0.0.0.0` 映射不得重复"）；
  解析失败时返回 trim 后的小写原值，保证"同一个坏 URL"仍能相互去重。
- `normalizeHost(host, hostContext?): string` — 通配/空主机统一成 `hostContext.primaryHost`，没有则 `localhost`。
- `isLocalhostUrl(url): boolean` — 复用 `util/net.ts` 的 `isLoopbackHost`（`127.0.0.1` / `localhost` / `::1`）。
- `buildServiceEntries(input): ServiceEntry[]` — 候选入口全集：
  `preferredUrl` → `user`（管理员显式保存并验证过，**按定义视为可达**，由健康检查负责证伪）；
  绑定的 serve 路由 → `serve`（detail 写 `serve → <proxy>`）；
  容器端口 → `tailnet`/`lan`/`localhost`；`hostPort === null` 跳过；
  mapper 对 localhost-only 端口刻意不给 url，这里补 `http://localhost:<port>/` 以便诊断与"仅本机"提示
  （注释写明这是**有意为之**：不是给可点击主入口，而是让用户看到"它只在本机"）；
  不可达且非 localhost-only 的端口不产出候选。最后交给 `dedupeEntries`。
- `dedupeEntries(entries, hostContext?): ServiceEntry[]` — **两个去重键**：
  ① 规范化完整 URL（同 URL 取 rank 更高者，同 rank 时取"可达"者）；
  ② **`loopback:<port><path>`**（把 `127.0.0.1:8080` 与 `localhost:8080` 视为同一主机，保留 rank 更优者）。
  这就是 spec §3.2 的"去重两个键"。返回前用 `compareEntries` 稳定排序。
- `compareEntries(hostContext?)` — rank 升序 → 路径深度（浅者优先）→ 端口升序 → URL 字典序；
  完全确定，测试可断言。`pathDepth` 解析失败给 99、`urlPort` 解析失败给 9999（坏 URL 排最后，不抛）。
- `pickEntry(entries): ServiceEntry | null` — **首个 `accessible === true`** 的候选；一个都没有 → `null`
  （UI 显示"无可达入口"+ 原因）。
- `ContainerState = 'running' | 'stopped' | 'absent'`、`ServiceHealth = 'ok' | 'fail' | 'unknown' | 'skipped'`、
  `ServiceStatus`、`ResolveStatusInput`。
- `resolveServiceStatus(input): ServiceStatus` — 三维判定与 `reasons`：
  - 容器：有容器按 `state === 'running'` 分 running/stopped；`sourceType === 'docker'` 但没有容器 → `absent`
    （**不是"服务挂了"**）；纯 serve/手工服务 → `null`。
  - 可达：有任一可达候选 → `true`；**Docker 与 serve 都不可用 → `null`（不确定 ≠ 不可达）**；
    否则 `false` 并区分"没有发现任何入口"/"所有候选入口都只能在宿主机本机访问"。
  - 典型误报专门处理：容器端口 `localhost-only` 但存在 serve 入口 → `reachable=true` 且 reasons 写明
    "容器端口仅绑本机，经 Serve 提供 tailnet 入口"；没有 serve 才提示"局域网与 tailnet 都访问不到"。
  - 健康：没配目标 → `skipped`（默认，不探测）；配了但没结果 → `unknown`；有结果取 `ok`/`fail` 并把 detail 写进 reasons。
  - serve 不可用且该服务没有任何 serve 候选 → reasons 补"Serve 配置读不到，Serve 入口可能缺失"。
- `findContainerForService({ sourceRef, containerIds, containerNames, containers })` — 匹配顺序：
  绑定里的容器 ID（可能过期）→ 绑定的容器名 → 由 `sourceRef` 反推的稳定标识。
  **不能只看 ID**：容器重建后 ID 变了而 `sourceRef` 不变，这正是身份稳定的价值所在。
- `serveRoutesForService({ bindingRefs, container, serveRoutes })` — 按稳定 ref 或"当前容器的 id/name 归属"过滤，
  并按 ref 去重。
- `slugBaseFor(displayName, sourceRef): string` — 用"展示名 + ref 派生词"拼 slug 基名：
  中文会被 `slugify` 剥空，所以必须带 ref 兜底，否则所有中文服务会撞成同一个 slug。

#### 新增：`server/src/modules/services/service.ts`（S1-03 编排 + S1-05）

分层：**本文件只做编排**（发现→落库→算视图），业务判断在 `registry.ts`，存取在 `db/services.ts`，
探测安全边界在 `healthProbe.ts`。三条实现纪律写在文件头，其中第一条最容易违反：

1. **不在启动时拉数据**：构造函数不发起任何请求，第一次请求（或 `discover`）才触发 `sync()`
   —— 否则"设置还没生效就去读 Docker"会在冷启动时读到过期配置。
2. 发现过程只调用仓储的 `insert` / `upsertDiscovered` / `replaceBindings`，**绝不自己写 UPDATE**。
3. 候选入口、可达性、运行态、健康结果当场算，DB 里只留发现快照。

- `type ServiceRole = 'admin' | 'viewer'`、`interface ServiceActor { userId; username; ip }`、`ServiceRegistryServiceDeps`
  （`containers` / `tailscale` / `repository` / `audit` / `config` / `logger`）。
- `DiscoverySnapshot` / `ServiceListQuery` / `ServiceCreateInput` / `ServiceUpdateInput` / `ServiceOrderEntry`。
- `DISCOVERY_CACHE_TTL_FALLBACK_MS = 5000` — 发现缓存 TTL 优先跟随
  `config.cache.containersTtlMs`（默认 2s，可在设置页热调）；仅在配置值非法（NaN/负）时才回退 5000ms
  （理由：底层 `containers.list` 本来就是这个 TTL，发现比它更频繁只会重复扫同样的数据）。
- `HEALTH_RESULT_LIMIT = 512` — 内存里保留的健康结果上限（超出淘汰最早一条）。
- `class ServiceRegistryService`
  - `constructor(deps)` — 建 `TtlCache<DiscoverySnapshot>`（`maxEntries: 4`）与内存 `healthResults`；
    **不拉数据**（`servicesDiscovery.test.ts` 有一条用例直接钉住这一点）。
  - `sync(request?, { force? }): Promise<DiscoverySnapshot>` — 默认走 TTL 缓存（页面刷新、
    多客户端同时打开不会各扫一遍 Docker）；`force: true` 先删缓存键再执行（供 `POST /discover`）。
  - `runDiscovery(request?)`（私有）— 取实时数据 → `planDiscovery` → 对每个发现结果：
    既有服务走 `upsertDiscovered`（用户字段由 SQL 保护）、新服务 `insert`（`slug` 由 `uniqueSlug` 保证唯一、
    `userEdited: false`）→ `replaceBindings` 整体重建快照；返回 `{ plan, discoveredAt }`。
  - `list(request, query = {}, role = 'viewer'): Promise<ServiceListResponse>` — `sync` + 取实时容器 +
    按 `canSee` 过滤（非 admin 永远只看 `visible`）+ `matchesQuery` + 构建视图；
    返回 `{ items, total, categories, discovery, generatedAt }`。
  - `detail(id, request, role = 'viewer'): Promise<ServiceDetailResponse>` — 列表项 + **全部候选入口**
    （`candidates`）+ 诊断（`containerPorts` / `serveRoutes` / `plan.notes`）。
    hidden 服务对非 admin 抛 **`notFound`（不是 403）**：403 会泄露"这里确实有一个你看不到的服务"。
  - `create(input, actor, request): Promise<ServiceView>` — 手工服务：名称 trim 后为空 → 400；
    `preferredUrl`/`healthTarget`/`healthPath`/`icon` 全部**先校验再落库**；
    身份固定为 `manual:<uuid>`、`userEdited: true`（手工创建即"用户编辑过"，后续发现不许改写）；
    返回前写审计 `service.create`。
  - `update(id, patch, actor, request)` — 逐字段清洗（`emptyToNull` / `cleanIcon` / `cleanOptionalUrl` /
    `cleanHealthPath`）后交给 `updateUserFields`；审计 `service.update`，detail 只记**改了哪些字段名**，
    不把 URL 之类写进日志噪声。
  - `remove(id, mode, actor, request)` — 三种语义（S1-03 验收）：
    `mode === 'reset'` → `clearUserOverrides` + 删内存健康结果 + 审计 `service.reset`；
    `sourceType === 'manual'` → 真删（它只存在于注册表里，没有"自动层"可回退）+ `service.delete`；
    其它 → `setVisibility('hidden')` 保留配置 + `service.hide`
    （**容器临时没起来就把用户配置删掉，是这类面板最容易犯的错**）。
  - `reorder(entries, actor, request)` — 先逐个确认服务存在（不存在 → 404，不做部分写入），
    再单事务排序，返回**含 hidden 的完整列表**供前端整体替换本地状态；审计 `service.reorder`。
  - `probeHealth(id, overrideTarget, actor, request)` — 目标优先级见 `resolveHealthTarget`；
    没有目标 → 400；`runHealthProbe` 后 `rememberHealth`（只进内存）+ 审计 `service.health`
    （含结果与原因）；返回最新视图与本次结果。
  - 私有 `viewOf` / `computeContext` / `buildView` / `loadLive` / `buildHost` / `neutralRequest` /
    `groupBindings` / `requireService` / `requireVisible` / `rememberHealth` / `audit`。
    其中 `computeContext` 是视图的唯一来源（入口与状态**每次请求重算**，只用 DB 里的用户配置）；
    `neutralRequest()` 给无请求上下文的调用（后台/测试直接 `sync()`）一个中性 host 上下文；
    `audit()` **失败只 warn**（写操作已完成，不该因为审计失败回滚或报 500）。
- 导出的纯辅助函数（便于直接单测）：
  - `resolveHealthTarget({ overrideTarget?, healthTarget?, healthPath?, entry? }): string | null` —
    显式覆盖 → 已保存 `healthTarget` → `healthPath` 追加到首选入口（相对路径语义）；都没有 → `null`。
  - `hasHealthTarget(service: Pick<Service, 'healthTarget' | 'healthPath'>): boolean` — 任一非空即"配了健康检查"
    （决定默认 `skipped` 还是 `unknown`）。
  - `cleanOptionalUrl(value, field: 'preferredUrl' | 'healthTarget'): string | null` — 校验并规范化，
    非法直接抛 400 并带 `fieldErrors`。**刻意复用 `validateHealthTarget`**：保存时与探测时同一套判定，
    不会出现"存得进去但探不出去"（副作用见"已知限制"）。
  - `cleanHealthPath(value): string | null` — 必须以 `/` 开头（否则会变成一个任意的跳转目标）、上限 512。
  - `cleanIcon(value): string | null` — 内置白名单键，或 `https://` URL（复用同一校验），其它一律 400。
  - `emptyToNull(value)` — 空串/空白 → `null`（"清空字段"的统一语义，与"没传"区分）。
  - `canSee(service, role, includeHidden?): boolean` — `includeHidden` **只对 admin 生效**。
  - `matchesQuery(view, query): boolean` — 标题/slug/描述/分类/来源/首选入口/容器名子串匹配；
    分类精确匹配；`favorite === true` 时过滤非收藏。
  - `collectCategories(items): string[]` — 去重分类，顺序 = 列表顺序（已按 `sort_order`/`display_name` 排好）；
    `NULL`/空串统一显示为 `未分类` 并**排在最后**。
  - `toDiscoveryState(snapshot): ServiceDiscoveryState` — 发现结果 → HTTP 契约。

#### 新增：`server/src/modules/services/healthProbe.ts`（S1-05 安全边界）

本项目里**唯一**"服务器主动向用户提供的地址发起请求"的功能，也就是典型 SSRF 面；
单独成文件、写得啰嗦，是为了让它成为**可审计的一小块**，而不是散在路由里的一行 `fetch(...)`。

- `HEALTH_PROBE_TIMEOUT_MS = 3000`、`HEALTH_PROBE_MAX_BODY_BYTES = 16 * 1024`（**常量已导出，
  但当前实现未按字节截断 —— 见"已知限制"第 9 条**）。
- `type HealthProbeRejectReason = 'EMPTY' | 'TOO_LONG' | 'BAD_SCHEME' | 'NO_HOST' | 'CREDENTIALS_IN_URL' |
  'METADATA_ADDRESS' | 'DOCKER_API' | 'UNIX_SOCKET' | 'BAD_HOST'`；`HealthProbeTarget` / `HealthProbeValidation`。
- 私有拒绝清单：`METADATA_HOSTS`（`metadata.google.internal` / `metadata.goog` / `instance-data` /
  `localhost.localdomain`）、`DOCKER_API_PORTS = [2375, 2376, 2377]`、`MAX_URL_LENGTH = 2048`、
  `isLinkLocalIpv4`（`169.254.0.0/16`）、`isLinkLocalIpv6`（`fd00:ec2::254` 与 `fe80:` 前缀）。
- `validateHealthTarget(raw: string | null | undefined): HealthProbeValidation` — **纯函数，不发请求**；
  拒绝顺序刻意从"格式"到"危险目标"，错误信息面向管理员（要能看懂为什么被拒）：
  空 → 超长（>2048）→ URL 解析失败 → scheme 非 `http`/`https`（显式点名拒绝
  `javascript:`/`data:`/`file:` 等）→ URL 内嵌凭据（`user:pass@`）→ 主机名缺失 →
  **`docker.sock`（主机名或路径）与 `unix://`** → 通配地址（`0.0.0.0`/`::`/`*`）→
  云元数据主机名 → link-local IPv4/IPv6 → 主机名合法性（IP 或以 `[a-z0-9-]` 组成、可含点的域名）→
  **Docker API 端口**（注释写明"即使只读也可能泄露容器信息"）。通过则返回规范化后的
  `{ url, host, port, scheme }`。
- `runHealthProbe({ target, fetchImpl?, timeoutMs?, now? }): Promise<HealthProbeResult>` —
  先走 `validateHealthTarget`，**校验不通过直接返回 `fail` 且一个请求都不发**；
  请求纪律：`method: 'GET'`、**`redirect: 'manual'`（不跟随跳转）**、`AbortController` + 3s 超时、
  `user-agent: HomePort-HealthProbe/1.0`；读完响应体后丢弃，只取状态码与耗时；
  2xx/3xx → `ok`，其余 → `fail` + `目标返回 HTTP <code>`；超时/网络错误 → `fail` + 人类可读原因，
  **绝不抛给调用方，也不重试**；`finally` 清定时器。`fetchImpl` / `now` 只用于测试注入，
  生产路径走 `globalThis.fetch`。

#### 新增：`server/src/api/services.ts`（S1-03 路由）

- `registerServiceRoutes(app: FastifyInstance, ctx: RouteContext): void` — 成功响应**不带信封**
  （列表直接返回 `ServiceListResponse`，与 spec 的 JSON 示例逐字段对应）。
- 内部 `actorOf(session, ip): ServiceActor` — 路由层 → 服务层的审计执行者转换。
- 路由表：`GET /`（`requireAuth` + `serviceListQuerySchema`，角色传入服务层决定 hidden 可见性）、
  `GET /:id`、`POST /`（`assertAdmin`，**201**）、`POST /reorder`（admin，静态路径放在 `/:id` 之前，
  语义更直观且 Fastify 优先匹配静态段）、`POST /discover`（admin，`sync({ force: true })` 后返回
  **含 hidden** 的最新列表）、`PATCH /:id`（admin）、`DELETE /:id`（admin，`?mode=reset` 归一成
  `'reset' | null`）、`POST /:id/health`（admin，body 可带一次性覆盖目标）。
- 权限模型**两层**：`/api/services` 在 `PROTECTED_PREFIXES` 里（登录 + CSRF 前缀守卫），
  写操作在 handler 内再 `assertAdmin` —— 与 `api/settings.ts` 同一写法；
  "默认安全"不变：新增路由即使忘记加守卫，最坏是"需要登录"，不会匿名开放。

#### 新增：`server/src/api/search.ts`（S1-04 聚合搜索）

- `SEARCH_DEFAULT_LIMIT = 8`、`SEARCH_MAX_LIMIT = 20`（注释写明"再多也没人看，且会让前端弹层滚动成负担"）。
- `KIND_ORDER` — 分组顺序固定 服务 → 容器 → 设备 → 工具。
- `SearchIndexInput` — 四类内容，且**调用方保证已按角色过滤过**（这个类型里没有"设置/用户/审计/Token"的位置）。
- `buildSearchHits(index, query, limit): ServiceSearchHit[]` — **纯函数**，路由只负责取数与鉴权：
  标题与 keywords 大小写不敏感子串匹配；同组内"标题命中"排在"keywords 命中"之前；
  分组顺序 → 命中优先级 → 标题字典序，截断到 `limit`；空查询或 `limit <= 0` 返回 `[]`
  （**不返回全量**，避免"搜索没生效"的错觉）；`dedupe` 按 `kind:id` 去重。
  索引字段：服务（slug/sourceRef/sourceType/category/容器名/镜像）、容器（镜像/shortId/compose/宿主端口）、
  设备（dnsName/ipv4/ipv6/os/tags；**`url: null`** —— 给一个打不开的设备地址会诱导用户点击）、
  工具（id/category/description/宿主端口）。
- `registerSearchRoutes(app, ctx): void` — `GET /`：`requireAuth` + `searchQuerySchema`（`q` 至少 1 字符，
  空查询 400）；`limit` 取 `min(query.limit ?? 8, 20)`；
  四个数据源 `Promise.allSettled` 并行，**任何单源失败都不 500**（降级为该组空结果 + 一条 `warn`）；
  服务走 `ctx.services.list(..., { includeHidden: role === 'admin' })`（非 admin 不含 hidden）、
  容器走 `containers.list({ all: true, stats: false })`、
  设备走 `tailscale.getStatus()`（self + peers）、
  **工具走 `probe: false`**（搜索框每敲一个字就发一次 HTTP/端口探测是不可接受的）；
  返回 `{ items, query }`。
- 私有 `includes` / `serviceSubtitle`（`分类 · 入口标签`，与 spec 示例一致）/ `toolStatusLabel` / `dedupe`。

#### 修改：`server/src/api/index.ts` / `context.ts` / `app.ts`（装配）

- `PROTECTED_PREFIXES` 增加 `{ prefix: '/api/services', register: registerServiceRoutes }` 与
  `{ prefix: '/api/search', register: registerSearchRoutes }`（注释写明：读接口 viewer 可用，
  写接口 handler 内要求 admin，聚合搜索按角色过滤索引内容）。
- `RouteContext` 增加 `services: ServiceRegistryService`（注释：发现 / 列表 / 管理 / 健康探测）。
- `app.ts`：新增 `const servicesRepo = new ServicesRepository(db)`；
  新增 `const serviceRegistry = new ServiceRegistryService({ containers, tailscale, repository: servicesRepo,
  audit: auditRepo, config, logger })`，并写进 `RouteContext`。注释强调**构造期不拉数据**：
  第一次请求（或管理员 discover）才 `sync()`，保证"`settings.initialize()` 之后才读 Docker"这条顺序
  不会被这里破坏。

#### 修改：`server/src/http/schemas.ts`（请求校验）

全部 `.strict()`（未知字段直接 400，避免"拼错了却没报错"），`boolQuerySchema` 只认
`1`/`0`/`true`/`false` 且**省略时不给默认值**（默认值统一在路由层显式给出）：

- `serviceListQuerySchema` — `query`(≤128) / `category`(≤32) / `favorite` / `includeHidden`。
- `serviceCreateBodySchema` — `displayName` 必填 1–64，`description`≤280，`icon`≤2048，
  `category`≤32，`preferredUrl`≤2048，`healthTarget`≤2048，`healthPath`≤512，
  `visibility` enum，`sortOrder` int ±10000，`favorite` boolean。
- `serviceUpdateBodySchema` — 同上任意子集，可选字段 `nullable()`（**`null` = 清空该字段**，
  与"没传"区分开），并 `.refine()` 要求至少一个字段。
- `serviceDeleteQuerySchema` — `mode: z.literal('reset').optional()`（其它值 400，不做模糊匹配）。
- `serviceReorderBodySchema` — `order[]` 每项 `{ id, sortOrder }`，1–500 项。
- `serviceHealthBodySchema` — 可带一次性 `healthTarget`（服务层同一套校验）。
- `searchQuerySchema` — `q` 必填 1–128、`limit` coerce 1–20；
  注释写明空查询**直接 400 而不是返回全部**的理由。

#### 修改：`web/src/App.tsx` / `layout/AppShell.tsx` / `components/ui.tsx`（外壳与路由）

- `App.tsx`：`/` 从 `<OverviewPage/>` 改为 `<ServicesPage/>`（首页 = 服务墙）；
  **新增 `/overview` 承载原样未改的 `<OverviewPage/>`**（这是本 Sprint 唯一对用户可见的
  路径破坏性变更）；新增 `/services/:id`（`Protected`，viewer 可看，hidden 由后端 404）；
  新增 `/admin/services`（`Protected` + `AdminOnly`）。文件头注释同步 viewer 访问
  `/admin` 或 `/admin/services` 都进 403 页面。
- `AppShell.tsx`：`NavItem` 增加 `end?: boolean`；导航表把 `'/'` 从「总览」改成
  **「服务」（`server` 图标，`end: true`）**，新增 `/overview`「总览」与 `/admin/services`
  「服务管理」（`adminOnly`、`end`）；`end` 统一为 `item.to === '/' || item.end === true`
  （有子路由的条目必须精确匹配，否则父项与子项同时高亮）；
  整个外壳包进 **`CommandPaletteProvider`**（任意页面都能 `Ctrl/Cmd+K` 唤起）；
  页脚文案从"只读展示"改成"容器与设备只读展示（不提供容器写操作），服务配置可由管理员编辑"。
- `ui.tsx`：`Icon` 的 `paths` 增加 `dashboard` 与 `server` 两个内联 SVG（侧栏新增条目用），
  不改任何既有图形与签名。

#### 修改：`web/src/api/types.ts` / `web/src/api/client.ts`

- `api/types.ts`：新增 `ServiceEntryKind` / `ContainerState` / `ServiceHealth` / `ServiceSourceType` /
  `ServiceVisibility` / `ServiceDeleteMode` 与 `ServiceEntryView` / `ServiceStatusView` /
  `ServiceContainerRef` / `ServiceView` / `ServiceDiscoveryState` / `ServiceListResponse` /
  `ServiceDiagnostics` / `ServiceDetailResponse` / `ServiceSearchKind` / `ServiceSearchHit` /
  `ServiceSearchResponse` / `ServiceHealthView` / `ServiceHealthResponse` / `ServiceDeleteResponse` /
  `ServiceListParams` / `ServiceCreateRequest` / `ServiceUpdateRequest` / `ServiceReorderRequest`
  —— 与 `server/src/modules/services/types.ts` **逐字段镜像**（改一处必须改两处）。
- `api/client.ts`：`ApiClient` 新增 9 个方法（成功响应形状与后端一致，无信封）：
  `services(params: ServiceListParams = {}): Promise<ServiceListResponse>`（`favorite`/`includeHidden`
  转 `'1'`，`timeoutMs: SLOW_TIMEOUT_MS`；注释强调**前端不要再并行调 `/containers` 自行拼装**，
  那会引入两套口径）、`service(id): Promise<ServiceDetailResponse>`、
  `createService(input): Promise<ServiceView>`（201 裸对象）、
  `updateService(id, patch): Promise<ServiceView>`、
  `deleteService(id, mode?: 'reset'): Promise<ServiceDeleteResponse>`（`query: { mode }`）、
  `reorderServices(order: Array<{ id: string; sortOrder: number }>): Promise<ServiceListResponse>`、
  `discoverServices(): Promise<ServiceListResponse>`、
  `probeServiceHealth(id, healthTarget?): Promise<ServiceHealthResponse>`（不传则 body 为 `{}`）、
  `search(q: string, limit?: number): Promise<ServiceSearchResponse>`。所有 id 走 `encodeURIComponent`。

#### 新增：`web/src/components/Modal.tsx`

- `ModalProps` — `{ open; onClose; title: ReactNode; description?; children; footer?; size?: 'sm'|'md'|'lg';
  closeLabel?; initialFocusRef?: RefObject<HTMLElement | null>; className? }`。
- `Modal(props): ReactNode` — `role="dialog"` + `aria-modal` + `aria-labelledby`（`useId`，`description`
  挂 `aria-describedby`）；打开时记录 `document.activeElement` 并把焦点移入（有 `initialFocusRef` 用它，
  否则面板内第一个可聚焦元素）；Tab/Shift+Tab 在面板内循环（**焦点不逃逸**）；Esc、遮罩、关闭按钮都走 `onClose`；
  关闭后**归还焦点**给打开前的元素。用 ref 持有最新 `onClose`，避免父组件传内联箭头函数时 effect 反复重跑抢焦点
  （StrictMode 双跑 effect 下幂等）。

#### 新增：`web/src/components/ServiceIcon.tsx` / `UrlCandidateList.tsx` / `ServiceCard.tsx`

- `ServiceIcon.tsx` — `SERVICE_ICON_NAMES`（与后端 `BUILTIN_ICONS` 对齐的白名单）、
  `ServiceIconName`、`SERVICE_FALLBACK_ICON = 'container'`、`isServiceIconName`、`isServiceIconUrl`、
  `ServiceIconProps`（`{ icon; className?; alt? }`）、`ServiceIcon(...)`：
  白名单键 → 内联 SVG；`https://` → `<img loading="lazy" referrerPolicy="no-referrer">`；
  其它（含空、`javascript:`）→ 一律回退 `container`。**不引图标字体/CDN**（默认 CSP `img-src 'self' data:`
  会拦掉，见"已知限制"）。
- `UrlCandidateList.tsx` — `UrlCandidateListProps`（`{ entries; emptyHint?; className? }`）、
  `unreachableLabel(entry): string`、`UrlCandidateList(...)`：卡片抽屉与详情页共用的候选入口列表；
  **不可达项照列**并明确标注"仅本机/不可达"，可达项才是可点击外链。
- `ServiceCard.tsx` — `ServiceStatusBadgesProps`、`ServiceStatusBadges({ status, className })`：
  **三个独立状态点**（容器 / 可达 / 健康）各带 `title` 悬停解释与 `data-status="container|reachable|health"`
  （E2E 可断言），容器 running 时脉冲点；
  `describeSourceType(sourceType): string`（Docker 自动发现 / Serve 路由 / 手工创建）；
  `ServiceCardProps`（`{ service; canManage?; onEdit?; onToggleFavorite?; busy?; defaultExpanded?; to? }`）、
  `ServiceCard(...)`：图标 + 名称链接（默认 `/services/:id`）+ 分类 + 状态点 + 首选入口外链 +
  `entryCount > 1` 时展开 `UrlCandidateList`；`canManage=false`（viewer）**不渲染任何管理入口**；
  `data-service-id` 便于测试定位。

#### 新增：`web/src/components/ServiceForm.tsx`

- `ServiceFormProps` — `{ service?: ServiceView | null; onSaved?; onCancel? }`；
  `ServiceForm(...)` — 新建/编辑共用表单（名称/描述/图标选择器/分类/首选入口/健康检查目标/健康路径）。
- E2E 依赖的稳定契约：`#service-name` / `#service-description` / `#service-icon` / `#service-category` /
  `#service-url` / `#service-health-path`（每个都有 `<label htmlFor>`），
  另外实现补了 `#service-health-target`（spec 只列了健康路径，实际把显式目标也放进表单；
  该输入目前**没有测试/E2E 覆盖**，见"已知限制"第 12 条）；
  按钮可访问名固定为 `保存` / `取消`。
- 前端拦截：首选入口填 `javascript:` / `data:` / `file:` 等时**本地提示并禁用保存**
  （不把明显非法的值发到后端再等 400）；图标既不是内置键也不是 `https://` 时提示，
  并说明"外部图标需在 `PORTAL_CSP` 的 `img-src` 中放行"。
- 提交契约：编辑走 `PATCH /api/services/:id`；新建走 `POST /api/services`，**空的可选字段整个省略**
  （后端创建 schema 不接受 `null`）—— 这一点有专门的用例钉住；
  后端 400 的 `fieldErrors` 回填到对应输入（`aria-invalid` + `aria-describedby` + `role="alert"`）。

#### 新增：`web/src/components/CommandPalette.tsx`

- `DEBOUNCE_MS = 150`；`CommandPaletteContextValue`（`{ visible; open(); close() }`）、
  `useCommandPalette()`（没有 Provider 时返回安全兜底值，单测单独渲染不会崩）、
  `CommandPaletteProvider({ children })`（注册全局 `Ctrl/Cmd+K`，`ctrlKey || metaKey` 且不带 alt，
  `preventDefault`；StrictMode 下 add/remove 成对，只有一个监听器；渲染面板本体）、
  `CommandPaletteProps`（`{ open; onClose }`）、`CommandPalette(...)`。
- 状态：每次打开清空关键词/结果/选中项/错误；输入后 `setTimeout(150ms)` 防抖请求
  `api.search(keyword, 8)`，并用**递增序号 `seqRef`** 丢弃过期响应（先发后到的旧响应不得覆盖新结果）；
  请求失败只显示错误文案，不残留旧结果。
- 无障碍：输入框 `role="combobox"` + `aria-activedescendant`（指向 `${listId}-option-${index}`）、
  结果 `role="listbox"`、选项 `role="option"` + `aria-selected`，**焦点始终留在输入框**（不靠移动焦点选条目）。
- 键盘与 Enter 行为固定（E2E 断言 URL）：`service` → `navigate('/services/:id')`、
  `container` → `navigate('/containers/:id')`、`device` → `navigate('/devices')`、
  `tool` → `window.open(hit.url, '_blank', 'noopener,noreferrer')`（没有 url 时退回 `/tools`）；
  **服务条目绝不走 `window.open`**。↑↓ 移动、Esc 关闭（焦点归还触发元素）、无结果给可读文案。

#### 新增：`web/src/pages/ServicesPage.tsx`（首页服务墙）

- `buildServiceGroups(items: ServiceView[], categories: string[]): { favorites: ServiceView[]; groups: ServiceGroup[] }`
  — 收藏置顶区 + 分类分组；**收藏项不从分类里重复出现**（同一张卡出现两次会让
  `getByRole('link', { name })` 命中多个元素，E2E 直接失败，也让"墙上到底有几个服务"变含糊）；
  分组顺序按后端 `categories`，后端没给的分类附在后面（zh 排序），**「未分类」永远最后**；
  组内按 `sortOrder` → `displayName`（zh）排序。
- `discoveryMessages(discovery: ServiceDiscoveryState): string[]` — 降级文案：后端 `notes` 是面向人的解释，
  **必须原样透出**；只有后端没给对应说明时才用兜底句子（且兜底句子里也明确写出 `Docker` / `Serve`，
  便于用户与 E2E 定位）；其余 notes 一律附上，不静默丢弃。
- `ServicesPage(): ReactNode` — 顶部搜索框（点击打开命令面板，右侧提示 `Ctrl/Cmd K`）→
  数据源降级提示条（`role="status"`，`⚠` 图标 `aria-hidden`）→ 收藏区 → 分类分组（可折叠，空分类不显示）
  → 卡片网格（移动端 1 列 / `sm` 2 列 / `xl` 3 列）；0 个服务时 admin 看到「新建服务」入口、
  viewer 只看到说明；viewer 不渲染任何管理入口。

#### 新增：`web/src/pages/ServiceDetailPage.tsx`

- `ServiceDetailPage(): ReactNode` — `/services/:id` 的数据源是 `GET /api/services/:id`；
  页面按"为什么这个服务是现在这个样子"组织：三个独立状态点 + **`status.reasons` 逐条列出** +
  首选入口（外链，`entry === null` 时明确写"暂无可达入口，所有候选入口都只能在宿主机本机访问"）
  + `UrlCandidateList` 展示**全部**候选（含不可达）+ 诊断区块（容器端口 / serve 路由 / notes）；
  admin 额外有「编辑」（`Modal` + `ServiceForm`）与「健康检查」。
  404（服务不存在，或 hidden 且当前账号不是管理员）时给出可读错误与「← 返回服务墙」，
  **不白屏**。存在这个页面的理由就是 S1 的最终验收："管理员能解释某个服务为什么不可达"。

#### 新增：`web/src/pages/AdminServicesPage.tsx`

- `AdminServicesPage(): ReactNode` — `/admin/services`（`AdminOnly`）：
  列表按 `sortOrder`，支持上移/下移（写回 `reorder`）、收藏切换、可见性开关、编辑、新建自定义服务、
  重新发现（显示"已重新发现：当前 N 个服务"）、一次性健康探测。
- **删除语义按来源区分并如实提示**：`manual` 服务是真删除（二次确认）；
  自动发现的服务只能「隐藏」（可逆，因此不再弹确认框，少一次打断）或「重置为自动」
  （明确告知"名称/图标/分类/首选入口/顺序/收藏等自定义都会被清除"）。
- 可见性用开关而不是又一个叫「隐藏」的按钮：同行已有一个语义为"隐藏自动服务"的按钮，
  同名按钮会让读屏与 E2E 选择器产生歧义（开关的 `aria-label` 是"在服务墙显示「X」"）。
- 顶部一行状态摘要透出 `discovery.dockerAvailable` / `serveAvailable`；所有写操作显示后端错误信息
  （校验失败要能看到"scheme 不允许"这类原因）。

#### 新增：`server/tests/*` 与 `server/tests/support/`

- `support/serviceFixtures.ts` — `TS_HOST`、`PORTAL_HOST_PORT = 8899`、`makeHostContext(primaryHost?)`、
  `makePort`、`makeContainer`、`makeServeRoute`、`makeContainerList`、`makeDevice`、`makeTool`、
  `interface Topology`、`realTopology({ containerIdSuffix? })`：把"开发机/`family-nas` 上的真实拓扑"
  （日历容器 + `/calendar` 等 serve 路由 + 门户自身 443 `/` + 冲突端口）固化成夹具，
  让纯函数测试不必起 Docker；`containerIdSuffix` 用来模拟"容器重建换 ID"。
- `servicesDiscovery.test.ts`（22 用例，6 组）— 稳定身份（容器重建 → 同 `sourceRef` 且不含容器 ID、
  副本后缀剥离、副本合并、用户字段重新发现后保留）；serve 归属与门户自身（三条 serve 归属容器、
  门户 443 `/` 归根域名、日历首选 `/calendar` 而非 `:36065`、Gitea 取 `/git/`、
  多容器冲突不猜并在 notes 说明、serve/Docker 不可用给可读解释）；
  入口优先级与去重（路径浅优先、同 rank 稳定排序、`0.0.0.0`/`::` 去重、`127.0.0.1`/`localhost` 同一主机、
  默认端口与尾斜杠规范化、用户指定恒 rank 0、无可达候选 → `entry: null` 但候选全保留）；
  三维状态（`container=absent` 不是"挂了"、数据源不可用 → `reachable=null`、
  只绑本机但经 Serve 可达 → `reachable=true` 且 reasons 说明、健康三维独立）；
  构造时机（`new` 不发请求、首次 `sync` 才拉数据、之后走 TTL 缓存）；
  性能（0/1/20/100 个服务，100 个 < 150ms）。
- `servicesApi.test.ts`（22 用例，4 组）— 鉴权与 CSRF（匿名 401、viewer 读得到、viewer 写 403、
  admin 缺 CSRF 403）；手工服务与校验（201 且身份 `manual:<uuid>`、重名 slug 互不相同、
  未知字段 400 且不落库、缺必填/空 PATCH/非法查询 400、
  **危险 URL 一律 400 且不落库**（`javascript:`/`data:`/内嵌凭据/元数据地址）、
  PATCH 各字段生效、列表四种过滤、hidden 对 viewer 不可见且详情 404、`includeHidden` 只对 admin 生效）；
  详情/排序/删除/重新发现（详情含不可达候选与诊断、reorder、DELETE 三种语义各自的作用域、
  `/discover` 返回最新列表、写操作留下 `service.*` 审计）；
  健康探测（未配置目标 → 400 且零请求、云元数据 → `fail` 且 detail 说明"已拒绝"、
  结果进内存但不把覆盖目标落库）。
- `servicesHealthProbe.test.ts`（17 用例，3 组）— `validateHealthTarget` 的拒绝清单与格式校验
  （接受 loopback/私网、空值与超长、非 http(s) scheme、内嵌凭据、云元数据与 link-local、
  通配与 unix socket、Docker API 端口、非法主机名给可读原因）；
  `runHealthProbe` 注入 fetch 的请求纪律（`redirect: 'manual'` + GET + 超时信号、
  2xx/3xx → ok 与 4xx/5xx → fail、超时 → fail 且不重试、网络错误 → fail 带原因、
  **被拒目标零请求**）；`resolveHealthTarget` 优先级（显式覆盖 > 已保存 > `healthPath` 追加到入口，
  都没有 → null）。全部走注入 `fetchImpl`，测试期间**不产生真实网络流量**。
- `servicesSearch.test.ts`（12 用例，2 组）— `buildSearchHits` 纯函数（分组顺序、标题命中优先、
  大小写不敏感子串与 keywords、limit 与空查询、设备 `url` 为 null）；
  `GET /api/search` 契约与权限（匿名 401、默认/上限 limit 且 21 → 400、空查询 400、
  **viewer 搜不到 hidden 而 admin 能搜到**、容器与设备沿用只读权限、
  工具走 `probe: false` 不发探测、**拿用户名与设置值搜不到任何东西**）。
- `migrationV4.test.ts`（9 用例，2 组）— v3 库升级后 `schema_migrations` 恰好 4 行、
  v4 **没有 down**（append-only，回退只能靠备份恢复）、重复 `runMigrations` 幂等、
  升级前管理员会话仍有效、用户与设置都在且来源仍标记为数据库；
  服务行与用户覆盖在重新发现后保留（首次发现写行与快照、用户改过展示属性与首选入口后再次发现仍是同一 ID
  且行不重复、**Docker 不可达的空发现不会删掉已有服务行**、API 层能读到这一行 —— 服务墙不会因迁移而空掉）。
- `migrationV3.test.ts`（修改）— 回落脚本在删 v3 的 4 列 2 表之外**同时删掉 v4 三张表**并把
  `schema_migrations` 的 `version IN (3, 4)` 一起删除；断言从硬编码 `toBe(3)` 改为
  `Math.max(...MIGRATIONS.map(m => m.version))` + `toBeGreaterThanOrEqual(3)`。
  **为什么**：v3 用例的假设是"库里只有 v3"，而 v4 落地后它实际测的是"整条迁移链在已有数据上前滚"；
  不改的话用例会稳定失败于一条与 v3 无关的断言，而不是发现真问题。

#### 新增：`web/tests/*`

- `serviceTestUtils.ts` — `jsonResponse` / `errorResponse` / `RecordedCall` / `Handler` /
  `stubFetch(routes)`（按 URL 命中并记录调用，用于断言"发了什么请求、带了什么 body"）/
  `callsTo(calls, url)` / `sessionUser` / `sessionPayload` / `baseRoutes` /
  `entry` / `LOCALHOST_ENTRY` / `serviceView` / `discoveryState` / `listResponse`。
- `services.test.tsx`（12 用例，4 组）— 卡片与分组（收藏不重复、未分类最后）、
  **三个状态点分别渲染且互不相同**、无容器绑定显示"无容器/可达性未知"而不是"不可达"；
  降级提示与空态（后端原因原样透出、后端没给也要有含 "Docker" 的兜底、0 服务时 admin/viewer 的差别）；
  权限与候选入口（viewer 不渲染任何管理入口、admin 能看到编辑/收藏、展开候选时不可达项被标注）；
  详情页（三维状态 + 全部候选 + 诊断、404 给错误与返回入口不白屏、viewer 无管理按钮而 admin 有编辑与健康检查）。
- `serviceForm.test.tsx`（9 用例，3 组）— 六个输入的 label/htmlFor 关联与按钮可访问名、
  名称为空不能保存；危险输入（`javascript:` / `data:` / `file:` 本地拦截并禁用保存、
  非法图标提示且说明 CSP 约束）；提交契约（编辑走 PATCH 且逐字段符合契约并带 CSRF、
  **新建时空的可选字段整个省略**、填了的字段不含 `null`、后端 `fieldErrors` 回填到输入并带
  `aria-invalid`/`aria-describedby`/`role="alert"`）。
- `commandPalette.test.tsx`（8 用例，2 组）— 打开与关闭（Ctrl+K 的 dialog/aria 契约与焦点进入搜索框、
  Meta+K 同样能开、Esc 关闭并归还焦点、点遮罩关闭）；搜索与键盘导航（防抖请求 + `aria-selected` 维护、
  Enter 打开服务 → `/services/:id`、容器 → `/containers/:id`、设备 → `/devices`、
  工具 → `window.open`、无结果给可读文案）。
- `adminServices.test.tsx`（6 用例，1 组）— 管理页的**按钮契约与写操作 payload**：
  渲染排序/收藏/可见性/编辑按钮，且手工服务给「删除」、自动服务给「隐藏 + 重置为自动」；
  点「下移」调 `reorderServices` 且 payload 是重排后的完整顺序（`(index + 1) * 10`）；
  点「重新发现」调 `POST /api/services/discover` 并提示结果；点「编辑」打开 Modal 且表单使用固定输入 id；
  可见性开关调 PATCH `visibility`、取消收藏调 PATCH `favorite`；
  「重置为自动」二次确认后调 `DELETE /api/services/:id?mode=reset`；
  列表请求 URL 硬编码为 `/api/services?includeHidden=1`（钉住"管理页必须带 `includeHidden`"）。

#### 修改：`e2e/smoke.spec.ts`

- 既有断言的**必然修正**（首页迁移的连带影响，不改就是稳定失败）：
  登录成功落点从 `heading '总览'` 改为 `heading '服务'`；bootstrap 后的落点断言同样改；
  "聚合告警卡"用例在断言前显式 `page.goto('/overview')`（总览已不在 `/`）。
- 文件末尾**追加 2 条用例**（不加新 spec 文件：`.e2e-data` 只在整轮开始时清空一次，
  admin/viewer 账号由本文件第 2、5 条用例创建，`workers: 1` 且文件内顺序敏感，
  新文件若文件名排序在前会先于建号用例运行）：
  1. `服务墙：数据源全不可用时给出可解释的降级提示，管理员可手工新建服务且刷新后仍在`
     —— 断言 `/` 是服务墙、页面出现 `Docker` 字样；`/admin/services` 新建「测试服务」→ 刷新仍在
     → 回到 `/` 能在服务墙看到它且首选入口是 `https://example.ts.net/app`。
  2. `服务墙：Ctrl+K 搜索并进入服务详情；viewer 看不到任何管理入口`
     —— `getByRole('dialog')` + 输入并按 Enter → URL 落到 `/services/:id` 且出现「服务详情」；
     退出登录换 viewer：侧栏有「服务」、**没有「服务管理」**、页面**没有「新建服务」**按钮、
     服务本身可见；直接访问 `/admin/services` 得到「权限不足」。

#### 顺手修掉的真实缺陷：`portal.sqlite` 在 WAL 模式下"只拷主文件"的备份会静默丢数据

**这是本条目最值得单独记的一件事，因为它不是新功能的一部分，而是准备迁移演练时撞出来的生产风险。**

- **现象**：准备 v3→v4 演练时，`docker cp homeport-portal:/data/portal.sqlite` 拿到的副本
  **只有 v1/v2 迁移记录**，而生产库实际已经是 v3。
- **原因**：数据库跑在 **WAL 模式**。主库文件停在 `03:59`，同目录 `portal.sqlite-wal` 有 **140KB**，
  v3 迁移与近期审计**全在 WAL 里没有 checkpoint 回主文件**。
- **危害**：这种"备份"能正常打开、`pragma integrity_check` 也过，**看起来完全正常**，
  却悄悄少了几小时数据；恢复后甚至会被判定为"未迁移"而重跑迁移。
  `portal.sqlite-shm` / `portal.sqlite-wal` 是数据库的一部分，不是临时文件。
- **修法（`docs/static/08-operations.md` §10 已改写）**：
  - 方案 A（**推荐，日常用，不停机**）：容器内 `VACUUM INTO '/tmp/snap.sqlite'` 做一致性导出
    → `docker cp` 取出；导出后核对 `schema_migrations` 版本列表、`users`/`audit_log` 条数、
    `integrity_check = ok`；**必须再单独备份 `secret.key`**，否则密文读不回来。
    Windows 下把导出脚本落成文件再 `docker cp` 进容器，避免嵌套引号被 PowerShell 吃掉。
  - 方案 B（**能停服务时最稳**）：`docker compose stop homeport`（停写，保证 WAL 已 checkpoint）
    → `docker run --rm -v homeport-data:/data ... tar czf` 整卷打包（顺带包含密钥）→ `start`。
    文档明确写出"容器仍在写时 `tar` 卷是活文件拷贝、一致性没有保证"，所以必须显式停。
  - 核对项与"恢复后如何确认迁移状态"一并写入 §10；`todo.md` 也记了一条勾选项。

#### 删除：无

本轮**没有删除任何文件**。唯一"消失"的是 `/` 上的总览页面内容 —— 它被**原样迁移**到 `/overview`
（`OverviewPage.tsx` 一字未改，只是路由换了位置），侧栏同时保留「服务」与「总览」两个入口。

### 配置/接口/数据模型影响

- **环境变量：无新增**。发现规则、探测超时（3s）、响应体上限常量、发现缓存 TTL 都是代码常量；
  健康检查目标与首选入口是**按服务存库**的数据，由管理员在 `/admin/services` 保存。
  最小可用配置仍然是空 `.env`（见 `02-configuration.md`）。
- **DB 迁移 v4 `services_registry`**：追加 `services` / `service_bindings` / `service_preferences`
  与 `idx_service_bindings_service` / `idx_services_sort` / `idx_services_source`；
  既有表**一列未改**；每个迁移在独立事务中执行并写 `schema_migrations`，失败回滚并让启动失败；
  仅有 `up`（append-only），**回退 = 镜像回退 + 备份恢复**（旧版本代码看不到这三张表也不会报错，
  因此回滚镜像不需要动数据库）。逐列语义见 `07-data-model.md` §2。
- **新增 HTTP 接口 9 个**（契约见 `04-api-contract.md` §6.5 / §6.6，本节不重复字段表）：
  `GET /api/services`、`GET /api/services/:id`、`POST /api/services`（201）、
  `PATCH /api/services/:id`、`DELETE /api/services/:id`（`?mode=reset`）、
  `POST /api/services/reorder`、`POST /api/services/discover`、`POST /api/services/:id/health`、
  `GET /api/search`。**未新增错误码**（沿用 `VALIDATION_FAILED` / `NOT_FOUND` / `FORBIDDEN`）。
- **权限**：`/api/services` 与 `/api/search` 进入 `PROTECTED_PREFIXES`（匿名 401、缺 CSRF 403）；
  读接口 viewer 可用，写接口在 handler 内 `assertAdmin`（viewer 写 403）；
  hidden 服务对非 admin → `NOT_FOUND`（不是 403，避免泄露"这里有一个你看不到的服务"）。
- **审计动作**：`service.create` / `service.update` / `service.delete` / `service.hide` /
  `service.reset` / `service.reorder` / `service.health`（target 为 `service:<id>`，
  reorder 的 target 为 null）。
- **⚠️ 对用户可见的破坏性变更（路径）**：`/` 从「总览」变为「**服务墙**」，总览迁到 `/overview`；
  新增 `/services/:id` 与 `/admin/services`。侧栏同时提供「服务」与「总览」，
  但**书签指向 `/` 的用户会看到服务墙而不是总览** —— 这是产品意图（首页就该是入口墙），
  升级说明里必须写清（`08-operations.md` §7.1 已列）。
- **前端 API 客户端**：`web/src/api/client.ts` 新增 9 个方法（见上文）；服务契约类型在
  `web/src/api/types.ts` 与后端逐字段镜像。
- **CSP 影响**：外部图标 URL（`icon` 为 `https://…`）会被默认 `img-src 'self' data:` 拦掉；
  管理页如实提示"需在 `PORTAL_CSP` 的 `img-src` 中放行其来源"，**不为了图标放宽默认 CSP**
  （见 `06-security.md`）。
- **健康结果不落库**：只在进程内存里保留（`HEALTH_RESULT_LIMIT = 512`），重启回到 `unknown`。

### 验证方式

本轮实际执行的命令（未在本地重跑前的历史结论见 `IMPLEMENTATION_REPORT_S1.md` §6，
那里记录的是当次运行的结果；本条只写命令本身与已确证的事实，**不臆造总数**）：

```bash
npm run typecheck                    # server + web 两个工作区
npm run build                        # web（vite build）→ server（tsc）
npx vitest run --root server         # server 单测/集成
npx vitest run --root web            # web 单测（jsdom + RTL）
npm run test:e2e                     # Playwright 冒烟（默认端口 8988，PORTAL_E2E_PORT 可覆盖）
```

新增测试的规模（按文件统计的用例数，可复现）：
`servicesDiscovery.test.ts` 22、`servicesApi.test.ts` 22、`servicesHealthProbe.test.ts` 17、
`servicesSearch.test.ts` 12、`migrationV4.test.ts` 9（server 合计 82）；
`services.test.tsx` 12、`serviceForm.test.tsx` 9、`commandPalette.test.tsx` 8、
`adminServices.test.tsx` 6（web 合计 35）；
`e2e/smoke.spec.ts` 共 7 条用例（新增 2 条 + 修正既有 5 条）。
server/web 的**文件总数与全绿结论**、E2E 通过条数见 `IMPLEMENTATION_REPORT_S1.md` §6。

**真实库迁移演练**（不是空库测试，而是拿生产库副本跑的）：

```bash
node _homeport-backups/migrate-rehearsal.mjs <v2 库副本> <v3 库副本>
```

结论：`portal-pre-sprint0-….sqlite`（v2，v1,v2 · users=2 sessions=11 audit=17）与
`portal-live-pre-sprint1.sqlite`（v3，v1,v2,v3 · 同计数）两份样本，
迁移后**用户/会话/审计/设置数不变、密文逐字未变、三张表建出、重复迁移幂等**。
脚本只读源库（复制到临时目录再迁移），不会污染原始样本。

**实机发现验证**（真实 Docker + 真实 `tailscale serve` CLI，非夹具）：

```bash
node _homeport-backups/real-discovery.mjs   # buildApp() + 真实登录 + app.inject()
```

结论：家庭日历首选 `https://sisi-laptop.tail921448.ts.net/calendar`（Serve HTTPS，rank 1 胜过
只绑本机的端口）；门户自身 443 `/` 归到根域名 HTTPS；`localhost:443` 作为**不可达候选保留并标注**；
4 条 serve 路径各自保留；`/dsh`（多容器端口冲突）**不猜测归属**，作为独立服务列出并写进 notes；
不可达服务的 `status.reasons` 给出人话；匿名 `GET /api/services` → 401；搜索 `calendar` 命中服务与容器；
`dockerAvailable` / `serveAvailable` 自洽。
`family-nas` 上 443 `/`、8443 `/calendar`、8443 `/git/` 的拓扑本机没有，由夹具覆盖、NAS 部署时复核
（已记入 `todo.md`）。

### 已知限制 / 后续

1. **健康探测刻意允许 loopback 与私网**：家用场景"本机服务 + Serve 暴露"是主流形态，
   探测 `http://127.0.0.1:36065/health` 是刚需；拒绝清单只覆盖"被请求就会造成危害"的目标
   （云元数据、Docker API 端口）。缓解：**默认不探测、必须管理员显式配置**（见 `06-security.md` §3）。
2. **`preferredUrl` 与 `healthTarget` 共用一套校验**（一个真相来源，避免"存得进去却探不出去"）。
   副作用：指向 Docker API 端口（2375/2376/2377）的**链接**也会被拒。
   将来若确有"指向 Docker API 的入口"需求，需要把"链接校验"与"服务器出站校验"拆成两套并分别测试。
3. **外部图标 URL 需要 CSP 放行**：默认 `img-src 'self' data:`，`https://` 图标会被浏览器拦掉。
   管理页已提示，**不为了图标放宽默认 CSP**。
4. **API 模式读不到 serve 配置**：此时服务墙的入口会偏保守（只有端口映射）。
   界面会明确说明（`discovery.serveDetail` + 兜底文案），不是静默少几条入口；
   serve 路由需要 `PORTAL_TAILSCALE_MODE=cli`。
5. **健康结果不落库**：进程重启后回到 `unknown`。这是刻意的（结果会过期，落库会把"某一刻的探测结果"
   变成"永久的谎话"）。
6. **serve 归属不做猜测**：多容器共用同一目标端口时列为独立服务并写 `notes`；
   代价是可能多出一个服务条目，收益是绝不把入口挂到错的容器上。
7. **首页路径变更**：书签指向 `/` 的用户会看到服务墙（见上文"破坏性变更"）。
8. **两个内联弹窗未迁移到新的 `Modal`**（`web/src/pages/admin/SecurityTab.tsx` /
   `UsersTab.tsx`）：无功能问题，仅为无障碍一致性与去重收益，已记入 `todo.md` 技术债。
9. **`HEALTH_PROBE_MAX_BODY_BYTES` 曾被"声明但未接线"——已在本次提交内修掉**：归档时发现
   `runHealthProbe` 实际执行的是 `await response.text()` 后丢弃，读的是**完整响应体**，
   而 `06-security.md` 与本条上文按设计意图写的是"最多读 16KB"。健康目标可以是任意进程
   （包括返回无限流的服务），`text()` 等于让对端决定门户分配多少内存。
   修法：新增 `discardProbeBody(response, maxBytes)` —— 用 `response.body.getReader()`
   逐块累计到上限即 `reader.cancel()`（释放连接、不读完），无流式 body 时退回一次性读取；
   状态码判定不受影响。用例 `无限流：读满上限就主动断开，而不是把响应体整个读进内存`
   （构造真实 `ReadableStream` 无限流，断言 `cancel` 被调用且读入量 ≤ 上限 + 2 个分片）
   在新实现下 50ms 内结束，在旧实现下会一直读到 3s 超时且 `cancel` 不会被调用 —— 可区分。
10. **NAS 实机复核未做**：`family-nas` 上三条 serve 路由的服务墙呈现只能在那台机器上验（本机无此拓扑）。
11. **未做项（计划内不在 Sprint 1 范围）**：服务分组/标签体系、批量编辑、服务级健康历史曲线、
    把 `service_preferences` 真正用到视图偏好上。`git push` 仍未执行（Sprint 0/1 提交都在本地）。
12. **`#service-health-target` 的契约覆盖已在本次提交内补齐**：`ServiceForm` 文件头注释原只列了
    6 个固定 id，`serviceForm.test.tsx` 的 label 关联用例也只校验 6 个，第 7 个输入
    `#service-health-target`（可访问名「健康探测目标」）当时没被守住。现已在文件头注释与
    测试的 id 表里补上（用例名同步改为"七个输入"）。
13. **归档时发现的三处"文档与实现不一致"——其中两处已在本次提交内修正**：
    - `03-server-modules.md`：`listBindings` 改为 `(serviceIds?) => ServiceBinding[]`（实现返回扁平
      数组，按服务分组在服务层），`uniqueSlug` 改为 `(base) => string`（无 `excludeId` 参数）；
    - `02-configuration.md`：补回 §3 Docker 变量表被删掉的分隔行 `| --- | --- | --- |`
      （原会导致该表不渲染），并把 `DISCOVERY_CACHE_TTL_FALLBACK_MS = 5000` 兜底值、
      `HEALTH_RESULT_LIMIT = 512` 与"响应体读满即 cancel"一起补成常量表；
    - `web/src/api/types.ts` 导出的 `ServiceReorderRequest` 在 `web/` 内仍零引用
      （`client.ts` 的 `reorderServices` 用的是内联对象数组类型）—— 属类型镜像的冗余导出，
      保留不影响行为，不再单独修。

### 新增文档

- `docs/sprint1-implementation-spec.md` — Sprint 1 冻结设计契约（**唯一实现依据**；发现契约有问题先改它）。
- `IMPLEMENTATION_REPORT_S1.md` — 索引级实施报告：交付概览、迁移 v4 与回滚、升级步骤、
  验收记录（含真实库演练与实机发现验证）、风险清单、未做项。
- 同步更新的既有静态文档（内容**不在本条重复**，只在此列出以便追溯）：
  `01-architecture.md`（服务层分层）、`02-configuration.md`（无新环境变量）、
  `03-server-modules.md`（模块与仓储函数表）、`04-api-contract.md`（§6.5 / §6.6）、
  `05-web-modules.md`（页面与组件契约）、`06-security.md`（SSRF 与图标 CSP）、
  `07-data-model.md`（迁移 v4 逐列）、`08-operations.md`（§7.1 升级回滚、§10 备份修正）。

---

## [2026-10-16] 修复：Sprint 1 验收驳回的三个发现层缺陷（多副本 / 冲突路由 / 重复 serve）

### 背景与目标

第一轮验收的自动化门禁全绿（单测 565 例、E2E 9 例、类型检查、生产构建、Compose 解析），
但**手工复现真实场景**时驳回了两个 P1。复核后发现三个缺陷同源：

> **"归属与身份的聚合"没做到底** —— 内存里的规划看着对，一旦真的落库（唯一约束）
> 或生成视图（视图阶段重新推断归属）就露出来。

这是 S1-01（稳定身份）与 S1-02（归属与去重）的核心契约问题，不是边角。
更值得记的是：**旧用例把错误行为锁死了** —— 有一条用例断言"副本服务有 2 份绑定"，
所以单测全绿却挡不住线上直接失败。这一轮的每条回归用例都验证过
"在修复前的代码上必然失败"。

### 变更概览

| 文件 | 类型 | 改了什么 |
| --- | --- | --- |
| `server/src/modules/services/registry.ts` | 修改 | 副本按 `ref` 合并（代表容器优先"在运行"的）；抽出共享判定 `countHostPortClaimants` / `isServeRouteAttributable`；`serveRoutesForService` 空过滤时复用同一判定；收尾统一归一化 `(kind, ref)` 唯一 |
| `server/src/modules/services/service.ts` | 修改 | `serveRoutesForService` 调用处补传 `containers: live.items`（判定归属唯一性必需） |
| `server/tests/servicesDiscovery.test.ts` | 修改 | 重写"副本合并"用例的断言（2 份 → 1 份，并说明为什么）；新增副本落库、代表容器选择、冲突路由的视图层、重复 serve 路由共 4 条；3 处 `serveRoutesForService` 调用补 `containers` |
| `server/tests/servicesApi.test.ts` | 修改 | 假数据源改为可替换拓扑（`liveTopology` + `withTopology()` + 清理），新增 2 条端到端 P1 回归（多副本落库 / 冲突路由不被认领） |
| `web/src/pages/ServicesPage.tsx` | 修改 | 服务卡片网格加 `data-testid="service-grid"`（移动视口 E2E 的稳定锚点） |
| `e2e/smoke.spec.ts` | 修改 | 新增 390×844 移动视口用例（单列轨道、卡片不溢出、无横向滚动、命令面板不溢出） |
| `README.md` | 修改 | 测试规模 333/106 → 430/141 |
| `todo.md` | 修改 | 移动视口 E2E 待办改为已完成（并说明仍未覆盖"超长名截断"的视觉细节） |
| `docs/static/03-server-modules.md` | 修改 | `registry.ts` 行补两个新导出与两条不变量说明 |
| `IMPLEMENTATION_REPORT_S1.md` | 修改 | 新增 §2.10（本轮修复全过程与可区分性证据）、§7 风险 9/10、§6 数字更新 |

### 逐项明细

#### 修复 1（P1）：多副本服务让整个发现事务失败

- **现象**：`docker compose up --scale web=2` 之类产生两个共享 `sourceRef` 的副本容器时，
  `POST /api/services/discover` / `GET /api/services` 报
  `UNIQUE constraint failed: service_bindings.service_id, service_bindings.kind, service_bindings.ref`，
  发现事务整体回滚 —— 用户看到的是"服务墙挂了"，而不是"多一张卡片"。
- **根因**：`planDiscovery` 的容器循环里，绑定去重条件写成
  `item.ref === binding.ref && item.containerId === binding.containerId`。
  副本共享 `ref`（这正是稳定身份的设计）但容器 ID 必然不同 → 条件恒真 → 两份同 `ref` 绑定。
  而 `service_bindings` 的唯一约束是 `(service_id, kind, ref)`。
- **修法**：
  1. 副本合并只按 `ref` 去重，**一份绑定**；代表容器**优先取正在运行的那个**
     （`containerAvailabilityRank`：`running` < `restarting`/`created`/`paused` < 其它）——
     代表恰好是停掉的副本时，界面会显示"容器未运行"，让人去重启一个本来没事的服务；
  2. `planDiscovery` **收尾统一归一化**"每个服务里每个 `(kind, ref)` 只有一份绑定"。
     为什么收敛到一个出口：任何一处漏去重都会让**整个**发现事务回滚，
     而同类的"多推一份"在 serve 路径上也存在（见修复 3）。把不变量放一处，
     以后新增绑定来源不会再踩。

#### 修复 2（P1）：端口冲突的 serve 路由在视图阶段又被挂回第一个容器

- **现象**：`/conflict` 既是独立 serve 服务，又出现在 `docker:app-a` 的候选入口里
  （`serviceBindingRefs: ["docker:app-a"]` + 该路由被 `routesReattached`）。
  用户点到的是别人家的服务 —— 正是"多容器端口冲突不猜"要防的事。
- **根因**：发现阶段（`planDiscovery`）已经正确地否决了 mapper 的 owner，
  但**视图阶段**的 `serveRoutesForService()` 又凭原始 `route.containerId/containerName`
  认领回来，而那两个字段来自 `mapServeRoutes` 的 `containers.find(...)`
  —— **端口冲突时取第一个匹配**。
- **修法**：把"能不能归属"抽成共享纯函数
  `isServeRouteAttributable(route, containers)`（`countHostPortClaimants(...) === 1` 才可信），
  **发现阶段与视图阶段用同一个判定**。显式写在 `service.bindingRefs` 里的稳定 ref 不受影响
  —— 那是发现阶段确认过的结果，也是独立 serve 服务能显示自己入口的唯一依据
  （若把它也一并否决，独立服务会连自己的入口都没有）。
- `serveRoutesForService()` 因此多一个必填参数 `containers: readonly ContainerSummary[]`
  （内部签名，不是 HTTP 契约；唯一调用方 `service.ts` 已同步）。

#### 修复 3（同类）：重复的 serve 路由也会撞唯一约束

- `owner.bindings.push(binding)` 与独立 serve 服务的 `existing.bindings.push(binding)`
  **都没有按 ref 去重**：同一 `host/port/path` 出现两次（CLI 输出重复、或两条配置归一后相同）
  就会产生两份同 `ref` 的 serve 绑定。行为与 P1-1 完全同类。
- 由修复 1 的收尾归一化统一兜住；用例"重复的 serve 路由合并成一份绑定"锁住它。

#### 测试：为什么这轮能挡住，上一轮没挡住

- **旧用例锁死了错误行为**：`servicesDiscovery.test.ts` 原文断言
  `expect(web[0]?.bindings).toHaveLength(2)`（"副本容器合并成一个服务"，注释写着"只保留一份绑定记录"
  但断言是 2）。已重写为 1，并把"为什么必须是 1"写进注释 —— 这条断言本身就是契约的一部分。
- **新增 7 条回归**（server 单测 +2、API 端到端 +2、其余 3 条含在 discovery 文件里，见上表）。
- **每条都验证过可区分性**：用 `git stash push -- registry.ts service.ts` 退回修复前，
  5 条回归全部失败（`500 UNIQUE constraint failed`、
  `docker:app-a 不该认领冲突路由: expected [...] to not include '…/conflict'`、
  `expected [ { kind: 'serve', …(13) }, …(1) ] to have a length of 1 but got 2` 等），
  `git stash pop` 后全绿。
- **API 级用例的可重跑性**：新增 `liveTopology`（假数据源在**读取时**取当前拓扑）
  与 `withTopology()`（用完恢复 + 删掉这次临时拓扑新引入的服务 + 重新发现真实拓扑）。
  否则本文件所有用例共享一个内存库，临时拓扑会把后续用例的列表污染掉。

#### 非阻断缺口（一并补掉）

- `README.md` 的测试规模长期停在旧值（server 15 文件 / 333 用例、web 4 文件 / 106 用例），
  已更新为**当前实测值**：server 21 文件 / 430 用例、web 8 文件 / 141 用例。
- **移动端排版从未实测**（计划 §4 的验收项之一）：卡片是 Tailwind 断点驱动的
  （`grid sm:grid-cols-2 xl:grid-cols-3`），而 jsdom 不做布局、`getComputedStyle` 拿不到真实轨道数，
  所以必须有真浏览器用例。新增 `e2e/smoke.spec.ts` 的 390×844 视口用例：
  断言网格**单列**、首张卡片在视口内、`documentElement.scrollWidth - innerWidth <= 1`
  （无横向滚动）、命令面板不溢出且输入框可用。为此给网格加了 `data-testid="service-grid"`
  作为稳定锚点（按 Tailwind 类名选元素会在改样式时假失败）。

### 配置 / 接口 / 数据模型影响

- **环境变量**：无。
- **HTTP 契约**：无变化（这轮修的全是内部归属判定与绑定聚合）。
- **数据模型**：无迁移。**约束语义变得更加重要**：`service_bindings` 的
  `UNIQUE(service_id, kind, ref)` 是这轮修复的"裁判"，文档里已把它写成不变量而非实现细节。
- **内部签名**：`serveRoutesForService()` 新增必填参数 `containers`；
  新增导出 `countHostPortClaimants()`、`isServeRouteAttributable()`（见 `03-server-modules.md`）。

### 验证方式

```
npm run typecheck                      # exit 0（server + web）
npx vitest run --root server           # 21 文件 / 430 用例全绿
npx vitest run --root web              # 8 文件 / 141 用例全绿
npm run build                          # exit 0
npm run test:e2e                       # 10 用例通过（含移动视口用例）
# 可区分性：临时回退源码后，5 条回归用例全部失败（见"测试"小节）
git stash push -- server/src/modules/services/registry.ts server/src/modules/services/service.ts
git stash pop
```

### 已知限制 / 后续

1. **多副本只保留"代表容器"的一份绑定**：唯一约束决定了副本无法一行一个地存。
   现状是一个服务 + 一份绑定（优先正在运行的副本），服务的"容器运行"维度反映代表容器。
   代价：详情页看不到"另一个副本也在跑"。要列全需加列（如 `replicas` JSON）
   或给绑定 `ref` 加副本序号 —— 属 Sprint 2 的取舍，已写入 `IMPLEMENTATION_REPORT_S1.md` §7-9。
2. **`mapper.mapServeRoutes` 仍按 `containers.find(...)` 取第一个匹配**：既有 HTTP 契约未改，
   服务层已在**发现 + 视图**两处兜住。彻底修法是让 mapper 在冲突时返回 `null`，
   会改动既有字段语义，需单独评估（`todo.md` 已记）。
3. **移动视口的"超长服务名截断"等视觉细节仍未覆盖**：需要视觉回归工具（截图比对），
   本轮只断言了布局与溢出这类可精确判定的性质，暂不引入视觉回归依赖。
4. **未做**：`/dsh` 这类"目标不是容器"的 serve 路由在真实 NAS 上的呈现仍待 NAS 实机复核（同 Sprint 1 条目）。


---

## [2026-10-16] Sprint 2：历史趋势 + 健康监测 + 告警（S2-01…S2-04）

### 背景

Sprint 2 补两个具体缺口：**只有瞬时值、看不到历史**，以及**服务挂了没人知道**。四条 P1：
S2-01 指标存储（后台单例降采样）、S2-02 历史图表、S2-03 健康检查、S2-04 告警规则。
冻结契约在 `docs/sprint2-implementation-spec.md`（验收口径、响应形状、测试清单）。
三条并行开发线（服务端指标存储 / 健康与告警 / 前端）+ 集成裁决；接缝问题
（路由依赖签名、tick 结果类型、`/api/health/monitor` 前缀归属、后台 HostContext 的唯一定义）
在集成阶段统一处理，装配缺口由端到端用例兜住。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `docs/sprint2-implementation-spec.md` | Sprint 2 冻结契约（含 §1.1 预算判据、§7 响应形状、§10 测试清单） |
| 新增 | `server/src/modules/metrics/{types,buckets,collector,history,sampler,scheduler}.ts` | 指标采集与存储域：内存累积 + 分钟落库 + 整点滚动 + 保留清理 + 后台单飞调度 |
| 新增 | `server/src/modules/health/{types,state,monitor}.ts` | 三维健康状态机 + 探测节流与全局并发上限 |
| 新增 | `server/src/modules/alerts/{types,rules,engine,service}.ts` | 四条内置规则 + episode 引擎（触发/恢复/静默期重开）+ 规则与事件服务 |
| 新增 | `server/src/api/{metrics,alerts,healthMonitor}.ts` | 9 个新路由（见下） |
| 新增 | `server/src/modules/docker/backgroundContext.ts` | "没有访客"的 `HostContextRequest` **唯一定义**，两条后台线共用 |
| 修改 | `server/src/db/database.ts` | **只追加** v5 迁移 `metrics_alerts_schema`：3 表 + 4 索引（含部分唯一索引 `idx_alert_events_open`） |
| 修改 | `server/src/config.ts` `settings/registry.ts` `settings/service.ts` | 6 个新设置键（全 `live`）；**修掉 `groupList()` 手抄副本漏分组**导致设置页少渲染 6 个键的真 bug |
| 修改 | `server/src/modules/docker/{types,mapper}.ts` | `ContainerSummary.exitCode` + 映射 `State.ExitCode`（`null`=未知、`0`=正常退出，语义不可互换） |
| 修改 | `server/src/api/index.ts` `app.ts` `index.ts` | 路由依赖与保护前缀；装配采样器/监视器/引擎/调度器；`backgroundJobs` 只控制定时器 |
| 新增 | `web/src/api/{metrics,alerts}.ts`、`hooks/{useMetricsHistory,useAlertSummary}.ts`、`components/{MetricsChart,MetricPicker,AlertEventList,AlertRuleForm}.tsx`、`pages/{HistoryPage,AlertsPage}.tsx` | 历史页与告警页 |
| 修改 | `web/src/api/client.ts` `App.tsx` `layout/AppShell.tsx` | 客户端**纯新增**（+68/−0，未动既有方法）、两条路由、侧栏两个入口（未读 badge 是 NavLink 的**兄弟节点**，保持链接可访问名干净） |
| 新增 | `server/tests/{metricsBuckets,metricsSampler,metricsHistory,metricsApi,healthState,healthMonitor,alertEngine,alertsApi,backgroundBoundary,schedulerIntegration}.test.ts`、`web/tests/{metricsChart,alertsPage}.test.tsx` | 见"验证方式" |

### 关键决策（含被否决的方案）

1. **写事务频率：规格勘误。** 规格早期写"一小时的 tick 只产生 2 次批量写"，那是**算错的** ——
   漏了 flush 发生在**每个分钟边界**。真实是 30s 间隔下 **60 次 flush + 1 次整点 rollup = 61 次/小时**。
   实现按机制原文走，判据换成机器可证的三条：写事务数与 **tick 密度无关**（30s 与 5s 同样时长
   都是 1861）、整点那一 tick 恰好 2 次批量写、与前端会话数无关。
   **被否决**：攒到整点才 flush 能做到字面"2 次/小时"，但当前小时只在内存，重启最多丢 59 分钟、
   1h 视图整点前恒为空 —— 与"24h 每分钟 1 条""重启后历史保留"直接冲突。
2. **缺测不写 0。** 缺的分钟**没有行**，`samples < expected` 才标 `partial`；图上"没数据"与
   "真的是 0"必须能分开（写 0 会把采样失败画成 0% 占用，是**主动误导**）。
3. **多副本合并成一条序列。** `containerServiceRef` 对 compose 服务的所有副本返回同一 target，
   `expected = base × 副本数`（掉一个副本会正确显示 partial），`targetLabel` 只由 target 身份决定。
   **被否决**：每容器一条序列（前端按 `/api/services` 每服务推导一个 target，切过去会让历史错位）；
   也否决了"取名字最小的副本"（副本数 3→1 时同一条序列会反复改名）。
4. **`duration` 门控计时在内存。** 重启后重新计时（宁晚一轮，不误报）；抖动会立刻清零，不累积。
5. **`suppressed` 与 `reopened` 分开计。** `suppressed` 只在"未恢复行已存在"时计数，
   静默期内重新触发算 `reopened`（`reopen_count+1`，清空确认）；唯一来源是引擎的 `suppressedTotal()`。
   **后续更正（第二组收口，提交 `470ac16`）**：`suppressedTotal()` **已删除**，唯一来源改为
   引擎的**按 target 明细** `suppressedByTarget()`（读路径按当前可见性求和）—— 见本文件末条。
6. **"后台模块无出站能力"做成可执行约束。** `backgroundBoundary.test.ts` 扫描源码断言无
   `fetch`/`http.request`/`net.connect`/`child_process`/通知库/直连 docker.sock，
   且探测只发 GET 无请求体；并断言目标目录存在且非空（防止约束退化成永不触发的空扫描）。
7. **E2E 登录会话复用（不为测试放宽安全控制）。** 登录限流是硬编码的安全常量（10 次/分钟）。
   Sprint 2 新增两条用例后登录次数达 11 次/分钟，末尾用例被 429 挡在登录页。
   **没有**放宽限流，而是让每个角色只走一次真实登录表单，其余复用缓存会话，
   并在会话被"退出"撤销时自愈重登（缓存的令牌会被退出真正作废）。
8. **装配缺口：`AlertEngine` 必须接快照来源。** 不接则四条规则永远 `evaluated = 0` ——
   36 条单测全绿但**生产上任何告警都不触发**（引擎拿空快照时"正确地什么都不做"，
   既无异常也无日志）。已接 `createAlertSnapshotSource(...)` 并把"每轮结果回灌服务层"一并接上，
   同时补了端到端因果链用例，并用"只撤掉那一行接线"实测其判别力。

### 配置 / 接口 / 数据模型影响

- **设置键（6 个，全部 `effect: 'live'`）**：`PORTAL_METRICS_SAMPLE_INTERVAL_SEC`(30, 5–3600)、
  `PORTAL_METRICS_RETENTION_MINUTE_HOURS`(24, 1–168)、`PORTAL_METRICS_RETENTION_HOUR_DAYS`(30, 1–3650)、
  `PORTAL_METRICS_CONTAINER_LIMIT`(10, 0–100)、`PORTAL_HEALTH_PROBE_INTERVAL_SEC`(300, **0 = 关闭探测**)、
  `PORTAL_HEALTH_PROBE_CONCURRENCY`(4, 1–32)。
- **HTTP 契约（9 个新路由）**：`GET /api/metrics/{catalog,history,storage}`、
  `GET|PATCH /api/alerts/rules[/:id]`、`GET /api/alerts/events`、`POST /api/alerts/events/:id/ack`、
  `GET /api/alerts/summary`、`GET /api/health/monitor`。读接口 viewer 即可、无需 CSRF；
  写接口要求 admin + 有效 CSRF。`GET /api/alerts/rules` 响应是 `{ items: [...] }`（不是裸数组）。
- **数据模型**：迁移 **v5 `metrics_alerts_schema`**（纯追加）。`metric_buckets` 的
  `UNIQUE (resolution, metric, target, bucket_at)` 是"同一桶幂等重写"的裁判；
  `alert_events` 的部分唯一索引 `WHERE resolved_at IS NULL` 是"同一规则同一目标最多一行未恢复"的裁判
  （**不变量，不是实现细节**）。保留清理边界含等号。
- **内部签名**：`tickOnce(now?)`、`MetricsTickResult`、`MetricStorageView`、`AlertTickResult`、
  `HealthTickResult`、`backgroundHostRequest(config)`（见 `03-server-modules.md`）。

### 验证方式

```
npm run typecheck                      # exit 0（server + web）
npm test                               # server 31 文件 / 594 用例；web 10 文件 / 172 用例
npm run build                          # exit 0
npm run test:e2e                       # 12 用例通过（含 Sprint 2 的历史/告警与 viewer 只读）
# 真实库副本迁移演练（只读源 → 临时副本）：v4→v5、v3→v4→v5 各 15/15 通过
node migrate-rehearsal-s2.mjs portal-v4-fixture.sqlite portal-live-pre-sprint1.sqlite
# 判别力：只撤掉 app.ts 里 AlertEngine 的 snapshot 接线 → 端到端告警用例红在 evaluated > 0
```

### 已知限制 / 后续

1. **不做外发通知、不做自动修复**（Sprint 4 才加通知渠道）；告警"确认"只在界面内，
   引擎本身不做任何出站调用，也不重启/停止任何容器。
2. `container_exit` 规则依赖 `State.ExitCode`：**未知退出码不告警**（`null` 与 `0` 都沉默，
   但语义不同，不许互相伪装）；`dead` 状态仍可直接触发。
3. **多副本"另一个副本也在跑"仍不可见**（同 Sprint 1 已知限制，绑定只留代表容器）。
4. `e2e/**` 仍不在类型检查内（`todo.md` 技术债）；本轮 E2E 又踩到一次"断言写错但类型检查无感"。
5. **尚未部署到 NAS**：生产仍是 Sprint 0 镜像，Sprint 1 + Sprint 2 待一起部署验收。

---

## [2026-10-16] 修复：Sprint 2 验收驳回的三个 P1（健康监视器泄漏 / 历史指标绕过可见性 / 测试依赖墙钟）

### 背景与目标

Sprint 2 提交后，用户手工复现真实场景**驳回了三个 P1**。三条同属一类：

> **"看得见什么"这件事只做了一半就被当成做完了。**
> 采集侧固定 viewer 视角看着很安全，但**读侧**与**清理路径**各自留了一个缺口；
> 而测试因为把"跑测试的真实时刻"当输入，既挡不住这些缺口，自己还会时红时绿。

第一条与第二条是**同一个泄漏面的两半**（隐藏服务的名字与曲线），第三条是**测试自身的可判别性**问题
——它正好解释了为什么前两条能一路通过自动化门禁。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `server/src/modules/health/monitor.ts` | 新增 `ServiceListViewResult`（`ok` 判别位）、`visibleRefs`、`isVisible()`；`loadServices()` 区分"读失败/契约破损"与"成功读到空列表"；成功即（含空列表）更新可见集合并 `dropStaleStates()`（**同时删 `labelsByRef`**）；`states()` / `state()` / `view()` 按可见集合过滤 |
| 修改 | `server/src/modules/metrics/sampler.ts` | 新增 `visibleServiceRefs()`（**每次读都查注册表、刻意不缓存**）、`isHostOwnedTarget()`、`targetVisible()`；`availableTargets()` / `resolveTarget()` / `catalog()` 改 async 并按**当前**可见性过滤；`resolveTarget()` 在**任何存在性查找之前**先过可见性；注册表读失败 **fail-closed** |
| 修改 | `server/src/api/metrics.ts` | `await deps.metrics.resolveTarget(...)`；注释写明"不可见与从未采集过走同一条 400 分支、刻意不用 404/403" |
| 修改 | `server/tests/healthMonitor.test.ts` | 新增 4 条（现 21 条）：成功读到空列表必须清状态**与服务名**；删空 ≠ 降级；读失败保留旧状态且 notes 说明；**读路径纵深防御**（绕过 `dropStaleStates` 直接塞回不可见状态） |
| 新增 | `server/tests/metricsVisibility.test.ts` | **13 条**，全走 `buildApp()` + `app.inject()`（真实路由 / 会话 Cookie / CSRF / SQLite），夹具是**真的采集**；隐藏后 catalog 不列、history 与陌生 target **逐字节一致**、admin 同样不可见、宿主指标不受影响、恢复可见后曲线与隐藏前逐字段相同、删除与"曾采过的容器序列"同样受控 |
| 修改 | `server/tests/schedulerIntegration.test.ts` | 起点由固定 `EPOCH` 推出（原 `minuteStart(Date.now()/1000) - 3600` **必然横跨一个整点**）；三个数据源换成注入假夹具；序列数从区间断言收紧为等号；新增**跨整点用例**（22:59:30 → 23:00:30） |
| 修改 | `server/tests/metricsApi.test.ts` | `vi.setSystemTime(EPOCH * 1000)` + 三个假数据源；原 `Date.now()` 与"用墙钟推导保留截止时刻"全部改为固定量；显式断言"本夹具不跨整点" |
| 新增 | `server/tests/clockBoundary.test.ts` | **4 条**：把"这两条线只许用固定 epoch"变成可执行约定（扫源码禁止 `Date.now(` / `new Date(` / `performance.now(`；必须声明同一个 `EPOCH`；必须注入三个数据源；受约束文件缺失或为空时用例必须失败） |
| 修改 | `docs/static/{03,04,06,09}.md`、`todo.md`、`IMPLEMENTATION_REPORT_S2.md` | 本次归档 |

### 逐项明细

#### 修复 1（P1）：健康监视器把已隐藏的服务状态与服务名永久留在内存

- **现象**：把服务全部隐藏（或删除）之后，`GET /api/health/monitor` 仍然列出它们，
  `services[].label` 就是服务名 —— 用户的"隐藏"被后台绕过。
- **根因**：`tick()` 里写的是 `if (tracked.length > 0) this.dropStaleStates(tracked);`。
  `loadServices()` 把"`list()` 抛错"与"成功读到空列表"都返回 `[]`，
  于是**成功读到空列表**（= 用户把服务全隐藏/全删了）与"这次没读到服务列表"不可区分，
  而条件 `tracked.length > 0` 让两者**都**跳过 reconcile → 旧状态与旧服务名永久留存。
  即使 reconcile 被执行，`dropStaleStates()` 原来也只删 `statesByRef`，
  **`labelsByRef` 里的服务名不受影响** —— 名字照样能从视图里取出来。
- **修法**：
  1. `loadServices()` 返回带判别位的 `ServiceListViewResult`：`list()` 抛错或响应缺 `items`
     数组 → `{ ok: false }`；正常返回（哪怕 `items` 为空）→ `{ ok: true }`。
     **不靠"数组是否为空"事后猜** —— 用户隐藏掉最后一个服务时 `items` 同样是空数组。
  2. `if (loaded.ok)` 才更新 `visibleRefs` 并 `dropStaleStates(tracked)`：**空列表也走全清**，
     且 `dropStaleStates()` 同时删 `statesByRef` 与 `labelsByRef`（名字与状态同生同灭）。
  3. 读失败时**不碰**任何既有状态、`visibleRefs` 保持不变，原因写进 `lastRegistryError`
     → 由 `view().notes` 的"服务列表不可用：…"说明（取数抖动 ≠ 服务消失）。
  4. **纵深防御**：新增 `visibleRefs` + `isVisible()`，`states()` / `state()` / `view()` 都过滤
     不在最近一次成功读取集合里的状态。`visibleRefs === null`（还没成功读过）时不过滤（无数据可漏）。
     **语义收紧**：`state(ref)` 对不可见 ref 现在返回 `null`。
- **验证**：`healthMonitor.test.ts` 新增 4 条，其中"读路径纵深防御"一条**故意绕过 reconcile**
  往 `statesByRef` / `labelsByRef` 里塞回一个不可见的 `docker:ghost`，断言三个读出口都不发出它
  —— 只修写路径的版本在这条用例下会红。另有一条断言 `JSON.stringify(view())` 里
  **连服务名都不出现**（比"字段为空"更严）。

#### 修复 2（P1）：历史指标读接口绕过当前可见性

- **现象**：一个服务被采集过、随后被隐藏，viewer 仍能在 `/api/metrics/catalog` 里看到它的
  target 与 `targetLabel`（= 服务名），并能在 `/api/metrics/history` 里查到它的完整曲线，
  直到历史数据过期（分钟桶 24h / 小时桶 30d）。
- **根因**：采集侧固定 `role: 'viewer'` 只保证"隐藏之后不再产生新样本"。
  **隐藏之前**已落库的 `metric_buckets` 行与进程内 `liveTargets` 仍然带着服务名，
  而读路径 `availableTargets()` 直接遍历 `repo.listTargets()`、`resolveTarget()` 直接查存在性，
  **两处都没有核对当前 hidden**。这是"读取侧"整半缺失。
- **修法**：
  1. 新增 `visibleServiceRefs()`：用与采集**同一个** `backgroundHostRequest(config)` 调
     `registry.list(request, {}, 'viewer')`，返回可见 `sourceRef` 集合；
     **读失败返回 `null`**，调用方按 **fail-closed** 处理。
  2. 新增 `isHostOwnedTarget()`（`targetKind ∈ {host, disk}`）与 `targetVisible()`：
     宿主/磁盘恒可见（响应不变），服务/容器类必须命中当前可见集合，
     `visible === null` 一律不可见。
  3. `availableTargets()` 过滤候选，并且**只在真的存在非宿主 target 时**才查注册表
     （纯宿主/磁盘目录完全不变）；`resolveTarget()` 在**任何存在性查找之前**先过可见性
     —— 否则"库里曾经有过"本身就是存在性证据。
  4. `catalog()` / `availableTargets()` / `resolveTarget()` 因此变成 **async**；
     路由层 `await` 之（`api/metrics.ts`）。
- **为什么"不可见"必须与"从未采集过"完全一致**：两者都返回 `null` → 同一个 400
  `VALIDATION_FAILED` + `details.targetPattern`。**刻意不用 404/403、也不加任何区分字段** ——
  那等于向调用者承认"这个目标存在，只是你看不到"。
- **代价（有意取舍，写在源码注释里）**：`visibleServiceRefs()` **不做任何缓存**
  （"任何 TTL 都是泄漏窗口"），因此每次 catalog 与每次服务类 history 读都会查一次注册表。
  默认 `PORTAL_CACHE_CONTAINERS_TTL_MS = 2000` 时由注册表既有的 TTL 缓存吸收（不产生 Docker 调用，
  并发读被 single-flight 合并）；该 TTL 允许设为 0（不缓存），那时每次读都会真的跑一遍服务发现。
- **验证**：`metricsVisibility.test.ts`（13 条，真实路由 + 真实鉴权 + 真实 SQLite）。
  关键断言是"抹平调用者自己传入的 target 串后，隐藏目标的响应体与陌生 target 的响应体
  **逐字节相同**"，以及 `Object.keys(error)` 集合相同 —— 任何区分字段都会在这里红。
  **判别力（修复方实测，归档时未复跑）**：临时关掉读路径过滤后，13 条里 12 条依赖可见性的用例有
  **6 条变红**。

#### 修复 3（P1）：两条服务端测试用墙钟构造起点，必然/可能横跨整点

- **现象**：同一份代码在一天里时红时绿。
  `schedulerIntegration.test.ts` 的 `BASE = minuteStart(Math.floor(Date.now()/1000)) - 3600`
  **必然横跨一个整点**，`BASE + 60` 跨过整点后整点滚动凭空多出 hour 行，
  而断言写的是"总行数 === 本轮 flush 的行数" → 实测出现 `10 === 5`；
  `metricsApi.test.ts` 用 `Date.now()` 取 T0、并用墙钟推导保留截止时刻，
  23:01 跑时 T0 已落到上一个整点，hour 桶被滚出来而断言仍写着"hour 窗口为空"。
- **根因**：起点来自真实墙钟 = **"跑测试的真实时刻"成了输入**；同时断言依赖真实宿主采样器与真实 Docker
  （"这台机器恰好有没有 CPU 基线、有没有 Docker"也成了输入）。
  这类缺陷不编译报错、不运行抛错，只在某些时刻红，靠"重跑一次看看"几乎定位不到。
- **修法**：
  1. 两条线改用**固定 epoch** `EPOCH = 1_700_000_000`（= `2023-11-14T22:13:20Z`）：
     `schedulerIntegration` 的 `BASE = hourStart(EPOCH) + 15min`（与 `BASE+60` / `BASE+120` 同处一小时），
     `metricsApi` 用 `vi.setSystemTime(EPOCH * 1000)` 把被测进程的读侧时钟钉住。
     取值只要求"好算、落在整点内"，**不是为了回避边界**（注释里明写）。
  2. 三个"外部世界"（`ctx.system.snapshot` / `ctx.containers.list` / `ctx.services.list`）
     **全部**换成注入假夹具 → 一次采集的序列数是确定值，断言从区间收紧为等号
     （`schedulerIntegration` 的 `HOST_SERIES = 5`）。
  3. 每个"本该没有 hour 行"的地方都**显式断言 `hoursRolledUp === 0`**，不再靠"恰好没跨"。
  4. **跨整点从"随机撞上"变成"被测行为"**：新增用例 22:59:30 → 23:00:30，
     断言 minute 落 5 行、22 点滚出 5 行 hour（`samples = 1` / `expected = 60` / 值等于唯一读数）、
     总行数 = 5 + 5、未结束的 23 点**不许提前滚出**、同整点重复 tick 不重复滚。
  5. 新增 `clockBoundary.test.ts` 把这套约定变成**可执行约束**：扫这两个文件的源码
     （去注释后）禁止 `Date.now(` / `new Date(` / `performance.now(`；必须声明同一个 `EPOCH`
     并写明"为了确定性、不是为了回避边界"；必须注入三个数据源；
     **受约束文件不存在或为空时用例必须失败**（否则一次重命名就让守卫退化成空断言）。
- **顺带发现的真问题（不是测试问题，是装配顺序）**：`buildApp` 内部会跑
  `settings.initialize()`，它把设置表/环境变量层的值**就地写回同一个 `config` 对象** ——
  于是测试传进去的 `metrics.sampleIntervalSec = 5` 会被"设置默认值 30"取代
  （实测 `expected` 从 12 悄悄变成 2）。`schedulerIntegration.test.ts` 因此在 `openApp` 里
  把生效值显式钉回 5 并写明原因。**这不是本轮要修的产品缺陷**，但它是一条值得记住的接线语义：
  后台模块每次读 `config` 才拿到"最新值"（这是 `live` 生效的实现方式），
  因此任何"先在 config 上改一个值、再 `buildApp`"的写法都可能被 `settings.initialize()` 覆盖。

#### 归档与文档

- `03-server-modules.md`：`sampler.ts` 的函数表与新增"读路径的可见性"小节（含三条 why 与代价）、
  新增 `ServiceListViewResult` / `visibleRefs` / `isVisible` 表与"成功读到空列表必须清理"逐分支表、
  `monitor.ts` 的状态淘汰与 notes 行改写（原文写着"仅在服务列表非空时执行"—— 那正是被驳回的行为）、
  `api/metrics.ts` 与 `api/healthMonitor.ts` 的行、§5 测试表。
- `04-api-contract.md`：§6.7 新增"可见性语义（不变量）"小节（不可枚举 / 不可查询 / 不泄漏存在性 /
  没有 404·403 / 不做角色特例 / 宿主不受影响 / 隐藏≠删除数据 / fail-closed / 代价）、
  catalog 与 history 的参数与边界、§6.8 健康监测的可见性语义。
- `06-security.md`：§3 后台任务表新增"读取侧的可见性强制"行与"不变量：双重落实"表、
  "冻结三件事"第 3 条改写、§9 残余风险第 10 条改写并**新增第 11 条**（告警读路径仍未收口，见下）、
  §10 清单新增一条。
- `todo.md` / `IMPLEMENTATION_REPORT_S2.md`：勾掉三条 P1 并记录未做项与残留风险。

### 配置 / 接口 / 数据模型影响

- **环境变量**：无新增、无默认值变化。
- **数据模型**：无迁移。**历史行一条都不删** —— 隐藏只是访问受控，
  重新可见后曲线与隐藏前逐字段相同（有用例断言）。
- **HTTP 契约**：路径、方法、权限、字段名全部未变。**语义收紧两处**：
  ① `/api/metrics/history` 的 target 闸门多一条"当前可见性"，
  不可见目标与陌生目标返回**完全一致**的 400（仍带 `details.targetPattern`，**没有** 404/403）；
  ② `/api/health/monitor` 的 `services[]` 只含当前可见服务，`state(ref)` 对不可见 ref 返回 `null`。
- **内部签名**：`MetricsSampler.availableTargets()` / `resolveTarget()` / `catalog()` 由同步改为
  **async**（唯一调用方 `api/metrics.ts` 已 `await`）；
  `HealthMonitor.loadServices()` 返回类型改为 `ServiceListViewResult`；新增三个私有成员。

### 验证方式

```
npx vitest run tests/clockBoundary.test.ts tests/healthMonitor.test.ts \
  tests/metricsVisibility.test.ts tests/metricsApi.test.ts \
  tests/schedulerIntegration.test.ts --root server
# → Test Files 5 passed (5)；Tests 59 passed (59)
#   clockBoundary 4 / healthMonitor 21 / metricsVisibility 13 / metricsApi 14 / schedulerIntegration 7
#   （归档时刻实测：2026-10-16 23:15；全库 `npm test` 由父任务在提交前跑）

# 判别力（修复方实测，本轮归档未复跑）
#   临时关掉读路径可见性过滤 → metricsVisibility.test.ts 13 条里 12 条依赖可见性的用例有 6 条变红
#   clockBoundary.test.ts 的守卫：往受约束文件里加一行 `Date.now()` 即红
```

### 已知限制 / 后续（照实记录，未在本次修复中解决）

1. **`visibleServiceRefs()` 的 fail-closed 分支没有单测**：现有用例都通过"真隐藏 / 真删除"走到
   `visible = Set(...)` 的路径；"注册表抛错 → 服务类 target 全部不可见、宿主指标不受影响"
   目前只有实现与注释，**没有可区分性证明**。补法很简单（注入一个抛错的 registry 走真实路由），
   本轮未做 —— 已记入 `todo.md`。
2. **告警读接口是同一类泄漏面上仍未收口的一块**：`/api/alerts/events` / `summary` 返回的
   `target`（`service:<sourceRef>`）与 `target_label`（服务展示名）是**触发时**写进
   `alert_events` 的，不随可见性变化 → 隐藏前产生的告警事件仍会带出服务名；
   隐藏后 `health.states()` 不再包含该服务，引擎"目标不在快照里 → 不动，不假恢复"的既有语义
   又让它的未恢复告警**停在未恢复状态**。本轮范围只覆盖 `metrics/*` 与 `health/monitor`。
   详见 `06-security.md` §9-11 与 `todo.md`。
3. **`state(ref)` 语义收紧的连带影响**：`MetricsSampler.verdictOf` 走
   `health.state(ref)?.verdict ?? 'unknown'`，因此"不可见"在采样侧表现为 `unknown` → 该 tick
   **不产生样本**（不是写 0，方向安全）；`AlertEngine` 的快照用 `health.states()`，
   因此隐藏服务会从告警快照里消失（即上文第 2 条的"停在未恢复"）。两个模块的可见性口径
   由此绑在一起，改任一处都要一起看。
4. **每次读都查一次注册表**：默认 TTL（2s）下由注册表既有缓存吸收，但
   `PORTAL_CACHE_CONTAINERS_TTL_MS = 0`（合法的"不缓存"取值）时，每个
   `/api/metrics/catalog` 与每个服务类 `/api/metrics/history` 都会真的跑一遍服务发现。
   这是**有意的**安全优先取舍，不是疏漏；若将来要优化，**不能**用"给可见性加 TTL"的办法。
5. **`docs/sprint2-implementation-spec.md` §3.1 的方法签名清单已过期**（仍写着
   `availableTargets / resolveTarget / catalog` 的同步形态）。冻结规格本轮未改，
   已记入 `todo.md`；`03-server-modules.md` 与 `04-api-contract.md` 按实现为准。
6. **未在本轮复核的既有台账**：`README.md` 的测试规模数字仍是 Sprint 2 提交时的值
   （本轮新增 2 个测试文件、新增 21 条用例：13 + 4 + 4），且 `03-server-modules.md` 里
   `metricsSampler.test.ts` 等既有条目的条数未逐个重数。已记入 `todo.md`。

---

## [2026-10-16] 修复：收口告警读接口的可见性泄漏（同类问题第三处）

> 代码改动已在提交 **`871c3dc`**（工作区干净，本条目只补文档；上一轮的同类修复是 `734da64` + 文档 `daca355`）。

### 背景与目标

上一轮归档时自查发现：**同一类泄漏还有第三处，而且这一处比前两处更硬** ——
前两处泄漏的是"库里曾经有过的行"（内存状态 / 历史桶），这一处泄漏的是**事件快照里的名字**，
并且**计数本身就是存在性证据**：

- `alert_events` 的 `target`（`service:<sourceRef>` / `container:<sourceRef>`）、
  `target_label`（服务展示名 / 容器名）与 `message` 是**触发那一刻**由 `createAlertSnapshotSource`
  填好落库的，**不随可见性变化**；
- 于是服务被隐藏（或删除）之后，viewer 仍能在 `GET /api/alerts/events` 读到它的名字；
  更糟的是 `GET /api/alerts/summary` 的 `open` / `unacknowledged` / `bySeverity` / `top`
  仍把它的未恢复事件算在内 —— **"未恢复从 3 掉到 2"就告诉 viewer 少了一条什么**；
- 另一条既有语义在隐藏后继续作用：`health.states()` 不再包含该服务，引擎
  "目标不在快照里 → 不动，不假恢复"让它的未恢复事件**停在未恢复状态**。

目标：把冻结契约"hidden 服务不得经读接口泄漏、且不泄漏其存在性"扩展到告警读路径，
并借这次把"当前可见服务集合"的读取抽成**唯一实现**，让历史指标与告警共用 ——
同类问题已经各写两遍，第三遍不能再来一次。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 新增 | `server/src/modules/visibility/serviceVisibility.ts` | 读路径可见性的**唯一实现**：`loadVisibleServiceRefs`（`registry.list(request, {}, 'viewer')` + `backgroundHostRequest(config)`，**刻意不缓存**，注册表读失败返回 `null`）、`serviceRefOfTarget`、`isServiceTargetVisible`、两个 target 前缀常量与 `ServiceVisibilityDeps` |
| 修改 | `server/src/modules/metrics/sampler.ts` | `visibleServiceRefs()` 改为委托 `loadVisibleServiceRefs`（`source: 'metrics.read'`）；`targetVisible()` 改用 `isServiceTargetVisible`（`kind` 由 `metricByKey(...).targetKind` 推出）。**行为逐字未变**（含宿主/磁盘短路条件），只是实现搬了家 |
| 修改 | `server/src/modules/alerts/service.ts` | 新增 `AlertEventVisibility`、`alertEventVisibilityWhere()`、私有 `eventWhere()`；`events(query, visible)` / `summary(visible)` / `counts(visible)` **在 SQL 层**按当前可见集合过滤；`acknowledge()` 刻意不动 |
| 修改 | `server/src/api/alerts.ts` | `/events` 与 `/summary` 每请求先经内部 `loadAlertsVisibility()` 取一次可见集合；`AlertRoutesContext` 新增**可选** `config` / `services` / `logger`（缺任一 → fail-closed + warn，不抛 5xx）；`/rules` 与 `ack` 注释写明**本轮不收口**的理由；**不实例化 `MetricsSampler`** |
| 新增 | `server/tests/alertsVisibility.test.ts`（**15 条**） | 全走 `buildApp()` + `app.inject()` 真实路由 / 鉴权 / SQLite；覆盖隐藏前→隐藏→恢复可见→fail-closed 四段与两条纯函数边界 |
| 修改 | `server/tests/alertsApi.test.ts` | **只调夹具，未削弱或删除任何既有断言**：`/events` 用例补一行可见 docker 服务；`/api/alerts-unwired` 改传真实 `handle.ctx` |
| 修改 | `docs/static/{03,04,06,09}.md`、`todo.md`、`IMPLEMENTATION_REPORT_S2.md` | 本次归档 |

### 逐项明细

#### 1. 新增共享模块 `server/src/modules/visibility/serviceVisibility.ts`

- `loadVisibleServiceRefs({ registry, request, source, logger? })` — `registry.list(request, {}, 'viewer')`
  → 可见服务 `sourceRef` 集合；**读失败返回 `null`**（不是空集合：`null` 与"一个可见服务都没有"
  必须给出相反结论）。三条刻意保持的行为（源码注释写明"不要在这里优化"）：
  **不缓存**（任何 TTL 都是泄漏窗口）、**fail-closed**、**不分角色**（固定 `viewer`，admin 无特例）。
- `serviceRefOfTarget(target, kind?)` — `service:<ref>` / `container:<ref>` → `<ref>`；
  `host` / `disk:<label>` / 未知前缀 → `null`。传了 `kind` 会**顺带校验前缀与类型对得上**。
- `isServiceTargetVisible(target, visible, kind?)` — `visible === null` 一律 `false`；
  非服务 target 也返回 `false`（"宿主可见"是调用方的策略，不是这里的默认值）。
- **`ServiceVisibilityRegistry` 用结构类型**：只需要 `list()`，传真实 `ServiceRegistryService` 实例即可。

#### 2. 历史指标侧：实现搬家，行为不变

`MetricsSampler.visibleServiceRefs()` / `targetVisible()` 的逻辑**一个字没改语义**，
只是改为调用共享函数；`hostRequest` 仍是采集用的同一个 `backgroundHostRequest(config)`，
`source` 变成 `'metrics.read'`。原有的 `metricsVisibility.test.ts` 13 条**一条未改**且全绿 ——
这是"搬家没搬坏"的证据。

#### 3. 告警侧：SQL 层过滤（不是取出来再筛）

- `alertEventVisibilityWhere(visible)`（**导出、纯函数**）返回 `AND` 用的条件 + 位置参数：
  - `visible === null`（不可得）或空集合 → 只放行宿主自有事件
    `(target NOT LIKE 'service:%' AND target NOT LIKE 'container:%')`；
  - 有集合 → `(宿主 OR (kind = 'service_health' AND target IN (…service:…)) OR (kind = 'container_exit' AND target IN (…container:…)))`，
    参数顺序**先 service 分支再 container 分支**（必须与占位符顺序一致）。
  - 判据用 **target 前缀**而不是 `kind`：泄漏面由 target 决定（名字就在 `target` / `target_label` 里）；
    再叠一次 `kind` 校验，于是"kind 说是磁盘、target 却指向服务"的手工脏行也落不进可见集合。
- `eventWhere(state, visible)`（私有）保证**可见性条件总是在**，因此不存在"忘了加可见性"的写法。
- **为什么"先过滤再 LIMIT"**：`limit` 必须作用在可见集合上，否则首页会被不可见事件占位，
  出现"看得见的事件反而翻不到"（夹具里最新的一条恰是服务事件，隐藏后 `limit=1` 仍返回
  最新那条**可见**事件）。
- **为什么计数也要过滤**：`total` / `counts` / `bySeverity` / `top` 一起只统计可见集合 ——
  **计数本身就是存在性证据**；只过滤 `top` 而留着计数，等于用数字告诉 viewer
  "有一条你看不见的未恢复告警"。`summary` 的四个计数全部走同一条 `eventWhere`。
- **admin 口径沿用 metrics 已定的一条**：路由**没有角色分支**，可见集合固定 `role: 'viewer'`，
  因此 **admin 打这两个接口同样看不到**可见集合外的事件（`metricsVisibility.test.ts` 已钉过该口径，
  本轮对告警补了同样的断言）。

#### 4. fail-closed：来源不可得时收紧，而不是放行

- 注册表读失败 → `loadVisibleServiceRefs` 返回 `null` → 服务/容器类事件**一律不可见**，宿主类照常。
- 装配缺 `config` / `services`（单独挂载 `api/alerts.ts` 的测试场景）同样按 `null` 处理，
  只记一条 warn：读接口失败会变成 5xx，而正确行为是"少显示几条"，不是"整个告警页打不开"。
- **测试覆盖**：`alertsVisibility.test.ts` 把 `handle.ctx.services` 换成**必抛桩**走真实路由，
  断言事件列表与摘要都只剩宿主事件、且整段 JSON 无泄漏串；还原后恢复原样
  （证明失败态不是"过滤被永久关掉"）。共享函数另有两条纯函数边界用例。
  这条补上了上一轮记的"`visibleServiceRefs()` 的 fail-closed 分支没有单测"。

#### 5. 刻意不动引擎语义（写在源码注释里，不要"顺手修"）

隐藏一个服务**不会**动它的未恢复事件行：`resolved_at` 仍为 NULL、episode 不变量与静默期判定
完全不变。结果是"库里仍未恢复、viewer 看不见" —— 有意的组合语义：告警引擎的事实
（服务确实在故障）与读侧的暴露面（谁允许看到）是两件事。恢复可见后**同一事件原样回来**
（行没被删、状态没被改）。反过来，只要引擎还认为目标在故障中，就不会因为"读侧看不见"而假恢复 ——
那会把真实故障从运维视野里抹掉。运维含义：**读响应里的未恢复列表不等于库里的未恢复故障全集**。

#### 6. 判别力实验（两个，临时代码已撤除并 grep 确认无残留）

| 实验 | 结果 |
| --- | --- |
| **完全不过滤**（临时去掉可见性条件） | 新文件 15 例中 **12 例红** |
| **只让 `counts` 不过滤**（只回退计数这一处） | **9 例红** |

第二个实验正是"计数也是证据"的可区分性证明：只修列表的版本过不了。

### 配置 / 接口 / 数据模型影响

- **环境变量**：无新增、无默认值变化。
- **数据模型**：无迁移。**事件行一条不删、状态一列不改**（恢复可见后原样回来，有用例断言）。
- **HTTP 契约**：路径、方法、权限、**字段名全部未变**。**语义收紧两处**：
  ① `GET /api/alerts/events` 的 `items` / `total` / `counts` 只统计当前可见集合，
  `limit` 改为作用在过滤之后；② `GET /api/alerts/summary` 的 `open` / `unacknowledged` /
  `bySeverity` / `top` 只统计当前可见集合。宿主类（`host` / `disk:*`）事件不变。
- **内部签名**：`AlertsService.events(query, visible)`、`summary(visible)` 新增**必填**的可见性参数
  （类型上没有"省略 = 不过滤"）；新增导出 `AlertEventVisibility` / `alertEventVisibilityWhere`；
  `MetricsSampler` 的两个私有成员改为委托（签名不变）。
- **代价（照实记）**：`summary` 徽标每 60s 轮询各多一次 `registry.list`
  （内部走服务注册表既有的发现 / 容器 TTL 缓存与 single-flight；该 TTL 允许设为 0，那时会真跑服务发现）。

### 验证方式

```
npx vitest run tests/alertsApi.test.ts tests/alertsVisibility.test.ts tests/alertEngine.test.ts --root server
# → Test Files 3 passed (3)；Tests 78 passed (78)
#   alertsApi 27 / alertsVisibility 15（新）/ alertEngine 36
#   （本次归档时刻独立复跑，2026-10-16 23:34；修复方另称连续 5 次全绿）

# 修复方实测（提交信息记载，本次归档**未复跑**）：
#   server 全量 34 文件 / 631 用例全绿；typecheck / build / E2E 全绿
# 判别力（修复方实测，归档未复跑）：完全不过滤 → 15 例中 12 红；仅 counts 不过滤 → 9 红
```

### 已知限制 / 后续

1. **两处未收口、待裁定**（照实记，不要写成已修）：
   ① `GET /api/alerts/rules` 的 `rule.target` —— 管理员自己写的规则配置（不是触发快照），
   按可见性抹成 `null` 会让 viewer 看到一份与实际规则不一致的配置；
   ② `POST /api/alerts/events/:id/ack` 的**响应体** —— admin 写路径，入参是随机 UUID 的事件 ID，
   要拿到隐藏服务事件的 ID 得先有别的泄漏渠道。本轮收口范围是**读**响应。
2. **残留观察**：`summary` 的 `suppressed` / `evaluatedAt` 取自引擎、**不参与可见性过滤**
   （它们是"引擎这一轮干了什么"的进程级度量）；因此"本轮压掉 N 次触发"仍是全量数字 ——
   不含名字、不指向具体服务，但严格说是一条**极弱**的旁路信号。取舍理由：让"没有告警"可解释
   优先于该信号的理论信息量。已记入 `todo.md` 与 `04-api-contract.md` §6.9。
3. **隐藏服务的未恢复告警仍停在未恢复状态**（既有引擎语义，本轮有意不动）：读侧看不见 ≠ 引擎认为已恢复。
   要改这条得先裁定产品语义（"隐藏服务的未恢复告警算不算还在故障"），不是一次过滤能解决的。
4. **`docs/sprint2-implementation-spec.md` §3.1 的签名清单仍过期**（写着同步形态、
   也没有可见性参数）：冻结规格未改，本文档与 `03-server-modules.md` / `04-api-contract.md` 按实现为准。
5. **`README.md` 的测试规模数字仍过期**：Sprint 2 提交后累计 **+3 文件 / +36 用例**
   （上一轮 `metricsVisibility` 13 + `clockBoundary` 4 + `healthMonitor` 4；本轮 `alertsVisibility` 15）；
   `03-server-modules.md` §5 里既有条目的条数未逐个重数。均记入 `todo.md`。
6. **归档核对代码时发现一处既有口径不精确（已就地澄清，不是代码缺陷）**：
   文档原写"采集侧固定 viewer → 隐藏后不再产生新样本"，实际只覆盖**服务健康**序列；
   `container.cpu.percent` / `container.memory.used_bytes` 仍按 `containers.list()` 照采
   （容器列表不看服务可见性）。因此容器类指标的隐藏**完全靠读取侧兜住** ——
   那句不精确的表述会把"读取侧强制"误说成可选增强。已在 `04-api-contract.md` §6.7 与
   `06-security.md` §3 写明纠正。

## [2026-10-16] 修复：告警读路径可见性收口（第二组）—— `suppressed` 按 target 记账 + `/rules` 的 `target` 仅对 viewer 遮蔽

> 代码改动已在提交 **`470ac16`**（本条目只补文档；上一组是 `871c3dc` + 文档归档 `4181f5f`）。

### 背景与目标

第一组收口的是 `/api/alerts/events` 与 `/summary` 的**事件行快照与四个计数**（SQL 层过滤，
先过滤再 `LIMIT`）。复审时发现同一类泄漏还剩两处，**载体不同** —— 一处在**数字**里，
一处在**规则配置行**里，所以第一组的写法套不上：

- `summary.suppressed` 原本是引擎的**全局总数**：隐藏 / 已删除的服务每次被压掉都让它涨 ——
  **数字本身就是存在性证据**（"有个你看不见的东西在反复失败"）；而一个**没有归因的总数**
  也根本没法按可见性过滤。
- `GET /api/alerts/rules` 的 `rule.target` 会回显隐藏 / 已删除服务的名字
  （`service:<ref>` / `container:<ref>`），而 viewer 可读该接口 —— 读一次规则列表就能把
  看不见的服务**枚举**出来。
- 顺带发现两处半成品痕迹：`AlertEngine.suppressedTotal()` 全仓零调用方；
  `AlertsService.recordTick` 的签名要求 `suppressed: number` 却**完全忽略**它
  （只传总数会**静默丢计数**）。

### 裁定（owner）

**`rule.target` 仅对 viewer 遮蔽成 `null`，admin 保留真值。**
理由：规则是 admin 自己写的**配置**（不是触发快照），对**作者本人**遮蔽保护不了任何东西，
只会让 `web/src/components/AlertRuleForm.tsx:163` 把空 target 渲染成"· 适用于全部目标"
**对 admin 说假话**；该端点本就是 admin 可 PATCH / viewer 只读，角色分支与端点语义一致。
配套写进代码注释的**口径边界**：**事件 / 快照类**接口（`/events`、`/summary`、`/api/metrics/*`）
**不分角色**；**配置类**接口（`/rules`）**区分角色** —— 两套口径不要互相套用。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `server/src/modules/alerts/engine.ts` | `suppressedTotalValue: number` → `suppressedByTargetValue: Map<string, number>`；`suppressedTotal()` **删除**，新增 `suppressedByTarget(): ReadonlyMap<string, number>`（返回新 Map）；私有 `bumpSuppressed(target, thisTick)` 同时累计总数、按 target 的累计明细与**本轮**明细。**判定语义一行未动** |
| 修改 | `server/src/modules/alerts/types.ts` | `AlertTickResult` 新增**必填** `suppressedByTarget: Record<string, number>`（键 = target 原文，如 `disk:<标签>` / `host` / `service:<ref>`） |
| 修改 | `server/src/modules/alerts/service.ts` | 新增 `isHostOwnedAlertTarget` / `isAlertTargetVisible` / `maskRuleTarget` / `AlertRuleReadOptions` / `sumSuppressedVisible`；`rules()` → `rules(visible, options)`（`maskServiceTargets` **必填无默认值**）；`summary()` 的 `suppressed` 改为按明细求和；`suppressedTotal: number` → `suppressedByTarget: Map`；`recordTick` 改为只收 `{ at, suppressedByTarget }`；`HOST_OWNED_EVENT_SQL` 的旧注释按实现更正并标注已知残留 |
| 修改 | `server/src/api/alerts.ts` | 引擎依赖改为具名 `AlertSummaryEngine`（`lastTickAt` + `suppressedByTarget`）；`composeAlertSummary(summary, engine, visible)` 新增第三参数；`/rules` 加**角色分支**（viewer 遮蔽 / admin 真值且**不查注册表**）；文件头写明两条口径的边界 |
| 修改 | `server/tests/alertsVisibility.test.ts` | **15 → 27 条**（新增 12 条：`suppressed` 6 条 + `rule.target` 5 条 + 1 条纯函数边界）；原"admin 与 viewer 同一口径"两条按裁定**反向为真值断言** |
| 修改 | `server/tests/{alertEngine,alertsApi,metricsSampler}.test.ts` | 只改夹具 / 桩（`rules()` 两个入参、`composeAlertSummary` 第三参数、`AlertTickResult` 补必填字段），**未削弱或删除任何既有断言** |
| 修改 | `docs/static/{03,04,06,09}.md`、`todo.md`、`IMPLEMENTATION_REPORT_S2.md` | 本次归档 |

### 逐项明细

#### 1. `summary.suppressed`：从"全局总数"到"按 target 记账 + 按可见性求和"

- `AlertEngine`：`suppressedByTargetValue` 是 `Map<target, count>`；`bumpSuppressed()` 在
  "已有未恢复 episode"的两条分支（`openEpisodes.has(key)`，以及 `recordTrigger` 既非 opened
  也非 reopened）里被调用。`tick()` 的结果新增**本轮**明细 `suppressedByTarget`。
  **计数与判定分支一行未动**：episode / 静默期 / `reopen_count` / duration 门控 /
  "目标不在快照 → 不假恢复"全部未触碰。
- `AlertsService`：同样只留明细；`summary()` 里 `suppressed: sumSuppressedVisible(this.suppressedByTarget, visible)`。
- `sumSuppressedVisible(byTarget, visible)`：宿主自有（`host` / `disk:<label>`）恒计入；
  `service:` / `container:` 必须命中可见集合；`visible === null` → **只计宿主自有（fail-closed）**；
  非有限值与非正值**直接跳过**（宁可少报，也不让脏数据把数字撑起来）。
- `composeAlertSummary(summary, engine, visible)`：装了引擎就用引擎的**明细**求和覆盖
  （一个数只能有一个来源，仍不做 `Math.max` 折中）；没接引擎时原样返回服务层那份（同口径）。
- **`recordTick` 的新签名**：`(result: { at: string; suppressedByTarget: Record<string, number> })`。
  **刻意不收 `suppressed` 总数** —— 收一个不参与记账的数，只会让调用方以为"传总数也行"，
  而那正是**静默丢计数**（数字看着在动，viewer 的 `suppressed` 却纹丝不动）；
  误导签名现在**编译期**就被挡下。只想记评估时间时用 `recordEvaluatedAt()`。

#### 2. `GET /api/alerts/rules` 的 `rule.target`：仅对 viewer 遮蔽

- `isHostOwnedAlertTarget(target)`（**白名单**：`host` / `disk:`）与
  `isAlertTargetVisible(target, visible)`（宿主自有放行；服务类须命中可见集合；
  空串 / 未知前缀 / `visible === null` → **不允许**）构成读路径的**唯一内存判据**
  （`suppressed` 求和与 `rule.target` 遮蔽共用）。
- `maskRuleTarget(target, visible)`：不可见 → `null`（本就是 `null` 的原样返回）。
  遮蔽成 `null` 而**不引入第三种状态**（`service:<hidden>` 等于直接承认"这里有一个你看不到的目标存在"）。
- `rules(visible, options)` 的 `AlertRuleReadOptions.maskServiceTargets` **必填、无默认值**：
  "给谁看"是裁定，默认值正是"悄悄多显示一个服务"或"悄悄对 admin 说假话"的来源。
  **admin 分支不读 `visible`**，路由层因此**不为 admin 查注册表**
  （免得白付一次 `registry.list`、还因注册表偶发不可用记一条与他无关的 warn）。
- `PATCH /rules/:id` 的响应**不遮蔽**：写路径回显的是调用方自己刚提交的配置
  （把"你刚写的 target"变成 `null` 只会让人以为没保存上），且要求 admin + CSRF。
- 响应形状未变（仍是**13 个字段**、`target` 仍是 `string | null`）；遮蔽是**读时求值**，
  库里 `alert_rules.target` 逐字未动（恢复可见后原样回来）。
- **viewer 侧注册表读失败 → fail-closed**（服务类 target 一律 `null`、宿主类照常）；
  **admin 侧不受影响** —— 那不是 fail-open，而是那条路径压根不读可见集合。

#### 3. 死代码清理与注释更正

- `AlertEngine.suppressedTotal()` **删除**：全仓零调用方，且"一个没有归因的总数"正是本轮要修掉的东西 ——
  留着它等于给下一个调用点留一个绕过可见性过滤的入口。`AlertTickResult.suppressed`（总数）仍在
  （tick 结果形状与调度器日志要用），但**不再进读响应**。
- `HOST_OWNED_EVENT_SQL` 的旧注释曾写它与内存判据"同一个方向"，与实现相反 ⇒ 按实修正，
  并在两处互相引用标注**已知残留**（见下）。

### 判别力

| 实验 | 结果 |
| --- | --- |
| 角色分支**恒遮蔽**（admin 也遮蔽） | `/rules` 3 例红（`expected null to be 'service:manual:…'`） |
| 角色分支**恒放行**（viewer 也不遮蔽） | 同 3 例红（反向） |
| 还原 | 绿 |

**照实记**：以上为修复方实测，本次归档**未复跑**。**`suppressed` 侧没有做"取消可见性求和"
的突变实验** —— 它的判别力由**非零夹具**承担（用例先自检 `suppressed === 2` 且
`suppressedByTarget` 归因为 `host 1 + 目标服务 1`，否则"按可见性求和"测到的只是 `0`），
这不等于一次变异实验，不要当成同等强度的证据。

### 验证方式

```
npx vitest run --root server        # 本次归档独立复跑（2026-10-16）：
# → Test Files 34 passed (34)；Tests 643 passed (643)
#   （上一组归档时是 34 文件 / 631 例；本轮 +12 例 = alertsVisibility 15 → 27）
# 另外三条同轮被改夹具的文件：alertsApi 27 / alertEngine 36 / metricsSampler 10，均全绿

# 来自提交信息 `470ac16`（本次归档未复跑）：typecheck exit 0；web 10 文件 / 172 例全绿；
#   build exit 0；E2E 12 passed（含"告警页 viewer 只读（带有效 CSRF 的写请求也被拒）"）
```

### 已知限制 / 后续

1. **仍然未收口 / 待裁定**：`POST /api/alerts/events/:id/ack` 的**响应体** —— admin 写路径，
   入参是随机 UUID 的事件 ID（要拿到隐藏服务事件的 ID 得先有别的泄漏渠道）。
   收口范围是**读**响应。
2. **已知残留（本轮不修，成因与影响照实记）**：`alerts/service.ts` 里"这个 target 算不算宿主自有"
   有**两种形态、方向相反**的判据 —— SQL 的 `HOST_OWNED_EVENT_SQL` 是**黑名单**
   （"不是服务类前缀就算宿主"），内存的 `isHostOwnedAlertTarget` 是**白名单**
   （"就是 `host` 或 `disk:` 才算"）。空串 / 未知前缀（`weird:secret`）这类**手工脏行**
   因此**在事件列表里被当宿主放出，在 `suppressed` 计数与 `rule.target` 上却被 fail-closed
   剔出 / 遮蔽**。两者都保守，但方向相反 ⇒ 同一批脏行在这几处的表现可能不一致；
   要统一得先裁定"未知前缀到底算不算一个目标"。
3. **`evaluatedAt` 仍不做可见性过滤**：它不指向任何目标，没有可见性语义 —— 这不是残留，是设计。
4. **前端未改**：`AlertRuleForm.tsx` 的"· 适用于全部目标"文案**现在对 admin 不再说谎**
   （admin 拿到真值），因此本轮不需要改 `web/**`；但若将来出现"admin 也遮蔽"的复用点，
   该文案会**再次说谎** —— 已记入 `todo.md`。
5. **`README.md` 的测试规模数字仍过期**（未随两组收口更新：仍写着 server 31 文件 / 594 例，
   实际 34 / 643），已记入 `todo.md`；本次归档范围不含 `README.md`。
6. **归档核对时发现的运维副作用（本轮收口带来的，照实记）**：`suppressed` 收口后，
   **按 target 的全量明细没有任何对外通道** —— `GET /api/alerts/summary` 只给按可见性求和后的数字，
   调度器日志只记 `at` / 耗时 / `error`（`toSchedulerView` 不暴露 `alerts`），
   全量明细只存在于进程内（`scheduler.lastSummary()?.alerts.suppressedByTarget`，目前只有测试读它）。
   后果：**对"被隐藏 / 已删除的服务是否一直在被压掉"这件事，界面上看不出来**，
   要判断得先恢复它的可见性再看数字变化。这是安全优先的必然代价（数字就是存在性证据），
   但它是**有意的行为变化**，运维文档已按实写明；若将来需要"给 admin 一个全量视图"，
   应新开一个**管理侧**（`includeHidden` 口径）的读接口，**不要**把 `/summary` 改成区分角色
   —— 那会与"事件 / 快照类不分角色"的口径打架。

---

## [2026-10-17] 测试隔离：`alertsVisibility` 的 suppressed 组不再依赖宿主 Docker 与真实探测

> 代码改动在提交 **`330b172`**（正文只改了 `server/tests/alertsVisibility.test.ts` 与 `README.md`
> 的测试规模数字）。**本条目归档范围不含 `server/**`**，因此这里记录的是"改了什么、为什么、怎么验证"，
> 而不是一次新的实现。

### 背景（复审驳回）

用户复审给出的**唯一阻断项**：`server/tests/alertsVisibility.test.ts` 第 721–736 行的 `beforeAll`
在**默认配置**下稳定超时 —— 它连续跑两次真实 `scheduler.tickOnce`，却只把宿主快照换成了假夹具，
**Docker 容器列表与健康探测仍走真实外部世界**。在无 Docker（或 Docker Desktop 抖动）的机器上
每轮 tick 都要等到超时，两轮把 `beforeAll` 顶过 **30s `hookTimeout`**（`server/vitest.config.ts`
的 `hookTimeout: 30_000`），于是该组 **6 条最关键的 suppressed 用例全部被跳过**，
`npm test` 失败（server **637 通过 / 6 跳过**）；加 `--hookTimeout=120000` 后 6/6 通过，
但**耗时约 102 秒**。用户明确要求：**不要仅提高超时**，要么注入假数据源，要么用真实
`AlertEngine` + 固定 snapshot 产生 suppressed 再经真实 HTTP 路由验证。

### 修法（路线 A 加固版：保留真实 `tickOnce` 与真实 HTTP 路由，只换外部世界）

**未改任何断言、无 skip、未动任何超时。** 六个外部世界替换点全部装在
`isolateTickDataSources()` 里，`afterAll` 全部还原：

| # | 替换点 | 换成什么 | 为什么 |
| --- | --- | --- | --- |
| 1 | `ctx.system.snapshot` | 假宿主快照（内存 95%） | suppressed 的**宿主来源**（`memory_percent` 规则） |
| 2 | `ctx.containers.list` | `makeContainerList([], { dockerAvailable: false })` | **102 秒的真正来源**；照抄 `schedulerIntegration.test.ts` / `metricsApi.test.ts` 的既有三件套写法 |
| 3 | `ctx.services` | **刻意不换**（保持生产实例：`repository.listAll()` + `role='viewer'` 过滤） | 它本身**无外部调用**，隐藏/删除**立刻**反映到可见集合；换成静态 `EMPTY_SERVICES` 会把"按可见性求和"这件事**架空** |
| 4 | `HealthMonitor.deps.probe` | 注入固定 `fail`（**零出站请求**），不再依赖"回环端口恰好连不上" | 监视器实例、状态机与连续失败计数仍是生产实现 |
| 5 | `handle.config.health.probeIntervalSec` | **钉成 1** | 为 `0` 时监视器**根本不排探测** → 服务永远拿不到"连续失败" → 本组会**静默退化成 0、失去判别力** |
| 6 | `afterAll` | 全部还原 | 别的组（含"把注册表换成抛错桩"的 fail-closed 用例）读路径行为一个字不变 |

**装配期捕获的坑（本次实测踩到，照实记录）**：`serviceRegistry` / `HealthMonitor` /
告警快照来源都在**装配期**就捕获了 `ctx.containers` 这**同一个对象**，因此**只替换 `handle` 上的引用
是空操作** —— 实测 `handle.health = new HealthMonitor(...)` 无效（换完仍走真实探测）。
必须替换**装配期捕获的那一处**（本组即 `ctx.containers.list` 与 `HealthMonitor.deps.probe`）。

**用例语义**：6 条 suppressed 用例**逐条不变**（只改夹具 / 驱动方式），并**新增一条 5 秒耗时上界断言**
（`TICK_BUDGET_MS = 5_000`，对两轮 tick 的墙钟耗时断言 `< 5000ms`），把"不许重新混入真 Docker"
变成**可执行约束**而不是 reviewer 看时间戳。

**判别力（修复方实测，本次归档未复跑）**：把注入探测从 `fail` 改成 `ok` → 用例红在
`expected 1 to be 2`（该服务对 `suppressed` 的贡献正确消失），证明夹具没有被架空。

### 变更概览

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 修改 | `server/tests/alertsVisibility.test.ts` | 新增 `isolateTickDataSources()` / `overrideHealthProbe()` / `failingProbe()`（**全是夹具，不是被测逻辑**）；`beforeAll` 改为装配四个替换点 + 两轮 tick 计时；`afterAll` 全量还原；新增 `TICK_BUDGET_MS` 耗时上界与 `lastTickMs` 自检。**6 条用例的断言与名称逐条未改** |
| 修改 | `README.md` | 测试规模 **594 / 766 → 643 / 815**（server 34 文件 / 643 例；web 10 文件 / 172 例），E2E 12 条复核为 `smoke` 10 + `security-headers` 2 |
| 修改 | `docs/static/{03,08,09}.md`、`todo.md` | 本次归档（**未改 `server/src/**`、`web/**`、`e2e/**`**） |

### 验证方式（本次归档**独立复跑**）

```
npm test                                   # 根目录，无任何 flag
# → server：Test Files 34 passed (34)；Tests 643 passed (643)；Duration 20.55s
#   web   ：Test Files 10 passed (10)；Tests 172 passed (172)
#   exit 0，**0 skipped**（这正是复审驳回时的症状指标：当时是 637 通过 / 6 跳过）

npx vitest run tests/alertsVisibility.test.ts --root server
# → Tests 27 passed (27)；Duration 2.87s（tests 1.73s）—— 修复前约为 102 秒（用户机器实测）
```

**归档时用临时探针做的两次交叉核对（探针已删除，非交付物）**：

| 核对项 | 结果 |
| --- | --- |
| `containers.list` 在两轮 tick 里被调用几次 | 在**修复前的那个文件**上给真实 `containers.list` 加计数包装，实测 **两轮共 12 次（每轮 6 次）**，每次 0–1ms。**与提交信息"假 containers 每 tick 被调用 12 次"的措辞不同：实测是每轮 6 次、两轮共 12 次**。机制上这 12 次调用点现在全部落在注入的假夹具上（`ctx.containers.list` 是同一个对象），所以"夹具确实接住了全部容器类取数"成立，但**这个 12 是旧文件的调用点计数，不是在交付代码上直接测出来的** |
| 修复前的文件在本机单独跑 | **27 例全绿，`Duration 3.46s`**（另一次 2.35s / 3.85s）—— 本机 Docker 守护进程是活的（`docker version` → Server `29.8.0`），**慢路径根本走不到**，所以"102 秒"在本机无法验证，也**不是**"旧文件必然超时"的反证 |
| 探针的自我干扰（照实记） | 同一份旧文件，**加**计数包装后变成 **3 红 + 5 跳过**（`PATCH /api/services/:id` 返回 500，另一处断言红），**去掉**包装后同机全绿 ⇒ 计数探针本身会干扰该文件。"12 次/两轮"这条数字**只在探针运行下成立**，未在交付代码里复核 |

### 已知限制 / 后续

1. **本机无法复现用户那台机器的 102 秒**（本机 Docker 可用且秒回，旧文件同机 27 例全绿 3.46s），
   因此"修复有效"由**机制证据**支撑（旧文件里的 12 处 `containers.list` 调用点现在全部落在
   注入的假夹具上 + 5 秒耗时上界断言），**仍需在有 Docker 的机器上复核一次**。已记入 `todo.md`。
2. **修复前的失败归因（"真实 Docker 调用每轮等到超时"）取自提交信息与用户实测，本次归档未独立证实**
   —— 本机能拿到的只是"未加包装的旧文件在本机 3.46s 全绿"，那只说明**本机走不到慢路径**，
   既不能证实也不能证伪用户机器上的 637 / 6 跳过。
3. `HealthMonitor.deps.probe` 是通过**一次结构化断言**够到的私有依赖（`src` 不动）。
   若将来 `HealthMonitor` 变成 `#private` 字段或改变内部结构，这段夹具会失效 ——
   失效方式是**编译期/运行期立刻报错**（不是静默放过），但它确实是"测试够到实现细节"的耦合点。
4. 本组仍然**走真实 HTTP 路由 + 真实 SQLite + 真实调度器**：隔离的只是外部世界（Docker / 宿主采样 / 探测），
   被测的可见性逻辑一行未换。




