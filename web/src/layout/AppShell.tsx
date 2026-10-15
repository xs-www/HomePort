/**
 * 应用外壳布局：侧边导航 + 顶栏 + 内容区。
 *
 * 响应式策略：`>= lg` 固定侧栏；`< lg` 抽屉式侧栏（由顶栏按钮控制）。
 */
import { useEffect, useState, type ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuth } from '../auth/AuthProvider.js';
import { Icon } from '../components/ui.js';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  adminOnly?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '总览', icon: 'overview' },
  { to: '/containers', label: '容器', icon: 'container' },
  { to: '/devices', label: 'tailnet 设备', icon: 'devices' },
  { to: '/system', label: '系统指标', icon: 'system' },
  { to: '/tools', label: '工具入口', icon: 'tools' },
  { to: '/admin', label: '账号管理', icon: 'admin', adminOnly: true },
];

export interface AppShellProps {
  children: ReactNode;
  /** 顶栏右侧额外内容（如实时状态、刷新按钮） */
  topbarExtra?: ReactNode;
  /** 顶栏标题覆盖（默认取当前路由名） */
  title?: string;
}

export function AppShell({ children, topbarExtra, title }: AppShellProps): ReactNode {
  const { user, logout, preferences, updatePreferences, apiVersion } = useAuth();
  const location = useLocation();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // 抽屉在路由切换后自动收起
  useEffect(() => {
    setDrawerOpen(false);
  }, [location.pathname]);

  const items = NAV_ITEMS.filter((item) => !item.adminOnly || user?.role === 'admin');
  const activeLabel = items.find((item) => item.to === location.pathname)?.label ?? title ?? '门户';

  const theme = preferences?.theme ?? 'dark';
  const cycleTheme = (): void => {
    const next = theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark';
    void updatePreferences({ theme: next }).catch(() => {
      // 忽略：偏好保存失败不影响本地浏览
    });
  };

  return (
    <div className="flex min-h-screen">
      {/* 侧栏 */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-64 shrink-0 transform border-r border-slate-200/80 bg-white/95 backdrop-blur transition-transform duration-200 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0 dark:border-white/8 dark:bg-ink-900/80 ${
          drawerOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex h-full flex-col">
          {/* 品牌区 */}
          <div className="flex items-center gap-3 px-5 py-4">
            <div className="grid size-9 place-items-center rounded-xl bg-gradient-to-br from-sky-500 to-cyan-400 text-white shadow-lg shadow-sky-500/20">
              <Icon name="container" className="size-5" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">HomePage</p>
              <p className="muted truncate text-[11px]">Tailnet 控制面板</p>
            </div>
          </div>

          {/* 导航 */}
          <nav className="scroll-thin flex-1 space-y-1 overflow-y-auto px-3 py-2">
            {items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition ${
                    isActive
                      ? 'bg-sky-500/12 font-medium text-sky-600 ring-1 ring-sky-500/25 dark:text-sky-300'
                      : 'text-slate-600 hover:bg-slate-100 dark:text-ink-300 dark:hover:bg-white/6'
                  }`
                }
              >
                <Icon name={item.icon} className="size-4" />
                <span className="truncate">{item.label}</span>
              </NavLink>
            ))}
          </nav>

          {/* 用户区 */}
          <div className="border-t border-slate-200/80 px-3 py-3 dark:border-white/8">
            <div className="flex items-center gap-2.5 rounded-xl px-2.5 py-2">
              <div className="grid size-8 shrink-0 place-items-center rounded-full bg-slate-200 text-xs font-semibold dark:bg-white/10">
                {(user?.displayName ?? user?.username ?? '?').slice(0, 1).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{user?.displayName ?? user?.username}</p>
                <p className="muted text-[11px]">{user?.role === 'admin' ? '管理员' : '只读用户'}</p>
              </div>
            </div>
            <div className="mt-1.5 flex items-center gap-1.5">
              <button type="button" className="btn btn-ghost flex-1 px-2 py-1.5 text-xs" onClick={cycleTheme} title="切换主题">
                <Icon name={theme === 'light' ? 'sun' : 'moon'} className="size-3.5" />
                {theme === 'dark' ? '暗色' : theme === 'light' ? '亮色' : '跟随系统'}
              </button>
              <button type="button" className="btn btn-ghost px-2 py-1.5 text-xs" onClick={() => void logout()} title="退出登录">
                <Icon name="logout" className="size-3.5" />
                退出
              </button>
            </div>
            {apiVersion ? <p className="muted mt-2 px-1 text-[10px]">服务端 v{apiVersion}</p> : null}
          </div>
        </div>
      </aside>

      {/* 抽屉遮罩 */}
      {drawerOpen ? (
        <button
          type="button"
          aria-label="关闭导航"
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}

      {/* 主区域 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur dark:border-white/8 dark:bg-ink-950/70">
          <div className="flex items-center gap-3 px-4 py-3 sm:px-6">
            <button
              type="button"
              className="btn btn-ghost px-2 py-1.5 lg:hidden"
              onClick={() => setDrawerOpen((open) => !open)}
              aria-label="打开导航"
            >
              <Icon name="menu" className="size-4" />
            </button>
            <h1 className="min-w-0 flex-1 truncate text-sm font-semibold sm:text-base">{activeLabel}</h1>
            {topbarExtra}
          </div>
        </header>

        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-6">
          <div className="mx-auto w-full max-w-7xl space-y-5">{children}</div>
        </main>

        <footer className="muted px-4 pb-6 text-center text-[11px] sm:px-6">
          HomePage 门户 · 只读展示，不提供容器写操作 · 数据源不可用时会在对应卡片上标注原因
        </footer>
      </div>
    </div>
  );
}
