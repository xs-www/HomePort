# 06 · 安全模型

> 门户能看到宿主的容器、硬件与 tailnet 拓扑，属于**高价值目标**。
> 本文件说明已实现的控制措施与**已知残余风险**，改动安全相关逻辑前必读。

## 1. 威胁模型

| 威胁 | 场景 | 应对 |
| --- | --- | --- |
| 未授权访问 | tailnet 内其它设备或同网段设备直接访问门户 | 全站登录；除 `/api/health` 与 `/api/auth/*` 外全部要求会话 |
| 凭据窃取（XSS） | 前端被注入脚本读取会话令牌 | 会话 Cookie `HttpOnly`，JS 不可读 |
| 跨站请求伪造（CSRF） | 用户已登录时被诱导访问恶意页面发起变更请求 | 独立 CSRF 令牌 + 请求头校验 + `SameSite=Lax` |
| 会话固定 | 攻击者预先设定会话 ID | 登录成功时**新签发**随机令牌，不接受客户端提供的会话标识 |
| 用户枚举 | 通过登录报错区分"用户不存在"与"密码错误" | 统一错误码与文案 + `dummyVerify()` 抹平耗时差异 |
| 暴力破解 | 大量登录尝试 | 登录接口限流 10 次/分钟/IP + bcrypt cost 12 |
| 敏感信息泄漏到前端 | 容器环境变量/日志里含密钥 | 服务端脱敏（`util/redact.ts`），前端拿到的已是 `***` |
| 越权（水平/垂直） | viewer 尝试管理账号 | 后端逐路由角色守卫（前端隐藏只是体验） |
| 凭证泄漏到日志 | 请求日志/审计记录写入密码 | 不记录请求体；审计只记动作与目标 |

## 2. 认证

### 密码

- 哈希：**bcrypt，cost 12**（约 250ms/次）。
  选 bcryptjs（纯 JS）而非 argon2/native bcrypt 的原因：多架构（amd64/arm64 NAS）镜像构建时
  不需要编译原生模块，避免构建失败。代价是抗 GPU 破解略弱，因此配合强口令策略与限流。
- 策略（`checkPasswordStrength`）：至少 10 位、至少两类字符（小写/大写/数字/符号）、
  拒绝常见弱口令片段、上限 128 字节。
  上限的存在是因为 bcrypt 只取前 72 字节，过长会**静默截断**，
  与其让用户以为长密码更安全，不如直接拒绝。

### 会话

| 项 | 实现 |
| --- | --- |
| 令牌 | `crypto.randomBytes(32)` → base64url（256 bit 熵） |
| 存储 | DB **只存** SHA-256 摘要（`token_hash`），泄库也无法直接冒用 |
| 传递 | Cookie `hp_session`，`HttpOnly; SameSite=Lax; Path=/`，HTTPS 下自动加 `Secure` |
| 有效期 | 常规 12h；"记住我" 30 天（可配） |
| 滑动续期 | `touch()` 更新最后活跃时间；改密时保留当前会话 |
| 吊销 | 单条 `revoke`、按用户 `revokeAllForUser`；改密/重置密码/禁用/删除用户都会触发 |
| 清理 | 每小时清理过期与已撤销超过 24h 的会话 |

### 首启初始化（bootstrap）

- 仅当用户表为空时可用；否则返回 `ALREADY_INITIALIZED`。
- 需要**首启令牌**：
  - `PORTAL_SETUP_TOKEN` 环境变量，或
  - 自动生成并写入 `<dataDir>/setup-token.txt`（权限 `0600`）+ 打印到容器日志。
    日志通道是刻意保留的：NAS 上读容器内的文件不如 `docker logs` 方便。
- 令牌比较用 `timingSafeEqual`。
- 首个账号**强制**为 `admin` 角色（前端不可选，后端硬编码）。

### 两步验证（TOTP，S0-03）

可选的第二因子，服务端实现见 `03-server-modules.md`；**前端**这侧的约定如下
（每一条都有对应单测 `web/tests/totp.test.tsx`）：

