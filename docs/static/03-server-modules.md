# 03 · 后端模块与函数（静态函数文档）

> 逐个文件说明**导出函数/类的签名、参数、返回值与关键契约**。
> 修改后端代码后必须同步更新本文件（见 `09-changelog.md` 的记录规则）。

阅读顺序建议：`config → logger → db → http → modules/* → api/* → app → index`。

---

## 1. 基础设施

### `src/config.ts`

唯一读取 `process.env` 的地方。所有环境变量在此收敛为强类型 `PortalConfig`。

> **这条约定是可执行的**：`server/tests/envBoundary.test.ts` 会扫描 `src/**/*.ts`
> （去掉注释后）断言只有 `config.ts` 出现 `process.env`。需要环境变量的其它模块走两个口子：
> `config.envVars`（快照，用于"继承环境"或批量取值）与 `config.readEnvVar(name)`
> （单个取值，去空白、空串视为未设置，供设置注册表展示"环境变量层原值"）。
>
> 为什么较真：环境变量读点散落各处时不会报错，只会让**行为取决于宿主机** ——
> 真实踩到的例子是 tailnet 连通性测试因宿主环境里存在 `PORTAL_TAILSCALE_API_TOKEN`
> 而走进 API 分支、真的发起网络请求，本机与 CI 的结论不同。
> 具体分支：`util/exec.ts` 不传 `env` 即"继承父进程环境"（Node 默认行为），
> 因此连继承都不需要读 `process.env`。

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `LogLevel` | `'debug' \| 'info' \| 'warn' \| 'error'` | 日志级别 |
| `MountConfig` | interface | 磁盘挂载点配置：`{ path, containerPath, label, statPath, readOnly }` |
| `PortalConfig` | interface | 全部配置字段（见 `02-configuration.md` 的逐项对照）；含 `envVars` 环境快照 |
| `parseMounts` | `(raw: string) => MountConfig[]` | 解析 `PORTAL_DISK_MOUNTS`。**必须**是 `展示路径=容器内路径[|标签[|statfs路径]]`；缺少 `=` 抛错 |
| `defaultMountLabel` | `(displayPath: string) => string`（内部） | 取路径最后一段，并去掉 Windows 盘符冒号（`C:` → `C`） |
| `loadConfig` | `(overrides?: Partial<PortalConfig>) => PortalConfig` | 读取并校验全部环境变量。非法值直接抛错。`overrides` 供测试替换（可用 `envVars` 追加环境变量而不改 `process.env`） |
| `readEnvVar` | `(name: string) => string \| null` | 读取单个环境变量原值：去空白，空串按"未设置"处理 |
| `ensureDataDir` | `(config: PortalConfig) => void` | `mkdir -p dataDir` |
| `SERVER_ROOT` | `string` | server 包根目录（由 `import.meta.url` 推导，源码/构建后均正确） |
| `REPO_ROOT` | `string` | 仓库根目录 = `SERVER_ROOT/..` |
| `config` | `PortalConfig` | 进程级单例配置 |

**注意**：`webDistDir` 默认值是 `REPO_ROOT/web/dist`，**不是** `process.cwd()/web/dist`。
早期版本用了 `cwd`，导致从 `server/` 目录启动时找不到前端产物。

**Sprint 2 新增的两个命名空间**（`metrics` / `health`，S2-01 / S2-03）：

| 字段 | 环境变量 | 默认 | 合法范围 | 说明 |
| --- | --- | --- | --- | --- |
| `metrics.sampleIntervalSec` | `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` | `30` | 5–3600 | 后台采样 tick 间隔（秒）。**同时是 minute 桶期望样本数的基准**（`expected = max(1, round(60/intervalSec))`），所以它既影响采集频率，也影响"缺测"的判定口径 |
| `metrics.minuteRetentionHours` | `PORTAL_METRICS_RETENTION_MINUTE_HOURS` | `24` | 1–168 | minute 桶保留小时数。稳态行数由它封顶 —— 这是"行数不随运行时长增长"的实现方式 |
| `metrics.hourRetentionDays` | `PORTAL_METRICS_RETENTION_HOUR_DAYS` | `30` | 1–3650 | hour 桶保留天数 |
| `metrics.containerLimit` | `PORTAL_METRICS_CONTAINER_LIMIT` | `10` | 0–100 | 采集容器的数量上限；**0 = 完全不采容器指标**（宿主与磁盘不受影响） |
| `health.probeIntervalSec` | `PORTAL_HEALTH_PROBE_INTERVAL_SEC` | `300` | **0**–86400 | 每个服务两次 HTTP 探测之间的最小间隔；**0 是合法值 = 关闭自动探测**（因此下界是 0 而不是 1） |
| `health.probeConcurrency` | `PORTAL_HEALTH_PROBE_CONCURRENCY` | `4` | 1–32 | 全局在飞探测上限（不是"每 tick 上限"，见 `health/monitor.ts`） |

两处刻意的取舍：

1. **非法值启动即抛错**（与 `parseTrustProxy` 同风格），不静默截断。静默截断的代价是
   "我以为保留 3 天生效了，其实库里留的是别的东西"，半年后才被发现。
2. **`overrides` 里的嵌套对象是整体覆盖**（`loadConfig` 的 `{...config, ...overrides}` 语义）。
   测试里要改一个字段必须写全整组：
   `{ metrics: { ...loadConfig().metrics, sampleIntervalSec: 1 } }`，否则会丢字段。
   `schedulerIntegration.test.ts` / `metricsSampler.test.ts` 都是这么写的。
   `health.probeIntervalSec = 0` 是**测试避免真实网络请求**的标准手法（见 `schedulerIntegration.test.ts`）。

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

**迁移 v5 `metrics_alerts_schema`（Sprint 2，只追加）**：三张表 + 四个索引。
逐列定义见 `07-data-model.md`；这里只记**为什么这样建**：

| 新对象 | 为什么存在 |
| --- | --- |
| `metric_buckets` + `UNIQUE (resolution, metric, target, bucket_at)` | 一个桶只允许一行。写入用 `INSERT … ON CONFLICT DO UPDATE` 幂等重写 —— "同一分钟内多次刷新"不会产生重复行。**约束比调用方自觉可靠**（Sprint 1 的教训） |
| `idx_metric_buckets_series (resolution, metric, target, bucket_at)` | 历史查询的命中索引：`WHERE resolution=? AND metric=? AND target=? AND bucket_at >= ? AND bucket_at <= ?` |
| `idx_metric_buckets_retention (resolution, bucket_at)` | 保留清理的命中索引（两个分辨率各自按时间删） |
| `alert_rules`（**不塞业务数据**） | 只建结构。四条内置规则由 `AlertsService.ensureBuiltinRules()` 在**装配期**幂等补齐 —— 迁移只跑一次，而内置规则的默认值会随版本演进，放代码里老库升级也能拿到新默认值；同时"迁移后新表为空"这条可验证性质得以保留。`enabled` 默认 `0`（装了但不吵） |
| `alert_events` + `idx_alert_events_open (rule_id, target) WHERE resolved_at IS NULL` | **部分唯一索引是不变量本身**：同一规则同一目标最多一行未恢复。引擎的"重启不重复通知"不靠内存计数器，靠它 |
| `idx_alert_events_recent (fired_at DESC)` | 事件列表（默认取最近 50 条）与 `summary().top` 的排序依据 |

> **新增迁移时必须同步改两处降级夹具**：`migrationV3.test.ts` / `migrationV4.test.ts` 的
> "退回老库形态"步骤要 `DROP` 新表并删掉对应的 `schema_migrations` 行，
> 否则各版本的真实回落夹具会一起报版本号断言失败。本次两个文件都已补上 v5
> （v3 文件删 `version IN (3,4,5)`，v4 文件删 `version IN (4,5)`）。
> `migrationV4.test.ts` 的"迁移链末端"断言改成与
> `Math.max(...MIGRATIONS.map((m) => m.version))` 比对，并保留原有全部 v4 断言。

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

### `src/db/services.ts`

**`ServicesRepository`**（S1-01）——唯一能写 `services` 表的地方，写入纪律写死在 SQL 里。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `listAll` / `findById` / `findBySlug` | `() => Service[]` / `(id) => Service \| null` / `(slug) => Service \| null` | — |
| `findBySource` | `(sourceType, sourceRef) => Service \| null` | **稳定身份**查重（发现落库靠它） |
| `listBindings` | `(serviceIds?) => ServiceBinding[]` | **单条 SQL** 取全部绑定（返回扁平数组，按服务分组的辅助逻辑在服务层），避免 N+1 |
| `uniqueSlug` | `(base) => string` | 冲突追加 `-2`/`-3`… |
| `insert` | `(NewServiceInput) => Service` | 新建（手工服务与首次发现） |
| `upsertDiscovered` | `(DiscoveryUpdateInput) => Service` | **只写自动字段**：`CASE WHEN user_edited = 0 THEN ? ELSE 列名 END` |
| `updateUserFields` | `(id, UserFieldPatch, updatedBy) => Service \| null` | **唯一**能改展示属性的入口，**必然**置 `user_edited = 1` |
| `clearUserOverrides` | `(id) => Service \| null` | 「重置为自动」：清用户覆盖并复位 `user_edited` |
| `setVisibility` / `reorder` / `delete` | — | 隐藏 / 批量排序（单事务）/ 删除 |
| `replaceBindings` | `(serviceId, BindingInput[]) => void` | 单事务 `DELETE` + 批量 `INSERT`，快照永不越攒越脏 |
| `getPreference` / `setPreference` / `count` | — | 单例偏好 KV / 计数 |

> **为什么"用户配置不丢"是靠 SQL 而不是靠代码自觉**：发现流程只有 `upsertDiscovered()` 一条路，
> 它连"写用户字段"的能力都没有（`CASE WHEN user_edited = 0` 在语句里）。想覆盖用户值，
> 只能显式走 `updateUserFields()`（必然留下 `user_edited = 1`）或 `clearUserOverrides()`。
> 这样"自动发现不得覆盖用户别名与顺序"就成了**结构保证**，不是"记得别写错"。

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
| `backgroundContext.ts` | `backgroundHostRequest` | **"没有访客"的 `HostContextRequest` 唯一定义**（S2，见下） |

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

**`backgroundHostRequest(config)`（S2 新增，`backgroundContext.ts`）**

```ts
export function backgroundHostRequest(config: Pick<PortalConfig, 'port'>): HostContextRequest {
  return { protocol: 'http', hostname: 'localhost', headers: {}, port: config.port };
}
```

Sprint 2 引入了**第一个没有 HTTP 请求的调用方**（后台采样器 / 健康监视器 / 告警快照），
而 `services.list()` / `containers.list()` 都需要 `HostContextRequest`。
没有它，后台只能绕开服务层直接读库 —— 那样会漏掉发现缓存、可见性过滤与状态计算。

| 要点 | 说明 |
| --- | --- |
| 语义 | "没有访问者，以配置为准"。`headers: {}` 使 `buildHostContext` 取不到 Host 头，候选主机自然退化为 `PORTAL_PUBLIC_HOST` → MagicDNS → tailnet IP → localhost |
| 唯一性 | 与 `ServiceRegistryService.neutralRequest()`（私有方法）的字面量完全一致。抽出来的目的就是让"无访问者"只有**一个**定义，而不是三个模块各写一遍 |
| 禁止 | **不要**伪造 `x-forwarded-*` 头：那会让后台任务误以为自己在替某个访问者生成 URL |
| 参数 | 只取 `Pick<PortalConfig,'port'>` —— 依赖面越小，"后台真的不需要访问者"这件事越明显 |

