/**
 * Sprint 2 历史指标模块的类型与**指标目录**（S2-01 / S2-02）。
 *
 * 契约见 `docs/sprint2-implementation-spec.md` §1 / §1.1 / §2 / §3 / §7。
 *
 * ## 三条不可动摇的约定
 *
 * 1. **metric key 是稳定标识**：进库（`metric_buckets.metric`）、进 URL、进前端。
 *    改名等于改契约，历史数据会因此与图表对不上。
 * 2. **百分比与字节是两套 key**，永不互相换算。`*.percent`（unit `percent`）
 *    与 `*.used_bytes`（unit `bytes`）各自有独立的桶；API 层不做任何单位转换，
 *    前端也只按 unit 选刻度。这样"磁盘用了 91%"和"磁盘用了 900GB"都是原始事实，
 *    不会因为某处除了一个总数而悄悄变成另一个量纲。
 * 3. **缺测绝不写 0**：没有样本的桶**没有行**（见 `buckets.ts` 的写入路径），
 *    `samples < expected` 才表示"这一桶里有缺测"。
 *
 * ## 类型与前端的关系
 *
 * 本文件同时是 `web/src/api/types.ts` 的镜像来源（沿用 Sprint 1 的做法：
 * 前端手写镜像，不 import 后端代码）。改字段必须同步：
 * 本文件、`docs/static/04-api-contract.md`、`web/src/api/types.ts`。
 */
import type { ContainerListQuery, ContainerListResult } from '../docker/types.js';
import type { HostContextRequest } from '../docker/service.js';
import type { SystemSnapshot } from '../system/types.js';
import type { ServiceListQuery, ServiceRole } from '../services/service.js';
import type { ServiceListResponse } from '../services/types.js';

/** 指标单位。**只允许这三种**：不做换算，也不新增。 */
export type MetricUnit = 'percent' | 'bytes' | 'ratio';

/** 桶分辨率。只有两种：minute（1h/24h 视图）与 hour（7d/30d 视图）。 */
export type MetricResolution = 'minute' | 'hour';

/** 历史查询窗口。 */
export type MetricRange = '1h' | '24h' | '7d' | '30d';

/** `target` 的身份形态（§1）。 */
export type MetricTargetKind = 'host' | 'disk' | 'container' | 'service';

/** 数据源可用性（与 `SystemSnapshot.sources.*` 同形，便于直接透出给前端）。 */
export interface MetricSourceStatus {
  available: boolean;
  /** host-proc / container-proc / statfs / docker / health-monitor / none … */
  mode: string;
  detail: string | null;
}

/** 目录里的一项指标。 */
export interface MetricDefinition {
  /** 稳定键（进库/进 URL） */
  key: string;
  label: string;
  unit: MetricUnit;
  targetKind: MetricTargetKind;
  /** target 的形态说明，如 `disk:<label>`；只用于文档与校验提示 */
  targetPattern: string;
  /** 数据源说明（人类可读，进 catalog，也进文档） */
  source: string;
  /** 为什么采它 / 边界（如"RSS 语义"） */
  description: string | null;
}

/**
 * 指标目录。**顺序即前端的展示顺序**，也是 catalog 接口的顺序。
 *
 * 刻意只采 8 个 key：不加 GPU、不加网络、不加每核 CPU、不加全部容器
 * （容器上限 `PORTAL_METRICS_CONTAINER_LIMIT`，默认 10）。历史库的大小由
 * "key 数 × target 数 × 保留窗口"决定，每加一个 key 都是长期成本。
 */
