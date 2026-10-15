/**
 * 运行时设置模块的类型。
 */

/** 单台设备的精简摘要（连通性测试结果里展示用）。 */
export interface TailscaleDeviceSummary {
  hostname: string;
  os: string;
  online: boolean;
  ipv4: string | null;
}

/** Tailscale 连通性测试结果。 */
export interface TailscaleTestResult {
  /** 是否连通 */
  ok: boolean;
  /** 实际测试的模式 */
  mode: 'cli' | 'api' | 'off';
  /** 数据源状态（与 /api/health 的 sources.tailscale 同结构） */
  source: { available: boolean; mode: string; detail: string | null };
  /** 读到的设备总数；失败为 null */
  deviceCount: number | null;
  /** 其中在线数；失败为 null */
  onlineCount: number | null;
  /** 前几台设备，便于确认"确实读到了我的设备" */
  devices: TailscaleDeviceSummary[];
  /** 面向用户的中文结论与下一步建议 */
  message: string;
}

export type { SourceStatus } from '../tailscale/types.js';
