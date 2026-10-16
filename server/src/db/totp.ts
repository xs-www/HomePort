/**
 * TOTP 的两个辅助仓储：恢复码与登录挑战。
 *
 * 为什么单独放一个文件而不是塞进 `db/users.ts`：
 * - 这两张表只服务于两步验证，`users.ts` 已经承担了用户/偏好/审计三类仓储；
 * - 恢复码与挑战都有明确的**生命周期**（消费、过期清理），集中在这里更好审计。
 *
 * 两条存储铁律：
 * 1. **不存明文**：恢复码存 sha256 摘要，挑战令牌同样存摘要。
 *    泄露数据库文件不足以伪造恢复码或重放挑战。
 * 2. **一次性**：恢复码用掉即写 `used_at`；挑战用掉即写 `consumed_at`，
 *    并且带 `attempts` 计数，超过上限直接作废（防止对 6 位码暴力尝试）。
 */
import crypto from 'node:crypto';
import type { Db } from './database.js';
import type { TotpChallengeRow, TotpRecoveryCodeRow } from './types.js';

/** 单个挑战允许的验证码尝试次数上限。 */
export const TOTP_CHALLENGE_MAX_ATTEMPTS = 5;

export interface TotpChallenge {
  id: string;
  userId: number;
  createdAt: string;
  expiresAt: string;
  attempts: number;
}

function mapChallenge(row: TotpChallengeRow): TotpChallenge {
  return {
    id: row.id,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    attempts: row.attempts,
  };
}

/** 恢复码摘要工具：与 `modules/auth/totp.ts` 的 `hashRecoveryCode` 保持一致。 */
function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export class RecoveryCodesRepository {
  constructor(private readonly db: Db) {}

  /** 用一批新的恢复码摘要**整体替换**该用户的旧恢复码（含已用过的）。 */
  replaceAll(userId: number, codeHashes: readonly string[]): void {
    const now = new Date().toISOString();
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(userId);
      const insert = this.db.prepare(
        'INSERT INTO totp_recovery_codes (user_id, code_hash, created_at) VALUES (?, ?, ?)',
      );
      for (const hash of codeHashes) insert.run(userId, hash, now);
    });
    tx();
  }

  /** 未使用过的恢复码数量（用于界面提示"还剩 N 个恢复码"）。 */
  countUnused(userId: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS c FROM totp_recovery_codes WHERE user_id = ? AND used_at IS NULL')
      .get(userId) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /**
   * 核销一个恢复码（原子：只有未使用过才写得进去）。
   *
   * @param code 用户输入的恢复码**明文**（内部归一化后取摘要）
   * @returns 是否成功核销（false = 不存在或已用过）
   */
  consume(userId: number, code: string): boolean {
    const hash = sha256Hex(code.replace(/[^A-Za-z0-9]/g, '').toUpperCase());
    const info = this.db
      .prepare(
        `UPDATE totp_recovery_codes
            SET used_at = ?
          WHERE user_id = ? AND code_hash = ? AND used_at IS NULL`,
      )
      .run(new Date().toISOString(), userId, hash);
    return info.changes > 0;
  }

  /** 删除该用户全部恢复码（关闭两步验证 / 强制重置时调用）。 */
  deleteAllForUser(userId: number): number {
    return this.db.prepare('DELETE FROM totp_recovery_codes WHERE user_id = ?').run(userId).changes;
  }
}

export class TotpChallengesRepository {
  constructor(private readonly db: Db) {}

  /**
   * 创建登录第二步挑战。
   *
   * @returns 明文令牌（**只在此刻存在**，数据库里只有摘要）
   */
  create(input: { userId: number; ttlSeconds: number }): { token: string; expiresAt: string } {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + input.ttlSeconds * 1000).toISOString();
    this.db
      .prepare(
        `INSERT INTO totp_challenges (id, token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        `c-${crypto.randomBytes(8).toString('hex')}`,
        sha256Hex(token),
        input.userId,
        new Date(now).toISOString(),
        expiresAt,
      );
    return { token, expiresAt };
  }

  /** 按明文令牌查找**仍然有效**（未消费、未过期、尝试次数未超限）的挑战。 */
  findValidByToken(token: string): TotpChallenge | null {
    const row = this.db
      .prepare(
        `SELECT * FROM totp_challenges
          WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? AND attempts < ?`,
      )
      .get(sha256Hex(token), new Date().toISOString(), TOTP_CHALLENGE_MAX_ATTEMPTS) as TotpChallengeRow | undefined;
    return row ? mapChallenge(row) : null;
  }

  /**
   * 记录一次失败尝试。
   *
   * @returns 累计失败次数（调用方据此决定是否提示"挑战已作废"）
   */
  incrementAttempts(id: string): number {
    this.db.prepare('UPDATE totp_challenges SET attempts = attempts + 1 WHERE id = ?').run(id);
    const row = this.db.prepare('SELECT attempts FROM totp_challenges WHERE id = ?').get(id) as
      | { attempts: number }
      | undefined;
    return row?.attempts ?? 0;
  }

  /** 标记挑战已消费（成功登录后调用，防止同一个挑战被复用）。 */
  consume(id: string): void {
    this.db.prepare('UPDATE totp_challenges SET consumed_at = ? WHERE id = ?').run(new Date().toISOString(), id);
  }

  /** 清理过期/已消费超过 `keepHours` 小时的挑战。 */
  purgeExpired(keepHours = 24): number {
    const cutoff = new Date(Date.now() - keepHours * 3600 * 1000).toISOString();
    return this.db
      .prepare('DELETE FROM totp_challenges WHERE expires_at < ? OR (consumed_at IS NOT NULL AND consumed_at < ?)')
      .run(cutoff, cutoff).changes;
  }
}