export const METRIC_CATALOG: readonly MetricDefinition[] = [
  {
    key: 'host.cpu.percent',
    label: '宿主 CPU 使用率',
    unit: 'percent',
    targetKind: 'host',
    targetPattern: 'host',
    source: 'SystemProvider.snapshot().cpu.percent',
    description: '两次采样做差得出；宿主 /proc 不可用时会退化为容器/虚拟机视图（见系统页的数据源提示）。',
  },
  {
    key: 'host.memory.percent',
    label: '宿主内存使用率',
    unit: 'percent',
    targetKind: 'host',
    targetPattern: 'host',
    source: 'SystemProvider.snapshot().memory.percent',
    description: null,
  },
  {
    key: 'host.memory.used_bytes',
    label: '宿主已用内存',
    unit: 'bytes',
    targetKind: 'host',
    targetPattern: 'host',
    source: 'SystemProvider.snapshot().memory.usedBytes',
    description: '与内存百分比是两套键：字节用于容量分析，百分比用于阈值告警，永不互换。',
  },
  {
    key: 'host.disk.percent',
    label: '磁盘使用率',
    unit: 'percent',
    targetKind: 'disk',
    targetPattern: 'disk:<label>',
    source: 'SystemProvider.snapshot().disks[].percent',
    description: '按挂载点标签分 target；`PORTAL_DISK_MOUNTS` 增删挂载点会新增/停止 target，互不影响。',
  },
  {
    key: 'host.disk.used_bytes',
    label: '磁盘已用空间',
    unit: 'bytes',
    targetKind: 'disk',
    targetPattern: 'disk:<label>',
    source: 'SystemProvider.snapshot().disks[].usedBytes',
    description: null,
  },
  {
    key: 'container.cpu.percent',
    label: '容器 CPU',
    unit: 'percent',
    targetKind: 'container',
    targetPattern: 'container:<sourceRef>',
    source: 'containers.list({all:true,stats:true}).items[].stats.cpuPercent',
    description: '只采前 N 个关键容器（见容器上限设置）；target 用稳定身份，容器重建后曲线连续。',
  },
  {
    key: 'container.memory.used_bytes',
    label: '容器内存',
    unit: 'bytes',
    targetKind: 'container',
    targetPattern: 'container:<sourceRef>',
    source: 'containers.list({all:true,stats:true}).items[].stats.memUsedBytes',
    description: 'RSS 语义（含缓存），与容器页展示的字符串同源。',
  },
  {
    key: 'service.health.up_ratio',
    label: '服务健康采样占比',
    unit: 'ratio',
    targetKind: 'service',
    targetPattern: 'service:<sourceRef>',
    source: '健康监视器的最新判定（HealthMonitor.state().verdict）',
    description:
      'healthy = 1，down/degraded = 0，unknown **不计入样本**（不知道就不能算健康）。桶内均值即"这段时间里有多少比例的采样是健康的"。',
  },
];

/** 按 key 取指标定义。 */
export function metricByKey(key: string): MetricDefinition | null {
  return METRIC_CATALOG.find((item) => item.key === key) ?? null;
}

/** 某个 metric 的 target 是否**形态**合法（不判断该 target 是否真的出现过）。 */
export function matchesTargetPattern(metric: MetricDefinition, target: string): boolean {
  if (metric.targetKind === 'host') return target === 'host';
  const prefixes: Record<Exclude<MetricTargetKind, 'host'>, string> = {
    disk: 'disk:',
    container: 'container:',
    service: 'service:',
  };
  const prefix = prefixes[metric.targetKind];
  return target.startsWith(prefix) && target.length > prefix.length;
}

/* ------------------------------------------------------------------ *
 * 采集（collector → sampler）
 * ------------------------------------------------------------------ */

/** 一个原始样本（尚未进入桶）。`value` 一定是**真实存在的读数**，缺测不会走到这里。 */
export interface MetricSample {
  metric: string;
  target: string;
  targetLabel: string;
  unit: MetricUnit;
  value: number;
  /**
   * 本 tick 里**贡献这个 target 的副本数**（默认 1）。
   *
   * 多副本合并到同一个 target 时，一次 tick 会产生 N 个读数，
   * 因此该桶的 `expected` 是 `base × replicaCount` —— 少采到一个副本时
   * `samples < expected` 才会成立，界面才能显示"部分缺测"。
   * 宿主/磁盘/服务样本恒为 1（一个目标一个读数）。
   */
  replicaCount?: number;
}

