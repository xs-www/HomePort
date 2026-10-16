# 02 · 配置参考

> 所有配置都通过**环境变量**注入（`.env` → `docker compose` → 容器）。
> 本文件是唯一权威说明；`.env.example` 是可直接复制的样例。

## 0. 两种配置方式：环境变量 与 界面设置

从 v0.2.0 起，部分配置项可以**直接在管理界面里改**，无需重建容器：

```
数据库覆盖（管理员在界面里改的）  >  环境变量（.env / compose）  >  内置默认值
```

- **首次部署**仍推荐写 `.env`（一次性把端口、挂载、模式定好）。
- **日常调整**（Token、超时、缓存、工具端口）在「账号管理 → 系统设置」里做，保存后立即生效。
- 未在界面改过的项**不受影响**，继续按 `.env` 生效。界面里可随时「恢复默认」。

### 生效级别（容器架构的硬边界）

| 级别 | 含义 | 典型项 |
| --- | --- | --- |
| **立即生效** | 保存后下次读取即生效；必要的数据源会自动重建 | Tailscale Token/模式、Docker 地址、各类缓存 TTL、探测超时、工具端口、指标间隔、磁盘挂载点（显示层面） |
| **需重建容器** | 容器创建参数或引导期配置，**任何界面都改不了** | 端口映射、数据卷、`PORTAL_SECURE_COOKIES`、数据目录、日志级别 |

界面里 `restart` 级的项**不提供编辑控件**，只展示当前值与原因；
服务端也会拒绝这类写入（双重保险）。

**特别说明：磁盘挂载点**属于"半自动" —— 界面能改"显示哪些、怎么标注"，
但**路径本身必须已经挂进容器**。想新增一个盘仍要改 compose 的 `volumes` 并重建容器。

### 界面设置的存储

界面改的值存在 SQLite 的 `settings` 表（`/data/portal.sqlite`），
随数据卷持久化，重建容器不丢失。备份与恢复见 [07-data-model.md](./07-data-model.md) §4。

### 敏感值加密主密钥（AES-256-GCM）

