/**
 * 账号管理 · 用户与权限标签页（F5，仅管理员）。
 *
 * 职责：展示账号列表（用户名/显示名、角色、启用状态、最近登录、是否启用两步验证），
 * 并提供改角色、禁用/启用、重置密码、强制下线、**重置两步验证**、删除等操作，
 * 以及新建用户表单与重置密码弹窗。
 *
 * 数据由 `AdminPage` 统一加载后经 props 传入；本组件只负责交互与展示。
 * 后端会独立校验权限与「最后一个管理员」保护，这里对当前账号的删除禁用只是体验优化。
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { useAuth } from '../../auth/AuthProvider.js';
import { Badge, Card, ErrorNotice, Icon, Skeleton } from '../../components/ui.js';
import { useSubmit } from '../../hooks/useAsync.js';
import { formatRelative } from '../../lib/format.js';
import type { SessionUser } from '../../api/types.js';

export function UsersTab({
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

  const act = async <T,>(
    id: number,
    action: () => Promise<T>,
    successMessage: string | ((result: T) => string),
  ): Promise<void> => {
    setBusyUser(id);
    setNotice(null);
    try {
      const result = await action();
      setNotice(typeof successMessage === 'function' ? successMessage(result) : successMessage);
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
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge tone={user.disabled ? 'idle' : 'ok'} dot>
                            {user.disabled ? '已禁用' : '启用'}
                          </Badge>
                          {user.totpEnabled ? <Badge tone="brand">两步验证已启用</Badge> : null}
                        </div>
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
                          {user.totpEnabled ? (
                            <button
                              type="button"
                              className="btn btn-ghost px-2 py-1 text-[11px]"
                              disabled={busy}
                              title="清除该用户的两步验证绑定，并吊销其全部会话"
                              onClick={() => {
                                if (
                                  !confirm(
                                    `确认重置 ${user.username} 的两步验证？\n\n` +
                                      '该用户的两步验证绑定会被清除，其全部登录会话会被吊销：' +
                                      '用户会立即掉线，需重新登录并重新绑定验证器。此操作不可撤销。',
                                  )
                                ) {
                                  return;
                                }
                                void act(
                                  user.id,
                                  () => api.resetUserTotp(user.id),
                                  (result) =>
                                    `已重置 ${user.username} 的两步验证，吊销 ${result.revokedSessions} 个会话；该用户需重新登录并重新绑定`,
                                );
                              }}
                            >
                              重置两步验证
                            </button>
                          ) : null}
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