/**
 * 告警页（`/alerts` · Sprint 2 · S2-04）测试。
 *
 * 覆盖规格 §10 表格里 `web/tests/alertsPage.test.tsx` 那一行，逐条：
 * 1. **viewer 看不到规则表单与确认按钮**（但看得到事件、计数与只读规则）；
 * 2. **admin 改阈值 → `PATCH /api/alerts/rules/:id`**：请求体只含改动过的字段 + CSRF 头；
 * 3. **点「确认」→ `POST /api/alerts/events/:id/ack`**：带 CSRF 头并重取事件；
 * 4. **事件列表展示 `reopenCount` 与恢复状态**；
 * 5. 额外：越界阈值在本地就被拦住（不静默截断、不发请求）；
 * 6. 额外：导航对 viewer 可见，徽标数字取自 `summary.unacknowledged`（0 时不显示）。
 *
 * 全部走假 fetch（沿用 Sprint 1 的 `serviceTestUtils` 风格），不发真实请求。
 * 两个端点的 mock 一律返回 §7 **冻结形状**（`{ items }` 与聚合对象），
 * 前端按冻结类型直接取字段 —— 不再有归一化兜底。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type {
  AlertEventView,
  AlertEventsResponse,
  AlertRuleView,
} from '../src/api/alerts.js';
import type { SessionUser } from '../src/api/types.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { AppShell } from '../src/layout/AppShell.js';
import { AlertsPage } from '../src/pages/AlertsPage.js';
import {
  baseRoutes,
  callsTo,
  jsonResponse,
  sessionUser,
  stubFetch,
  type Handler,
  type RecordedCall,
} from './serviceTestUtils.js';

// ---------------------------------------------------------------- 夹具（§7 冻结形状）

const BUILTIN_RULES: AlertRuleView[] = [
  {
    id: 'rule-disk-percent',
    kind: 'disk_percent',
    name: '磁盘使用率过高',
    description: '任一磁盘使用率超过阈值并持续一段时间',
    enabled: false,
    threshold: 85,
    durationSec: 600,
    target: null,
    silenceSec: 3600,
    notifyRecovery: true,
    severity: 'warning',
    builtin: true,
    updatedAt: '2026-10-15T09:00:00.000Z',
  },
  {
    id: 'rule-memory-percent',
    kind: 'memory_percent',
    name: '内存使用率过高',
    description: '宿主内存使用率超过阈值并持续一段时间',
    enabled: false,
    threshold: 90,
    durationSec: 300,
    target: null,
    silenceSec: 3600,
    notifyRecovery: true,
    severity: 'warning',
    builtin: true,
    updatedAt: '2026-10-15T09:00:00.000Z',
  },
  {
    id: 'rule-container-exit',
    kind: 'container_exit',
    name: '容器异常退出',
    description: '容器以非 0 退出码终止',
    enabled: false,
    threshold: 0,
    durationSec: 0,
    target: null,
    silenceSec: 3600,
    notifyRecovery: true,
    severity: 'critical',
    builtin: true,
    updatedAt: '2026-10-15T09:00:00.000Z',
  },
  {
    id: 'rule-service-health',
    kind: 'service_health',
    name: '服务连续探测失败',
    description: '服务连续失败次数达到阈值',
    enabled: false,
    threshold: 3,
    durationSec: 0,
    target: null,
    silenceSec: 3600,
    notifyRecovery: true,
    severity: 'critical',
    builtin: true,
    updatedAt: '2026-10-15T09:00:00.000Z',
  },
];

function rule(id: string): AlertRuleView {
  const found = BUILTIN_RULES.find((item) => item.id === id);
  if (!found) throw new Error(`夹具里没有规则：${id}`);
  return found;
}

function alertEvent(overrides: Partial<AlertEventView> = {}): AlertEventView {
  return {
    id: 'alert-1',
    ruleId: 'rule-disk-percent',
    kind: 'disk_percent',
    ruleName: '磁盘使用率过高',
    target: 'disk:C:',
    targetLabel: 'C:',
    severity: 'warning',
    state: 'open',
    value: 91.2,
    threshold: 85,
    unit: 'percent',
    message: '磁盘 C: 使用率 91.2%（阈值 85%，已持续 12 分钟）',
    startedAt: '2026-10-15T09:48:00.000Z',
    firedAt: '2026-10-15T10:00:00.000Z',
    resolvedAt: null,
    reopenCount: 0,
    acknowledgedAt: null,
    acknowledgedBy: null,
    ...overrides,
  };
}

/** 三条事件：未恢复未确认（重开 2 次）/ 已恢复已确认 / 已恢复未确认。 */
function eventsPayload(): AlertEventsResponse {
  return {
    items: [
      alertEvent({ id: 'alert-1', reopenCount: 2 }),
      alertEvent({
        id: 'alert-2',
        state: 'resolved',
        resolvedAt: '2026-10-15T10:30:00.000Z',
        acknowledgedAt: '2026-10-15T10:35:00.000Z',
        acknowledgedBy: 'admin',
      }),
      alertEvent({ id: 'alert-3', state: 'resolved', resolvedAt: '2026-10-15T11:00:00.000Z' }),
    ],
    total: 3,
    counts: { open: 1, resolved: 2, unacknowledged: 2 },
  };
}

