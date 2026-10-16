/**
 * 健康状态机（S2-03 §4.1）—— **纯函数，无 I/O、不读时钟**。
 *
 * 为什么坚持纯函数：三维判定 + 两级去抖（失败去抖 / 恢复去抖）是"看起来简单、
 * 改一行就错"的典型。把时间（`at`）、阈值、信号全部作为参数传进来，就能把 §4.1
 * 的 7 条规则逐条锁成单元测试，而不是靠"跑起来看着像对"。
 *
 * 两条容易理解错的设计（都是刻意的）：
 *
 * 1. **`unknown` 既不算成功也不算失败**。`unknown` 的语义是"没信号"，
 *    不是"坏"。如果把它当失败，一次 Docker API 抖动就会把满屏服务判成 down；
 *    如果把它当成功，就会在真正宕机时把服务"洗白"。所以它只做两件事：
 *    不参与成败计数、把 verdict 拉成 `unknown`（当三维全无信号时）。
 *
 * 2. **`degraded` 是"还没到阈值"和"正在恢复但还没好透"共用的中间态**。
 *    verdict 集合里没有 `recovering`，所以恢复过程中的那 1 次全好只能落在 `degraded`，
 *    并用 `reasons` 说明"正在恢复（1/2）" —— 结论与解释分开，UI 才不用猜。
 *
 * 另外：**首轮评估不做恢复去抖**（`previous === null` 时第一次全好就是 `healthy`）。
 * 理由：去抖是为了抑制"状态来回跳"，而首轮根本没有前一状态可跳；若此时返回 `degraded`，
 * `service.health.up_ratio` 会在每个新服务的第一个采样点写下 0 —— 那是一个凭空的失败样本。
 */
import {
  HEALTH_DIMENSION_KEYS,
  isoFromMs,
  normalizeThreshold,
  toEpochMs,
  DEFAULT_FAIL_THRESHOLD,
  DEFAULT_OK_THRESHOLD,
  type HealthDimension,
  type HealthDimensionKey,
  type HealthDimensionState,
  type HealthSignal,
  type HealthVerdict,
  type ServiceHealthState,
} from './types.js';

const VALID_DIMENSION_STATES: ReadonlySet<string> = new Set(['ok', 'fail', 'unknown']);

/** 把任意输入收敛成合法维度状态（防御：调用方给了脏数据时按"没信号"处理，不崩）。 */
function readDimensionState(value: HealthDimensionState | undefined): HealthDimensionState {
  return typeof value === 'string' && VALID_DIMENSION_STATES.has(value) ? (value as HealthDimensionState) : 'unknown';
}

/**
 * 维度 → 人话证据（§4.1 规则 6）。
 *
 * 文案格式是被测试锁住的契约（前端与排障都靠它）：
 * - `容器 sisi-calendar 已退出（exited）（连续 1/3 次）`
 * - `HTTP 探测失败 2/3 次：连接超时`
 * - `容器健康检查未通过（sisi-calendar: unhealthy）（连续 1/3 次）`
 *
 * `detail` 由监视器提供（它才知道容器名与探测错误信息）。**没有证据就不编**：
 * 此时只报维度与次数。
 */
function dimensionReason(
  key: HealthDimensionKey,
  dimension: HealthDimension,
  evidence: string | null,
  failThreshold: number,
): string | null {
  if (dimension.state !== 'fail') return null;
  const counter = `连续 ${dimension.consecutiveFailures}/${failThreshold} 次`;
  if (key === 'http') {
    return `HTTP 探测失败 ${dimension.consecutiveFailures}/${failThreshold} 次${evidence ? `：${evidence}` : ''}`;
  }
  if (key === 'container') {
    return evidence ? `容器 ${evidence}（${counter}）` : `容器维度异常（${counter}）`;
  }
  return evidence ? `容器健康检查未通过（${evidence}）（${counter}）` : `容器健康检查未通过（${counter}）`;
}

/**
 * 评估一次健康信号，产出（或延续）一个服务的健康状态。
 *
 * @param previous 上一次的状态；首轮为 null
 * @param signal   三维信号 + 证据（+ 身份、探测时间，见 `HealthSignal` 注释）
 * @param options  `at` 为毫秒时间戳；阈值非有限或 < 1 时退回默认 3 / 2
 */
