# HomePort 2.0 · Sprint 0 实施报告（变更总结 / 升级与回滚）

- **Sprint**：Sprint 0「止血与安全基线」（计划见 `docs/HomePort_2.0_Balanced_Development_Plan.md` §3）
- **范围**：S0-01 基线审计 · S0-02 CI 质量门 · S0-03 安全加固 · S0-04 Docker 最小权限 · S0-05 技术债
- **状态**：代码 / 测试 / 迁移 / 文档 全部落盘，验收命令全绿（见 §6）
- **下一阶段**：**等待人工确认后**再开始 Sprint 1（本文末尾列出建议进入 Sprint 1 的前置条件）

---

## 1. 交付概览

| 项 | 内容 | 状态 |
| --- | --- | --- |
| S0-01 | 基线审计报告 `docs/sprint0-baseline-audit.md`（126 行，含只读复现命令） | ✅ |
| S0-02 | `.github/workflows/ci.yml`（新）+ `docker-publish.yml` 质量门 | ✅ |
| S0-03a | 安全响应头 / CSP / HSTS + `trustProxy` 边界收紧 | ✅ |
| S0-03b | 敏感设置 AES-256-GCM 加密 + 主密钥管理 + 轮换 | ✅ |
| S0-03c | 两步验证（TOTP）：后端 + 前端 + 恢复码 + 管理员重置 + 离线兜底 | ✅ |
| S0-04 | `docker.sock` 只读挂载 + `cap_drop: ALL` + 可选只读 socket 代理（**已本机实测**） | ✅ |
| S0-05 | AdminPage 拆分 / docker mapper 拆分 / web 单测 / Playwright E2E / MIT LICENSE | ✅ |

**没有做的事**（有意留到后续 Sprint，理由见 §9）：Sprint 1 的指标留存与告警、`read_only: true` 根文件系统默认开启、双栈端口去重的**服务级**合并。

---

## 2. 逐项变更

### 2.1 S0-03a 安全响应头（`server/src/http/securityHeaders.ts`，新）

- **实现方式**：手写而非引入 `@fastify/helmet`。理由：HSTS 需要"**仅 HTTPS 时下发**"的条件判断、SSE 分支需要绕开 Fastify 钩子单独处理，helmet 的默认组合反而要写更多覆盖代码；同时少一个运行时依赖。
- **固定头**：`x-content-type-options: nosniff`、`x-frame-options: DENY`、`referrer-policy: no-referrer`、COOP/CORP `same-origin`、`permissions-policy`（关闭摄像头/麦克风/地理位置等）、`x-permitted-cross-domain-policies: none`。
- **CSP**：内置默认策略（`default-src 'self'` 系），可用 `PORTAL_CSP` 覆盖。
- **HSTS**：仅当 `request.protocol === 'https'` 且开关打开且 `maxAge > 0` 时下发；**不带** `includeSubDomains` / `preload`（宿主是 `*.ts585599.ts.net` 共享域名，带 includeSubDomains 会污染同域其它服务）。
- **`/api/*` 一律 `cache-control: no-store`**。
- ⚠️ **踩过的坑**：SSE 端点（`server/src/api/system.ts`）用 `reply.raw.writeHead` 直接写响应头，会**绕过** Fastify 的 `onRequest` 钩子 —— 那里必须手动补 `securityHeadersFor(...)`，否则该响应没有任何安全头。

### 2.2 S0-03a `trustProxy` 边界收紧（`server/src/config.ts`）

- 默认值由「信任全部」改为 **`loopback`**，与标准部署 `tailscale serve → 127.0.0.1:8899` 匹配：既能拿到真实客户端 IP（登录限流才有意义），又会忽略伪造的 `X-Forwarded-For`。
- 支持 `0` / `loopback` / IP 或 CIDR 列表 / `1`（危险，仅限门户前面确实没有反代、且不暴露公网的场景）。
- **回归测试**：`server/tests/securityHeaders.test.ts` 用 100.72.255.30 伪造 XFF 验证"默认不被采信"，同时验证 loopback 来源会被采信。