| 项 | 实现 |
| --- | --- |
| 登录第一步 | 已启用 TOTP 的账号只返回 `{ totpRequired, challengeToken, expiresAt }`，**不下发会话 Cookie** —— 拿到密码但拿不到第二个因子时不会产生任何会话 |
| 挑战凭据 | `challengeToken` 只存在登录页的**组件状态**里：不写 `localStorage`/`sessionStorage`，刷新即失效（后端 TTL 默认 300s） |
| 错误码语义 | `TOTP_INVALID`（验证码错）→ 就地重试、保留输入；`TOTP_CHALLENGE_EXPIRED`（过期/已消费/尝试超限）→ 退回第一步并提示重新登录 |
| 会话失效判定 | 客户端把 `TOTP_INVALID` / `TOTP_CHALLENGE_EXPIRED` / `INVALID_CREDENTIALS` 从"401 = 会话失效"里排除，**不触发全局登出**；否则输错一次验证码就等于被踢下线 |
| 恢复码 | 只在 `enable` / `recovery-codes` 的响应里出现一次（库里只存摘要）；界面弹窗逐条展示、提示"只显示这一次"、必须勾选"我已保存恢复码"才能关闭 |
| 绑定种子 | `setup` 重复调用会重新生成**未确认**的种子，界面明确提示"上一次未确认的种子会失效"并二次确认 |
| 关闭门槛 | 需要密码 **+ 当前动态码或恢复码**（不低于开启门槛），防止"会话被短暂劫持即可拆掉第二因子" |
| 管理员强制重置 | 语义是"清绑定 + 吊销该用户全部会话"，界面二次确认并写明"用户会掉线、需重新登录并重新绑定" |
| 依赖 | **不引入二维码库**：只展示密钥文本与 `otpauth://` 链接，由验证器 App 手动输入/粘贴 |

> 前端**不做**验证码格式的最终判定：`code` 同时接受 6 位动态码与
> `XXXX-XXXX` 恢复码，统一交给后端返回 `TOTP_INVALID` 或成功。

#### 服务端约定（挑战 / 防重放 / 恢复码）

实现见 `server/src/modules/auth/totp.ts`（纯函数核心）、
`server/src/modules/auth/service.ts`（流程）与 `server/src/db/totp.ts`（仓储）。

| 项 | 实现 | 为什么 |
| --- | --- | --- |
| 第一步 | 密码通过后**不签发会话**，只返回 5 分钟有效的挑战令牌（`PORTAL_TOTP_CHALLENGE_TTL_SECONDS`，默认 300s）；库里只存令牌的 sha256 摘要 | "知道密码"不等于"通过了第二因子"，中途不产生任何可用会话；摘要存储让泄库不足以重放挑战 |
| 挑战尝试次数 | 每个挑战最多 5 次尝试（`TOTP_CHALLENGE_MAX_ATTEMPTS`），超限即作废并消费 | 6 位码只有 100 万种组合，不给无限试错的机会 |
| 限流 | `/api/auth/login` 与 `/api/auth/login/totp` **共用** 10 次/分钟/IP | 挑战内 5 次上限挡不住"重新登录拿新挑战"的暴力尝试，真正的闸门在 IP 限流上 |
| 防重放 | `users.totp_last_counter` 记录最后成功使用的时间步，同一个（或更早的）30 秒时间步再次出现判 `replayed` | 码在有效期内被偷看后重放是 TOTP 的固有弱点 |
| 防重放范围 | **只作用于登录路径**；会话内的再次确认（关闭两步验证、重新生成恢复码）**不消费**计数器 | 否则"绑定完立刻退出再登录"会在同一个 30 秒窗口里被自己的防重放挡住。这是**有意**的取舍：会话内确认的真实风险面是"会话已被劫持"，而这种场景下防重放也救不了 |
| 恢复码 | 10 个、形如 `XXXX-XXXX`；字符集剔除易混的 `0 O 1 I L`；入库只存 sha256 摘要、一次性核销；重新生成时旧码整体作废 | 恢复码是人工抄写/手打的，混字符 = 抄错一次就用不了；摘要存储让"拷走数据库文件"不足以伪造恢复码 |
| 验证码校验 | `timingSafeEqual` 比较；时间窗默认 ±1 个周期（`PORTAL_TOTP_WINDOW`）；算法 HMAC-SHA1 / 6 位 / 30 秒 | 手机时钟漂移是常态，窗口为 0 会让真实用户频繁被拒；SHA1 是各家验证器 App 的"兼容档" |
| 种子 | 与其他敏感设置**同一个** `secretBox`（AES-256-GCM）加密后落库；`totp_enabled` 与种子分离（setup 先写未确认种子，回填一次码才置 1） | 种子等价于"第二把钥匙"，明文落库等于把两步验证降级成一步；"扫了码但没输码"不能算启用，否则一次失败的绑定就能把人锁在门外 |
| 接口归属 | 绑定/关闭/恢复码挂在 `/api/users/me/totp/*`（不是 `/api/auth/*`） | `/api/auth/*` 是**匿名**作用域、没有角色守卫也没有 CSRF 钩子；变更类操作必须同时满足「已登录 + CSRF」两层。会话 Cookie 与 CSRF 令牌仍照旧 |
| 关闭门槛 | 需要当前密码；**已启用时还需一次当前验证码或恢复码** | "关掉它的门槛不低于打开它"，避免会话被短暂劫持即可拆掉第二因子 |
| 管理员强制重置 | 清绑定 + 删除全部恢复码 + **吊销该用户全部会话**，并记 `auth.totp_reset` 审计（含吊销会话数） | 丢失设备流程；语义上等同于"临时降低该账号的安全等级"，必须记到管理员头上 |
| 离线兜底 | 唯一管理员自己丢了设备时，用容器内脚本或直接改库重置（见 `08-operations.md` §5） | 不能设计成"丢了设备就永久锁死"，但这条路径**绕过审计**，是最后手段 |
| 审计动作 | `auth.totp_setup_started` / `auth.totp_enabled` / `auth.totp_failed` / `auth.totp_recovery_used` / `auth.totp_recovery_regenerated` / `auth.totp_disabled` / `auth.totp_reset` | 启用、失败、恢复码使用与重置都要留痕 |

