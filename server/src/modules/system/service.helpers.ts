/**
 * 系统指标的纯函数助手（与 IO 分离，便于单测）。
 */
import type { SystemMetricsFrame, SystemSnapshot } from './types.js';

/** 从完整快照裁剪出 SSE 帧。 */
export function buildMetricsFrame(snapshot: SystemSnapshot): SystemMetricsFrame {
  return {
    generatedAt: snapshot.generatedAt,
    cpu: snapshot.cpu,
    memory: snapshot.memory,
    disks: snapshot.disks,
    gpu: snapshot.gpu,
    sources: {
      cpu: snapshot.sources.cpu,
      memory: snapshot.sources.memory,
      gpu: snapshot.sources.gpu,
    },
  };
}

/** 判断快照是否包含任何降级数据源（前端用于显示"数据可能不准"提示）。 */
export function hasDegradedSource(snapshot: SystemSnapshot): boolean {
  const { cpu, memory, disk, gpu } = snapshot.sources;
  return [cpu, memory, disk, gpu].some((source) => !source.available || source.mode === 'container-proc');
}

/** 生成告警列表：数据源不可用或降级时给出人类可读的原因。 */
export function collectWarnings(snapshot: SystemSnapshot): Array<{ area: 'cpu' | 'memory' | 'disk' | 'gpu'; message: string }> {
  const out: Array<{ area: 'cpu' | 'memory' | 'disk' | 'gpu'; message: string }> = [];
  for (const area of ['cpu', 'memory', 'disk', 'gpu'] as const) {
    const source = snapshot.sources[area];
    if (source.available && source.mode !== 'container-proc') continue;
    if (source.detail) out.push({ area, message: source.detail });
  }
  return out;
}
