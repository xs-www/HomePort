/**
 * 服务表单 `ServiceForm` 组件测试（Sprint 1 · S1-03）。
 *
 * 覆盖：
 * 1. **危险链接提示**：`preferredUrl` 填 `javascript:` 等内容时就地提示"只允许 http/https"并禁用保存；
 *    非法图标（非内置键、非 https）同样提示；
 * 2. **E2E 依赖的固定 id / 可访问名**：`#service-name` / `#service-description` / `#service-icon` /
 *    `#service-category` / `#service-url` / `#service-health-path`，每个都有 `<label htmlFor>`，
 *    按钮可访问名为「保存」「取消」；
 * 3. **提交契约**：编辑走 `PATCH /api/services/:id`、新建走 `POST /api/services`，请求体逐字段断言，
 *    变更类请求带 CSRF 头；
 * 4. **后端字段错误显示**：`ApiError.fieldErrors` 挂到对应输入（`aria-invalid` + `aria-describedby` + `role="alert"`）。
 *
 * 全部走假 fetch，不发真实请求。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { ServiceForm } from '../src/components/ServiceForm.js';
import {
  baseRoutes,
  callsTo,
  errorResponse,
  jsonResponse,
  serviceView,
  sessionUser,
  stubFetch,
  type Handler,
  type RecordedCall,
} from './serviceTestUtils.js';

function renderForm(
  routes: Record<string, Handler>,
  props: { service?: ReturnType<typeof serviceView> | null; onSaved?: () => void } = {},
): RecordedCall[] {
  const calls = stubFetch({ ...baseRoutes(sessionUser()), ...routes });
  render(
    <AuthProvider>
      <ServiceForm service={props.service ?? null} onCancel={() => undefined} onSaved={props.onSaved ?? (() => undefined)} />
    </AuthProvider>,
  );
  return calls;
}

/** 提交表单（不依赖 jsdom 对"点提交按钮触发表单提交"的实现）。 */
function submitForm(): void {
  const form = screen.getByRole('button', { name: '保存' }).closest('form');
  if (!form) throw new Error('保存按钮不在表单内');
  fireEvent.submit(form);
}