**`ContainerSummary.exitCode`（S2 新增，`types.ts` + `mapper.ts`）**

`mapper.mapContainer` 现在映射 `inspect.State.ExitCode`：

| 值 | 含义 |
| --- | --- |
| `number`（含 `0`） | 真实退出码。`0` = 正常退出 |
| `null` | **未知**：`State` 缺失/不可读，或 `ExitCode` 字段不存在（老版本 Docker、inspect 只读到一半） |

映射写成 `typeof … === 'number' && Number.isFinite(…) ? … : null`，**刻意不用 `?? 0`**：
把"未知"兜成 `0` 会让"异常退出但读不到退出码"永远静默（`container_exit` 规则只在
**已知且非 0** 时触发）。两者的语义不同，谁也不许伪装成另一个 ——
`server/tests/dockerMapper.test.ts` 的「容器退出码（null ≠ 0）」小节逐条锁死
（`137` 就是 `137`；`0` 保留 `0`；`State` 缺失 → `null` 且 `state = 'unknown'`；
`ExitCode` 字段缺失 → `null`；运行中的容器是 `0` 而不是 `null`）。

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

**Sprint 2 新增两组设置（`metrics` / `health`，6 个键，全部 `effect: 'live'`）**

`SettingGroup` 联合类型扩为 `'tailscale' | 'docker' | 'system' | 'tools' | 'performance' | 'metrics' | 'health' | 'boot'`，
`SETTING_GROUPS` 相应新增两条（`metrics` = 「历史指标采样」、`health` = 「健康监测」）。

| 键 | group | 默认 | 范围 | 单位 |
| --- | --- | --- | --- | --- |
| `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` | `metrics` | 30 | 5–3600 | 秒 |
| `PORTAL_METRICS_RETENTION_MINUTE_HOURS` | `metrics` | 24 | 1–168 | 小时 |
| `PORTAL_METRICS_RETENTION_HOUR_DAYS` | `metrics` | 30 | 1–3650 | 天 |
| `PORTAL_METRICS_CONTAINER_LIMIT` | `metrics` | 10 | 0–100 | 个 |
| `PORTAL_HEALTH_PROBE_INTERVAL_SEC` | `health` | 300 | 0–86400 | 秒 |
| `PORTAL_HEALTH_PROBE_CONCURRENCY` | `health` | 4 | 1–32 | 个 |

- `applyTo()` 对这六个键用既有的 `pickNumber` + `setIfChanged` 就地写回 `config.metrics.*` /
  `config.health.*`，**不出现在 `reloadTailscale` / `reloadDocker` 里，也不进 `skippedKeys`**。
- 为什么不需要任何重建动作：采样器与调度器**每次 tick / 每次排期**都从 `config` 读
  （`intervalSec()` / `intervalMs()` 就是为此设计的闭包），监视器同理。
  这就是 `live` 级在本 Sprint 的落地方式 —— **改完下一个周期即生效，无需重启**。
- `PORTAL_METRICS_CONTAINER_LIMIT` / `PORTAL_HEALTH_PROBE_INTERVAL_SEC`
  的 `min` 可以是 0，因为 0 是**有意义的取值**（不采容器 / 关闭自动探测），不是"没设置"。

> **这里修了一个真 bug（`service.ts` 的 `groupList()`）**：它原先是一份**手抄的分组副本**，
> 而不是复用 `SETTING_GROUPS`。新增 `metrics` / `health` 两组时只改了 registry，
> 于是设置接口返回的 `groups` 少了这两组 —— 前端按 `groups` 分区渲染，
> **设置页会少渲染这 6 个键**（接口能返回设置项，但界面没有对应的分区）。
> `tests/auth.test.ts` 的"每一项的 group 必须在 groups 里声明过"断言立刻抓到了这个用户可见缺陷。
> 现在 `groupList()` 直接 `return SETTING_GROUPS`（同源），新增分组只可能改一处。

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

### `src/modules/services/`（服务注册表，S1-01…S1-05）

把"容器 + serve 路由"归纳成用户看得懂的**服务**。四个文件职责严格分开，
前两个是**纯逻辑**（无 I/O、可直接单测），第三个是编排，第四个是安全边界：

| 文件 | 性质 | 导出 | 说明 |
| --- | --- | --- | --- |
| `registry.ts` | 纯函数 | `planDiscovery` `buildServiceEntries` `dedupeEntries` `pickEntry` `compareEntries` `resolveServiceStatus` `findContainerForService` `serveRoutesForService` `containerServiceRef` `serveServiceRef` `normalizeUrl` `normalizeHost` `normalizePath` `defaultPresentation` `humanizeName` `isBuiltinIcon` `BUILTIN_ICONS` `ENTRY_RANK` `ENTRY_LABEL` `slugBaseFor` `DEFAULT_CATEGORY` `countHostPortClaimants` `isServeRouteAttributable` | 发现规划、入口候选与优先级、三维状态、稳定身份。**不认识数据库，也不发请求**。两条不变量：①`planDiscovery` 不盲信 `mapper.mapServeRoutes()` 给的归属 —— 用 `isServeRouteAttributable`（按实时容器列表判"是否唯一占用该宿主端口"）复核，`>1` 即视为不可确定，改为独立 serve 服务 + 可读原因，快照里也不记该 owner；**视图阶段的 `serveRoutesForService` 复用同一个判定**，否则冲突路由会一边当独立服务、一边又被挂回第一个容器。②收尾统一保证"每个服务每个 `(kind, ref)` 只有一份绑定"（副本容器、重复 serve 路由都靠它兜住，否则撞 `service_bindings` 的 `UNIQUE(service_id, kind, ref)` 让整个发现事务回滚） |
| `healthProbe.ts` | 纯函数 + 单次 fetch | `validateHealthTarget` `runHealthProbe` `HEALTH_PROBE_TIMEOUT_MS` `HEALTH_PROBE_MAX_BODY_BYTES` | 健康探测的 SSRF 拒绝清单与请求纪律（见 [06-security.md](./06-security.md) §3） |
| `service.ts` | 编排 | `ServiceRegistryService` `resolveHealthTarget` `cleanOptionalUrl` `cleanHealthPath` `cleanIcon` `emptyToNull` `canSee` `matchesQuery` `collectCategories` `toDiscoveryState` `DISCOVERY_CACHE_TTL_FALLBACK_MS` `HEALTH_RESULT_LIMIT` | 取数（容器/设备/serve）→ 规划 → 落库 → 生成视图；写操作校验与审计 |
| `types.ts` | 类型 | `ServiceView` `ServiceEntryView` `ServiceStatusView` `ServiceListResponse` `ServiceDetailResponse` `ServiceSearchResponse` … | **HTTP 契约**，前端逐字段镜像 |

**三层不可混淆**（`01-architecture.md` §4.1）：事实层（容器/端口/可达性）实时取、不落库；
注册表层（身份与用户配置）落 `services` 表；派生层（候选入口、首选入口、三维状态）每次读请求现算。
`service_bindings` 只是"上次发现"的快照，用于诊断与容器重建后找回关联 —— **不是真相**。

**服务身份**：`sourceRef` 取 `docker:<compose项目>/<compose服务>`（无 Compose 标签时退化为
`docker:<规范化容器名>`：去副本后缀、小写、非字母数字转 `-`）或 `serve:<host>:<port><path>`；
手工服务取 `manual:<uuid>`。**容器 ID 不在身份里**，只作为绑定快照的"当前关联"——
这是"容器重建换 ID 后配置不丢"的唯一实现方式。

**发现缓存**：`TtlCache`（TTL 与容器列表一致，默认 2s；配置为 0 则不缓存），
`sync({ force: true })` 由 `POST /api/services/discover` 触发。
`ServiceRegistryService` 在**第一次读请求**时才取数，启动阶段不发任何请求
（`settings.initialize()` 之前不许有网络/进程调用）。

**入口优先级**（`ENTRY_RANK`，数字越小越优先）：`0` 用户指定 → `1` Serve HTTPS →
`2` Tailnet → `3` LAN → `4` 仅本机。`dedupeEntries()` 按 URL 与
`loopback:<port><path>` 两个键去重（后者解决 `127.0.0.1` 与 `localhost` 同时出现），
`pickEntry()` **只从可达候选里**取第一个；一个可达的都没有 → `entry: null`，
并在 `status.reasons` 里说明原因（前端据此解释而不是给死链）。

**健康探测**：默认 `skipped`（不配置就不探测）；结果只在内存（`HEALTH_RESULT_LIMIT = 512`，
超限淘汰最早一条），进程重启即清空 —— **落库会把"某一刻的探测结果"变成"永久的谎话"**。

### `src/modules/metrics/`（历史指标，S2-01 / S2-02）

Sprint 2 的"轻量历史监控"。六层严格分开，**副作用只出现在 `sampler.ts`（+ 仓储）与 `scheduler.ts`**：

| 文件 | 性质 | 导出 |
| --- | --- | --- |
| `types.ts` | 类型 + 指标目录 | `MetricUnit` `MetricResolution` `MetricRange` `MetricTargetKind` `MetricSourceStatus` `MetricDefinition` `METRIC_CATALOG` `metricByKey` `matchesTargetPattern` `MetricSample` `MetricCollection` `MetricPoint` `MetricSummary` `MetricGaps` `MetricHistoryView` `MetricTargetView` `MetricRangeSpec` `MetricBudgetView` `MetricStorageView` `MetricSchedulerView` `MetricCatalogView` `MetricsServiceRegistrySource` `MetricServiceVerdict` `MetricsHealthSource` `MetricsSystemSource` `MetricsContainerSource` `BucketWriteResult` `MetricsTickResult` |
| `buckets.ts` | 纯函数 + **唯一写入点** | `MINUTE_SECONDS` `HOUR_SECONDS` `HOUR_EXPECTED_MINUTE_ROWS` `minuteStart` `hourStart` `alignTo` `expectedSamples` `isPartial` `BucketAccumulator` `accumulatorKey` `addSample` `takeEnded` `BucketWriteInput` `accumulatorToRow` `HourAggregate` `hourValue` `hourAggregateToRow` `MetricBucketRow` `MetricBucketsRepository` `combineWriteResults` |
| `collector.ts` | 纯函数（无 I/O、无时钟） | `HOST_TARGET` `HOST_TARGET_LABEL` `verdictToRatio` `collectHostSamples` `collectContainerSamples` `collectServiceSamples` `mergeCollections` `collectionOf` `containerSource` `containersWithStats` |
| `history.ts` | 纯函数 | `bucketAtToIso` `METRIC_RANGES` `isMetricRange` `rangeSpec` `resolutionForRange` `rangeWindow` `expectedBucketsIn` `samplingNote` `bucketToPoint` `countGaps` `summarizeBuckets` `unknownSource` `BuildHistoryInput` `buildHistoryView` |
| `sampler.ts` | 编排（内存累积 + 落库 + 滚动 + 清理） | `MetricsDeps` `FlushResult` `RollupResult` `BASELINE_SERIES_PER_MINUTE` `METRIC_BYTES_PER_ROW` `STEADY_STATE_BUDGET_BYTES` `estimateBudget` `MetricsSampler` |
| `scheduler.ts` | 编排（后台单例，见下） | `DEFAULT_SCHEDULER_INTERVAL_MS` `MIN_SCHEDULER_INTERVAL_MS` `SchedulerDeps` `TickSummary` `BackgroundScheduler` |

**指标目录（`METRIC_CATALOG`，8 个 key）** —— `key` 是稳定标识，进库、进 URL、进前端，
**改名等于改契约**。数组顺序即前端展示顺序与 catalog 接口顺序。

