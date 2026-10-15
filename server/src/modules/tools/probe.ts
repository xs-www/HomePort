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
  /** 失败后的兜底主机（通常为 127.0.0.1） */
  fallbackHost?: string | null;
  logger?: Logger;
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
 * @returns 探测结果（永不抛异常）
 */
export async function probeTool(options: ProbeOptions): Promise<ProbeResult> {
  const { host, port, scheme, probePath, expectedStatus, timeoutMs, fallbackHost, logger } = options;
  const checkedAt = new Date().toISOString();

  const primary = await tryProbe(host, port, scheme, probePath, expectedStatus, timeoutMs);
  if (primary.state === 'up' || !fallbackHost || fallbackHost === host) {
    return { ...primary, checkedAt, target: primary.state === 'unknown' ? null : { host, port } };
  }

  const secondary = await tryProbe(fallbackHost, port, scheme, probePath, expectedStatus, timeoutMs);
  if (secondary.state === 'up') {
    return {
      ...secondary,
      checkedAt,
      target: { host: fallbackHost, port },
      detail: `经 ${fallbackHost} 可访问，但经 ${host} 不可访问。若其它设备也打不开，请检查容器的端口绑定地址与防火墙`,
    };
  }

  logger?.debug('工具探测失败', { host, port, primary: primary.detail, secondary: secondary.detail });
  return {
    ...primary,
    checkedAt,
    target: null,
    detail: primary.detail ?? secondary.detail ?? '无法连接',
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