const EVENTS_URL = (state: string): string => `/api/alerts/events?state=${state}&limit=100`;

function alertsRoutes(user: SessionUser, overrides: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    ...baseRoutes(user),
    [EVENTS_URL('all')]: () => jsonResponse(eventsPayload()),
    [EVENTS_URL('open')]: () => jsonResponse({ ...eventsPayload(), items: [alertEvent({ id: 'alert-1', reopenCount: 2 })] }),
    [EVENTS_URL('resolved')]: () => jsonResponse(eventsPayload()),
    // 冻结形状：列表端点统一 { items }
    '/api/alerts/rules': () => jsonResponse({ items: BUILTIN_RULES }),
    '/api/alerts/rules/rule-disk-percent': () => jsonResponse({ ...rule('rule-disk-percent'), threshold: 90, enabled: true }),
    '/api/alerts/events/alert-1/ack': () => jsonResponse(alertEvent({ acknowledgedAt: '2026-10-15T12:00:00.000Z', acknowledgedBy: 'admin' })),
    '/api/alerts/summary': () =>
      jsonResponse({
        open: 1,
        unacknowledged: 2,
        suppressed: 0,
        bySeverity: { warning: 1, critical: 0 },
        top: [],
        evaluatedAt: '2026-10-15T12:00:00.000Z',
      }),
    ...overrides,
  };
}

// ---------------------------------------------------------------- 渲染工具

function renderAlerts(routes: Record<string, Handler>): { calls: RecordedCall[]; container: HTMLElement; unmount: () => void } {
  const calls = stubFetch(routes);
  const view = render(
    <MemoryRouter initialEntries={['/alerts']}>
      <AuthProvider>
        <AlertsPage />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { calls, container: view.container, unmount: view.unmount };
}

/** 等 AuthProvider 的会话探测落地（此时 CSRF 令牌已注入 API 客户端）。 */
async function waitForSession(calls: RecordedCall[]): Promise<void> {
  await waitFor(() => expect(callsTo(calls, '/api/users/me').length).toBeGreaterThan(0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---------------------------------------------------------------- 权限分层

describe('告警页 · viewer 只读', () => {
  it('viewer 看不到规则表单与确认按钮，但能看事件、计数与只读规则', async () => {
    const { calls, container } = renderAlerts(alertsRoutes(sessionUser({ role: 'viewer', username: 'viewer' })));
    await waitForSession(calls);

    // 规则表用语义化 <table> + caption（可访问名可读）
    await screen.findByRole('table', { name: /告警规则列表/ });
    expect(screen.getAllByText('已关闭')).toHaveLength(4); // 四条内置规则默认关闭（E2E 也断言这条）

    // 规则只读：卡片里一个按钮都没有（没有开关、没有编辑、没有保存）
    const rulesCard = screen.getByTestId('alert-rules');
    expect(within(rulesCard).queryAllByRole('button')).toHaveLength(0);
    expect(within(rulesCard).queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: '确认' })).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /编辑规则/ })).toHaveLength(0);

    // 事件与计数是只读页面该有的东西
    expect(container.querySelectorAll('[data-alert-event-id]')).toHaveLength(3);
    expect(screen.getByText('未确认 2')).toBeTruthy();
    expect(screen.getByText('只读视角：修改规则与确认告警需要管理员权限')).toBeTruthy();
  });

  it('admin 有每条规则的编辑入口与未确认事件的确认按钮（已恢复但未确认的也能确认）', async () => {
    const { calls } = renderAlerts(alertsRoutes(sessionUser()));
    await waitForSession(calls);

    expect(await screen.findByRole('button', { name: '编辑规则 磁盘使用率过高' })).toBeTruthy();
    // alert-1（未恢复未确认）+ alert-3（已恢复未确认）→ 2 个确认按钮；alert-2 已确认 → 没有
    expect(screen.getAllByRole('button', { name: '确认' })).toHaveLength(2);
    expect(document.querySelector('[data-alert-event-id="alert-2"] button')).toBeNull();
  });
});

