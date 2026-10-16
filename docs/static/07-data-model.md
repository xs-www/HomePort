# 07 · 数据模型

> 单文件 SQLite（`<dataDir>/portal.sqlite`）。选型理由：门户写入频率极低
> （登录、偏好、审计），同步驱动省去连接池与事务编排，单文件便于 NAS 备份。

## 1. 连接参数

`openDatabase()` 设置的 PRAGMA：

| PRAGMA | 值 | 原因 |
| --- | --- | --- |
| `journal_mode` | `WAL`（内存库为 `MEMORY`） | 读写并发更好，崩溃恢复更稳 |
| `foreign_keys` | `ON` | 让删除用户时级联清理会话、偏好与 TOTP 恢复码/挑战 |
| `busy_timeout` | `5000` | 避免瞬时锁冲突直接报错 |
| `synchronous` | `NORMAL` | WAL 下的性能/安全平衡点 |

## 2. 表结构

### `schema_migrations`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `version` | INTEGER PK | 迁移版本号 |
| `name` | TEXT NOT NULL | 迁移名 |
| `applied_at` | TEXT NOT NULL | 应用时间（ISO） |

### `users`

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK AUTOINCREMENT | — |
| `username` | TEXT | NOT NULL | 原始大小写，用于展示 |
| `username_ci` | TEXT | NOT NULL | **小写**，唯一索引列 |
| `display_name` | TEXT | NOT NULL | 展示名 |
| `role` | TEXT | NOT NULL CHECK IN ('admin','viewer') | 角色 |
| `password_hash` | TEXT | NOT NULL | bcrypt |
| `disabled` | INTEGER | NOT NULL DEFAULT 0 | 0/1 |
| `created_at` | TEXT | NOT NULL | ISO |
| `updated_at` | TEXT | NOT NULL | ISO |
| `last_login_at` | TEXT | NULL | ISO |
| `totp_secret` | TEXT | NULL | TOTP 种子**密文**（`enc:v1:…`，AES-256-GCM，迁移 v3）；未开始绑定为 NULL |
| `totp_enabled` | INTEGER | NOT NULL DEFAULT 0 | 0/1，**已完成绑定**才为 1 |
| `totp_confirmed_at` | TEXT | NULL | 绑定确认时间（ISO），前端显示为"启用时间" |
| `totp_last_counter` | INTEGER | NULL | 最后成功使用的 TOTP 时间步，用于防重放 |

索引：`UNIQUE idx_users_username_ci(username_ci)`

> 为什么要 `username_ci` 冗余列：SQLite 的 `COLLATE NOCASE` 只对 ASCII 生效，
> 且无法在表达式上建唯一索引。显式维护小写列更可靠。
> **不变量**：`username_ci === username.trim().toLowerCase()`，由 `UsersRepository` 保证。

> **`totp_enabled` 与"有种子"是两件事**：`POST /api/users/me/totp/setup` 会先写入一个
> **未确认**的种子（`totp_secret` 非空、`totp_enabled = 0`、`totp_confirmed_at = NULL`），
> 只有用户用验证器 App 回填一次验证码后才置 1 —— 否则"扫了码但没输码"就会把人锁在门外
> （`UsersRepository.setPendingTotpSecret()` / `enableTotp()`，`server/src/db/users.ts`）。
> 关闭两步验证或管理员强制重置会把这三列一并清空（`disableTotp()`）。
> 中间态也是"重复 setup 会作废旧种子"的实现基础：重新 setup 只是再写一次 `totp_secret`。
>
> **`totp_last_counter` 只在登录路径写**：绑定确认时刻意**不**记录 —— 绑定用的那个码只是
> "证明 App 配好了"，若记下来，用户绑定完立刻登出再登录（同一个 30 秒窗口内）就会被判重放
> 而登录失败（`enableTotp()` 里的注释，`server/src/modules/auth/service.ts`）。

