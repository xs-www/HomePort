/**
 * 两步验证（TOTP）· 前端组件与流程测试（S0-03）。
 *
 * 覆盖点（全部走 `vi.stubGlobal('fetch', …)` 造假响应，绝不发真实请求）：
 * 1. 两步登录切换：第一步返回 `totpRequired` → 出现验证码输入（含 inputMode /
 *    autoComplete / maxLength 等无障碍与移动端输入属性），且 `challengeToken`
 *    不写入 localStorage/sessionStorage。
 * 2. `TOTP_INVALID` → 就地报错"验证码不正确，请重试"，保留已输入的验证码。
 * 3. `TOTP_CHALLENGE_EXPIRED` → 自动退回第一步并提示"验证已过期，请重新登录"。
 * 4. 启用流程：setup 展示密钥与 otpauth 链接 → enable 后**一次性**展示恢复码，
 *    未勾选"我已保存恢复码"时无法关闭弹窗。
 * 5. 管理员强制重置：`totpEnabled` 用户显示徽标，二次确认后调用 reset 并提示掉线。
 *
 * 说明：表单提交统一用 `fireEvent.submit(form)`（不依赖 jsdom 对"点击提交按钮
 * 触发表单提交"的实现），按钮的 `disabled` 状态另行断言。
 * 本文件沿用 `web/tests/client.test.ts` 的假 fetch 写法，且不修改任何既有测试文件。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiClient, ApiError } from '../src/api/client.js';
import type { SessionUser } from '../src/api/types.js';
import { AuthProvider } from '../src/auth/AuthProvider.js';
import { LoginPage } from '../src/pages/LoginPage.js';
import { SecurityTab } from '../src/pages/admin/SecurityTab.js';
import { UsersTab } from '../src/pages/admin/UsersTab.js';

// ---------------------------------------------------------------- 假响应工具

/** 造一个 JSON 响应。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** 造一个后端错误响应（`{ error: { code, message, details } }`）。 */
function errorResponse(code: string, message: string, status = 401): Response {
  return jsonResponse({ error: { code, message, details: null } }, status);
}

interface RecordedCall {
  url: string;
  init: RequestInit;
  /** 已解析的请求体（无 body 时为 undefined） */
  body: unknown;
  headers: Record<string, string>;
}

type Handler = (init: RequestInit) => Response;

/**
 * 安装 fetch 假实现：按**精确 URL** 分发并记录每次调用。
 * 未定义的 URL 返回 500 + 明确文案，便于在断言里看出漏配了哪个假响应。
 */
function stubFetch(routes: Record<string, Handler>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init: RequestInit = {}) => {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
      calls.push({
        url,
        init,
        body,
        headers: (init.headers ?? {}) as Record<string, string>,
      });
      const handler = routes[url];
      if (!handler) {
        return Promise.resolve(
          jsonResponse({ error: { code: 'NOT_STUBBED', message: `未定义假响应：${url}` } }, 500),
        );
      }
      return Promise.resolve(handler(init));
    }),
  );
  return calls;
}

/** 取指定 URL 的所有调用。 */
function callsTo(calls: RecordedCall[], url: string): RecordedCall[] {
  return calls.filter((call) => call.url === url);
}

/** 造一个会话用户。 */
function sessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 1,
    username: 'admin',
    displayName: '管理员',
    role: 'admin',
    disabled: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    lastLoginAt: null,
    totpEnabled: false,
    totpConfirmedAt: null,
    ...overrides,
  };
}

/** `GET /api/auth/session` 的响应体。 */
function sessionPayload(user: SessionUser | null): unknown {
  return {
    setupRequired: false,
    authenticated: user !== null,
    csrfToken: user ? 'csrf-1' : '',
    user,
    expiresAt: null,
  };
}

/** 所有渲染都需要的公共假路由（会话探测 + 健康检查 + 偏好）。 */
function baseRoutes(user: SessionUser | null): Record<string, Handler> {
  return {
    '/api/auth/session': () => jsonResponse(sessionPayload(user)),
    '/api/health': () => jsonResponse({ version: 'test' }),
    '/api/users/me': () => jsonResponse({ user, preferences: null }),
  };
}

/** 填写第一步的账号密码。 */
function fillCredentials(username = 'admin', password = 'pw'): void {
  fireEvent.change(screen.getByLabelText('用户名'), { target: { value: username } });
  fireEvent.change(screen.getByLabelText('密码'), { target: { value: password } });
}