### 2.3 S0-03b 敏感设置加密（`server/src/modules/settings/secretBox.ts` + `secretStore.ts`，新）

- AES-256-GCM，密文格式 `enc:v1:<base64(iv|tag|cipher)>`（12 字节 IV + 16 字节认证标签 + 密文，拼成一个 base64；前缀带版本号便于日后换算法）。
- 主密钥来源优先级：`PORTAL_SECRET_KEY` → `PORTAL_SECRET_KEY_FILE` → **自动生成** `<数据目录>/secret.key`（权限 0600，日志提示"请随数据卷一起备份"）。
- 装饰器式 `SecretSettingsStore`：写时加密、读时解密；**解不开的行会被丢弃**而不是让启动失败（主密钥丢失时门户仍可启动、可登录）。
- 启动时 `settings.reencryptAll()`：把存量明文敏感值一次性升级为密文，**幂等**（只处理"不是当前密钥密文"的行），失败只告警不中断启动。
- 密钥轮换：旧密钥填 `PORTAL_SECRET_KEY_PREVIOUS`（逗号分隔）即可解密旧数据，启动时自动升级到新密钥。
- 同一个 `secretBox` 同时服务 TOTP 种子（见 2.4），避免两套密钥。

### 2.4 S0-03c 两步验证 TOTP

**后端**

- `server/src/modules/auth/totp.ts`：RFC 6238 纯函数核心（HMAC-SHA1、6 位、30 秒周期、±1 周期时间窗、`timingSafeEqual`、防重放计数器），另含 Base32 编解码、`otpauth://` 链接生成、恢复码生成/归一化/摘要。
- `server/src/db/totp.ts`：恢复码仓储（核销）与登录挑战仓储（创建/校验/计数/作废/清理）。
- 登录改为**两步**：密码通过后若账号已启用 TOTP 则**不签发会话**，只返回 5 分钟有效的挑战令牌；第二步用 TOTP 码或恢复码换取会话。
- 绑定流程：`setup`（生成种子，明文只返回一次）→ `enable`（回填验证码，一次性返回 10 个恢复码）。
- 关闭门槛不低于开启：需当前密码；已启用时还需一次当前验证码或恢复码。
- 管理员可强制重置任意用户的两步验证（清空种子与恢复码 + **吊销该用户全部会话**），审计记录到管理员头上。
- 定时清理过期挑战；审计写入 `auth.totp_enabled/disabled/failed/reset/recovery_used/recovery_regenerated/setup_started` 等动作。

**关键设计取舍（有意为之，已写进代码注释）**

1. **防重放只作用于登录路径**：`totp_last_counter` 仅在"登录第二步"被写入。会话内的再次确认（关闭两步验证、重生成恢复码）**不消费**计数器 —— 否则"绑定完立刻退出再登录"会在同一个 30 秒窗口里被自己的防重放挡住（自伤式安全）。绑定成功时也刻意不记录计数器。
2. **`PORTAL_TOTP_ENABLED=0` 只是"不允许新绑定"**：已经绑定的账号仍会继续要求第二步，避免管理员关掉开关就把所有账号静默降级成"仅密码"；同时"关闭两步验证 / 重生成恢复码"不受该开关影响（否则用户会被开关锁在门外）。已由 `server/tests/totpDisabled.test.ts` 钉住。
3. **种子与恢复码永不回显**：种子以 `enc:v1:` 密文入库，恢复码只存 sha256 摘要；`toPublicUser` 改为**显式白名单**（原来是"解构掉 passwordHash 后展开"，加字段就会静默泄漏）。
4. **接口挂在 `/api/users/me/*`**：`/api/auth/*` 是匿名作用域（无角色守卫、无 CSRF 钩子），而绑定/关闭是登录后的变更操作，必须同时满足"已登录 + CSRF"。

**前端**

