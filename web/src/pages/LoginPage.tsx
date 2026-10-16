/**
 * 登录页。
 *
 * 支持两种形态，由后端第一步的响应决定：
 * 1. **账号密码**（未启用 TOTP）—— 提交后直接进入门户；
 * 2. **两步验证**（已启用 TOTP）—— 第一步返回 `totpRequired`，切到验证码输入。
 *
 * `challengeToken` 只保存在本组件的状态里，**不写任何存储**：
 * 刷新页面即失效（后端 TTL 默认 5 分钟），这样半途的凭据不会留在浏览器里。
 *
 * 设计取舍：不做"忘记密码"（本地账号体系无邮件通道，重置由管理员在账号管理页完成），
 * 但会明确提示这一点，避免用户困惑。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import { ApiError } from '../api/client.js';
import { Icon } from '../components/ui.js';
import { formatDateTime } from '../lib/format.js';

/** 第二步的挑战凭据（只在内存中存活）。 */
interface TotpChallenge {
  challengeToken: string;
  expiresAt: string;
}

export function LoginPage(): ReactNode {
  const { login, completeTotpLogin } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 非错误类的提示（如"验证已过期，请重新登录"） */
  const [notice, setNotice] = useState<string | null>(null);

  const [challenge, setChallenge] = useState<TotpChallenge | null>(null);
  const [code, setCode] = useState('');

  /** 回到第一步：清掉一次性挑战与密码，保留用户名方便重试。 */
  const backToCredentials = (): void => {
    setChallenge(null);
    setCode('');
    setPassword('');
    setError(null);
  };

  /** 第一步：账号密码。 */
  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const outcome = await login({ username: username.trim(), password, remember });
      if (outcome.status === 'totp') {
        // 切到第二步：此时**没有**会话 Cookie，challengeToken 只留在内存里
        setChallenge({ challengeToken: outcome.challengeToken, expiresAt: outcome.expiresAt });
        setCode('');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  };

  /** 第二步：动态码或恢复码。 */
  const onTotpSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!challenge) return;
    setSubmitting(true);
    setError(null);
    try {
      await completeTotpLogin({ challengeToken: challenge.challengeToken, code: code.trim(), remember });
      // 成功后 AuthProvider 写入用户，路由守卫会把页面切走
    } catch (err) {
      if (err instanceof ApiError && err.code === 'TOTP_INVALID') {
        // 就地报错：保留已输入的验证码，方便用户改一位重试
        setError('验证码不正确，请重试');
      } else if (err instanceof ApiError && err.code === 'TOTP_CHALLENGE_EXPIRED') {
        // 挑战已过期/已消费：退回第一步，让用户重新登录
        backToCredentials();
        setNotice('验证已过期，请重新登录');
      } else {
        setError(err instanceof Error ? err.message : '验证失败');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-sm">
        {/* 品牌 */}
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-sky-500 to-cyan-400 text-white shadow-xl shadow-sky-500/25">
            <Icon name="container" className="size-6.5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">HomePort 门户</h1>
            <p className="muted mt-1 text-xs">本机容器入口 · tailnet 设备状态 · 硬件占用</p>
          </div>
        </div>

        {challenge ? (
          /* ------------------------------------------------ 第二步：两步验证 */
          <form onSubmit={onTotpSubmit} className="card space-y-4 px-6 py-6">
            <div className="text-center">
              <h2 className="text-sm font-semibold">两步验证</h2>
              <p className="muted mt-1 text-xs">
                账号 <span className="font-mono">{username.trim()}</span> 已开启两步验证
              </p>
            </div>

            <div>
              <label className="label" htmlFor="totp-code">
                验证码
              </label>
              <input
                id="totp-code"
                className="input font-mono tracking-[0.2em]"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={9}
                autoFocus
                placeholder="123456"
                aria-invalid={error !== null}
                aria-describedby={error ? 'totp-code-hint totp-code-error' : 'totp-code-hint'}
              />
              <p id="totp-code-hint" className="muted mt-1.5 text-[11px] leading-relaxed">
                在验证器 App 中查看 6 位动态验证码；
                <br />
                手机不在身边时，可输入保存的恢复码（形如 <span className="font-mono">XXXX-XXXX</span>）。
              </p>
              {error ? (
                <p
                  id="totp-code-error"
                  role="alert"
                  className="mt-2 rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-600 ring-1 ring-rose-500/25 dark:text-rose-300"
                >
                  {error}
                </p>
              ) : null}
            </div>

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={submitting || code.trim().length < 6}
            >
              {submitting ? '验证中…' : '验证并登录'}
            </button>

            <button
              type="button"
              className="btn btn-ghost w-full"
              disabled={submitting}
              onClick={() => {
                backToCredentials();
                setNotice(null);
              }}
            >
              返回上一步
            </button>

            <p className="muted text-center text-[11px] leading-relaxed">
              本次验证有效至 {formatDateTime(challenge.expiresAt)}，超时后需要重新输入账号密码。
            </p>
          </form>
        ) : (
          /* ------------------------------------------------ 第一步：账号密码 */
          <form onSubmit={onSubmit} className="card space-y-4 px-6 py-6">
            <div>
              <label className="label" htmlFor="username">
                用户名
              </label>
              <input
                id="username"
                className="input"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="admin"
                aria-invalid={error !== null}
                aria-describedby={error ? 'login-error' : undefined}
                required
              />
            </div>

            <div>
              <label className="label" htmlFor="password">
                密码
              </label>
              <input
                id="password"
                type="password"
                className="input"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="••••••••"
                aria-invalid={error !== null}
                aria-describedby={error ? 'login-error' : undefined}
                required
              />
            </div>

            <label className="flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                className="size-3.5 accent-sky-500"
                checked={remember}
                onChange={(event) => setRemember(event.target.checked)}
              />
              记住我（30 天内免登录）
            </label>

            {notice ? (
              <p
                role="status"
                className="rounded-xl bg-amber-500/10 px-3 py-2 text-xs text-amber-700 ring-1 ring-amber-500/25 dark:text-amber-300"
              >
                {notice}
              </p>
            ) : null}

            {error ? (
              <p
                id="login-error"
                role="alert"
                className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-600 ring-1 ring-rose-500/25 dark:text-rose-300"
              >
                {error}
              </p>
            ) : null}

            <button
              type="submit"
              className="btn btn-primary w-full"
              disabled={submitting || username === '' || password === ''}
            >
              {submitting ? '登录中…' : '登录'}
            </button>

            <p className="muted text-center text-[11px] leading-relaxed">
              忘记密码？本地账号体系不提供自助找回，
              <br />
              请联系管理员在「账号管理」中重置。
            </p>
          </form>
        )}

        <p className="muted mt-5 text-center text-[11px]">
          登录会话通过 httpOnly Cookie 保存，变更类操作需校验 CSRF 令牌。
        </p>
      </div>
    </div>
  );
}