/** 一次采集的结果：样本 + 每个 metric 的数据源状态（供 history 透出）。 */
export interface MetricCollection {
  samples: MetricSample[];
  /** metric key → 数据源状态；缺失表示本次没拿到该 metric 的来源信息 */
  sources: Record<string, MetricSourceStatus>;
  /** 采集过程中的非致命错误（数据源不可用等），只记日志/摘要，不抛 */
  errors: string[];
}

/* ------------------------------------------------------------------ *
 * 视图（HTTP 契约）
 * ------------------------------------------------------------------ */

/** 历史曲线上的一个点。 */
export interface MetricPoint {
  /** 桶起点的 ISO 时刻 */
  at: string;
  value: number;
  min: number;
  max: number;
  samples: number;
  expected: number;
  /** `samples < expected`：这一桶部分缺测（前端必须能看出来） */
  partial: boolean;
}

/** 窗口内**有值的桶**的统计；窗口内一行都没有时除 count 外全为 null。 */
export interface MetricSummary {
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  latest: number | null;
  latestAt: string | null;
}

export interface MetricGaps {
  /** 窗口内应有桶数 − 实际行数（缺测 = 没有行） */
  missingBuckets: number;
  /** 实际行里 `samples < expected` 的桶数 */
  partialBuckets: number;
}

/** `GET /api/metrics/history` 的响应。 */
export interface MetricHistoryView {
  metric: string;
  label: string;
  unit: MetricUnit;
  target: string;
  targetLabel: string;
  range: MetricRange;
  resolution: MetricResolution;
  from: string;
  to: string;
  sampling: {
    intervalSec: number;
    aggregate: 'mean';
    expectedPerBucket: number;
    note: string;
  };
  source: MetricSourceStatus;
  points: MetricPoint[];
  gaps: MetricGaps;
  summary: MetricSummary;
}

/** 目录里的一个可用 target。 */
export interface MetricTargetView {
  metric: string;
  target: string;
  targetLabel: string;
  unit: MetricUnit;
  /** 最近一次出现该 target 的桶时刻（ISO）；仅"本进程刚采到、库里还没有"时为 null */
  lastSeenAt: string | null;
}

export interface MetricRangeSpec {
  range: MetricRange;
  resolution: MetricResolution;
  windowSec: number;
  /** 窗口内应有的桶数 */
  expectedBuckets: number;
  label: string;
}

/** 存储与预算视图（§1.1 的判据都从这里读）。 */
export interface MetricBudgetView {
  /** 估算基准：`observed` = 按库里观察到的序列数；`baseline` = §1.1 的典型部署基准 */
  basis: 'observed' | 'baseline';
  /** 每分钟落库的序列数（= metric×target 组合数） */
  seriesPerMinute: number;
  bytesPerRow: number;
  minuteRowsPerDay: number;
  hourRowsPerDay: number;
  /** 稳态 minute 行数（保留窗口封顶，**不随运行时长增长**） */
  minuteSteadyRows: number;
  hourSteadyRows: number;
  estimatedBytesPerDay: number;
  estimatedSteadyBytes: number;
  steadyLimitBytes: number;
  withinBudget: boolean;
  note: string;
}

export interface MetricStorageView {
  generatedAt: string;
  rows: { minute: number; hour: number; total: number };
  size: { pageCount: number; pageSize: number; freelistCount: number; bytes: number; megabytes: number };
  bounds: {
    minute: { oldestAt: string | null; newestAt: string | null };
    hour: { oldestAt: string | null; newestAt: string | null };
  };
  retention: {
    minuteHours: number;
    hourDays: number;
    minuteCutoffAt: string;
    hourCutoffAt: string;
  };
  budget: MetricBudgetView;
  /** 最近一次**采样 tick**的摘要（不是后台调度摘要；调度摘要在 catalog 里） */
  lastTick: MetricsTickResult | null;
}

