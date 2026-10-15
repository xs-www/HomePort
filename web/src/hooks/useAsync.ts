/**
 * 数据获取 hook：把「加载中 / 出错 / 自动刷新 / 手动刷新」收敛成一个小工具，
 * 避免每个页面重复写 useEffect + useState 三件套。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.js';

export interface AsyncState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  /** 首次加载已完成（无论成功失败），用于区分骨架屏与刷新中的指示器 */
  loaded: boolean;
  reload: () => Promise<void>;
}

export interface UseAsyncOptions {
  /** 自动刷新间隔（ms）；0 表示不自动刷新 */
  refreshIntervalMs?: number;
  /** 是否立即加载（默认 true） */
  immediate?: boolean;
  /** 出错时是否保留上一次成功的数据（默认 true） */
  keepPreviousData?: boolean;
}

/**
 * 通用异步数据 hook。
 *
 * @param loader 数据加载函数；**必须**用 useCallback 包裹以保证引用稳定
 * @example
 * const loader = useCallback(() => api.containers(), [api]);
 * const { data, loading, error, reload } = useAsync(loader, { refreshIntervalMs: 15000 });
 */
export function useAsync<T>(loader: () => Promise<T>, options: UseAsyncOptions = {}): AsyncState<T> {
  const { refreshIntervalMs = 0, immediate = true, keepPreviousData = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(immediate);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  // 组件卸载后不再 setState，避免 React 警告与内存泄漏
  const mountedRef = useRef(true);
  // 并发保护：只接受最后一次请求的结果
  const seqRef = useRef(0);

  const run = useCallback(
    async (): Promise<void> => {
      const seq = ++seqRef.current;
      setLoading(true);
      try {
        const result = await loader();
        if (!mountedRef.current || seq !== seqRef.current) return;
        setData(result);
        setError(null);
      } catch (err) {
        if (!mountedRef.current || seq !== seqRef.current) return;
        const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : '加载失败';
        setError(message);
        if (!keepPreviousData) setData(null);
      } finally {
        if (mountedRef.current && seq === seqRef.current) {
          setLoading(false);
          setLoaded(true);
        }
      }
    },
    [loader, keepPreviousData],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!immediate) return;
    void run();
  }, [run, immediate]);

  useEffect(() => {
    if (refreshIntervalMs <= 0) return;
    const timer = setInterval(() => {
      // 页面不可见时跳过刷新，省电且避免无意义请求
      if (typeof document !== 'undefined' && document.hidden) return;
      void run();
    }, refreshIntervalMs);
    return () => clearInterval(timer);
  }, [run, refreshIntervalMs]);

  return { data, loading, error, loaded, reload: run };
}

/**
 * 表单提交状态 hook：提交中、错误、字段错误。
 */
export interface SubmitState {
  submitting: boolean;
  error: string | null;
  fieldErrors: Record<string, string[]>;
  setError: (message: string | null) => void;
  reset: () => void;
  /** 包装提交函数，自动处理 loading / 错误 */
  submit: (action: () => Promise<void>) => Promise<boolean>;
}

export function useSubmit(): SubmitState {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const submit = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    setSubmitting(true);
    setError(null);
    setFieldErrors({});
    try {
      await action();
      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError(err instanceof Error ? err.message : '操作失败');
      }
      return false;
    } finally {
      setSubmitting(false);
    }
  }, []);

  const reset = useCallback((): void => {
    setError(null);
    setFieldErrors({});
  }, []);

  return { submitting, error, fieldErrors, setError, reset, submit };
}

/**
 * 本地持久化的状态（用于「记住筛选条件」这类体验优化）。
 */
export function useLocalState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: T): void => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // 忽略写入失败（隐私模式）
      }
    },
    [key],
  );

  return [value, update];
}
