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
import {
  TOTP_CHALLENGE_MAX_ATTEMPTS,
  type RecoveryCodesRepository,
  type TotpChallengesRepository,
} from '../../db/totp.js';
import type { SecretBox } from '../settings/secretBox.js';
import type { AuthContext, ClientHints } from '../../http/guards.js';
import { HttpError, badRequest, conflict, notFound, unauthenticated } from '../../http/errors.js';
import {
  checkPasswordStrength,
  dummyVerify,
  generateSetupToken,
  hashPassword,
  timingSafeEqual,
  verifyPassword,
} from './crypto.js';
import {
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  buildOtpauthUri,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotp,
} from './totp.js';
import type { SessionsRepository } from './sessions.js';

export interface AuthServiceDeps {
  users: UsersRepository;
  sessions: SessionsRepository;
  preferences: PreferencesRepository;
  audit: AuditRepository;
  config: PortalConfig;
  logger: Logger;
  /**
   * 敏感值加密盒（AES-256-GCM），用于加解密 TOTP 种子。
   *
   * 可选：不传时两步验证接口统一返回 `TOTP_UNAVAILABLE`，
   * 其余认证功能完全不受影响（便于单测与最小部署）。
   */
  secretBox?: SecretBox;
  /** TOTP 辅助仓储（恢复码 / 登录挑战）。不给则两步验证不可用。 */
  totp?: {
    recoveryCodes: RecoveryCodesRepository;
    challenges: TotpChallengesRepository;
  };
}

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

/**
 * 登录第一步的结果：密码正确，但该账号启用了两步验证。
 *
 * 此时**不签发会话**，只给一个短时效的挑战令牌；前端拿它去调用
 * `POST /api/auth/login/totp` 完成第二步。
 */
export interface TotpChallengeResult {
  totpRequired: true;
  challengeToken: string;
  expiresAt: string;
}

export type LoginOutcome = LoginResult | TotpChallengeResult;

/** 判别联合收窄：是否还需要第二步验证。 */
export function isTotpChallenge(outcome: LoginOutcome): outcome is TotpChallengeResult {
  return (outcome as TotpChallengeResult).totpRequired === true;
}

export interface TotpSetupResult {
  /** 明文种子（**只在 setup 响应里出现一次**，随后只以密文存在数据库） */
  secret: string;
  otpauthUri: string;
  digits: number;
  period: number;
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
  async login(input: LoginInput): Promise<LoginOutcome> {
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

    // 启用两步验证的账号：到此只证明"知道密码"，**不签发会话**。
    //
    // 这里刻意**不看** `config.totp.enabled`：那个开关只决定"是否允许新绑定"。
    // 已经绑定的账号必须继续走第二步，否则管理员关掉开关就等于把所有账号
    // 静默降级成"仅密码"，而用户毫不知情。
    if (secret.totpEnabled) {
      const challenge = this.requireTotpRepos().challenges.create({
        userId: secret.id,
        ttlSeconds: this.deps.config.totp.challengeTtlSeconds,
      });
      this.deps.logger.info('登录需第二步验证', { username: secret.username });
      return { totpRequired: true, challengeToken: challenge.token, expiresAt: challenge.expiresAt };
    }

    return this.issueSession(secret, { remember: input.remember, hints: input.hints, detail: '常规登录' });
  }