> `PORTAL_TOTP_ENABLED=0` 只表示"**不允许新绑定**"：已经绑定的账号仍会继续要求第二步。
> 否则管理员关掉开关就等于把所有已绑定账号静默降级成"仅密码"，而用户毫不知情。

## 3. 授权

### 角色

| 角色 | 权限 |
| --- | --- |
| `admin` | 全部只读功能 + 账号管理（增删改用户、重置密码、强制下线、查看审计） |
| `viewer` | 全部只读功能（总览/容器/设备/系统/工具），个人偏好与自助改密 |

### 强制点

- **后端**：`src/api/index.ts` 的 `PROTECTED_PREFIXES` 为每个路由域统一挂
  `createRequireRoleHook('viewer')`；管理员接口在 handler 内再 `assertAdmin`。
  "默认安全"——新增路由忘记加守卫，最坏结果是"需要登录"，不会匿名开放。
- **前端**：`AdminOnly` 组件隐藏入口并渲染 403 页。**仅为体验**，
  后端会独立拒绝（有测试覆盖）。

### 关键不变量（有测试）

- 系统内**始终至少有一个启用状态的 admin**：拒绝删除/降级/禁用最后一个。
- 不能删除当前登录账号。
- 重置他人密码会吊销该用户全部会话。

## 4. CSRF

| 项 | 实现 |
| --- | --- |
| 令牌 | 每条会话独立的 `csrf_token`（24 字节随机），随会话行存储 |
| 下发 | `GET /api/auth/session` 响应体的 `csrfToken` 字段 |
| 回填 | 前端 `ApiClient` 对**非 GET** 请求自动加 `X-CSRF-Token` |
| 校验 | `createCsrfHook`：存在性 + `timingSafeEqual` 与会话记录比对 |
| 豁免 | `POST /api/auth/login`、`POST /api/auth/bootstrap`（此时尚无会话）；所有 `GET/HEAD/OPTIONS` |
| 附加防线 | `SameSite=Lax` —— 跨站发起的非导航请求不会带上 Cookie |

> 为什么不用 Double-Submit Cookie：会话令牌是 httpOnly 的，前端无法读取它来做签名；
> 服务端持有会话记录，直接比对存储的令牌更简单且没有"cookie 可被覆盖"的攻击面。

## 5. 限流

| 范围 | 配置 |
| --- | --- |
| 登录 | 10 次 / 分钟 / IP（`LOGIN_RATE_LIMIT`），超出返回 `429 RATE_LIMITED` |
| 全局 | 插件已注册但 `global: false`，仅按需对路由开启（避免误伤 SSE 长连接与频繁轮询） |