### `sessions`

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | 内部 ID（随机），**不是**会话令牌 |
| `token_hash` | TEXT | NOT NULL | 会话令牌的 SHA-256 |
| `csrf_token` | TEXT | NOT NULL | CSRF 令牌明文（需比对，故不哈希） |
| `user_id` | INTEGER | NOT NULL REFERENCES users(id) ON DELETE CASCADE | — |
| `created_at` / `expires_at` / `last_seen_at` | TEXT | NOT NULL | ISO |
| `user_agent` | TEXT | NULL | 诊断用 |
| `remote_addr` | TEXT | NULL | 诊断用 |
| `revoked_at` | TEXT | NULL | 非空表示已撤销 |

索引：`UNIQUE idx_sessions_token(token_hash)`、`idx_sessions_user(user_id)`、`idx_sessions_expires(expires_at)`

### `user_preferences`

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `user_id` | INTEGER | PK REFERENCES users(id) ON DELETE CASCADE | — |
| `theme` | TEXT | NOT NULL DEFAULT 'dark' | `dark`/`light`/`system` |
| `density` | TEXT | NOT NULL DEFAULT 'comfortable' | `comfortable`/`compact` |
| `default_page` | TEXT | NOT NULL DEFAULT 'overview' | 默认落地页 |
| `updated_at` | TEXT | NOT NULL | ISO |

### `settings`（迁移 v2）

运行时设置的数据库覆盖层。**只存被显式覆盖过的键**，未覆盖的走环境变量或内置默认。

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `key` | TEXT PK | 稳定键名，**等于环境变量名**（如 `PORTAL_TAILSCALE_API_TOKEN`） |
| `value` | TEXT NOT NULL | 统一以字符串存储（布尔存 `'1'`/`'0'`），解析由 `settings/registry.ts` 负责。**标记为 `sensitive` 的键存 `enc:v1:<base64(iv\|tag\|cipher)>` 密文**（AES-256-GCM） |
| `updated_at` | TEXT NOT NULL | ISO 时间，同时用作"设置版本"的一部分 |
| `updated_by` | TEXT NULL | 最后修改者的用户名 |

**为什么值统一存字符串**：表结构不需要随配置项增减而迁移，
新增一个设置项只是往 `buildSettingDefinitions()` 里加一条记录。

**为什么用 `key = 环境变量名`**：界面上能直接显示对应的 `.env` 变量名，
排查时"界面改的"与"环境变量配的"一眼可对应。

> 敏感值（如 API Token）在数据库里是**密文**：注册表标了 `sensitive` 的键由
> `settings/secretStore.ts` 在**写库前加密、读出后解密**（AES-256-GCM，格式 `enc:v1:…`），
> 服务内部回读到的仍是明文，因此照常能去调用外部 API。
> 主密钥来自 `PORTAL_SECRET_KEY` 或 `<dataDir>/secret.key`（0600，缺失时自动生成）。
> **无 `enc:v1:` 前缀 = 迁移前的旧明文**，照样能读，并在下次写入时自动升级（首启还有
> 一次性 `reencryptAll()`）。界面读取一律打码，审计与日志只记键名。见 `06-security.md` §7。

### `audit_log`

| 列 | 类型 | 说明 |
| --- | --- | --- |
| `id` | INTEGER PK AUTOINCREMENT | — |
| `at` | TEXT NOT NULL | ISO |
| `actor_id` | INTEGER NULL | 执行者；系统动作可空 |
| `actor_name` | TEXT NULL | 冗余用户名（用户被删后仍可追溯） |
| `action` | TEXT NOT NULL | 见下表 |
| `target` | TEXT NULL | 如 `user:3` 或 `settings` |
| `detail` | TEXT NULL | 人类可读描述 |
| `ip` | TEXT NULL | 来源 IP |

索引：`idx_audit_at(at)`。保留 90 天（定时清理）。

**已记录的动作**