export function evaluateHealth(
  previous: ServiceHealthState | null,
  signal: HealthSignal,
  options: { failThreshold: number; okThreshold: number; at: number },
): ServiceHealthState {
  const failThreshold = normalizeThreshold(options.failThreshold, DEFAULT_FAIL_THRESHOLD);
  const okThreshold = normalizeThreshold(options.okThreshold, DEFAULT_OK_THRESHOLD);
  const atMs = toEpochMs(options.at);
  const atIso = isoFromMs(atMs);

  const details = signal.details ?? {};
  const dimensions = {} as Record<HealthDimensionKey, HealthDimension>;

  for (const key of HEALTH_DIMENSION_KEYS) {
    const state = readDimensionState(signal[key]);
    const before = previous?.dimensions[key] ?? null;
    // 规则 5：维度计数只在"同一维度连续同状态"时累加；状态一变立刻归零重算。
    const consecutiveFailures = state === 'fail' ? (before?.state === 'fail' ? before.consecutiveFailures + 1 : 1) : 0;
    const evidence = details[key];
    const detail = evidence ?? (state === 'ok' ? null : (before?.detail ?? null));
    dimensions[key] = { state, consecutiveFailures, detail: detail ?? null };
  }

  const states = HEALTH_DIMENSION_KEYS.map((key) => dimensions[key].state);
  const failing = HEALTH_DIMENSION_KEYS.filter((key) => dimensions[key].state === 'fail');
  const anyFail = failing.length > 0;
  const anyOk = states.includes('ok');

  // 服务级计数：规则 1 把"失败"定义在服务级（至少一维 fail），因此跨维度连续。
  let consecutiveFailures: number;
  let consecutiveSuccesses: number;
  if (anyFail) {
    consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    consecutiveSuccesses = 0;
  } else if (anyOk) {
    consecutiveSuccesses = (previous?.consecutiveSuccesses ?? 0) + 1;
    consecutiveFailures = 0;
  } else {
    // 三维全 unknown：不参与成败，计数原样保留（"没信号"不该抹掉已有的失败连续数）。
    consecutiveFailures = previous?.consecutiveFailures ?? 0;
    consecutiveSuccesses = previous?.consecutiveSuccesses ?? 0;
  }

  // 规则 1/2/3：先判"有没有失败"，再判"够不够格回到健康"。
  const wasFailing = (previous?.consecutiveFailures ?? 0) > 0;
  let verdict: HealthVerdict;
  if (!anyFail && !anyOk) {
    verdict = 'unknown';
  } else if (anyFail) {
    verdict = consecutiveFailures >= failThreshold ? 'down' : 'degraded';
  } else {
    // 只有"刚从失败里出来"才需要连续 okThreshold 次全好；首轮 / 从 unknown 转来时直接 healthy。
    verdict = wasFailing && previous !== null && consecutiveSuccesses < okThreshold ? 'degraded' : 'healthy';
  }

  const reasons: string[] = [];
  if (verdict === 'down') {
    reasons.push(`连续失败 ${consecutiveFailures} 次（阈值 ${failThreshold}），判定为不可用`);
  }
  for (const key of failing) {
    const reason = dimensionReason(key, dimensions[key], details[key] ?? null, failThreshold);
    if (reason) reasons.push(reason);
  }
  if (verdict === 'degraded' && !anyFail) {
    reasons.push(`正在恢复：连续正常 ${consecutiveSuccesses}/${okThreshold} 次，尚未达到恢复阈值`);
  }
  if (verdict === 'unknown') {
    reasons.push('三维均为未知：没有可用信号，暂不判定');
  }

  return {
    sourceRef: signal.sourceRef ?? previous?.sourceRef ?? '',
    serviceId: signal.serviceId ?? previous?.serviceId ?? '',
    verdict,
    dimensions,
    consecutiveFailures,
    consecutiveSuccesses,
    // 规则 5：changedAt 只在 verdict 真的变了时更新。
    changedAt: previous && previous.verdict === verdict ? previous.changedAt : atIso,
    lastEvaluatedAt: atIso,
    lastProbeAt: signal.probedAt ?? previous?.lastProbeAt ?? null,
    reasons,
  };
}