/**
 * 登录页。
 *
 * 设计取舍：不做"忘记密码"（本地账号体系无邮件通道，重置由管理员在账号管理页完成），
 * 但会明确提示这一点，避免用户困惑。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import { Icon } from '../components/ui.js';

export function LoginPage(): ReactNode {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await login({ username: username.trim(), password, remember });
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
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

          {error ? (
            <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-600 ring-1 ring-rose-500/25 dark:text-rose-300">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn-primary w-full" disabled={submitting || username === '' || password === ''}>
            {submitting ? '登录中…' : '登录'}
          </button>

          <p className="muted text-center text-[11px] leading-relaxed">
            忘记密码？本地账号体系不提供自助找回，
            <br />
            请联系管理员在「账号管理」中重置。
          </p>
        </form>

        <p className="muted mt-5 text-center text-[11px]">
          登录会话通过 httpOnly Cookie 保存，变更类操作需校验 CSRF 令牌。
        </p>
      </div>
    </div>
  );
}
