/**
 * 工具可用性探测：TCP 连通性 + 可选 HTTP 状态校验。
 *
 * 判定策略（两级）：
 * 1. **TCP 连接**该端口，超时即判 down。
 * 2. 若工具声明了 `probePath`，再发一个 HTTP GET 并检查状态码；
 *    连不上 HTTP 但 TCP 通 → 仍判 `up`，但 `detail` 标注"未通过 HTTP 校验"
 *    （例如服务是纯 TCP 协议或有鉴权跳转）。
 *
 * 探测目标主机选择：优先用门户当前的对外主机（与用户点击入口时走同一条路径），
 * 失败且主机不是 localhost 时再用 `127.0.0.1` 复测一次，用于区分
 * "服务没起来"与"从门户这边网络路径不通"。
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import type { Logger } from '../../logger.js';

export type ProbeState = 'up' | 'down' | 'unknown';

export interface ProbeResult {
  state: ProbeState;
  latencyMs: number | null;
  httpStatus: number | null;
  checkedAt: string;
  detail: string | null;
  /** 实际探测使用的主机与端口 */
  target: { host: string; port: number } | null;
}

export interface ProbeOptions {
  host: string;
  port: number;
  scheme: 'http' | 'https';
  probePath: string;
  expectedStatus: number | null;
  timeoutMs: number;
  /**
   * 兜底主机列表（按顺序尝试）。
   *
   * 为什么需要：门户跑在容器里，用户浏览器访问门户用的主机名（如 `localhost`
   * 或 `127.0.0.1`）在容器内指向**容器自己**，而不是宿主。
   * 宿主上的服务在容器内要用 `host.docker.internal` 才连得上。
   * 默认兜底链见 `defaultFallbackHosts()`。
   */
  fallbackHosts?: readonly string[];
  logger?: Logger;
}

/**
 * 默认兜底主机链。
 *
 * - `host.docker.internal`：Docker Desktop 与（配了 host-gateway 的）Linux 上
 *   指向宿主的特殊域名，是"宿主服务"最可靠的探测目标。
 * - `127.0.0.1`：门户原生运行（非容器）时就是宿主本身。
 *
 * 去重与"跳过与首选相同者"的逻辑在 `probeTool` 内处理。
 */
export function defaultFallbackHosts(): string[] {
  return ['host.docker.internal', '127.0.0.1'];
}

/** TCP 连通性测试。 */
export function tcpConnect(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; latencyMs: number; error: string | null }> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = new net.Socket();
    let settled = false;

    const done = (ok: boolean, error: string | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ok, latencyMs: Date.now() - startedAt, error });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true, null));
    socket.once('timeout', () => done(false, `TCP 连接超时（>${timeoutMs}ms）`));
    socket.once('error', (error: NodeJS.ErrnoException) => done(false, describeNetError(error)));
    socket.connect(port, host);
  });
}

/** 发起一次 HTTP(S) GET 并返回状态码（不读取 body）。 */
export function httpStatus(
  host: string,
  port: number,
  scheme: 'http' | 'https',
  path: string,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const transport = scheme === 'https' ? https : http;
    let settled = false;

    const done = (ok: boolean, status: number | null, error: string | null): void => {
      if (settled) return;
      settled = true;
      resolve({ ok, status, error });
    };

    let request: http.ClientRequest;
    try {
      request = transport.request(
        {
          host,
          port,
          path,
          method: 'GET',
          timeout: timeoutMs,
          headers: { 'user-agent': 'homepage-portal-probe/1.0', accept: '*/*' },
          // 自签证书场景（NAS 常见）不阻断探测
          ...(scheme === 'https' ? { rejectUnauthorized: false } : {}),
        },
        (response) => {
          response.resume();
          const status = response.statusCode ?? null;
          done(true, status, null);
        },
      );
    } catch (error) {
      done(false, null, error instanceof Error ? error.message : String(error));
      return;
    }

    request.on('timeout', () => {
      request.destroy();
      done(false, null, `HTTP 请求超时（>${timeoutMs}ms）`);
    });
    request.on('error', (error: NodeJS.ErrnoException) => done(false, null, describeNetError(error)));
    request.end();
  });
}

