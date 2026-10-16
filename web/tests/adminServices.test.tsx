/**
 * 服务管理页 `AdminServicesPage` 组件测试（Sprint 1 · S1-03）。
 *
 * 重点是**锁定 E2E 依赖的契约**：
 * - 按钮可访问名：`重新发现` / `新建服务` / `上移` / `下移` / `隐藏` / `重置为自动` / `编辑` / `删除`，
 *   且同一行里"隐藏"只会出现一次（可见性用开关，不用同名按钮）；
 * - 删除语义：`manual` 服务是「删除」，自动发现的服务是「隐藏」+「重置为自动」；
 * - 排序调用 `reorderServices` 且 payload 是重排后的完整顺序；
 * - 「重新发现」调用 `POST /api/services/discover`；
 * - 「编辑」打开 Modal，里面就是那张带固定 id 的表单。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { AdminServicesPage } from '../src/pages/AdminServicesPage.js';
import {
  baseRoutes,
  callsTo,
  jsonResponse,
  listResponse,
  serviceView,
  sessionUser,
  stubFetch,
  type Handler,
  type RecordedCall,
} from './serviceTestUtils.js';

/** 列表接口带 `includeHidden=1`（管理页要求看到隐藏服务）。 */
const LIST_URL = '/api/services?includeHidden=1';

function renderAdmin(routes: Record<string, Handler>): { calls: RecordedCall[]; container: HTMLElement } {
  const calls = stubFetch({ ...baseRoutes(sessionUser()), ...routes });
  const view = render(
    <MemoryRouter>
      <AuthProvider>
        <AdminServicesPage />
      </AuthProvider>
    </MemoryRouter>,
  );
  return { calls, container: view.container };
}

