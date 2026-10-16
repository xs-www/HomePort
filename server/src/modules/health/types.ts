/**
 * 健康监测（S2-03）的**契约类型**与共享常量。
 *
 * 分层与 Sprint 1 的服务注册表一致：
 * - `state.ts` 是**纯状态机**（无 I/O、无时钟读取，可注入 `at`），
 * - `monitor.ts` 是编排（取服务/容器、节流探测、并发上限、写内存状态），
 * - 本文件只放类型与常量，不含任何副作用。
 *
 * 为什么把"状态机"和"监视器"拆成两个文件：三维判定规则（§4.1 的 7 条）是本 Sprint
 * 最容易被改坏的地方 —— 它必须是"同样输入必然同样输出"的纯函数，才能把 7 条规则逐条锁死。
 * 一旦把探测或容器列表读进来，这些规则就只能靠集成测试间接验证了。
 */

/** 单个判定维度的状态。`unknown` 表示"没有信号"，**不等于坏**。 */
export type HealthDimensionState = 'ok' | 'fail' | 'unknown';

/** 一个服务的整体判定（去抖后的结论，与 Sprint 1 的单次探测结果 `ok|fail|skipped|unknown` 区分开）。 */
export type HealthVerdict = 'healthy' | 'degraded' | 'down' | 'unknown';

/** 三个互相独立的判定维度。 */
export type HealthDimensionKey = 'container' | 'dockerHealth' | 'http';

/** 全部维度键（固定顺序：容器 → 容器健康检查 → HTTP）。 */
export const HEALTH_DIMENSION_KEYS: readonly HealthDimensionKey[] = ['container', 'dockerHealth', 'http'];

export interface HealthDimension {
  state: HealthDimensionState;
  /** 该维度**连续**失败次数（成功或 unknown 都会归零）。 */
  consecutiveFailures: number;
  /** 面向人的证据（如 `sisi-calendar 已退出（exited）`）；没有证据时为 null，**不猜**。 */
  detail: string | null;
}

/**
 * 一次评估的输入信号。
 *
 * 三个维度字段表示"**此刻**对该维度的评估结论"（不是"本次是否探测过"）：
 * 被节流而没探测的这一 tick，监视器把**上一次的 http 结论**原样传进来 ——
 * 否则"没探测"会被误读成"没信号"，一次 HTTP 失败会在下一 tick 被自己的节流抹平，
 * 连续失败计数永远攒不到阈值。
 *
 * 两处对 §4.1 的**非破坏性扩展**（可选字段，不影响任何既有调用方）：
 * - `sourceRef` / `serviceId`：`previous` 为 null 时纯函数也需要身份才能产出
 *   `ServiceHealthState`（否则首轮评估无法返回合法对象）；
 * - `probedAt`：`lastProbeAt` 只能由"真的探过"来填，而 `http !== 'unknown'`
 *   不能作为判据（节流时 http 仍报上次结论）。
 */
export interface HealthSignal {
  container: HealthDimensionState;
  dockerHealth: HealthDimensionState;
  http: HealthDimensionState;
  details?: Partial<Record<HealthDimensionKey, string>>;
  sourceRef?: string;
  serviceId?: string;
  probedAt?: string | null;
}

/** 一个服务的健康状态（内存中的真相，**不落库** —— 落库会把"某一刻的判定"变成永久的谎话）。 */
export interface ServiceHealthState {
  sourceRef: string;
  serviceId: string;
  verdict: HealthVerdict;
  dimensions: Record<HealthDimensionKey, HealthDimension>;
  /** 服务级连续失败次数：**至少一维 fail** 即算一次失败。 */
  consecutiveFailures: number;
  /** 服务级连续全好次数（无 fail 且至少一维 ok）。 */
  consecutiveSuccesses: number;
  /** 仅在 **verdict 变化**时更新（用于"这个结论是什么时候开始的"）。 */
  changedAt: string;
  lastEvaluatedAt: string;
  /** 最近一次真的发出 HTTP 探测的时间；从没探过（或没有目标）时为 null。 */
  lastProbeAt: string | null;
  /** 用人话写的判定依据（只描述有问题的维度；不猜原因）。 */
  reasons: string[];
}

