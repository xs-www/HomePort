/**
 * SQLite 连接与迁移。
 *
 * 选型：better-sqlite3（同步 API）。理由：门户的写入频率极低（登录、偏好、审计），
 * 同步驱动省去了连接池与事务编排的复杂度，且是单文件持久化，适合 NAS 场景。
 *
 * 迁移策略：迁移体写在代码里（非独立 SQL 文件），打包后不会丢文件；
 * 每个迁移在**独立事务**中执行并记录到 `schema_migrations`。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import type { Logger } from '../logger.js';

export type Db = SqliteDatabase;

export interface Migration {
  /** 递增整数，必须唯一且不可复用 */
  version: number;
  name: string;
  /** 幂等向上的迁移 SQL 或函数 */
  up: (db: Db) => void;
}

/**
 * 全部迁移。**只允许追加**，不允许修改已发布的迁移。
 * 修改已发布迁移会导致老库与新库结构不一致。
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_auth_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          username      TEXT    NOT NULL,
          username_ci   TEXT    NOT NULL,
          display_name  TEXT    NOT NULL,
          role          TEXT    NOT NULL CHECK (role IN ('admin','viewer')),
          password_hash TEXT    NOT NULL,
          disabled      INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT    NOT NULL,
          updated_at    TEXT    NOT NULL,
          last_login_at TEXT
        );
        CREATE UNIQUE INDEX idx_users_username_ci ON users(username_ci);

        CREATE TABLE sessions (
          id            TEXT    PRIMARY KEY,
          token_hash    TEXT    NOT NULL,
          csrf_token    TEXT    NOT NULL,
          user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at    TEXT    NOT NULL,
          expires_at    TEXT    NOT NULL,
          last_seen_at  TEXT    NOT NULL,
          user_agent    TEXT,
          remote_addr   TEXT,
          revoked_at    TEXT
        );
        CREATE UNIQUE INDEX idx_sessions_token ON sessions(token_hash);
        CREATE INDEX idx_sessions_user ON sessions(user_id);
        CREATE INDEX idx_sessions_expires ON sessions(expires_at);

        CREATE TABLE user_preferences (
          user_id   INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          theme     TEXT    NOT NULL DEFAULT 'dark',
          density   TEXT    NOT NULL DEFAULT 'comfortable',
          default_page TEXT NOT NULL DEFAULT 'overview',
          updated_at TEXT   NOT NULL
        );

        CREATE TABLE audit_log (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          at         TEXT    NOT NULL,
          actor_id   INTEGER,
          actor_name TEXT,
          action     TEXT    NOT NULL,
          target     TEXT,
          detail     TEXT,
          ip         TEXT
        );
        CREATE INDEX idx_audit_at ON audit_log(at);
      `);
    },
  },
  {
    version: 2,
    name: 'runtime_settings',
    up: (db) => {
      // 运行时可配置项：管理员在界面里修改的值存这里，优先级高于环境变量。
      // 只存「被显式覆盖过」的键，未覆盖的走环境变量/内置默认（见 settings 模块）。
      db.exec(`
        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          updated_by TEXT
        );
      `);
    },
  },
  {
    version: 3,
    name: 'totp_two_factor',
    up: (db) => {
      // 两步验证（TOTP）。设计要点：
      //
      // 1. `totp_secret` 存的是**密文**（`enc:v1:…`，AES-256-GCM，见 settings/secretBox.ts）。
      //    种子等价于"第二个密码"，明文落库等于把两步验证降级成一步 ——
      //    因此哪怕数据库文件被拷走，没有主密钥也拿不到种子。
      // 2. `totp_enabled` 与 `totp_secret` 分离：setup 阶段会先写入一个**未确认**的种子，
      //    只有用户用验证器 App 成功回填一次验证码后才置 1。
      //    这样"扫了码但没输码"不会把人锁在门外。
      // 3. `totp_last_counter` 记录最后成功使用的时间步，用于**防重放**：
      //    同一个 30 秒窗口内的验证码被二次使用会被拒绝。
      // 4. 恢复码只存 sha256 摘要；用掉一次就记 `used_at`，不可复用。
      // 5. 登录第二步的挑战令牌同样只存摘要，并带 `attempts` 计数，
      //    避免"拿到密码的人"对 6 位验证码做无限次暴力尝试。
      db.exec(`
        ALTER TABLE users ADD COLUMN totp_secret TEXT;
        ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN totp_confirmed_at TEXT;
        ALTER TABLE users ADD COLUMN totp_last_counter INTEGER;

        CREATE TABLE totp_recovery_codes (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          code_hash  TEXT    NOT NULL,
          created_at TEXT    NOT NULL,
          used_at    TEXT
        );
        CREATE INDEX idx_totp_recovery_user ON totp_recovery_codes(user_id);

        CREATE TABLE totp_challenges (
          id          TEXT    PRIMARY KEY,
          token_hash  TEXT    NOT NULL,
          user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at  TEXT    NOT NULL,
          expires_at  TEXT    NOT NULL,
          consumed_at TEXT,
          attempts    INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX idx_totp_challenges_token ON totp_challenges(token_hash);
        CREATE INDEX idx_totp_challenges_expires ON totp_challenges(expires_at);
      `);
    },
  },
  {
    version: 4,
    name: 'services_registry',
    up: (db) => {
      // 服务注册表：把「容器/端口/serve 路由」这层基础设施事实，提升为用户看到的「服务」。
      //
      // 设计要点（对应 Sprint 1 的 S1-01/S1-02/S1-05）：
      //
      // 1. **稳定身份**：`(source_type, source_ref)` 唯一，且 `source_ref` **不含容器 ID**
      //    （用 Compose 项目/服务名或规范化容器名）。容器被重建、ID 变化时仍复用同一行，
      //    用户改过的名称/图标/顺序/收藏因此不会丢。
      // 2. **自动发现不得覆盖用户**：用户改过的展示属性靠 `user_edited` 标记，发现过程只写
      //    自动字段（见 modules/services/registry.ts）。
      // 3. **`service_bindings` 只是快照**：每次发现**重建**，可丢可重算，只用于展示与诊断。
      //    候选入口、可达性、运行态、健康结果一律实时计算，不落库 —— 落库就会变成"缓存住的谎话"。
      // 4. **`service_preferences`** 存单例偏好（视图模式等），不含任何权限敏感内容。
      db.exec(`
        CREATE TABLE services (
          id            TEXT PRIMARY KEY,
          slug          TEXT NOT NULL UNIQUE,
          display_name  TEXT NOT NULL,
          description   TEXT,
          icon          TEXT,
          category      TEXT,
          preferred_url TEXT,
          source_type   TEXT NOT NULL,
          source_ref    TEXT NOT NULL,
          binding_refs  TEXT NOT NULL DEFAULT '[]',
          visibility    TEXT NOT NULL DEFAULT 'visible',
          sort_order    INTEGER NOT NULL DEFAULT 100,
          favorite      INTEGER NOT NULL DEFAULT 0,
          health_target TEXT,
          health_path   TEXT,
          user_edited   INTEGER NOT NULL DEFAULT 0,
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          updated_by    TEXT,
          UNIQUE (source_type, source_ref)
        );

        CREATE TABLE service_bindings (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          service_id      TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
          kind            TEXT NOT NULL,
          ref             TEXT NOT NULL,
          container_id    TEXT,
          container_name  TEXT,
          compose_project TEXT,
          compose_service TEXT,
          scheme          TEXT,
          host            TEXT,
          port            INTEGER,
          path            TEXT,
          url             TEXT,
          reachability    TEXT,
          accessible      INTEGER NOT NULL DEFAULT 0,
          rank            INTEGER NOT NULL DEFAULT 100,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL,
          UNIQUE (service_id, kind, ref)
        );
        CREATE INDEX idx_service_bindings_service ON service_bindings(service_id);

        CREATE TABLE service_preferences (
          key        TEXT PRIMARY KEY,
          value      TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX idx_services_sort ON services(visibility, sort_order, display_name);
        CREATE INDEX idx_services_source ON services(source_type, source_ref);
      `);
    },
  },
  {
    version: 5,
    name: 'metrics_alerts_schema',
    up: (db) => {
      // Sprint 2：轻量历史监控（S2-01/S2-02）与告警（S2-04）的表。
      //
      // 设计要点（对应 docs/sprint2-implementation-spec.md §2）：
      //
      // 1. **缺测绝不写 0**：`metric_buckets` 只存"这一个时间桶里确实有样本"的行。
      //    没有样本的分钟/整点**没有行** —— 图表按时间间隔断开，而不是画一条 0 的平线。
      //    因此 `samples < expected` 是"部分缺测"的唯一信号，两者都必须落库。
      // 2. **一个桶只写一次**：`UNIQUE (resolution, metric, target, bucket_at)` 是
      //    幂等重写（`INSERT … ON CONFLICT DO UPDATE`）的依据，也是不变量的载体 ——
      //    同一分钟内多次刷新不会产生重复行（Sprint 1 的教训：约束比调用方自觉更可靠）。
      // 3. **`target` 用稳定身份**（`host` / `disk:<label>` / `container:<sourceRef>` /
      //    `service:<sourceRef>`），**不含容器 ID**：容器重建后历史曲线仍然连续。
      // 4. **告警用 episode 模型**：一次"故障"一行，恢复写 `resolved_at`，
      //    静默期内再次触发是**重开同一行**而不是插新行。这条不变量的落地方式是
      //    下面的部分唯一索引 `idx_alert_events_open`（同一规则同一目标最多一行未恢复），
      //    而不是靠引擎代码自觉 —— 重启后靠它避免重复通知。
      // 5. `alert_rules.enabled` 默认 0：内置规则"装了但不吵"，由管理员显式开启；
      //    四条内置规则的数据由 `AlertsService.ensureBuiltinRules()` 幂等补齐，
      //    **不放迁移里**（迁移只建结构，不塞业务数据）。
      db.exec(`
        CREATE TABLE metric_buckets (
          id           TEXT PRIMARY KEY,
          resolution   TEXT NOT NULL,
          metric       TEXT NOT NULL,
          target       TEXT NOT NULL,
          target_label TEXT NOT NULL,
          unit         TEXT NOT NULL,
          bucket_at    INTEGER NOT NULL,
          value        REAL NOT NULL,
          min_value    REAL NOT NULL,
          max_value    REAL NOT NULL,
          samples      INTEGER NOT NULL,
          expected     INTEGER NOT NULL,
          created_at   TEXT NOT NULL,
          UNIQUE (resolution, metric, target, bucket_at)
        );
        CREATE INDEX idx_metric_buckets_series ON metric_buckets (resolution, metric, target, bucket_at);
        CREATE INDEX idx_metric_buckets_retention ON metric_buckets (resolution, bucket_at);

        CREATE TABLE alert_rules (
          id              TEXT PRIMARY KEY,
          kind            TEXT NOT NULL,
          name            TEXT NOT NULL,
          description     TEXT NOT NULL DEFAULT '',
          enabled         INTEGER NOT NULL DEFAULT 0,
          threshold       REAL,
          duration_sec    INTEGER NOT NULL DEFAULT 0,
          target          TEXT,
          silence_sec     INTEGER NOT NULL DEFAULT 3600,
          notify_recovery INTEGER NOT NULL DEFAULT 1,
          severity        TEXT NOT NULL DEFAULT 'warning',
          builtin         INTEGER NOT NULL DEFAULT 1,
          updated_at      TEXT NOT NULL,
          created_at      TEXT NOT NULL
        );

        CREATE TABLE alert_events (
          id              TEXT PRIMARY KEY,
          rule_id         TEXT NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
          kind            TEXT NOT NULL,
          rule_name       TEXT NOT NULL,
          target          TEXT NOT NULL,
          target_label    TEXT NOT NULL,
          severity        TEXT NOT NULL,
          value           REAL,
          threshold       REAL,
          unit            TEXT,
          message         TEXT NOT NULL,
          started_at      TEXT NOT NULL,
          fired_at        TEXT NOT NULL,
          resolved_at     TEXT,
          reopen_count    INTEGER NOT NULL DEFAULT 0,
          acknowledged_at TEXT,
          acknowledged_by TEXT,
          created_at      TEXT NOT NULL
        );
        -- 不变量：同一规则同一目标最多一行未恢复（部分唯一索引，见上文要点 4）
        CREATE UNIQUE INDEX idx_alert_events_open ON alert_events (rule_id, target) WHERE resolved_at IS NULL;
        CREATE INDEX idx_alert_events_recent ON alert_events (fired_at DESC);
      `);
    },
  },
];

export interface OpenDbOptions {
  /** 数据库文件路径；`:memory:` 表示内存库 */
  file: string;
  logger?: Logger;
  /** 关闭 WAL（如挂载在不支持 WAL 的共享卷上） */
  disableWal?: boolean;
}