| key | unit | target 形态 | 数据源 |
| --- | --- | --- | --- |
| `host.cpu.percent` | `percent` | `host` | `SystemProvider.snapshot().cpu.percent` |
| `host.memory.percent` | `percent` | `host` | `snapshot().memory.percent` |
| `host.memory.used_bytes` | `bytes` | `host` | `snapshot().memory.usedBytes` |
| `host.disk.percent` | `percent` | `disk:<label>` | `snapshot().disks[].percent` |
| `host.disk.used_bytes` | `bytes` | `disk:<label>` | `snapshot().disks[].usedBytes` |
| `container.cpu.percent` | `percent` | `container:<sourceRef>` | `containers.list({all:true,stats:true}).items[].stats.cpuPercent` |
| `container.memory.used_bytes` | `bytes` | `container:<sourceRef>` | 同上 `stats.memUsedBytes`（RSS 语义） |
| `service.health.up_ratio` | `ratio` | `service:<sourceRef>` | 健康监视器的最新判定 |

刻意只采 8 个 key：不加 GPU、不加网络、不加每核 CPU、不加全部容器
（容器上限 `PORTAL_METRICS_CONTAINER_LIMIT`）。历史库大小 = "key 数 × target 数 × 保留窗口"，
每加一个 key 都是**长期成本**。

`matchesTargetPattern(metric, target)` 只判**形态**（不判该 target 是否真的出现过）：
`host` 要求严格等于 `'host'`；其余要求以 `disk:` / `container:` / `service:` 开头**且前缀后非空**。
"是否出现过"由 `MetricsSampler.resolveTarget()` 负责 —— 两件事分开，是因为
"格式对但库里没有"与"格式就不对"要给前端不同的提示。

**`buckets.ts` —— 桶语义与"为什么缺测不写 0"**

| 纯函数 | 签名 | 说明 |
| --- | --- | --- |
| `minuteStart` / `hourStart` / `alignTo` | `(unixSeconds) => number` / `(unixSeconds, resolution) => number` | 桶起点 = `floor(t / step) * step` |
| `expectedSamples` | `(intervalSec, resolution) => number` | minute：`max(1, round(60 / intervalSec))`；hour：**恒 60**。`intervalSec` 非有限或 ≤0 时按 60 兜底（→ minute 的 expected = 1） |
| `isPartial` | `(samples, expected) => boolean` | `samples < expected` |
| `addSample` | `(accumulators, sample, bucketAt) => BucketAccumulator` | 折进累加器（不存在则新建）：`sum/count/min/max`；`replicas` 取**最大值**；`targetLabel` **随桶更新** |
| `takeEnded` | `(accumulators, before) => BucketAccumulator[]` | 取出并移除 `bucketAt < before` 的桶；返回按 `bucketAt` 再按 `metric\|target` 稳定排序（写入顺序可预测，测试才能断言具体行） |
| `accumulatorToRow` | `(acc, resolution, baseExpected, createdAt) => BucketWriteInput` | `value/min/max` 保留 3 位小数；**`expected = baseExpected × max(1, replicas)`** |
| `hourValue` | `(aggregate) => number` | `Σ(value×samples) / Σsamples` —— **按 samples 加权** |
| `hourAggregateToRow` | `(aggregate, createdAt) => BucketWriteInput` | `samples` = 该整点内**存在的 minute 行数**，`expected = 60` |
| `combineWriteResults` | `(results) => BucketWriteResult` | 把多次写结果相加 |

> **为什么 `expected` 要乘副本数**：多副本按服务合并成**一个** target（见 `collector.ts`），
> 于是同一 tick 对同一 target 有 N 个读数。若 `expected` 仍是"每分钟 tick 数"，
> `samples < expected` 永远不成立 —— "掉了一个副本"就再也报不出来。
> `replicas` 取桶内**最大值**而不是累加：它描述的是"每 tick 几个读数"，
> 与桶里累计了多少 tick 无关。

| `MetricBucketsRepository` 方法 | 签名 | 说明 |
| --- | --- | --- |
| `writeBuckets` | `(rows) => number` | **一次事务**批量 upsert（事务对象在构造期缓存，避免反复编译）；`rows` 为空时**直接返回 0 且不开事务** |
| `selectRange` | `(resolution, metric, target, from, to) => MetricBucketRow[]` | 按 `bucket_at` 升序；命中 `idx_metric_buckets_series` |
| `rollupMissingHours` | `(from, toExclusive) => HourAggregate[]` | 从 minute 行 `GROUP BY (bucket_at/3600)*3600` 聚合，**再剔除已有 hour 行的整点**。调用方必须保证 `toExclusive` 落在整点边界上（否则会把进行中的小时也聚合进来） |
| `deleteOlderThan` | `(resolution, cutoff) => number` | 单分辨率删除，返回行数 |
| `deleteExpired` | `(minuteCutoff, hourCutoff) => number` | **一次事务**删两个分辨率：要么都清完要么都不清 —— 半个清理状态会让"行数为什么不对"难以复现 |
| `countRows` / `storageStats` / `timeBounds` | — | 行数 / `page_count × page_size` + `freelist_count` / 每个分辨率最老最新时刻 |
| `seriesPerMinuteSince` | `(fromBucketAt) => number` | 窗口内 `DISTINCT metric,target` 的个数（存储预算"按实际规模修正"的依据） |
| `listTargets` | `(sinceBucketAt) => …` | 库中出现过的 target 及其最近一次标签/单位 |
| `findLatestTargetLabel` | `(metric, target) => string \| null` | 从未出现 → `null`（API 层据此返回 400） |

> `listTargets` 依赖 SQLite 的 **bare-column 语义**：与 `MAX(bucket_at)` 同组的裸列
> （`target_label` / `unit`）取自命中该最大值的行。因此它给的是"这个 target 最近一次的展示值"。
> 这是有意的（避免再写一条窗口函数），但它是一条**隐式约定** —— 换数据库就得改写。

UPSERT 语句是 `INSERT … ON CONFLICT(resolution, metric, target, bucket_at) DO UPDATE`，
更新 `value/min_value/max_value/samples/expected/target_label/unit/created_at`。

**三条不可动摇的语义**（写在文件头，测试逐条锁）：

1. **缺测 = 没有行**。整分钟/整小时一个样本都没有时**不写行**，也绝不写 `value = 0`。
   理由：`0` 是**合法读数**（宿主 CPU 真的可能是 0%）。用 0 表示"没样本"，
   事后无法区分 —— 图表会画出平线、告警会以为指标正常，保留统计也会把缺测算成数据。
   缺测的两种表达是：**没有行**（整桶缺）与 `samples < expected`（桶内部分缺，前端显示 partial）。
2. **一个桶只写一次**（幂等重写同一行）。同一分钟内多次刷新不会产生重复行。
3. **`target` 用稳定身份、不含容器 ID** —— 容器重建后曲线仍然连续。

**`collector.ts` —— 把快照翻译成样本（缺测在这里就被丢掉）**

| 函数 | 说明 |
| --- | --- |
| `verdictToRatio(verdict)` | `healthy → 1`，`unknown → null`，其余（`degraded`/`down`）`→ 0`。**`unknown` 不计入样本**：不知道就不能算健康，算成 0 会让恢复中的服务看起来一直在挂 |
| `collectHostSamples(snapshot)` | CPU `percent` / 内存 `percent` / 内存 `usedBytes` / 每个磁盘的 `percent` 与 `usedBytes`。**`null` 与非有限值一律跳过**（CPU 首次采样没有基线、statfs 失败）—— 它们是"不知道"，不是 0 |
| `collectContainerSamples(result, limit)` | `limit` 非有限或 ≤0 → `[]`（完全不采容器）。排序：**运行中的优先** → `containerServiceRef` 升序 → **容器名升序**（同一 target 的副本内部再排序，让样本产生顺序与 `containers.list()` 的返回顺序无关：桶内均值是浮点累加，顺序不同可能差最后一位） |
| `collectServiceSamples(result, verdictOf)` | 逐服务取判定，`null` 与 `unknown` 都跳过 |
| `containerSource` / `containersWithStats` | 容器数据源状态映射 / "取到 stats 的容器数"（诊断用，不影响落库） |

**多副本合并（关键边界）**：`containerServiceRef()` 对同一 compose 服务的所有副本返回
**同一个** target（`docker:<project>/<service>`），因此多副本合并为**一条序列**。
这个口径不能改成"每容器一条" —— 前端的目标列表是从 `/api/services` 的 `sourceRef` 推导的，
每容器一条会让副本曲线在界面上根本选不中。两条必须处理的后果：

- **标签只由 target 身份决定**：`labelOf(ref) = ref.replace(/^docker:/, '')`。
  刻意**不看"本 tick 有几个副本"** —— 否则副本数从 3 掉到 1 时标签会在
  `shop/web` 与 `web-1` 之间反复横跳，同一条序列的历史会显示成两个名字。
  （界面上更友好的名字来自 `/api/services` 的 `sourceRef → displayName`；这个标签是兜底。）
- **每个样本带 `replicaCount`**（本 tick 该 target 由几个副本贡献），供 `expected` 放大。
- **`stats` 为 null（已停止/未取到）时不产生样本**：容器的 CPU/内存缺测就是"没有行"，
  不是 0；此时该 target 本 tick 的贡献数低于副本数，于是这一分钟会正确显示为 partial。

**`sampler.ts` —— 一次 tick 做了什么（顺序不可换）**

```
1) flushPending(now)   已结束的分钟 → 批量落库（每 tick 至多一次写事务）
2) rollupHours(now)    整点滚动：从 minute 行聚合出缺失的 hour 行（每小时至多一次）
3) pruneIfDue(now)     保留清理（启动后第一次必做，之后每个整点一次）
4) collect(now)        取数据源 → 累加进**内存**里当前分钟的累加器（不写库）
```

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `tick` | `(now: number) => Promise<MetricsTickResult>` | `now` 是 **unix 秒** |
| `flushPending` | `(now) => FlushResult` | 只做 DB 写；已结束 = `bucketAt < 当前分钟起点` |
| `rollupHours` | `(now) => RollupResult` | 构造后**第一次调用必然执行**（用于补齐停机期间的整点） |
| `prune` | `(now) => number` | 返回删除行数；只 `DELETE`，不做 `VACUUM`（空闲页留给后续写入复用） |
| `lastTick` | `() => MetricsTickResult \| null` | 供 `/api/metrics/storage` 透出 |
| `availableTargets` | `() => MetricTargetView[]` | 库中出现过的 + **本进程刚采到但还没落库**的（后者 `lastSeenAt: null`） |
| `resolveTarget` | `(metric, target) => string \| null` | 形态对且**确实出现过**才返回标签；未知 → `null`（API 层转 400） |
| `history` | `({ metric, target, targetLabel, range }) => MetricHistoryView` | 一次 SELECT + 纯函数组装 |
| `catalog` | `(scheduler?) => MetricCatalogView` | 目录 + 可用 target + range 表 + 采样状态 |
| `storage` | `() => MetricStorageView` | 行数 / 文件占用 / 时间边界 / 保留配置 / 预算 / 最近一次采样摘要 |

`MetricsTickResult`：`at`（ISO）、`collected`（本 tick 接受的样本数）、
`samplesWritten`（= flush 的 samples 之和 + rollup 的 samples 之和）、
`bucketsFlushed`、`hoursRolledUp`、`pruned`、`gaps`、`errors[]`。

