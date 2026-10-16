/**
 * 命令面板 `CommandPalette` 组件测试（Sprint 1 · S1-03）。
 *
 * 覆盖：
 * 1. `Ctrl/Cmd+K` 打开（输入框内也能开）、Esc / 点遮罩关闭、焦点打开时进输入框、关闭后归还触发元素；
 * 2. aria 契约：`role="dialog"` + `aria-modal` + `aria-labelledby`、输入框 `aria-label`、
 *    结果 `role="listbox"` / 选项 `role="option"` + `aria-selected`；
 * 3. ↑↓ 移动 + Enter 打开，且**四种 kind 的跳转目标固定**
 *    （service → `/services/:id`、container → `/containers/:id`、device → `/devices`、tool → 外部新窗口）；
 * 4. 无结果时可读文案。
 *
 * 全部走假 fetch；`window.open` 用 `vi.stubGlobal` 打桩，绝不真的弹窗。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ServiceSearchHit } from '../src/api/types.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { CommandPaletteProvider } from '../src/components/CommandPalette.js';
import { baseRoutes, callsTo, jsonResponse, sessionUser, stubFetch, type Handler, type RecordedCall } from './serviceTestUtils.js';

function hit(overrides: Partial<ServiceSearchHit> = {}): ServiceSearchHit {
  return {
    kind: 'service',
    id: 'svc-calendar',
    title: '家庭日历',
    subtitle: '家庭 · Serve HTTPS',
    url: 'https://family-nas.tail585599.ts.net:8443/calendar',
    keywords: ['calendar'],
    ...overrides,
  };
}

/**
 * 渲染"套了外壳的命令面板"。
 *
 * 结构刻意与真实应用一致：`CommandPaletteProvider` 在路由**外层**（真实应用里在 `AppShell` 中），
 * 因此命令面板在跳转后依然存在，可以连续测试多种跳转。
 */
function renderPalette(routes: Record<string, Handler>): RecordedCall[] {
  const calls = stubFetch({ ...baseRoutes(sessionUser()), ...routes });
  render(
    <MemoryRouter initialEntries={['/']}>
      <AuthProvider>
        <CommandPaletteProvider>
          <button type="button">打开搜索</button>
          <Routes>
            <Route path="/" element={<div>服务墙首页</div>} />
            <Route path="/services/:id" element={<div>服务详情路由</div>} />
            <Route path="/containers/:id" element={<div>容器详情路由</div>} />
            <Route path="/devices" element={<div>设备列表路由</div>} />
          </Routes>
        </CommandPaletteProvider>
      </AuthProvider>
    </MemoryRouter>,
  );
  return calls;
}

/** 触发全局快捷键（浏览器里 key 是 'k'，同时接受 ctrlKey / metaKey）。 */
function pressHotkey(init: KeyboardEventInit = { ctrlKey: true }): void {
  fireEvent.keyDown(document, { key: 'k', ...init });
}

/** 打开面板并输入关键词，等到结果渲染出来。 */
async function searchFor(keyword: string): Promise<HTMLElement[]> {
  pressHotkey();
  const input = await screen.findByLabelText('搜索服务、容器、设备与工具');
  fireEvent.change(input, { target: { value: keyword } });
  await waitFor(() => expect(screen.queryAllByRole('option').length).toBeGreaterThan(0));
  return screen.queryAllByRole('option');
}

/** 面板固定请求 8 条（`limit` 是显式参数，URL 因此带 `&limit=8`）。 */
const SEARCH_CAL = '/api/search?q=cal&limit=8';
const SEARCH_ZZZ = '/api/search?q=zzz&limit=8';