/** 提交按钮所在的表单。 */
function submitFormOf(button: HTMLElement): void {
  const form = button.closest('form');
  if (!form) throw new Error('按钮不在表单内');
  fireEvent.submit(form);
}

/** 登录第一步"需要第二步"的响应体。 */
const CHALLENGE = {
  totpRequired: true as const,
  challengeToken: 'challenge-abc',
  expiresAt: '2026-01-01T00:05:00.000Z',
};

/** 渲染登录页（含 AuthProvider）。 */
function renderLoginPage(routes: Record<string, Handler>): RecordedCall[] {
  const calls = stubFetch({ ...baseRoutes(null), ...routes });
  render(
    <AuthProvider>
      <LoginPage />
    </AuthProvider>,
  );
  return calls;
}

/** 走到第二步：填账号密码 → 提交 → 等验证码输入出现。 */
async function gotoSecondStep(): Promise<HTMLElement> {
  fillCredentials();
  submitFormOf(screen.getByRole('button', { name: '登录' }));
  return await screen.findByLabelText('验证码');
}

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

// ---------------------------------------------------------------- 1. 两步登录切换

describe('两步登录 · 切换到验证码输入', () => {
  it('第一步返回 totpRequired 时切到第二步，并带齐输入与无障碍属性', async () => {
    const calls = renderLoginPage({
      '/api/auth/login': () => jsonResponse(CHALLENGE),
    });

    const codeInput = await gotoSecondStep();

    // 标题与"返回上一步"
    expect(screen.getByText('两步验证')).toBeTruthy();
    expect(screen.getByRole('button', { name: '返回上一步' })).toBeTruthy();

    // 移动端数字键盘 / 一次性验证码自动填充 / 允许恢复码的 9 个字符
    expect(codeInput.getAttribute('inputmode')).toBe('numeric');
    expect(codeInput.getAttribute('autocomplete')).toBe('one-time-code');
    expect(codeInput.getAttribute('maxlength')).toBe('9');
    expect(codeInput.id).toBe('totp-code');
    // label 关联（htmlFor/id）与恢复码提示文案
    expect(document.querySelector('label[for="totp-code"]')?.textContent).toContain('验证码');
    expect(screen.getByText(/XXXX-XXXX/)).toBeTruthy();

    // 第一步的请求体形状不变
    expect(callsTo(calls, '/api/auth/login')[0]?.body).toEqual({
      username: 'admin',
      password: 'pw',
      remember: true,
    });
    // 第二步尚未发起请求
    expect(callsTo(calls, '/api/auth/login/totp')).toHaveLength(0);
  });

  it('挑战令牌只留在组件状态里，不写入任何 Web Storage', async () => {
    renderLoginPage({ '/api/auth/login': () => jsonResponse(CHALLENGE) });
    await gotoSecondStep();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(JSON.stringify([...Object.values(localStorage), ...Object.values(sessionStorage)])).not.toContain(
      'challenge-abc',
    );
  });

  it('第二步提交后按契约发送 challengeToken / code / remember', async () => {
    const calls = renderLoginPage({
      '/api/auth/login': () => jsonResponse(CHALLENGE),
      '/api/auth/login/totp': () =>
        jsonResponse({
          user: sessionUser({ totpEnabled: true }),
          csrfToken: 'csrf-2',
          expiresAt: '2026-01-01T01:00:00.000Z',
        }),
    });

    const codeInput = await gotoSecondStep();
    fireEvent.change(codeInput, { target: { value: ' 123456 ' } });
    submitFormOf(screen.getByRole('button', { name: '验证并登录' }));

    await waitFor(() => expect(callsTo(calls, '/api/auth/login/totp')).toHaveLength(1));
    expect(callsTo(calls, '/api/auth/login/totp')[0]?.body).toEqual({
      challengeToken: 'challenge-abc',
      code: '123456',
      remember: true,
    });
    // 建立会话之前的请求不应带 CSRF 头（此时还没有令牌）
    expect(callsTo(calls, '/api/auth/login/totp')[0]?.headers['x-csrf-token']).toBeUndefined();
  });

  it('验证码不足 6 位时提交按钮禁用', async () => {
    renderLoginPage({ '/api/auth/login': () => jsonResponse(CHALLENGE) });
    const codeInput = await gotoSecondStep();
    const submit = screen.getByRole('button', { name: '验证并登录' }) as HTMLButtonElement;

    expect(submit.disabled).toBe(true);
    fireEvent.change(codeInput, { target: { value: '12345' } });
    expect(submit.disabled).toBe(true);
    fireEvent.change(codeInput, { target: { value: '123456' } });
    expect(submit.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------- 2. TOTP_INVALID

describe('两步登录 · TOTP_INVALID', () => {
  it('验证码错误时就地报错、保留输入，且不退回第一步', async () => {
    renderLoginPage({
      '/api/auth/login': () => jsonResponse(CHALLENGE),
      '/api/auth/login/totp': () => errorResponse('TOTP_INVALID', '验证码不正确'),
    });

    const codeInput = await gotoSecondStep();
    fireEvent.change(codeInput, { target: { value: '654321' } });
    submitFormOf(screen.getByRole('button', { name: '验证并登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('验证码不正确，请重试');

    // 输入保留，仍停在第二步
    const input = screen.getByLabelText('验证码') as HTMLInputElement;
    expect(input.value).toBe('654321');
    expect(screen.queryByRole('button', { name: '返回上一步' })).toBeTruthy();

    // 无障碍：aria-invalid + aria-describedby 指向错误文案
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(input.getAttribute('aria-describedby')).toContain('totp-code-error');
    expect(document.getElementById('totp-code-error')?.getAttribute('role')).toBe('alert');
    expect(document.getElementById('totp-code-error')?.textContent).toBe('验证码不正确，请重试');

    // 401 属于"验证码错误"而非会话失效：既没登录成功，也没被踢回第一步
    expect(screen.queryByLabelText('密码')).toBeNull();
  });
});

// ---------------------------------------------------------------- 3. 挑战过期

describe('两步登录 · TOTP_CHALLENGE_EXPIRED', () => {
  it('挑战过期时自动退回第一步并提示重新登录', async () => {
    renderLoginPage({
      '/api/auth/login': () => jsonResponse(CHALLENGE),
      '/api/auth/login/totp': () => errorResponse('TOTP_CHALLENGE_EXPIRED', '挑战已过期'),
    });

    const codeInput = await gotoSecondStep();
    fireEvent.change(codeInput, { target: { value: '123456' } });
    submitFormOf(screen.getByRole('button', { name: '验证并登录' }));

    expect(await screen.findByText('验证已过期，请重新登录')).toBeTruthy();
    // 回到第一步：验证码输入消失，账号密码表单回来
    expect(screen.queryByLabelText('验证码')).toBeNull();
    expect(screen.getByLabelText('密码')).toBeTruthy();
    // 用户名保留、密码清空（避免半途的凭据留在表单里）
    expect((screen.getByLabelText('用户名') as HTMLInputElement).value).toBe('admin');
    expect((screen.getByLabelText('密码') as HTMLInputElement).value).toBe('');
    // 提示用 role="status"（非错误类通知）
    expect(screen.getByRole('status').textContent).toBe('验证已过期，请重新登录');
  });
});

// ---------------------------------------------------------------- 4. 启用流程

describe('两步验证 · 启用与一次性恢复码', () => {
  it('setup 展示密钥与 otpauth 链接，enable 后一次性展示恢复码且必须确认已保存', async () => {
    let totpEnabled = false;
    const calls = stubFetch({
      '/api/auth/session': () => jsonResponse(sessionPayload(sessionUser({ totpEnabled }))),
      '/api/health': () => jsonResponse({ version: 'test' }),
      '/api/users/me': () => jsonResponse({ user: sessionUser({ totpEnabled }), preferences: null }),
      '/api/users/me/totp/setup': () =>
        jsonResponse({
          secret: 'JBSWY3DPEHPK3PXP',
          otpauthUri: 'otpauth://totp/HomePort:admin?secret=JBSWY3DPEHPK3PXP&issuer=HomePort',
          digits: 6,
          period: 30,
        }),
      '/api/users/me/totp/enable': () => {
        totpEnabled = true;
        return jsonResponse({
          recoveryCodes: ['AAAA-BBBB', 'CCCC-DDDD', 'EEEE-FFFF'],
          user: sessionUser({ totpEnabled: true, totpConfirmedAt: '2026-01-03T00:00:00.000Z' }),
        });
      },
    });

    render(
      <AuthProvider>
        <SecurityTab preferences={null} onChange={async () => {}} />
      </AuthProvider>,
    );

    // 未启用：给出启用入口
    const startButton = await screen.findByRole('button', { name: /启用两步验证/ });
    fireEvent.click(startButton);

    // setup 后展示密钥（可选中复制）与 otpauth 链接
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    expect(screen.getByText(/^otpauth:\/\/totp\/HomePort:admin/)).toBeTruthy();
    expect(screen.getByText('密钥（在验证器 App 里手动输入）')).toBeTruthy();
    expect(screen.getByRole('button', { name: '重新生成密钥' })).toBeTruthy();
    expect(callsTo(calls, '/api/users/me/totp/setup')).toHaveLength(1);

    // 输入 6 位动态码并确认
    const enableCode = screen.getByLabelText('验证器 App 上的 6 位动态码') as HTMLInputElement;
    const confirmEnable = screen.getByRole('button', { name: '确认启用' }) as HTMLButtonElement;
    expect(confirmEnable.disabled).toBe(true);
    fireEvent.change(enableCode, { target: { value: '123456' } });
    expect(confirmEnable.disabled).toBe(false);
    submitFormOf(confirmEnable);

    // 一次性恢复码弹窗
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain('这些码只显示这一次，请立即保存');
    expect(callsTo(calls, '/api/users/me/totp/enable')[0]?.body).toEqual({ code: '123456' });

    for (const code of ['AAAA-BBBB', 'CCCC-DDDD', 'EEEE-FFFF']) {
      const item = screen.getByText(code);
      expect(item.tagName).toBe('LI');
      expect(item.classList.contains('font-mono')).toBe(true);
    }

    // 未勾选"我已保存恢复码"前不能关闭
    const done = screen.getByRole('button', { name: '完成' }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);
    const ack = screen.getByLabelText('我已保存恢复码') as HTMLInputElement;
    expect(ack.type).toBe('checkbox');
    fireEvent.click(ack);
    expect(done.disabled).toBe(false);
    fireEvent.click(done);

    // 关闭后刷新上下文 → 切到"已启用"视图
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('button', { name: '重新生成恢复码' })).toBeTruthy();
    expect(screen.getByText('启用时间：')).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 5. 管理员强制重置

describe('用户列表 · 管理员强制重置两步验证', () => {
  it('totpEnabled 用户显示徽标；二次确认后重置并提示用户需重新登录', async () => {
    const confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);
    const reload = vi.fn();
    stubFetch({
      ...baseRoutes(sessionUser()),
      '/api/users/1/totp/reset': () => jsonResponse({ ok: true, revokedSessions: 3 }),
    });

    render(
      <AuthProvider>
        <UsersTab
          users={[sessionUser({ totpEnabled: true })]}
          loading={false}
          error={null}
          reload={reload}
          currentUserId={99}
        />
      </AuthProvider>,
    );

    expect(screen.getByText('两步验证已启用')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '重置两步验证' }));

    // 二次确认文案必须说明"会掉线 + 需重新绑定"
    expect(confirmMock).toHaveBeenCalledTimes(1);
    const message = String(confirmMock.mock.calls[0]?.[0] ?? '');
    expect(message).toContain('清除');
    expect(message).toContain('吊销');
    expect(message).toContain('掉线');
    expect(message).toContain('重新绑定');

    expect(await screen.findByText(/已重置 admin 的两步验证，吊销 3 个会话/)).toBeTruthy();
    expect(screen.getByText(/需重新登录并重新绑定/)).toBeTruthy();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('未启用两步验证的用户不显示重置入口', async () => {
    stubFetch(baseRoutes(sessionUser()));
    render(
      <AuthProvider>
        <UsersTab
          users={[sessionUser({ totpEnabled: false })]}
          loading={false}
          error={null}
          reload={() => undefined}
          currentUserId={99}
        />
      </AuthProvider>,
    );
    // 等 AuthProvider 的会话探测落地（否则测试结束时会触发 act 警告）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText('两步验证已启用')).toBeNull();
    expect(screen.queryByRole('button', { name: '重置两步验证' })).toBeNull();
  });
});

// ---------------------------------------------------------------- 6. ApiClient 契约与 401 语义

describe('ApiClient · TOTP 接口与 401 语义', () => {
  it('loginTotp 走 /api/auth/login/totp，且 401 不触发全局登出回调（会话尚未建立）', async () => {
    const calls = stubFetch({ '/api/auth/login/totp': () => errorResponse('TOTP_INVALID', '验证码不正确') });
    const onUnauthorized = vi.fn();
    const client = new ApiClient({ onUnauthorized });

    const error = (await client
      .loginTotp({ challengeToken: 'challenge-abc', code: '123456', remember: true })
      .catch((e: unknown) => e)) as ApiError;

    expect(calls[0]?.url).toBe('/api/auth/login/totp');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ challengeToken: 'challenge-abc', code: '123456', remember: true });
    expect(error.code).toBe('TOTP_INVALID');
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('输错验证码（401 TOTP_INVALID）不会把用户踢下线', async () => {
    stubFetch({
      '/api/users/me/totp/enable': () => errorResponse('TOTP_INVALID', '验证码不正确'),
      '/api/users/me/totp/recovery-codes': () => errorResponse('TOTP_INVALID', '验证码或恢复码不正确'),
      '/api/users/me/totp/disable': () => errorResponse('INVALID_CREDENTIALS', '密码错误'),
    });
    const onUnauthorized = vi.fn();
    const client = new ApiClient({ getCsrfToken: () => 'csrf-1', onUnauthorized });

    const codes: string[] = [];
    codes.push(((await client.totpEnable({ code: '000000' }).catch((e: unknown) => e)) as ApiError).code);
    codes.push(((await client.totpRegenerateRecoveryCodes({ code: '000000' }).catch((e: unknown) => e)) as ApiError).code);
    codes.push(((await client.totpDisable({ password: 'pw', code: '000000' }).catch((e: unknown) => e)) as ApiError).code);

    expect(codes).toEqual(['TOTP_INVALID', 'TOTP_INVALID', 'INVALID_CREDENTIALS']);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('会话真的失效（401 UNAUTHORIZED）仍然触发全局回调', async () => {
    stubFetch({ '/api/users/me/totp/setup': () => errorResponse('UNAUTHORIZED', '会话已失效') });
    const onUnauthorized = vi.fn();
    const client = new ApiClient({ getCsrfToken: () => 'csrf-1', onUnauthorized });

    const error = (await client.totpSetup().catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('UNAUTHORIZED');
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });

  it('各个自助接口的路径、方法与 CSRF 头符合契约', async () => {
    const calls = stubFetch({
      '/api/users/me/totp/setup': () =>
        jsonResponse({ secret: 'S', otpauthUri: 'otpauth://totp/x', digits: 6, period: 30 }),
      '/api/users/me/totp/enable': () => jsonResponse({ recoveryCodes: ['AAAA-BBBB'], user: sessionUser({ totpEnabled: true }) }),
      '/api/users/me/totp/disable': () => jsonResponse({ ok: true, user: sessionUser() }),
      '/api/users/7/totp/reset': () => jsonResponse({ ok: true, revokedSessions: 2 }),
    });
    const client = new ApiClient({ getCsrfToken: () => 'csrf-9' });

    await client.totpSetup();
    await client.totpEnable({ code: '123456' });
    await client.totpDisable({ password: 'pw', code: '123456' });
    const reset = await client.resetUserTotp(7);

    expect(calls.map((call) => call.url)).toEqual([
      '/api/users/me/totp/setup',
      '/api/users/me/totp/enable',
      '/api/users/me/totp/disable',
      '/api/users/7/totp/reset',
    ]);
    for (const call of calls) {
      expect(call.init.method).toBe('POST');
      // 变更类请求都带 CSRF（这些接口都在会话建立之后调用）
      expect(call.headers['x-csrf-token']).toBe('csrf-9');
    }
    expect(calls[2]?.body).toEqual({ password: 'pw', code: '123456' });
    expect(reset).toEqual({ ok: true, revokedSessions: 2 });
  });

  it('关闭两步验证缺验证码时，后端 400 的 fieldErrors 可被表单读取', async () => {
    stubFetch({
      '/api/users/me/totp/disable': () =>
        jsonResponse(
          {
            error: {
              code: 'VALIDATION_FAILED',
              message: '请输入当前验证码',
              details: { fieldErrors: { code: ['请输入当前的 6 位验证码或恢复码'] } },
            },
          },
          400,
        ),
    });

    const error = (await new ApiClient().totpDisable({ password: 'pw' }).catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(400);
    expect(error.fieldErrors.code?.[0]).toBe('请输入当前的 6 位验证码或恢复码');
  });
});