限流键为 `request.ip`，它的可信度完全取决于 `trustProxy` 边界。默认值是
**`loopback`**（只信任来自回环地址的代理），与标准部署
`tailscale serve → 127.0.0.1:8899` 精确匹配：

| `PORTAL_TRUST_PROXY` | 含义 | 安全后果 |
| --- | --- | --- |
| 未设置 / `loopback`（默认） | 只信任回环来源的 `X-Forwarded-For` / `X-Forwarded-Proto` | 拿到真实客户端 IP（限流键正确），同时**忽略** tailnet 直连客户端自带的伪造头 |
| `0` / `false` | 完全不信任任何转发头 | 反代部署下所有请求被归到同一个 IP 桶（= 10 次/分钟全站共享） |
| IP / CIDR 列表（如 `127.0.0.1/8,::1`） | 显式白名单 | 与 `loopback` 等价的写法，适合代理不在回环上的场景 |
| `1` / `true` | 无条件相信**任何来源**的转发头 | ⚠️ 任意客户端都能伪造客户端 IP 绕过登录限流；还能让门户以为自己在 HTTPS 后面（误发 `Secure` Cookie） |

非法值**启动即报错**（不静默退化成"信任所有人"）。

> 为什么默认不是 `true`：门户在 tailnet 内可被任意设备直连，`true` 等于把
> "我是谁、我用的是什么协议"的决定权交给每一个客户端。
> 为什么默认也不是 `false`：标准部署里代理连接必然来自回环，`loopback` 既拿到真实 IP，
> 又不必相信任何外部来源。改这个值之前请先确认"门户前面是否真有一个**不可绕过**的反代"。

## 6. 敏感信息脱敏

`src/util/redact.ts` 在**服务端**处理，前端拿到的就是打码后的数据：

| 场景 | 处理 |
| --- | --- |
| 容器环境变量（详情页） | `redactEnvList`：key 命中敏感模式 → `***` |
| 容器日志 | `redactLines`：`KEY=VALUE` 形式的密钥 → `***`；同时命中 `sk-*`/`tskey-*`/`ghp_*`/`AKIA*`/`Bearer *` 字面量 |
| 日志文本 | `redactText` |

敏感 key 模式（`isSensitiveKey`）：`password|passwd|passphrase`、`secret`、`token`、
`api_key|apikey`、`access_key`、`private_key`、`auth_key`、`credential`、`authorization`、
`session_id`、`cookie`、`salt`、以 `_key` 结尾。

**原则：宁可多打码，不可漏密钥。** 因此像 `TS_AUTHKEY` 这类命名也会命中。

## 7. 运行时设置的安全考量

界面可改运行时配置后，新增的攻击面与应对：

| 关注点 | 处理 |
| --- | --- |
| 谁能改 | **仅 admin**。`/api/settings/*` 的每个 handler 内 `assertAdmin`（不依赖前端隐藏） |
| CSRF | 变更类接口（PATCH / POST）走统一的 CSRF 钩子 |
| 敏感值读取 | API Token 一律打码（保留 `tskey-api-` 前缀便于确认身份），前端拿到的不含原文 |
| 敏感值写入 | 提交 `********` 或空字符串 = **不修改**。避免"界面上的打码值被当成新值写回" |
| 审计 | `settings.update` 记录被改的键；**敏感项只记键名，值写 `***`** |
| 越权提权 | 设置里**没有**任何可以提权的项（不能改角色、不能改认证方式） |
| 改坏配置 | `restart` 级键服务端拒绝；非法值逐项拒绝并保留其余项；界面可一键「恢复默认」 |
| 数据库中的敏感值 | 标了 `sensitive` 的键**落库即密文**（AES-256-GCM，`enc:v1:<base64(iv\|tag\|cipher)>`），主密钥来自 `PORTAL_SECRET_KEY` 或 `<dataDir>/secret.key`（0600）。拷贝走数据库文件拿不到 Token；非敏感键保持明文便于排障 |
| 密钥轮换 | 新密钥 + `PORTAL_SECRET_KEY_PREVIOUS`（只用于解密）仍能读旧密文，`reencryptAll()` 把老密文升级到当前密钥 |
| 解不开的密文 | 密钥不匹配/密文被改时**不崩进程**：该键按"未设置"处理（不进 config、不传给外部 API），日志只记键名与固定原因，用户重填一次即恢复 |
| 存量明文迁移 | 无 `enc:v1:` 前缀视为迁移前的旧明文：照常读取，下次写入该键时自动升级为密文；首启装配调用一次 `reencryptAll()` 兜底全部升级 |

