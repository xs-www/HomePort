/**
 * 路由与守卫装配。
 *
 * 守卫规则（与后端权限矩阵一一对应）：
 * - 未登录 → `/login`
 * - 系统未初始化 → `/setup`（无论访问哪个路径）
 * - 已登录访问 `/login` 或 `/setup` → 跳回首页
 * - viewer 访问 `/admin` 或 `/admin/services` → 403 页面（后端也会独立拒绝）
 */
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AuthProvider, useAuth } from './auth/AuthProvider.js';
import { Icon } from './components/ui.js';
import { AppShell } from './layout/AppShell.js';
import { AdminPage } from './pages/AdminPage.js';
import { AdminServicesPage } from './pages/AdminServicesPage.js';
import { ContainerDetailPage } from './pages/ContainerDetailPage.js';
import { ContainersPage } from './pages/ContainersPage.js';
import { DevicesPage } from './pages/DevicesPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { OverviewPage } from './pages/OverviewPage.js';
import { ServiceDetailPage } from './pages/ServiceDetailPage.js';
import { ServicesPage } from './pages/ServicesPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { SystemPage } from './pages/SystemPage.js';
import { ToolsPage } from './pages/ToolsPage.js';

/** 全屏加载态（会话探测期间）。 */
function BootScreen(): ReactNode {
  return (
    <div className="grid min-h-screen place-items-center">
      <div className="flex flex-col items-center gap-3">
        <div className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-sky-500 to-cyan-400 text-white shadow-lg shadow-sky-500/20">
          <Icon name="container" className="size-6" />
        </div>
        <p className="muted text-xs">正在连接门户…</p>
      </div>
    </div>
  );
}

/** 需要登录的页面外壳。 */
function Protected({ children }: { children: ReactNode }): ReactNode {
  const { ready, user, setupRequired } = useAuth();
  const location = useLocation();

  if (!ready) return <BootScreen />;
  if (setupRequired) return <Navigate to="/setup" replace />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

/** 仅管理员可见。 */
function AdminOnly({ children }: { children: ReactNode }): ReactNode {
  const { isAdmin } = useAuth();
  if (!isAdmin) return <ForbiddenPage />;
  return <>{children}</>;
}

function ForbiddenPage(): ReactNode {
  return (
    <AppShell title="权限不足">
      <div className="card px-6 py-12 text-center">
        <p className="text-3xl">🔒</p>
        <h2 className="mt-3 text-base font-semibold">需要管理员权限</h2>
        <p className="muted mt-1 text-xs">当前账号为只读用户，无法访问账号管理功能。</p>
      </div>
    </AppShell>
  );
}

/** 登录页守卫：已登录则跳回来源页。 */
function GuestOnly({ children }: { children: ReactNode }): ReactNode {
  const { ready, user, setupRequired } = useAuth();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  if (!ready) return <BootScreen />;
  if (setupRequired) return <Navigate to="/setup" replace />;
  if (user) return <Navigate to={from} replace />;
  return <>{children}</>;
}

/** 路由表。 */
function AppRoutes(): ReactNode {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <GuestOnly>
            <LoginPage />
          </GuestOnly>
        }
      />
      <Route path="/setup" element={<SetupPage />} />

      {/* 首页 = 服务墙（Sprint 1） */}
      <Route
        path="/"
        element={
          <Protected>
            <ServicesPage />
          </Protected>
        }
      />
      {/* 原首页改为「总览」，保留原有全部内容 */}
      <Route
        path="/overview"
        element={
          <Protected>
            <OverviewPage />
          </Protected>
        }
      />
      {/* 服务详情：viewer 也可查看（hidden 服务对非管理员返回 404） */}
      <Route
        path="/services/:id"
        element={
          <Protected>
            <ServiceDetailPage />
          </Protected>
        }
      />
      <Route
        path="/containers"
        element={
          <Protected>
            <ContainersPage />
          </Protected>
        }
      />
      <Route
        path="/containers/:id"
        element={
          <Protected>
            <ContainerDetailPage />
          </Protected>
        }
      />
      <Route
        path="/devices"
        element={
          <Protected>
            <DevicesPage />
          </Protected>
        }
      />
      <Route
        path="/system"
        element={
          <Protected>
            <SystemPage />
          </Protected>
        }
      />
      <Route
        path="/tools"
        element={
          <Protected>
            <ToolsPage />
          </Protected>
        }
      />
      <Route
        path="/admin"
        element={
          <Protected>
            <AdminOnly>
              <AdminPage />
            </AdminOnly>
          </Protected>
        }
      />
      {/* 服务管理（Sprint 1）：服务配置可写，因此单独一个 adminOnly 子页面 */}
      <Route
        path="/admin/services"
        element={
          <Protected>
            <AdminOnly>
              <AdminServicesPage />
            </AdminOnly>
          </Protected>
        }
      />
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

export function App(): ReactNode {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
