/**
 * 系统指标的 SSE 订阅 hook。
 *
 * 为什么用 SSE 而不是轮询：CPU 使用率需要稳定的采样间隔才有意义，
 * 服务端统一按 `PORTAL_METRICS_INTERVAL_MS` 采样并推送，多标签页也共享同一序列。
 *
 * 断线处理交给浏览器 `EventSource` 的自动重连；这里只维护「最近一帧」与连接状态。
 */
import { useEffect, useRef, useState } from 'react';
import type { SystemMetricsFrame } from '../api/types.js';

export type StreamStatus = 'connecting' | 'open' | 'error' | 'closed';

export interface MetricsStream {
  frame: SystemMetricsFrame | null;
  status: StreamStatus;
  /** 已接收帧数（用于诊断） */
  frames: number;
  /** 最近一次错误信息 */
  lastError: string | null;
  /** 手动重连（清掉当前连接后由 effect 重建） */
  reconnect: () => void;
}

/**
 * 订阅 `/api/system/stream`。
 *
 * @param enabled 是否启用（例如页面不可见时可以关闭）
 */
export function useMetricsStream(enabled = true): MetricsStream {
  const [frame, setFrame] = useState<SystemMetricsFrame | null>(null);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [frames, setFrames] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (!enabled) {
      setStatus('closed');
      return;
    }

    const source = new EventSource('/api/system/stream', { withCredentials: true });
    sourceRef.current = source;
    setStatus('connecting');

    source.addEventListener('open', () => {
      setStatus('open');
      setLastError(null);
    });

    source.addEventListener('metrics', (event) => {
      try {
        const parsed = JSON.parse((event as MessageEvent<string>).data) as SystemMetricsFrame;
        setFrame(parsed);
        setFrames((n) => n + 1);
        setStatus('open');
        setLastError(null);
      } catch (error) {
        setLastError(error instanceof Error ? error.message : '指标解析失败');
      }
    });

    source.addEventListener('error', (event) => {
      // EventSource 的 error 事件在自动重连期间会反复触发，这里只记录状态
      const message = (event as MessageEvent<string>).data;
      setStatus('error');
      setLastError(typeof message === 'string' && message !== '' ? message : '指标流已断开，正在重连…');
    });

    return () => {
      source.close();
      sourceRef.current = null;
      setStatus('closed');
    };
  }, [enabled, nonce]);

  return {
    frame,
    status,
    frames,
    lastError,
    reconnect: () => setNonce((n) => n + 1),
  };
}