| action | 触发点 |
| --- | --- |
| `auth.bootstrap` | 首启创建管理员 |
| `auth.login` / `auth.login_failed` | 登录成功/失败 |
| `auth.logout` | 登出 |
| `auth.password_changed` | 用户自助改密 |
| `auth.totp_setup_started` | 开始绑定两步验证（生成待确认的种子） |
| `auth.totp_enabled` / `auth.totp_disabled` | 绑定确认 / 用户主动关闭（`detail` 记恢复码张数） |
| `auth.totp_failed` | 登录第二步验证码或恢复码错误（`detail` 附失败原因 `malformed`/`mismatch`/`replayed`） |
| `auth.totp_recovery_used` | 用恢复码完成登录（`detail` 记剩余可用个数） |
| `auth.totp_recovery_regenerated` | 重新生成恢复码（旧码作废） |
| `auth.totp_reset` | 管理员强制重置某用户的两步验证 |
| `user.create` / `user.update` / `user.delete` | 账号增删改 |
| `user.password_reset` | 管理员重置密码 |
| `user.sessions_revoked` | 强制下线 |
| `settings.update` | 界面修改运行时设置（**敏感项只记键名，不记值**） |
| `settings.reset` | 恢复设置为默认值 |

> TOTP 相关动作的 `detail` 只记张数、剩余数与失败原因，**不记录任何码值、种子或恢复码**。

### `totp_recovery_codes`（迁移 v3）

恢复码按批生成 10 条（`RECOVERY_CODE_COUNT`，`server/src/modules/auth/totp.ts`），
重新生成时整批替换、旧码立即失效。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK AUTOINCREMENT | — |
| `user_id` | INTEGER | NOT NULL REFERENCES users(id) ON DELETE CASCADE | 删用户即级联清理 |
| `code_hash` | TEXT | NOT NULL | 恢复码的 **sha256 十六进制摘要**，不存明文 |
| `created_at` | TEXT | NOT NULL | ISO |
| `used_at` | TEXT | NULL | 非空表示已核销，不可复用 |

索引：`idx_totp_recovery_user(user_id)`

> **为什么用不带盐的 sha256 而不是 bcrypt**：恢复码是 8 位随机字符（约 40 bit 熵），
> 足以抵抗离线爆破；而加盐会让"按摘要直接查表核销"退化成全表扫描 ——
> 与密码（必须 bcrypt）的取舍不同（`hashRecoveryCode()`，`modules/auth/totp.ts`）。
> 核销是**原子 UPDATE**（`WHERE code_hash = ? AND used_at IS NULL`），
> 所以同一个码并发提交只会成功一次（`RecoveryCodesRepository.consume()`，`db/totp.ts`）。
> 写入时按 `user_id` **整体替换**（含已用过的行），因此"还剩几个可用"要靠
> `countUnused()` 现算。关闭两步验证、管理员强制重置都会清空这张表。

### `totp_challenges`（迁移 v3）

登录第二步的一次性凭据。**明文令牌只出现在 `POST /api/auth/login` 的成功响应里**
（客户端随后交给 `POST /api/auth/login/totp`），库里只有摘要。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | 内部 ID（形如 `c-<随机 hex>`），**不是**挑战令牌 |
| `token_hash` | TEXT | NOT NULL | 挑战令牌的 sha256 摘要 |
| `user_id` | INTEGER | NOT NULL REFERENCES users(id) ON DELETE CASCADE | — |
| `created_at` / `expires_at` | TEXT | NOT NULL | ISO；`expires_at` 由 `PORTAL_TOTP_CHALLENGE_TTL_SECONDS` 决定 |
| `consumed_at` | TEXT | NULL | 非空表示已消费，防同一个挑战被复用 |
| `attempts` | INTEGER | NOT NULL DEFAULT 0 | 失败尝试计数 |

索引：`UNIQUE idx_totp_challenges_token(token_hash)`、`idx_totp_challenges_expires(expires_at)`

> **`attempts` 达到 5 即作废**：`TOTP_CHALLENGE_MAX_ATTEMPTS = 5`（`server/src/db/totp.ts`），
> `findValidByToken()` 的查询条件里带 `attempts < 5`，因此超限后挑战直接"查不到"，
> 登录第二步返回 `TOTP_CHALLENGE_EXPIRED`（前端须退回第一步）。
> 这挡的是"拿到密码的人"对 6 位码的暴力尝试；真正的第一道防线是
> `/api/auth/login` 与 `/api/auth/login/totp` 的**共用**限流（10 次/分钟/IP）。
>
> **清理**：`AuthService.purgeExpiredTotpState()` 由 `server/src/app.ts` 的定时器调用，
> 删除已过期、或已消费超过 24 小时的挑战（`TotpChallengesRepository.purgeExpired(24)`）。