- 登录页两分支（密码 → 验证码），`TOTP_INVALID` 就地重试、`TOTP_CHALLENGE_EXPIRED` 退回第一步；挑战令牌只存在组件状态里，**不落 Web Storage**。
- 安全面板：启用向导（手输密钥 + otpauth 文本，**未引入二维码库**）、一次性恢复码弹窗（必须勾选"我已保存恢复码"才能关闭）、重新生成恢复码、关闭；用户列表显示"两步验证已启用"徽标与强制重置按钮。
- **顺带修掉一个真实缺陷**：`web/src/api/client.ts` 原先"任何 401 都触发全局登出"，导致"输错一次验证码 = 被踢下线"（也影响"改密时输错当前密码"）。现对 `TOTP_INVALID` / `TOTP_CHALLENGE_EXPIRED` / `INVALID_CREDENTIALS` 不触发登出，真正的会话失效（`UNAUTHORIZED`）行为不变。

### 2.5 S0-04 Docker 最小权限

`docker-compose.yml`：

- `docker.sock` 挂载加 **`:ro`**；
- 新增 `cap_drop: [ALL]` 与 `security_opt: [no-new-privileges:true]`（门户只读 Docker、只读宿主文件、日志走 stdout，不需要任何 capability）；
- **移除硬编码的 Windows `"C:/:/host/disk/C:ro"`**（在 Linux/NAS 上会让 `docker compose up` 直接失败，个别版本还会悄悄创建出 `C:` 目录），改为"按需取消注释 + 在 `PORTAL_DISK_MOUNTS` 登记"；
- 补全新环境变量的透传（安全头 / 主密钥 / TOTP）。

`docker-compose.socket-proxy.yml`（新，可选覆盖文件）：

- 用 `tecnativa/docker-socket-proxy`（HAProxy 实现，多架构：amd64/arm64/armv7/386/ppc64le/s390x，已核对 manifest）把 socket 藏在只读代理后面，门户改连 `tcp://docker-socket-proxy:2375`，代理**不发布宿主端口**。
- 放行清单按代码实际用到的接口最小化：`CONTAINERS` / `INFO` / `VERSION` / `PING`；`POST` / `EXEC` / `BUILD` / `SECRETS` / `IMAGES` / `NETWORKS` 等一律 0。
- **为什么 `:ro` 不够**（本文件存在的理由）：`:ro` 只是挂载层的只读，Docker 的 HTTP API 完全看不到挂载选项，容器内进程依然可以对 socket 发 `POST /containers/{id}/stop` 这类写请求。代理把"只读"变成**结构性**保证，与门户代码是否有漏洞无关。

**本机实测记录**（临时代理容器，测完已删除；未触碰任何既有容器/卷）：

| 探测 | 结果 |
| --- | --- |
| `GET /_ping`、`/version`、`/info`、`/containers/json` | 200 |
| `GET /images/json`、`/secrets`（未放行） | **403** |
| `POST /containers/<不存在>/start`、`DELETE /containers/<不存在>` | **403** |
| 真实门户产物经代理运行 | `health 200`、`bootstrap 201`、登录成功、列出 **7 个**容器、inspect 拿到 ports/mounts/networks、logs 正常 |
| 清理后 | 临时代理残留 0、8991 无监听、用户 `homeport-portal` 容器始终 `running / healthy` |

### 2.6 S0-02 CI 质量门

- `.github/workflows/ci.yml`（新）：`pull_request` + `push(master)` + `workflow_dispatch`；**不设 `paths-ignore`**（安全相关改动必须被拦住）；`permissions: contents: read`；不使用任何 `secrets.`。
  - job `quality`：`npm ci` → `npm run typecheck` → `npm test` → `npm run build` → 校验构建产物存在；
  - job `e2e`（`needs: quality`）：`npx playwright install --with-deps chromium` → `npm run test:e2e`，失败时上传 `playwright-report`。