const FOUR_HITS: ServiceSearchHit[] = [
  hit(),
  hit({ kind: 'container', id: 'cid-1', title: 'sisi-calendar', subtitle: '运行中 · 36065', url: 'http://localhost:36065/' }),
  hit({ kind: 'device', id: 'dev-1', title: 'family-nas', subtitle: '在线 · linux', url: 'https://family-nas.tail585599.ts.net/' }),
  hit({ kind: 'tool', id: 'tool-1', title: 'Portainer', subtitle: '工具 · up', url: 'https://family-nas.tail585599.ts.net:9443/' }),
];

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('命令面板 · 打开与关闭', () => {
  it('Ctrl+K 打开：dialog / aria 契约齐备，焦点进入搜索框', async () => {
    const calls = renderPalette({});

    expect(screen.queryByRole('dialog')).toBeNull();
    pressHotkey();

    const dialog = await screen.findByRole('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('命令面板');

    const input = screen.getByLabelText('搜索服务、容器、设备与工具');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input);

    // 结果容器有 listbox 语义；未输入时给出可读提示
    expect(screen.getByRole('listbox').getAttribute('aria-label')).toBe('搜索结果');
    expect(screen.getByRole('status').textContent).toContain('输入关键词开始搜索');

    // 未输入关键词时不打服务端
    expect(callsTo(calls, SEARCH_CAL)).toHaveLength(0);
  });

  it('Meta+K 同样能开（macOS 用户习惯）', async () => {
    renderPalette({});
    pressHotkey({ metaKey: true });
    expect(await screen.findByRole('dialog')).toBeTruthy();
  });

  it('Esc 关闭并把焦点归还触发元素；点遮罩也能关闭', async () => {
    renderPalette({});

    const trigger = screen.getByRole('button', { name: '打开搜索' });
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    pressHotkey();
    await screen.findByRole('dialog');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);

    // 点遮罩关闭
    pressHotkey();
    const dialog = await screen.findByRole('dialog');
    const backdrop = dialog.parentElement?.querySelector('[data-modal-backdrop="true"]');
    expect(backdrop).not.toBeNull();
    fireEvent.click(backdrop as Element);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });
});

describe('命令面板 · 搜索与键盘导航', () => {
  it('输入后按防抖请求 /api/search，渲染 option 并维护 aria-selected', async () => {
    const calls = renderPalette({ [SEARCH_CAL]: () => jsonResponse({ items: FOUR_HITS, query: 'cal' }) });

    const options = await searchFor('cal');

    expect(callsTo(calls, SEARCH_CAL)).toHaveLength(1);
    expect(calls[0]?.init.method).toBe('GET');
    expect(options).toHaveLength(4);
    expect(options[0]?.getAttribute('aria-selected')).toBe('true');
    expect(options[1]?.getAttribute('aria-selected')).toBe('false');
    expect(options[0]?.textContent).toContain('家庭日历');

    const input = screen.getByLabelText('搜索服务、容器、设备与工具');
    expect(input.getAttribute('aria-activedescendant')).toBe(options[0]?.id);

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.queryAllByRole('option')[1]?.getAttribute('aria-selected')).toBe('true');
    expect(screen.queryAllByRole('option')[0]?.getAttribute('aria-selected')).toBe('false');

    // 循环到底
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(screen.queryAllByRole('option')[3]?.getAttribute('aria-selected')).toBe('true');
  });

  it('Enter 打开服务 → 站内跳转 /services/:id', async () => {
    renderPalette({ [SEARCH_CAL]: () => jsonResponse({ items: FOUR_HITS, query: 'cal' }) });

    const options = await searchFor('cal');
    const input = screen.getByLabelText('搜索服务、容器、设备与工具');
    expect(options[0]?.getAttribute('data-kind')).toBe('service');

    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('服务详情路由')).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Enter 打开容器 → /containers/:id，设备 → /devices', async () => {
    renderPalette({ [SEARCH_CAL]: () => jsonResponse({ items: FOUR_HITS, query: 'cal' }) });

    await searchFor('cal');
    let input = screen.getByLabelText('搜索服务、容器、设备与工具');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('容器详情路由')).toBeTruthy();

    // 设备：再打开一次，下移到第 3 项
    await searchFor('cal');
    input = screen.getByLabelText('搜索服务、容器、设备与工具');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(await screen.findByText('设备列表路由')).toBeTruthy();
  });

  it('Enter 打开工具 → 外部新窗口（window.open），不做站内跳转', async () => {
    const openMock = vi.fn();
    vi.stubGlobal('open', openMock);
    renderPalette({ [SEARCH_CAL]: () => jsonResponse({ items: FOUR_HITS, query: 'cal' }) });

    await searchFor('cal');
    const input = screen.getByLabelText('搜索服务、容器、设备与工具');
    for (let index = 0; index < 3; index += 1) fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(openMock).toHaveBeenCalledTimes(1));
    expect(openMock.mock.calls[0]?.[0]).toBe('https://family-nas.tail585599.ts.net:9443/');
    expect(openMock.mock.calls[0]?.[1]).toBe('_blank');
    // 仍停在首页（没有站内跳转）
    expect(screen.getByText('服务墙首页')).toBeTruthy();
  });

  it('无结果时给出可读文案', async () => {
    renderPalette({ [SEARCH_ZZZ]: () => jsonResponse({ items: [], query: 'zzz' }) });

    pressHotkey();
    const input = await screen.findByLabelText('搜索服务、容器、设备与工具');
    fireEvent.change(input, { target: { value: 'zzz' } });

    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('未找到与「zzz」匹配'));
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
});