/** 调度器摘要（供 catalog / storage 透出"后台有没有在跑"）。 */
export interface MetricSchedulerView {
  running: boolean;
  lastTickAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
}

/** `GET /api/metrics/catalog` 的响应：目录 + 可用 target + range 表 + 采样状态。 */
export interface MetricCatalogView {
  metrics: Array<MetricDefinition & { availableTargets: number }>;
  targets: MetricTargetView[];
  ranges: MetricRangeSpec[];
  sampling: {
    intervalSec: number;
    expectedPerMinuteBucket: number;
    /** 只采关键容器：上限与说明（§1 要求把这件事写清楚） */
    containerLimit: number;
    containerNote: string | null;
    aggregate: 'mean';
    note: string;
  };
  scheduler: MetricSchedulerView | null;
}

/* ------------------------------------------------------------------ *
 * 依赖（结构类型）
 * ------------------------------------------------------------------ */

/**
 * 服务注册表的最小依赖面。
 *
 * 用**结构类型**而不是 import 具体类：这里只需要 `list()`（它内部走发现缓存 +
 * 容器 TTL 缓存，所以每 tick 一次不会新增 docker 压力），
 * 传真实的 `ServiceRegistryService` 实例即可自动满足。
 *
 * 后台调用固定 `role: 'viewer'` —— **hidden 服务不采指标**，
 * 否则只读的历史接口会泄露用户刻意隐藏的服务名。
 */
export interface MetricsServiceRegistrySource {
  list(
    request: HostContextRequest,
    query?: ServiceListQuery,
    role?: ServiceRole,
  ): Promise<ServiceListResponse>;
}

/** 健康判定形态（镜像 spec §4.1 的 `HealthVerdict`，此处只取需要的字段）。 */
export type MetricServiceVerdict = 'healthy' | 'degraded' | 'down' | 'unknown';

/**
 * 健康监视器的最小依赖面：只问"这个服务现在是什么判定"。
 *
 * **不在这里重新数失败次数**：去抖/连续失败计数是状态机（§4.1）的职责，
 * 指标线只把判定转成 1 / 0 / 不计样本。
 */
export interface MetricsHealthSource {
  state(sourceRef: string): { verdict: MetricServiceVerdict } | null;
}

/** 采样器的数据源依赖（与 `sampler.ts` 的 `MetricsDeps` 同形，便于测试单独构造）。 */
export interface MetricsSystemSource {
  snapshot(): Promise<SystemSnapshot>;
}

export interface MetricsContainerSource {
  list(query: ContainerListQuery, request: HostContextRequest): Promise<ContainerListResult>;
}

/* ------------------------------------------------------------------ *
 * tick 结果
 * ------------------------------------------------------------------ */

/** 一次批量写库的结果（flush / rollup 共用）。 */
export interface BucketWriteResult {
  /** 写入（或幂等重写）的行数 */
  rows: number;
  /** 这些行里"部分缺测"（`samples < expected`）的行数 */
  partial: number;
}

/** `MetricsSampler.tick(now)` 的返回值。 */
export interface MetricsTickResult {
  at: string;
  /** 本 tick 接受的样本数（数据源为 null/缺测的读数不会计入） */
  collected: number;
  /** 本 tick 落库的样本总数（flush 的 minute 行里 samples 之和 + rollup 的 hour 行） */
  samplesWritten: number;
  /** 本 tick 写库的 minute 行数 */
  bucketsFlushed: number;
  /** 本 tick 写库的 hour 行数 */
  hoursRolledUp: number;
  /** 本 tick 删掉的过期行数 */
  pruned: number;
  /** 缺口计数：`samples < expected` 的桶 + 完全没有样本的整分钟 */
  gaps: number;
  /** 采集过程中的非致命错误（数据源不可用等） */
  errors: string[];
}