标了 `sensitive` 的设置项（当前是 `PORTAL_TAILSCALE_API_TOKEN`）**在数据库里是密文**
（`enc:v1:<base64(iv|tag|cipher)>`），主密钥按下列优先级取得：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_SECRET_KEY` | 空 | 显式主密钥：64 位十六进制或 base64 的 32 字节（`openssl rand -base64 32`）。空 = 用密钥文件 |
| `PORTAL_SECRET_KEY_FILE` | `<dataDir>/secret.key` | 密钥文件路径。文件不存在时**自动生成**（权限 `0600`）并打印告警 |
| `PORTAL_SECRET_KEY_PREVIOUS` | 空 | 轮换期间保留的旧密钥（逗号分隔），**只用于解密** |

- **作用范围**：`settings` 表里标了 `sensitive` 的设置项 **+ 用户的 TOTP 种子**
  （`users.totp_secret`，见 [07-data-model.md](./07-data-model.md) §2）——
  两处共用同一个 `secretBox`（`server/src/app.ts` 装配时构造一次）。
- **什么都不配也能加密**：默认自动生成密钥文件。但此时主密钥与数据库同卷，
  只防"数据库文件被单独拷走"，**不防主机失陷**；需要更强隔离请显式设 `PORTAL_SECRET_KEY`。
- **主密钥丢失 = 已加密的敏感值永久解不开**：界面会显示为"未设置"（服务不会崩），
  在界面重填一次即可恢复；**备份数据卷时请一并备份密钥文件**。
- **换密钥**：新密钥写 `PORTAL_SECRET_KEY`，旧密钥写 `PORTAL_SECRET_KEY_PREVIOUS`
  （启动时的新旧密文都能读），确认 `reencryptAll()` 已把老密文升级完毕后再移除 previous。
  详见 [06-security.md](./06-security.md) §7。

## 1. 规则与约定

- 所有变量都可省略，**最小可用配置是空 `.env`**。
- 布尔值接受 `1/0`、`true/false`、`yes/no`、`on/off`。
- 非法值会**在启动时抛错并退出**（而不是静默取默认值），避免"配置写错了但看起来在跑"。
- 唯一的 `process.env` 读取点是 `server/src/config.ts`；其余模块只从强类型 `config` 取值。

## 2. 门户自身

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_HOST_PORT` | `8899` | compose 映射到宿主的端口 |
| `PORTAL_BIND_ADDR` | `0.0.0.0` | compose 端口绑定地址。填宿主 tailnet IP 可做到"只经 tailnet 访问" |
| `PORTAL_PORT` | `8899` | 容器内监听端口（一般不改） |
| `PORTAL_HOST` | `0.0.0.0` | 容器内监听地址 |
| `PORTAL_LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `PORTAL_PUBLIC_HOST` | 空 | 门户对外主机名。空 = 按访问者请求头推导。填 MagicDNS 名或 tailnet IP 可让所有入口链接固定 |
| `PORTAL_PUBLIC_PORT` | `0` | 对外端口；`0` = 跟随请求 |
| `PORTAL_PUBLIC_SCHEME` | `http` | `http` / `https` |
| `PORTAL_SECURE_COOKIES` | `0` | 部署在 HTTPS 反代之后时置 `1`，会话 Cookie 带 `Secure` |
| `PORTAL_TRUST_PROXY` | `loopback` | 可信代理范围。默认**只信任本机反代**，见下方说明 |
| `PORTAL_SETUP_TOKEN` | 空 | 首启令牌；空 = 自动生成并写入 `/data/setup-token.txt` + 打印到日志 |
| `PORTAL_DATA_DIR` | `/data`（镜像内） | SQLite 与令牌目录 |
| `PORTAL_DB_PATH` | `<dataDir>/portal.sqlite` | 数据库文件路径 |
| `PORTAL_VERSION` | `0.1.0` | 展示用版本号 |
| `PORTAL_BUILD_REVISION` | `dev` | 展示用构建号/提交号（CI 里可注入） |
| `TZ` | `Asia/Shanghai` | 日志与界面时区 |

> **为什么 `PORTAL_TRUST_PROXY` 默认是 `loopback`**：本项目的标准部署是
> **`tailscale serve` → `127.0.0.1:8899`**，代理连接必然来自回环地址。
> 只信回环时，`X-Forwarded-For` 里的真实客户端 IP 会被采纳（登录限流
> `10 次/分钟/IP` 的计数桶才是对的），而 tailnet 直连客户端**自带**的伪造头会被忽略。
> 若默认 `1`/`true`，任何人都能靠改 `X-Forwarded-For` **换桶绕过登录限流**，
> 还能伪造 `X-Forwarded-Proto: https` 让门户误以为自己在 HTTPS 后面。
>
> `1`/`true`/`on`/`yes` 仍可显式开启（= 无条件相信 `X-Forwarded-*`），但这是**危险**配置，
> **仅在门户前面确有一个不可绕过的反代、且该反代是重写而不是追加这些头时才用**；
> `0`/`false`/`off`/`no` 完全不信任；也可直接写 IP/CIDR 列表（`127.0.0.1/8,::1`）
> 或 proxy-addr 预置名（`loopback`/`linklocal`/`uniquelocal`）。
> 非法值**启动即报错**，不会静默退化成"信任所有人"（`parseTrustProxy()`，`server/src/config.ts`）。
>
> 相邻变量 `PORTAL_FORWARDED_PROTO_TRUSTED`（默认 `1`，本文件此前未收录）只影响
> **入口链接的 scheme 推导**：置 `0` 时忽略 `X-Forwarded-Proto`，一律用 Fastify 判定的协议
> （`buildHostContext()`，`server/src/modules/docker/hostContext.ts`）。

### 会话

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_SESSION_TTL_HOURS` | `12` | 常规会话有效期 |
| `PORTAL_SESSION_REMEMBER_TTL_HOURS` | `720`（30 天） | 勾选"记住我"时的有效期 |
| `PORTAL_SESSION_COOKIE` | `hp_session` | 会话 Cookie 名 |