- `.github/workflows/docker-publish.yml`：新增独立 `quality` job，`build-and-push` 改为 `needs: quality`。该工作流**没有** `pull_request` 触发（fork PR 拿不到 secrets）。
- **明确记录**：E2E 是 CI 的必过检查，但**不是**发布依赖 —— 发布门只要求 `quality`（typecheck + 单测 + build）。
- ⚠️ **想让 E2E 也拦住发布，不能只改一行**：GitHub Actions 的 `needs` **不能跨工作流引用** `ci.yml` 里的 job。正确做法是在 `docker-publish.yml` 里**再定义一个** `e2e` job（内容与 `ci.yml` 的一致），然后写 `needs: [quality, e2e]`。只加 `needs` 而不同时定义 job，工作流会直接报错。
- `server/tests/ciWorkflow.test.ts` 用结构化断言守着这些不变量（有 PR 触发、无 paths-ignore、无 secrets 引用、publish 依赖 quality 且无 PR 触发），防止以后被"顺手改回去"。

### 2.7 S0-05 技术债

| 项 | 结果 |
| --- | --- |
| `AdminPage.tsx` 拆分 | 655 → 89 行；新增 `web/src/pages/admin/{UsersTab,AuditTab,SecurityTab}.tsx`；逐行等价重构 |
| docker 映射拆分 | `server/src/modules/docker/service.ts` 700 → 370 行；新增 `mapper.ts`（460 行纯函数）+ `server/tests/dockerMapper.test.ts`；`service.ts` 保留同名 re-export，旧 import 路径不变 |
| web 单测 | web 工作区接入 vitest + jsdom + Testing Library，`web/tests/` 4 个文件 |
| E2E | `playwright.config.ts` + `e2e/start-server.mjs` + 2 个 spec（7 条用例） |
| LICENSE | 根目录 `LICENSE`（MIT，Copyright (c) 2026 xs-www） |

- **docker mapper 拆分唯一的有意行为变更**：`0.0.0.0` 与 `::` 同宿主端口的双栈重复绑定现在去重（`dedupeIdenticalBindings`），`ports` 条目 2 → 1、入口重复 URL 2 → 1；`reachability` / `primaryUrl` / `urlCandidates` 不变。判据**不含 hostIp**，且 `127.0.0.1` 与 `0.0.0.0` 同端口（可达性不同）**不合并**。
- 旧实现 vs 新实现的机器化对比：168 次输出比较，差异 24 处**全部**落在双栈 fixture，其余 12 类形态逐字节一致。
- E2E 默认端口 **8988**（刻意避开门户生产端口 8899：开发机上常跑着 `homeport-portal`，而配置要求 `reuseExistingServer: false`，撞端口会让 `npm run test:e2e` 直接失败）。可用 `PORTAL_E2E_PORT` 覆盖。

---

## 3. 数据库迁移（升级前必读）

**migration `version: 3`，名称 `totp_two_factor`**（`server/src/db/database.ts`）：

- `users` 表新增：`totp_secret`（`enc:v1:` 密文，可空）、`totp_enabled`（0/1）、`totp_confirmed_at`、`totp_last_counter`（防重放时间步）。
- 新表 `totp_recovery_codes(id, user_id, code_hash, created_at, used_at)`、`totp_challenges(id, token_hash, user_id, created_at, expires_at, consumed_at, attempts)` 及索引。

特性：

- **向后兼容**：纯新增列/表，无数据改写；旧版本代码读新库会忽略这些列（可回滚，见 §5）。
- **自动执行**：启动时按版本号向前迁移，每个迁移在**单个事务**内完成（失败即回滚，不会留下半迁移状态）。
- **存量明文敏感设置**：启动时由 `reencryptAll()` 一次性升级为密文，幂等、可重复执行。

---

## 4. 配置变更（升级注意）

### 4.1 默认值变更（**会影响现有部署，务必确认**）

| 变量 | 旧行为 | 新默认 | 影响与处置 |
| --- | --- | --- | --- |
| `PORTAL_TRUST_PROXY` | 文档写"默认信任全部"（代码默认 `loopback`） | **`loopback`** | 反代场景（`tailscale serve`）**无需改动**，且限流更准；若门户被**直接**暴露、前面没有任何反代，且你依赖 `X-Forwarded-For` 统计来源，请显式设为 `0`（保持不信任）或列出反代 IP。**不要**为了"让 IP 显示对"就设 `1`（任何人可伪造 IP 绕过登录限流）。 |
| `docker.sock` 挂载 | 读写 | **`:ro`** | 门户本来就只做读取，无需改动；若你自行加过写操作的自定义脚本，请改用覆盖文件或恢复该行。 |
| `PORTAL_DISK_MOUNTS` + compose 磁盘挂载 | compose 默认挂 `C:/` | **不挂任何宿主磁盘** | Windows 用户若要继续看 C: 占用，需在 `docker-compose.yml` 的 volumes 里取消注释 `- "C:/:/host/disk/C:ro"`，并保留 `PORTAL_DISK_MOUNTS=C:=/host/disk/C`。 |