/** 取某一行（`li`）。 */
function rowOf(container: HTMLElement, id: string): HTMLElement {
  const row = container.querySelector<HTMLElement>(`li[data-service-id="${id}"]`);
  if (!row) throw new Error(`没有找到服务行：${id}`);
  return row;
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('服务管理页 · 列表与按钮契约', () => {
  it('渲染排序/收藏/可见性/编辑按钮；手工服务「删除」、自动服务「隐藏 + 重置为自动」', async () => {
    const auto = serviceView({ id: 'svc-auto', displayName: '家庭日历', sortOrder: 10 });
    const manual = serviceView({
      id: 'svc-manual',
      displayName: '我的服务',
      sourceType: 'manual',
      sourceRef: 'manual:1',
      category: '项目',
      sortOrder: 20,
    });

    const { container, calls } = renderAdmin({ [LIST_URL]: () => jsonResponse(listResponse([auto, manual])) });

    expect(await screen.findByText('家庭日历')).toBeTruthy();
    expect(callsTo(calls, LIST_URL)).toHaveLength(1);

    // 顶部操作
    expect(screen.getByRole('button', { name: '重新发现' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '新建服务' })).toBeTruthy();

    // 自动服务：没有「删除」，有「隐藏」与「重置为自动」
    const autoRow = rowOf(container, 'svc-auto');
    expect(autoRow.querySelector('button[type="button"]')).not.toBeNull();
    expect(Array.from(autoRow.querySelectorAll('button')).map((node) => node.textContent)).toEqual([
      '上移',
      '下移',
      '收藏',
      '编辑',
      '健康检查',
      '隐藏',
      '重置为自动',
    ]);
    // 可见性用开关（aria-label 带服务名），避免与「隐藏」按钮同名
    expect(autoRow.querySelector('input[type="checkbox"]')?.getAttribute('aria-label')).toBe('在服务墙显示「家庭日历」');

    // 手工服务：有「删除」，没有「重置为自动」
    const manualRow = rowOf(container, 'svc-manual');
    const manualButtons = Array.from(manualRow.querySelectorAll('button')).map((node) => node.textContent);
    expect(manualButtons).toContain('删除');
    expect(manualButtons).not.toContain('重置为自动');
    expect(manualButtons).not.toContain('隐藏');

    // 第一行的「上移」禁用（已经在最前）
    const upInFirstRow = Array.from(autoRow.querySelectorAll('button')).find((node) => node.textContent === '上移');
    expect((upInFirstRow as HTMLButtonElement).disabled).toBe(true);
  });

  it('点「下移」调用 reorder，payload 是重排后的完整顺序', async () => {
    const first = serviceView({ id: 'svc-a', displayName: 'A', sortOrder: 10 });
    const second = serviceView({ id: 'svc-b', displayName: 'B', sortOrder: 20 });

    const { container, calls } = renderAdmin({
      [LIST_URL]: () => jsonResponse(listResponse([first, second])),
      '/api/services/reorder': () => jsonResponse(listResponse([second, first])),
    });

    await screen.findByText('A');
    const row = rowOf(container, 'svc-a');
    const down = Array.from(row.querySelectorAll('button')).find((node) => node.textContent === '下移');
    fireEvent.click(down as HTMLButtonElement);

    await waitFor(() => expect(callsTo(calls, '/api/services/reorder')).toHaveLength(1));
    expect(callsTo(calls, '/api/services/reorder')[0]?.body).toEqual({
      order: [
        { id: 'svc-b', sortOrder: 10 },
        { id: 'svc-a', sortOrder: 20 },
      ],
    });
  });

  it('点「重新发现」调用 POST /api/services/discover 并提示结果', async () => {
    const item = serviceView({ id: 'svc-a', displayName: 'A' });
    const { calls } = renderAdmin({
      [LIST_URL]: () => jsonResponse(listResponse([item])),
      '/api/services/discover': () => jsonResponse(listResponse([item])),
    });

    await screen.findByText('A');
    fireEvent.click(screen.getByRole('button', { name: '重新发现' }));

    await waitFor(() => expect(callsTo(calls, '/api/services/discover')).toHaveLength(1));
    expect(callsTo(calls, '/api/services/discover')[0]?.init.method).toBe('POST');
    expect(await screen.findByText(/已重新发现：当前 1 个服务/)).toBeTruthy();
  });

  it('点「编辑」打开 Modal，表单使用固定的输入 id', async () => {
    const item = serviceView({ id: 'svc-a', displayName: '家庭日历' });
    renderAdmin({ [LIST_URL]: () => jsonResponse(listResponse([item])) });

    await screen.findByText('家庭日历');
    fireEvent.click(screen.getByRole('button', { name: '编辑' }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('家庭日历');
    for (const id of ['service-name', 'service-description', 'service-icon', 'service-category', 'service-url', 'service-health-path']) {
      expect(dialog.querySelector(`#${id}`)).not.toBeNull();
    }
    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();

    // Esc 关闭并归还焦点（Modal 的统一行为）
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('可见性开关调用 PATCH visibility，取消收藏调用 PATCH favorite', async () => {
    const item = serviceView({ id: 'svc-a', displayName: '家庭日历', favorite: true });
    const { container, calls } = renderAdmin({
      [LIST_URL]: () => jsonResponse(listResponse([item])),
      '/api/services/svc-a': () => jsonResponse(item),
    });

    await screen.findByText('家庭日历');
    const row = rowOf(container, 'svc-a');

    fireEvent.click(row.querySelector('input[type="checkbox"]') as HTMLInputElement);
    await waitFor(() => expect(callsTo(calls, '/api/services/svc-a')).toHaveLength(1));
    expect(callsTo(calls, '/api/services/svc-a')[0]?.body).toEqual({ visibility: 'hidden' });

    const favorite = Array.from(row.querySelectorAll('button')).find((node) => node.textContent === '取消收藏');
    fireEvent.click(favorite as HTMLButtonElement);
    await waitFor(() => expect(callsTo(calls, '/api/services/svc-a')).toHaveLength(2));
    expect(callsTo(calls, '/api/services/svc-a')[1]?.body).toEqual({ favorite: false });
  });

  it('「重置为自动」二次确认后调用 DELETE ?mode=reset', async () => {
    const item = serviceView({ id: 'svc-a', displayName: '家庭日历', sourceType: 'docker' });
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);

    const { container, calls } = renderAdmin({
      [LIST_URL]: () => jsonResponse(listResponse([item])),
      '/api/services/svc-a?mode=reset': () =>
        jsonResponse({ ok: true, mode: 'reset', service: item }),
    });

    await screen.findByText('家庭日历');
    const row = rowOf(container, 'svc-a');
    const reset = Array.from(row.querySelectorAll('button')).find((node) => node.textContent === '重置为自动');
    fireEvent.click(reset as HTMLButtonElement);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(String(confirmMock.mock.calls[0]?.[0])).toContain('重置为自动发现值');
    await waitFor(() => expect(callsTo(calls, '/api/services/svc-a?mode=reset')).toHaveLength(1));
    expect(callsTo(calls, '/api/services/svc-a?mode=reset')[0]?.init.method).toBe('DELETE');
    expect(await screen.findByText(/已重置/)).toBeTruthy();
  });
});