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

限流键为 `request.ip`。部署在反代之后时必须保证 `PORTAL_TRUST_PROXY=1`
且反代**正确重写** `X-Forwarded-For`，否则所有请求会被归到同一个 IP 桶。

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

## 7. 传输与浏览器侧

| 项 | 现状 | 说明 |
| --- | --- | --- |
| 传输加密 | 默认 HTTP | NAS 上门户跑在 tailnet 内，WireGuard 已提供链路加密与设备认证 |
| 公网暴露 | 不建议 | 若必须，请在反代上启用 HTTPS 并设 `PORTAL_SECURE_COOKIES=1` |
| 安全响应头 | 未设置 | 未引入 `@fastify/helmet`。因门户不内嵌第三方内容且无用户可控 HTML，风险有限；见"残余风险" |
| `robots` | `<meta name="robots" content="noindex, nofollow">` | 避免被索引 |

## 8. 已知残余风险

按"是否会实际影响本场景"排序，作为后续迭代输入：

1. **无 TOTP / 二次验证**：拿到密码即可登录。缓解：限流 + 强口令 + 通常仅在 tailnet 内可达。
2. **无安全响应头**（CSP / X-Frame-Options / HSTS）：建议后续引入 `@fastify/helmet` 并加 CSP。
3. **无审计日志界面以外的告警**：登录失败只有记录，没有通知。
4. **`nvidia-smi` / `tailscale` 以只读方式挂载宿主二进制**：本身是执行宿主程序，
   若镜像被替换则可被滥用。缓解：只读挂载、镜像来源可信、容器非 root 运行。
5. **`docker.sock` 挂载**：门户只调用只读 API，但拥有 socket 等于拥有宿主 root 等价能力。
   **若攻击者控制了门户进程，即可控制宿主 Docker。** 这是本架构最大的风险点，
   因此：只读展示、不提供写操作、`node` 用户运行、登录强制、限流。
   若需进一步收敛，可换成只读 socket 代理（如 `docker-socket-proxy` 并仅放行 GET）。
6. **SQLite 无静态加密**：数据库文件包含用户名与密码哈希，不含明文密码。
   卷权限由 Docker 管理。

## 9. 安全检查清单（发布前）

- [ ] `PORTAL_SETUP_TOKEN` 未硬编码在 `docker-compose.yml` 或镜像内
- [ ] 首启后确认 `data/setup-token.txt` 已删除或卷不可被他人读取
- [ ] `.env` 未提交到 git（`.gitignore` 已包含）
- [ ] 反代部署时设置了 `PORTAL_SECURE_COOKIES=1` 与正确的 `X-Forwarded-*`
- [ ] 区分 admin 与 viewer 账号用途，日常浏览用 viewer
- [ ] 定期检查审计日志中的 `auth.login_failed`