> 设计取舍：主密钥与数据库可能同卷（自动生成密钥文件时的默认行为），
> 这防的是"数据库文件被单独拷走"，**不防主机失陷**。
> 需要更强隔离时显式提供 `PORTAL_SECRET_KEY`（宿主环境变量），
> 与数据库分开保管。加密范围由注册表的 `sensitive: true` 决定，
> 新增加密项只需在 `registry.ts` 打标，无需改存储层。

### 主密钥：来源、作用范围与丢失后果

| 项 | 说明 |
| --- | --- |
| 来源优先级 | `PORTAL_SECRET_KEY`（宿主环境变量）→ `PORTAL_SECRET_KEY_FILE`（默认 `<dataDir>/secret.key`，文件存在即读取）→ 两者都没有时**自动生成**并写入该文件（`0600`） |
| 编码 | 32 字节，写成 64 位十六进制或 base64（可用 `openssl rand -base64 32` 生成）；长度不对**启动即报错** |
| 作用范围 | `settings` 表里标 `sensitive` 的键 **+ 用户的 TOTP 种子**（同一个 `secretBox`，`users.totp_secret` 同样是 `enc:v1:` 密文）。非敏感键保持明文，便于排障与人工修库 |
| 轮换 | 把旧密钥填进 `PORTAL_SECRET_KEY_PREVIOUS`（逗号分隔，**只用于解密**）再换主密钥；启动时 `reencryptAll()` 把老密文升级到当前密钥后才算完成 |
| 密钥丢失/错配 | 已加密值不可逆：敏感设置按"未设置"处理（重填一次即恢复）；**TOTP 种子解不开** → 该账号的动态码校验不通过，需要管理员强制重置或走离线重置后重新绑定 |
| 恢复码不受影响 | 恢复码是**独立的摘要校验**（sha256，不经过主密钥），所以密钥丢失后"已保存恢复码"的用户仍能登录 |
| 备份要求 | `<dataDir>/secret.key` 必须与 `portal.sqlite` **一起**备份/恢复，否则备份里的敏感字段等于废纸（命令见 `08-operations.md` §10） |

> 底线：主密钥丢失**不会**让门户整体无法登录 —— 未启用两步验证的账号照旧用密码登录。
> 受影响的只是"已加密字段的可读性"与"已绑定 TOTP 账号的第二因子"。

## 8. 传输与浏览器侧

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 传输加密 | 默认 HTTP | NAS 上门户跑在 tailnet 内，WireGuard 已提供链路加密与设备认证 |
| 公网暴露 | 不建议 | 若必须，请在反代上启用 HTTPS 并设 `PORTAL_SECURE_COOKIES=1` |
| 安全响应头 | **已实现**（可关） | 手写而非 `@fastify/helmet`（见下）。默认 CSP + 六个固定头；`/api/*` 一律 `cache-control: no-store` |
| `robots` | `<meta name="robots" content="noindex, nofollow">` | 避免被索引 |

### 安全响应头（S0-03）

实现在 `server/src/http/securityHeaders.ts`，由 `app.ts` 注册 `onRequest` 钩子。
钩子放在鉴权钩子**之前**：这样连 401/403 之类的错误响应也会带头，不会出现"报错页没防护"的缝。

**为什么自己写而不用 `@fastify/helmet`**：

1. 门户只需要"固定头 + 一个可配 CSP"，引插件换来的是它一整套默认值，
   其中 `coep` / `origin-agent-cluster` 等对本场景没有收益，却要逐个去关 ——
   关错一个就可能让 SSE 或静态资源失效；
2. HSTS 的判定必须与本项目的 `trustProxy` 边界对齐（只在**确为 HTTPS** 时下发），
   自己写才能把"谁说了算"写清楚，而不是依赖插件默认值；
