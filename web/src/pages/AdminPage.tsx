/**
 * 账号管理页（F5，仅管理员）。
 *
 * 职责：只保留路由级数据加载、标签页骨架与 props 分发 ——
 * 用户列表与审计日志在这里取数，再连同回调传给对应标签页。
 * 各标签页的实现分别在 `./admin/UsersTab.tsx`（用户与权限）、
 * `./admin/AuditTab.tsx`（审计日志）、`./admin/SecurityTab.tsx`（安全与偏好）、
 * `./admin/SettingsPanel.tsx`（系统设置）。
 *
 * 后端会独立校验权限与「最后一个管理员」保护，本页的禁用状态只是体验优化。
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useAuth } from '../auth/AuthProvider.js';
import { Icon } from '../components/ui.js';
import { useAsync } from '../hooks/useAsync.js';
import { Shell } from '../layout/Shell.js';
import { AuditTab } from './admin/AuditTab.js';
import { SecurityTab } from './admin/SecurityTab.js';
import { SettingsPanel } from './admin/SettingsPanel.js';
import { UsersTab } from './admin/UsersTab.js';

type Tab = 'users' | 'audit' | 'security' | 'settings';

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
            { value: 'settings', label: '系统设置', icon: 'system' },
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

      {tab === 'settings' ? <SettingsPanel /> : null}
    </Shell>
  );
}