  /**
   * 登录第二步：用挑战令牌 + 验证码（或恢复码）换会话。
   *
   * 失败处理刻意区分三件事，前端据此决定"就地重试"还是"退回第一步"：
   * - 挑战不存在/已过期/已消费/尝试次数超限 → `TOTP_CHALLENGE_EXPIRED`（退回第一步）；
   * - 验证码错误但挑战仍有效 → `TOTP_INVALID`（就地重试）。
   */
  async completeTotpLogin(input: {
    challengeToken: string;
    code: string;
    remember: boolean;
    hints: ClientHints;
  }): Promise<LoginResult> {
    const { challenges, recoveryCodes } = this.requireTotpRepos();

    const challenge = challenges.findValidByToken(input.challengeToken);
    if (!challenge) {
      throw new HttpError('TOTP_CHALLENGE_EXPIRED', '验证已过期，请重新登录');
    }

    const secret = this.deps.users.findWithSecretById(challenge.userId);
    if (!secret || secret.disabled || !secret.totpEnabled || !secret.totpSecretEncrypted) {
      challenges.consume(challenge.id);
      throw new HttpError('TOTP_CHALLENGE_EXPIRED', '验证已失效，请重新登录');
    }

    const verdict = this.verifySecondFactor(secret, input.code, recoveryCodes, true);
    if (!verdict.ok) {
      const attempts = challenges.incrementAttempts(challenge.id);
      this.deps.audit.append({
        actorId: secret.id,
        actorName: secret.username,
        action: 'auth.totp_failed',
        target: `user:${secret.id}`,
        detail: verdict.method === 'recovery' ? '恢复码不正确' : `验证码不正确（${verdict.reason}）`,
        ip: input.hints.ip,
      });
      if (attempts >= TOTP_CHALLENGE_MAX_ATTEMPTS) {
        challenges.consume(challenge.id);
        this.deps.logger.warn('两步验证尝试次数过多，挑战已作废', { username: secret.username, attempts });
        throw new HttpError('TOTP_CHALLENGE_EXPIRED', '尝试次数过多，请重新登录');
      }
      throw new HttpError('TOTP_INVALID', '验证码不正确');
    }

    challenges.consume(challenge.id);
    if (verdict.method === 'recovery') {
      this.deps.audit.append({
        actorId: secret.id,
        actorName: secret.username,
        action: 'auth.totp_recovery_used',
        target: `user:${secret.id}`,
        detail: `使用恢复码登录，剩余 ${recoveryCodes.countUnused(secret.id)} 个`,
        ip: input.hints.ip,
      });
    }

    return this.issueSession(secret, {
      remember: input.remember,
      hints: input.hints,
      detail: verdict.method === 'recovery' ? '两步验证登录（恢复码）' : '两步验证登录',
    });
  }

  /** 开始绑定两步验证：生成种子并以**未确认**状态保存，返回明文种子给界面展示一次。 */
  async beginTotpSetup(auth: AuthContext): Promise<TotpSetupResult> {
    const { secretBox } = this.requireTotp();
    this.assertTotpEnrollmentAllowed();
    const user = this.deps.users.findById(auth.user.id);
    if (!user) throw unauthenticated();
    if (user.totpEnabled) throw conflict('两步验证已启用；如需重新绑定，请先关闭');

    const secret = generateTotpSecret();
    // 明文只在此刻存在于内存与响应体里；数据库里立刻就是密文
    this.deps.users.setPendingTotpSecret(user.id, secretBox.encrypt(secret));
    this.deps.audit.append({
      actorId: user.id,
      actorName: user.username,
      action: 'auth.totp_setup_started',
      target: `user:${user.id}`,
      detail: '生成待确认的两步验证种子',
      ip: null,
    });

    return {
      secret,
      otpauthUri: buildOtpauthUri({
        secret,
        issuer: this.deps.config.totp.issuer,
        account: user.username,
      }),
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    };
  }

