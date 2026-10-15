/**
 * 用户管理服务（F5 的管理侧）：CRUD、角色、禁用、重置密码、强制下线。
 *
 * 关键不变量（在**写操作前**校验，避免把系统锁死）：
 * - 不能删除自己
 * - 不能删除/降级/禁用**最后一个启用状态的 admin**
 */
import type { Logger } from '../../logger.js';
import type { User, UserPreferences, UserRole } from '../../db/types.js';
import { AuditRepository, PreferencesRepository, UsersRepository, type CreateUserInput } from '../../db/users.js';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../../http/errors.js';
import { checkPasswordStrength, hashPassword } from '../auth/crypto.js';
import { USERNAME_RE } from '../auth/service.js';
import type { SessionsRepository } from '../auth/sessions.js';

export interface UsersServiceDeps {
  users: UsersRepository;
  sessions: SessionsRepository;
  preferences: PreferencesRepository;
  audit: AuditRepository;
  logger: Logger;
  /** 用户变更后清理 auth service 的缓存 */
  onUserChanged: (userId?: number) => void;
}

export class UsersService {
  private readonly deps: UsersServiceDeps;

  constructor(deps: UsersServiceDeps) {
    this.deps = deps;
  }

  /** 列出全部用户。 */
  list(): { items: User[]; total: number } {
    const items = this.deps.users.list();
    return { items, total: items.length };
  }

  /** 取单个用户。 */
  get(id: number): User {
    const user = this.deps.users.findById(id);
    if (!user) throw notFound('用户不存在');
    return user;
  }

  /** 读取用户偏好（不存在时创建默认值）。 */
  preferences(userId: number): UserPreferences {
    return this.deps.preferences.getOrCreate(userId);
  }

  /** 更新用户偏好。 */
  updatePreferences(
    userId: number,
    input: Partial<Pick<UserPreferences, 'theme' | 'density' | 'defaultPage'>>,
  ): UserPreferences {
    return this.deps.preferences.update(userId, input);
  }

  /** 某用户当前活跃会话数。 */
  activeSessionCount(userId: number): number {
    return this.deps.sessions.countActiveForUser(userId);
  }

  /** 非管理员直接 403（路由层调用）。 */
  assertAdmin(user: User): void {
    assertAdmin(user);
  }

  /**
   * 创建用户。
   *
   * @param actor 执行者（用于审计）
   */
  async create(
    actor: User,
    input: { username: string; password: string; displayName: string; role: UserRole },
    ip: string | null,
  ): Promise<User> {
    const username = input.username.trim();
    if (!USERNAME_RE.test(username)) {
      throw badRequest('用户名不合法', { fieldErrors: { username: ['用户名需为 3-32 位字母、数字、下划线、点或短横线'] } });
    }
    if (this.deps.users.usernameExists(username)) {
      throw conflict('用户名已存在', { fieldErrors: { username: ['用户名已存在'] } });
    }
    const strength = checkPasswordStrength(input.password);
    if (!strength.ok) {
      throw badRequest('密码强度不足', { fieldErrors: { password: [strength.reason ?? '密码强度不足'] } });
    }

    const passwordHash = await hashPassword(input.password);
    const payload: CreateUserInput = {
      username,
      displayName: input.displayName.trim() || username,
      role: input.role,
      passwordHash,
    };
    let created: User;
    try {
      created = this.deps.users.create(payload);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw conflict('用户名已存在', { fieldErrors: { username: ['用户名已存在'] } });
      }
      throw error;
    }

    this.deps.onUserChanged(created.id);
    this.deps.audit.append({
      actorId: actor.id,
      actorName: actor.username,
      action: 'user.create',
      target: `user:${created.id}`,
      detail: `创建用户 ${created.username}（角色 ${created.role}）`,
      ip,
    });
    return created;
  }

  /**
   * 更新用户（显示名 / 角色 / 禁用）。
   *
   * 「最后一个 admin」保护：任何会减少启用 admin 数量的变更都会被拒绝。
   */
  update(
    actor: User,
    targetId: number,
    input: { displayName?: string; role?: UserRole; disabled?: boolean },
    ip: string | null,
  ): User {
    const target = this.get(targetId);
    const willDemote = input.role !== undefined && input.role !== 'admin' && target.role === 'admin';
    const willDisable = input.disabled === true && !target.disabled;

    if ((willDemote || willDisable) && this.isLastActiveAdmin(targetId)) {
      throw conflict('不能降级或禁用最后一个管理员账号');
    }

    const updated = this.deps.users.update(targetId, input);
    if (!updated) throw notFound('用户不存在');

    // 被禁用或角色变化 → 立即吊销会话
    let revoked = 0;
    if (willDisable || (input.role !== undefined && input.role !== target.role)) {
      revoked = this.deps.sessions.revokeAllForUser(targetId);
    }

    this.deps.onUserChanged(targetId);
    const changes: string[] = [];
    if (input.displayName !== undefined) changes.push(`显示名 → ${updated.displayName}`);
    if (input.role !== undefined) changes.push(`角色 → ${updated.role}`);
    if (input.disabled !== undefined) changes.push(`禁用 → ${updated.disabled ? '是' : '否'}`);
    this.deps.audit.append({
      actorId: actor.id,
      actorName: actor.username,
      action: 'user.update',
      target: `user:${targetId}`,
      detail: `${changes.join('，')}${revoked > 0 ? `（吊销 ${revoked} 个会话）` : ''}`,
      ip,
    });
    return updated;
  }

  /** 删除用户。 */
  delete(actor: User, targetId: number, ip: string | null): void {
    const target = this.get(targetId);
    if (target.id === actor.id) {
      throw conflict('不能删除当前登录的账号');
    }
    if (target.role === 'admin' && !target.disabled && this.isLastActiveAdmin(targetId)) {
      throw conflict('不能删除最后一个管理员账号');
    }
    const removed = this.deps.users.delete(targetId);
    if (!removed) throw notFound('用户不存在');
    this.deps.onUserChanged(targetId);
    this.deps.audit.append({
      actorId: actor.id,
      actorName: actor.username,
      action: 'user.delete',
      target: `user:${targetId}`,
      detail: `删除用户 ${target.username}`,
      ip,
    });
  }

  /** 强制某用户下线。 */
  revokeSessions(actor: User, targetId: number, ip: string | null): number {
    const target = this.get(targetId);
    const revoked = this.deps.sessions.revokeAllForUser(targetId);
    this.deps.audit.append({
      actorId: actor.id,
      actorName: actor.username,
      action: 'user.sessions_revoked',
      target: `user:${targetId}`,
      detail: `强制 ${target.username} 下线，吊销 ${revoked} 个会话`,
      ip,
    });
    return revoked;
  }

  /** 目标用户是否为「最后一个启用 admin」。 */
  private isLastActiveAdmin(userId: number): boolean {
    const target = this.deps.users.findById(userId);
    if (!target || target.role !== 'admin' || target.disabled) return false;
    return this.deps.users.countActiveAdmins() <= 1;
  }
}

/** SQLite 唯一约束冲突识别。 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: string }).code;
  return code === 'SQLITE_CONSTRAINT_UNIQUE' || code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT';
}

/** 供路由层复用的守卫：非 admin 直接 403。 */
export function assertAdmin(user: User): void {
  if (user.role !== 'admin') throw forbidden('该操作需要管理员权限');
}

/** 导出给路由层的错误类型（保持 import 面简洁）。 */
export { HttpError };