### 缓存与实时推送

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_METRICS_INTERVAL_MS` | `3000` | SSE 指标推送间隔 |
| `PORTAL_CACHE_CONTAINERS_TTL_MS` | `2000` | 容器列表缓存。容器多（>30）时可调到 5000 降低 inspect 压力 |
| `PORTAL_CACHE_TAILSCALE_TTL_MS` | `5000` | tailnet 状态缓存，避免频繁 fork `tailscale` 进程 |

### 历史采集与健康探测（Sprint 2）

> ⚠️ **`PORTAL_METRICS_INTERVAL_MS` 与 `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` 是两件事**，
> 名字像但作用域完全不同：前者只管"往**浏览器**推多快"（开页面时的实时刷新），
> 后者决定"**落库**的历史曲线密度"。历史采集与浏览器开不开、开几个标签页**无关**
> —— 进程内只有一个采样器。调优时别只调前者（详见 `08-operations.md` §7.2/§8）。

| 变量 | 默认值 | 范围 | 说明 |
| --- | --- | --- | --- |
| `PORTAL_METRICS_SAMPLE_INTERVAL_SEC` | `30` | 5–3600 | 后台采样 tick 间隔（秒）；同时是 minute 桶"应有样本数"的基准（`max(1, round(60/间隔))`）。NAS 弱机建议 `60` |
| `PORTAL_METRICS_RETENTION_MINUTE_HOURS` | `24` | 1–168 | minute 桶保留小时数。**稳态行数由此封顶**（窗口滚动，不随时间累积） |
| `PORTAL_METRICS_RETENTION_HOUR_DAYS` | `30` | 1–3650 | hour 桶保留天数 |
| `PORTAL_METRICS_CONTAINER_LIMIT` | `10` | 0–100 | 采集容器的数量上限（**0 = 完全不采容器指标**，只留宿主与服务健康） |
| `PORTAL_HEALTH_PROBE_INTERVAL_SEC` | `300` | 0–86400 | 自动 HTTP 探测间隔（秒）。**0 = 关闭自动探测**（容器维度判定与手动探测仍可用） |
| `PORTAL_HEALTH_PROBE_CONCURRENCY` | `4` | 1–32 | 全局在飞探测并发上限；超出的服务轮到下一轮，不排队 |

- 非法值**启动即报错**（与 `PORTAL_TRUST_PROXY` 同风格），不静默截断 ——
  否则"我设了保留 3 天"可能实际生效的是别的值。
- 这 6 项都是 `live` 生效级别（改完即生效，不需要重启、不需要重建容器）。
- 取值只影响"采多少、留多久、探多勤"，**都不改变任何出站行为**：Sprint 2 没有任何通知通道。

### 安全响应头（S0-03）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_SECURITY_HEADERS` | `1` | 总开关。关闭后**一个安全头都不发**（仅排障时用，启动会打 warn） |
| `PORTAL_CSP` | 空（= 用内置默认策略） | `Content-Security-Policy` 内容。**留空不是"关掉 CSP"**，而是回落到内置默认策略 |
| `PORTAL_HSTS` | `1` | 是否允许下发 HSTS。**只在请求确为 HTTPS 时才真正下发** |
| `PORTAL_HSTS_MAX_AGE` | `15552000`（180 天） | HSTS `max-age`（秒）；`0` 等于不下发 |

内置默认 CSP（`DEFAULT_CSP`，`server/src/config.ts`）：

```
default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
connect-src 'self'; form-action 'self'; frame-ancestors 'none'
```

- `style-src` 里的 `'unsafe-inline'` 是**必要**的：React 组件会用 `style` **属性**写少量
  内联样式（进度条宽度等），属性级内联无法用 nonce 覆盖。`script-src` 则保持 `'self'`，
  因为前端产物全部是本地静态文件、没有内联脚本（React 19 + Vite 产物满足该约束）。
- `connect-src 'self'` 同时覆盖同源 `fetch` 与 **SSE** 长连接 —— 改 CSP 时若漏掉它，
  概览页的实时指标会直接断掉。
- 想彻底关掉安全头（例如排障时被 CSP 挡住）请用 `PORTAL_SECURITY_HEADERS=0`，
  **不要**靠把 `PORTAL_CSP` 置空 —— 空值会被 `str()` 回落到默认策略
  （`server/src/config.ts` 的 `str()`：空串一律取 fallback）。

**HSTS 只在 HTTPS 时下发**（`securityHeadersFor()`，`server/src/http/securityHeaders.ts`）：
`tailscale serve` 在节点上终止 TLS 后回源到 `http://127.0.0.1:8899`，
只有 `X-Forwarded-Proto: https` 才能说明浏览器那一侧确实是 HTTPS；
**直连 HTTP（含 tailnet 直连 `http://<tailnet IP>:8899`）自动忽略**。
内网 HTTP 下发 HSTS 会把用户浏览器锁死在一个不存在的 HTTPS 站点上，是真实的可用性事故。
下发的头形如 `max-age=15552000`，**刻意不带 `includeSubDomains`，也不带 `preload`**：
生产主机名形如 `family-nas.tail585599.ts.net`，带 `includeSubDomains` 会波及同域下的其它名字，
那不是门户能替用户做的决定。