### 4.2 新增环境变量（全部有默认值，最小可用配置仍是空 `.env`）

安全：`PORTAL_SECURITY_HEADERS`(1)、`PORTAL_CSP`(空=内置)、`PORTAL_HSTS`(1)、`PORTAL_HSTS_MAX_AGE`(15552000)、`PORTAL_TRUST_PROXY`(loopback)、`PORTAL_SECRET_KEY`(空)、`PORTAL_SECRET_KEY_FILE`(空)、`PORTAL_SECRET_KEY_PREVIOUS`(空)。

两步验证：`PORTAL_TOTP_ENABLED`(1)、`PORTAL_TOTP_ISSUER`(HomePort)、`PORTAL_TOTP_WINDOW`(1)、`PORTAL_TOTP_CHALLENGE_TTL_SECONDS`(300)。

详见 `.env.example` 的「安全」与「两步验证」小节。

### 4.3 新接口（契约见 `docs/static/04-api-contract.md`）

`POST /api/auth/login/totp`、`POST /api/users/me/totp/{setup,enable,disable,recovery-codes}`、`POST /api/users/:id/totp/reset`（管理员）。`POST /api/auth/login` 在账号启用 TOTP 时改为返回 `{ totpRequired: true, challengeToken, expiresAt }`（**不设 Cookie**）。

---

## 5. 升级与回滚

### 5.1 升级步骤

```bash
# 1) 备份（必须：数据库 + 主密钥要一起备，否则加密字段无法恢复）
docker compose exec homeport sh -c 'cp /data/portal.sqlite /data/portal.sqlite.bak'
docker cp homeport-portal:/data/secret.key ./secret.key.bak        # 若你让门户自动生成密钥

# 2) 拉取新代码并重建
docker compose up -d --build

# 3) 核对启动日志（应看到迁移与密钥来源，且无 "请求处理失败" 报警）
docker compose logs homeport | Select-String "迁移|加密|初始化令牌"

# 4) 冒烟：登录 → 改一个设置并刷新 → （可选）在「账号管理 → 安全」里启用两步验证
```

NAS 上建议同时启用只读 socket 代理：

```bash
docker compose -f docker-compose.yml -f docker-compose.socket-proxy.yml up -d --build
```

### 5.2 回滚

- **代码回滚**：`git revert` 到 Sprint 0 之前的提交后 `docker compose up -d --build` 即可。migration v3 只**新增**列与表，旧代码不读它们，因此**不需要**改库、也不会丢数据。
- **数据库回滚**：只有在你想彻底清掉 TOTP 相关列/表时才需要（正常回滚不必做）。做法：停容器 → 用备份覆盖 `/data/portal.sqlite` → 起旧版本。
- **安全头/TOTP 出问题时的最小回退**（不必回滚代码）：`PORTAL_SECURITY_HEADERS=0`、`PORTAL_TOTP_ENABLED=0`（已绑定的用户仍会被要求第二步，这是有意的；确实要全关就逐个在界面上关闭两步验证，或按下节重置）。
- ⚠️ **主密钥丢失**：`/data/secret.key` 丢失后，已加密的敏感设置与 TOTP 种子都不再可解。影响是**分层**的：未启用两步验证的账号照旧用密码登录；已启用的账号动态码不可用，但**恢复码仍可用**（恢复码只存 sha256 摘要，不依赖主密钥）—— 因此门户不会整体锁死。处置方式：重新填写敏感设置；已绑定 TOTP 的用户优先用恢复码登录，没有恢复码的走管理员重置或离线流程后重新绑定。