> **"为什么是内存累积 + 分钟落库"**：曲线的最小分辨率就是一分钟，
> 同一分钟里的所有样本最终只会变成一行。若每 tick 写库，30s 间隔下就是 120 次写事务/小时，
> 多出来的写全是浪费（这正是"采样引起高 CPU"的成因）。若"攒一小时再写"，
> 进程在小时内重启就丢掉最多 59 分钟样本。折中方案把**重启损失上界压到"当前这一分钟"**，
> 代价只是每分钟一次极小的写事务。
>
> **勘误（`sprint2-implementation-spec.md` §1.1 早期版本算错了）**：原文写的"每小时 2 次批量写"
> 是错的 —— 漏掉了 flush 发生在**每个分钟边界**。真实数字是
> **61 次/小时 = 60 次 flush + 1 次整点 rollup**
> （30s 采样间隔下；另加每小时 1 次保留清理）。因此"符合预算"的判据改成三条**机器可证**的形式：
>
> 1. **写事务数与 tick 密度无关**：30s 与 5s 两种间隔跑同样 30 小时，写事务数完全相同
>    （`metricsSampler.test.ts` 实测 **1861** = 1800 次分钟 flush + 30 次 rollup + 31 次清理，
>    3601 tick 与 21601 tick 得到同一个数）；
> 2. **整点那一 tick 恰好 2 次批量写**（flush + rollup）—— 可精确断言的锚点
>    （该 tick 另有 1 次清理事务，断言里分开计数）；
> 3. **与前端会话数无关** —— 采样是后台单例，一个浏览器都没连时照样采
>    （`schedulerIntegration.test.ts` 用零 SSE/HTTP 客户端验证）。
>
> 真正要守的核心不变量是**"不产生每 tick 一次的库写"**，第 1 条正是它的可证形式。
> 被否决的替代方案（攒到整点才 flush）能做到字面上的"2 次/小时"，
> 代价是**当前小时只存在于内存**：重启最多丢 59 分钟、且 1h 视图在整点前恒为空。

**缺测与 `gaps` 的精确口径**（最容易读错的地方）：

- `flushPending` 的 `gaps = partial + missingMinutes`。`missingMinutes` 是"**整分钟一个样本都没有**"的分钟数，
  通过 `[上一次 tick 所在分钟, 当前分钟)` 的分钟数减去这段里**真的有累加器**的分钟数得到 ——
  这样"tick 过但零样本"的那一分钟也被算成缺口（它同样没有行）。
- **进程启动后的第一个 tick 不计缺口**（`lastTickBucketAt === null`）。停机期间缺的行只能从
  `history` 的 `gaps.missingBuckets` 看出来 —— 这是刻意的：重启那一刻没有"上一个 tick"可参照。
- `rollupHours` 的 partial（`samples < 60` 的整点）**不计入 `tick().gaps`**，它只在
  `RollupResult.partial` 与日志里出现；界面上的 partial 由行自身的 `samples/expected` 表达。
- `rollupHours` 的回溯窗口 = `max(2, ceil(minuteRetentionHours))` 小时：只可能补出
  "minute 行还在"的整点，因此取 minute 保留窗口即可，至少 2 小时以保证短暂停机也能补上。
  没有 minute 行的整点**不写行**（那就是缺测，不凭空造 hour 行）。
- 清理时刻：`minuteCutoff = minuteStart(now) - minuteRetentionHours × 3600`，
  `hourCutoff = hourStart(now) - hourRetentionDays × 86400`，两者在**同一事务**里删。
- `intervalSec()` 每次读取都从注入闭包/config 求值；非有限或 ≤0 回退 60（避免 `expected` 变成 `NaN`）。

**存储预算（`estimateBudget` / `MetricBudgetView`）** —— "符合预算"的判据就照这个实现：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `BASELINE_SERIES_PER_MINUTE` | `36` | 规格 §1.1 的典型部署基准（host 3 + 磁盘 6 + 容器 20 + 服务 7） |
| `METRIC_BYTES_PER_ROW` | `200` | 每行估算（含索引开销） |
| `STEADY_STATE_BUDGET_BYTES` | `32 MB` | 稳态总量上限 |

`estimateBudget({ minuteRetentionHours, hourRetentionDays, observedSeriesPerMinute })`：

| 字段 | 计算 |
| --- | --- |
| `basis` | 最近一小时实测序列数 `> 0` → `'observed'`，否则 `'baseline'` |
| `seriesPerMinute` | 上述实测值或 `BASELINE_SERIES_PER_MINUTE` |
| `minuteRowsPerDay` / `hourRowsPerDay` | `series × 1440` / `series × 24` |
| `minuteSteadyRows` | `round(series × 60 × minuteRetentionHours)` —— **只与保留窗口有关，与跑了多久无关** |
| `hourSteadyRows` | `hourRowsPerDay × hourRetentionDays` |
| `estimatedBytesPerDay` / `estimatedSteadyBytes` | 行数 × `METRIC_BYTES_PER_ROW` |
| `withinBudget` | `estimatedSteadyBytes <= STEADY_STATE_BUDGET_BYTES` |
| `note` | 必须写明"这是估算而非实测，实测占用见 `size.bytes`；分钟行数由保留窗口封顶" |

**判据 ②（minute 行数不随运行时长增长）由 `minuteSteadyRows` 表达**，
它比"总量小"更能证明没有泄漏；`MetricStorageView.size.bytes` 是**实测**
（`page_count × page_size`），两者一起看：预算回答"照这个规模跑一年会不会涨到不可接受"，
实测回答"现在到底多大"。

**`history.ts` —— range → 窗口 → 缺口 → summary**

| 导出 | 说明 |
| --- | --- |
| `bucketAtToIso(seconds)` | 桶时刻 → ISO。**刻意不用 `unixSecondsToIso`**：后者在 0 时返回 `null`，而 0 是合法时刻 |
| `METRIC_RANGES` | `1h`(minute, 60 桶) / `24h`(minute, 1440) / `7d`(hour, 168) / `30d`(hour, 720)，顺序即前端下拉顺序 |
| `isMetricRange` / `rangeSpec` / `resolutionForRange` | 合法性判定 / 取规格（非法**抛错**，调用方须先校验）/ range → resolution |
| `rangeWindow(range, now)` | `to = floor(now/step)*step`，`from = to - windowSec`。**`to` 也向下对齐**：桶是左闭右开整数区间，未结束的当前桶不该算进"应有桶数"，否则每个窗口都永远缺一个桶 |
| `expectedBucketsIn(from, to, resolution)` | `floor((to - from)/step)`；`to <= from` → 0 |
| `samplingNote(intervalSec, resolution)` | 前端必须展示的四项之一（另外三项是单位、数据源、缺测数量） |
| `bucketToPoint(row)` | 一行 → 一个点（`partial = samples < expected`） |
| `countGaps(rows, expectedBuckets)` | `missingBuckets = max(0, 应有 − 实际行数)`；`partialBuckets` = 行里 partial 的数量 |
| `summarizeBuckets(rows)` | 对**有值的桶**做 min/max/avg + 最新值。窗口内一行都没有 → `count: 0` 且**其余全为 `null`**（不用 0 冒充）；`min` 取各行 `minValue` 的最小、`max` 取各行 `maxValue` 的最大、`avg` 是各行 `value` 的**算术平均**（不加权，与 hour 聚合口径不同） |
| `unknownSource(reason)` | 数据源未知时的占位（诚实说明"这次没采到"，而不是 `available: true`） |
| `buildHistoryView(input)` | 组装 `GET /api/metrics/history` 响应。**不做任何单位换算**：percent 就是百分比，bytes 就是字节数，前端按 unit 选刻度 |

`sample.mode` 缺失时 `buildHistoryView` 用
`unknownSource('本进程尚未采集到该指标的数据源状态（重启后需要一次采样）')` ——
`lastSources` 是内存的，重启后第一次采样之前没有来源信息，这里**不允许静默填 `available: true`**。

**`scheduler.ts` —— `BackgroundScheduler`（唯一的后台单例）**

| 导出 / 成员 | 签名 | 说明 |
| --- | --- | --- |
| `DEFAULT_SCHEDULER_INTERVAL_MS` / `MIN_SCHEDULER_INTERVAL_MS` | `30000` / `1000` | 间隔兜底值与下限（防设置页填出 1ms 把宿主打满） |
| `SchedulerDeps` | `{ health, metrics, alerts, logger, clock?, intervalMs? }` | 三步只要求 `tick(now)` 这一个方法（结构类型）；**默认 `clock` 是 `Math.floor(Date.now()/1000)`，单位是 unix 秒** |
| `TickSummary` | `{ at, durationMs, skipped, health, metrics, alerts, error }` | 三步结果**可为 `null`** = 该步未执行或失败（不用 0 值冒充"跑过了"） |
| `start()` | `() => void` | **立即跑一次** tick，再排期；重复调用是空操作。立即跑是必要的：重启后要尽快补齐停机期间的整点，并让页面在第一个间隔之前就有状态 |
| `stop()` | `() => void` | 清定时器；`app.close()` 必须调用 |
| `tickOnce(now?)` | `(now?: number) => Promise<TickSummary>` | 单飞；`now` 为 **unix 秒**，省略时取注入时钟 |
| `running` | `get => boolean` | 定时器是否在跑 |
| `lastSummary()` | `() => TickSummary \| null` | 最近一次**真正跑过**的摘要（被跳过的轮次不覆盖它） |

**三条硬约束**：

1. **顺序固定**：`health.tick()` → `metrics.tick()` → `alerts.tick()`。这是契约：
   指标里的 `service.health.up_ratio` 必须用**本 tick 刚更新**的判定，
   告警评估必须看到**本 tick 刚写入**的样本（`schedulerIntegration.test.ts` 断言三步都非 null，
   且告警用例断言 `evaluated > 0`）。
2. **单飞**：上一轮未结束时新的 tick 立即返回 `{ skipped: true, durationMs: 0, health/metrics/alerts: null }`，
   **不排队、不并发、不等待**。等待在飞的那一轮会让 tick 队列越积越长（每轮都慢就是雪崩）。
3. **失败隔离**：每一步各自 `try/catch`，错误累加进 `TickSummary.error`（多步用 `; ` 连接）并 `logger.warn`，
   **绝不向上抛**；剩下的步骤仍然执行。采集失败在落库时就表现为"那一分钟没有样本"（gap），不是 0。

**定时器与 live 生效**：`schedule()` 里 `setInterval` 之后**必须 `unref()`**
（否则 `backgroundJobs: false` 之外的测试进程会被定时器吊住）；`intervalMs()` 在
**每次排期时重新求值**，并且每次触发时比较当前值 —— 变了就先按新间隔重新排期、
**本轮仍然照跑**（空转一轮没有必要）。这就是"设置页改了采样间隔，下一个周期即生效"的落地方式
（`app.ts` 注入的闭包是 `() => config.metrics.sampleIntervalSec * 1000`）。

> **与规格的两处差异，按实现为准**：① 规格写 `clock?: () => number; // 默认 Date.now`，
> 实现里默认是**秒**（各位 `tick(now)` 的契约都是 unix 秒）。
> ② 规格的 `TickSummary` 把三步写成非空类型，实现里是 `| null` ——
> "这一步根本没跑/跑挂了"与"跑了但结果为 0"必须能区分。
> `HealthMonitor` / `AlertEngine` 的注入时钟默认是**毫秒**（`Date.now`），
> 但它们都用 `toEpochMs()` 归一化，因此**秒制与毫秒制都能吃**。

### `src/modules/health/`（健康监测，S2-03）

分层与 Sprint 1 的服务注册表一致：`state.ts` 是**纯状态机**（无 I/O、不读时钟），
`monitor.ts` 是编排（取服务/容器、节流探测、并发上限、写内存状态），`types.ts` 只有类型与常量。

