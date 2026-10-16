/**
 * 健康探测的安全边界单测（spec §4.4 / §7）。
 *
 * 这个文件只测**纯函数 + 注入 fetch**，因此可以断言那些在生产里无法断言的事：
 * 拒绝清单命中时**一个请求都不发**、请求 `redirect: 'manual'`、超时确实中断。
 * 路由级的断言（返回 `state:'fail'` 且 detail 含"已拒绝"）在 `servicesApi.test.ts`。
 *
 * 全程不碰真实网络：所有 fetch 都是注入的假实现。
 */
import { describe, expect, it } from 'vitest';
import {
  HEALTH_PROBE_MAX_BODY_BYTES,
  HEALTH_PROBE_TIMEOUT_MS,
  runHealthProbe,
  validateHealthTarget,
  type FetchLike,
} from '../src/modules/services/healthProbe.js';
import { resolveHealthTarget } from '../src/modules/services/service.js';

/** 记录调用次数的 fetch：任何调用都会让"零请求"断言失败。 */
function countingFetch(): { calls: () => number; impl: FetchLike } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    throw new Error('本用例不应发起网络请求');
  }) as FetchLike;
  return { calls: () => calls, impl };
}

function jsonResponse(status: number): Response {
  return new Response(status === 204 ? null : '{"ok":true}', { status });
}

function rejecting(reason: string) {
  return validateHealthTarget(reason);
}

describe('validateHealthTarget · 拒绝清单与格式校验', () => {
  it('接受 http/https 的合法目标（含 loopback 与私网 —— 家用场景刚需）', () => {
    for (const url of [
      'http://127.0.0.1:36065/health',
      'https://family-nas.tail585599.ts.net:8443/calendar',
      'http://host.docker.internal:8080/healthz',
      'http://192.168.1.10:9000/',
    ]) {
      const validation = validateHealthTarget(url);
      expect(validation.ok, url).toBe(true);
    }
  });

  it('空值与超长直接拒绝', () => {
    expect(rejecting('')).toMatchObject({ ok: false, reason: 'EMPTY' });
    expect(rejecting('   ')).toMatchObject({ ok: false, reason: 'EMPTY' });
    const long = `http://example.com/${'a'.repeat(2100)}`;
    expect(rejecting(long)).toMatchObject({ ok: false, reason: 'TOO_LONG' });
  });

  it('非 http/https 的 scheme 一律拒绝（javascript / data / file / vbscript）', () => {
    for (const url of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'vbscript:msgbox(1)',
      'ftp://example.com/x',
    ]) {
      expect(rejecting(url), url).toMatchObject({ ok: false, reason: 'BAD_SCHEME' });
    }
  });

  it('内嵌凭据的 URL 拒绝（user:pass@）', () => {
    expect(rejecting('http://admin:secret@127.0.0.1:8080/')).toMatchObject({
      ok: false,
      reason: 'CREDENTIALS_IN_URL',
    });
  });

  it('云元数据与 link-local 地址拒绝（169.254.0.0/16、fd00:ec2::254、metadata.google.internal）', () => {
    for (const url of [
      'http://169.254.169.254/',
      'http://169.254.1.1/latest/meta-data/',
      'http://[fd00:ec2::254]/',
      'http://[fe80::1]/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(rejecting(url), url).toMatchObject({ ok: false, reason: 'METADATA_ADDRESS' });
    }
  });

  it('通配地址与 unix socket 路径拒绝', () => {
    expect(rejecting('http://0.0.0.0:8080/')).toMatchObject({ ok: false, reason: 'BAD_HOST' });
    expect(rejecting('http://docker.sock/')).toMatchObject({ ok: false, reason: 'UNIX_SOCKET' });
    expect(rejecting('http://127.0.0.1/var/run/docker.sock')).toMatchObject({ ok: false, reason: 'UNIX_SOCKET' });
  });

  it('Docker API 端口拒绝（即使只读也可能泄露容器信息）', () => {
    expect(rejecting('http://127.0.0.1:2375/containers/json')).toMatchObject({ ok: false, reason: 'DOCKER_API' });
    expect(rejecting('https://127.0.0.1:2376/')).toMatchObject({ ok: false, reason: 'DOCKER_API' });
  });

  it('不是 URL / 主机名非法时给出可读原因', () => {
    expect(rejecting('not a url')).toMatchObject({ ok: false, reason: 'NO_HOST' });
    expect(rejecting('http://-bad-.example.com/')).toMatchObject({ ok: false, reason: 'BAD_HOST' });
  });
});

