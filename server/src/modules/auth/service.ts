/**
 * 鉴权服务：登录、登出、会话解析、首启初始化、改密。
 *
 * 这是 F5「登录权限管理」的业务出口。routes/auth.ts 只做参数校验后调用这里。
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Logger } from '../../logger.js';
import type { PortalConfig } from '../../config.js';
import type { User, UserWithSecret } from '../../db/types.js';
import { AuditRepository, PreferencesRepository, UsersRepository } from '../../db/users.js';
import type { AuthContext, ClientHints } from '../../http/guards.js';
import { HttpError, badRequest, conflict, unauthenticated } from '../../http/errors.js';
import {
  checkPasswordStrength,
  dummyVerify,
  generateSetupToken,
  hashPassword,
  timingSafeEqual,
  verifyPassword,
} from './crypto.js';
import type { SessionsRepository } from './sessions.js';

export interface AuthServiceDeps {
  users: UsersRepository;
  sessions: SessionsRepository;
  preferences: PreferencesRepository;
  audit: AuditRepository;
  config: PortalConfig;
  logger: Logger;
}

export interface SessionView {
  setupRequired: boolean;
  authenticated: boolean;
  csrfToken: string;
  user: User | null;
  expiresAt: string | null;
}

export interface LoginInput {
  username: string;
  password: string;
  remember: boolean;
  hints: ClientHints;
}

export interface LoginResult {
  token: string;
  expiresAt: string;
  csrfToken: string;
  user: User;
}

export interface BootstrapInput {
  token: string;
  username: string;
  password: string;
  displayName: string;
  hints: ClientHints;
}

export const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;

export class AuthService {
  private readonly deps: AuthServiceDeps;
  /** 进程内用户缓存，降低每个请求的 SQL 次数（写操作会失效） */
  private readonly userCache = new Map<number, User>();
  /** 首启初始化令牌（延迟初始化） */
  private setupToken: string | null = null;

  constructor(deps: AuthServiceDeps) {
    this.deps = deps;
  }

  /** 是否尚未创建任何用户（前端需要显示"初始化"流程）。 */
  isSetupRequired(): boolean {
    return this.deps.users.count() === 0;
  }

  /**
   * 取得首启初始化令牌。
   *
   * 优先取环境变量 `PORTAL_SETUP_TOKEN`；否则生成随机令牌并写入
   * `<dataDir>/setup-token.txt`（权限 0600），同时在日志中打印一次，
   * 这样在 NAS 上无法轻易读文件时也能从 `docker logs` 拿到。
   */
  getSetupToken(): string {
    if (this.setupToken) return this.setupToken;
    const fromEnv = this.deps.config.bootstrap.token;
    if (fromEnv) {
      this.setupToken = fromEnv;
      return fromEnv;
    }

    const tokenFile = this.deps.config.bootstrap.tokenFile;
    try {
      if (fs.existsSync(tokenFile)) {
        const existing = fs.readFileSync(tokenFile, 'utf8').trim();
        if (existing.length >= 8) {
          this.setupToken = existing;
          return existing;
        }
      }
    } catch (error) {
      this.deps.logger.warn('读取初始化令牌文件失败，将重新生成', { error, file: tokenFile });
    }

    const generated = generateSetupToken();
    try {
      fs.mkdirSync(path.dirname(tokenFile), { recursive: true });
      fs.writeFileSync(tokenFile, `${generated}\n`, { mode: 0o600 });
    } catch (error) {
      this.deps.logger.warn('写入初始化令牌文件失败（仍可从日志获取）', { error, file: tokenFile });
    }
    this.setupToken = generated;
    return generated;
  }

  /** 校验初始化令牌（恒定时间比较）。 */
  private verifySetupToken(provided: string): boolean {
    const expected = this.getSetupToken();
    return timingSafeEqual(provided.trim(), expected.trim());
  }

  /** 首启初始化：创建第一个（且必须是 admin 的）用户。 */
  async bootstrap(input: BootstrapInput): Promise<User> {
    if (!this.isSetupRequired()) {
      throw new HttpError('ALREADY_INITIALIZED', '系统已初始化，无法重复执行初始化');
    }
    if (!this.verifySetupToken(input.token)) {
      throw badRequest('初始化令牌不正确', { fieldErrors: { token: ['初始化令牌不正确，请查看服务端日志或 data/setup-token.txt'] } });
    }
    if (!USERNAME_RE.test(input.username.trim())) {
      throw badRequest('用户名不合法', {
        fieldErrors: { username: ['用户名需为 3-32 位字母、数字、下划线、点或短横线'] },
      });
    }
    const strength = checkPasswordStrength(input.password);
    if (!strength.ok) {
      throw badRequest('密码强度不足', { fieldErrors: { password: [strength.reason ?? '密码强度不足'] } });
    }

    const passwordHash = await hashPassword(input.password);
    const user = this.deps.users.create({
      username: input.username.trim(),
      displayName: input.displayName.trim() || input.username.trim(),
      role: 'admin',
      passwordHash,
    });
    this.deps.preferences.getOrCreate(user.id);
    this.deps.audit.append({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.bootstrap',
      target: `user:${user.id}`,
      detail: '创建首个管理员账号',
      ip: input.hints.ip,
    });
    this.deps.logger.info('首启初始化完成，已创建管理员', { username: user.username });
    return user;
  }

  /**
   * 登录。
   *
   * 防用户枚举：用户不存在时也执行一次等价耗时的哈希比较。
   * 登录失败一律返回 `INVALID_CREDENTIALS`，不区分「用户不存在」与「密码错误」。
   */
  async login(input: LoginInput): Promise<LoginResult> {
    if (this.isSetupRequired()) {
      throw new HttpError('SETUP_REQUIRED', '系统尚未初始化，请先创建管理员账号');
    }

    const secret: UserWithSecret | null = this.deps.users.findWithSecretByUsername(input.username);
    if (!secret) {
      await dummyVerify();
      throw new HttpError('INVALID_CREDENTIALS', '用户名或密码错误');
    }

    const ok = await verifyPassword(input.password, secret.passwordHash);
    if (!ok) {
      this.deps.audit.append({
        actorId: secret.id,
        actorName: secret.username,
        action: 'auth.login_failed',
        target: `user:${secret.id}`,
        detail: '密码错误',
        ip: input.hints.ip,
      });
      throw new HttpError('INVALID_CREDENTIALS', '用户名或密码错误');
    }

    if (secret.disabled) {
      throw new HttpError('FORBIDDEN', '该账号已被禁用');
    }

    const ttlHours = input.remember ? this.deps.config.session.rememberTtlHours : this.deps.config.session.ttlHours;
    const { token, session } = this.deps.sessions.create({
      userId: secret.id,
      ttlHours,
      userAgent: input.hints.userAgent,
      remoteAddr: input.hints.ip,
    });
    this.deps.users.touchLastLogin(secret.id);
    this.cacheUser({ ...secret, lastLoginAt: new Date().toISOString() });

    this.deps.audit.append({
      actorId: secret.id,
      actorName: secret.username,
      action: 'auth.login',
      target: `user:${secret.id}`,
      detail: input.remember ? '记住我' : '常规登录',
      ip: input.hints.ip,
    });

    const user = this.toPublicUser(secret);
    return { token, expiresAt: session.expiresAt, csrfToken: session.csrfToken, user };
  }

  /** 登出：撤销会话。 */
  logout(sessionId: string, actor: User | null, ip: string | null): void {
    this.deps.sessions.revoke(sessionId);
    this.deps.audit.append({
      actorId: actor?.id ?? null,
      actorName: actor?.username ?? null,
      action: 'auth.logout',
      target: actor ? `user:${actor.id}` : null,
      detail: null,
      ip,
    });
  }

  /**
   * 由会话令牌解析鉴权上下文。
   *
   * @returns 有效则返回 `{ user, session }`；令牌为空/无效/用户被禁用/已删除均返回 null
   */
  resolveSession(input: { token: string | null; userAgent: string | null; remoteAddr: string | null }): AuthContext | null {
    if (!input.token) return null;
    const session = this.deps.sessions.findValidByToken(input.token);
    if (!session) return null;

    const user = this.getUser(session.userId);
    if (!user || user.disabled) return null;

    this.deps.sessions.touch(session.id);
    return { user, session };
  }

  /** 构造 `/api/auth/session` 响应。 */
  describeSession(auth: AuthContext | null): SessionView {
    if (!auth) {
      return {
        setupRequired: this.isSetupRequired(),
        authenticated: false,
        csrfToken: '',
        user: null,
        expiresAt: null,
      };
    }
    return {
      setupRequired: false,
      authenticated: true,
      csrfToken: auth.session.csrfToken,
      user: auth.user,
      expiresAt: auth.session.expiresAt,
    };
  }

  /**
   * 用户自助改密。成功后**吊销该用户的其它会话**（当前会话保留）。
   */
  async changeOwnPassword(
    auth: AuthContext,
    input: { currentPassword: string; newPassword: string; ip: string | null },
  ): Promise<void> {
    const secret = this.deps.users.findWithSecretById(auth.user.id);
    if (!secret) throw unauthenticated();
    const ok = await verifyPassword(input.currentPassword, secret.passwordHash);
    if (!ok) {
      throw badRequest('当前密码不正确', { fieldErrors: { currentPassword: ['当前密码不正确'] } });
    }
    const strength = checkPasswordStrength(input.newPassword);
    if (!strength.ok) {
      throw badRequest('新密码强度不足', { fieldErrors: { newPassword: [strength.reason ?? '密码强度不足'] } });
    }
    if (input.currentPassword === input.newPassword) {
      throw badRequest('新密码不能与当前密码相同', { fieldErrors: { newPassword: ['新密码不能与当前密码相同'] } });
    }

    const passwordHash = await hashPassword(input.newPassword);
    this.deps.users.updatePassword(auth.user.id, passwordHash);
    this.revokeOtherSessions(auth.user.id, auth.session.id);
    this.deps.audit.append({
      actorId: auth.user.id,
      actorName: auth.user.username,
      action: 'auth.password_changed',
      target: `user:${auth.user.id}`,
      detail: '用户自助改密',
      ip: input.ip,
    });
  }

  /** 吊销某用户的全部会话，可保留一个。 */
  revokeOtherSessions(userId: number, keepSessionId: string | null): number {
    const activeIds = this.deps.sessions.countActiveForUser(userId);
    this.deps.sessions.revokeAllForUser(userId);
    if (keepSessionId) {
      // 上面是整体撤销，这里把当前会话"复活"（重建会丢失 csrf，故直接清空 revoked_at）
      // 实现上通过仓储的私有 SQL 完成，见 SessionsRepository.unrevoke
      this.deps.sessions.unrevoke(keepSessionId);
    }
    return Math.max(0, activeIds - (keepSessionId ? 1 : 0));
  }

  /** 管理员重置他人密码：吊销目标用户全部会话。 */
  async resetPassword(
    actor: AuthContext,
    targetUserId: number,
    newPassword: string,
    ip: string | null,
  ): Promise<number> {
    const target = this.deps.users.findById(targetUserId);
    if (!target) throw new HttpError('NOT_FOUND', '目标用户不存在');
    const strength = checkPasswordStrength(newPassword);
    if (!strength.ok) {
      throw badRequest('密码强度不足', { fieldErrors: { newPassword: [strength.reason ?? '密码强度不足'] } });
    }
    const passwordHash = await hashPassword(newPassword);
    this.deps.users.updatePassword(targetUserId, passwordHash);
    const revoked = this.deps.sessions.revokeAllForUser(targetUserId);
    this.deps.audit.append({
      actorId: actor.user.id,
      actorName: actor.user.username,
      action: 'user.password_reset',
      target: `user:${targetUserId}`,
      detail: `管理员重置密码，吊销 ${revoked} 个会话`,
      ip,
    });
    return revoked;
  }

  /** 清理过期会话（由 app.ts 的定时器调用）。 */
  purgeExpiredSessions(): number {
    return this.deps.sessions.purge(24);
  }

  /** 用户缓存失效（用户被修改/删除时调用）。 */
  invalidateUserCache(userId?: number): void {
    if (userId === undefined) this.userCache.clear();
    else this.userCache.delete(userId);
  }

  private getUser(userId: number): User | null {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    const user = this.deps.users.findById(userId);
    if (user) this.cacheUser(user);
    return user;
  }

  private cacheUser(user: User): void {
    this.userCache.set(user.id, user);
  }

  private toPublicUser(secret: UserWithSecret): User {
    const { passwordHash: _ignored, ...rest } = secret;
    return rest;
  }
}

/** 供路由层复用的冲突检查（重名用户）。 */
export function assertUsernameAvailable(users: UsersRepository, username: string, excludeId?: number): void {
  if (users.usernameExists(username, excludeId)) {
    throw conflict('用户名已存在', { fieldErrors: { username: ['用户名已存在'] } });
  }
}
