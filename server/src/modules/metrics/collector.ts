/**
 * 采集：把"数据源快照"翻译成指标样本（**纯函数**，无 I/O、无时钟）。
 *
 * 职责边界：
 * - 本文件只回答"哪些读数存在、属于哪个 metric/target"；
 * - 什么时候采、怎么落库是 `sampler.ts` 的事；
 * - 缺测（null 读数、服务 verdict 为 unknown）**在这里就被丢掉**，
 *   因此下游永远不会写出 `value = 0` 来冒充未知。
 *
 * 数据源说明（规格 §1.1 判据 5：采样不新增 docker API 调用频率）：
 * - 宿主/磁盘用 `SystemProvider.snapshot()`（本来就被 SSE 用着）；
 * - 容器用 `containers.list()`（**走它自带的 TTL 2s 缓存**，不绕开缓存直接 dockerode）；
 * - 服务用注册表 `list()`（走发现缓存 + 同一个容器缓存）。
 */
import { containerServiceRef } from '../services/registry.js';
import type { ContainerListResult, ContainerSummary } from '../docker/types.js';
import type { ServiceListResponse } from '../services/types.js';
import type { SystemSnapshot } from '../system/types.js';
import type {
  MetricCollection,
  MetricSample,
  MetricServiceVerdict,
  MetricSourceStatus,
} from './types.js';

/** 宿主类 metric 的 target 恒为 `host`。 */
export const HOST_TARGET = 'host';
/** 宿主类 metric 的展示标签。 */
export const HOST_TARGET_LABEL = '宿主';

/** 健康判定 → `service.health.up_ratio` 的取值；`unknown` 返回 null（不计样本）。 */
export function verdictToRatio(verdict: MetricServiceVerdict): number | null {
  if (verdict === 'healthy') return 1;
  if (verdict === 'unknown') return null;
  return 0;
}

/**
 * 宿主机（CPU / 内存 / 磁盘）样本。
 *
 * `null` 读数一律**跳过**：CPU 首次采样没有基线（percent 为 null）、
 * statfs 失败的磁盘（percent/usedBytes 为 null）都不算 0 —— 它们是"不知道"。
 */
export function collectHostSamples(snapshot: SystemSnapshot): MetricSample[] {
  const samples: MetricSample[] = [];

  if (snapshot.cpu.percent !== null && Number.isFinite(snapshot.cpu.percent)) {
    samples.push({
      metric: 'host.cpu.percent',
      target: HOST_TARGET,
      targetLabel: HOST_TARGET_LABEL,
      unit: 'percent',
      value: snapshot.cpu.percent,
    });
  }

  if (snapshot.memory.percent !== null && Number.isFinite(snapshot.memory.percent)) {
    samples.push({
      metric: 'host.memory.percent',
      target: HOST_TARGET,
      targetLabel: HOST_TARGET_LABEL,
      unit: 'percent',
      value: snapshot.memory.percent,
    });
  }
  if (Number.isFinite(snapshot.memory.usedBytes)) {
    samples.push({
      metric: 'host.memory.used_bytes',
      target: HOST_TARGET,
      targetLabel: HOST_TARGET_LABEL,
      unit: 'bytes',
      value: snapshot.memory.usedBytes,
    });
  }

  for (const disk of snapshot.disks) {
    const target = `disk:${disk.label}`;
    if (disk.percent !== null && Number.isFinite(disk.percent)) {
      samples.push({
        metric: 'host.disk.percent',
        target,
        targetLabel: disk.label,
        unit: 'percent',
        value: disk.percent,
      });
    }
    if (disk.usedBytes !== null && Number.isFinite(disk.usedBytes)) {
      samples.push({
        metric: 'host.disk.used_bytes',
        target,
        targetLabel: disk.label,
        unit: 'bytes',
        value: disk.usedBytes,
      });
    }
  }

  return samples;
}

/**
 * 容器样本（CPU / 内存）。
 *
 * 只采前 `limit` 个"关键容器"：**运行中的优先**，其次按稳定身份
 * (`containerServiceRef`，不含容器 ID) 升序 —— 顺序稳定，测试与运维都能预测。
 * `limit = 0` 表示完全不采容器。
 *
 * ## 多副本：按服务合并，但记账要诚实
 *
 * `containerServiceRef` 对同一 compose 服务的多个副本返回**同一个** target
 * （这正是"一个服务一条曲线"的口径，不能改成每容器一条序列 —— 前端的目标列表
 * 是从 `/api/services` 的 `sourceRef` 推导的，每容器一条会让副本曲线在界面上选不中）。
 * 于是有两条必须处理的后果：
 *
 * 1. **标签必须确定**：多副本各自的名字不同，若用"后写覆盖"，
 *    同一份数据的展示名会随 `containers.list()` 的返回顺序变化。这里改成：
 *    组内只有一个名字 → 用那个名字（单副本时与以前完全一致）；
 *    组内有多个名字 → 用合并口径的服务名（`docker:<project>/<service>` 去掉前缀），
 *    并在注释/标签上表明这是**多副本的合并视图**（值 = 副本均值）。
 * 2. **每个样本带上 `replicaCount`**：本 tick 这个 target 由几个副本贡献。
 *    合并后每 tick 的读数个数是 N（不是 1），因此 `expected` 必须是 `base × N`；
 *    否则 `samples < expected` 永不成立，"掉了一个副本"就报不出 partial。
 *    （bucket 里的 `samples` 仍按**读数个数**计，因此 N 副本 × 每分钟 2 次 tick = 4。）
 *
 * 注意 `stats` 为 null（已停止/未取到）时不产生样本：容器的 CPU/内存缺测
 * 就是"没有行"，不是 0；此时该 target 本 tick 的贡献数会低于副本数，
 * 于是这一分钟会正确地显示为 partial。
 */