export interface HealthTickResult {
  at: string;
  evaluated: number;
  probed: number;
  skippedForConcurrency: number;
  failures: number;
}

export interface HealthProbeStats {
  /** 自动探测间隔（秒）；0 = 关闭自动探测。 */
  intervalSec: number;
  /** 全局在飞探测上限。 */
  concurrency: number;
  /** 当前在飞探测数（并发上限是全局的，不只是本 tick 的）。 */
  inFlight: number;
  lastRunAt: string | null;
  probedThisTick: number;
  skippedForConcurrency: number;
}

/** `GET /api/health/monitor` 的响应体（见 §7）。 */
export interface HealthMonitorServiceView {
  sourceRef: string;
  serviceId: string;
  label: string;
  verdict: HealthVerdict;
  dimensions: Record<HealthDimensionKey, HealthDimension>;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  changedAt: string;
  lastEvaluatedAt: string;
  lastProbeAt: string | null;
  reasons: string[];
}

export interface HealthMonitorView {
  generatedAt: string;
  /** 阈值一并透出：没有它前端无法解释"为什么失败 2 次还不告警"。 */
  thresholds: { failThreshold: number; okThreshold: number };
  probe: HealthProbeStats;
  services: HealthMonitorServiceView[];
  /** 降级说明（容器列表取不到、探测被关闭等），**不允许静默为空**。 */
  notes: string[];
}

/* ------------------------------------------------------------------ *
 * 常量与共享纯函数
 * ------------------------------------------------------------------ */

/** 连续失败多少次判 `down`（§4.1 规则 1）。 */
export const DEFAULT_FAIL_THRESHOLD = 3;
/** 连续全好多少次回到 `healthy`（§4.1 规则 2）。 */
export const DEFAULT_OK_THRESHOLD = 2;
/**
 * HTTP 探测节流间隔（秒）。
 *
 * 这里是**默认值常量**而不是 `config.health.probeIntervalSec`：Sprint 2 的新配置项
 * 由另一位代理加进 `config.ts`，本模块只接受注入的 `intervalSec()` 闭包 ——
 * 这样"配置项还没落地"时本模块照样能编译、能单测，接线时也不会有两处真相。
 */
export const DEFAULT_PROBE_INTERVAL_SEC = 300;
/** 全局在飞探测上限的默认值（同上，由 `concurrency()` 覆盖）。 */
export const DEFAULT_PROBE_CONCURRENCY = 4;
/** 内存里最多跟踪多少个服务的健康状态（超出按最久未评估淘汰）。 */
export const MAX_TRACKED_SERVICES = 512;

/**
 * 把"可能是秒、也可能是毫秒"的时间戳统一成毫秒。
 *
 * 为什么需要这个守卫：`tick(now)` 的 `now` 来自注入的 `clock`（默认 `Date.now`，毫秒），
 * 但跨模块调用时单位很容易被写成秒。一旦单位错 1000 倍，**节流会静默失效**
 * （每次都判定"距上次探测足够久"→ 每 tick 都探），而症状只是"探测比预期频繁"，
 * 很难定位。阈值取 1e11：毫秒制下是 1973 年，秒制下是公元 5138 年，两者不可能混淆。
 */
export function toEpochMs(value: number): number {
  if (!Number.isFinite(value)) return Date.now();
  return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
}

/** 毫秒时间戳 → ISO 字符串（全项目统一 ISO 存时间）。 */
export function isoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

/** 阈值兜底：非有限或 < 1 时退回默认值（配置错误不该让状态机失去去抖能力）。 */
export function normalizeThreshold(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.floor(value);
}