| 文件 | 性质 | 导出 |
| --- | --- | --- |
| `types.ts` | 类型 + 常量 | `HealthDimensionState` `HealthVerdict` `HealthDimensionKey` `HEALTH_DIMENSION_KEYS` `HealthDimension` `HealthSignal` `ServiceHealthState` `HealthTickResult` `HealthProbeStats` `HealthMonitorServiceView` `HealthMonitorView` `DEFAULT_FAIL_THRESHOLD` `DEFAULT_OK_THRESHOLD` `DEFAULT_PROBE_INTERVAL_SEC` `DEFAULT_PROBE_CONCURRENCY` `MAX_TRACKED_SERVICES` `toEpochMs` `isoFromMs` `normalizeThreshold` |
| `state.ts` | 纯函数 | `evaluateHealth` |
| `monitor.ts` | 编排 | `CONTAINER_SNAPSHOT_TTL_MS` `HealthRegistrySource` `HealthContainersSource` `HealthMonitorDeps` `HealthMonitor`（并 re-export `HealthTickResult` / `HealthMonitorView` / `ServiceHealthState`） |

**为什么不落库**：健康状态是"此刻的判定"，落库会把它变成**永久的谎话**（与 Sprint 1 的
`healthResult` 同一理由）。进程重启即清空，连续计数重新攒。

**`state.ts` —— 三维判定 + 两级去抖（规则逐条锁）**

```ts
evaluateHealth(previous, signal, { failThreshold, okThreshold, at }): ServiceHealthState
```

| 维度 | 合格（`ok`） | 不合格（`fail`） | 没信号（`unknown`） |
| --- | --- | --- | --- |
| `container` | 绑定的容器**全部 running** | 有容器非 running（`exited`/`dead`/`restarting`/`created`/`paused`/`removing`，以及状态读不出来时的 `unknown`） | 没有绑定容器（**不猜**） |
| `dockerHealth` | 全部 `healthy`，或没声明 HEALTHCHECK（`health` 为 `null` / `none`） | 有容器 `unhealthy` | `starting`（健康检查还没通过）；没有绑定容器 |
| `http` | 最近一次探测成功 | 最近一次探测失败/超时 | 没有 `healthTarget`（**不探测**）；有目标但从未探过（detail 为 `尚未探测`） |

判定规则（`healthState.test.ts` 26 条用例逐条对应）：

1. `failThreshold`（默认 3）次**连续**失败才判 `down`；未到阈值是 `degraded`
   （单次抖动不告警）。"失败"的定义在**服务级**：三维中至少一维 `fail`，因此服务级计数**跨维度连续**。
2. `okThreshold`（默认 2）次**连续全好**才回到 `healthy`（恢复去抖）。
   **首轮评估不做恢复去抖**（`previous === null` 时第一次全好就是 `healthy`）——
   去抖是为了抑制"状态来回跳"，首轮没有前一状态可跳；若此时返回 `degraded`，
   `service.health.up_ratio` 会在每个新服务的第一个采样点写下 0，那是**凭空的失败样本**。
3. `unknown` 维**不参与**成败判定。三维全 `unknown` → verdict `unknown`，
   且**服务级计数原样保留**（"没信号"不该抹掉已有的失败连续数）。
4. 维度计数**互相独立**：HTTP 连续失败 2 次而容器正常时，`http.consecutiveFailures = 2`、
   `container.consecutiveFailures = 0`，verdict 仍是 `degraded`。
5. **任一维状态变化 → 该维计数归零重算**；`changedAt` 只在 **verdict 变化**时更新
   （`lastEvaluatedAt` 每轮都更新）。
6. `reasons` 用人话写清维度、次数与证据：`连续失败 3 次（阈值 3），判定为不可用`、
   `容器 sisi-calendar 已退出（exited）（连续 1/3 次）`、`HTTP 探测失败 2/3 次：连接超时`、
   `容器健康检查未通过（sisi-calendar: unhealthy）（连续 1/3 次）`、
   恢复中写 `正在恢复：连续正常 1/2 次，尚未达到恢复阈值`、全未知写
   `三维均为未知：没有可用信号，暂不判定`。**证据不足时只报维度与次数**（`detail` 由监视器提供），
   健康时 `reasons` 为空数组 —— 不编原因。
7. 没有 `healthTarget` 的服务：`http` 维固定 `unknown` 且**不探测**，由容器维决定 verdict
   （与 Sprint 1 的"默认 skipped 不探测"一致）。

> **`unknown` 到底清不清零？两个层级不一样，必须分清**：
> - **维度级**：状态不是 `fail` 就把该维的 `consecutiveFailures` 记 0
>   （`state === 'fail' ? 续计 : 0`）。所以"某维 fail 2 次后变 unknown"会让该维计数归零。
> - **服务级**：只有"三维全 `unknown`"才走"计数原样保留"的分支；
>   只要有一维 `ok`/`fail`，就按成功/失败推进。
> 这两条一起才构成"unknown 既不推进也不抹掉服务级失败连续数"，
> 但它**不是**"任何位置的 unknown 都不清零"。

`changedAt` / `lastProbeAt` 的写法：`lastProbeAt` **只由 `signal.probedAt` 推进**
（`http !== 'unknown'` 不能作判据 —— 节流时 http 仍报上次结论）。
`toEpochMs` 的阈值取 `1e11`：毫秒制下是 1973 年，秒制下是公元 5138 年，两者不可能混淆；
单位错 1000 倍的症状只是"探测比预期频繁"，很难定位，所以在这里挡住。
`normalizeThreshold` 对非有限或 <1 的值回退默认（配置错误不该让状态机失去去抖能力）。

**`monitor.ts` —— `HealthMonitor`**

| 成员 | 签名 | 说明 |
| --- | --- | --- |
| `tick` | `(now: number) => Promise<HealthTickResult>` | `now` 毫秒或秒都行（经 `toEpochMs`）。返回 `{ at, evaluated, probed, skippedForConcurrency, failures }` |
| `states` / `state` | `() => ServiceHealthState[]` / `(sourceRef) => ServiceHealthState \| null` | 按 `sourceRef` 稳定排序 / 单个 |
| `probeStats` | `() => HealthProbeStats` | `{ intervalSec, concurrency, inFlight, lastRunAt, probedThisTick, skippedForConcurrency }` |
| `view` | `() => HealthMonitorView` | `GET /api/health/monitor` 的响应体（比规格的类方法表多一个 `view()`：路由层不该知道标签从哪来，降级原因必须与判定结论出现在同一个响应里） |

一次 `tick` 的顺序：取服务（`registry.list(request, {}, 'viewer')`）→ 按 `sourceRef` 排序 →
取容器快照 → 决定探测名单 → 探测 → **逐服务评估恰好一次** → 丢弃已消失的服务状态。

| 行为 | 口径与边界 |
| --- | --- |
| 服务列表 | `role: 'viewer'` —— **hidden 服务不纳入监控**。hidden 是用户"我不想看到它"的明确表达，后台继续采它的健康指标并把名字写进 `/api/health/monitor` 等于绕过用户的隐藏 |
| 容器维 / docker health 不额外发请求 | 用 `containers.list({ all: true, stats: false })` 的结果，**自建 2s 快照缓存**（`CONTAINER_SNAPSHOT_TTL_MS`）。刻意用**注入时钟**判过期，而不是 `util/cache.ts` 的 `TtlCache`（后者读真实 `Date.now`）—— 否则测试里"推进时钟"对缓存不生效，TTL 行为无法确定性验证 |
| 容器列表取不到 | 返回 `null` → 容器维与 docker health 都退化为 `unknown`。**不拿过期快照冒充现状**：用几分钟前的状态说"容器还在跑"比承认"不知道"更危险 |
| HTTP 探测节流 | 每个服务距上次**真的探过**不足 `intervalSec` 就不探。失败也算"探过"（避免打爆故障目标）。`intervalSec = 0` → **完全不探测**（名单为空）但仍评估容器维 |
| 全局并发上限 | `budget = max(0, concurrency - inFlight)`，名单按 `sourceRef` 稳定排序后 `slice(0, budget)`；装不下的记入 `skippedForConcurrency`，**推迟到下一 tick，不排队、不无限等待**。`inFlight` 是**全局**的（不只是本 tick）—— 万一 `tick()` 被并发调用，"每 tick 几个"会退化成"每 tick 几乘调用次数个"，上限就形同虚设 |
| 探测异常兜底 | `runProbes` 里对每个探测 `try/catch`：注入的替换实现抛错时转成 `state: 'fail'` + `探测异常：…`（`healthProbe` 自己绝不抛）。一次探测异常不该让整轮 tick 崩掉 |
| 探测实现 | 生产由 `app.ts` 注入 `(target, options) => runHealthProbe({ target, timeoutMs })` —— SSRF 拒绝清单、3s 超时、16KB 响应体上限全在 `healthProbe.ts` 里，**不要复制一份探测逻辑** |
| 三维信号组装 | `target === null` → `http = 'unknown'` + detail `未配置健康检查目标，不探测`；本轮探到了 → 按结果 `ok`/`fail`；**被节流（或没排上）→ 沿用上次 http 结论**（`details.http = '尚未探测'` 如果从没探过）。否则"没探测"会被误读成"没信号"，一次 HTTP 失败会在下一 tick 被自己的节流抹平，连续失败计数永远攒不到阈值 |
| `probedAt` | **只有真的探了才填** —— 它决定 `lastProbeAt`，也就是下一轮的节流基准 |
| 状态淘汰 | 仅在服务列表**非空**时执行（空列表通常意味着发现失败/Docker 刚重启，此时清空会把所有连续失败计数抹掉，故障期间的告警随之消失）。同时按 `MAX_TRACKED_SERVICES = 512` 淘汰**最久未评估**的条目，保证内存有界 |
| 视图 notes | **不允许静默为空**：关闭自动探测、服务列表不可用、容器列表不可用、本轮有探测被并发上限推迟、还没有可监测的服务 —— 逐条写进 `notes` |
| 阈值 | `view().thresholds` 恒为 `DEFAULT_FAIL_THRESHOLD` / `DEFAULT_OK_THRESHOLD`（3 / 2）一并透出：没有它前端无法解释"为什么失败 2 次还不告警"。这两个值目前**不是**可配置项 |

> **与规格的一处差异**：规格的 `HealthMonitorDeps.intervalSec` / `concurrency` 写"默认读 config"，
> 实现里的默认值是**常量**（`DEFAULT_PROBE_INTERVAL_SEC = 300` / `DEFAULT_PROBE_CONCURRENCY = 4`），
> 真实配置由装配方以闭包注入（`app.ts` 传 `() => config.health.probeIntervalSec` / `…probeConcurrency`）。
> 这样"配置项还没落地"时本模块照样能编译、能单测，接线时也不会有两处真相。
> `intervalSec` 非有限或 <0 回退 300（**0 是合法值 = 关闭**）；`concurrency` 非有限或 <1 回退 4。

### `src/modules/alerts/`（告警，S2-04）

