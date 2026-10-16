/**
 * `web/src/api/client.ts` 单元测试（S0-05）。
 *
 * 覆盖点：
 * 1. CSRF：变更类请求自动注入 `X-CSRF-Token`，GET/HEAD 不注入，令牌缺失时不发空头。
 * 2. 后端 `{ error: { code, message, details } }` → `ApiError`（含 `fieldErrors`）。
 * 3. 非 JSON 响应（HTML 500 / HTML 200）不因 `JSON.parse` 崩溃。
 * 4. 401 触发 `onUnauthorized`，`skipUnauthorizedHandler` 时跳过。
 * 5. 超时（AbortController 内部计时器 / 外部 signal）→ `TIMEOUT`，与网络失败 `NETWORK_ERROR` 区分。
 *
 * 全部通过 `vi.stubGlobal('fetch', ...)` 造假响应，绝不发真实请求；
 * 超时用 `vi.useFakeTimers()` 推进，不依赖真实时间流逝。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient, ApiError, api, toApiError } from '../src/api/client.js';

// ---------------------------------------------------------------- 假响应工具

/** 造一个 JSON 响应。 */
function jsonResponse(payload: unknown, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

/** 造一个非 JSON（HTML / 纯文本）响应。 */
function textResponse(body: string, status = 200): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => body,
  } as unknown as Response;
}

/** 造一个 204 空响应。 */
function emptyResponse(): Response {
  return {
    status: 204,
    ok: true,
    text: async () => '',
  } as unknown as Response;
}

type FetchHandler = (url: string, init: RequestInit) => Response | Promise<Response>;

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/** 安装 fetch 假实现并记录每次调用。 */
function stubFetch(handler: FetchHandler): { mock: unknown; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const mock = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

/** 一个尊重 `AbortSignal` 的假 fetch：被中止时以 `AbortError` 拒绝。 */
function abortAwareFetch(): FetchHandler {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init.signal;
      const onAbort = (): void => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
}

/** 取第 n 次 fetch 调用；缺失时直接失败，避免非空断言。 */
function callAt(calls: RecordedCall[], index = 0): RecordedCall {
  const call = calls[index];
  if (!call) throw new Error(`fetch 未被调用（第 ${index} 次）`);
  return call;
}

/** 读出请求头（源码用的键均为小写；HTTP 头名本身大小写不敏感）。 */
function headersOf(init: RequestInit): Record<string, string> {
  return (init.headers ?? {}) as Record<string, string>;
}

/** 通过私有 `request` 直接构造请求：公开方法触达不到的 HTTP 方法与外部 signal。 */
function privateRequest(
  client: ApiClient,
  path: string,
  options: Record<string, unknown>,
): Promise<unknown> {
  const internal = client as unknown as {
    request: (path: string, options?: Record<string, unknown>) => Promise<unknown>;
  };
  return internal.request(path, options);
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------- CSRF

describe('ApiClient · CSRF 注入', () => {
  it('GET 请求不注入 X-CSRF-Token（即使令牌可用）', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient({ getCsrfToken: () => 'tok-abc' });

    await client.sessionActivity();

    const { init } = callAt(calls);
    expect(init.method).toBe('GET');
    expect(headersOf(init)['x-csrf-token']).toBeUndefined();
    expect(headersOf(init)['accept']).toBe('application/json');
    expect(init.credentials).toBe('same-origin');
  });

  it('POST / PATCH / DELETE 等变更类请求注入 X-CSRF-Token', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient({ getCsrfToken: () => 'tok-abc' });

    await client.login({ username: 'admin', password: 'pw', remember: false });
    await client.updatePreferences({ theme: 'dark' });
    await client.deleteUser(7);

    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.init.method)).toEqual(['POST', 'PATCH', 'DELETE']);
    for (const call of calls) {
      expect(headersOf(call.init)['x-csrf-token']).toBe('tok-abc');
    }
  });

  it('令牌缺失（null）时不发送空头', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient({ getCsrfToken: () => null });

    await client.createUser({ username: 'u', password: 'p', displayName: 'U', role: 'viewer' });

    const headers = headersOf(callAt(calls).init);
    expect(headers['x-csrf-token']).toBeUndefined();
    expect(Object.values(headers)).not.toContain('');
  });

  it('令牌为空字符串时同样不发送空头', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient({ getCsrfToken: () => '' });

    await client.logout();

    expect(headersOf(callAt(calls).init)['x-csrf-token']).toBeUndefined();
  });

  it('未提供 getCsrfToken 时默认返回 null，不发送该头', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient();

    await client.logout();

    expect(headersOf(callAt(calls).init)['x-csrf-token']).toBeUndefined();
  });
});

