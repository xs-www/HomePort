/**
 * 用户仓储：users 表的全部读写。
 *
 * 不变量（由本模块保证，调用方无需重复检查）：
 * 1. `username_ci` 始终等于 `username.toLowerCase()`，保证唯一性索引有效。
 * 2. 系统内**始终至少存在一个启用状态的 admin**（由 service 层在删改前校验）。
 */
import type { Db } from './database.js';
import {
  DEFAULT_PREFERENCES,
  mapPreferenceRow,
  mapUserRow,
  mapUserWithSecret,
  normalizeRole,
  usernameCi,
  type PreferenceRow,
  type User,
  type UserPreferences,
  type UserRole,
  type UserRow,
  type UserWithSecret,
} from './types.js';

export interface CreateUserInput {
  username: string;
  displayName: string;
  role: UserRole;
  passwordHash: string;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: UserRole;
  disabled?: boolean;
}

export class UsersRepository {
  constructor(private readonly db: Db) {}

  /** 用户总数（用于 bootstrap 判定）。 */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** 启用状态的 admin 数量（用于「最后一个 admin」保护）。 */
  countActiveAdmins(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin' AND disabled = 0")
      .get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  findById(id: number): User | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? mapUserRow(row) : null;
  }

  findWithSecretById(id: number): UserWithSecret | null {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? mapUserWithSecret(row) : null;
  }

  /** 按用户名（大小写不敏感）查找，返回含密码哈希的模型。 */
  findWithSecretByUsername(username: string): UserWithSecret | null {
    const row = this.db
      .prepare('SELECT * FROM users WHERE username_ci = ?')
      .get(usernameCi(username)) as UserRow | undefined;
    return row ? mapUserWithSecret(row) : null;
  }

  /** 列出全部用户（按创建时间升序）。 */
  list(): User[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY created_at ASC, id ASC').all() as UserRow[];
    return rows.map(mapUserRow);
  }

  /** 是否存在同名用户（大小写不敏感）。 */
  usernameExists(username: string, excludeId?: number): boolean {
    const row = excludeId === undefined
      ? (this.db.prepare('SELECT id FROM users WHERE username_ci = ?').get(usernameCi(username)) as { id: number } | undefined)
      : (this.db.prepare('SELECT id FROM users WHERE username_ci = ? AND id <> ?').get(usernameCi(username), excludeId) as
          | { id: number }
          | undefined);
    return row !== undefined;
  }

  /** 创建用户，返回新用户。用户名冲突时抛 SQLITE_CONSTRAINT。 */
  create(input: CreateUserInput): User {
    const now = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO users (username, username_ci, display_name, role, password_hash, disabled, created_at, updated_at)
         VALUES (@username, @usernameCi, @displayName, @role, @passwordHash, 0, @now, @now)`,
      )
      .run({
        username: input.username.trim(),
        usernameCi: usernameCi(input.username),
        displayName: input.displayName.trim(),
        role: input.role,
        passwordHash: input.passwordHash,
        now,
      });
    const created = this.findById(Number(info.lastInsertRowid));
    if (!created) throw new Error('创建用户后无法读回该用户');
    return created;
  }

  /** 部分更新用户；未提供的字段保持不变。返回更新后的用户或 null（不存在）。 */
  update(id: number, input: UpdateUserInput): User | null {
    const existing = this.findById(id);
    if (!existing) return null;
    const nextDisplayName = input.displayName?.trim() ?? existing.displayName;
    const nextRole = input.role ?? existing.role;
    const nextDisabled = input.disabled ?? existing.disabled;
    this.db
      .prepare(
        `UPDATE users
            SET display_name = @displayName,
                role         = @role,
                disabled     = @disabled,
                updated_at   = @updatedAt
          WHERE id = @id`,
      )
      .run({
        id,
        displayName: nextDisplayName,
        role: nextRole,
        disabled: nextDisabled ? 1 : 0,
        updatedAt: new Date().toISOString(),
      });
    return this.findById(id);
  }

  /** 覆盖密码哈希。 */
  updatePassword(id: number, passwordHash: string): boolean {
    const info = this.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?')
      .run(passwordHash, new Date().toISOString(), id);
    return info.changes > 0;
  }

  /** 记录登录成功时间。 */
  touchLastLogin(id: number, at: Date = new Date()): void {
    this.db.prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(
      at.toISOString(),
      at.toISOString(),
      id,
    );
  }

  /**
   * 写入一个**尚未确认**的 TOTP 种子（绑定流程的中间态）。
   *
   * 刻意把 `totp_enabled` 置 0：用户"扫了码但还没回填验证码"时不能算启用，
   * 否则一次失败的绑定操作就能把自己锁在门外。
   */
  setPendingTotpSecret(id: number, encryptedSecret: string): void {
    this.db
      .prepare(
        `UPDATE users
            SET totp_secret = ?, totp_enabled = 0, totp_confirmed_at = NULL, totp_last_counter = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(encryptedSecret, new Date().toISOString(), id);
  }