除 CSP/HSTS 外还会固定下发 `x-content-type-options: nosniff`、`x-frame-options: DENY`、
`referrer-policy: no-referrer`、`cross-origin-opener-policy` / `cross-origin-resource-policy: same-origin`、
`x-permitted-cross-domain-policies: none` 与一份全关的 `permissions-policy`（`STATIC_SECURITY_HEADERS`）；
`/api/*` 额外补 `cache-control: no-store`（响应可能含容器环境变量快照、设备清单等敏感内容）。

### 两步验证（TOTP，S0-03）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_TOTP_ENABLED` | `1` | 是否允许**新绑定**两步验证；已绑定账号不受影响，见下方说明 |
| `PORTAL_TOTP_ISSUER` | `HomePort` | `otpauth://totp/...` URI 里的签发者名，即验证器 App 里显示的分组名 |
| `PORTAL_TOTP_WINDOW` | `1` | 校验允许的时间窗：±N 个 30 秒周期（取值 `0`~`5`） |
| `PORTAL_TOTP_CHALLENGE_TTL_SECONDS` | `300` | 登录第二步挑战令牌的有效期（取值 `60`~`1800`） |

- 算法固定为 **HMAC-SHA1 + 6 位 + 30 秒**（Google Authenticator / 1Password / Aegis 等主流 App
  的默认兼容档），这三项**不提供配置项**。
- **关掉开关只关"新绑定"**：`POST /api/users/me/totp/setup` 与 `/enable` 返回
  `400 TOTP_UNAVAILABLE`（文案「服务端已关闭两步验证功能，暂时无法绑定新设备」），
  由 `assertTotpEnrollmentAllowed()`（`modules/auth/service.ts`）在这两个入口拦截。
- **已绑定的账号无论如何都会继续走第二步**：`login()` 刻意不看 `config.totp.enabled`，
  否则关掉开关就等于把所有账号**静默降级成仅密码**，而用户毫不知情。
  同理 `disable`（关闭两步验证）与 `recovery-codes`（重生成恢复码）**不受该开关影响** ——
  不能因为管理员关了开关，就让已绑定的人连"关掉它"都做不到。
- **各变量的生效时机**：`PORTAL_TOTP_WINDOW` 在 `verifySecondFactor()`（登录第二步、关闭、
  重生成恢复码都走它）与 `enableTotp()` 的绑定校验里读取；`PORTAL_TOTP_CHALLENGE_TTL_SECONDS`
  在 `login()` 里传给 `challenges.create()`；`PORTAL_TOTP_ISSUER` 只在 `beginTotpSetup()`
  拼 `otpauth://` URI 时读取。
- 挑战 TTL 只决定"输码的时间预算"，与登录会话有效期（`PORTAL_SESSION_TTL_HOURS`）无关；
  有效期内同一个挑战只能用一次，且累计 5 次输错即作废（见 [07-data-model.md](./07-data-model.md) §2）。
- 本节（安全响应头 / TOTP）的所有变量都是**引导期读取**（`config.ts` 在启动时构造一次配置），
  改完需重启容器，且**不在**「界面设置」里 —— 与 §0 的 `restart` 级项同类。

### 服务注册表（S1-01…S1-05）

**没有新增任何环境变量**。服务发现的规则、健康探测的超时、发现缓存的 TTL 都是代码里的常量：

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `HEALTH_PROBE_TIMEOUT_MS` | `3000` | 单次探测超时（`healthProbe.ts`） |
| `HEALTH_PROBE_MAX_BODY_BYTES` | `16384`（16KB） | 响应体**读满即 cancel**（不读完整响应体，防对端用无限流撑爆内存） |
| `DISCOVERY_CACHE_TTL_FALLBACK_MS` | `5000` | 发现缓存的**兜底** TTL：正常情况下跟随 `PORTAL_CACHE_CONTAINERS_TTL_MS`（默认 2000，随设置热调，`0` 表示不缓存），只有配置值非法时才用它 |
| `HEALTH_RESULT_LIMIT` | `512` | 内存里保留的最近健康结果条数（结果不落库） |

