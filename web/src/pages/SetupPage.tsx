/**
 * 首启初始化页（bootstrap）。
 *
 * 触发条件：后端用户表为空（`setupRequired: true`）。
 * 需要「首启令牌」——它由服务端启动时打印到日志并写入 `data/setup-token.txt`，
 * 或用环境变量 `PORTAL_SETUP_TOKEN` 指定。
 *
 * 首个账号**强制**为管理员（后端保证，前端不可选角色）。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { ApiError } from '../api/client.js';
import { Icon } from '../components/ui.js';

export function SetupPage(): ReactNode {
  const { bootstrap, setupRequired } = useAuth();
  const navigate = useNavigate();

  const [token, setToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [displayName, setDisplayName] = useState('管理员');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    if (password !== confirm) {
      setError('两次输入的密码不一致');
      return;
    }

    setSubmitting(true);
    try {
      await bootstrap({ token: token.trim(), username: username.trim(), password, displayName: displayName.trim() });
      navigate('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError(err instanceof Error ? err.message : '初始化失败');
      }
    } finally {
      setSubmitting(false);
    }
  };

  /** 已初始化后再访问本页：给出明确指引而不是报错。 */
  if (!setupRequired) {
    return (
      <div className="grid min-h-screen place-items-center px-4">
        <div className="card max-w-sm px-6 py-8 text-center">
          <p className="text-2xl">✅</p>
          <h1 className="mt-3 text-base font-semibold">系统已初始化</h1>
          <p className="muted mt-1 text-xs">管理员账号已存在，请直接登录。</p>
          <button type="button" className="btn btn-primary mt-5 w-full" onClick={() => navigate('/login', { replace: true })}>
            前往登录
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-7 flex flex-col items-center gap-3 text-center">
          <div className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-sky-500 to-cyan-400 text-white shadow-xl shadow-sky-500/25">
            <Icon name="shield" className="size-6.5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold">首次启动 · 创建管理员</h1>
            <p className="muted mt-1 text-xs">这一步只执行一次，创建的账号拥有全部管理权限</p>
          </div>
        </div>

        <form onSubmit={onSubmit} className="card space-y-4 px-6 py-6">
          <div>
            <label className="label" htmlFor="token">
              首启令牌
            </label>
            <input
              id="token"
              className="input font-mono"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              placeholder="XXXXXX-XXXXXX-XXXXXX-XXXXXX"
              required
            />
            <p className="muted mt-1.5 text-[11px] leading-relaxed">
              在服务端日志（<code className="font-mono">docker logs</code>）或{' '}
              <code className="font-mono">data/setup-token.txt</code> 中查看；也可用环境变量{' '}
              <code className="font-mono">PORTAL_SETUP_TOKEN</code> 指定。
            </p>
            {fieldErrors.token ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.token[0]}</p> : null}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className="label" htmlFor="username">
                用户名
              </label>
              <input
                id="username"
                className="input"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="username"
                required
              />
              {fieldErrors.username ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.username[0]}</p> : null}
            </div>
            <div>
              <label className="label" htmlFor="displayName">
                显示名
              </label>
              <input
                id="displayName"
                className="input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="管理员"
              />
            </div>
          </div>

          <div>
            <label className="label" htmlFor="password">
              密码
            </label>
            <input
              id="password"
              type="password"
              className="input"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
            <p className="muted mt-1.5 text-[11px]">
              至少 10 位，且包含大小写字母、数字、符号中的任意两类
            </p>
            {fieldErrors.password ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.password[0]}</p> : null}
          </div>

          <div>
            <label className="label" htmlFor="confirm">
              确认密码
            </label>
            <input
              id="confirm"
              type="password"
              className="input"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              required
            />
          </div>

          {error ? (
            <p className="rounded-xl bg-rose-500/10 px-3 py-2 text-xs text-rose-600 ring-1 ring-rose-500/25 dark:text-rose-300">
              {error}
            </p>
          ) : null}

          <button type="submit" className="btn btn-primary w-full" disabled={submitting}>
            {submitting ? '创建中…' : '创建管理员并进入门户'}
          </button>
        </form>
      </div>
    </div>
  );
}