// ---------------------------------------------------------------- 写操作契约

describe('告警页 · 规则 PATCH 契约', () => {
  it('admin 改阈值 → PATCH /api/alerts/rules/:id，请求体只含改动过的字段并带 CSRF', async () => {
    const { calls } = renderAlerts(alertsRoutes(sessionUser()));
    await waitForSession(calls);

    fireEvent.click(await screen.findByRole('button', { name: '编辑规则 磁盘使用率过高' }));

    const threshold = screen.getByLabelText('阈值') as HTMLInputElement;
    expect(threshold.value).toBe('85');
    expect(threshold.id).toBe('alert-rule-rule-disk-percent-threshold');
    fireEvent.change(threshold, { target: { value: '90' } });

    const form = screen.getByRole('button', { name: '保存' }).closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);

    await waitFor(() => expect(callsTo(calls, '/api/alerts/rules/rule-disk-percent')).toHaveLength(1));
    const call = callsTo(calls, '/api/alerts/rules/rule-disk-percent')[0];
    expect(call?.init.method).toBe('PATCH');
    // 局部更新：只发改动过的字段（未动的 enabled/silenceSec 都不出现）
    expect(call?.body).toEqual({ threshold: 90 });
    expect(call?.headers['x-csrf-token']).toBe('csrf-1');

    // 保存成功后关闭弹窗并重取规则
    await waitFor(() => expect(screen.queryByLabelText('阈值')).toBeNull());
    await waitFor(() => expect(callsTo(calls, '/api/alerts/rules').length).toBeGreaterThanOrEqual(2));
  });

  it('越界阈值在本地就被拦住：显示原因、禁用保存、不发请求（不静默截断）', async () => {
    const { calls } = renderAlerts(alertsRoutes(sessionUser()));
    await waitForSession(calls);

    fireEvent.click(await screen.findByRole('button', { name: '编辑规则 磁盘使用率过高' }));
    fireEvent.change(screen.getByLabelText('阈值'), { target: { value: '150' } });

    const error = await screen.findByText('阈值必须大于 0 且不超过 100（单位 %）');
    expect(error.getAttribute('role')).toBe('alert');
    expect(error.id).toBe('alert-rule-rule-disk-percent-threshold-error');
    expect((screen.getByLabelText('阈值') as HTMLInputElement).getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);
    expect(callsTo(calls, '/api/alerts/rules/rule-disk-percent')).toHaveLength(0);
  });
});

describe('告警页 · 确认事件', () => {
  it('点「确认」→ POST /api/alerts/events/:id/ack（带 CSRF），并重取事件列表', async () => {
    const { calls } = renderAlerts(alertsRoutes(sessionUser()));
    await waitForSession(calls);

    const ackButtons = await screen.findAllByRole('button', { name: '确认' });
    fireEvent.click(ackButtons[0] as HTMLButtonElement);

    await waitFor(() => expect(callsTo(calls, '/api/alerts/events/alert-1/ack')).toHaveLength(1));
    const call = callsTo(calls, '/api/alerts/events/alert-1/ack')[0];
    expect(call?.init.method).toBe('POST');
    expect(call?.headers['x-csrf-token']).toBe('csrf-1');

    // 计数与"已确认"列必须来自服务端：确认后重取事件
    await waitFor(() => expect(callsTo(calls, EVENTS_URL('all')).length).toBeGreaterThanOrEqual(2));
  });

  it('切换"未恢复/已恢复"过滤会带上 state 查询参数', async () => {
    const { calls } = renderAlerts(alertsRoutes(sessionUser()));
    await waitForSession(calls);

    await screen.findByRole('table', { name: /告警事件列表/ });
    fireEvent.click(screen.getByRole('button', { name: '未恢复' }));

    await waitFor(() => expect(callsTo(calls, EVENTS_URL('open')).length).toBeGreaterThanOrEqual(1));
    expect(screen.getByRole('button', { name: '未恢复' }).getAttribute('aria-pressed')).toBe('true');
  });
});