### `services`（迁移 v4）

服务注册表的主表：**一行 = 用户看到的一个「服务」**（家庭日历 / Gitea / WorldForge…）。
这是本项目里唯一一处"用户可写"的数据（除账号与设置外），因此写入纪律写得最细。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | `crypto.randomUUID()`；**与容器 ID 无关** |
| `slug` | TEXT | NOT NULL UNIQUE | 稳定可读键（`[a-z0-9-]`），冲突时由 `ServicesRepository.uniqueSlug()` 追加 `-2`、`-3` |
| `display_name` | TEXT | NOT NULL | 展示名（自动派生或用户改写） |
| `description` / `icon` / `category` | TEXT | NULL | 展示属性；`icon` = 内置图标键或 `https://` URL |
| `preferred_url` | TEXT | NULL | **用户指定并验证过**的首选入口，入口优先级最高（rank 0） |
| `source_type` | TEXT | NOT NULL | `docker` / `serve` / `manual` |
| `source_ref` | TEXT | NOT NULL，`UNIQUE(source_type, source_ref)` | **稳定来源标识，不含容器 ID**（见下） |
| `binding_refs` | TEXT | NOT NULL DEFAULT `'[]'` | JSON 数组：稳定绑定标识（本仓唯一的 JSON 列） |
| `visibility` | TEXT | NOT NULL DEFAULT `'visible'` | `visible` / `hidden` |
| `sort_order` | INTEGER | NOT NULL DEFAULT 100 | 越小越靠前 |
| `favorite` | INTEGER | NOT NULL DEFAULT 0 | 0/1 |
| `health_target` / `health_path` | TEXT | NULL | 可选的健康探测目标（**显式配置才探测**） |
| `user_edited` | INTEGER | NOT NULL DEFAULT 0 | 1 = 用户改过展示属性，**自动发现不得覆盖** |
| `created_at` / `updated_at` | TEXT | NOT NULL | ISO |
| `updated_by` | TEXT | NULL | 最后修改者用户名（审计线索） |

索引：`idx_services_sort(visibility, sort_order, display_name)`、`idx_services_source(source_type, source_ref)`

> **为什么身份不认容器 ID**：容器被 `docker compose up -d` 重建后 ID 一定变，
> 而 Compose 项目/服务名与容器名不变。因此 `source_ref` 取
> `docker:<composeProject>/<composeService>`，没有 Compose 标签时退化为
> `docker:<规范化容器名>`（去掉 `-1`/`_2` 这类副本后缀）；serve 路由取
> `serve:<host>:<port><path>`。容器 ID 只出现在 `service_bindings` 里，作为"当前关联"的快照。
> 这条规则直接支撑验收用例「容器重建更换 ID 后关联仍可恢复」。
>
> **自动发现与用户配置的边界**：`ServicesRepository.updateUserFields()` 是唯一能改展示属性的入口，
> 且必然置 `user_edited = 1`；发现走 `upsertDiscovered()`，其 SQL 用
> `CASE WHEN user_edited = 0 THEN ? ELSE 列名 END` 保证不覆盖用户值。
> 想把某个服务交还给自动层，只有显式「重置为自动」（`clearUserOverrides()`）。

### `service_bindings`（迁移 v4）

发现结果的**快照**（可丢可重算），用于展示归属与诊断，**不参与服务身份**。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | INTEGER | PK AUTOINCREMENT | — |
| `service_id` | TEXT | NOT NULL REFERENCES services(id) ON DELETE CASCADE | — |
| `kind` | TEXT | NOT NULL | `container` / `serve` |
| `ref` | TEXT | NOT NULL，`UNIQUE(service_id, kind, ref)` | 稳定绑定标识 |
| `container_id` | TEXT | NULL | **当前**容器 ID（会变，仅作关联线索） |
| `container_name` / `compose_project` / `compose_service` | TEXT | NULL | 用于容器重建后重新找回关联 |
| `scheme` / `host` / `port` / `path` / `url` | — | NULL | 入口原始信息（serve 路由用） |
| `reachability` / `accessible` / `rank` | — | — | 判定结果快照（rank 见 03 文档的入口优先级） |
| `created_at` / `updated_at` | TEXT | NOT NULL | ISO |

