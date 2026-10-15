/**
 * 账号管理页（F5，仅管理员）。
 *
 * 功能：用户列表与创建、角色调整、禁用/启用、重置密码、强制下线、审计日志。
 * 后端会独立校验权限与「最后一个管理员」保护，本页的禁用状态只是体验优化。
 */
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import { Badge, Card, ErrorNotice, Icon, Skeleton } from '../components/ui.js';
import { useAsync, useSubmit } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { formatDateTime, formatRelative } from '../lib/format.js';
import type { SessionUser, UserPreferences } from '../api/types.js';

type Tab = 'users' | 'audit' | 'security';

export function AdminPage(): ReactNode {
  const { api, user: currentUser, preferences, updatePreferences } = useAuth();
  const [tab, setTab] = useState<Tab>('users');

  const loadUsers = useCallback(() => api.users(), [api]);
  const users = useAsync(loadUsers, { refreshIntervalMs: 30_000 });

  const loadAudit = useCallback(() => api.auditLog(100), [api]);
  const audit = useAsync(loadAudit, { immediate: false });

  return (
    <Shell>
      {/* 标签页 */}
      <div className="flex flex-wrap gap-1.5">
        {(
          [
            { value: 'users', label: '用户与权限', icon: 'user' },
            { value: 'audit', label: '审计日志', icon: 'log' },
            { value: 'security', label: '安全与偏好', icon: 'shield' },
          ] as Array<{ value: Tab; label: string; icon: string }>
        ).map((item) => (
          <button
            key={item.value}
            type="button"
            onClick={() => {
              setTab(item.value);
              if (item.value === 'audit' && !audit.loaded) void audit.reload();
            }}
            className={`inline-flex items-center gap-2 rounded-xl px-3.5 py-2 text-xs transition ${
              tab === item.value
                ? 'bg-sky-500/15 font-medium text-sky-600 ring-1 ring-sky-500/30 dark:text-sky-300'
                : 'text-slate-600 hover:bg-slate-100 dark:text-ink-300 dark:hover:bg-white/6'
            }`}
          >
            <Icon name={item.icon} className="size-3.5" />
            {item.label}
          </button>
        ))}
      </div>

      {tab === 'users' ? (
        <UsersTab
          users={users.data?.items ?? []}
          loading={users.loading && !users.data}
          error={users.error}
          reload={() => void users.reload()}
          currentUserId={currentUser?.id ?? -1}
        />
      ) : null}

      {tab === 'audit' ? (
        <AuditTab
          items={audit.data?.items ?? []}
          loading={audit.loading}
          error={audit.error}
          reload={() => void audit.reload()}
        />
      ) : null}

      {tab === 'security' ? <SecurityTab preferences={preferences} onChange={updatePreferences} /> : null}
    </Shell>
  );
}

// ---------------------------------------------------------------- 用户标签页