describe('runHealthProbe · 注入 fetch 的请求纪律', () => {
  it('不跟随跳转（redirect=manual）、GET、带超时信号', async () => {
    let observed: RequestInit | undefined;
    let observedUrl = '';
    const impl: FetchLike = async (input, init) => {
      observedUrl = input;
      observed = init;
      return jsonResponse(200);
    };

    const result = await runHealthProbe({ target: 'http://127.0.0.1:36065/health', fetchImpl: impl });

    expect(observedUrl).toBe('http://127.0.0.1:36065/health');
    expect(observed?.method).toBe('GET');
    expect(observed?.redirect).toBe('manual');
    expect(observed?.signal).toBeInstanceOf(AbortSignal);
    expect(result.state).toBe('ok');
    expect(result.statusCode).toBe(200);
  });

  it('2xx / 3xx → ok；404 / 500 → fail', async () => {
    const ok = await runHealthProbe({ target: 'http://127.0.0.1:8080/', fetchImpl: async () => jsonResponse(204) });
    expect(ok).toMatchObject({ state: 'ok', statusCode: 204 });

    const redirect = await runHealthProbe({ target: 'http://127.0.0.1:8080/', fetchImpl: async () => jsonResponse(302) });
    expect(redirect).toMatchObject({ state: 'ok', statusCode: 302 });

    const missing = await runHealthProbe({ target: 'http://127.0.0.1:8080/', fetchImpl: async () => jsonResponse(404) });
    expect(missing.state).toBe('fail');
    expect(missing.detail).toContain('404');

    const broken = await runHealthProbe({ target: 'http://127.0.0.1:8080/', fetchImpl: async () => jsonResponse(500) });
    expect(broken.state).toBe('fail');
  });

  it('超时 → fail 且写明超时（不重试）', async () => {
    let calls = 0;
    const impl: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        calls += 1;
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')));
      });

    const result = await runHealthProbe({ target: 'http://127.0.0.1:9/', fetchImpl: impl, timeoutMs: 20 });

    expect(calls).toBe(1); // 只发一次，绝不重试
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('超时');
    expect(result.statusCode).toBeNull();
    expect(HEALTH_PROBE_TIMEOUT_MS).toBe(3000); // 生产默认值被钉住
  });

  it('网络错误 → fail 并带上原因', async () => {
    const impl: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await runHealthProbe({ target: 'http://127.0.0.1:9/', fetchImpl: impl });
    expect(result.state).toBe('fail');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('被拒绝的目标**零请求**（javascript: / 云元数据 / Docker API）', async () => {
    for (const target of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'http://169.254.169.254/',
      'http://127.0.0.1:2375/containers/json',
      'http://docker.sock/',
    ]) {
      const network = countingFetch();
      const result = await runHealthProbe({ target, fetchImpl: network.impl });
      expect(network.calls(), `${target} 不该发起请求`).toBe(0);
      expect(result.state, target).toBe('fail');
      expect(result.detail, target).toContain('已拒绝');
    }
  });
});

describe('runHealthProbe · 响应体读取上限', () => {
  it('无限流：读满上限就主动断开，而不是把响应体整个读进内存', async () => {
    let pulled = 0;
    let cancelled = false;
    const chunk = new Uint8Array(8 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        // 兜底：真被读完就结束，避免用例把测试进程拖死（正常实现不会走到这里）
        if (pulled > 1000) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });

    const result = await runHealthProbe({
      target: 'http://127.0.0.1:8080/health',
      fetchImpl: async () => new Response(stream, { status: 200 }),
    });

    // 状态码照常判定（上限只影响读体，不影响健康结论）
    expect(result.state).toBe('ok');
    expect(result.statusCode).toBe(200);
    // 关键断言：是**主动取消**，而不是读完整条流
    expect(cancelled).toBe(true);
    // 读入量在"上限 + 一个分片"以内（允许一点预读，但不允许读完 8MB）
    expect(pulled * chunk.byteLength).toBeLessThanOrEqual(HEALTH_PROBE_MAX_BODY_BYTES + chunk.byteLength * 2);
  });

  it('没有流式 body（空响应）时不报错，仍按状态码判定', async () => {
    const result = await runHealthProbe({
      target: 'http://127.0.0.1:8080/health',
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(result.state).toBe('ok');
    expect(result.statusCode).toBe(204);
  });
});

describe('resolveHealthTarget · 探测目标优先级', () => {
  it('显式覆盖优先于已保存的值', () => {
    expect(
      resolveHealthTarget({ overrideTarget: 'http://127.0.0.1:1/x', healthTarget: 'http://127.0.0.1:2/y', healthPath: null }),
    ).toBe('http://127.0.0.1:1/x');
  });

  it('其次用已保存的 healthTarget', () => {
    expect(resolveHealthTarget({ overrideTarget: null, healthTarget: 'http://127.0.0.1:2/y', healthPath: '/healthz' })).toBe(
      'http://127.0.0.1:2/y',
    );
  });

  it('healthPath 追加到首选入口（相对路径语义）', () => {
    expect(
      resolveHealthTarget({
        overrideTarget: null,
        healthTarget: null,
        healthPath: '/healthz',
        entry: 'https://family-nas.tail585599.ts.net:8443/calendar',
      }),
    ).toBe('https://family-nas.tail585599.ts.net:8443/healthz');
  });

  it('什么都没配（或没有可用入口）→ null（调用方据此报 400）', () => {
    expect(resolveHealthTarget({ overrideTarget: '  ', healthTarget: null, healthPath: null })).toBeNull();
    expect(resolveHealthTarget({ healthPath: '/healthz', entry: null })).toBeNull();
  });
});