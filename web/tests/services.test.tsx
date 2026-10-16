/**
 * 首页服务墙 `ServicesPage` 组件测试（Sprint 1 · S1-04）。
 *
 * 覆盖：
 * 1. 卡片 / 分类分组 / 收藏区（收藏**不重复**出现在分类里）、未分类排最后；
 * 2. **三个独立状态点**（容器 / 可达 / 健康）分别渲染且解释文案互不相同；
 * 3. 数据源降级提示必须透出 `discovery.notes` / `serveDetail`（含 "Docker" 字样）；
 * 4. 空态（admin 有「新建服务」入口，viewer 只有说明）；
 * 5. **viewer 不渲染任何管理入口**，且「查看所有候选入口」里不可达入口被明确标注。
 *
 * 全部走假 fetch，不发真实请求；断言只依赖 `textContent` / `getAttribute` / `querySelector`
 * （仓库没有 `@testing-library/jest-dom`）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SessionUser } from '../src/api/types.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { ServiceDetailPage } from '../src/pages/ServiceDetailPage.js';
import { ServicesPage } from '../src/pages/ServicesPage.js';
import {
  baseRoutes,
  callsTo,
  discoveryState,
  jsonResponse,
  listResponse,
  serviceView,
  sessionUser,
  stubFetch,
  type Handler,
  type RecordedCall,
} from './serviceTestUtils.js';

/**
 * 先装假 fetch，再渲染服务墙。
 *
 * 顺序很重要：`ServicesPage` 挂载时立刻请求 `/api/services`，
 * 先渲染会让首个请求打到未安装的 fetch 上。
 */