理由是它们属于"实现细节"，调大调小只会让行为更难预测。

需要按部署调整的是**每服务的数据**（不在这里配）：健康检查目标与首选入口由管理员在
`/admin/services` 里逐个服务保存，存在 `services` 表（见 [07-data-model.md](./07-data-model.md) §2）。

> **唯一与配置有关的坑**：服务墙能不能显示 `tailscale serve` 路由，取决于 §4 的模式选择 ——
> **API 模式读不到 serve 配置**（`tailscale serve status` 是 CLI 的能力）。此时
> `GET /api/services` 会返回 `discovery.serveAvailable: false` 并在 `serveDetail` 里写明原因，
> 前端显示降级提示条，而**不是**假装"这些服务不存在"。要做"家庭日历挂 `/calendar`"这类
> 路径暴露，必须用 `PORTAL_TAILSCALE_MODE=cli`。

## 3. Docker 数据源（F1）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DOCKER_ENDPOINT` | `unix:///var/run/docker.sock` | 引擎地址。**Windows 必须**用 `npipe:////./pipe/dockerDesktopLinuxEngine` |
| `DOCKER_SOCKET` | `/var/run/docker.sock` | compose 的宿主侧 socket 路径。Windows 用 `//var/run/docker.sock` |
| `DOCKER_GID` | `0` | `group_add` 的组 ID。NAS 上出现 `EACCES` 时设为其 docker 组 ID（群晖常见 `998`） |
| `PORTAL_DOCKER_INCLUDE_STOPPED` | `1` | 是否默认包含已停止容器 |
| `PORTAL_DOCKER_STATS_TIMEOUT_MS` | `4000` | `docker stats` 超时 |

支持的 endpoint 写法（`resolveDockerEndpoint`）：

| 写法 | 结果 |
| --- | --- |
| `npipe:////./pipe/dockerDesktopLinuxEngine` | `{ socketPath: '//./pipe/dockerDesktopLinuxEngine' }` |
| `unix:///var/run/docker.sock` | `{ socketPath: '/var/run/docker.sock' }` |
| `/var/run/docker.sock` | 同上 |
| `tcp://host:2375` / `http://host:2375` | `{ host, port, protocol: 'http' }` |
| `https://host:2376` | `{ host, port, protocol: 'https' }` |

> named pipe 的斜杠数量不规范（2~4 个都合法），代码统一归一化为 `//./pipe/...`。
> 传给 dockerode 的路径若不以 `//` 开头会被当成相对文件路径，报 `ENOENT`。

## 4. tailnet 数据源（F2）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_TAILSCALE_MODE` | `auto` | `auto` / `cli` / `api` / `off`。`auto` = 有 API Token 走 API，否则走 CLI |
| `PORTAL_TAILSCALE_BIN` | `tailscale`（镜像内为 `/usr/local/bin/tailscale`） | CLI 可执行文件路径 |
| `PORTAL_TAILSCALE_SOCKET` | `/var/run/tailscale/tailscaled.sock` | 非默认值时会追加 `--socket` 参数 |
| `PORTAL_TAILSCALE_API_TOKEN` | 空 | Tailscale API Token（只读 scope 即可） |
| `PORTAL_TAILSCALE_TAILNET` | `-` | API 模式的 tailnet 标识；`-` 表示当前 Token 所属 tailnet |
| `PORTAL_TAILSCALE_TIMEOUT_MS` | `5000` | CLI/API 超时 |

**两种模式的取舍**

| | CLI 模式 | API 模式 |
| --- | --- | --- |
| 需要 | 宿主 `tailscale` 可执行文件挂载进容器 | `PORTAL_TAILSCALE_API_TOKEN` |
| 网络 | 不需要外网 | 需要访问 `api.tailscale.com` |
| 数据新鲜度 | 与宿主一致，延迟低 | 有云端延迟（数十秒） |
| 中转信息 | 有 `Relay` / `CurAddr`（可判直连/中继） | 无 |
| **`tailscale serve` 路由** | ✅ 可读 | ❌ **读不到**（serve 是节点本地状态，REST API 不提供） |
| 适用 | NAS 上已装 Tailscale | 无法挂载宿主二进制、或想统一走云端 |