索引：`idx_service_bindings_service(service_id)`

> 每次发现对该服务的绑定**整体替换**（单事务：`DELETE` + 批量 `INSERT`），
> 所以这张表永远不会"越攒越脏"。候选入口、可达性、容器运行态、健康结果一律**实时计算**，
> 不落库 —— 落库就会变成"缓存住的谎话"（例如容器已经停了，界面还显示可达）。

### `service_preferences`（迁移 v4）

单例偏好 KV（视图模式、折叠的分类等），**不含任何权限敏感内容**。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `key` | TEXT | PK | 偏好键 |
| `value` | TEXT | NOT NULL | 值（统一 TEXT，避免为加一项就迁移） |
| `updated_at` | TEXT | NOT NULL | ISO |

### `metric_buckets`（迁移 v5）

历史指标桶。**一行 = 一个时间桶内一条序列的聚合结果**（不是原始样本）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUID |
| `resolution` | TEXT | NOT NULL | `minute` / `hour` |
| `metric` | TEXT | NOT NULL | 指标键，如 `host.cpu.percent`、`host.disk.used_bytes` |
| `target` | TEXT | NOT NULL | **稳定身份**：`host` / `disk:<label>` / `container:<sourceRef>` / `service:<sourceRef>` |
| `target_label` | TEXT | NOT NULL | 展示名（随最新一桶更新：服务改名后曲线仍连续） |
| `unit` | TEXT | NOT NULL | `percent` / `bytes` / `ratio`（**与 `metric` 一起决定图表纵轴单位**） |
| `bucket_at` | INTEGER | NOT NULL | 桶起点 unix 秒（`floor(now/60)*60` 或 `floor(now/3600)*3600`） |
| `value` | REAL | NOT NULL | 均值 |
| `min_value` | REAL | NOT NULL | 桶内最小值（服务健康这类 0/1 序列靠它看抖动） |
| `max_value` | REAL | NOT NULL | 桶内最大值 |
| `samples` | INTEGER | NOT NULL | 桶内实际样本数 |
| `expected` | INTEGER | NOT NULL | 应有样本数（minute：`max(1, round(60/采样间隔))`；hour：`60`） |
| `created_at` | TEXT | NOT NULL | ISO |

约束与索引：

- `UNIQUE (resolution, metric, target, bucket_at)` —— 幂等重写的依据
  （`INSERT … ON CONFLICT DO UPDATE`），同一分钟重复 flush 不会产生重复行。
- `idx_metric_buckets_series (resolution, metric, target, bucket_at)` —— 曲线查询。
- `idx_metric_buckets_retention (resolution, bucket_at)` —— 保留清理按分辨率+时间扫。

> **两条必须记住的语义**（图上直接可见）：
> 1. **缺测没有行，绝不写 0**：某个分钟没采到样本，就是**没有这一行** ——
>    图表在时间轴上断开，而不是画一条 0 的平线（写 0 会把"没数据"伪装成"CPU 真的是 0%"）。
> 2. `samples < expected` 才是"这桶有数据但缺了一部分"（`partial`），
>    两个数都必须落库，否则事后无法区分"没采"与"采到了 0"。
>
> `target` **刻意不含容器 ID**：容器重建后 `sourceRef` 不变，历史曲线因此连续；
> 用容器 ID 会让每次重建都断成两条线。

### `alert_rules`（迁移 v5）