| 文件 | 性质 | 导出 |
| --- | --- | --- |
| `types.ts` | 契约类型 + 纯映射 | `AlertKind` `AlertSeverity` `AlertRuleDbRow` `AlertRuleRow` `BuiltinAlertRule` `AlertRulePatch` `AlertRuleView` `AlertEventState` `AlertEventDbRow` `AlertEventView` `AlertEventCounts` `AlertRuleListResponse` `AlertEventListResponse` `AlertSummaryTopItem` `AlertSummaryView` `HealthVerdictLike` `AlertSnapshot` `AlertTickResult` `toAlertRuleRow` `toAlertRuleView` `alertEventState` `toAlertEventView` |
| `rules.ts` | 纯函数 | `ALERT_KINDS` `THRESHOLD_PERCENT_MIN_EXCLUSIVE` `THRESHOLD_PERCENT_MAX` `DURATION_SEC_MAX` `SILENCE_SEC_MIN` `SILENCE_SEC_MAX` `SERVICE_FAILURE_THRESHOLD_MIN` `SERVICE_FAILURE_THRESHOLD_MAX` `RULE_TARGET_MAX_LENGTH` `BUILTIN_ALERT_RULES` `mergeBuiltinRules` `RulePatchValidation` `validateRulePatch` `compareAlertRules` |
| `engine.ts` | 编排（评估 + episode 落库） | `AlertAuditSink` `AlertEngineDeps` `AlertCandidate` `RuleOutcome` `evaluateRule` `AlertSnapshotSourceDeps` `createAlertSnapshotSource` `AlertEngine`（并 re-export `AlertTickResult`） |
| `service.ts` | 业务出口 | `ALERT_EVENTS_DEFAULT_LIMIT` `ALERT_EVENTS_MAX_LIMIT` `ALERT_SUMMARY_TOP_LIMIT` `AlertsServiceDeps` `AlertEventQuery` `AlertsService` `normalizeLimit` |

两套命名刻意分开，不要混：`AlertRuleDbRow` / `AlertEventDbRow`（**数据库行**，snake_case）
与 `AlertRuleRow`（**领域行**，camelCase）。映射集中在 `toAlertRuleRow` / `toAlertEventRow`，
混用会导致"列名改了一个字却没人发现"。
`AlertRuleView` / `AlertEventView` 是 **HTTP 契约**（进前端），字段名改动等于改契约。

> **照实记录：三处注释与实现已经不一致（代码是对的，注释过期了）**
>
> 1. `types.ts` 的 `AlertSnapshot.containers[].exitCode` 注释、`engine.ts` 的
>    `createAlertSnapshotSource` 注释与 `readExitCode()` 注释都写着
>    "Sprint 2 的 `ContainerSummary` **没有**映射 `inspect.State.ExitCode`，当前实际为 null"。
>    **这句话已经不对了**：本轮 `docker/types.ts` + `mapper.ts` 已经映射了 `exitCode`，
>    `readExitCode()` 的容错读取（`(container as {exitCode?: unknown}).exitCode`）
>    现在拿到的是**真实退出码**。也就是说 `container_exit` 规则在生产上
>    **确实能因"exited + 非 0 退出码"触发**，而不是只能靠 `dead` 触发。
>    函数名与容错写法保留是对的（将来字段再变也不用改这里），但注释需要更正。
> 2. `alertEngine.test.ts` 的用例「用真实容器列表构造的快照（exitCode 未映射 → null）
>    不会误报 exited」标题与注释同样过期：它之所以仍然通过，是因为
>    `support/serviceFixtures.ts` 的 `makeContainer()` 把 `exitCode` 默认成 `null`，
>    **而不是**因为字段不存在。这条用例现在实际断言的是"退出码未知时不误报"（这仍然有价值），
>    但它的标题会让人误以为集成缺口还在。
> 3. `types.ts` 的 `normalizeKind()` 注释写"DB 有 CHECK 约束"。**迁移 v5 的
>    `alert_rules` / `alert_events` 没有 `kind` / `severity` 的 CHECK 约束**
>    （v1 的 `users.role` 才有）。因此 `normalizeKind` / `normalizeSeverity`
>    不是"防手写测试数据"，而是**唯一**的形状收敛点 —— 这句话的实际含义比注释更强。

**`rules.ts` —— 内置四条 + 阈值校验**

内置规则（`builtin = 1`、`enabled = 0`、**不可删除**，可在网页开关/改阈值）：

| id | kind | name | threshold | durationSec | silenceSec | severity |
| --- | --- | --- | --- | --- | --- | --- |
| `rule-disk-percent` | `disk_percent` | 磁盘使用率过高 | 85 | 600 | 3600 | `warning` |
| `rule-memory-percent` | `memory_percent` | 内存使用率过高 | 90 | 300 | 3600 | `warning` |
| `rule-container-exit` | `container_exit` | 容器异常退出 | 0 | 0 | 3600 | `critical` |
| `rule-service-health` | `service_health` | 服务连续探测失败 | 3 | 0 | 3600 | `critical` |

取值的理由：磁盘 85% 持续 10 分钟、内存 90% 持续 5 分钟是"确实要处理但不必半夜起来"的量级；
容器异常退出与服务连续探测失败是**事实级**故障，所以 `critical` 且无需 duration；
静默期统一 1 小时（"一小时内不重复刷屏"）。

| 函数 | 签名 | 说明 |
| --- | --- | --- |
| `mergeBuiltinRules` | `(rows, now) => AlertRuleRow[]` | 只补**缺失**的内置规则（按 `id`），已存在的行**原样保留** —— 管理员改过的阈值不能被"补齐"悄悄改回去。补齐行的 `createdAt`/`updatedAt` 取 `now`（常量表里留空串） |
| `validateRulePatch` | `(kind, patch) => { ok: true; value } \| { ok: false; reason }` | 部分更新：只校验**提供了**的字段。字段白名单之外的键直接拒绝（"不支持的字段 X"）；越界一律拒绝，**不静默截断** |
| `compareAlertRules` | `(a, b) => number` | 内置在前 → `ALERT_KINDS` 顺序 → 名称 |

阈值取值域与**目标形态**校验（后者容易被忽略，代价是"配了但永远匹配不到目标"）：

| kind | `threshold` | 其它字段 | `target` 前缀要求 |
| --- | --- | --- | --- |
| `disk_percent` | `(0, 100]` | `durationSec ∈ [0, 86400]`；`silenceSec ∈ [60, 604800]` | `disk:` 或 `null` |
| `memory_percent` | `(0, 100]` | 同上 | 只能是 `host` 或 `null` |
| `container_exit` | **必须为 0**（非 0 退出码即触发，不设百分比） | 同上 | `container:` 或 `null` |
| `service_health` | `[1, 10]` 且必须整数 | 同上 | `service:` 或 `null` |

`threshold: null` 一律拒绝（"容器退出规则用 0 表示非 0 退出码即触发"）。
`target` 通用形状：非空串（清空请传 `null`）、不含空白与控制字符、长度 ≤ `RULE_TARGET_MAX_LENGTH = 200`。

**`engine.ts` —— episode 模型 + 静默期 + 恢复**

**为什么必须是 episode 模型**：容器一直处于 `exited`、磁盘一直高于阈值，
如果每次 tick 都插一行，一晚上就是几千条 —— 那不是告警，那是日志。
episode 把"一次故障"压成一行，恢复写 `resolved_at`，静默期内再次发生只把同一行重开
（`reopen_count + 1`），所以"一小时内不重复刷屏"是**结构性**保证的，不依赖任何一个计数器。

| `evaluateRule(rule, snapshot, nowMs, pendingSince)` 的 kind 分支 | 触发条件 | 目标 | value/unit |
| --- | --- | --- | --- |
| `disk_percent` | `percent > threshold` 且 duration 已满（`rule.target === null` 时对每个磁盘各评一次，按 label 去重） | `disk:<label>` | 当前百分比 / `percent` |
| `memory_percent` | 宿主内存 `percent > threshold` 且 duration 已满 | 规则 target 或 `host` | 百分比 / `percent` |
| `container_exit` | `state === 'dead'`，或 `state === 'exited'` 且 **`exitCode` 已知且非 0** | `container:<sourceRef>` | 退出码 / `exit_code` |
| `service_health` | `consecutiveFailures >= threshold`（由状态机给，**引擎不再自己数**，否则两处计数必然漂移） | `service:<sourceRef>` | 连续失败次数 / `count` |

**"不触发"与"可恢复"是两件事**（`RuleOutcome.cleared` 的语义）：只有**明确判定条件已不成立**
才进 `cleared`；数据未知时**既不说还在故障，也不说已恢复**。逐条：

| 情况 | 行为 |
| --- | --- |
| 磁盘/内存 `percent === null`（取数失败） | 不触发也不恢复。"取数失败就自动恢复告警"是运维上最糟糕的假象 |
| 指定 `target` 的磁盘从快照里消失，但**其它磁盘还在** | 说明确实没有这块盘 → `cleared`（可恢复） |
| 磁盘列表整体为空 | 视为取数失败 → 不动 |
| `exited` + 退出码 `0` 或 `null` | 不动（证据不足）。**未知退出码宁可漏报，也不能把正常停止报成异常退出** |
| `running` | `cleared`（规格明文的恢复条件 = 容器重新 running） |
| 指定 `target` 的容器不在快照里（被删除） | 不动，**不假恢复** |
| 指定 `target` 的服务不在健康状态里（发现失败/还没评估过） | 不动 |

`gateDuration(rule, target, conditionTrue, nowMs, pendingSince)` 是 **duration 门控**，
`pendingSince` 是跨 tick 共享的内存 Map（key = `ruleId|target`）：
条件不成立时**立刻忘记起点**并返回 false（这样"抖动一下又恢复"不会把不同时间段的持续时间
累加成一个假的"持续了 10 分钟"）；成立时首次记录起点，`nowMs - since >= durationSec × 1000` 才算数。

`AlertEngine` 一轮 tick 的处理顺序（顺序本身是契约）：

1. 载入**启用**的规则（`enabled = 0` 的规则**完全不评估** —— 默认四条内置即"装了但不吵"）
   与全部未恢复 episode（`resolved_at IS NULL`，key = `ruleId|target`）。
2. 逐规则 `evaluateRule`。
3. **先处理恢复**：`cleared` 里、且确实有未恢复行的 → 写 `resolved_at`、`resolved++`。
4. **再处理触发**：候选已有未恢复行 → `suppressed++`（**不插新行**：这是"重启不重复通知"的落地）；
   否则走 `recordTrigger`。
5. `recordTrigger`：查最近一条同 `(rule, target)` 的 episode，若它**已恢复**且距其
   `fired_at`（上次触发，**不是恢复时间**）不足 `silenceSec` → **重开**该行；否则插入新行。
   插入若撞上部分唯一索引（并发/异常路径下已存在未恢复行）→ 记 `suppressed` 而不是抛错
   —— 那不是故障，而是不变量在起作用。

| 落库细节 | 说明 |
| --- | --- |
| 重开 | `resolved_at = NULL`、`reopen_count + 1`、**清空 `acknowledged_at/by`**、`started_at`/`fired_at` 更新为本次，并刷新 kind/rule_name/target_label/severity/value/threshold/unit/message。确认（ack）的语义是"我知道这一次故障了"，故障重开是一个**新的事实**，沿用已过期的"我知道了"会让看板骗人 |
| `started_at` | = **条件首次成立**的毫秒时刻（可能早于 `fired_at`：duration 窗口），以 ISO 落库 |
| 消息 | 百分比类写 `磁盘 C: 使用率 91.2%（阈值 85%，已持续 12 分钟）`；`durationSec = 0` 时**不写"已持续"**（避免"已持续 0 分钟"这种噪声）；容器类写 `容器 gitea 异常退出（exited，退出码 137）`；服务类写 `服务 Gitea 连续 3 次探测失败（阈值 3 次）` |
| 审计 | `alert.fired` / `alert.reopened` / `alert.resolved`，`detail` 只放非敏感字段（eventId/ruleId/kind/target/value/threshold/reopenCount/notifyRecovery）。**写入失败只 warn，不回滚、不抛错**（告警已经落库） |
| `suppressed` | 累计被"已有未恢复行"压掉的触发次数（自进程启动）。它的唯一理由是让"没有告警"可解释：是被压掉了，还是条件根本没成立 |

