# 07 · 数据模型

> 单文件 SQLite（`<dataDir>/portal.sqlite`）。选型理由：门户写入频率极低
> （登录、偏好、审计），同步驱动省去连接池与事务编排，单文件便于 NAS 备份。

## 1. 连接参数

`openDatabase()` 设置的 PRAGMA：

| PRAGMA | 值 | 原因 |
| --- | --- | --- |
| `journal_mode` | `WAL`（内存库为 `MEMORY`） | 读写并发更好，崩溃恢复更稳 |
| `foreign_keys` | `ON` | 让删除用户时级联清理会话与偏好 |
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

索引：`UNIQUE idx_users_username_ci(username_ci)`

> 为什么要 `username_ci` 冗余列：SQLite 的 `COLLATE NOCASE` 只对 ASCII 生效，
> 且无法在表达式上建唯一索引。显式维护小写列更可靠。
> **不变量**：`username_ci === username.trim().toLowerCase()`，由 `UsersRepository` 保证。

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
| `value` | TEXT NOT NULL | 统一以字符串存储（布尔存 `'1'`/`'0'`），解析由 `settings/registry.ts` 负责 |
| `updated_at` | TEXT NOT NULL | ISO 时间，同时用作"设置版本"的一部分 |
| `updated_by` | TEXT NULL | 最后修改者的用户名 |

**为什么值统一存字符串**：表结构不需要随配置项增减而迁移，
新增一个设置项只是往 `buildSettingDefinitions()` 里加一条记录。

**为什么用 `key = 环境变量名`**：界面上能直接显示对应的 `.env` 变量名，
排查时"界面改的"与"环境变量配的"一眼可对应。

> 敏感值（如 API Token）**以明文存储在数据库中**，与密码哈希不同 ——
> 因为它需要被回读去调用外部 API。数据库文件权限由 Docker 卷管理；
> 界面读取时一律打码，审计日志也只记录键名不记录值。见 `06-security.md` §6。

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
| `user.create` / `user.update` / `user.delete` | 账号增删改 |
| `user.password_reset` | 管理员重置密码 |
| `user.sessions_revoked` | 强制下线 |
| `settings.update` | 界面修改运行时设置（**敏感项只记键名，不记值**） |
| `settings.reset` | 恢复设置为默认值 |

## 3. 迁移

`MIGRATIONS`（`src/db/database.ts`）当前有两项：

| version | name | 内容 |
| --- | --- | --- |
| 1 | `initial_auth_schema` | 用户 / 会话 / 偏好 / 审计 四张表与全部索引 |
| 2 | `runtime_settings` | `settings` 表（运行时设置覆盖层） |

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
| audit_log | 每次登录/登出/管理操作一行；按 90 天清理。日活 10 次操作 ≈ 数千行/年 |

实际长期稳定在几百 KB 量级，NAS 上无需担心。
