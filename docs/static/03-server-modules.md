# 03 · 后端模块与函数（静态函数文档）

> 逐个文件说明**导出函数/类的签名、参数、返回值与关键契约**。
> 修改后端代码后必须同步更新本文件（见 `09-changelog.md` 的记录规则）。

阅读顺序建议：`config → logger → db → http → modules/* → api/* → app → index`。

---

## 1. 基础设施

### `src/config.ts`

唯一读取 `process.env` 的地方。所有环境变量在此收敛为强类型 `PortalConfig`。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `LogLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | 日志级别 |
| `MountConfig` | interface | 磁盘挂载点配置：`{ path, containerPath, label, statPath, readOnly }` |
| `PortalConfig` | interface | 全部配置字段（见 `02-configuration.md` 的逐项对照） |
| `parseMounts` | `(raw: string) => MountConfig[]` | 解析 `PORTAL_DISK_MOUNTS`。**必须**是 `展示路径=容器内路径[|标签[|statfs路径]]`；缺少 `=` 抛错 |
| `defaultMountLabel` | `(displayPath: string) => string`（内部） | 取路径最后一段，并去掉 Windows 盘符冒号（`C:` → `C`） |
| `loadConfig` | `(overrides?: Partial<PortalConfig>) => PortalConfig` | 读取并校验全部环境变量。非法值直接抛错。`overrides` 供测试替换 |
| `ensureDataDir` | `(config: PortalConfig) => void` | `mkdir -p dataDir` |
| `SERVER_ROOT` | `string` | server 包根目录（由 `import.meta.url` 推导，源码/构建后均正确） |
| `REPO_ROOT` | `string` | 仓库根目录 = `SERVER_ROOT/..` |
| `config` | `PortalConfig` | 进程级单例配置 |

**注意**：`webDistDir` 默认值是 `REPO_ROOT/web/dist`，**不是** `process.cwd()/web/dist`。
早期版本用了 `cwd`，导致从 `server/` 目录启动时找不到前端产物。

### `src/logger.ts`

无依赖的结构化日志（不引入 pino，避免与 Fastify logger 配置耦合）。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `LogField` / `LogFields` | `Record<string, unknown>` | 附加字段 |
| `Logger` | interface | `debug/info/warn/error/child` |
| `createLogger` | `(options: LoggerOptions) => Logger` | `options`: `{ level, pretty?, bindings?, sink? }`。`sink` 供测试捕获输出 |
| `createSilentLogger` | `() => Logger` | 测试用静默实现 |

行为：`error`/`warn` 走 stderr，其余走 stdout；`Error` 值自动序列化为 `{name,message,stack}`。

### `src/db/database.ts`

SQLite 连接与迁移。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `Db` | `better-sqlite3` Database 别名 | — |
| `Migration` | `{ version, name, up }` | 单个迁移 |
| `MIGRATIONS` | `readonly Migration[]` | 迁移列表。**只允许追加，不可修改已发布项** |
| `openDatabase` | `(options: OpenDbOptions) => Db` | 打开并设置 PRAGMA：WAL、`foreign_keys=ON`、`busy_timeout=5000`、`synchronous=NORMAL` |
| `appliedVersions` | `(db: Db) => Set<number>` | 已应用迁移版本 |
| `runMigrations` | `(db, migrations?, logger?) => number[]` | 按序应用未执行迁移；每个迁移独立事务。失败回滚并抛错 |
| `initDatabase` | `(options) => { db, applied }` | 打开 + 迁移 |
| `StatementCache` | class | 预编译语句缓存（`get(sql)` / `clear()`） |

### `src/db/types.ts`

行类型与应用对象的映射。约定：`*Row` 为 snake_case + 0/1 布尔；无后缀为 camelCase + 真布尔。

| 导出 | 说明 |
| --- | --- |
| `UserRow` / `User` / `UserWithSecret` | `UserWithSecret` 含 `passwordHash`，**禁止**直接返回 API |
| `SessionRow` / `Session` | 会话 |
| `PreferenceRow` / `UserPreferences` | 偏好 |
| `AuditRow` / `AuditEntry` | 审计 |
| `normalizeRole` | `(value) => UserRole`；非法值回退 `viewer`（最小权限） |
| `usernameCi` | `(username) => string` 大小写不敏感键 |
| `mapUserRow` / `mapUserWithSecret` / `mapSessionRow` / `mapPreferenceRow` / `mapAuditRow` | 纯映射函数 |
| `DEFAULT_PREFERENCES` | `{ theme: 'dark', density: 'comfortable', defaultPage: 'overview' }` |

### `src/db/users.ts`

三个仓储类，全部方法同步（better-sqlite3 特性）。

**`UsersRepository`**

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `count` | `() => number` | 用户总数（bootstrap 判定） |
| `countActiveAdmins` | `() => number` | 启用状态的 admin 数（"最后一个管理员"保护） |
| `findById` | `(id) => User \| null` | — |
| `findWithSecretById` | `(id) => UserWithSecret \| null` | — |
| `findWithSecretByUsername` | `(username) => UserWithSecret \| null` | 大小写不敏感 |
| `list` | `() => User[]` | 按创建时间升序 |
| `usernameExists` | `(username, excludeId?) => boolean` | — |
| `create` | `(CreateUserInput) => User` | 同步维护 `username_ci` |
| `update` | `(id, UpdateUserInput) => User \| null` | 部分更新 |
| `updatePassword` | `(id, hash) => boolean` | — |
| `touchLastLogin` | `(id, at?) => void` | — |
| `delete` | `(id) => boolean` | 级联删除会话与偏好 |

**`PreferencesRepository`**：`getOrCreate(userId)`、`update(userId, partial)`

**`AuditRepository`**：`append(AuditInput)`、`list(limit=100)`、`pruneOlderThan(iso)`

### `src/http/errors.ts`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `ApiErrorCode` | union | 全部错误码，与 `04-api-contract.md` §0.3 一致 |
| `HttpError` | class | `{ code, statusCode, details }`；`toBody()` 输出契约结构 |
| `badRequest` / `unauthenticated` / `forbidden` / `notFound` / `conflict` / `upstreamUnavailable` / `internal` | 工厂函数 | — |
| `toFieldIssues` | `(issues) => FieldIssues` | zod issues → `{ fieldErrors }` |
| `asHttpError` | `(error: unknown) => HttpError` | 把 Fastify 内置错误归一化 |
| `handleError` | `(ctx: ErrorHandlerContext) => void` | Fastify errorHandler 实现体。5xx 隐藏内部细节 |

### `src/http/guards.ts`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `AuthContext` | `{ user, session }` | 挂在 `request.auth` |
| `readCookie` | `(header, name) => string \| null` | 不依赖插件的 Cookie 解析（便于单测） |
| `createAuthHook` | `(deps) => onRequest` | 解析会话并填充 `request.auth`，**失败不抛错**（留给 requireRole 决定） |
| `createCsrfHook` | `() => onRequest` | 变更类请求校验 `X-CSRF-Token`；豁免 `login` / `bootstrap`；未登录不报错 |
| `createRequireRoleHook` | `(required: UserRole) => onRequest` | 角色守卫，`viewer` 表示"任意已登录用户" |
| `requireAuth` | `(request) => AuthContext` | 未认证抛 401 |
| `optionalAuth` | `(request) => AuthContext \| null` | — |
| `clientHints` | `(request) => { userAgent, ip }` | — |
| `buildSessionCookie` | `(SessionCookieInput) => string` | 固定 `HttpOnly; SameSite=Lax; Path=/` |
| `buildClearCookie` | `(name, secure) => string` | 登出用 |
| `setSessionCookie` | `(reply, cookie) => void` | — |

**CSRF 设计**：令牌独立于会话令牌，随会话行存储，通过 `/api/auth/session` 响应下发，
前端在请求头回填。双层校验（存在性 + `timingSafeEqual`）。日志接口是只读 GET，不受影响。

### `src/http/schemas.ts`

全部 zod schema 与 `parseOrThrow`。

| 导出 | 说明 |
| --- | --- |
| `passwordSchema` / `usernameSchema` / `roleSchema` | 基础约束 |
| `loginBodySchema` / `bootstrapBodySchema` / `changePasswordBodySchema` | 认证 |
| `createUserBodySchema` / `updateUserBodySchema` / `resetPasswordBodySchema` / `preferencesBodySchema` | 用户 |
| `containerListQuerySchema` / `containerLogsQuerySchema` / `toolsQuerySchema` | 查询参数 |
| `idParamSchema` / `numericIdParamSchema` / `auditQuerySchema` | 路径与分页 |
| `parseOrThrow` | `<S extends z.ZodTypeAny>(schema: S, value: unknown, where?) => z.output<S>`；失败抛 `VALIDATION_FAILED` + `fieldErrors` |

**两条刻意的写法**（踩过坑，勿改）：

1. 泛型用 `z.ZodTypeAny` 而非 `z.ZodType<T>`：带 `.transform()` 的 schema 输入输出类型不同，
   用 `ZodType<T>` 会因逆变检查失败而编译不过。
2. **不使用 zod 的 `.default()`**：其输出类型仍带 `| undefined`，反而迫使调用方到处写 `??`。
   默认值一律在路由层显式给出（如 `body.remember ?? false`）。

### `src/util/*`

| 文件 | 主要导出 | 说明 |
| --- | --- | --- |
| `net.ts` | `isTailscaleIp` `isLoopbackHost` `isWildcardHost` `isPrivateLanIp` `classifyBind` `bestReachability` `REACHABILITY_RANK` `hostForUrl` `buildUrl` `isInternalHost` `parsePortKey` `collectContainerIps` `isMagicDnsName` `tailnetFromDnsName` | **F1 判定核心**，全为纯函数 |
| `redact.ts` | `isSensitiveKey` `redactText` `redactLines` `redactRecord` `redactEnvList` | 脱敏。key 命中即整体打码 |
| `format.ts` | `formatBytes` `round` `percentOf` `formatDuration` `parseDockerTime` `toIso` `unixSecondsToIso` `normalizeLines` `shortId` | 展示格式化与解析 |
| `dockerStream.ts` | `demuxDockerLogs` `STREAM_STDOUT` `STREAM_STDERR` | Docker 多路复用日志解码（8 字节头） |
| `proc.ts` | `HostProcReader` `parseProcStat` `parseProcStatPerCore` `parseMemInfo` `parseProcUptime` `parseCpuModel` `parseLoadAvg` `cpuPercentBetween` `osCpusToCpuTimes` | 宿主 `/proc` 解析 + `os.cpus()` 兜底 |
| `exec.ts` | `runCommand` `isSuccess` `runCommandJson` | 子进程执行。**不抛异常**，结果通过返回值表达（`notFound` / `timedOut` / `code`） |
| `cache.ts` | `TtlCache<T>` `memoizeAsync` | TTL 缓存 + **single-flight**（并发同 key 只执行一次 loader） |

**`HostProcReader`** 关键方法：

| 方法 | 返回 | 说明 |
| --- | --- | --- |
| `usingHostProc` | `boolean` | 宿主 `/proc/stat` 是否可读 |
| `cpuSource` | `'host-proc' \| 'os-cpus' \| 'none'` | 决定 `sources.cpu.mode` |
| `readCpuTimes` | `CpuTimes \| null` | 宿主 `/proc/stat` → `os.cpus()` 聚合 |
| `readPerCoreTimes` | `Array<{index,total,idleAll}>` | 同上两级降级 |
| `readMemory` | `{ info, fromHostProc }` | `/proc/meminfo` → `os.totalmem()` |
| `readUptime` / `readLoadAvg` / `readCpuModel` / `readCpuCores` / `readIdentity` | — | 均带降级 |

---

## 2. 业务模块

### `src/modules/docker/`

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `types.ts` | `SourceStatus` `UrlCandidate` `ContainerPortView` `ContainerNetworkView` `ContainerMountView` `ContainerStatsView` `ContainerSummary` `ContainerDetail` `ContainerListSummary` `ContainerListResult` `ContainerListQuery` `ContainerLogsResult` `TAILSCALE_IMAGE_RE` | F1 契约类型 |
| `hostContext.ts` | `HostCandidate` `PortalHostContext` `splitHostPort` `buildHostContext` `portalUrl` | 门户对外主机推导 |
| `provider.ts` | `DockerProvider` `resolveDockerEndpoint` `normalizeNamedPipe` `endpointMode` `computeCpuPercent` `normalizeStats` `mapWithConcurrency` `withTimeout` `firstName` `isNotFound` `describeDockerError` | dockerode 封装（**只读 API**） |
| `service.ts` | `ContainerService` `HostInfoProvider` `HostContextRequest` `ServeRoutesProvider`（并 re-export `mapper.ts` 的全部映射函数） | 业务出口：缓存 / 数据源编排 / 契约装配 |
| `mapper.ts` | `summarize` `cleanName` `mapContainer` `mapNetworks` `mapMounts` `mapPorts` `dedupeIdenticalBindings` `urlForBinding` `rebuildPortUrls` `attachHostContext` `pickPrimaryUrl` `buildCandidates` `detectTailscaleSidecar` `joinCommand` `normalizeCommandList` `collectReachableHostPorts` `mapServeRoutes` `attachServePaths` `ServeRouteInput` | 「Docker inspect → 门户契约」**纯函数层**（S0-05 拆分自 `service.ts`） |

**分层铁律（S0-05）**：`mapper.ts` 只做纯计算 —— 不构造/调用 dockerode（仅 `import type` 引用
inspect 形状）、不发请求、不读文件、**不读全局配置**（`PortalConfig` 只经 `PortalHostContext` 传入）。
因此入口解析可用固定输入直接断言，不需要真实 Docker；有状态的编排全部留在 `service.ts`。
`service.ts` 保留全部同名 re-export，旧的 `import { mapPorts } from './docker/service.js'` 写法不受影响。

**入口解析关键函数**

| 函数 | 说明 |
| --- | --- |
| `mapPorts(inspect, hostContext, tailscaleIps, name)` | 以 `NetworkSettings.Ports` 为准（缺失回退 `HostConfig.PortBindings`）判定可达性 + 生成 URL；排序为「可达性优先 → 宿主端口升序」；去重交给 `dedupeIdenticalBindings` |
| `dedupeIdenticalBindings(entries)` | 去掉「除 `hostIp` 外渲染结果完全一致」的重复绑定（真实 `docker inspect` 的 `0.0.0.0` + `::` 双栈形态），保留先出现的一条；判定键含协议/容器端口/宿主端口/可达性/URL/提示，**可达性不同不合并** |
| `attachHostContext(items, hostContext)` | 缓存条目 + 当前访问者 → 重算 `ports[].url` / `reachability` / `primaryUrl` / `urlCandidates` |
| `buildCandidates(ports, hostContext)` | 多候选入口（MagicDNS / tailnet IP / LAN / localhost），按 URL 去重 |
| `collectReachableHostPorts(containers)` | 已作为 tailnet/lan 端口展示过的宿主端口集合（serve 去重依据） |
| `mapServeRoutes(routes, containers)` | serve 路由 → 视图：回填所属容器 + 标记 `coveredByContainerPort`（逐字段构造，`funnel` / `targetPath` 不进契约） |
| `attachServePaths(items, routes)` | 把 serve 路径写到容器卡上（`servePaths` / `servedUrl`） |

**`DockerProvider` 方法**（全部只读）

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `checkAvailability` | `() => Promise<SourceStatus>` | `version()` 探活；失败不抛错 |
| `listContainers` | `(all?) => Promise<ContainerInspectInfo[]>` | `list` 后以并发 8 逐个 `inspect`（端口/网络只在 inspect 里），按运行状态+名称排序 |
| `inspectContainer` | `(id) => Promise<ContainerInspectInfo \| null>` | 404 返回 null，其余抛错 |
| `getLogs` | `(id, options, isTty) => Promise<DockerLogsRaw>` | 非 TTY 走 `demuxDockerLogs`；超出 `maxBytes` 保留**尾部** |
| `getStats` | `(id) => Promise<DockerStatsRaw \| null>` | 一次性 stats，带超时；失败返回 null |
| `getInfo` | `() => Promise<Record<string, unknown> \| null>` | 排障用 |

**`ContainerService` 方法**

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `checkAvailability` | `() => Promise<SourceStatus>` | 暴露给 `/api/health` |
| `list` | `(query, request) => Promise<ContainerListResult>` | 缓存 + 过滤 + 可选 stats |
| `detail` | `(idOrName, request) => Promise<ContainerDetail \| null>` | 含脱敏 `env` |
| `logs` | `(idOrName, options, request) => Promise<ContainerLogsResult \| null>` | 已脱敏 |
| `resolveId` | `(idOrName) => Promise<string \| null>` | 完整 ID/短 ID/名称/唯一前缀 |

**两层 URL 生成**（重要）：`mapContainer` 在缓存阶段用 `skipUrls: true`
只算**可达性**（与访问者无关），URL 由 `attachHostContext` 在响应阶段按当前请求生成。
这样一份缓存可以服务不同访问者（localhost / tailnet IP / MagicDNS）。
（两者都在 `mapper.ts`，属纯函数，可单测；见 `server/tests/dockerMapper.test.ts`。）

### `src/modules/tailscale/`

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `types.ts` | `TailnetDevice` `TailnetSummary` `TailnetStatus` `TailnetStatusLite` `SourceStatus` | F2 契约类型 |
| `hostInfoCache.ts` | `CachedTailnetInfo` `setCachedTailnetInfo` `getCachedTailnetInfo` `cachedTailnetInfoAgeMs` `resetCachedTailnetInfo` | 解 `docker ↔ tailscale` 模块环的单向寄存器 |
| `provider.ts` | `TailscaleProvider` `CliTailscaleProvider` `ApiTailscaleProvider` `DisabledTailscaleProvider` `selectTailscaleProvider` `mapCliStatus` `mapCliPeer` `mapApiDevice` `mapApiDevices` `summarizePeers` `unavailableStatus` `splitIps` `normalizeDnsName` `withSocket` `CommandRunner` | 两种数据源 |
| `serveProvider.ts` | `ServeProvider` `ServeRoute` `ServeStatusResult` `ServeStatusJson` `parseServeStatus` `parseHostPort` `parseProxyTarget` `normalizePath` `describeServeFailure` | `tailscale serve` 路由读取 |
| `service.ts` | `TailscaleService` `defaultCommandRunner` `createUnavailableTailscaleService` | 缓存 + 同步读接口 |

**`ServeProvider`** —— 读取 `tailscale serve status --json`。

为什么与设备查询分开：**可用性不一致**。Windows 上设备查询可走 REST API，
但 serve 配置是节点本地状态、API 不提供，只有 CLI 能读。分开实现才能给出准确原因。

| 方法 / 函数 | 说明 |
| --- | --- |
| `ServeProvider.cliAvailable` | 当前模式是否为 CLI（`api` 与 `off` 返回 false） |
| `ServeProvider.fetchRoutes(allowHosts)` | 拉取并解析；`allowHosts` 用于把路由限定为本机 tailnet 名 |
| `parseServeStatus(json, allowHosts)` | 把 `Web[host:port].Handlers[path]` 展开为**每个路径一条路由**，排序为 主机→端口→路径（`/` 优先） |
| `parseProxyTarget(proxy)` | 解析 `http://127.0.0.1:443/calendar` → `{host, port, path}`；缺省端口按协议补全 |
| `describeServeFailure(result, bin)` | 命令失败翻译成可展示原因；成功返回 `null` |

> **踩过的坑**：`withSocket()` 原先把 `--socket` 追加到**子命令之后**，而它是
> tailscale 的**全局** flag，必须放在子命令**之前**，否则报
> `flag provided but not defined: -socket`。
> Windows 用默认 socket 路径所以没暴露，但 Linux/NAS 上显式配置 socket 是常规做法
> —— 这个 bug 会在 NAS 上直接让 tailnet 查询失效。

**`TailscaleService` 方法**

| 方法 | 说明 |
| --- | --- |
| `getStatus(force?)` | 完整状态，带 `cache.tailscaleTtlMs` 缓存 |
| `getStatusLite(force?)` | 精简版（顶栏/概览） |
| `checkAvailability()` | `/api/health` 用 |
| `warmup()` | 启动时预热，让容器模块立刻拿到本机 tailnet 地址 |
| `getTailscaleIpv4()` / `getTailscaleDnsName()` / `getTailscaleIps()` | **同步**读取最近一次成功结果（不触发命令） |
| `getLastStatus()` | 诊断 |

**关键取舍**：数据源失败时**保留**上一次的 tailnet 地址，而不是清空。
否则 tailscale 命令偶发失败会让整面容器墙瞬间判成"不可达"。

### `src/modules/system/`

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `types.ts` | `HostIdentityView` `CpuView` `MemoryView` `DiskView` `GpuView` `GpuProcessView` `SystemSources` `SystemSnapshot` `SystemMetricsFrame` | F3 契约类型 |
| `provider.ts` | `SystemProvider` `NVIDIA_QUERY_FIELDS` `parseNvidiaSmiCsv` `parseNvidiaSmiProcesses` `parseNvidiaSmiUuids` `describeProcFallback` `describeOsCpuMode` `describeStatfsError` `describeFsType` `diskPercent` `humanBytes` `nowIso` | 采集 |
| `service.ts` | `SystemService` | `snapshot()` / `metricsFrame()` / `intervalMs` / `sourceSummary()` |
| `service.helpers.ts` | `buildMetricsFrame` `hasDegradedSource` `collectWarnings` | 纯函数助手 |

**`SystemProvider` 关键行为**

| 方法 | 说明 |
| --- | --- |
| `snapshot()` | 一次取全（host/cpu/memory/disks/gpu + sources） |
| `readCpu()` | **采样间隔保护**：距上次不足 `MIN_CPU_SAMPLE_INTERVAL_MS`(500ms) 时复用上次结果。否则连续两次快照会因分子分母都接近 0 而给出 0%/null 抖动 |
| `readDisks()` | 对每个 `MountConfig.statPath` 调 `fs.statfs`；`used = (blocks - bfree) * bsize`，`percent = used / (used + available)` |
| `readGpu()` | 3 秒缓存；`nvidia-smi --query-gpu=...` 后附带 `--query-compute-apps` 取占用进程 |

**`sources[].mode` 取值含义**（UI 据此决定是否显示警告角标）

| mode | 含义 |
| --- | --- |
| `host-proc` | 读到宿主 `/proc`，**真实值** |
| `os-cpus` | 走 `os.cpus()` 兜底（Windows/macOS）。`os.cpus().times` 是**宿主整机**累计时间，因此仍是真实值，只是无 `iowait`/`steal` 细分 |
| `container-proc` | 只能看到容器/虚拟机视图，UI 显示警告 |
| `statfs` | 磁盘，真实值 |
| `nvidia-smi` | GPU，真实值 |
| `none` | 不可用 |

### `src/modules/tools/`

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `types.ts` | `ToolStatusView` `ToolUrlCandidate` `ToolView` `ToolListSummary` `ToolListResult` `SourceStatus` | F4 契约类型 |
| `catalog.ts` | `ToolDefinition` `ToolCategory` `BUILTIN_TOOLS` `ToolsFileConfig` `loadCatalog` `normalizeTool` `parseExtraTools` `LoadCatalogResult` | 目录加载与校验 |
| `probe.ts` | `ProbeState` `ProbeResult` `probeTool` `tcpConnect` `httpStatus` `describeNetError` `defaultFallbackHosts` | 多目标探测 |
| `service.ts` | `ToolsService` `buildToolUrls` `summarizeTools` `ToolUrls` | 业务出口 |

**探测目标链**（`probeTool`）：门户跑在容器里，`localhost` 在容器内指向容器自己，
因此宿主服务必须走特殊域名。按顺序尝试，任一成功即判 `up`：

```
1. options.host（门户的对外主机名）
2. host.docker.internal   ← 容器化部署下宿主服务的可靠目标
3. 127.0.0.1              ← 门户原生运行时的宿主
```

命中兜底主机时 `detail` 会写明"经 xxx 探测"，`ProbeResult.target` 返回实际成功的主机与端口
（`ToolStatusView.target` 透出给前端显示徽标）。

探测策略：先 TCP 连接 → 再按 `probePath` 发 HTTP GET。
TCP 通但 HTTP 不通仍判 `up`（服务可能是纯 TCP 或需鉴权跳转），只在 `detail` 说明。

### `src/modules/auth/`

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `crypto.ts` | `BCRYPT_ROUNDS` `PASSWORD_MIN_LENGTH` `PASSWORD_MAX_LENGTH` `checkPasswordStrength` `hashPassword` `verifyPassword` `dummyVerify` `randomToken` `hashToken` `timingSafeEqual` `generateSetupToken` | 密码与令牌 |
| `sessions.ts` | `SessionsRepository` `CreateSessionInput` `CreatedSession` | 会话 CRUD |
| `service.ts` | `AuthService` `SessionView` `LoginInput` `LoginResult` `BootstrapInput` `USERNAME_RE` `assertUsernameAvailable` | 认证业务 |

**密码策略**：bcrypt cost 12（bcryptjs 纯 JS，避免多架构镜像里编译原生模块失败）。
至少 10 位、至少两类字符、拒绝常见弱口令、上限 128 字节（bcrypt 只取前 72 字节，
过长直接拒绝而不是静默截断）。

**防用户枚举**：用户不存在时也执行一次等价耗时的 `dummyVerify()`，
失败一律返回 `INVALID_CREDENTIALS`（与密码错误完全相同的 code 与 message）。

**`SessionsRepository` 方法**：`create` `findById` `findValidByToken` `touch` `extend`
`revoke` `revokeAllForUser` `unrevoke` `purge` `countActiveForUser`

> `unrevoke` 的用途：改密时"吊销全部会话但保留当前会话"——先整体吊销再恢复当前会话，
> 比逐个排除的 SQL 更简单且不易出错。

### `src/modules/users/service.ts`

| 导出 | 说明 |
| --- | --- |
| `UsersService` | `list` `get` `preferences` `updatePreferences` `activeSessionCount` `assertAdmin` `create` `update` `delete` `revokeSessions` |
| `isUniqueViolation` | SQLite 唯一约束识别 |
| `assertAdmin` | 非 admin 抛 403 |

**"最后一个管理员"保护**：`update`/`delete` 在写库**前**校验，
拒绝任何会让启用 admin 数量归零的操作（降级、禁用、删除）。

### `src/modules/settings/`（运行时设置）

| 文件 | 导出 | 说明 |
| --- | --- | --- |
| `registry.ts` | `SettingDefinition` `SettingEffect` `SettingValueType` `SettingGroup` `SettingView` `SETTING_GROUPS` `MASK_TOKEN` `buildSettingDefinitions` `resolveSettings` `settingsToMap` `applyTo` `validateSettingValue` `parseSettingValue` `serializeSettingValue` `maskSecret` `ApplyResult` `ResolvedSetting` | 三层解析 + 校验 + 写回 config |
| `service.ts` | `SettingsService` `SettingsView` `UpdateSettingsInput` `UpdateSettingsResult` | 业务出口（含热重建编排、敏感值加解密接入） |
| `secretBox.ts` | `createSecretBox` `loadOrCreateKey` `parseKey` `parsePreviousKeys` `encodeKey` `SecretBoxError` `ENCRYPTED_PREFIX` `KEY_BYTES` | AES-256-GCM 加密盒（密文 `enc:v1:…`）+ 主密钥装载 |
| `secretStore.ts` | `SecretSettingsStore` `collectSensitiveKeys` `ReencryptUpgrade` | 敏感键**写库前加密 / 读出后解密**的仓储装饰层 + 存量明文一次性升级 |
| `tailscaleProbe.ts` | `probeTailscale` `effectiveMode` `summarizeApiDevices` `TailscaleProbeInput` `CommandExecutor` | 连通性测试（可注入 fetch/命令执行器） |
| `types.ts` | `TailscaleTestResult` `TailscaleDeviceSummary` | 契约类型 |

**三层优先级**：`数据库覆盖 > 环境变量 > 内置默认`。
`resolveSettings()` 对每项同时返回 `source`、`envValue`、`databaseValue`，供界面展示"改了什么"。

**`applyTo(config, map, overriddenKeys)`** — 就地改写 `PortalConfig`，返回
`{ changedKeys, reloadTailscale, reloadDocker, skippedKeys }`。

> **踩过的坑**：`overriddenKeys` 参数是必需的。`PORTAL_DISK_MOUNTS` 的默认值是空字符串，
> 而 config 的初值来自 `.env`/平台默认。若无条件按"解析结果 vs 当前值"比对，
> 未设置该项时会把 `.env` 里配好的挂载点**清空**。必须区分"用户清空"与"从未设置"。

**生效级别的实现约定**

| 级别 | 实现 |
| --- | --- |
| `live` | 依赖方每次调用时从 `config` 读取（如 `ToolsService`、`SystemProvider`） |
| `reload` | `applyTo` 返回 `reloadTailscale` / `reloadDocker`，由 `app.ts` 注入的 `onReload` 执行重建 |
| `restart` | `validateSettingValue` 直接拒绝；`applyTo` 显式列入 `skippedKeys` |

个别值在构造期读取，无法靠"每次读 config"生效，需要显式同步：

| 值 | 同步方式 |
| --- | --- |
| `PORTAL_CACHE_CONTAINERS_TTL_MS` | `ContainerService.syncConfig()` 重建 TtlCache |
| `PORTAL_HOST_PROC` | `SystemProvider.syncConfig()` 重建 HostProcReader 并清空 CPU 基线 |
| `DOCKER_ENDPOINT` | `DockerProvider.reload()` 重建 dockerode 连接 |
| Tailscale 模式/Token/socket/bin/tailnet | `TailscaleService.reload()` 重新选择数据源并预热 |

**`SettingsService` 方法**

| 方法 | 说明 |
| --- | --- |
| `initialize()` | 启动时应用数据库覆盖值（**必须在数据源被使用前调用**） |
| `reencryptAll()` | 一次性把库里仍是明文（或旧密钥）的敏感值升级为当前密钥的密文；**幂等**，返回升级条数；未注入 `secretBox` 时返回 0。启动装配时调用一次 |
| `ensureApplied(force?)` | 惰性幂等应用；以 settings 表的 `版本 = 条数:最新updatedAt` 判断是否需要重跑 |
| `view()` | 全部设置项视图（敏感项打码、含来源与生效级别） |
| `update(input)` | 部分成功语义：合法项写入、`restart` 级拒绝、非法项报告原因 |
| `reset(keys \| null, actor, ip)` | 删除覆盖值（恢复默认），单事务 |
| `testTailscale(candidateToken?)` | 连通性测试，支持尚未保存的候选 Token |

**敏感设置加密存储（S0-03）**

构造函数多了一个**可选**依赖 `secretBox`（`createSecretBox({ key, previousKeys })`）：

- 不传 → 完全保持明文行为（无密钥场景与既有测试不受影响）；
- 传入 → 注册表里 `sensitive: true` 的键，经 `SecretSettingsStore` 装饰层
  **写库前加密、读库后解密**。`resolveSettings()` 读到的仍是明文，
  因此 `applyTo()` 写回 `config` 的 Token 可直接用于调用外部 API。
  `registry.ts` 的 `ResolveOptions.repository` 因此改为依赖 `SettingsStore` 接口
  （`db/settings.ts` 抽出），而不是带 `private` 成员的类。
- **旧明文兼容**：无 `enc:v1:` 前缀即视为迁移前的旧明文，原样读取；
  下一次写入该键时自动升级为密文（惰性迁移），`reencryptAll()` 负责存量兜底。
- **密钥轮换**：`previousKeys` 只用于解密，`isCurrentKey()` 判断是否需要升级。
- **解密失败不崩**：该键按"未设置"处理（剔出读取结果 → 回退环境变量/默认），
  记一条**只含键名**的告警，绝不把解不开的值当有效 Token 传给外部 API。
- **不泄露**：日志与审计只记键名；审计里敏感项写成 `键=***`。

装配方接线点（`app.ts`，本次未改）：

```ts
const { key } = loadOrCreateKey({ explicit: config.secrets.key, keyFile: config.secrets.keyFile, logger });
const secretBox = createSecretBox({ key, previousKeys: config.secrets.previousKeys.map(parseKey) });
const settings = new SettingsService({ /* …原有依赖… */, secretBox });
await settings.reencryptAll();   // 存量明文一次性升级（幂等；失败只告警不中断）
await settings.initialize();
```

### `src/modules/overview/service.ts`

`OverviewService.build(request, role)`：并行取四个数据源（`Promise.allSettled`），
任一失败只影响自身并把原因写入 `warnings`，其余照常返回。
`pickPrimaryDisk(disks)` 选挂载点最短的可读磁盘作为"主磁盘"。

---

## 3. 路由层 `src/api/`

| 文件 | 导出 | 路由 |
| --- | --- | --- |
| `context.ts` | `RouteContext` `toHostContextRequest` | 依赖容器（路由不直接 import 业务实现） |
| `health.ts` | `registerHealthRoutes` | `GET /api/health` |
| `auth.ts` | `registerAuthRoutes` `LOGIN_RATE_LIMIT` | `/api/auth/*` |
| `overview.ts` | `registerOverviewRoutes` | `GET /api/overview` |
| `containers.ts` | `registerContainerRoutes` `DEFAULT_LOG_TAIL` | `/api/containers/*` |
| `tailscale.ts` | `registerTailscaleRoutes` | `/api/tailscale/*` |
| `system.ts` | `registerSystemRoutes` `SSE_PING_INTERVAL_MS` `SSE_MAX_LIFETIME_MS` | `/api/system/*` |
| `tools.ts` | `registerToolRoutes` | `/api/tools/*` |
| `users.ts` | `registerUserRoutes` `DEFAULT_AUDIT_LIMIT` | `/api/users/*` |
| `index.ts` | `registerRoutes` `PROTECTED_PREFIXES` | 总装 + 权限模型 |

**权限模型**（"默认安全"）：`/api/health` 与 `/api/auth/*` 匿名可用；
`PROTECTED_PREFIXES` 中的每个路由域统一挂 `requireRole('viewer')` + `csrf`。
新增路由即使忘记加守卫，最坏结果是"需要登录"，不会匿名开放。

---

## 4. 应用装配

### `src/app.ts`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `BuildAppOptions` | interface | `{ config?, logger?, dbPath?, serveStatic?, sessionCleanupIntervalMs? }` |
| `AppHandle` | interface | `{ app, ctx, db, config, logger, close }` |
| `DEFAULT_CLEANUP_INTERVAL_MS` | `3600000` | 会话/审计清理周期 |
| `buildApp` | `(options?) => Promise<AppHandle>` | 装配全部依赖，**不监听端口**（便于 `inject` 测试） |
| `registerStatic` | `(app, config, logger) => string \| null` | 注册静态资源，返回 `index.html` 路径（无产物时返回 null） |
| `escapeHtml` | `(input) => string` | 错误页转义 |

装配顺序即依赖方向：`config → logger → db → repositories → providers → services → api → static`。

**notFoundHandler 只注册一次**（`buildApp` 内）：`/api/*` 一律 JSON 404；
其它 GET 在前端已构建时回退 `index.html`。
> 踩过的坑：`registerStatic` 里也调用 `setNotFoundHandler` 会导致
> `Not found handler already set for Fastify instance with prefix: '/'` 启动失败。
> 另外若完全不注册，`/api/nope` 会返回 HTML，前端 `JSON.parse` 报出难以定位的错误。

### `src/index.ts`

进程入口：`buildApp` → 注册 `SIGTERM`/`SIGINT` 优雅退出 → `listen` →
若 `auth.isSetupRequired()` 则打印首启令牌到控制台。

---

## 5. 测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/util.test.ts` | 可达性判定、URL 组装、脱敏、`/proc` 解析、Docker 日志解复用、TtlCache |
| `tests/modules.test.ts` | 配置解析、endpoint 解析、stats 归一化、容器映射、主机上下文、tailnet 映射、nvidia-smi 解析、SSE 帧、工具目录 |
| `tests/auth.test.ts` | 认证流程、会话与 CSRF、角色与账号管理、接口契约（`app.inject` + 内存库） |

运行：`npm test`（根目录）或 `npx vitest run`（server 目录）。