function UsersTab({
  users,
  loading,
  error,
  reload,
  currentUserId,
}: {
  users: SessionUser[];
  loading: boolean;
  error: string | null;
  reload: () => void;
  currentUserId: number;
}): ReactNode {
  const { api } = useAuth();
  const [showCreate, setShowCreate] = useState(false);
  const [busyUser, setBusyUser] = useState<number | null>(null);
  const [resetTarget, setResetTarget] = useState<SessionUser | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const act = async (id: number, action: () => Promise<unknown>, successMessage: string): Promise<void> => {
    setBusyUser(id);
    setNotice(null);
    try {
      await action();
      setNotice(successMessage);
      reload();
    } catch (err) {
      setNotice(err instanceof Error ? `操作失败：${err.message}` : '操作失败');
    } finally {
      setBusyUser(null);
    }
  };

  return (
    <>
      {notice ? (
        <p className="rounded-xl bg-sky-500/10 px-3 py-2 text-xs text-sky-700 ring-1 ring-sky-500/25 dark:text-sky-300">{notice}</p>
      ) : null}
      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}

      <Card
        title="用户"
        subtitle={`共 ${users.length} 个账号 · 至少保留一个启用状态的管理员`}
        actions={
          <button type="button" className="btn btn-primary" onClick={() => setShowCreate((open) => !open)}>
            <Icon name="plus" className="size-3.5" />
            新建用户
          </button>
        }
        bodyClassName={showCreate ? 'pt-4' : 'p-0'}
      >
        {showCreate ? <CreateUserForm onDone={() => { setShowCreate(false); reload(); }} /> : null}

        {loading ? (
          <div className="px-5 py-4">
            <Skeleton rows={4} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="muted border-b border-slate-200/70 dark:border-white/6">
                <tr>
                  <th className="px-5 py-2.5 font-medium">账号</th>
                  <th className="px-3 py-2.5 font-medium">角色</th>
                  <th className="px-3 py-2.5 font-medium">状态</th>
                  <th className="px-3 py-2.5 font-medium">最近登录</th>
                  <th className="px-5 py-2.5 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-white/5">
                {users.map((user) => {
                  const isSelf = user.id === currentUserId;
                  const busy = busyUser === user.id;
                  return (
                    <tr key={user.id} className="transition hover:bg-sky-500/5">
                      <td className="px-5 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium">{user.displayName || user.username}</span>
                          {isSelf ? <Badge tone="brand">当前账号</Badge> : null}
                        </div>
                        <p className="muted font-mono text-[10px]">
                          {user.username} · #{user.id}
                        </p>
                      </td>
                      <td className="px-3 py-2.5">
                        <select
                          className="input w-auto px-2 py-1 text-[11px]"
                          value={user.role}
                          disabled={busy}
                          onChange={(event) =>
                            void act(
                              user.id,
                              () => api.updateUser(user.id, { role: event.target.value as 'admin' | 'viewer' }),
                              `已更新 ${user.username} 的角色`,
                            )
                          }
                        >
                          <option value="admin">管理员</option>
                          <option value="viewer">只读</option>
                        </select>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={user.disabled ? 'idle' : 'ok'} dot>
                          {user.disabled ? '已禁用' : '启用'}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5 whitespace-nowrap">{formatRelative(user.lastLoginAt)}</td>
                      <td className="px-5 py-2.5">
                        <div className="flex flex-wrap items-center justify-end gap-1.5">
                          <button
                            type="button"
                            className="btn btn-ghost px-2 py-1 text-[11px]"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                user.id,
                                () => api.updateUser(user.id, { disabled: !user.disabled }),
                                user.disabled ? `已启用 ${user.username}` : `已禁用 ${user.username}`,
                              )
                            }
                          >
                            {user.disabled ? '启用' : '禁用'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost px-2 py-1 text-[11px]"
                            disabled={busy}
                            onClick={() => setResetTarget(user)}
                          >
                            重置密码
                          </button>
                          <button
                            type="button"
                            className="btn btn-ghost px-2 py-1 text-[11px]"
                            disabled={busy}
                            onClick={() =>
                              void act(
                                user.id,
                                () => api.revokeUserSessions(user.id),
                                `已强制 ${user.username} 下线`,
                              )
                            }
                          >
                            强制下线
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger px-2 py-1 text-[11px]"
                            disabled={busy || isSelf}
                            title={isSelf ? '不能删除当前登录账号' : '删除该账号'}
                            onClick={() => {
                              if (!confirm(`确认删除账号 ${user.username}？此操作不可恢复。`)) return;
                              void act(user.id, () => api.deleteUser(user.id), `已删除 ${user.username}`);
                            }}
                          >
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {resetTarget ? (
        <ResetPasswordDialog
          user={resetTarget}
          onClose={() => setResetTarget(null)}
          onDone={(message) => {
            setResetTarget(null);
            setNotice(message);
            reload();
          }}
        />
      ) : null}
    </>
  );
}

/** 新建用户表单。 */
function CreateUserForm({ onDone }: { onDone: () => void }): ReactNode {
  const { api } = useAuth();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'admin' | 'viewer'>('viewer');
  const { submitting, error, fieldErrors, submit } = useSubmit();

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const ok = await submit(async () => {
      await api.createUser({ username: username.trim(), password, displayName: displayName.trim(), role });
    });
    if (ok) onDone();
  };

  return (
    <form onSubmit={onSubmit} className="mb-4 space-y-3 rounded-xl bg-slate-500/6 px-4 py-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <label className="label">用户名</label>
          <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="viewer01" required />
          {fieldErrors.username ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.username[0]}</p> : null}
        </div>
        <div>
          <label className="label">显示名</label>
          <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="访客" />
        </div>
        <div>
          <label className="label">密码</label>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 10 位"
            required
          />
          {fieldErrors.password ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.password[0]}</p> : null}
        </div>
        <div>
          <label className="label">角色</label>
          <select className="input" value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'viewer')}>
            <option value="viewer">只读（可查看全部页面）</option>
            <option value="admin">管理员（可管理账号）</option>
          </select>
        </div>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? '创建中…' : '创建'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onDone}>
          取消
        </button>
      </div>
    </form>
  );
}