/**
 * 综合探测单个工具。
 *
 * 依次尝试：首选主机（门户的对外主机名）→ 兜底链。
 * 任一成功即返回 `up`，并在 `detail` 说明实际是通过哪个主机连上的 ——
 * 这样"入口链接打不开但端口是通的"这类问题能被用户直接看到。
 *
 * @returns 探测结果（永不抛异常）
 */
export async function probeTool(options: ProbeOptions): Promise<ProbeResult> {
  const { host, port, scheme, probePath, expectedStatus, timeoutMs, logger } = options;
  const checkedAt = new Date().toISOString();

  // 组装候选目标：首选 + 兜底（去重、保持顺序）
  const targets: string[] = [];
  for (const candidate of [host, ...(options.fallbackHosts ?? defaultFallbackHosts())]) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    if (!targets.includes(trimmed)) targets.push(trimmed);
  }

  const failures: Array<{ host: string; detail: string | null }> = [];

  for (const target of targets) {
    const attempt = await tryProbe(target, port, scheme, probePath, expectedStatus, timeoutMs);
    if (attempt.state === 'up') {
      const isPrimary = target === targets[0];
      return {
        ...attempt,
        checkedAt,
        target: { host: target, port },
        // 备用主机连上时明确说明，避免用户以为入口链接一定可用
        detail: isPrimary
          ? attempt.detail
          : `端口可用（经 ${target} 探测）。若从浏览器打不开，可能是入口链接中的主机名在当前网络下不可达`,
      };
    }
    failures.push({ host: target, detail: attempt.detail });
  }

  // 全部失败：以首选主机的失败原因为主，附上其余尝试结果
  const primary = failures[0];
  const others = failures
    .slice(1)
    .map((f) => `${f.host}：${f.detail ?? '未知'}`)
    .join('；');
  logger?.debug('工具探测全部失败', { host, port, failures });

  return {
    state: 'down',
    latencyMs: null,
    httpStatus: null,
    checkedAt,
    target: null,
    detail: others
      ? `${primary?.detail ?? '无法连接'}（另尝试 ${others}）`
      : (primary?.detail ?? '无法连接'),
  };
}

async function tryProbe(
  host: string,
  port: number,
  scheme: 'http' | 'https',
  probePath: string,
  expectedStatus: number | null,
  timeoutMs: number,
): Promise<Omit<ProbeResult, 'checkedAt' | 'target'>> {
  const tcp = await tcpConnect(host, port, timeoutMs);
  if (!tcp.ok) {
    return { state: 'down', latencyMs: tcp.latencyMs, httpStatus: null, detail: tcp.error };
  }

  const http = await httpStatus(host, port, scheme, probePath, timeoutMs);
  if (!http.ok) {
    return {
      state: 'up',
      latencyMs: tcp.latencyMs,
      httpStatus: null,
      detail: `TCP 端口已开放，但 HTTP 校验未通过：${http.error ?? '未知原因'}`,
    };
  }

  const status = http.status;
  if (status !== null && status >= 500) {
    return {
      state: 'down',
      latencyMs: tcp.latencyMs,
      httpStatus: status,
      detail: `服务返回 ${status}`,
    };
  }
  if (expectedStatus !== null && status !== expectedStatus) {
    return {
      state: 'up',
      latencyMs: tcp.latencyMs,
      httpStatus: status,
      detail: `端口可用，但健康检查返回 ${status}（期望 ${expectedStatus}）`,
    };
  }
  return { state: 'up', latencyMs: tcp.latencyMs, httpStatus: status, detail: null };
}

/** 网络错误 → 中文说明。 */
export function describeNetError(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case 'ECONNREFUSED':
      return '连接被拒绝（端口未监听，服务可能未启动）';
    case 'EHOSTUNREACH':
      return '主机不可达';
    case 'ENETUNREACH':
      return '网络不可达';
    case 'ENOTFOUND':
      return '域名解析失败';
    case 'ETIMEDOUT':
      return '连接超时';
    case 'ECONNRESET':
      return '连接被重置';
    case 'EPERM':
      return '权限不足，被策略阻止';
    default:
      return error.message;
  }
}
