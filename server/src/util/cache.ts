/**
 * TTL 缓存 + 请求合并（single-flight）。
 *
 * 用途：多标签页/多客户端同时刷新时，避免把 docker.sock、tailscale CLI 打爆。
 */
import type { Logger } from '../logger.js';

export interface CachedValue<T> {
  value: T;
  /** 写入时间戳（ms） */
  storedAt: number;
  /** 过期时间戳（ms） */
  expiresAt: number;
}

export interface CacheOptions {
  /** 默认 TTL（ms） */
  ttlMs: number;
  /** 缓存条目上限，超出时淘汰最旧的 */
  maxEntries?: number;
  logger?: Logger;
}

/**
 * 带 TTL 与 single-flight 的异步缓存。
 *
 * - `get(key, loader)`：命中则返回缓存；未命中则调用 loader，并合并同 key 的并发请求。
 * - loader 抛错时**不写缓存**，错误直接向上抛。
 *
 * @typeParam T 缓存值类型
 */
export class TtlCache<T> {
  private readonly entries = new Map<string, CachedValue<T>>();
  private readonly inflight = new Map<string, Promise<T>>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly logger?: Logger;

  constructor(options: CacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxEntries = options.maxEntries ?? 200;
    this.logger = options.logger;
  }

  /** 当前默认 TTL（供运行时同步逻辑比对）。 */
  get defaultTtlMs(): number {
    return this.ttlMs;
  }

  /** 读取未过期缓存；不存在或已过期返回 undefined。 */
  peek(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /** 读取缓存元信息，用于诊断（如探测时间）。 */
  peekMeta(key: string): CachedValue<T> | undefined {
    const hit = this.entries.get(key);
    if (!hit || hit.expiresAt <= Date.now()) return undefined;
    return hit;
  }

  /** 写入缓存，可覆盖 TTL。 */
  set(key: string, value: T, ttlMs = this.ttlMs): void {
    const now = Date.now();
    this.entries.set(key, { value, storedAt: now, expiresAt: now + ttlMs });
    this.evictIfNeeded();
  }

  /** 删除单个 key。 */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** 删除匹配前缀的 key（如 'tool:'）。 */
  deleteByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  /** 清空全部缓存。 */
  clear(): void {
    this.entries.clear();
  }

  /** 当前缓存条目数。 */
  get size(): number {
    return this.entries.size;
  }

  /**
   * 取缓存；未命中则调用 loader 并缓存结果。
   *
   * @param key 缓存键
   * @param loader 生产值的异步函数（并发同 key 只会执行一次）
   * @param ttlMs 覆盖默认 TTL；传 0 表示不缓存
   */
  async get(key: string, loader: () => Promise<T>, ttlMs = this.ttlMs): Promise<T> {
    const cached = this.peek(key);
    if (cached !== undefined) return cached;

    const running = this.inflight.get(key);
    if (running) return running;

    const task = loader()
      .then((value) => {
        if (ttlMs > 0) this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });

    this.inflight.set(key, task);
    return task;
  }

  /**
   * 取缓存；未命中时若 `swr` 为真则返回过期值并后台刷新。
   *
   * 用于「先给旧数据，再更新」的场景（如工具探测）。
   *
   * @returns `{ value, stale }`；无任何可用值时 `value` 为 undefined 且 `stale=false`
   */
  async getStaleWhileRevalidate(
    key: string,
    loader: () => Promise<T>,
    ttlMs = this.ttlMs,
  ): Promise<{ value: T | undefined; stale: boolean }> {
    const fresh = this.peek(key);
    if (fresh !== undefined) return { value: fresh, stale: false };

    const expired = this.entries.get(key);
    if (expired) {
      void this.get(key, loader, ttlMs).catch((error: unknown) => {
        this.logger?.debug('后台刷新失败', { key, error });
      });
      return { value: expired.value, stale: true };
    }

    const value = await this.get(key, loader, ttlMs);
    return { value, stale: false };
  }

  /** 淘汰过期条目；条目数超限时按写入时间淘汰最旧的。 */
  private evictIfNeeded(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    if (this.entries.size <= this.maxEntries) return;
    const sorted = [...this.entries.entries()].sort((a, b) => a[1].storedAt - b[1].storedAt);
    const overflow = this.entries.size - this.maxEntries;
    for (let i = 0; i < overflow; i += 1) {
      const victim = sorted[i];
      if (victim) this.entries.delete(victim[0]);
    }
  }
}

/**
 * 进程内 TTL 记忆的异步结果（用于探测等带副作用的操作）。
 *
 * @param fn 待包裹的异步函数
 * @param ttlMs 结果复用窗口
 */
export function memoizeAsync<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  ttlMs: number,
): (...args: A) => Promise<R> {
  const cache = new TtlCache<R>({ ttlMs });
  return (...args: A) => cache.get(JSON.stringify(args), () => fn(...args));
}
