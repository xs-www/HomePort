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