function renderWall(routes: Record<string, Handler>): { calls: RecordedCall[]; container: HTMLElement; unmount: () => void } {
  const calls = stubFetch(routes);
  const view = render(
    <MemoryRouter>
      <AuthProvider>
        <ServicesPage />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { calls, container: view.container, unmount: view.unmount };
}

/** admin 视角的常用假路由。 */
function wallRoutes(user: SessionUser, payload: unknown): Record<string, Handler> {
  return {
    ...baseRoutes(user),
    '/api/services': () => jsonResponse(payload),
  };
}

/** 取某个服务卡片所在的 DOM 子树。 */
function cardOf(container: HTMLElement, id: string): HTMLElement {
  const card = container.querySelector<HTMLElement>(`[data-service-id="${id}"]`);
  if (!card) throw new Error(`没有找到服务卡片：${id}`);
  return card;
}

/** 卡片上的某个状态点（内含 Badge）。 */
function statusPoint(card: HTMLElement, key: 'container' | 'reachable' | 'health'): HTMLElement {
  const badge = card.querySelector<HTMLElement>(`[data-status="${key}"] .badge`);
  if (!badge) throw new Error(`没有找到状态点：${key}`);
  return badge;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('服务墙 · 卡片与分组', () => {
  it('渲染卡片、收藏区与分类分组（收藏不重复出现、未分类最后）', async () => {
    const favorite = serviceView({ id: 'svc-fav', displayName: '家庭日历', category: '家庭', favorite: true });
    const dev = serviceView({ id: 'svc-dev', displayName: 'Gitea', category: '开发', sortOrder: 20, favorite: false });
    const loose = serviceView({ id: 'svc-loose', displayName: '散装服务', category: null, sortOrder: 30 });

    const { calls } = renderWall(wallRoutes(sessionUser(), listResponse([favorite, dev, loose])));

    expect(await screen.findByText('Gitea')).toBeTruthy();
    expect(callsTo(calls, '/api/services')).toHaveLength(1);

    const groups = Array.from(document.querySelectorAll('[data-service-group]')).map((node) =>
      node.getAttribute('data-service-group'),
    );
    expect(groups).toEqual(['收藏', '开发', '未分类']);

    // 收藏项只出现一次（不重复渲染到分类里），可访问名 = displayName
    expect(screen.getAllByRole('link', { name: '家庭日历' })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Gitea' })).toBeTruthy();
    expect(screen.getByText(/共 3 个服务/)).toBeTruthy();
  });

  it('三个状态点分别渲染，且互不相同（绝不合并成一句"挂了"）', async () => {
    const broken = serviceView({
      id: 'svc-broken',
      displayName: 'CS22',
      category: '项目',
      status: {
        container: 'stopped',
        reachable: false,
        health: 'fail',
        reasons: ['容器未运行（exited）', '所有候选入口都只能在宿主机本机访问', '健康检查未通过'],
      },
    });

    const { container } = renderWall(wallRoutes(sessionUser(), listResponse([broken])));
    await screen.findByText('CS22');

    const card = cardOf(container, 'svc-broken');
    expect(card.querySelectorAll('[data-status]')).toHaveLength(3);

    const containerPoint = statusPoint(card, 'container');
    const reachablePoint = statusPoint(card, 'reachable');
    const healthPoint = statusPoint(card, 'health');

    expect(containerPoint.textContent).toContain('容器未运行');
    expect(reachablePoint.textContent).toContain('入口不可达');
    expect(healthPoint.textContent).toContain('健康检查失败');

    // 三个 title 是三条不同的解释（容器 / 入口 / 健康各自的含义）
    const titles = [containerPoint, reachablePoint, healthPoint].map((node) => node.getAttribute('title'));
    expect(new Set(titles).size).toBe(3);
    expect(titles[0]).toMatch(/容器/);
    expect(titles[1]).toMatch(/入口|可达/);
    expect(titles[2]).toMatch(/健康/);

    // reasons 逐条透出
    expect(card.textContent).toContain('容器未运行（exited）');
    expect(card.textContent).toContain('健康检查未通过');
  });

  it('无容器绑定的服务显示"无容器"与"可达性未知"，而不是"不可达"', async () => {
    const manual = serviceView({
      id: 'svc-manual',
      displayName: '手工服务',
      sourceType: 'manual',
      container: null,
      entry: null,
      entryCount: 0,
      entries: [],
      status: { container: null, reachable: null, health: 'skipped', reasons: ['数据源不可用，无法判定入口可达性'] },
    });

    const { container } = renderWall(wallRoutes(sessionUser(), listResponse([manual])));
    await screen.findByText('手工服务');

    const card = cardOf(container, 'svc-manual');
    expect(statusPoint(card, 'container').textContent).toContain('无容器');
    expect(statusPoint(card, 'reachable').textContent).toContain('可达性未知');
    expect(card.textContent).toContain('暂无可达入口');
  });
});

describe('服务墙 · 降级提示与空态', () => {
  it('Docker / Serve 数据源不可读时透出后端给出的原因文案', async () => {
    const payload = listResponse([serviceView()], {
      discovery: discoveryState({
        dockerAvailable: false,
        serveAvailable: false,
        serveDetail: 'API 模式读不到 serve 配置',
        notes: [
          'Docker 不可达：容器状态与端口入口暂时无法判定。',
          '未读到 Tailscale Serve 配置：API 模式读不到 serve 配置（Serve 入口可能缺失，CLI 模式才可读取。）',
        ],
      }),
    });

    renderWall(wallRoutes(sessionUser(), payload));

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Docker');
    expect(notice.textContent).toContain('serve 配置');
    expect(notice.textContent).toContain('CLI 模式');
  });

  it('后端没给说明时也要给出含 "Docker" 的兜底文案（不能静默为空）', async () => {
    const payload = listResponse([], {
      discovery: discoveryState({ dockerAvailable: false, serveAvailable: true, notes: [] }),
    });

    renderWall(wallRoutes(sessionUser(), payload));

    const notice = await screen.findByRole('status');
    expect(notice.textContent).toContain('Docker');
  });

  it('0 个服务时 admin 看到「新建服务」入口', async () => {
    const empty = listResponse([], { discovery: discoveryState() });
    renderWall(wallRoutes(sessionUser(), empty));

    expect(await screen.findByText('还没有发现任何服务')).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建服务' })).toBeTruthy();
  });

  it('0 个服务时 viewer 只看到说明，没有新建入口', async () => {
    const empty = listResponse([], { discovery: discoveryState() });
    renderWall(wallRoutes(sessionUser({ role: 'viewer', username: 'viewer' }), empty));

    expect(await screen.findByText('还没有发现任何服务')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '新建服务' })).toBeNull();
    expect(screen.getByText(/服务由管理员通过自动发现或手工添加/)).toBeTruthy();
  });
});

describe('服务墙 · 权限与候选入口', () => {
  it('viewer 不渲染任何管理入口（编辑 / 收藏 / 新建 / 服务管理）', async () => {
    const payload = listResponse([serviceView({ favorite: false })]);
    renderWall(wallRoutes(sessionUser({ role: 'viewer', username: 'viewer' }), payload));

    await screen.findByText('家庭日历');

    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: /收藏/ })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建服务' })).toBeNull();
    expect(screen.queryByRole('link', { name: '服务管理' })).toBeNull();
    expect(screen.queryByRole('button', { name: '服务管理' })).toBeNull();
    // 只读操作仍在：搜索入口 + 刷新
    expect(screen.getByRole('button', { name: '搜索服务、容器、设备与工具' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
  });

  it('admin 能看到编辑/收藏入口；展开候选入口时不可达项被标注"仅本机/不可达"', async () => {
    const { container } = renderWall(wallRoutes(sessionUser(), listResponse([serviceView()])));

    await screen.findByText('家庭日历');
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '收藏 家庭日历' })).toBeTruthy();
    // admin 才有管理入口：导航里的「服务管理」+ 页面内的「管理服务」
    expect(screen.getByRole('link', { name: '服务管理' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '管理服务' })).toBeTruthy();

    // entryCount=2 → 有「查看所有候选入口」按钮
    const toggle = screen.getByRole('button', { name: /查看所有候选入口（2）/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);

    const card = cardOf(container, 'svc-calendar');
    const unreachable = card.querySelector('[data-entry-accessible="false"]');
    expect(unreachable).not.toBeNull();
    expect(unreachable?.textContent).toContain('仅本机/不可达');

    // 可达入口渲染成新窗口链接
    const reachableLink = card.querySelector('[data-entry-accessible="true"] a');
    expect(reachableLink?.getAttribute('target')).toBe('_blank');
    expect(reachableLink?.getAttribute('rel')).toBe('noreferrer');
  });
});