---

## 6. 验收记录

| 命令 | 范围 | 结果 |
| --- | --- | --- |
| `npm run typecheck` | server + web（tsc，strict） | ✅ exit 0 |
| `npm test` | server（15 文件 / 333 用例）+ web（4 文件 / 106 用例），合计 **439** | ✅ 全绿 |
| `npm run build` | web（vite）+ server（tsc）生产构建 | ✅ |
| `npm run test:e2e` | Playwright + Chromium，2 个 spec / 7 条用例 | ✅ 7 passed |

E2E 覆盖：首启初始化（错误令牌被拒 → 正确令牌建管理员 → 自动落到首页）、登录/登出与回跳、关键页面降级提示（Docker 与 tailnet 数据源不可用时显示原因而非白屏）、权限（viewer 看不到「账号管理」、直敲 `/admin` 得到"权限不足"）、安全响应头（CSP 指令 + `nosniff`，且 CSP 不阻断前端产物、无 CSP 违规）。

专项新增测试：

- `server/tests/securityHeaders.test.ts`：HSTS 仅 HTTPS、无 includeSubDomains、CSP 指令、`/api/*` no-store、SSE 仍为 `text/event-stream`、`trustProxy` 默认拒绝伪造 XFF。
- `server/tests/secretBox.test.ts` + `settingsCrypto.test.ts`：加密往返、密钥来源、轮换、`reencryptAll` 幂等、解不开时不崩。
- `server/tests/totp.test.ts`：**RFC 6238 官方测试向量**（8 位码逐条一致；6 位码 = 后 6 位）、Base32 往返、时间窗、防重放、otpauth URI、恢复码。
- `server/tests/totpFlow.test.ts`：真实路由端到端 22 条 —— 未启用时登录行为不变、第一步不签发 Cookie、绑定/启用/恢复码/关闭全流程、恢复码一次性、登录码防重放、尝试 5 次后挑战作废、管理员重置（含会话吊销与 403 权限）、种子与恢复码不出现在任何响应里。
- `server/tests/totpDisabled.test.ts`：`PORTAL_TOTP_ENABLED=0` 的三条边界（不能新绑定 / 已绑定仍走第二步 / 仍能关闭它）。
- `server/tests/ciWorkflow.test.ts`：CI/发布工作流的结构性不变量。
- `server/tests/migrationV3.test.ts`：**升级路径**专项 —— 用当前代码建文件库 → 用 SQLite 把库真实退回 v2 形态（删 v3 的 4 列 + 2 表 + `schema_migrations` 里 version=3）→ 重启 → 断言迁移重放成功、原管理员密码照旧可登录、用户与设置都在、**升级前加密的敏感值仍能解出原值**（密钥文件被复用）、新列真的可用（能完成 TOTP 绑定）。
- `server/tests/composeHardening.test.ts`：compose 硬化的**结构性**断言（socket 必须 `:ro`、`cap_drop: ALL`、无硬编码 `C:/`、代理只放行 4 个读接口且写接口全 0、代理端口不发布到宿主）。
- `server/tests/dockerMapper.test.ts`、`web/tests/{client,format,components,totp}.test.*`。

### 6.1 过程中发现并修掉的自身缺陷（记录在案）

1. **`PORTAL_TOTP_ENABLED` 一度是"只写进文档、代码里没人读"的开关**：注释写着"关掉只是不允许新绑定"，但 `config.totp.enabled` 在任何地方都没有读取点 —— 也就是说关掉它什么也不会发生。文档归档阶段核对源码时发现，已补上 `assertTotpEnrollmentAllowed()` 与 `totpDisabled.test.ts` 的 5 条用例。**这类"开关看起来存在、实际不生效"的缺陷比缺少功能更危险**，因为部署者会以为自己已经关掉了某个能力。
2. **防重放计数器一度会在绑定成功时写入**：导致"绑定完立刻退出再登录"（同一个 30 秒窗口）被自己的防重放挡住。现改为只有**登录路径**消费计数器，会话内的再次确认不消费。
3. **`toPublicUser` 原本是"解构掉 passwordHash 后展开"**：加上 TOTP 字段后会**静默把种子密文带进 API 响应**。已改为显式白名单，并有"响应里不含 `enc:v1:`/种子/恢复码"的断言。
4. **前端"任何 401 都触发全局登出"**：会让"输错一次验证码"等于被踢下线（也影响改密时输错当前密码）。已按错误码区分（详见 2.4）。
5. **SSE 绕过安全头**：`reply.raw.writeHead` 不走 Fastify 钩子，已单独补头（详见 2.1）。