// ---------------------------------------------------------------- 方法判定（私有 request）

describe('ApiClient · HTTP 方法判定（经私有 request，记录现状）', () => {
  it('PUT 属于变更类请求，会注入令牌', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient({ getCsrfToken: () => 'tok-abc' });

    await privateRequest(client, '/anything', { method: 'PUT', body: { a: 1 } });

    expect(headersOf(callAt(calls).init)['x-csrf-token']).toBe('tok-abc');
  });

  it('HEAD 目前被当作变更类请求注入令牌（源码缺陷，见报告 client.ts:113）', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient({ getCsrfToken: () => 'tok-abc' });

    await privateRequest(client, '/anything', { method: 'HEAD' });

    // 期望：HEAD 是安全方法，不应注入 CSRF。
    // 现状：`isMutating = method !== 'GET'` 把 HEAD 也判为变更类，因而注入了令牌。
    // 该断言只记录当前行为，不作为规格；源码修正后此用例应随之调整。
    expect(headersOf(callAt(calls).init)['x-csrf-token']).toBe('tok-abc');
  });

  it('传入「已中止」的外部 signal 不会阻止请求（源码缺陷，见报告 client.ts:107-108）', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient();
    const controller = new AbortController();
    controller.abort();

    await expect(
      privateRequest(client, '/anything', { signal: controller.signal }),
    ).resolves.toEqual({ ok: true });

    // 期望：已中止的 signal 应立即以 TIMEOUT 失败。
    // 现状：只在 signal 上 addEventListener，没有先判 `signal.aborted`，
    // 监听器注册时中止事件早已派发过，于是请求照常发出。
    expect(calls).toHaveLength(1);
    expect((callAt(calls).init.signal as AbortSignal).aborted).toBe(false);
  });
});

// ---------------------------------------------------------------- URL 构建