> **选模式的关键区别**：如果你用 `tailscale serve` 把服务以路径形式暴露到 tailnet
> （例如把只绑 `127.0.0.1` 的服务挂到 `/calendar`），**必须用 CLI 模式**才能在门户里
> 看到这些路由。API 模式只能查设备状态，看不到 serve 配置。
> 见 `01-architecture.md` §5.1。

> **`--socket` 参数位置**：`PORTAL_TAILSCALE_SOCKET` 非默认值时，门户会把
> `--socket <path>` 插在**子命令之前**（`tailscale --socket X status --json`）。
> 这是 tailscale 的全局 flag，放在子命令之后会报
> `flag provided but not defined: -socket`。

## 5. 系统指标（F3）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_HOST_PROC` | `/host/proc` | 宿主 `/proc` 的容器内挂载点。**Linux/NAS 必挂**才能拿到宿主真实 CPU/内存 |
| `PORTAL_DISK_MOUNTS` | 空 | 磁盘挂载点列表，见下方语法 |
| `PORTAL_NVIDIA_SMI` | `/usr/local/bin/nvidia-smi` | `nvidia-smi` 路径 |
| `PORTAL_NVIDIA_LD_LIBRARY_PATH` | 空 | 追加到 `LD_LIBRARY_PATH`（WSL 下通常为 `/usr/lib/wsl/lib`） |
| `PORTAL_COMMAND_TIMEOUT_MS` | `5000` | 外部命令（`nvidia-smi` 等）超时 |

### `PORTAL_DISK_MOUNTS` 语法

```
展示路径=容器内路径[|展示标签[|statfs 路径]]，多个用英文逗号分隔
```

- `展示路径`：UI 上显示给用户看的宿主路径（如 `C:` 或 `/volume1`）。
- `容器内路径`：**必须是**宿主目录在容器里的挂载点。
- `展示标签`：可选，省略时取展示路径最后一段（Windows 盘符会自动去掉冒号）。
- `statfs 路径`：可选，省略时等于 `容器内路径`。

**必须显式写 `=`**：只写一个路径时无法判断它是宿主路径还是容器路径，
静默猜测会得到错误的 `statfs` 目标，因此直接报错。

| 平台 | 示例 |
| --- | --- |
| Windows | `C:=/host/disk/C` |
| NAS | `/volume1=/host/volume1,/volume2=/host/volume2` |
| 带标签 | `/volume1=/host/volume1\|存储池1` |

## 6. 工具目录（F4）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORTAL_TOOLS_FILE` | 空 | 自定义目录 JSON 的路径（需挂载进容器） |
| `PORTAL_TOOLS_EXTRA` | 空 | 快速追加：`id:名称:端口`，逗号分隔 |
| `PORTAL_TOOLS_PROBE_TTL_MS` | `10000` | 探测结果缓存时长 |
| `PORTAL_TOOLS_PROBE_TIMEOUT_MS` | `1500` | 单次 TCP/HTTP 探测超时 |
| `PORTAL_TOOLS_PROBE_HOST` | 空 | 强制指定探测目标主机。**一般不需要**，见下方探测目标链 |

### 探测目标链（重要）

门户跑在容器里，而"宿主上的服务"在容器内**不能**用 `localhost` 访问
（那指向容器自己）。因此探测按以下顺序尝试，任一成功即判定为 `up`：

```
1. 门户的对外主机名（访问者用的那个：tailnet IP / MagicDNS / localhost）
2. host.docker.internal      ← 容器化部署下宿主服务的可靠目标
3. 127.0.0.1                 ← 门户原生运行时的宿主
```

命中兜底主机时，`status.detail` 会明确写出"经 xxx 探测"，`status.target`
返回实际探测成功的主机和端口，前端工具卡片上显示为「探测目标 xxx」徽标 ——
这样"端口通但入口链接打不开"这类问题可以被直接看到，而不是变成一个说不清的红点。

实测案例：本机 DSH 监听 `3080`，容器内 `127.0.0.1:3080` 与 tailnet IP 都连不上，
只有 `host.docker.internal:3080` 可达（4ms）。兜底链覆盖后正确判为"可用"。

`extra_hosts: host.docker.internal:host-gateway` 已写入 `docker-compose.yml`，
Linux/NAS 上该域名才会解析（Docker Desktop 自带）。

### 目录 JSON 结构