  /**
   * 确认启用：回填一次验证器生成的码，成功后**一次性**返回恢复码。
   *
   * 恢复码明文只在此处返回，数据库里只留 sha256 摘要 —— 丢了只能重新生成。
   */
  async enableTotp(
    auth: AuthContext,
    code: string,
    ip: string | null,
  ): Promise<{ recoveryCodes: string[]; user: User }> {
    const { secretBox, recoveryCodes } = this.requireTotp();
    this.assertTotpEnrollmentAllowed();
    const secret = this.deps.users.findWithSecretById(auth.user.id);
    if (!secret) throw unauthenticated();
    if (secret.totpEnabled) throw conflict('两步验证已启用');
    if (!secret.totpSecretEncrypted) throw badRequest('请先开始绑定两步验证（获取种子）');

    let plaintext: string;
    try {
      plaintext = secretBox.decrypt(secret.totpSecretEncrypted);
    } catch (error) {
      this.deps.logger.error('TOTP 种子解密失败，无法完成绑定', { userId: secret.id, error });
      throw new HttpError('TOTP_UNAVAILABLE', '无法读取待确认的种子，请重新开始绑定');
    }

    const result = verifyTotp(plaintext, code, { window: this.deps.config.totp.window });
    if (!result.ok || result.counter === null) {
      throw new HttpError('TOTP_INVALID', '验证码不正确，请确认手机时间是否准确');
    }

    this.deps.users.enableTotp(secret.id, secret.totpSecretEncrypted);
    // 刻意**不**在这里记录 `totp_last_counter`：绑定用的那个码只是"证明 App 配好了"，
    // 若记下来，用户绑定完立刻退出再登录（同一个 30 秒窗口内）就会被判重放而登录失败。
    // 防重放只作用于**登录**路径，那里才是"被偷看的码"的真实风险面。

    const codes = generateRecoveryCodes();
    recoveryCodes.replaceAll(secret.id, codes.map(hashRecoveryCode));

    // 绑定成功意味着账号安全等级变化：吊销其它会话，只留当前这一个
    this.revokeOtherSessions(secret.id, auth.session.id);
    this.invalidateUserCache(secret.id);

    this.deps.audit.append({
      actorId: secret.id,
      actorName: secret.username,
      action: 'auth.totp_enabled',
      target: `user:${secret.id}`,
      detail: `启用两步验证，生成 ${codes.length} 个恢复码`,
      ip,
    });

    const updated = this.deps.users.findById(secret.id);
    if (!updated) throw unauthenticated();
    return { recoveryCodes: codes, user: updated };
  }

  /**
   * 关闭两步验证。
   *
   * 门槛必须不低于开启：要**密码**，并且如果当前已启用则还要一次当前验证码（或恢复码）。
   * 否则"会话被短暂劫持"就足以拆掉第二因子。
   */
  async disableTotp(
    auth: AuthContext,
    input: { password: string; code?: string | undefined; ip: string | null },
  ): Promise<User> {
    const { recoveryCodes } = this.requireTotp();
    const secret = this.deps.users.findWithSecretById(auth.user.id);
    if (!secret) throw unauthenticated();

    const ok = await verifyPassword(input.password, secret.passwordHash);
    if (!ok) {
      throw badRequest('当前密码不正确', { fieldErrors: { password: ['当前密码不正确'] } });
    }

    if (secret.totpEnabled) {
      const code = (input.code ?? '').trim();
      if (!code) throw badRequest('请输入当前验证码', { fieldErrors: { code: ['请输入当前的 6 位验证码或恢复码'] } });
      const verdict = this.verifySecondFactor(secret, code, recoveryCodes, false);
      if (!verdict.ok) throw new HttpError('TOTP_INVALID', '验证码或恢复码不正确');
    }

    this.deps.users.disableTotp(secret.id);
    recoveryCodes.deleteAllForUser(secret.id);
    this.revokeOtherSessions(secret.id, auth.session.id);
    this.invalidateUserCache(secret.id);

    this.deps.audit.append({
      actorId: secret.id,
      actorName: secret.username,
      action: 'auth.totp_disabled',
      target: `user:${secret.id}`,
      detail: '用户主动关闭两步验证',
      ip: input.ip,
    });

    const updated = this.deps.users.findById(secret.id);
    if (!updated) throw unauthenticated();
    return updated;
  }

  /** 重新生成恢复码（旧的一律作废）：需要一次当前验证码。 */
  async regenerateRecoveryCodes(auth: AuthContext, code: string, ip: string | null): Promise<string[]> {
    const { recoveryCodes } = this.requireTotp();
    const secret = this.deps.users.findWithSecretById(auth.user.id);
    if (!secret) throw unauthenticated();
    if (!secret.totpEnabled || !secret.totpSecretEncrypted) {
      throw badRequest('尚未启用两步验证');
    }

    const verdict = this.verifySecondFactor(secret, code, recoveryCodes, false);
    if (!verdict.ok) throw new HttpError('TOTP_INVALID', '验证码或恢复码不正确');

    const codes = generateRecoveryCodes();
    recoveryCodes.replaceAll(secret.id, codes.map(hashRecoveryCode));
    this.deps.audit.append({
      actorId: secret.id,
      actorName: secret.username,
      action: 'auth.totp_recovery_regenerated',
      target: `user:${secret.id}`,
      detail: `重新生成 ${codes.length} 个恢复码（旧码作废）`,
      ip,
    });
    return codes;
  }