告警规则。内置四条由 `AlertsService.ensureBuiltinRules()` 在**装配期幂等补齐**
（迁移只建结构、不塞业务数据）。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | 如 `rule-disk-percent`（内置规则用稳定 ID） |
| `kind` | TEXT | NOT NULL | `disk_percent` / `memory_percent` / `container_exit` / `service_health` |
| `name` | TEXT | NOT NULL | 展示名 |
| `description` | TEXT | NOT NULL DEFAULT `''` | 说明 |
| `enabled` | INTEGER | NOT NULL DEFAULT `0` | **默认关闭**：装了但不吵，由管理员显式开启 |
| `threshold` | REAL | 可 NULL | 阈值（`container_exit` 用不到） |
| `duration_sec` | INTEGER | NOT NULL DEFAULT `0` | 条件**需持续**多久才算数（0 = 立即） |
| `target` | TEXT | 可 NULL | 限定目标；NULL = 适用于该 kind 的全部目标 |
| `silence_sec` | INTEGER | NOT NULL DEFAULT `3600` | 静默周期：多久内不重复刷屏 |
| `notify_recovery` | INTEGER | NOT NULL DEFAULT `1` | 是否发恢复通知 |
| `severity` | TEXT | NOT NULL DEFAULT `warning` | `warning` / `critical` |
| `builtin` | INTEGER | NOT NULL DEFAULT `1` | 是否内置（内置规则不可删除） |
| `updated_at` / `created_at` | TEXT | NOT NULL | ISO |

### `alert_events`（迁移 v5）

告警**事件（episode 模型）**：一次故障一行，不是"每次判定一行"。

| 列 | 类型 | 约束 | 说明 |
| --- | --- | --- | --- |
| `id` | TEXT | PK | UUID |
| `rule_id` | TEXT | NOT NULL, FK → `alert_rules(id)` **ON DELETE CASCADE** | 规则删除即级联清理事件 |
| `kind` / `rule_name` / `severity` | TEXT | NOT NULL | **快照**规则信息：规则改了名/被删，历史事件仍能如实显示当时的样子 |
| `target` / `target_label` | TEXT | NOT NULL | 目标（`target` 用稳定身份，同 `metric_buckets`） |
| `value` / `threshold` / `unit` | REAL/REAL/TEXT | 可 NULL | 触发时的实测值、阈值、单位 |
| `message` | TEXT | NOT NULL | 人可读文案（含"已持续 N 分钟"；`duration_sec = 0` 时不写这句以免噪声） |
| `started_at` | TEXT | NOT NULL | 条件**开始成立**的时刻（不是发现时刻） |
| `fired_at` | TEXT | NOT NULL | 实际触发时刻（`started_at + duration_sec` 之后） |
| `resolved_at` | TEXT | 可 NULL | **NULL = 未恢复**（"在告警中"的定义） |
| `reopen_count` | INTEGER | NOT NULL DEFAULT `0` | 静默期内重开次数（第 2、3 次…） |
| `acknowledged_at` / `acknowledged_by` | TEXT | 可 NULL | 确认（ack）只表示"人已看到"，**不改变判定**；重开时清空 |
| `created_at` | TEXT | NOT NULL | ISO |

约束与索引：

- **`UNIQUE INDEX idx_alert_events_open (rule_id, target) WHERE resolved_at IS NULL`**
  —— 本次设计的核心不变量：**同一规则同一目标最多只有一行未恢复**。
  "一小时内不重复刷屏"与"进程重启后不重复通知"都靠它兜底，而不是靠引擎代码自觉：
  引擎写入前先查未恢复行，有就只把同一行 `reopen_count + 1`。
  （部分索引：SQLite 支持 `WHERE` 子句，因此"已恢复"的历史行不受此约束，可以有很多条。）
- `idx_alert_events_recent (fired_at DESC)` —— 事件列表按触发时间倒序。

> **为什么快照 `kind` / `rule_name` / `severity`**：规则是可改可删的，而事件是历史事实。
> 若事件只存 `rule_id`，删掉规则后（`ON DELETE CASCADE`）或改了名之后，
> 历史事件会显示成"现在"的样子 —— 那是篡改历史。

## 3. 迁移

`MIGRATIONS`（`src/db/database.ts`）当前有**五项**：