---

### 6.2 计划 §3「验收标准」逐条对照

| 计划的验收标准 | 证据 |
| --- | --- |
| CI 在含故意失败测试的 PR 上阻止镜像发布；正常分支通过全部质量门禁 | ① 放入一个故意失败的探针用例后 `npx vitest run` **退出码 = 1**，删除后对照用例 **退出码 = 0**（CI 的 `quality` job 靠这个非零码失败）；② `docker-publish.yml` 的 `build-and-push` 为 `needs: quality`，而 `quality` 跑的就是 typecheck + test + build；③ `docker-publish.yml` **没有** `pull_request` 触发，外部 fork PR 拿不到任何 secrets（有 `ciWorkflow.test.ts` 的结构化断言守着）。⚠️ 本机无法运行 GitHub Actions，工作流接线是静态断言 + YAML 复核，不是真跑过 CI。 |
| 既有管理员与设置无损迁移；重启可正常登录；TOTP 开关和恢复码有自动测试 | `migrationV3.test.ts`（5 条，真实退回 v2 再升级）；`totpFlow.test.ts` 22 条（含恢复码一次性、重生成后旧码作废）；`totpDisabled.test.ts` 5 条（**TOTP 开关**的三条边界）。 |
| 未登录和 viewer 无法访问敏感设置；token 读取默认脱敏 | `auth.test.ts` 的设置接口用例（匿名 401 / viewer 403 / admin 200）；`util.test.ts` 的 redact 套件（容器 env、日志行、自由文本中的 `TOKEN=`/`PASSWORD:`/`Bearer`）；`totpFlow.test.ts` 断言种子/恢复码/`enc:v1:` 不出现在任何响应里。 |
| CSP 不阻断 HomePort JS/CSS、SSE、登录与现有 Serve 路由；安全头遵循代理场景，不误将内网 HTTP 标为 HSTS | `securityHeaders.test.ts`（HTTP 下**不**下发 HSTS、无 `includeSubDomains`、SSE 仍为 `text/event-stream` 且带安全头）；E2E `security-headers.spec.ts`（CSP 指令齐备、无 CSP 违规、前端产物正常挂载）；E2E 冒烟里依赖 SSE 的系统页正常渲染。 |
| Docker 代理模式下能读取必要资源，写接口不可用；默认原部署兼容 | `composeHardening.test.ts`（12 条静态断言）+ §2.5 的本机实测（读接口 200 / 未放行读接口 403 / POST、DELETE 403，真实门户经代理可 list+inspect+logs）+ `docker compose config` 对默认 compose 校验通过（exit 0），证明默认部署未被破坏。 |

---

## 7. 丢失验证器设备的处置（含唯一管理员）

1. **普通用户**：管理员在「账号管理 → 用户」里点「重置两步验证」。效果：清空种子与恢复码 + **吊销该用户全部会话**（用户需重新登录并重新绑定），审计记录到管理员头上。
2. **唯一管理员自己丢了设备**（无法从界面操作时）：停容器 → 用 SQLite 工具直接清掉该用户的 TOTP 状态 → 起容器：

   ```sql
   UPDATE users
      SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL, totp_last_counter = NULL
    WHERE username = 'admin';
   DELETE FROM totp_recovery_codes WHERE user_id = (SELECT id FROM users WHERE username = 'admin');
   DELETE FROM totp_challenges    WHERE user_id = (SELECT id FROM users WHERE username = 'admin');
   ```

   门户没有为管理员保留任何"绕过两步验证的后门"—— 这是有意的，也正因为如此，这条路必须能手写 SQL 走通，并且**改库前先备份数据卷**。