  /**
   * 管理员强制重置某个用户的两步验证（**丢失设备流程**）。
   *
   * 语义：清空种子与恢复码 + 吊销该用户全部会话。用户下次登录只用密码，
   * 因此这一步的风险等同于"临时降低该账号的安全等级"，必须审计到管理员头上。
   *
   * 若**唯一的管理员**自己丢了设备，只能走离线流程：
   * `npm run totp:reset -- --user <name>`（直接操作数据库文件，见 08-operations.md）。
   */
  resetTotpForUser(actor: AuthContext, targetUserId: number, ip: string | null): number {
    const target = this.deps.users.findById(targetUserId);
    if (!target) throw notFound('目标用户不存在');

    this.deps.users.disableTotp(targetUserId);
    this.deps.totp?.recoveryCodes.deleteAllForUser(targetUserId);
    const revoked = this.deps.sessions.revokeAllForUser(targetUserId);
    this.invalidateUserCache(targetUserId);

    this.deps.audit.append({
      actorId: actor.user.id,
      actorName: actor.user.username,
      action: 'auth.totp_reset',
      target: `user:${targetUserId}`,
      detail: `管理员强制重置两步验证（目标曾${target.totpEnabled ? '已' : '未'}启用），吊销 ${revoked} 个会话`,
      ip,
    });
    this.deps.logger.warn('管理员重置了他人的两步验证', {
      actor: actor.user.username,
      target: target.username,
    });
    return revoked;
  }

  /** 清理过期的登录挑战（由 app.ts 的定时器调用）。 */
  purgeExpiredTotpState(): number {
    return this.deps.totp?.challenges.purgeExpired(24) ?? 0;
  }

  /**
   * 校验第二因子：先按 TOTP 校验，再按恢复码核销。
   *
   * 顺序上有意让 TOTP 先行（多数请求都是 TOTP），恢复码作为兜底；
   * 恢复码命中即当场核销，不可重放。
   *
   * @param consumeCounter 是否把命中的时间步记为"已用"（防重放）。
   *   只有**登录**路径传 true：
   *   - 登录是"被偷看的验证码被重放"的真实风险面；
   *   - 会话内的再次确认（关闭两步验证 / 重生成恢复码）若也消费计数器，
   *     用户确认完再登录（同一个 30 秒窗口内）会被判重放，属于自伤式安全。
   */
  private verifySecondFactor(
    secret: UserWithSecret,
    code: string,
    recoveryCodes: RecoveryCodesRepository,
    consumeCounter: boolean,
  ):
    | { ok: true; method: 'totp' | 'recovery'; counter: number | null }
    | { ok: false; method: 'totp' | 'recovery'; reason: string } {
    const encrypted = secret.totpSecretEncrypted;
    if (encrypted && this.deps.secretBox) {
      let plaintext: string | null = null;
      try {
        plaintext = this.deps.secretBox.decrypt(encrypted);
      } catch (error) {
        // 主密钥变了/密文被改：不崩溃，降级为"第二因子不可用"，
        // 用户可走管理员重置或离线重置流程。
        this.deps.logger.error('TOTP 种子解密失败，该用户的第二因子不可用', { userId: secret.id, error });
      }
      if (plaintext) {
        const result = verifyTotp(plaintext, code, {
          window: this.deps.config.totp.window,
          lastCounter: consumeCounter ? secret.totpLastCounter : null,
        });
        if (result.ok && result.counter !== null) {
          if (consumeCounter) this.deps.users.setTotpLastCounter(secret.id, result.counter);
          return { ok: true, method: 'totp', counter: result.counter };
        }
        if (result.reason === 'replayed') {
          return { ok: false, method: 'totp', reason: 'replayed' };
        }
      }
    }

    if (recoveryCodes.consume(secret.id, code)) {
      return { ok: true, method: 'recovery', counter: null };
    }
    return { ok: false, method: 'totp', reason: 'mismatch' };
  }