// ---------------------------------------------------------------- 事件列表内容

describe('告警页 · 事件列表展示数据质量', () => {
  it('展示 reopenCount（重开 N 次）与恢复状态，而不是只显示一句 message', async () => {
    const { calls, container } = renderAlerts(alertsRoutes(sessionUser()));
    await waitForSession(calls);
    await waitFor(() => expect(container.querySelectorAll('[data-alert-event-id]')).toHaveLength(3));

    const open = container.querySelector('[data-alert-event-id="alert-1"]');
    expect(open?.getAttribute('data-alert-state')).toBe('open');
    expect(open?.textContent).toContain('未恢复');
    expect(open?.textContent).toContain('重开 2 次');
    expect(open?.textContent).toContain('未确认');
    // 取值按 unit 显示（percent → 带 % 且阈值也带单位）
    expect(open?.textContent).toContain('91.2%');
    expect(open?.textContent).toContain('阈值 85.0%');

    const resolved = container.querySelector('[data-alert-event-id="alert-2"]');
    expect(resolved?.getAttribute('data-alert-state')).toBe('resolved');
    expect(resolved?.textContent).toContain('已恢复');
    expect(resolved?.textContent).toContain('已确认');
    expect(resolved?.textContent).toContain('—'); // reopenCount = 0
  });
});

// ---------------------------------------------------------------- 导航与徽标

describe('导航 · 历史/告警对 viewer 可见，徽标取 summary.unacknowledged', () => {
  function renderShell(user: SessionUser, summary: unknown): { calls: RecordedCall[] } {
    const calls = stubFetch({ ...baseRoutes(user), '/api/alerts/summary': () => jsonResponse(summary) });
    render(
      <MemoryRouter>
        <AuthProvider>
          <AppShell>
            <p>内容</p>
          </AppShell>
        </AuthProvider>
      </MemoryRouter>,
    );
    return { calls };
  }

  it('viewer 能看到「历史」「告警」；徽标数字来自 unacknowledged（不是 open）', async () => {
    const { calls } = renderShell(sessionUser({ role: 'viewer', username: 'viewer' }), {
      open: 5,
      unacknowledged: 2,
      suppressed: 3,
      bySeverity: { warning: 1, critical: 1 },
      top: [],
      evaluatedAt: '2026-10-15T12:00:00.000Z',
    });
    await waitFor(() => expect(callsTo(calls, '/api/alerts/summary')).toHaveLength(1));

    expect(await screen.findByRole('link', { name: '历史' })).toBeTruthy();
    // 徽标是链接的兄弟节点，所以链接的可访问名仍然是干净的「告警」
    expect(screen.getByRole('link', { name: '告警' })).toBeTruthy();

    const badge = await screen.findByTestId('nav-alert-badge');
    expect(badge.textContent).toBe('2'); // = unacknowledged，而不是 open = 5
    expect(badge.getAttribute('title')).toContain('2 条未确认告警');
    // suppressed 也要说清楚："没有告警"到底是被压了还是条件没成立
    expect(badge.getAttribute('title')).toContain('3 次触发因静默期被压制');

    // viewer 看不到管理入口（只读页面除外）
    expect(screen.queryByRole('link', { name: '账号管理' })).toBeNull();
    expect(screen.queryByRole('link', { name: '服务管理' })).toBeNull();
  });

  it('未确认计数为 0 时不渲染徽标（即使还有未恢复事件）', async () => {
    const { calls } = renderShell(sessionUser(), {
      open: 5,
      unacknowledged: 0,
      suppressed: 0,
      bySeverity: { warning: 5, critical: 0 },
      top: [],
      evaluatedAt: null,
    });
    await waitFor(() => expect(callsTo(calls, '/api/alerts/summary')).toHaveLength(1));

    expect(screen.getByRole('link', { name: '告警' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByTestId('nav-alert-badge')).toBeNull());
  });
});