export function collectContainerSamples(result: ContainerListResult, limit: number): MetricSample[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];

  const ranked = [...result.items].sort((left, right) => {
    const leftRunning = left.state === 'running' ? 0 : 1;
    const rightRunning = right.state === 'running' ? 0 : 1;
    if (leftRunning !== rightRunning) return leftRunning - rightRunning;
    const leftRef = containerServiceRef(left);
    const rightRef = containerServiceRef(right);
    if (leftRef !== rightRef) return leftRef < rightRef ? -1 : 1;
    // 同一 target（多副本）内部再按容器名排序：让样本的产生顺序与
    // `containers.list()` 的返回顺序无关 —— 桶内均值是浮点累加，
    // 顺序不同可能差最后一位，曲线就"同一份数据两次运行不一样"了。
    if (left.name === right.name) return 0;
    return left.name < right.name ? -1 : 1;
  });

  const selected = ranked.slice(0, Math.floor(limit));

  // 先按合并口径分组：一个 target 在本 tick 有多少副本、该显示什么名字。
  const groups = new Map<string, { labels: Set<string>; replicaCount: number }>();
  for (const container of selected) {
    const ref = containerServiceRef(container);
    const group = groups.get(ref);
    if (group === undefined) {
      groups.set(ref, { labels: new Set([container.name]), replicaCount: 1 });
    } else {
      group.labels.add(container.name);
      group.replicaCount += 1;
    }
  }

  // 标签只由 **target 身份**决定，不看"本 tick 有几个副本"：
  // 否则副本数从 3 掉到 1 时标签会在 `shop/web` 与 `web-1` 之间反复横跳，
  // 同一条序列的历史会显示成两个名字。这里用与 target 同口径的名字
  // （`docker:<project>/<service>` / 规范化容器名去掉 `docker:` 前缀），
  // 它同时也是"多副本合并视图"的诚实名字。
  // 界面上更友好的名字应从 `/api/services` 的 `sourceRef` → `displayName` 拿；
  // 这个标签是没有对应服务条目时的兜底。
  const labelOf = (ref: string): string => ref.replace(/^docker:/, '');

  const samples: MetricSample[] = [];
  for (const container of selected) {
    const ref = containerServiceRef(container);
    const target = `container:${ref}`;
    const group = groups.get(ref);
    const replicaCount = group?.replicaCount ?? 1;
    const targetLabel = labelOf(ref);
    const stats = container.stats;
    if (!stats) continue;
    if (stats.cpuPercent !== null && Number.isFinite(stats.cpuPercent)) {
      samples.push({
        metric: 'container.cpu.percent',
        target,
        targetLabel,
        unit: 'percent',
        value: stats.cpuPercent,
        replicaCount,
      });
    }
    if (stats.memUsedBytes !== null && Number.isFinite(stats.memUsedBytes)) {
      samples.push({
        metric: 'container.memory.used_bytes',
        target,
        targetLabel,
        unit: 'bytes',
        value: stats.memUsedBytes,
        replicaCount,
      });
    }
  }
  return samples;
}

/**
 * 服务健康样本。
 *
 * 判定来自**本 tick 刚更新**的状态机（`verdictOf` 由 sampler 注入，
 * 内部即 `HealthMonitor.state(sourceRef)`）。`unknown` **不计入样本**
 * —— "不知道"既不是健康也不是不健康，把它算成 0 会让恢复中的服务看起来一直在挂。
 *
 * `role: 'viewer'` 的 list 结果**不含 hidden 服务**，因此隐藏的服务不会被采，
 * 也就不会通过只读的历史接口泄露名字。
 */
export function collectServiceSamples(
  result: ServiceListResponse,
  verdictOf: (sourceRef: string) => MetricServiceVerdict | null,
): MetricSample[] {
  const samples: MetricSample[] = [];
  for (const service of result.items) {
    const verdict = verdictOf(service.sourceRef);
    if (verdict === null) continue;
    const value = verdictToRatio(verdict);
    if (value === null) continue;
    samples.push({
      metric: 'service.health.up_ratio',
      target: `service:${service.sourceRef}`,
      targetLabel: service.displayName,
      unit: 'ratio',
      value,
    });
  }
  return samples;
}

/** 把三个数据源的采集结果合并成一次采集。 */
export function mergeCollections(parts: readonly MetricCollection[]): MetricCollection {
  const samples: MetricSample[] = [];
  const sources: Record<string, MetricSourceStatus> = {};
  const errors: string[] = [];
  for (const part of parts) {
    samples.push(...part.samples);
    Object.assign(sources, part.sources);
    errors.push(...part.errors);
  }
  return { samples, sources, errors };
}

/** 一次只拿到了样本（没有来源信息）的便捷构造。 */
export function collectionOf(samples: MetricSample[]): MetricCollection {
  return { samples, sources: {}, errors: [] };
}

/** 容器列表的 source 转指标来源状态。 */
export function containerSource(result: ContainerListResult): MetricSourceStatus {
  return { available: result.source.available, mode: result.source.mode, detail: result.source.detail };
}

/** 容器统计里"取到 stats 的容器数"（供日志/诊断，不影响落库）。 */
export function containersWithStats(result: ContainerListResult): number {
  return result.items.filter((container: ContainerSummary) => container.stats !== null).length;
}