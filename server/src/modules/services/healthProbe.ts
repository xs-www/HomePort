/**
 * 服务健康探测的**安全边界**。
 *
 * 为什么单独一个文件、并且写得这么啰嗦：这是本项目里唯一一个"服务器主动向用户提供的地址
 * 发起请求"的功能，也就是典型的 SSRF 面。目标是把它做成**可审计的一小块**，
 * 而不是散在路由里的一行 `fetch(...)`。
 *
 * 授权模型（计划 §4 验收："后端健康探测防 SSRF，禁止探测敏感本地管理地址
 * （除可信明确授权范围）"）：
 * 1. 只有管理员**显式保存**了 `healthTarget`（或探测请求里显式给出目标）才会发起请求 ——
 *    这个显式动作就是"可信明确授权范围"；
 * 2. 即使显式授权，命中**拒绝清单**的地址依然拒绝（云元数据、Docker API 等
 *    "被探测就会造成危害"的目标不因授权而放行）；
 * 3. loopback 与私网**允许**：家用场景刚需（`http://127.0.0.1:36065/health`），
 *    且目标由管理员显式保存。此取舍必须写进安全文档，不能默默放宽。
 *
 * 请求纪律：GET、不跟随跳转、3 秒超时、最多读 16KB 响应体后丢弃、只取状态码与耗时。
 */
import { isIP } from 'node:net';

/** 探测超时（毫秒）。 */
export const HEALTH_PROBE_TIMEOUT_MS = 3000;
/** 响应体最多读取的字节数（读满即丢弃，只看状态码）。 */
export const HEALTH_PROBE_MAX_BODY_BYTES = 16 * 1024;

export type HealthProbeRejectReason =
  | 'EMPTY'
  | 'TOO_LONG'
  | 'BAD_SCHEME'
  | 'NO_HOST'
  | 'CREDENTIALS_IN_URL'
  | 'METADATA_ADDRESS'
  | 'DOCKER_API'
  | 'UNIX_SOCKET'
  | 'BAD_HOST';

export interface HealthProbeTarget {
  url: string;
  host: string;
  port: number;
  scheme: 'http' | 'https';
}

export type HealthProbeValidation =
  | { ok: true; target: HealthProbeTarget }
  | { ok: false; reason: HealthProbeRejectReason; message: string };

const MAX_URL_LENGTH = 2048;

/** 云元数据 / link-local：探测它们等于把实例凭据往外送。 */
const METADATA_HOSTS: readonly string[] = [
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  'localhost.localdomain',
];

/** Docker 守护进程 API 端口：GET 也可能触发拉镜像/读容器信息，一律不碰。 */
const DOCKER_API_PORTS: readonly number[] = [2375, 2376, 2377];

function isLinkLocalIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const [a, b] = [Number(match[1]), Number(match[2])];
  return a === 169 && b === 254;
}

function isLinkLocalIpv6(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === 'fd00:ec2::254' || lower.startsWith('fe80:');
}

/**
 * 校验一个健康探测目标。**纯函数**，不发起任何请求。
 *
 * 拒绝顺序刻意从"格式"到"危险目标"，错误信息面向管理员（要能看懂为什么被拒）。
 */
export function validateHealthTarget(raw: string | null | undefined): HealthProbeValidation {
  const value = (raw ?? '').trim();
  if (value === '') return { ok: false, reason: 'EMPTY', message: '健康探测地址为空' };
  if (value.length > MAX_URL_LENGTH) {
    return { ok: false, reason: 'TOO_LONG', message: `健康探测地址过长（上限 ${MAX_URL_LENGTH} 字符）` };
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'NO_HOST', message: '健康探测地址不是合法的 URL' };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== 'http:' && scheme !== 'https:') {
    return {
      ok: false,
      reason: 'BAD_SCHEME',
      message: `只允许 http/https，收到 ${scheme.replace(':', '') || '未知'}（拒绝 javascript:/data:/file: 等）`,
    };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, reason: 'CREDENTIALS_IN_URL', message: '健康探测地址不能内嵌用户名或密码' };
  }

  const host = parsed.hostname.trim().replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === '') return { ok: false, reason: 'NO_HOST', message: '健康探测地址缺少主机名' };
  // 主机名里出现 docker.sock、或**路径**里出现 docker.sock（`http://127.0.0.1/var/run/docker.sock`），
  // 以及任何 unix:// 写法都拒绝：spec §4.4 的拒绝清单明确包含"unix socket 路径（含 docker.sock）"。
  if (host.includes('docker.sock') || parsed.pathname.includes('docker.sock') || value.includes('unix://')) {
    return { ok: false, reason: 'UNIX_SOCKET', message: '不允许探测 unix socket 地址' };
  }
  if (host === '0.0.0.0' || host === '::' || host === '*') {
    return { ok: false, reason: 'BAD_HOST', message: '不允许探测通配地址 0.0.0.0/::' };
  }
  if (METADATA_HOSTS.includes(host)) {
    return { ok: false, reason: 'METADATA_ADDRESS', message: '不允许探测云元数据地址' };
  }
  if (isIP(host) === 4 && isLinkLocalIpv4(host)) {
    return { ok: false, reason: 'METADATA_ADDRESS', message: '不允许探测 link-local 地址（169.254.0.0/16）' };
  }
  if (isIP(host) === 6 && isLinkLocalIpv6(host)) {
    return { ok: false, reason: 'METADATA_ADDRESS', message: '不允许探测 link-local IPv6 地址' };
  }

  // 主机合法性：IP 或"看起来像域名"（含至少一个点，或就是 localhost 这类单词主机）
  const looksLikeHostname = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host);
  if (isIP(host) === 0 && !looksLikeHostname) {
    return { ok: false, reason: 'BAD_HOST', message: '健康探测地址的主机名不合法' };
  }

  const defaultPort = scheme === 'https:' ? 443 : 80;
  const port = parsed.port === '' ? defaultPort : Number(parsed.port);
  if (DOCKER_API_PORTS.includes(port)) {
    return {
      ok: false,
      reason: 'DOCKER_API',
      message: `不允许探测 Docker API 端口 ${port}（即使只读也可能泄露容器信息）`,
    };
  }

  return { ok: true, target: { url: parsed.toString(), host, port, scheme: scheme === 'https:' ? 'https' : 'http' } };
}