/** 重置密码弹窗。 */
function ResetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: SessionUser;
  onClose: () => void;
  onDone: (message: string) => void;
}): ReactNode {
  const { api } = useAuth();
  const [password, setPassword] = useState('');
  const { submitting, error, fieldErrors, submit } = useSubmit();

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    const ok = await submit(async () => {
      const result = await api.resetUserPassword(user.id, password);
      onDone(`已重置 ${user.username} 的密码，并吊销 ${result.revoked} 个会话`);
    });
    if (!ok) return;
  };

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/45 px-4 backdrop-blur-sm">
      <form onSubmit={onSubmit} className="card w-full max-w-sm space-y-4 px-5 py-5">
        <div>
          <h3 className="text-sm font-semibold">重置密码</h3>
          <p className="muted mt-1 text-xs">
            为 <span className="font-medium">{user.username}</span> 设置新密码；该用户所有会话将立即失效。
          </p>
        </div>
        <div>
          <label className="label">新密码</label>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
            required
          />
          <p className="muted mt-1.5 text-[11px]">至少 10 位，且包含大小写字母、数字、符号中的任意两类</p>
          {fieldErrors.newPassword ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.newPassword[0]}</p> : null}
        </div>
        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" className="btn btn-primary" disabled={submitting || password === ''}>
            {submitting ? '提交中…' : '确认重置'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------- 审计标签页

function AuditTab({
  items,
  loading,
  error,
  reload,
}: {
  items: Array<{ id: number; at: string; actorName: string | null; action: string; target: string | null; detail: string | null; ip: string | null }>;
  loading: boolean;
  error: string | null;
  reload: () => void;
}): ReactNode {
  const actionLabel: Record<string, string> = {
    'auth.login': '登录',
    'auth.login_failed': '登录失败',
    'auth.logout': '登出',
    'auth.bootstrap': '初始化管理员',
    'auth.password_changed': '修改密码',
    'user.create': '创建用户',
    'user.update': '更新用户',
    'user.delete': '删除用户',
    'user.password_reset': '重置密码',
    'user.sessions_revoked': '强制下线',
  };

  return (
    <>
      {error ? <ErrorNotice message={error} onRetry={reload} /> : null}
      <Card
        title="审计日志"
        subtitle="保留最近 90 天，最多展示 100 条"
        actions={
          <button type="button" className="btn btn-ghost" onClick={reload} disabled={loading}>
            <Icon name="refresh" className="size-3.5" />
            刷新
          </button>
        }
        bodyClassName="p-0"
      >
        {loading ? (
          <div className="px-5 py-4">
            <Skeleton rows={4} />
          </div>
        ) : items.length === 0 ? (
          <p className="muted px-5 py-8 text-center text-xs">暂无审计记录</p>
        ) : (
          <div className="scroll-thin max-h-[32rem] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="muted sticky top-0 border-b border-slate-200/70 bg-white/90 backdrop-blur dark:border-white/6 dark:bg-ink-900/90">
                <tr>
                  <th className="px-5 py-2.5 font-medium">时间</th>
                  <th className="px-3 py-2.5 font-medium">操作者</th>
                  <th className="px-3 py-2.5 font-medium">动作</th>
                  <th className="px-3 py-2.5 font-medium">详情</th>
                  <th className="px-5 py-2.5 font-medium">来源 IP</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200/60 dark:divide-white/5">
                {items.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-5 py-2 whitespace-nowrap">{formatDateTime(entry.at)}</td>
                    <td className="px-3 py-2">{entry.actorName ?? '—'}</td>
                    <td className="px-3 py-2">{actionLabel[entry.action] ?? entry.action}</td>
                    <td className="px-3 py-2">
                      <span className="muted">{entry.detail ?? '—'}</span>
                      {entry.target ? <span className="muted ml-1.5 font-mono text-[10px]">{entry.target}</span> : null}
                    </td>
                    <td className="px-5 py-2 font-mono text-[11px]">{entry.ip ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- 安全标签页

function SecurityTab({
  preferences,
  onChange,
}: {
  preferences: UserPreferences | null;
  onChange: (input: Partial<Pick<UserPreferences, 'theme' | 'density' | 'defaultPage'>>) => Promise<void>;
}): ReactNode {
  const { api, user, logout } = useAuth();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const { submitting, error, fieldErrors, submit } = useSubmit();

  const loadActivity = useCallback(() => api.sessionActivity(), [api]);
  const activity = useAsync(loadActivity, { immediate: false });

  const onSubmit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (newPassword !== confirm) {
      setMessage('两次输入的新密码不一致');
      return;
    }
    const ok = await submit(async () => {
      await api.changePassword({ currentPassword, newPassword });
    });
    if (ok) {
      setCurrentPassword('');
      setNewPassword('');
      setConfirm('');
      setMessage('密码已修改，其它设备的会话已失效');
      void activity.reload();
    } else {
      setMessage(null);
    }
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="修改我的密码" subtitle="修改成功后，除当前会话外的其它会话都会被吊销">
        <form onSubmit={onSubmit} className="space-y-3">
          <div>
            <label className="label">当前密码</label>
            <input
              type="password"
              className="input"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
            {fieldErrors.currentPassword ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.currentPassword[0]}</p> : null}
          </div>
          <div>
            <label className="label">新密码</label>
            <input
              type="password"
              className="input"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              required
            />
            {fieldErrors.newPassword ? <p className="mt-1 text-[11px] text-rose-500">{fieldErrors.newPassword[0]}</p> : null}
          </div>
          <div>
            <label className="label">确认新密码</label>
            <input
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
          {error ? <ErrorNotice message={error} /> : null}
          {message ? (
            <p className="rounded-xl bg-sky-500/10 px-3 py-2 text-xs text-sky-700 ring-1 ring-sky-500/25 dark:text-sky-300">{message}</p>
          ) : null}
          <button type="submit" className="btn btn-primary" disabled={submitting || !currentPassword || !newPassword}>
            {submitting ? '提交中…' : '修改密码'}
          </button>
        </form>
      </Card>

      <div className="space-y-4">
        <Card title="显示偏好">
          <div className="space-y-3 text-xs">
            <div>
              <label className="label">主题</label>
              <select
                className="input"
                value={preferences?.theme ?? 'dark'}
                onChange={(e) => void onChange({ theme: e.target.value as 'dark' | 'light' | 'system' })}
              >
                <option value="dark">暗色</option>
                <option value="light">亮色</option>
                <option value="system">跟随系统</option>
              </select>
            </div>
            <div>
              <label className="label">默认落地页</label>
              <select
                className="input"
                value={preferences?.defaultPage ?? 'overview'}
                onChange={(e) => void onChange({ defaultPage: e.target.value })}
              >
                <option value="overview">总览</option>
                <option value="containers">容器</option>
                <option value="devices">tailnet 设备</option>
                <option value="system">系统指标</option>
                <option value="tools">工具入口</option>
              </select>
            </div>
          </div>
        </Card>

        <Card
          title="当前会话"
          actions={
            <button type="button" className="btn btn-ghost" onClick={() => void activity.reload()}>
              <Icon name="refresh" className="size-3.5" />
              查看
            </button>
          }
        >
          {activity.data ? (
            <div className="space-y-1.5 text-xs">
              <p>
                <span className="muted">会话 ID：</span>
                <span className="font-mono">{activity.data.sessionId}</span>
              </p>
              <p>
                <span className="muted">签发于：</span>
                {formatDateTime(activity.data.createdAt)}
              </p>
              <p>
                <span className="muted">过期于：</span>
                {formatDateTime(activity.data.expiresAt)}
              </p>
              <p>
                <span className="muted">最近活跃：</span>
                {formatRelative(activity.data.lastSeenAt)}
              </p>
              <p className="break-all">
                <span className="muted">来源：</span>
                {activity.data.remoteAddr ?? '—'}
              </p>
              <p className="break-all">
                <span className="muted">客户端：</span>
                {activity.data.userAgent ?? '—'}
              </p>
            </div>
          ) : (
            <p className="muted text-xs">点击「查看」读取当前会话信息</p>
          )}
        </Card>

        <Card title="账号信息">
          <div className="space-y-1.5 text-xs">
            <p>
              <span className="muted">用户名：</span>
              <span className="font-mono">{user?.username}</span>
            </p>
            <p>
              <span className="muted">角色：</span>
              {user?.role === 'admin' ? '管理员' : '只读用户'}
            </p>
            <p>
              <span className="muted">创建时间：</span>
              {formatDateTime(user?.createdAt)}
            </p>
          </div>
          <button type="button" className="btn btn-danger mt-4" onClick={() => void logout()}>
            <Icon name="logout" className="size-3.5" />
            退出登录
          </button>
        </Card>
      </div>
    </div>
  );
}