  /** 确认启用两步验证：写入（或沿用）种子并置 `totp_enabled = 1`。 */
  enableTotp(id: number, encryptedSecret: string, at: Date = new Date()): void {
    this.db
      .prepare(
        `UPDATE users
            SET totp_secret = ?, totp_enabled = 1, totp_confirmed_at = ?, updated_at = ?
          WHERE id = ?`,
      )
      .run(encryptedSecret, at.toISOString(), at.toISOString(), id);
  }

  /** 关闭两步验证：清空种子、确认时间与时间步计数。 */
  disableTotp(id: number): void {
    this.db
      .prepare(
        `UPDATE users
            SET totp_secret = NULL, totp_enabled = 0, totp_confirmed_at = NULL, totp_last_counter = NULL, updated_at = ?
          WHERE id = ?`,
      )
      .run(new Date().toISOString(), id);
  }

  /** 记录最后成功使用的时间步（TOTP 防重放）。 */
  setTotpLastCounter(id: number, counter: number): void {
    this.db.prepare('UPDATE users SET totp_last_counter = ? WHERE id = ?').run(counter, id);
  }

  /** 删除用户（连带会话与偏好，靠外键级联）。返回是否删除成功。 */
  delete(id: number): boolean {
    const info = this.db.prepare('DELETE FROM users WHERE id = ?').run(id);
    return info.changes > 0;
  }
}

export class PreferencesRepository {
  constructor(private readonly db: Db) {}

  /** 读取偏好；不存在时写入默认值后返回。 */
  getOrCreate(userId: number): UserPreferences {
    const row = this.db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as PreferenceRow | undefined;
    if (row) return mapPreferenceRow(row);
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO user_preferences (user_id, theme, density, default_page, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(userId, DEFAULT_PREFERENCES.theme, DEFAULT_PREFERENCES.density, DEFAULT_PREFERENCES.defaultPage, now);
    const created = this.db.prepare('SELECT * FROM user_preferences WHERE user_id = ?').get(userId) as PreferenceRow;
    return mapPreferenceRow(created);
  }

  /** 部分更新偏好。 */
  update(
    userId: number,
    input: Partial<Pick<UserPreferences, 'theme' | 'density' | 'defaultPage'>>,
  ): UserPreferences {
    const current = this.getOrCreate(userId);
    this.db
      .prepare(
        `UPDATE user_preferences
            SET theme = @theme, density = @density, default_page = @defaultPage, updated_at = @updatedAt
          WHERE user_id = @userId`,
      )
      .run({
        userId,
        theme: input.theme ?? current.theme,
        density: input.density ?? current.density,
        defaultPage: input.defaultPage ?? current.defaultPage,
        updatedAt: new Date().toISOString(),
      });
    return this.getOrCreate(userId);
  }
}

export interface AuditInput {
  actorId: number | null;
  actorName: string | null;
  action: string;
  target?: string | null;
  detail?: string | null;
  ip?: string | null;
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  /** 追加一条审计记录。审计写入失败不应影响主流程。 */
  append(input: AuditInput): void {
    this.db
      .prepare(
        `INSERT INTO audit_log (at, actor_id, actor_name, action, target, detail, ip)
         VALUES (@at, @actorId, @actorName, @action, @target, @detail, @ip)`,
      )
      .run({
        at: new Date().toISOString(),
        actorId: input.actorId,
        actorName: input.actorName,
        action: input.action,
        target: input.target ?? null,
        detail: input.detail ?? null,
        ip: input.ip ?? null,
      });
  }

  /** 最近 N 条审计记录（按时间倒序）。 */
  list(limit = 100): import('./types.js').AuditEntry[] {
    const rows = this.db
      .prepare('SELECT * FROM audit_log ORDER BY at DESC, id DESC LIMIT ?')
      .all(limit) as import('./types.js').AuditRow[];
    return rows.map((row) => ({
      id: row.id,
      at: row.at,
      actorId: row.actor_id,
      actorName: row.actor_name,
      action: row.action,
      target: row.target,
      detail: row.detail,
      ip: row.ip,
    }));
  }

  /** 删除早于指定时间的审计记录，返回删除条数。 */
  pruneOlderThan(iso: string): number {
    const info = this.db.prepare('DELETE FROM audit_log WHERE at < ?').run(iso);
    return info.changes;
  }
}

/** 便捷：规范化角色（导出给 service 层复用）。 */
export { normalizeRole };