/**
 * 打开数据库并应用连接级 PRAGMA。
 *
 * @returns better-sqlite3 Database 实例（调用方负责 close）
 */
export function openDatabase(options: OpenDbOptions): Db {
  const { file, logger, disableWal = false } = options;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file);
  db.pragma('journal_mode = ' + (disableWal || file === ':memory:' ? 'MEMORY' : 'WAL'));
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  logger?.debug('sqlite 已打开', { file });
  return db;
}

/** 确保迁移记录表存在。 */
function ensureMigrationTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

/** 已应用的迁移版本号集合。 */
export function appliedVersions(db: Db): Set<number> {
  ensureMigrationTable(db);
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as Array<{ version: number }>;
  return new Set(rows.map((r) => r.version));
}

/**
 * 按序应用未执行的迁移。已应用的迁移会被跳过；迁移失败会回滚该迁移自身并抛出。
 *
 * @returns 本次实际应用的迁移版本列表
 */
export function runMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS, logger?: Logger): number[] {
  ensureMigrationTable(db);
  const applied = appliedVersions(db);
  const pending = [...migrations].filter((m) => !applied.has(m.version)).sort((a, b) => a.version - b.version);
  const executed: number[] = [];

  for (const migration of pending) {
    const tx = db.transaction(() => {
      migration.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
    });
    try {
      tx();
      executed.push(migration.version);
      logger?.info('迁移已应用', { version: migration.version, name: migration.name });
    } catch (error) {
      logger?.error('迁移失败', { version: migration.version, name: migration.name, error });
      throw new Error(`迁移 ${migration.version} (${migration.name}) 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return executed;
}

/** 打开 + 迁移，一步到位。 */
export function initDatabase(options: OpenDbOptions): { db: Db; applied: number[] } {
  const db = openDatabase(options);
  const applied = runMigrations(db, MIGRATIONS, options.logger);
  return { db, applied };
}

/** 预编译语句缓存（避免每次调用重新 prepare）。 */
export class StatementCache {
  private readonly cache = new Map<string, Statement>();

  constructor(private readonly db: Db) {}

  /** 取得（并缓存）预编译语句。 */
  get(sql: string): Statement {
    const existing = this.cache.get(sql);
    if (existing) return existing;
    const statement = this.db.prepare(sql);
    this.cache.set(sql, statement);
    return statement;
  }

  /** 清空缓存（schema 变更后调用）。 */
  clear(): void {
    this.cache.clear();
  }
}
