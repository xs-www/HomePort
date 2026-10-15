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
3. **无 TOTP 二次验证**、**无安全响应头（CSP/HSTS）**：见 `06-security.md` §8 残余风险。
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