3. 用户手上的**恢复码**（10 个，一次性）是首选的自我救援路径；登录页第二步直接输入恢复码即可。

---

## 8. 风险与已知限制

| 风险 | 现状 | 缓解 |
| --- | --- | --- |
| 主密钥丢失 → 敏感设置与 TOTP 种子不可解 | 门户仍可启动；密码登录与**恢复码**登录仍可用，不会整体锁死 | 文档要求 `/data/secret.key` 与数据库一起备份；轮换用 `PORTAL_SECRET_KEY_PREVIOUS`；恢复码是密钥丢失后的第一救援路径 |
| `PORTAL_TRUST_PROXY=1` 会让伪造 XFF 生效 | 非默认，需显式开启 | 文档标注为"危险"；默认 `loopback` 已在测试中验证拒绝伪造头 |
| CSP 可能挡住将来引入的外部资源 | 目前前端产物全部自源 | `PORTAL_CSP` 可覆盖；E2E 已断言"无 CSP 违规" |
| `read_only: true` 根文件系统**未默认开启** | 只在 compose 注释里给出开法 | 原因：NAS 上 Docker 版本差异大，`read_only` + 命名卷 + `group_add` 组合行为不一致，收益小于"部署起不来"的风险 |
| 只读 socket 代理是**可选**的（非默认） | 默认仅 `:ro` | `:ro` 挡不住 API 写请求，故提供覆盖文件；NAS 文档建议开启并已实测 |
| 双栈端口去重只做到**容器端口级** | 服务级去重属 Sprint 1（S1-02） | `dedupeIdenticalBindings` 是独立纯函数，扩展点已明确 |
| E2E 不在发布依赖链上 | 发布只依赖 `quality`（typecheck+单测+build） | 文档给出做法：在 `docker-publish.yml` 内**再定义一个 e2e job** 后写 `needs: [quality, e2e]`（`needs` 不能跨工作流引用，只加一行会让工作流报错）；E2E 在 ci.yml 里是必过检查 |
| 前端不知道"服务端是否允许绑定 TOTP" | 未增加能力探测字段（避免临期改契约） | `PORTAL_TOTP_ENABLED=0` 时安全面板仍会显示"启用"按钮，点击后拿到后端中文错误文案（`400 TOTP_UNAVAILABLE`）。自托管场景下开关由管理员控制，可接受；Sprint 1 可在会话接口里加一个服务端能力字段 |
| 登录限流 10 次/分钟/IP 在反代误配时可能误伤 | 依赖 `trustProxy` 正确 | 默认 `loopback` 与本机反代部署匹配；`0` 时为"按 socket IP"，即所有人都算同一个 IP（会误伤） |

---

## 9. 未做项与 Sprint 1 前置条件

**本 Sprint 明确未做**（不属于 S0 范围）：

- 指标留存 / 告警（Sprint 1）：目前仍是无留存的内存采样，`/api/system/stream` 只推实时帧。
- `read_only: true` 根文件系统、socket 代理设为**默认**（需先在 NAS 上跑一轮真实部署验证）。
- 前端 7 处既有小缺陷中，除"401 一律登出"外其余（`client.ts` 的 HEAD 也带 CSRF、200+HTML 解析为 `null`、`format.ts` 的 3599 秒显示为"60 分钟前"等）仍以"现状记录"形式被测试固定，未修改行为。

**建议进入 Sprint 1 前人工确认**：

1. 是否接受 `PORTAL_TRUST_PROXY` 默认 `loopback`（本机 `tailscale serve` 部署的标准配置）。
2. 是否把只读 socket 代理设为 NAS 的**推荐/默认**部署方式（本 Sprint 只提供可选覆盖文件并已实测）。
3. 是否同意 E2E 暂不作为发布前置（当前发布门 = typecheck + 单测 + build）。
4. 是否要在 Sprint 1 一并清掉前端那 6 处既有小缺陷（会让 `web/tests` 里若干"现状记录"断言反转）。