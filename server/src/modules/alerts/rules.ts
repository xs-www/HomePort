/**
 * 告警规则（S2-04 §5.1）—— 内置四条 + 补齐 + 阈值校验，**全部是纯函数**。
 *
 * 为什么把"补齐内置规则"做成纯函数而不是迁移里的 INSERT：
 * 迁移只跑一次，而内置规则的**定义**会随版本演进（改名、改默认阈值）。
 * 放在代码里 + 幂等补齐，老库升级时也能拿到新默认值；同时"迁移后新表为空"
 * 这条可验证的性质得以保留（播种是运行期显式动作，见 `AlertsService.ensureBuiltinRules`）。
 *
 * 三条不可动摇的语义：
 * 1. 内置规则 `builtin = 1`、`enabled = 0`（**装了但不吵**：默认不出站、不告警，
 *    由管理员显式打开）；可以改阈值与开关，但**不可删除**。
 * 2. 补齐是**幂等**的：已存在的行原样保留（管理员改过的阈值不能被"补齐"悄悄改回去）。
 * 3. 阈值越界**一律拒绝**，不静默截断 —— 静默截断会让"我设了 200% 却变成 100%"这种事
 *    在半年后才被发现。
 */
import type { AlertKind, AlertRulePatch, AlertRuleRow, BuiltinAlertRule } from './types.js';

export const ALERT_KINDS = ['disk_percent', 'memory_percent', 'container_exit', 'service_health'] as const;

/** 阈值与静默期的取值域（§5.1，测试逐条锁）。 */
export const THRESHOLD_PERCENT_MIN_EXCLUSIVE = 0;
export const THRESHOLD_PERCENT_MAX = 100;
export const DURATION_SEC_MAX = 86_400;
export const SILENCE_SEC_MIN = 60;
export const SILENCE_SEC_MAX = 86_400 * 7;
export const SERVICE_FAILURE_THRESHOLD_MIN = 1;
export const SERVICE_FAILURE_THRESHOLD_MAX = 10;
/** 目标标识（`disk:C:` / `service:<ref>`）的长度上限。 */
export const RULE_TARGET_MAX_LENGTH = 200;

/**
 * 四条内置规则（与 §2.3 的表格逐字对应；id 稳定，前端与审计都按它引用）。
 *
 * `threshold`/`duration_sec`/`silence_sec`/`severity` 的取值不是随手填的：
 * 磁盘 85% 持续 10 分钟、内存 90% 持续 5 分钟，都是"确实需要处理但不必半夜起来"的量级；
 * 容器异常退出与服务连续探测失败是**事实级**故障，所以 severity = critical 且无需 duration。
 * 静默期统一 1 小时：与规格"一小时内不重复刷屏"一致。
 */
export const BUILTIN_ALERT_RULES: readonly BuiltinAlertRule[] = [
  {
    id: 'rule-disk-percent',
    kind: 'disk_percent',
    name: '磁盘使用率过高',
    description: '任一磁盘使用率超过阈值并持续一段时间',
    enabled: 0,
    threshold: 85,
    durationSec: 600,
    target: null,
    silenceSec: 3600,
    notifyRecovery: 1,
    severity: 'warning',
    builtin: 1,
    // 内置规则的"创建时间"由 `mergeBuiltinRules` 的 `now` 决定，这里留空串。
    updatedAt: '',
    createdAt: '',
  },
  {
    id: 'rule-memory-percent',
    kind: 'memory_percent',
    name: '内存使用率过高',
    description: '宿主内存使用率超过阈值并持续一段时间',
    enabled: 0,
    threshold: 90,
    durationSec: 300,
    target: null,
    silenceSec: 3600,
    notifyRecovery: 1,
    severity: 'warning',
    builtin: 1,
    updatedAt: '',
    createdAt: '',
  },
  {
    id: 'rule-container-exit',
    kind: 'container_exit',
    name: '容器异常退出',
    description: '容器以非 0 退出码退出或进入 dead 状态',
    enabled: 0,
    // 容器退出规则不设百分比；threshold = 0 表示"非 0 退出码即触发"。
    threshold: 0,
    durationSec: 0,
    target: null,
    silenceSec: 3600,
    notifyRecovery: 1,
    severity: 'critical',
    builtin: 1,
    updatedAt: '',
    createdAt: '',
  },
  {
    id: 'rule-service-health',
    kind: 'service_health',
    name: '服务连续探测失败',
    description: '服务的连续失败次数达到阈值（由健康状态机给）',
    enabled: 0,
    threshold: 3,
    durationSec: 0,
    target: null,
    silenceSec: 3600,
    notifyRecovery: 1,
    severity: 'critical',
    builtin: 1,
    updatedAt: '',
    createdAt: '',
  },
];

