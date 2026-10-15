/**
 * tailnet 本机信息的进程内共享槽位。
 *
 * 为什么需要它：容器模块（F1）需要**同步**知道本机 tailnet 地址来判定端口可达性，
 * 而 tailnet 状态是异步获取的。若让 container service 直接依赖 tailscale service，
 * 会形成 `docker → tailscale → docker` 的模块环。这里用一个单向的"寄存器"
 * 解开环：tailscale service 写入，container service 读取。
 *
 * 语义：只保存**最近一次成功**的结果；数据源暂时不可用时保留旧值（宁可标注过期，
 * 也不要让容器墙突然全部变成"不可达"）。
 */

export interface CachedTailnetInfo {
  ipv4: string | null;
  ipv6: string | null;
  /** MagicDNS 全名 */
  dnsName: string | null;
  hostname: string;
  /** 写入时间（ISO），便于诊断"数据有多旧" */
  updatedAt: string;
}

let current: CachedTailnetInfo | null = null;

/** 写入（传 null 表示明确清空）。 */
export function setCachedTailnetInfo(info: Omit<CachedTailnetInfo, 'updatedAt'> | null): void {
  current = info === null ? null : { ...info, updatedAt: new Date().toISOString() };
}

/** 读取最近一次成功的 tailnet 本机信息。 */
export function getCachedTailnetInfo(): CachedTailnetInfo | null {
  return current;
}

/** 距离上次更新的毫秒数；无数据返回 null。 */
export function cachedTailnetInfoAgeMs(): number | null {
  if (!current) return null;
  return Date.now() - Date.parse(current.updatedAt);
}

/** 仅供测试：重置寄存器。 */
export function resetCachedTailnetInfo(): void {
  current = null;
}