```json
{
  "replace": false,
  "tools": [
    {
      "id": "jellyfin",
      "name": "Jellyfin",
      "port": 8096,
      "category": "media",
      "probePath": "/health",
      "deepLinkPath": "/web/",
      "icon": "media",
      "description": "开源媒体服务器",
      "scheme": "http",
      "expectedStatus": 200,
      "featured": true,
      "order": 60,
      "visibleTo": ["admin", "viewer"],
      "hint": null
    },
    { "id": "ollama", "port": 11435 }
  ]
}
```

- `replace: false`（默认）：按 `id` **合并**内置目录 —— 只写要覆盖的字段即可，未写的沿用内置值。
- `replace: true`：完全以内置目录被文件内容替代。
- `id` 只允许字母数字与短横线（最长 32 位）；`port` 必须为 1-65535 或 `null`。
- `visibleTo` 为 `[]` 时自动视为对所有角色可见。

字段含义：

| 字段 | 说明 |
| --- | --- |
| `probePath` | 健康检查路径；`/` 表示只校验根路径返回码 |
| `expectedStatus` | 期望状态码；`null` = 只要不是 5xx 就算可用 |
| `deepLinkPath` | 深度链接路径（如 Jellyfin 的 `/web/`） |
| `scheme` | `http` / `https`（自签证书不会阻断探测） |
| `featured` | 是否在概览页突出显示 |
| `order` | 排序权重，越小越靠前 |
| `hint` | 展示在卡片上的附加提示 |

### 内置工具（`BUILTIN_TOOLS`）

| id | 名称 | 端口 | 探测路径 |
| --- | --- | --- | --- |
| `ollama` | Ollama | 11434 | `/api/version` |
| `dsh` | DSH | 3080 | `/` |
| `comfyui` | ComfyUI | 8188 | `/` |
| `open-webui` | Open WebUI | 3001 | `/health` |
| `portainer` | Portainer | 9000 | `/api/status` |
| `jellyfin` | Jellyfin | 8096 | `/health` |
| `qbit` | qBittorrent | 8081 | `/api/v2/app/version` |
| `code-server` | code-server | 8443 | `/healthz` |

## 7. 部署矩阵速查

| | Windows 11 + Docker Desktop（容器化） | NAS（Synology / QNAP / TrueNAS） |
| --- | --- | --- |
| `DOCKER_ENDPOINT` | **`unix:///var/run/docker.sock`**（见下方警告） | `unix:///var/run/docker.sock` |
| `DOCKER_SOCKET` | `//var/run/docker.sock` | `/var/run/docker.sock` |
| `DOCKER_GID` | `0` | 常为 `998`（群晖），遇 `EACCES` 时设置 |
| CPU / 内存 | ⚠ **只有 WSL2 虚拟机的资源**（实测 4 线程 / 3.9 GB，宿主是 20 线程 / 31.6 GB）。挂 `/proc` 也无法改善 | `host-proc`：读宿主 `/proc`，**真实值** |
| 磁盘 | 挂 `"C:/:/host/disk/C:ro"`，`statfs` → **Windows 真实值**（实测 952 GB） | 挂 `/volume1` 等 |
| GPU | ❌ 容器内不可用（看不到 `/usr/lib/wsl/lib`，也无法执行 `nvidia-smi.exe`） | 多数 NAS 无独显；有则可挂 `nvidia-smi` |
| tailnet | 必须 API 模式（容器内执行不了 `tailscale.exe`） | CLI（挂 `tailscale` + `tailscaled.sock`）或 API |
| 门户访问 | `http://<宿主tailnet IP>:8899` | 同左 |

> **Windows 上容器化部署的 `DOCKER_ENDPOINT` 不能用 `npipe://`**。
> Docker Desktop 会把 Windows named pipe **转发**成容器内的 `/var/run/docker.sock`，
> 在容器里写 `npipe://` 会报 `ENOENT`。
> `npipe:////./pipe/dockerDesktopLinuxEngine` 只适用于**在 Windows 上原生运行 Node** 的开发场景。
>
> **需要 Windows 宿主真实 CPU/内存/GPU 指标时，请原生运行门户**（`node server/dist/index.js`），
> 实测可拿到 20 线程 / 31.63 GB 与 `nvidia-smi`。原因详见 `08-operations.md` §2。

## 8. 相关文档

- 逐函数说明 → [03-server-modules.md](./03-server-modules.md)
- 指标为什么可能不准 → [08-operations.md](./08-operations.md) 的「指标取数边界」
- 部署步骤 → [README.md](../../README.md)
