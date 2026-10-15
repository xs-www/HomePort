/**
 * F2 tailnet 设备模块的应用层类型（HTTP 契约见 docs/static/04-api-contract.md §4）。
 */

export interface SourceStatus {
  available: boolean;
  /** 数据源模式：cli / api / none */
  mode: string;
  detail: string | null;
}

export interface TailnetDevice {
  id: string;
  hostname: string;
  /** MagicDNS 全名，如 `sisi-laptop.tail921448.ts.net` */
  dnsName: string;
  os: string;
  ipv4: string | null;
  ipv6: string | null;
  online: boolean;
  /** 最后可见时间（ISO）；未知为 null */
  lastSeen: string | null;
  /** 创建时间（入网时间，ISO）；未知为 null */
  createdAt: string | null;
  exitNode: boolean;
  exitNodeOption: boolean;
  tags: string[];
  /** 中继区域（如 syd、hkg）；直连时为 null */
  relay: string | null;
  /** 是否为当前主机 */
  isSelf: boolean;
  rxBytes: number | null;
  txBytes: number | null;
  /** 与当前主机的连接方式：direct / relay / idle */
  connection: 'direct' | 'relay' | 'idle';
}

export interface TailnetSummary {
  peersTotal: number;
  peersOnline: number;
  peersOffline: number;
}

export interface TailnetStatus {
  self: TailnetDevice | null;
  tailnet: { name: string | null; magicDnsSuffix: string | null };
  peers: TailnetDevice[];
  summary: TailnetSummary;
  /** 后端状态：Running / Stopped / NeedsLogin 等 */
  backendState: string | null;
  source: SourceStatus;
}

export interface TailnetStatusLite {
  self: TailnetDevice | null;
  summary: TailnetSummary;
  backendState: string | null;
  source: SourceStatus;
}