export interface HealthProbeResult {
  state: 'ok' | 'fail';
  statusCode: number | null;
  durationMs: number;
  detail: string | null;
  at: string;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * 丢掉响应体，但**最多读 `maxBytes`**，读完立刻取消流。
 *
 * 为什么不用 `response.text()`：那会读**完整**响应体。健康目标是管理员填的任意地址，
 * 可以是任何进程（包括一个返回无限流的服务，或者一个被入侵的服务），
 * `text()` 就等于让对端决定我们要分配多少内存 —— 一个 `while(true) res.write(...)`
 * 就能把门户撑爆。这个上限就是 `HEALTH_PROBE_MAX_BODY_BYTES` 存在的唯一理由。
 *
 * 读满上限后 `reader.cancel()`：让 fetch 层丢掉剩余数据并释放连接，
 * 而不是继续把对端的输出读进来。任何异常都不影响"看状态码"这件事，所以整体吞掉。
 */
async function discardProbeBody(response: Response, maxBytes: number): Promise<void> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // 没有流式 body（空响应 / 某些测试替身）→ 没有"无限流"风险，退回一次性读取
    try {
      await response.text();
    } catch {
      /* 读体失败不影响状态码判定 */
    }
    return;
  }

  const reader = body.getReader();
  let read = 0;
  try {
    while (read < maxBytes) {
      const chunk = await reader.read();
      if (chunk.done) return;
      read += chunk.value?.byteLength ?? 0;
    }
  } catch {
    /* 读体中途失败（含超时 abort）不影响状态码判定 */
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 流已关闭 */
    }
  }
}

export interface RunHealthProbeInput {
  target: string;
  /** 测试注入用；生产传 `globalThis.fetch` */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

/**
 * 执行一次健康探测。
 *
 * 走 `validateHealthTarget`；校验不通过直接返回 `fail`（**不发起任何请求**）。
 * 任何异常都被收敛成 `fail` + 人类可读原因，绝不抛给调用方，也不重试。
 */
export async function runHealthProbe(input: RunHealthProbeInput): Promise<HealthProbeResult> {
  const now = input.now ?? ((): Date => new Date());
  const validation = validateHealthTarget(input.target);
  if (!validation.ok) {
    return {
      state: 'fail',
      statusCode: null,
      durationMs: 0,
      detail: `已拒绝：${validation.message}`,
      at: now().toISOString(),
    };
  }

  const timeoutMs = input.timeoutMs ?? HEALTH_PROBE_TIMEOUT_MS;
  const impl = input.fetchImpl ?? (globalThis.fetch as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();

  try {
    const response = await impl(validation.target.url, {
      method: 'GET',
      // 不跟随跳转：跳转可能把请求带到被拒绝的地址上（SSRF 经典绕过）
      redirect: 'manual',
      signal: controller.signal,
      headers: { accept: '*/*', 'user-agent': 'HomePort-HealthProbe/1.0' },
    });
    // 只取状态码与耗时：响应体**最多读上限**就丢弃（见 discardProbeBody）
    await discardProbeBody(response, HEALTH_PROBE_MAX_BODY_BYTES);
    const durationMs = Date.now() - startedAt;
    const ok = response.status >= 200 && response.status < 400;
    return {
      state: ok ? 'ok' : 'fail',
      statusCode: response.status,
      durationMs,
      detail: ok ? null : `目标返回 HTTP ${response.status}`,
      at: now().toISOString(),
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const aborted = controller.signal.aborted;
    const message = aborted
      ? `探测超时（>${timeoutMs}ms）`
      : error instanceof Error
        ? error.message
        : String(error);
    return { state: 'fail', statusCode: null, durationMs, detail: message, at: now().toISOString() };
  } finally {
    clearTimeout(timer);
  }
}