3. 少一个运行时依赖 = 少一份供应链风险，arm64/amd64 构建也不需要额外的安装步骤。

固定头（`STATIC_SECURITY_HEADERS`，与请求无关）：

| 头 | 值 | 作用 |
| --- | --- | --- |
| `x-content-type-options` | `nosniff` | 禁止浏览器嗅探类型，配合 CSP 压制"上传内容被当脚本执行"这一类问题 |
| `x-frame-options` | `DENY` | 与 CSP 的 `frame-ancestors 'none'` 双份声明，覆盖不支持 CSP 的老浏览器 |
| `referrer-policy` | `no-referrer` | 门户 URL 里含主机名/端口，跳转到外部服务时不应泄漏来源 |
| `cross-origin-opener-policy` | `same-origin` | 把门户与外部页面彻底隔离 |
| `cross-origin-resource-policy` | `same-origin` | 同上（禁止外部页面读取门户资源） |
| `x-permitted-cross-domain-policies` | `none` | 关掉 Flash/PDF 时代的跨域策略文件 |
| `permissions-policy` | `accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()` | 门户不需要任何设备能力，全部关掉 |

**CSP**：内置默认策略是 `config.ts` 的 `DEFAULT_CSP` 常量 ——
`default-src 'self'; base-uri 'self'; object-src 'none'; script-src 'self';
style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self';
connect-src 'self'; form-action 'self'; frame-ancestors 'none'`。
要点：`script-src 'self'` 不含 `'unsafe-inline'`（前端产物全是本地静态文件，无内联脚本）；
`style-src` 保留 `'unsafe-inline'` 是因为 React 组件用 `style` **属性**写少量内联样式
（进度条宽度等），属性级内联无法用 nonce 覆盖；`connect-src 'self'` 要允许同源 **SSE**
长连接。可用 `PORTAL_CSP` 整体覆盖（置空表示不下发 CSP）。

**HSTS**：只在 `request.protocol === 'https'` **且** 开关开启 **且** `maxAge > 0`
时下发（三者缺一不可），且**刻意不带** `includeSubDomains` / `preload`。
原因：宿主是 `family-nas.tail585599.ts.net` 这类**共享域名**，
带 `includeSubDomains` 会波及同域下不属于本门户的其它服务 —— 那不是本门户能替用户做的决定；
`preload` 同理。反向的可用性约束同样重要：对**内网 HTTP** 下发 HSTS 会把浏览器锁死在一个
不存在的 HTTPS 站点上，是真实的可用性事故。Tailscale Serve 终止 TLS 后回源到
`http://127.0.0.1:8899`，只有反代传来的 `X-Forwarded-Proto: https`（**经 `trustProxy` 判定**）
才能说明浏览器那一侧确实是 HTTPS。

**`/api/*` 一律 `cache-control: no-store`**：接口响应可能含容器环境变量快照、设备清单等
敏感内容，不应被浏览器或中间代理缓存。（SSE 是例外，它按自身语义写 `no-cache, no-transform`。）

开关与排障：`PORTAL_SECURITY_HEADERS=0` 可整体关闭（注册时会打一条 `warn`，仅应在排障时使用）。
验证：`curl -sI http://127.0.0.1:8899/ | grep -i content-security-policy`。

> ⚠️ **一个容易踩的坑：SSE 端点必须手动补头。**
> `/api/system/stream` 用 `reply.raw.writeHead()` 直接写原始响应头，
> **绕过了 Fastify 的正常发送流程，因此不会经过 `onRequest` 钩子里设置的那些头**。
> 该处理器显式调用一次 `securityHeadersFor(ctx.config.securityHeaders, request.protocol)`
> 并展开进 head（见 `server/src/api/system.ts`）。
> 以后再新增"直接写 raw head"的端点（长连接、文件流等）必须照做，
> 否则会出现"普通接口有 CSP、SSE 没有"的隐形缺口。
> `e2e/security-headers.spec.ts` 对首页响应头与"CSP 不阻断门户自身前端产物"有断言。

## 9. 已知残余风险

按"是否会实际影响本场景"排序，作为后续迭代输入：

