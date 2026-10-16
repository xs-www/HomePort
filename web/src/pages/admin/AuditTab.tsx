/**
 * 账号管理 · 审计日志标签页（F5，仅管理员）。
 *
 * 职责：按时间倒序展示最近 100 条审计记录（时间、操作者、动作、详情、来源 IP），
 * 并把后端动作码（如 `user.create`）翻译成中文文案，未知动作码原样展示。
 *
 * 数据由 `AdminPage` 懒加载后经 props 传入；本组件只负责展示与手动刷新。
 */
import type { ReactNode } from 'react';
import { Card, ErrorNotice, Icon, Skeleton } from '../../components/ui.js';
import { formatDateTime } from '../../lib/format.js';

export function AuditTab({
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