  /** 取得两步验证所需的依赖；缺失时统一报"功能不可用"而不是 500。 */
  private requireTotp(): { secretBox: SecretBox } & NonNullable<AuthServiceDeps['totp']> {
    const secretBox = this.deps.secretBox;
    const totp = this.deps.totp;
    if (!secretBox || !totp) {
      throw new HttpError('TOTP_UNAVAILABLE', '服务端未配置两步验证所需的主密钥，该功能不可用');
    }
    return { secretBox, ...totp };
  }

  /** 只取仓储（登录第二步不需要 secretBox，解密由 verifySecondFactor 内部处理）。 */
  private requireTotpRepos(): NonNullable<AuthServiceDeps['totp']> {
    const totp = this.deps.totp;
    if (!totp) {
      throw new HttpError('TOTP_UNAVAILABLE', '服务端未启用两步验证功能');
    }
    return totp;
  }

  /**
   * 新绑定是否被服务端配置允许（`PORTAL_TOTP_ENABLED`）。
   *
   * 只拦「绑定/确认」两个入口，**不拦**：
   * - 登录第二步：已绑定的账号必须继续要求第二步，否则关掉开关就等于把所有账号
   *   静默降级成"仅密码"，而用户毫不知情；
   * - 关闭与重生成恢复码：不能因为管理员关了开关，就让已经绑定的人连"关掉它"都做不到。
   */
  private assertTotpEnrollmentAllowed(): void {
    if (!this.deps.config.totp.enabled) {
      throw new HttpError('TOTP_UNAVAILABLE', '服务端已关闭两步验证功能，暂时无法绑定新设备');
    }
  }

  /** 签发会话（第一步与第二步共用，避免两处逻辑漂移）。 */
  private issueSession(
    secret: UserWithSecret,
    input: { remember: boolean; hints: ClientHints; detail: string },
  ): LoginResult {
    const ttlHours = input.remember ? this.deps.config.session.rememberTtlHours : this.deps.config.session.ttlHours;
    const { token, session } = this.deps.sessions.create({
      userId: secret.id,
      ttlHours,
      userAgent: input.hints.userAgent,
      remoteAddr: input.hints.ip,
    });
    const now = new Date().toISOString();
    this.deps.users.touchLastLogin(secret.id);
    const user = this.toPublicUser({ ...secret, lastLoginAt: now });
    this.cacheUser(user);

    this.deps.audit.append({
      actorId: secret.id,
      actorName: secret.username,
      action: 'auth.login',
      target: `user:${secret.id}`,
      detail: `${input.detail}${input.remember ? '（记住我）' : ''}`,
      ip: input.hints.ip,
    });

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

  /**
   * 内部模型 → 可返回给前端的模型。
   *
   * **显式白名单**而不是"解构掉 passwordHash 后展开"：
   * 后者在给 `UserWithSecret` 加字段（例如 TOTP 种子密文）时会**默默泄漏**
   * 到 API 响应里 —— 加字段的人不会想到要回头改这里。白名单让"新字段默认不外泄"。
   */
  private toPublicUser(secret: UserWithSecret): User {
    return {
      id: secret.id,
      username: secret.username,
      displayName: secret.displayName,
      role: secret.role,
      disabled: secret.disabled,
      createdAt: secret.createdAt,
      updatedAt: secret.updatedAt,
      lastLoginAt: secret.lastLoginAt,
      totpEnabled: secret.totpEnabled,
      totpConfirmedAt: secret.totpConfirmedAt,
    };
  }
}

/** 供路由层复用的冲突检查（重名用户）。 */
export function assertUsernameAvailable(users: UsersRepository, username: string, excludeId?: number): void {
  if (users.usernameExists(username, excludeId)) {
    throw conflict('用户名已存在', { fieldErrors: { username: ['用户名已存在'] } });
  }
}