/** 等 AuthProvider 的会话探测落地（CSRF 令牌此时已注入 API 客户端）。 */
async function waitForSession(calls: RecordedCall[]): Promise<void> {
  await waitFor(() => expect(callsTo(calls, '/api/users/me').length).toBeGreaterThan(0));
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('ServiceForm · 固定 id 与可访问名（E2E 契约）', () => {
  it('七个输入都有 label htmlFor 关联，按钮可访问名为「保存」「取消」', async () => {
    const calls = renderForm({});
    await waitForSession(calls);

    for (const [label, id] of [
      ['名称', 'service-name'],
      ['描述', 'service-description'],
      ['图标', 'service-icon'],
      ['分类', 'service-category'],
      ['首选入口', 'service-url'],
      ['健康路径', 'service-health-path'],
      ['健康探测目标', 'service-health-target'],
    ] as const) {
      const input = screen.getByLabelText(label);
      expect(input.id).toBe(id);
      expect(document.querySelector(`label[for="${id}"]`)).not.toBeNull();
    }

    expect(screen.getByRole('button', { name: '保存' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('名称为空时不能保存', async () => {
    const calls = renderForm({});
    await waitForSession(calls);
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的服务' } });
    expect(save.disabled).toBe(false);
  });
});

describe('ServiceForm · 危险输入', () => {
  it('首选入口填 javascript: 时提示只允许 http/https 并禁用保存', async () => {
    const calls = renderForm({});
    await waitForSession(calls);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的服务' } });
    fireEvent.change(screen.getByLabelText('首选入口'), { target: { value: 'javascript:alert(1)' } });

    const input = screen.getByLabelText('首选入口');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('service-url-error');
    expect(document.getElementById('service-url-error')?.textContent).toContain('只允许 http/https');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);

    // 换成 https 后提示消失、可以保存
    fireEvent.change(screen.getByLabelText('首选入口'), { target: { value: 'https://example.ts.net/app' } });
    expect(document.getElementById('service-url-error')).toBeNull();
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('data: / file: 同样被拦下', async () => {
    const calls = renderForm({});
    await waitForSession(calls);
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的服务' } });

    for (const url of ['data:text/html;base64,PHNjcmlwdD4=', 'file:///etc/passwd']) {
      fireEvent.change(screen.getByLabelText('首选入口'), { target: { value: url } });
      expect(document.getElementById('service-url-error')?.textContent).toContain('只允许 http/https');
    }
  });

  it('图标既不是内置键也不是 https 地址时给出提示（并说明外部图标的 CSP 约束）', async () => {
    const calls = renderForm({});
    await waitForSession(calls);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的服务' } });
    fireEvent.change(screen.getByLabelText('图标'), { target: { value: 'http://evil.test/icon.png' } });

    expect(document.getElementById('service-icon-error')?.textContent).toContain('内置键或 https:// 地址');
    expect((screen.getByRole('button', { name: '保存' }) as HTMLButtonElement).disabled).toBe(true);

    // https 图标合法，且页面已提示需要 CSP 放行
    fireEvent.change(screen.getByLabelText('图标'), { target: { value: 'https://cdn.example.com/icon.png' } });
    expect(document.getElementById('service-icon-error')).toBeNull();
    expect(screen.getByText(/PORTAL_CSP/)).toBeTruthy();
  });
});

describe('ServiceForm · 提交契约', () => {
  it('编辑模式：PATCH /api/services/:id，请求体逐字段符合契约并带 CSRF', async () => {
    const onSaved = vi.fn();
    const calls = renderForm(
      { '/api/services/svc-calendar': () => jsonResponse(serviceView()) },
      { service: serviceView(), onSaved },
    );
    await waitForSession(calls);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '家庭日历（改）' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '家庭' } });
    fireEvent.change(screen.getByLabelText('首选入口'), { target: { value: 'https://family-nas.tail585599.ts.net:8443/calendar' } });
    fireEvent.change(screen.getByLabelText('健康路径'), { target: { value: '/healthz' } });
    submitForm();

    await waitFor(() => expect(callsTo(calls, '/api/services/svc-calendar')).toHaveLength(1));

    const call = callsTo(calls, '/api/services/svc-calendar')[0];
    expect(call?.init.method).toBe('PATCH');
    expect(call?.body).toEqual({
      displayName: '家庭日历（改）',
      description: null,
      icon: 'calendar',
      category: '家庭',
      preferredUrl: 'https://family-nas.tail585599.ts.net:8443/calendar',
      healthTarget: null,
      healthPath: '/healthz',
    });
    expect(call?.headers['x-csrf-token']).toBe('csrf-1');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('新建模式：POST /api/services，空的可选字段整个省略（后端创建 schema 不接受 null）', async () => {
    const onSaved = vi.fn();
    const calls = renderForm({ '/api/services': () => jsonResponse(serviceView()) }, { onSaved });
    await waitForSession(calls);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的服务' } });
    fireEvent.change(screen.getByLabelText('图标'), { target: { value: 'box' } });
    submitForm();

    await waitFor(() => expect(callsTo(calls, '/api/services')).toHaveLength(1));

    const call = callsTo(calls, '/api/services')[0];
    expect(call?.init.method).toBe('POST');
    expect(call?.body).toEqual({ displayName: '我的服务', icon: 'box' });
    expect(call?.headers['x-csrf-token']).toBe('csrf-1');
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
  });

  it('新建模式：填了的字段按契约提交（不含 null）', async () => {
    const calls = renderForm({ '/api/services': () => jsonResponse(serviceView()) });
    await waitForSession(calls);

    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '我的服务' } });
    fireEvent.change(screen.getByLabelText('描述'), { target: { value: '自建门户' } });
    fireEvent.change(screen.getByLabelText('分类'), { target: { value: '项目' } });
    fireEvent.change(screen.getByLabelText('首选入口'), { target: { value: 'https://example.ts.net/app' } });
    fireEvent.change(screen.getByLabelText('健康路径'), { target: { value: '/healthz' } });
    submitForm();

    await waitFor(() => expect(callsTo(calls, '/api/services')).toHaveLength(1));
    expect(callsTo(calls, '/api/services')[0]?.body).toEqual({
      displayName: '我的服务',
      description: '自建门户',
      category: '项目',
      preferredUrl: 'https://example.ts.net/app',
      healthPath: '/healthz',
    });
  });

  it('后端 400 的 fieldErrors 显示在对应输入上（aria-invalid + aria-describedby + role="alert"）', async () => {
    const calls = renderForm(
      {
        '/api/services/svc-calendar': () =>
          errorResponse('VALIDATION_FAILED', '请求参数不合法', 400, {
            fieldErrors: { preferredUrl: ['只允许 http/https 链接'] },
          }),
      },
      { service: serviceView() },
    );
    await waitForSession(calls);

    fireEvent.change(screen.getByLabelText('首选入口'), { target: { value: 'https://example.ts.net/app' } });
    submitForm();

    const alert = await screen.findByText('只允许 http/https 链接');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.id).toBe('service-url-error');

    const input = screen.getByLabelText('首选入口');
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('service-url-error');
    // 顶层错误信息也要显示（用户能看到校验失败的整体原因）
    expect(screen.getByText('请求参数不合法')).toBeTruthy();
  });
});