| version | name | 内容 |
| --- | --- | --- |
| 1 | `initial_auth_schema` | 用户 / 会话 / 偏好 / 审计 四张表与全部索引 |
| 2 | `runtime_settings` | `settings` 表（运行时设置覆盖层） |
| 3 | `totp_two_factor` | `users` 新增 `totp_secret` / `totp_enabled` / `totp_confirmed_at` / `totp_last_counter`；新建 `totp_recovery_codes` / `totp_challenges` 两张表与索引 |
| 4 | `services_registry` | 新建 `services` / `service_bindings` / `service_preferences` 三张表与两个索引（服务注册表，Sprint 1） |
| 5 | `metrics_alerts_schema` | 新建 `metric_buckets` / `alert_rules` / `alert_events` 三张表、两个指标索引、告警部分唯一索引与最近事件索引（历史监控与告警，Sprint 2）**——只建结构，不塞业务数据；四条内置规则由启动时 `ensureBuiltinRules()` 幂等补齐** |

**迁移规则**

1. **只允许追加**新版本，不允许修改已发布的迁移体
   （改已发布的迁移会让老库与新库结构不一致）。
2. 每个迁移在**独立事务**中执行并写入 `schema_migrations`；
   失败回滚该迁移并抛错，进程启动失败（宁可起不来，也不要半个 schema）。
3. 迁移体写在代码里（不是独立 `.sql` 文件），保证打包进镜像后不丢文件。

**新增迁移的步骤**

```
1. 在 MIGRATIONS 数组末尾追加 { version: N+1, name: '...', up: (db) => { db.exec(`...`) } }
2. 若涉及新表/新列，同步更新 db/types.ts 的 Row 与映射函数
3. 同步更新本文件 §2 与 §3
4. 在 09-changelog.md 记录
```

## 4. 备份与恢复

数据库位于 `homeport-data` 卷的 `/data/portal.sqlite`。

**备份**（推荐用 SQLite 在线备份，避免 WAL 中间态）：

```bash
docker compose exec homeport node -e "
  const D=require('/app/node_modules/better-sqlite3');
  const db=new D('/data/portal.sqlite',{readonly:true});
  db.backup('/data/backup-' + Date.now() + '.sqlite').then(()=>console.log('ok'));
"
docker compose cp homeport:/data/ ./backup/
```

**恢复**：停容器 → 用备份文件替换 `portal.sqlite`（并删除同目录的 `-wal` / `-shm`）→ 启动。

> 直接 `cp portal.sqlite` 在 WAL 模式下可能漏掉未 checkpoint 的事务，
> 因此优先用上面的 `.backup()` 或先 `PRAGMA wal_checkpoint(TRUNCATE)`。

## 5. 容量估算

| 数据 | 增长速度 |
| --- | --- |
| users / user_preferences | 与账号数同阶，可忽略 |
| sessions | 每次登录一行；每小时清理过期与 24h 前的已撤销项 |
| totp_recovery_codes | 每用户 10 行；重新生成时整批替换，关闭两步验证即清空 |
| totp_challenges | 每次"密码正确但需要第二步"的登录一行；过期或消费超 24h 即清理 |
| audit_log | 每次登录/登出/管理操作一行；按 90 天清理。日活 10 次操作 ≈ 数千行/年 |
| metric_buckets（minute） | ≈36 行/分钟（基准：宿主 3 + 磁盘 6 + 容器 10×2 + 服务 7）→ 约 51,840 行/天；**只保留 24h，稳态不累积**（≈10–12 MB） |
| metric_buckets（hour） | 864 行/天；保留 30 天（≈5–6 MB） |
| alert_rules | 固定 4 条内置（+人工新增），可忽略 |
| alert_events | 每次**故障（episode）**一行，不是每次判定一行；静默期内重开只 `reopen_count+1`。按 90 天清理。正常家庭环境 ≈ 每年几十行 |

既有数据实际长期稳定在几百 KB 量级，NAS 上无需担心。

**Sprint 2 之后的总量**：历史指标成为唯一有意义的增长项，但 **minute 分辨率 24h 后即被清理，
稳态总量 ≤ 32 MB**（含索引与空闲页；每行约 200 B，见 `docs/sprint2-implementation-spec.md` §1.1）。

> **判断"有没有泄漏"只看一条**：`minute` 行数**不应随运行时长增长**（保留窗口滚动）。
> 若它持续单调上升，说明保留清理没生效 —— 那不是"数据多"，是真 bug。
> 用 `GET /api/metrics/storage` 可随时核对行数、`page_count × page_size` 与按当前速率外推的日增。