describe('服务详情页 · /services/:id', () => {
  /** 渲染详情页（必须包 Router：页面用 `useParams` 与 `Link`）。 */
  function renderDetail(routes: Record<string, Handler>): { calls: RecordedCall[]; container: HTMLElement; unmount: () => void } {
    const calls = stubFetch(routes);
    const view = render(
      <MemoryRouter initialEntries={['/services/svc-calendar']}>
        <AuthProvider>
          <Routes>
            <Route path="/services/:id" element={<ServiceDetailPage />} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>,
    );
    return { calls, container: view.container, unmount: view.unmount };
  }

  it('显示三维状态、全部候选（含不可达）与诊断信息', async () => {
    const service = serviceView();
    const { calls } = renderDetail({
      ...baseRoutes(sessionUser()),
      '/api/services/svc-calendar': () =>
        jsonResponse({
          service,
          candidates: service.entries,
          diagnostics: {
            containerPorts: [
              { containerPort: 8080, protocol: 'tcp', hostIp: '127.0.0.1', hostPort: 36065, reachability: 'localhost-only', url: null },
            ],
            serveRoutes: [
              {
                host: 'family-nas.tail585599.ts.net',
                port: 8443,
                path: '/calendar',
                url: 'https://family-nas.tail585599.ts.net:8443/calendar',
                proxy: 'http://127.0.0.1:36065',
                targetPort: 36065,
              },
            ],
            notes: ['serve 路由命中容器 sisi-calendar'],
          },
        }),
    });

    expect(await screen.findByText('家庭日历')).toBeTruthy();
    expect(callsTo(calls, '/api/services/svc-calendar')).toHaveLength(1);

    // 三个状态点
    expect(document.querySelector('[data-status="container"]')?.textContent).toContain('容器运行中');
    expect(document.querySelector('[data-status="reachable"]')?.textContent).toContain('入口可达');
    expect(document.querySelector('[data-status="health"]')?.textContent).toContain('未配置健康检查');

    // 全部候选里不可达项被标注
    expect(document.querySelector('[data-entry-accessible="false"]')?.textContent).toContain('仅本机/不可达');

    // 诊断信息（同一段文本可能同时出现在候选列表与诊断表里，因此用 getAllByText）
    expect(screen.getByText('serve 路由命中容器 sisi-calendar')).toBeTruthy();
    expect(screen.getAllByText(/127\.0\.0\.1:36065/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/family-nas\.tail585599\.ts\.net:8443\/calendar/).length).toBeGreaterThan(0);

    // 详情页的标题用 Shell 覆盖（activeLabel 只精确匹配导航项）
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('服务详情');
  });

  it('404 时给出错误提示与返回入口，不白屏', async () => {
    renderDetail({
      ...baseRoutes(sessionUser()),
      '/api/services/svc-calendar': () =>
        jsonResponse({ error: { code: 'NOT_FOUND', message: '服务不存在', details: null } }, 404),
    });

    expect(await screen.findByText('服务不存在')).toBeTruthy();
    expect(screen.getByText(/隐藏服务对非管理员返回 404/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '← 返回服务墙' })).toBeTruthy();
  });

  it('viewer 能看到内容但没有管理按钮；admin 有编辑与健康检查', async () => {
    const service = serviceView();
    const detail = (): Response =>
      jsonResponse({ service, candidates: service.entries, diagnostics: { containerPorts: [], serveRoutes: [], notes: [] } });

    const viewer = renderDetail({
      ...baseRoutes(sessionUser({ role: 'viewer', username: 'viewer' })),
      '/api/services/svc-calendar': detail,
    });
    await screen.findByText('家庭日历');
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull();
    expect(screen.queryByRole('button', { name: '健康检查' })).toBeNull();
    expect(callsTo(viewer.calls, '/api/services/svc-calendar')).toHaveLength(1);
    // 先卸载 viewer 视角，避免 document 里残留两份内容（RTL 的自动 cleanup 只在测试结束后执行）
    viewer.unmount();
    localStorage.clear();

    renderDetail({ ...baseRoutes(sessionUser()), '/api/services/svc-calendar': detail });
    await screen.findByText('家庭日历');
    expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '健康检查' })).toBeTruthy();
  });
});