1. **两步验证是"可选"而非"强制"**：只有用户自己绑定 TOTP 后才生效，账号默认仍是"密码即可登录"；
   丢失验证器时若**唯一管理员**也丢了设备，只能走离线重置流程（`08-operations.md` §5：
   管理员强制重置 + 容器内改库两条路径，后者绕过审计）。
   缓解：恢复码一次性展示 + 管理员强制重置（有审计）+ 限流 + 强口令 + 通常仅在 tailnet 内可达。
2. **安全响应头已实现，但策略仍需按部署复核**：默认 CSP 为 React 的内联 `style` 属性保留了
   `style-src 'unsafe-inline'`，也没有 `report-uri` / `report-to`，因此**违规是静默的**；
   `PORTAL_CSP` 改错或加严（例如误删 `connect-src 'self'`）会直接打断 SSE 与登录流程。
   建议改动后用 `curl -sI` 复核响应头，并跑一次 `npm run test:e2e`（含 CSP 不阻断前端产物的断言）。
3. **无审计日志界面以外的告警**：登录失败只有记录，没有通知。
4. **`nvidia-smi` / `tailscale` 以只读方式挂载宿主二进制**：本身是执行宿主程序，
   若镜像被替换则可被滥用。缓解：只读挂载、镜像来源可信、容器非 root 运行。
5. **`docker.sock` 挂载**：门户只调用只读 API，但拥有 socket 等于拥有宿主 root 等价能力。
   **若攻击者控制了门户进程，即可控制宿主 Docker。** 这是本架构最大的风险点，
   因此：只读展示、不提供写操作、`node` 用户运行、登录强制、限流，
   并且默认 compose 已把 socket 改成 **`:ro`** 挂载，另加 `cap_drop: ALL` +
   `no-new-privileges:true`。
   但注意 —— **`:ro` 挡不住写 API**：Docker 的 HTTP API 看不到挂载选项，
   容器内的进程依然能对 socket 发 `POST /containers/{id}/stop` 这类写请求。
   真正的最小权限做法是走**只读 socket 代理**：仓库已提供可选的
   `docker-compose.socket-proxy.yml`（只放行 `CONTAINERS` / `INFO` / `VERSION` / `PING`），
   此时"不能写"是代理层的**结构性**保证，与门户代码是否有漏洞无关
   （用法与代价见 `08-operations.md` §11）。
6. **SQLite 无整库静态加密**：数据库文件包含用户名与密码哈希，不含明文密码；
   敏感设置项已是 AES-256-GCM 密文（§7），但**主密钥文件默认与数据库同卷**，
   因此"数据库文件单独泄露"可防、"整卷/主机失陷"不可防。
   更高要求请显式设 `PORTAL_SECRET_KEY` 并把密钥与数据卷分开存放。

## 10. 安全检查清单（发布前）

- [ ] `PORTAL_SETUP_TOKEN` 未硬编码在 `docker-compose.yml` 或镜像内
- [ ] 首启后确认 `data/setup-token.txt` 已删除或卷不可被他人读取
- [ ] 备份数据卷时**一并备份** `<dataDir>/secret.key`（或单独保管 `PORTAL_SECRET_KEY`）——
      主密钥丢失后敏感设置与后续的 TOTP 种子都无法解密；换密钥时用
      `PORTAL_SECRET_KEY_PREVIOUS` 过渡并确认 `reencryptAll()` 已升级完毕
- [ ] `.env` 未提交到 git（`.gitignore` 已包含）
- [ ] 反代部署时设置了 `PORTAL_SECURE_COOKIES=1` 与正确的 `X-Forwarded-*`
- [ ] `PORTAL_TRUST_PROXY` 保持 `loopback`（或等价的显式白名单），**没有**设成 `1`
- [ ] HTTPS 部署下 `curl -sI https://<门户>/ | grep -i strict-transport-security`
      能看到 `max-age=` 且**不含** `includeSubDomains`；HTTP 直连时不出现该头
- [ ] `docker-compose.yml` 里的 `docker.sock` 仍是 `:ro`，
      需要更强保证时已启用只读 socket 代理（`docker-compose.socket-proxy.yml`）
- [ ] 区分 admin 与 viewer 账号用途，日常浏览用 viewer
- [ ] 需要的账号已绑定两步验证，并且**恢复码已离线保存**（恢复码只显示一次）
- [ ] 定期检查审计日志中的 `auth.login_failed`、`auth.totp_failed`、`auth.totp_reset`