/**
 * 补齐缺失的内置规则（幂等）。
 *
 * @param rows 库里已有的规则行（**管理员改过的值原样保留**，只补缺的）
 * @param now  补齐出来的行的 `created_at` / `updated_at`
 */
export function mergeBuiltinRules(rows: AlertRuleRow[], now: string): AlertRuleRow[] {
  const existing = new Set(rows.map((row) => row.id));
  const missing = BUILTIN_ALERT_RULES.filter((rule) => !existing.has(rule.id)).map((rule) => ({
    ...rule,
    createdAt: now,
    updatedAt: now,
  }));
  return [...rows, ...missing];
}

export type RulePatchValidation = { ok: true; value: AlertRulePatch } | { ok: false; reason: string };

function isIntegerInRange(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

/** 目标标识的通用形状：非空、无空白与控制字符、长度受限。具体前缀按 kind 再校验。 */
function targetProblem(target: string | null): string | null {
  if (target === null) return null;
  const trimmed = target.trim();
  if (trimmed === '') return '目标不能是空字符串（清空请传 null）';
  if (trimmed.length > RULE_TARGET_MAX_LENGTH) return `目标过长（上限 ${RULE_TARGET_MAX_LENGTH} 字符）`;
  if (/\s/.test(trimmed)) return '目标不能包含空白字符';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return '目标不能包含控制字符';
  return null;
}

/**
 * 校验并规范化一次规则更新（§5.1 的取值域）。
 *
 * 只在**提供了**的字段上校验：`PATCH` 是部分更新，缺省字段保持原值。
 * 目标标识前缀按 kind 校验（`disk:` / `host` / `container:` / `service:`）：
 * 规则目标与目标形态必须同源，否则规则会永远匹配不到任何目标 ——
 * 那是最难发现的"配了但不生效"。
 */
export function validateRulePatch(kind: AlertKind, patch: AlertRulePatch): RulePatchValidation {
  const allowed: ReadonlyArray<keyof AlertRulePatch> = [
    'enabled',
    'threshold',
    'durationSec',
    'silenceSec',
    'notifyRecovery',
    'target',
  ];
  for (const key of Object.keys(patch) as Array<keyof AlertRulePatch>) {
    if (!allowed.includes(key)) return { ok: false, reason: `不支持的字段 ${String(key)}` };
  }

  const value: AlertRulePatch = {};

  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') return { ok: false, reason: 'enabled 必须是布尔值' };
    value.enabled = patch.enabled;
  }
  if (patch.notifyRecovery !== undefined) {
    if (typeof patch.notifyRecovery !== 'boolean') return { ok: false, reason: 'notifyRecovery 必须是布尔值' };
    value.notifyRecovery = patch.notifyRecovery;
  }

  if (patch.durationSec !== undefined) {
    if (typeof patch.durationSec !== 'number' || !Number.isFinite(patch.durationSec)) {
      return { ok: false, reason: 'durationSec 必须是数字' };
    }
    if (!isIntegerInRange(patch.durationSec, 0, DURATION_SEC_MAX)) {
      return { ok: false, reason: `durationSec 必须是 0-${DURATION_SEC_MAX} 的整数（当前 ${patch.durationSec}）` };
    }
    value.durationSec = patch.durationSec;
  }

  if (patch.silenceSec !== undefined) {
    if (typeof patch.silenceSec !== 'number' || !Number.isFinite(patch.silenceSec)) {
      return { ok: false, reason: 'silenceSec 必须是数字' };
    }
    if (!isIntegerInRange(patch.silenceSec, SILENCE_SEC_MIN, SILENCE_SEC_MAX)) {
      return {
        ok: false,
        reason: `silenceSec 必须是 ${SILENCE_SEC_MIN}-${SILENCE_SEC_MAX} 的整数（当前 ${patch.silenceSec}）`,
      };
    }
    value.silenceSec = patch.silenceSec;
  }

  if (patch.threshold !== undefined) {
    if (patch.threshold === null) {
      return { ok: false, reason: `${kind} 的阈值不能为空（容器退出规则用 0 表示"非 0 退出码即触发"）` };
    }
    if (typeof patch.threshold !== 'number' || !Number.isFinite(patch.threshold)) {
      return { ok: false, reason: 'threshold 必须是数字' };
    }
    if (kind === 'disk_percent' || kind === 'memory_percent') {
      if (patch.threshold <= THRESHOLD_PERCENT_MIN_EXCLUSIVE || patch.threshold > THRESHOLD_PERCENT_MAX) {
        return {
          ok: false,
          reason: `threshold 必须在 (${THRESHOLD_PERCENT_MIN_EXCLUSIVE}, ${THRESHOLD_PERCENT_MAX}] 之间（当前 ${patch.threshold}）`,
        };
      }
    } else if (kind === 'service_health') {
      if (!isIntegerInRange(patch.threshold, SERVICE_FAILURE_THRESHOLD_MIN, SERVICE_FAILURE_THRESHOLD_MAX)) {
        return {
          ok: false,
          reason: `service_health 的 threshold 必须是 ${SERVICE_FAILURE_THRESHOLD_MIN}-${SERVICE_FAILURE_THRESHOLD_MAX} 的整数（当前 ${patch.threshold}）`,
        };
      }
    } else if (patch.threshold !== 0) {
      return { ok: false, reason: 'container_exit 的 threshold 必须为 0（非 0 退出码即触发）' };
    }
    value.threshold = patch.threshold;
  }

  if (patch.target !== undefined) {
    const problem = targetProblem(patch.target);
    if (problem) return { ok: false, reason: problem };
    if (patch.target !== null) {
      const trimmed = patch.target.trim();
      if (kind === 'disk_percent' && !trimmed.startsWith('disk:')) {
        return { ok: false, reason: 'disk_percent 的 target 必须是 disk:<磁盘标签> 或 null' };
      }
      if (kind === 'memory_percent' && trimmed !== 'host') {
        return { ok: false, reason: 'memory_percent 的 target 只能是 host 或 null' };
      }
      if (kind === 'container_exit' && !trimmed.startsWith('container:')) {
        return { ok: false, reason: 'container_exit 的 target 必须是 container:<sourceRef> 或 null' };
      }
      if (kind === 'service_health' && !trimmed.startsWith('service:')) {
        return { ok: false, reason: 'service_health 的 target 必须是 service:<sourceRef> 或 null' };
      }
      value.target = trimmed;
    } else {
      value.target = null;
    }
  }

  return { ok: true, value };
}

/** 规则排序：内置在前、按 §5.1 的 kind 顺序、再按名称（稳定且与前端展示一致）。 */
export function compareAlertRules(a: AlertRuleRow, b: AlertRuleRow): number {
  if (a.builtin !== b.builtin) return b.builtin - a.builtin;
  const rank = ALERT_KINDS.indexOf(a.kind) - ALERT_KINDS.indexOf(b.kind);
  if (rank !== 0) return rank;
  return a.name.localeCompare(b.name);
}