**其他成员**：`lastTickAt()`（ISO，供 `summary().evaluatedAt`）、`suppressedTotal()`、
`pendingCount()`（diagnosis：当前 duration 计时中有多少目标）、
`tick(now, snapshot?)`（`now` 非有限时退回注入时钟，而不是让 `NaN` 静默污染所有时间比较）。

**`duration` 计时在内存里丢是刻意的**：进程重启后 `pendingSince` 清空，
只是"持续时间重新计时"（最多晚 `durationSec` 报一次，宁晚一轮不误报）；
而**未恢复的告警绝不能因为重启再通知一次** —— 那条由数据库的部分唯一索引兜住，与内存无关
（`alertEngine.test.ts` 有"预置一行未恢复时 tick 绝不插新行"的用例）。

**引擎不做任何出站调用、不重启任何东西**：`backgroundBoundary.test.ts` 以源码能力边界钉住
（无 `fetch(` / `node:http(s).request` / `net.connect` / 子进程 / 通知客户端；
不得**值导入** `docker/service.js` / `docker/provider.js` / `dockerode`）。

**`createAlertSnapshotSource(deps)`** —— 可选依赖，给"只传一个参数调 `tick(now)`"的调度器用：

| 快照字段 | 来源 | 单源失败时 |
| --- | --- | --- |
| `at` | 传入的 `nowMs`（毫秒） | — |
| `host.cpuPercent` / `memoryPercent` / `disks[]` | `system.snapshot()` | 全部为 `null` / 空数组（对应规则本轮不触发也不恢复） |
| `containers[]` | `containers.list({ all: true, stats: false })` + `containerServiceRef()` 算 `sourceRef` | 空数组 |
| `services[]` | **`health.states()`**（不是服务列表）+ 从服务列表取 `displayName` 当标签 | 标签退化为 `sourceRef` |

> **服务宇宙取健康状态而不是服务列表**：列表里有而状态里没有的服务意味着"还没评估过"，
> 把它当成 `consecutiveFailures = 0` 会把未恢复的告警**假恢复掉**。
> 单个数据源失败**只降级该部分**并记 warn，不抛错 —— 告警引擎是后台任务，
> 宁可少报一轮，也不能因为一个数据源抖动就整轮失败。

> **装配缺口（必须接）**：`AlertEngineDeps.snapshot` 不接的话，引擎每轮拿到的是
> **空快照**（"正确地什么都不做"，`evaluated = 0`，无异常也无日志），
> 四条内置规则会**永远静默失效**。`app.ts` 因此显式接
> `snapshot: createAlertSnapshotSource(...)`，并由 `schedulerIntegration.test.ts`
> 的 `evaluated > 0` 断言守着这条因果链。
> 未接时只记**一次** warn（这是装配缺口，不是每轮的运行故障，不需要刷屏）。

**`service.ts` —— `AlertsService`（业务出口）**

只做"人能看到什么、人能改什么"，**评估全在 `engine.ts`**。

| 方法 | 签名 | 说明 |
| --- | --- | --- |
| `ensureBuiltinRules` | `(at?) => number` | 幂等补齐四条内置规则，返回**本次插入**条数（第二次必然 0）。装配时调一次。**GET 不播种**：如果 GET 也播种，"迁移后新表为空"与"接口一被调用表就有四条"就会互相打脸，彩排脚本也无法验证迁移本身是干净的 |
| `rules` | `() => AlertRuleView[]` | 全部规则（内置在前，按 kind 顺序）。未调用 `ensureBuiltinRules()` 时可以是空数组 |
| `updateRule` | `(id, patch, actor) => AlertRuleView` | 未知 id → `NOT_FOUND`；校验失败 → `VALIDATION_FAILED`（`fieldErrors.patch`），**什么都不写**。SQL 只拼出被提供字段的赋值 + 恒有的 `updated_at` |
| `events` | `(query) => AlertEventListResponse` | `state` 默认 `all`；`limit` 默认 50（`normalizeLimit` 收敛到 1–200）；`total` 是**过滤后**的总数，而 `counts` 是**全量**计数（徽标要的是"现在有多少未确认"，不是"这一页里有多少未确认"） |
| `acknowledge` | `(id, actor) => AlertEventView` | 不存在 → `NOT_FOUND`；已恢复的也能确认；**幂等**：已确认的直接原样返回，不改时间、不再写审计（否则"谁在什么时候先看到的"这个信息就丢了） |
| `summary` | `() => AlertSummaryView` | `open`/`unacknowledged` 来自全量计数；`bySeverity` 只统计**未恢复**的事件；`top` 取未恢复的前 5 条（critical 优先 → `fired_at` 倒序，精简形状）；`suppressed` 是自进程启动的累计值（只报上一轮的话绝大多数时刻都是 0，等于没有信息） |
| `recordTick` / `recordEvaluatedAt` | `(result) => void` / `(at) => void` | 装配处（`app.ts` 的 `AlertEngineDeps.onTick`）回灌 tick 结果，供 `summary()` 的 `evaluatedAt` / `suppressed` |

写操作（`updateRule` / `acknowledge`）都走审计（`alert.rule_updated` / `alert.acknowledged`），
审计失败只 warn。`AlertsServiceDeps.config` 是**可选且未使用**的字段：
阈值/静默期是每行规则自己的事，没有全局配置项；保留它只是让装配代码与其它模块形状一致。

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
| `services.ts` | `registerServiceRoutes` | `/api/services/*`（写操作 handler 内 `assertAdmin`） |
| `search.ts` | `registerSearchRoutes` `buildSearchHits` `SEARCH_DEFAULT_LIMIT` `SEARCH_MAX_LIMIT` | `GET /api/search` |
| `users.ts` | `registerUserRoutes` `DEFAULT_AUDIT_LIMIT` | `/api/users/*` |
| `metrics.ts` | `registerMetricsRoutes` `MetricsRouteDeps` `toSchedulerView` | `/api/metrics/*`（三个只读 GET，viewer） |
| `alerts.ts` | `registerAlertRoutes` `AlertRouteDeps` `AlertRoutesContext` `composeAlertSummary` | `/api/alerts/*`（读 viewer，写 handler 内 `assertAdmin`） |
| `healthMonitor.ts` | `registerHealthMonitorRoutes` `HealthMonitorLike` `HealthMonitorRouteDeps` | `GET /api/health/monitor`（独立前缀，viewer） |
| `index.ts` | `registerRoutes` `PROTECTED_PREFIXES` `RouteDependencies` `AlertsRouteDeps` | 总装 + 权限模型 |

**权限模型**（"默认安全"）：`/api/health` 与 `/api/auth/*` 匿名可用；
`PROTECTED_PREFIXES` 中的每个路由域统一挂 `requireRole('viewer')` + `csrf`。
新增路由即使忘记加守卫，最坏结果是"需要登录"，不会匿名开放。
Sprint 2 新增三个前缀：`/api/metrics`、`/api/alerts`、`/api/health/monitor`。
`/api/health` 与 `/api/health/monitor` 是**两个前缀**：前者匿名（探活），后者 viewer（逐服务判定），
因此 `healthMonitor.ts` 必须是独立文件、独立前缀条目。

**Sprint 2 新增：`RouteDependencies`（第三个参数）**

`registerRoutes(app, ctx, deps)` 多了一个依赖参数，`PROTECTED_PREFIXES` 的
`register` 签名随之变成 `(app, ctx, deps) => void`。
这些对象**刻意不放进 `RouteContext`**：`RouteContext` 是全站共享依赖，
而采样器/调度器/健康监视器只有这几个新域用；显式传参让依赖方向一眼可见。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `metrics` | `MetricsSampler` | 采样器**始终被构造**，只有后台**定时器**受 `backgroundJobs` 控制 |
| `scheduler` | `BackgroundScheduler` | 只用于透出"后台有没有在跑、上次错在哪" |
| `health` | `HealthMonitor` | `/api/health/monitor` 用，与调度器共用同一个实例 |
| `alerts` | `AlertsRouteDeps`（= `Parameters<typeof registerAlertRoutes>[2]`） | **告警域的路由依赖形状由 alerts 模块自己定义**；并行开发时任何一方都不该把对方的依赖形状锁死在自己的文件里 |

> **重要边界**：`buildApp({ backgroundJobs: false })` 只是**不开定时器**，
> 采样器 / 健康监视器 / 告警引擎**仍然被构造**（`app.ts` 无条件 `new`）。
> 于是这些只读接口在测试里照样能读，只是不会被后台 tick 重复采集。
> `backgroundJobs` 的语义是"要不要跑后台循环"，不是"要不要装配这些对象"。

| 端点 | 角色 | 实现要点 |
| --- | --- | --- |
| `GET /api/metrics/catalog` | viewer | `metrics.catalog(toSchedulerView(deps.scheduler))`；未接调度器时 `scheduler: null` |
| `GET /api/metrics/history` | viewer | `metric`/`target`/`range` 三个查询参数**必填**；未知 metric → 400 且 `details.allowed` 列出全部键；未知 range → 400 且在 `fieldErrors.range` 里列出允许值；未知 target（形态对但没出现过）→ 400 且 `details.targetPattern` 给出形态提示 |
| `GET /api/metrics/storage` | viewer | 行数 / 文件占用 / 保留配置 / 预算 / `lastTick` |
| `GET /api/alerts/rules` | viewer | **服务层返回裸数组，路由包成 `{ items }`** —— 层次分工，不要把包装混进服务层 |
| `PATCH /api/alerts/rules/:id` | **admin** | `ctx.users.assertAdmin()`；请求体 zod `.strict()` + `refine(至少一个字段)`；取值域交给 `validateRulePatch`（那里知道 kind） |
| `GET /api/alerts/events` | viewer | 查询 schema `.strict()`（拼错参数直接 400，不静默忽略）；`state` 默认 `all`、`limit` 默认 50 |
| `POST /api/alerts/events/:id/ack` | **admin** | 幂等；已恢复的也能确认 |
| `GET /api/alerts/summary` | viewer | `composeAlertSummary(service.summary(), deps.engine)`：`suppressed` / `evaluatedAt` **优先取引擎的真实值**，不做 `Math.max` 之类的折中（一个数只能有一个来源） |
| `GET /api/health/monitor` | viewer | 监视器未装配时返回 **503 `UPSTREAM_UNAVAILABLE`**，而不是空列表（空列表会被误读成"全部健康"） |

**兜底守卫**：`alerts.ts` 与 `healthMonitor.ts` **各自再挂一份** viewer + CSRF 钩子。
接线是别人的工作，万一 `PROTECTED_PREFIXES` 漏了某条前缀，最坏结果也必须是
"需要登录 + 缺 CSRF 被拒"，而不是把只读的规则与事件匿名开放出去。
重复挂同一钩子是幂等的（只是多校验一次），这个代价远小于"漏一个前缀就对外裸奔"。
三个新路由文件还各自 `requireAuth(request)` 一次作为纵深防御。
校验 schema 写在各路由文件内而不是 `http/schemas.ts`（后者是既有共享文件）。

---

## 4. 应用装配

### `src/app.ts`