describe('ApiClient · URL 与请求体构建', () => {
  it('查询参数过滤 null/undefined/空串，并拼接为查询串', async () => {
    const { calls } = stubFetch(() => jsonResponse({ containers: [] }));
    const client = new ApiClient();

    await client.containers({ all: false, stats: true, q: undefined, reachability: '' });

    expect(callAt(calls).url).toBe('/api/containers?all=0&stats=1');
  });

  it('baseUrl 末尾斜杠被归一化，path 自动补前导斜杠', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient({ baseUrl: '/api/v1/' });

    await privateRequest(client, 'ping', {});

    expect(callAt(calls).url).toBe('/api/v1/ping');
  });

  it('无 body 时不设置 content-type，也不传 body 字段', async () => {
    const { calls } = stubFetch(() => emptyResponse());
    const client = new ApiClient();

    await client.logout();

    const { init } = callAt(calls);
    expect(headersOf(init)['content-type']).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('有 body 时序列化为 JSON 并设置 content-type', async () => {
    const { calls } = stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient();

    await client.login({ username: 'admin', password: 'pw', remember: true });

    const { init } = callAt(calls);
    expect(headersOf(init)['content-type']).toBe('application/json');
    expect(init.body).toBe(JSON.stringify({ username: 'admin', password: 'pw', remember: true }));
  });

  it('容器 id 在路径中被 URL 编码', async () => {
    const { calls } = stubFetch(() => jsonResponse({ container: {} }));
    const client = new ApiClient();

    await client.container('a b/c');

    expect(callAt(calls).url).toBe('/api/containers/a%20b%2Fc');
  });

  it('204 响应直接解析为 undefined', async () => {
    stubFetch(() => emptyResponse());
    const client = new ApiClient();

    await expect(client.deleteUser(3)).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------- 后端错误 → ApiError

describe('ApiClient · 后端错误体转换', () => {
  it('{ error: { code, message, details } } 被转成 ApiError', async () => {
    stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: '用户名不合法',
            details: { fieldErrors: { username: ['太短', '含非法字符'] } },
          },
        },
        400,
      ),
    );
    const client = new ApiClient();

    const error = await client.createUser({ username: 'x', password: 'p', displayName: 'D', role: 'admin' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.name).toBe('ApiError');
    expect(apiError.code).toBe('VALIDATION_FAILED');
    expect(apiError.message).toBe('用户名不合法');
    expect(apiError.status).toBe(400);
    expect(apiError.details).toEqual({ fieldErrors: { username: ['太短', '含非法字符'] } });
    expect(apiError.fieldErrors).toEqual({ username: ['太短', '含非法字符'] });
  });

  it('error 对象缺字段时给出兜底 code/message/details', async () => {
    stubFetch(() => jsonResponse({ error: {} }, 500));
    const client = new ApiClient();

    const error = (await client.me().catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('INTERNAL');
    expect(error.message).toBe('请求失败');
    expect(error.details).toBeNull();
    expect(error.fieldErrors).toEqual({});
  });

  it('details 非对象时 fieldErrors 返回空对象而不抛错', async () => {
    stubFetch(() => jsonResponse({ error: { code: 'X', message: 'm', details: 'oops' } }, 409));

    const error = (await new ApiClient().me().catch((e: unknown) => e)) as ApiError;

    expect(error.details).toBe('oops');
    expect(error.fieldErrors).toEqual({});
  });

  it('无错误体时按状态码给中文兜底文案', async () => {
    stubFetch(() => textResponse('', 403));

    const error = (await new ApiClient().me().catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('UNKNOWN');
    expect(error.status).toBe(403);
    expect(error.message).toBe('权限不足');
  });
});

describe('toApiError 兜底文案', () => {
  it('已知状态码映射为固定中文提示', () => {
    const cases: Array<[number, string]> = [
      [400, '请求参数不合法'],
      [404, '资源不存在'],
      [409, '操作冲突'],
      [429, '操作过于频繁，请稍后再试'],
      [500, '服务器内部错误'],
      [503, '依赖服务不可用'],
    ];
    for (const [status, message] of cases) {
      const error = toApiError(null, status);
      expect(error.message).toBe(message);
      expect(error.code).toBe('UNKNOWN');
      expect(error.status).toBe(status);
    }
  });

  it('未知状态码带上 HTTP 状态，且不因 payload 是数组/字符串而误判', () => {
    expect(toApiError('boom', 418).message).toBe('请求失败（HTTP 418）');
    expect(toApiError([1, 2], 502).message).toBe('请求失败（HTTP 502）');
    expect(toApiError({ error: 'not-an-object' }, 404).message).toBe('资源不存在');
  });
});

// ---------------------------------------------------------------- 非 JSON 响应

describe('ApiClient · 非 JSON 响应', () => {
  it('HTML 500 不因 JSON.parse 崩溃，并给出可理解的中文错误', async () => {
    stubFetch(() => textResponse('<html><body>Internal Server Error</body></html>', 500));

    const error = (await new ApiClient().overview().catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('UNKNOWN');
    expect(error.status).toBe(500);
    expect(error.message).toBe('服务器内部错误');
  });

  it('HTML 200（如 SPA 回退页）解析为 null 而不抛错', async () => {
    stubFetch(() => textResponse('<!doctype html><html></html>', 200));

    await expect(new ApiClient().overview()).resolves.toBeNull();
  });

  it('空 body 的 200 解析为 null', async () => {
    stubFetch(() => textResponse('', 200));

    await expect(new ApiClient().health()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------- 401

describe('ApiClient · 401 未授权回调', () => {
  it('401 触发 onUnauthorized 并抛出会话过期错误', async () => {
    stubFetch(() => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '会话已失效' } }, 401));
    const onUnauthorized = vi.fn();
    const client = new ApiClient({ onUnauthorized });

    const error = (await client.sessionActivity().catch((e: unknown) => e)) as ApiError;

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.status).toBe(401);
    expect(error.message).toBe('会话已失效');
  });

  it('无错误体的 401 也触发回调，文案为兜底提示', async () => {
    stubFetch(() => textResponse('', 401));
    const onUnauthorized = vi.fn();

    const error = (await new ApiClient({ onUnauthorized }).me().catch((e: unknown) => e)) as ApiError;

    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(error.message).toBe('未登录或会话已过期');
  });

  it('skipUnauthorizedHandler 的请求（session/health）401 时不触发回调', async () => {
    stubFetch(() => jsonResponse({ error: { code: 'UNAUTHORIZED', message: '未登录' } }, 401));
    const onUnauthorized = vi.fn();
    const client = new ApiClient({ onUnauthorized });

    const error = (await client.session().catch((e: unknown) => e)) as ApiError;

    expect(error.status).toBe(401);
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('非 401 的失败不触发回调', async () => {
    stubFetch(() => jsonResponse({ error: { code: 'FORBIDDEN', message: '无权限' } }, 403));
    const onUnauthorized = vi.fn();

    await new ApiClient({ onUnauthorized }).me().catch(() => undefined);

    expect(onUnauthorized).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- 超时与网络失败

describe('ApiClient · 超时与网络失败', () => {
  it('内部超时触发 AbortController → TIMEOUT（status 0）', async () => {
    vi.useFakeTimers();
    const { calls } = stubFetch(abortAwareFetch());
    const client = new ApiClient({ timeoutMs: 1000 });

    const settled = client.sessionActivity().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1000);
    const error = (await settled) as ApiError;

    expect(calls).toHaveLength(1);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('TIMEOUT');
    expect(error.status).toBe(0);
    expect(error.message).toBe('请求超时或已取消');
  });

  it('未超时的请求在计时器到点前正常返回', async () => {
    vi.useFakeTimers();
    stubFetch(() => jsonResponse({ ok: true }));
    const client = new ApiClient({ timeoutMs: 5000 });

    const settled = client.sessionActivity();
    await vi.advanceTimersByTimeAsync(4999);

    await expect(settled).resolves.toEqual({ ok: true });
  });

  it('外部 signal 中止与超时归为同一类 TIMEOUT', async () => {
    stubFetch(abortAwareFetch());
    const client = new ApiClient();
    const controller = new AbortController();

    const settled = privateRequest(client, '/anything', { signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    controller.abort();
    const error = (await settled) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('TIMEOUT');
    expect(error.status).toBe(0);
  });

  it('fetch 拒绝（TypeError: Failed to fetch）→ NETWORK_ERROR，与超时区分', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    const client = new ApiClient();

    const error = (await client.overview().catch((e: unknown) => e)) as ApiError;

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.status).toBe(0);
    expect(error.message).toContain('网络请求失败');
    expect(error.message).toContain('Failed to fetch');
  });

  it('非 Error 抛出物 → 通用网络失败文案', async () => {
    stubFetch(() => Promise.reject('boom'));
    const client = new ApiClient();

    const error = (await client.overview().catch((e: unknown) => e)) as ApiError;

    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toBe('网络请求失败');
  });

  it('超时后不会把 ApiError 再包一层网络错误', async () => {
    vi.useFakeTimers();
    stubFetch(abortAwareFetch());
    const client = new ApiClient({ timeoutMs: 50 });

    const settled = client.me().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(50);
    const error = (await settled) as ApiError;

    expect(error.code).toBe('TIMEOUT');
    expect(error.message).not.toContain('网络请求失败');
  });
});

// ---------------------------------------------------------------- 单例

describe('ApiClient · 单例导出', () => {
  it('导出名为 api 的 ApiClient 单例', () => {
    expect(api).toBeInstanceOf(ApiClient);
  });
});