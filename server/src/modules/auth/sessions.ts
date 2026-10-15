/**
 * 会话仓储：sessions 表的全部读写。
 *
 * 安全模型：
 * - 会话令牌（`hp_session` Cookie）= 32 字节随机值，DB 只存 SHA-256 摘要。
 * - CSRF 令牌独立生成，随会话行存储，并通过独立 Cookie + API 响应双通道下发。
 */
import type { Db } from '../../db/database.js';
import { mapSessionRow, type Session, type SessionRow } from '../../db/types.js';
import { hashToken, randomToken } from './crypto.js';

export interface CreateSessionInput {
  userId: number;
  ttlHours: number;
  userAgent?: string | null;
  remoteAddr?: string | null;
}

export interface CreatedSession {
  /** 明文令牌：只在此刻返回一次，之后无法从 DB 取回 */
  token: string;
  session: Session;
}

export class SessionsRepository {
  constructor(private readonly db: Db) {}

  /** 创建会话，返回明文令牌与记录。 */
  create(input: CreateSessionInput): CreatedSession {
    const token = randomToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + input.ttlHours * 3600 * 1000);
    const id = randomToken(12);
    this.db
      .prepare(
        `INSERT INTO sessions (id, token_hash, csrf_token, user_id, created_at, expires_at, last_seen_at, user_agent, remote_addr, revoked_at)
         VALUES (@id, @tokenHash, @csrfToken, @userId, @createdAt, @expiresAt, @lastSeenAt, @userAgent, @remoteAddr, NULL)`,
      )
      .run({
        id,
        tokenHash: hashToken(token),
        csrfToken: randomToken(24),
        userId: input.userId,
        createdAt: now.toISOString(),
        expiresAt: expiresAt.toISOString(),
        lastSeenAt: now.toISOString(),
        userAgent: input.userAgent ?? null,
        remoteAddr: input.remoteAddr ?? null,
      });
    const session = this.findById(id);
    if (!session) throw new Error('创建会话后无法读回该会话');
    return { token, session };
  }

  findById(id: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    return row ? mapSessionRow(row) : null;
  }

  /**
   * 按明文令牌查找**有效**会话（未撤销且未过期）。
   *
   * @returns 有效会话；不存在/已撤销/已过期返回 null
   */
  findValidByToken(token: string): Session | null {
    const row = this.db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hashToken(token)) as
      | SessionRow
      | undefined;
    if (!row) return null;
    if (row.revoked_at !== null) return null;
    if (Date.parse(row.expires_at) <= Date.now()) return null;
    return mapSessionRow(row);
  }

  /**
   * 刷新最后活跃时间。为降低写放大，仅当距上次记录超过 `minIntervalMs` 才写库。
   *
   * @returns 是否实际写入
   */
  touch(id: string, minIntervalMs = 60_000): boolean {
    const row = this.db.prepare('SELECT last_seen_at FROM sessions WHERE id = ?').get(id) as
      | { last_seen_at: string }
      | undefined;
    if (!row) return false;
    if (Date.now() - Date.parse(row.last_seen_at) < minIntervalMs) return false;
    this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(new Date().toISOString(), id);
    return true;
  }

  /** 延长会话有效期（滑动续期）。 */
  extend(id: string, ttlHours: number): void {
    const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
    this.db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(expiresAt, id);
  }

  /** 撤销单个会话。 */
  revoke(id: string): boolean {
    const info = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), id);
    return info.changes > 0;
  }

  /** 撤销某用户的全部会话，返回撤销条数。 */
  revokeAllForUser(userId: number): number {
    const info = this.db
      .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), userId);
    return info.changes;
  }

  /**
   * 取消撤销单个会话（`revoked_at` 置空）。
   *
   * 用途：改密时「吊销全部会话但保留当前会话」—— 先整体吊销再恢复当前会话，
   * 比逐个排除的 SQL 更简单且不易出错。
   */
  unrevoke(id: string): boolean {
    const info = this.db.prepare('UPDATE sessions SET revoked_at = NULL WHERE id = ?').run(id);
    return info.changes > 0;
  }

  /** 清理已过期或已撤销超过 `keepRevokedHours` 小时的会话。 */
  purge(keepRevokedHours = 24): number {
    const cutoff = new Date(Date.now() - keepRevokedHours * 3600 * 1000).toISOString();
    const info = this.db
      .prepare('DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)')
      .run(new Date().toISOString(), cutoff);
    return info.changes;
  }

  /** 某用户当前有效会话数。 */
  countActiveForUser(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM sessions WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?')
      .get(userId, new Date().toISOString()) as { c: number } | undefined;
    return row?.c ?? 0;
  }
}