| 导出 | 签名 | 说明 |
| --- | --- | --- |
| `BuildAppOptions` | interface | `{ config?, logger?, dbPath?, serveStatic?, sessionCleanupIntervalMs?, backgroundJobs? }` |
| `AppHandle` | interface | `{ app, ctx, db, config, logger, metrics, health, alerts, scheduler, close }` |
| `DEFAULT_CLEANUP_INTERVAL_MS` | `3600000` | 会话/审计清理周期 |
| `buildApp` | `(options?) => Promise<AppHandle>` | 装配全部依赖，**不监听端口**（便于 `inject` 测试） |
| `registerStatic` | `(app, config, logger) => string \| null` | 注册静态资源，返回 `index.html` 路径（无产物时返回 null） |
| `escapeHtml` | `(input) => string` | 错误页转义 |

装配顺序即依赖方向：`config → logger → db → repositories → providers → services → api → static`。

**`backgroundJobs?: boolean`（默认 `false`，Sprint 2）**：是否启动后台任务
（采样 / 健康监测 / 告警评估）。默认关闭的理由必须写在代码注释与文档里：
`buildApp` 被大量测试 `inject` 复用，默认开定时器会让测试变慢、相互干扰
（同一个库被多路 tick 写），而且进程会被定时器吊住。生产入口只有一个
（`server/src/index.ts`：`buildApp({ backgroundJobs: true })`），由它显式开启。

**Sprint 2 装配（`app.ts`）** —— 顺序即依赖方向，health → metrics → alerts：

```ts
const health = new HealthMonitor({
  config, logger, registry: serviceRegistry, containers,
  probe: (target, options) => runHealthProbe({ target, /* timeoutMs */ }),
  intervalSec: () => config.health.probeIntervalSec,      // 闭包：设置页改完立刻生效
  concurrency: () => config.health.probeConcurrency,
});
const metrics = new MetricsSampler({ db, config, logger, system, containers, registry: serviceRegistry, health });
const alerts = new AlertsService({ db, config, logger, audit: auditRepo });
const alertEngine = new AlertEngine({
  db, config, logger, audit: auditRepo,
  snapshot: createAlertSnapshotSource({ config, system, containers, registry: serviceRegistry, health, logger }),
  onTick: (result) => alerts.recordTick(result),          // summary 的 suppressed/evaluatedAt 才是真值
});
await Promise.resolve(alerts.ensureBuiltinRules()).catch((error) => logger.warn('补齐内置告警规则失败', { error }));
const scheduler = new BackgroundScheduler({
  health, metrics, alerts: alertEngine, logger,
  intervalMs: () => config.metrics.sampleIntervalSec * 1000,   // 每次排期重新求值（live）
});
if (options.backgroundJobs === true) scheduler.start();
registerRoutes(app, ctx, { metrics, scheduler, health, alerts: { alerts, engine: alertEngine, scheduler } });
```

| 装配要点 | 为什么 |
| --- | --- |
| `probe` 适配 `runHealthProbe` | 复用 Sprint 1 的 SSRF 防护 / 3s 超时 / 16KB 上限，**只把"对象参数"适配成 `(target, options)`**，不复制探测逻辑 |
| `intervalSec` / `concurrency` 传**闭包** | 不接闭包的话 `PORTAL_HEALTH_PROBE_INTERVAL_SEC` / `…_CONCURRENCY` 在界面上"能改、能保存、看起来生效了"，但监视器仍按 300s/4 跑 —— **静默失效** |
| `AlertEngine` **必须接 `snapshot`** | 不接则每轮拿到空快照，四条规则永远 `evaluated = 0`。所有单测照样全绿，生产上任何告警都不触发 —— 这是"装配缺口"而非"逻辑错误"的典型（模块自己完全正确，缺的是把它接到真实世界）。判别力已由 `schedulerIntegration.test.ts` 的 `evaluated > 0` 断言验证 |
| `onTick` 回灌 `alerts.recordTick` | 否则 `GET /api/alerts/summary` 的 `suppressed` / `evaluatedAt` 恒为 0/null |
| `audit` 直接传 `auditRepo` | `AlertEngineDeps.audit` 接受两种形态（函数或带 `append` 的 `AuditRepository`），接线只有一行，不需要再写适配闭包 |
| `ensureBuiltinRules()` 放在装配期 | "迁移只建结构，业务数据由业务层负责"。失败**只告警不阻断启动**（规则表为空时告警页显示空列表，比整个门户起不来好） |
| `health` 传同一个实例给路由 | 判定只算一次，不出现第二条探测循环 |
| `close()` 里 `scheduler.stop()` **必须在 `db.close()` 之前** | 否则关闭库之后还可能有一轮 tick 在写库 |

> **`AppHandle` 新增 `metrics` / `health` / `alerts` / `scheduler`** 的直接原因是测试：
> 测试要调 `scheduler.tickOnce(now)` 做确定性推进（不 sleep、不依赖真实时钟），
> 或直接调 `metrics.tick(now)`，而不是等定时器。

**notFoundHandler 只注册一次**（`buildApp` 内）：`/api/*` 一律 JSON 404；
其它 GET 在前端已构建时回退 `index.html`。
> 踩过的坑：`registerStatic` 里也调用 `setNotFoundHandler` 会导致
> `Not found handler already set for Fastify instance with prefix: '/'` 启动失败。
> 另外若完全不注册，`/api/nope` 会返回 HTML，前端 `JSON.parse` 报出难以定位的错误。

### `src/index.ts`

进程入口：`buildApp({ backgroundJobs: true })` → 注册 `SIGTERM`/`SIGINT` 优雅退出 → `listen` →
若 `auth.isSetupRequired()` 则打印首启令牌到控制台。
**后台任务只在生产入口显式开启**（全进程只有一个入口，后台单例也只有一个）。

---

## 5. 测试

| 文件 | 覆盖 |
| --- | --- |
| `tests/util.test.ts` | 可达性判定、URL 组装、脱敏、`/proc` 解析、Docker 日志解复用、TtlCache |
| `tests/modules.test.ts` | 配置解析、endpoint 解析、stats 归一化、容器映射、主机上下文、tailnet 映射、nvidia-smi 解析、SSE 帧、工具目录 |
| `tests/auth.test.ts` | 认证流程、会话与 CSRF、角色与账号管理、接口契约（`app.inject` + 内存库） |

**Sprint 2 新增**（全量时间相关用例都用**注入时钟**，禁止 `await sleep` 等真实时间）：

| 文件 | 覆盖 |
| --- | --- |
| `tests/metricsBuckets.test.ts` | 桶纯函数（对齐 / `expected = max(1, round(60/intervalSec))`）；幂等重写同一桶；**多副本合并**（三个副本两个 target、标签只由 target 决定、`expected = 基准 × 副本数`、掉一个副本判 partial）；**整分钟无样本不写行**；小时滚动从 minute 行聚合；保留清理按两个分辨率分别生效 |
| `tests/metricsSampler.test.ts` | **一昼夜确定性仿真**（注入时钟，30s 一 tick 跑 30h）：24h 窗口每条序列恰好 1440 条 minute 桶且缺口 0；**721 tick 的 30 天整点仿真**真跑出 720 条 hour 桶（缺分钟的整点标 partial，不靠外推）；**写事务数与 tick 密度无关**（30s 与 5s 两种间隔写事务数完全相同 = **1861**，且整点那一 tick 恰好 2 次批量写 + 1 次清理）；采集中断 → 该段**无行**（gap）而不是 0；单飞 `skipped`；单 tick 耗时上界；重启（新建 sampler 复用同一 db）后历史仍在、小时桶能补 |
| `tests/metricsHistory.test.ts` | range→resolution 映射（1h/24h 用 minute，7d/30d 用 hour）；percent 与 bytes **不混**；`count: 0` 时 summary 字段是 `null` 而非 0；`missingBuckets` / `partialBuckets` 计算 |
| `tests/healthState.test.ts` | 26 条：连续 2 次失败仍 `degraded`、第 3 次才 `down`；中间夹一次成功则计数归零（抖动不告警）；恢复需连续 2 次全好；三维独立计数；全 `unknown` → `unknown` 且服务级计数不变；无 `healthTarget` 时 http 维固定 `unknown`；`reasons` 文案含维度与次数；首轮不做恢复去抖；秒制时间戳可识别 |
| `tests/healthMonitor.test.ts` | 探测节流（间隔内不重复探）；**全局并发上限**（可控 pending Promise 断言在飞数 ≤ concurrency，超出的计入 `skippedForConcurrency` 并留到下一 tick）；`intervalSec = 0` 完全不探测但仍评估容器维；探测失败不清空既有状态；容器列表取不到 → 容器维 `unknown`（不拿过期快照冒充）；视图 notes 不静默为空 |
| `tests/alertEngine.test.ts` | 36 条：四条规则各自的触发/不触发边界（**等于阈值不触发**；`exited` + 退出码 `0`/`null` 不触发、`dead` 触发）；服务连续失败 3 次只产生 1 条 firing、恢复产生 1 条 resolved；抖动在静默期内重开同一行（`reopen_count = 1`，不插新行）；**预置未恢复行时 tick 绝不插新行**；部分唯一索引真的生效；`enabled = 0` 不评估；duration 窗口未满不触发、途中恢复则计时清零；`suppressed` 计数；审计动作名齐全；`createAlertSnapshotSource` 单源失败只降级该部分 |
| `tests/metricsApi.test.ts` | viewer 可读三个 GET；匿名 401；非法 `range` / 未知 `metric` / 未知 `target` → 400 且 `code = VALIDATION_FAILED`；`storage` 返回大小与保留配置 |
| `tests/alertsApi.test.ts` | viewer 读规则/事件 200、**PATCH 与 ack 被 403 拒绝**；admin PATCH 成功并写审计；阈值越界 400；未知 rule/event id → 404；**缺 CSRF → 403**；`GET /api/health/monitor` 的鉴权与形状 |
| `tests/schedulerIntegration.test.ts` | 装配级（`buildApp` 真实装配，**全程不建立任何 SSE/HTTP 客户端**）：`backgroundJobs` 决定定时器是否启动、`close()` 之后一定停掉；tick 照样把样本写进库且"报告的行数 = 实际行数"；**缺测的分钟没有行**（写 0 会被这条抓住）；重启后历史还在（同一库文件）；`tickOnce` 单飞；**告警端到端**（读数 → 判定 → 落库 → 恢复 → 静默期内重开不新增 → 审计留痕，`evaluated > 0` 是"装配漏接 snapshot"的照妖镜） |
| `tests/backgroundBoundary.test.ts` | 以**源码能力边界**钉住"默认不外发、不自动重启容器"：三个后台模块目录存在且非空（否则守卫退化成空断言）；无 `fetch(` / `node:http(s).request` / `net.connect` / 子进程 / 通知客户端；不得**值导入** `docker/service.js` / `docker/provider.js` / `dockerode`（`import type` 允许）；`healthProbe.ts` 只声明 `GET` 且不带请求体 |
| `tests/dockerMapper.test.ts`（新增小节） | 「容器退出码（null ≠ 0）」：`exited` + `137` → `137`；`ExitCode = 0` 保留 `0`；`State` 缺失 → `null` 且 `state = 'unknown'`；`ExitCode` 字段缺失 → `null`；运行中的容器是 `0` |
| `tests/migrationV3.test.ts` / `tests/migrationV4.test.ts`（修改） | 降级夹具补上 v5（`DROP` 三张新表 + 删 `schema_migrations` 的 5）；v4 的"迁移链末端"断言改为与 `Math.max(...MIGRATIONS.map(m => m.version))` 比对，版本号断言改成"1..4 的名字原样保留 + 之后只允许追加更大版本号 + 无重复"；`afterAll` 的临时目录清理容忍失败（Windows 上 WAL 占用会让 `rmSync` 抛 EBUSY 把真正的失败盖住） |

运行：`npm test`（根目录）或 `npx vitest run`（server 目录）。
