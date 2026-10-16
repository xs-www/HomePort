/**
 * 告警引擎单测（Sprint 2 §5 / §10）。
 *
 * 覆盖四件事，缺一不可：
 * 1. 四条内置规则各自的触发/不触发边界；
 * 2. **episode 语义**：一次故障一行、恢复写 `resolved_at`、静默期内重开同一行、超期才插新行；
 * 3. **不变量**：预置未恢复行时 `tick()` 绝不插新行（重启不重复通知）；
 * 4. duration 门控、`enabled = 0` 不评估、`suppressed` 计数与审计动作名。
 *
 * 数据库用真实迁移（`initDatabase({ file: ':memory:' })` 跑完整 MIGRATIONS），
 * 因此"未恢复最多一行"的部分唯一索引是**真的**在起作用 ——
 * 手工建表虽然也能跑，但测不出这条不变量本身。
 */
import { describe, expect, it } from 'vitest';
import { initDatabase, type Db } from '../src/db/database.js';
import { AuditRepository } from '../src/db/users.js';
import { createSilentLogger } from '../src/logger.js';
import { AlertEngine, createAlertSnapshotSource, evaluateRule } from '../src/modules/alerts/engine.js';
import { AlertsService } from '../src/modules/alerts/service.js';
import { BUILTIN_ALERT_RULES, mergeBuiltinRules, validateRulePatch } from '../src/modules/alerts/rules.js';
import type { AlertEventDbRow, AlertRuleDbRow, AlertRuleRow, AlertSnapshot } from '../src/modules/alerts/types.js';
import { toAlertRuleRow } from '../src/modules/alerts/types.js';
import type { ContainerListResult } from '../src/modules/docker/types.js';
import type { SystemSnapshot } from '../src/modules/system/types.js';
import { makeContainer, makeContainerList } from './support/serviceFixtures.js';

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const T0_ISO = new Date(T0).toISOString();
const MINUTE = 60_000;

interface AuditCall {
  action: string;
  detail: Record<string, unknown>;
}

interface World {
  db: Db;
  engine: AlertEngine;
  service: AlertsService;
  audits: AuditCall[];
  /** 打开一条内置规则（默认阈值）并可选地改阈值/时长/静默期/严重级/目标。 */
  configure(id: string, patch?: { threshold?: number | null; durationSec?: number; silenceSec?: number; severity?: string; target?: string | null }): void;
  rows(): AlertEventDbRow[];
  count(): number;
  ruleRows(): AlertRuleRow[];
  close(): void;
}

function createWorld(options: { auditSink?: 'collector' | 'repository' } = {}): World {
  const { db } = initDatabase({ file: ':memory:' });
  const audits: AuditCall[] = [];
  const repository = new AuditRepository(db);
  const sink =
    options.auditSink === 'repository'
      ? repository
      : (action: string, detail: Record<string, unknown>) => {
          audits.push({ action, detail });
        };
  const service = new AlertsService({ db, audit: repository, logger: createSilentLogger(), clock: () => T0 });
  service.ensureBuiltinRules(T0_ISO);
  const engine = new AlertEngine({ db, config: {} as never, logger: createSilentLogger(), audit: sink, clock: () => T0 });

  return {
    db,
    engine,
    service,
    audits,
    configure: (id, patch = {}) => {
      db.prepare('UPDATE alert_rules SET enabled = 1 WHERE id = ?').run(id);
      if (patch.threshold !== undefined) db.prepare('UPDATE alert_rules SET threshold = ? WHERE id = ?').run(patch.threshold, id);
      if (patch.durationSec !== undefined) db.prepare('UPDATE alert_rules SET duration_sec = ? WHERE id = ?').run(patch.durationSec, id);
      if (patch.silenceSec !== undefined) db.prepare('UPDATE alert_rules SET silence_sec = ? WHERE id = ?').run(patch.silenceSec, id);
      if (patch.severity !== undefined) db.prepare('UPDATE alert_rules SET severity = ? WHERE id = ?').run(patch.severity, id);
      if (patch.target !== undefined) db.prepare('UPDATE alert_rules SET target = ? WHERE id = ?').run(patch.target, id);
    },
    rows: () => db.prepare('SELECT * FROM alert_events ORDER BY fired_at, created_at').all() as AlertEventDbRow[],
    count: () => Number((db.prepare('SELECT COUNT(*) AS n FROM alert_events').get() as { n: number }).n),
    ruleRows: () => (db.prepare('SELECT * FROM alert_rules').all() as AlertRuleDbRow[]).map(toAlertRuleRow),
    close: () => db.close(),
  };
}

function makeSnapshot(overrides: Partial<AlertSnapshot> = {}): AlertSnapshot {
  return {
    at: T0,
    host: { cpuPercent: 5, memoryPercent: 40, disks: [{ label: 'C:', percent: 20 }] },
    containers: [],
    services: [],
    ...overrides,
  };
}

function hostSnapshot(input: { memoryPercent?: number | null; disks?: Array<{ label: string; percent: number | null }> }): AlertSnapshot {
  return makeSnapshot({
    host: {
      cpuPercent: 5,
      memoryPercent: input.memoryPercent ?? 40,
      disks: input.disks ?? [{ label: 'C:', percent: 20 }],
    },
  });
}

function serviceSnapshot(sourceRef: string, consecutiveFailures: number, label = sourceRef): AlertSnapshot {
  return makeSnapshot({
    services: [{ sourceRef, serviceId: `svc-${sourceRef}`, label, verdict: consecutiveFailures > 0 ? 'down' : 'healthy', consecutiveFailures }],
  });
}

/** 预置一行（通常是"未恢复"或"已恢复"的 episode），用于重启/静默期场景。 */
function seedEvent(
  world: World,
  input: {
    id: string;
    ruleId: string;
    kind: string;
    target: string;
    targetLabel?: string;
    severity?: string;
    value?: number | null;
    firedAt: string;
    resolvedAt?: string | null;
    reopenCount?: number;
    acknowledgedAt?: string | null;
  },
): void {
  world.db
    .prepare(
      `INSERT INTO alert_events (
         id, rule_id, kind, rule_name, target, target_label, severity, value, threshold, unit,
         message, started_at, fired_at, resolved_at, reopen_count, acknowledged_at, acknowledged_by, created_at
       ) VALUES (
         @id, @ruleId, @kind, @kind, @target, @targetLabel, @severity, @value, 0, 'count',
         'seed', @firedAt, @firedAt, @resolvedAt, @reopenCount, @acknowledgedAt, NULL, @firedAt
       )`,
    )
    .run({
      id: input.id,
      ruleId: input.ruleId,
      kind: input.kind,
      target: input.target,
      targetLabel: input.targetLabel ?? input.target,
      severity: input.severity ?? 'warning',
      value: input.value ?? 1,
      firedAt: input.firedAt,
      resolvedAt: input.resolvedAt ?? null,
      reopenCount: input.reopenCount ?? 0,
      acknowledgedAt: input.acknowledgedAt ?? null,
    });
}

describe('告警规则纯函数（§5.1）', () => {
  it('内置规则共四条，id 稳定、enabled=0、builtin=1', () => {
    expect(BUILTIN_ALERT_RULES).toHaveLength(4);
    expect(BUILTIN_ALERT_RULES.map((rule) => rule.id)).toEqual([
      'rule-disk-percent',
      'rule-memory-percent',
      'rule-container-exit',
      'rule-service-health',
    ]);
    expect(BUILTIN_ALERT_RULES.map((rule) => rule.kind)).toEqual([
      'disk_percent',
      'memory_percent',
      'container_exit',
      'service_health',
    ]);
    for (const rule of BUILTIN_ALERT_RULES) {
      expect(rule.enabled).toBe(0);
      expect(rule.builtin).toBe(1);
    }
  });

  it('mergeBuiltinRules 幂等：补齐两次仍是四条，已存在行原样保留', () => {
    const first = mergeBuiltinRules([], T0_ISO);
    expect(first).toHaveLength(4);
    expect(first.every((rule) => rule.createdAt === T0_ISO && rule.updatedAt === T0_ISO)).toBe(true);

    const second = mergeBuiltinRules(first, new Date(T0 + MINUTE).toISOString());
    expect(second).toHaveLength(4);
    expect(second.map((rule) => rule.id)).toEqual(first.map((rule) => rule.id));

    // 管理员改过的阈值不会被"补齐"改回去
    const edited = first.map((rule) => (rule.id === 'rule-disk-percent' ? { ...rule, threshold: 42, enabled: 1 } : rule));
    const merged = mergeBuiltinRules(edited, T0_ISO);
    expect(merged.find((rule) => rule.id === 'rule-disk-percent')?.threshold).toBe(42);
    expect(merged.find((rule) => rule.id === 'rule-disk-percent')?.enabled).toBe(1);
  });

  it('阈值/时长/静默期越界一律拒绝（不静默截断）', () => {
    expect(validateRulePatch('disk_percent', { threshold: 0 })).toMatchObject({ ok: false });
    expect(validateRulePatch('disk_percent', { threshold: 100 })).toMatchObject({ ok: true });
    expect(validateRulePatch('disk_percent', { threshold: 100.5 })).toMatchObject({ ok: false });
    expect(validateRulePatch('disk_percent', { threshold: null })).toMatchObject({ ok: false });

    expect(validateRulePatch('disk_percent', { durationSec: 0 })).toMatchObject({ ok: true });
    expect(validateRulePatch('disk_percent', { durationSec: 86_400 })).toMatchObject({ ok: true });
    expect(validateRulePatch('disk_percent', { durationSec: 86_401 })).toMatchObject({ ok: false });
    expect(validateRulePatch('disk_percent', { durationSec: -1 })).toMatchObject({ ok: false });
    expect(validateRulePatch('disk_percent', { durationSec: 1.5 })).toMatchObject({ ok: false });

    expect(validateRulePatch('disk_percent', { silenceSec: 59 })).toMatchObject({ ok: false });
    expect(validateRulePatch('disk_percent', { silenceSec: 60 })).toMatchObject({ ok: true });
    expect(validateRulePatch('disk_percent', { silenceSec: 604_800 })).toMatchObject({ ok: true });
    expect(validateRulePatch('disk_percent', { silenceSec: 604_801 })).toMatchObject({ ok: false });

    expect(validateRulePatch('service_health', { threshold: 0 })).toMatchObject({ ok: false });
    expect(validateRulePatch('service_health', { threshold: 1 })).toMatchObject({ ok: true });
    expect(validateRulePatch('service_health', { threshold: 10 })).toMatchObject({ ok: true });
    expect(validateRulePatch('service_health', { threshold: 11 })).toMatchObject({ ok: false });
    expect(validateRulePatch('service_health', { threshold: 2.5 })).toMatchObject({ ok: false });

    expect(validateRulePatch('container_exit', { threshold: 0 })).toMatchObject({ ok: true });
    expect(validateRulePatch('container_exit', { threshold: 1 })).toMatchObject({ ok: false });

    expect(validateRulePatch('disk_percent', { enabled: true })).toMatchObject({ ok: true });
    expect(validateRulePatch('disk_percent', { notifyRecovery: false })).toMatchObject({ ok: true });
  });

  it('目标标识必须与 kind 同源（否则规则永远匹配不到目标）', () => {
    expect(validateRulePatch('disk_percent', { target: 'disk:C:' })).toMatchObject({ ok: true });
    expect(validateRulePatch('disk_percent', { target: 'service:docker:x' })).toMatchObject({ ok: false });
    expect(validateRulePatch('memory_percent', { target: 'host' })).toMatchObject({ ok: true });
    expect(validateRulePatch('memory_percent', { target: 'disk:C:' })).toMatchObject({ ok: false });
    expect(validateRulePatch('container_exit', { target: 'container:docker:gitea' })).toMatchObject({ ok: true });
    expect(validateRulePatch('container_exit', { target: 'host' })).toMatchObject({ ok: false });
    expect(validateRulePatch('service_health', { target: 'service:docker:gitea' })).toMatchObject({ ok: true });
    expect(validateRulePatch('service_health', { target: null })).toMatchObject({ ok: true });
    expect(validateRulePatch('service_health', { target: '  ' })).toMatchObject({ ok: false });

    // 不支持的字段与错误类型
    expect(validateRulePatch('disk_percent', { wat: 1 } as never)).toMatchObject({ ok: false });
    expect(validateRulePatch('disk_percent', { enabled: 'yes' } as never)).toMatchObject({ ok: false });
  });
});

describe('告警引擎 · disk_percent 边界', () => {
  it('等于阈值不触发；超过才触发（并带 value/threshold/unit/message）', async () => {
    const world = createWorld();
    world.configure('rule-disk-percent', { durationSec: 0 });

    const atThreshold = await world.engine.tick(T0, hostSnapshot({ disks: [{ label: 'C:', percent: 85 }] }));
    expect(atThreshold.opened).toBe(0);
    expect(world.count()).toBe(0);

    const above = await world.engine.tick(T0, hostSnapshot({ disks: [{ label: 'C:', percent: 85.1 }] }));
    expect(above.opened).toBe(1);
    expect(above.evaluated).toBe(1);
    const row = world.rows()[0]!;
    expect(row.rule_id).toBe('rule-disk-percent');
    expect(row.kind).toBe('disk_percent');
    expect(row.target).toBe('disk:C:');
    expect(row.target_label).toBe('C:');
    expect(row.value).toBe(85.1);
    expect(row.threshold).toBe(85);
    expect(row.unit).toBe('percent');
    expect(row.message).toBe('磁盘 C: 使用率 85.1%（阈值 85%）');
    expect(row.severity).toBe('warning');
    world.close();
  });

  it('target 指定别的磁盘时，其它磁盘超过阈值也不触发', async () => {
    const world = createWorld();
    world.configure('rule-disk-percent', { durationSec: 0, target: 'disk:D:' });
    const result = await world.engine.tick(T0, hostSnapshot({ disks: [{ label: 'C:', percent: 95 }] }));
    expect(result.opened).toBe(0);
    expect(world.count()).toBe(0);
    world.close();
  });

  it('磁盘数据缺失（percent=null）既不触发也不恢复', async () => {
    const world = createWorld();
    world.configure('rule-disk-percent', { durationSec: 0 });
    seedEvent(world, { id: 'a-open', ruleId: 'rule-disk-percent', kind: 'disk_percent', target: 'disk:C:', firedAt: T0_ISO });

    const result = await world.engine.tick(T0 + MINUTE, hostSnapshot({ disks: [{ label: 'C:', percent: null }] }));
    expect(result.resolved).toBe(0);
    expect(world.rows()[0]!.resolved_at).toBeNull();
    world.close();
  });
});

describe('告警引擎 · memory_percent 边界', () => {
  it('等于阈值不触发；超过才触发，目标固定为 host', async () => {
    const world = createWorld();
    world.configure('rule-memory-percent', { durationSec: 0 });

    expect((await world.engine.tick(T0, hostSnapshot({ memoryPercent: 90 }))).opened).toBe(0);
    const above = await world.engine.tick(T0, hostSnapshot({ memoryPercent: 90.5 }));
    expect(above.opened).toBe(1);
    const row = world.rows()[0]!;
    expect(row.target).toBe('host');
    expect(row.target_label).toBe('宿主');
    expect(row.message).toBe('宿主内存使用率 90.5%（阈值 90%）');
    world.close();
  });
});

describe('告警引擎 · container_exit 边界', () => {
  function containerSnapshot(items: AlertSnapshot['containers']): AlertSnapshot {
    return makeSnapshot({ containers: items });
  }

  it('exited + 非 0 退出码 → 触发（unit=exit_code）', async () => {
    const world = createWorld();
    world.configure('rule-container-exit');
    const result = await world.engine.tick(
      T0,
      containerSnapshot([{ sourceRef: 'docker:gitea', label: 'gitea', containerId: 'c-gitea', state: 'exited', exitCode: 1, startedAt: T0_ISO }]),
    );
    expect(result.opened).toBe(1);
    const row = world.rows()[0]!;
    expect(row.target).toBe('container:docker:gitea');
    expect(row.value).toBe(1);
    expect(row.unit).toBe('exit_code');
    expect(row.severity).toBe('critical');
    expect(row.message).toBe('容器 gitea 异常退出（exited，退出码 1）');
    world.close();
  });

  it('exited + 退出码 0 → 不触发（正常停止不是故障）', async () => {
    const world = createWorld();
    world.configure('rule-container-exit');
    const result = await world.engine.tick(
      T0,
      containerSnapshot([{ sourceRef: 'docker:gitea', label: 'gitea', containerId: 'c-gitea', state: 'exited', exitCode: 0, startedAt: T0_ISO }]),
    );
    expect(result.opened).toBe(0);
    world.close();
  });

  it('exited + 退出码未知 → 不触发（宁可漏报，不把正常停止报成异常退出）', async () => {
    const world = createWorld();
    world.configure('rule-container-exit');
    const result = await world.engine.tick(
      T0,
      containerSnapshot([{ sourceRef: 'docker:gitea', label: 'gitea', containerId: 'c-gitea', state: 'exited', exitCode: null, startedAt: T0_ISO }]),
    );
    expect(result.opened).toBe(0);
    world.close();
  });

  it('state = dead → 触发（即使退出码未知）', async () => {
    const world = createWorld();
    world.configure('rule-container-exit');
    const result = await world.engine.tick(
      T0,
      containerSnapshot([{ sourceRef: 'docker:gitea', label: 'gitea', containerId: 'c-gitea', state: 'dead', exitCode: null, startedAt: T0_ISO }]),
    );
    expect(result.opened).toBe(1);
    expect(world.rows()[0]!.message).toContain('退出码未知');
    world.close();
  });

  it('running → 不触发，且把已有未恢复行恢复掉（恢复条件 = 重新 running）', async () => {
    const world = createWorld();
    world.configure('rule-container-exit');
    seedEvent(world, {
      id: 'a-container',
      ruleId: 'rule-container-exit',
      kind: 'container_exit',
      target: 'container:docker:gitea',
      firedAt: T0_ISO,
      severity: 'critical',
    });

    const result = await world.engine.tick(
      T0 + MINUTE,
      containerSnapshot([{ sourceRef: 'docker:gitea', label: 'gitea', containerId: 'c-gitea', state: 'running', exitCode: null, startedAt: T0_ISO }]),
    );
    expect(result.resolved).toBe(1);
    expect(world.rows()[0]!.resolved_at).toBe(new Date(T0 + MINUTE).toISOString());
    world.close();
  });

  it('一直在 exited 的一次异常退出只告警一次', async () => {
    const world = createWorld();
    world.configure('rule-container-exit');
    const snapshot = containerSnapshot([
      { sourceRef: 'docker:gitea', label: 'gitea', containerId: 'c-gitea', state: 'exited', exitCode: 1, startedAt: T0_ISO },
    ]);

    const first = await world.engine.tick(T0, snapshot);
    const second = await world.engine.tick(T0 + MINUTE, snapshot);
    expect(first.opened).toBe(1);
    expect(second.opened).toBe(0);
    expect(second.suppressed).toBe(1);
    expect(world.count()).toBe(1);
    world.close();
  });

  it('容器不在快照里（被删除）→ 保持未恢复，不假恢复', async () => {
    const world = createWorld();
    world.configure('rule-container-exit');
    seedEvent(world, { id: 'a-container', ruleId: 'rule-container-exit', kind: 'container_exit', target: 'container:docker:gitea', firedAt: T0_ISO });
    const result = await world.engine.tick(T0 + MINUTE, containerSnapshot([]));
    expect(result.resolved).toBe(0);
    expect(world.rows()[0]!.resolved_at).toBeNull();
    world.close();
  });

  it('退出码未知（null）时不会把 exited 误报成异常退出', async () => {
    // 语义：`null` = 未知、`0` = 正常退出，**两者都不触发** —— 宁可漏报，
    // 也不能把"正常停止"报成异常退出。`makeContainer()` 默认就是 `exitCode: null`，
    // 模拟的是"容器已 exited 但退出码没取到"（缺 State 的 inspect、或旧夹具）。
    // 注：mapper 现已映射 `State.ExitCode`，"非 0 退出码触发"由引擎用例另行覆盖。
    const live: ContainerListResult = makeContainerList([
      makeContainer({ id: 'c-gitea', name: 'gitea', state: 'exited', status: 'Exited (1)', finishedAt: T0_ISO }),
    ]);
    const world = createWorld();
    world.configure('rule-container-exit');
    const source = createAlertSnapshotSource({
      config: { port: 8899 } as never,
      system: { snapshot: async () => { throw new Error('未使用'); } },
      containers: { list: async () => live },
      registry: { list: async () => ({ items: [], total: 0, categories: [], discovery: {} as never, generatedAt: T0_ISO }) },
      health: { states: () => [] },
    });
    const result = await world.engine.tick(T0, await source.capture(T0));
    expect(result.opened).toBe(0);
    world.close();
  });
});

describe('告警引擎 · service_health 边界', () => {
  it('连续失败 2 次（阈值 3）不触发，3 次才触发，unit=count', async () => {
    const world = createWorld();
    world.configure('rule-service-health');

    expect((await world.engine.tick(T0, serviceSnapshot('docker:gitea', 2, 'Gitea'))).opened).toBe(0);
    const triggered = await world.engine.tick(T0 + MINUTE, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    expect(triggered.opened).toBe(1);
    const row = world.rows()[0]!;
    expect(row.target).toBe('service:docker:gitea');
    expect(row.target_label).toBe('Gitea');
    expect(row.value).toBe(3);
    expect(row.unit).toBe('count');
    expect(row.message).toBe('服务 Gitea 连续 3 次探测失败（阈值 3 次）');
    world.close();
  });

  it('服务不在快照里（发现失败）→ 保持未恢复', async () => {
    const world = createWorld();
    world.configure('rule-service-health');
    seedEvent(world, { id: 'a-service', ruleId: 'rule-service-health', kind: 'service_health', target: 'service:docker:gitea', firedAt: T0_ISO, severity: 'critical' });
    const result = await world.engine.tick(T0 + MINUTE, makeSnapshot());
    expect(result.resolved).toBe(0);
    world.close();
  });
});

describe('告警引擎 · episode / 静默期 / 重开 / 恢复', () => {
  it('服务连续失败 3 次只产生 1 条 firing，恢复产生 1 条 resolved（事件总数仍是 1）', async () => {
    const world = createWorld();
    world.configure('rule-service-health');

    const fired = await world.engine.tick(T0, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    const again = await world.engine.tick(T0 + MINUTE, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    const recovered = await world.engine.tick(T0 + 2 * MINUTE, serviceSnapshot('docker:gitea', 0, 'Gitea'));

    expect(fired.opened).toBe(1);
    expect(again.opened).toBe(0);
    expect(again.suppressed).toBe(1);
    expect(recovered.resolved).toBe(1);
    expect(world.count()).toBe(1);
    expect(world.rows()[0]!.resolved_at).toBe(new Date(T0 + 2 * MINUTE).toISOString());
    world.close();
  });

  it('抖动（失败-成功-失败）在静默期内不产生第二条事件，而是重开同一行', async () => {
    const world = createWorld();
    world.configure('rule-service-health');

    await world.engine.tick(T0, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    const eventId = world.rows()[0]!.id;
    await world.engine.tick(T0 + 2 * MINUTE, serviceSnapshot('docker:gitea', 0, 'Gitea'));
    const reopened = await world.engine.tick(T0 + 5 * MINUTE, serviceSnapshot('docker:gitea', 3, 'Gitea'));

    expect(reopened.reopened).toBe(1);
    expect(reopened.opened).toBe(0);
    expect(world.count()).toBe(1);
    const row = world.rows()[0]!;
    expect(row.id).toBe(eventId);
    expect(row.reopen_count).toBe(1);
    expect(row.resolved_at).toBeNull();
    world.close();
  });

  it('重开会清空 acknowledged_*（新的故障事实不该沿用旧的"我知道了"）', async () => {
    const world = createWorld();
    world.configure('rule-service-health');
    seedEvent(world, {
      id: 'a-acked',
      ruleId: 'rule-service-health',
      kind: 'service_health',
      target: 'service:docker:gitea',
      firedAt: T0_ISO,
      resolvedAt: new Date(T0 + MINUTE).toISOString(),
      acknowledgedAt: T0_ISO,
    });

    const result = await world.engine.tick(T0 + 2 * MINUTE, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    expect(result.reopened).toBe(1);
    const row = world.rows()[0]!;
    expect(row.reopen_count).toBe(1);
    expect(row.acknowledged_at).toBeNull();
    expect(row.acknowledged_by).toBeNull();
    expect(row.started_at).toBe(new Date(T0 + 2 * MINUTE).toISOString());
    world.close();
  });

  it('超过静默期后再次触发 → 插新行（不是重开）', async () => {
    const world = createWorld();
    world.configure('rule-service-health');
    // 静默期默认 3600s
    await world.engine.tick(T0, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    await world.engine.tick(T0 + 10 * MINUTE, serviceSnapshot('docker:gitea', 0, 'Gitea'));
    const beyond = await world.engine.tick(T0 + 61 * MINUTE, serviceSnapshot('docker:gitea', 3, 'Gitea'));

    expect(beyond.opened).toBe(1);
    expect(beyond.reopened).toBe(0);
    expect(world.count()).toBe(2);
    world.close();
  });

  it('不变量：预置一行未恢复时 tick() 绝不插新行（重启不重复通知）', async () => {
    const world = createWorld();
    world.configure('rule-service-health');
    seedEvent(world, {
      id: 'a-from-before-restart',
      ruleId: 'rule-service-health',
      kind: 'service_health',
      target: 'service:docker:gitea',
      firedAt: new Date(T0 - 30 * MINUTE).toISOString(),
      severity: 'critical',
    });

    const first = await world.engine.tick(T0, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    const second = await world.engine.tick(T0 + MINUTE, serviceSnapshot('docker:gitea', 3, 'Gitea'));

    expect(first.opened).toBe(0);
    expect(second.opened).toBe(0);
    expect(first.suppressed).toBe(1);
    expect(second.suppressed).toBe(1);
    expect(world.count()).toBe(1);
    expect(world.rows()[0]!.id).toBe('a-from-before-restart');
    world.close();
  });

  it('部分唯一索引是真的生效（直接插第二行未恢复会被数据库拒绝）', () => {
    const world = createWorld();
    seedEvent(world, { id: 'a1', ruleId: 'rule-service-health', kind: 'service_health', target: 'service:docker:gitea', firedAt: T0_ISO });
    expect(() =>
      seedEvent(world, { id: 'a2', ruleId: 'rule-service-health', kind: 'service_health', target: 'service:docker:gitea', firedAt: T0_ISO }),
    ).toThrow(/UNIQUE/i);
    world.close();
  });
});

describe('告警引擎 · duration / enabled / 快照缺失', () => {
  it('duration 窗口未满不触发，满了才触发（started_at = 条件首次成立）', async () => {
    const world = createWorld();
    // 磁盘规则默认 600s 窗口
    world.configure('rule-disk-percent');
    const hot = hostSnapshot({ disks: [{ label: 'C:', percent: 95 }] });

    const pending = await world.engine.tick(T0, hot);
    expect(pending.opened).toBe(0);
    expect(world.engine.pendingCount()).toBe(1);

    const halfway = await world.engine.tick(T0 + 5 * MINUTE, hot);
    expect(halfway.opened).toBe(0);

    const fired = await world.engine.tick(T0 + 10 * MINUTE, hot);
    expect(fired.opened).toBe(1);
    const row = world.rows()[0]!;
    expect(row.started_at).toBe(T0_ISO);
    expect(row.fired_at).toBe(new Date(T0 + 10 * MINUTE).toISOString());
    expect(row.message).toContain('已持续 10 分钟');
    world.close();
  });

  it('duration 途中条件恢复 → 计时清零重来（不累加两个不同时间段）', async () => {
    const world = createWorld();
    world.configure('rule-disk-percent');
    const hot = hostSnapshot({ disks: [{ label: 'C:', percent: 95 }] });
    const cool = hostSnapshot({ disks: [{ label: 'C:', percent: 10 }] });

    await world.engine.tick(T0, hot);
    await world.engine.tick(T0 + 5 * MINUTE, cool);
    expect(world.engine.pendingCount()).toBe(0);
    const restarted = await world.engine.tick(T0 + 9 * MINUTE, hot);
    expect(restarted.opened).toBe(0);
    const fired = await world.engine.tick(T0 + 9 * MINUTE + 600_000, hot);
    expect(fired.opened).toBe(1);
    expect(world.rows()[0]!.started_at).toBe(new Date(T0 + 9 * MINUTE).toISOString());
    world.close();
  });

  it('enabled = 0 的规则完全不评估', async () => {
    const world = createWorld(); // 不 configure → 四条内置规则全是 enabled = 0
    const result = await world.engine.tick(
      T0,
      makeSnapshot({
        host: { cpuPercent: 100, memoryPercent: 100, disks: [{ label: 'C:', percent: 100 }] },
        containers: [{ sourceRef: 'docker:gitea', label: 'gitea', containerId: 'c', state: 'exited', exitCode: 3, startedAt: null }],
        services: [{ sourceRef: 'docker:gitea', serviceId: 'svc', label: 'Gitea', verdict: 'down', consecutiveFailures: 9 }],
      }),
    );
    expect(result.evaluated).toBe(0);
    expect(result.opened).toBe(0);
    expect(world.count()).toBe(0);
    world.close();
  });

  it('没有快照来源时（空快照）不触发也不恢复，并记一条 warn', async () => {
    const world = createWorld();
    world.configure('rule-service-health');
    seedEvent(world, { id: 'a-open', ruleId: 'rule-service-health', kind: 'service_health', target: 'service:docker:gitea', firedAt: T0_ISO });

    const result = await world.engine.tick(T0); // 第二参数缺省、也没有 deps.snapshot
    expect(result.evaluated).toBe(0);
    expect(result.opened).toBe(0);
    expect(result.resolved).toBe(0);
    expect(world.rows()[0]!.resolved_at).toBeNull();
    world.close();
  });

  it('tick 结果形状：at 是 ISO、计数与事件表一致', async () => {
    const world = createWorld();
    world.configure('rule-service-health');
    const result = await world.engine.tick(T0, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    expect(result.at).toBe(T0_ISO);
    expect(result).toMatchObject({ evaluated: 1, opened: 1, reopened: 0, resolved: 0, suppressed: 0 });
    expect(world.engine.lastTickAt()).toBe(T0_ISO);
    world.close();
  });

  it('engine.tick 接受 unix 秒（调度器传的就是秒）', async () => {
    const world = createWorld();
    world.configure('rule-service-health');
    const seconds = Math.floor(T0 / 1000);
    const result = await world.engine.tick(seconds, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    expect(result.at).toBe(T0_ISO);
    world.close();
  });
});

describe('告警引擎 · 审计（§2.5）', () => {
  it('fired / reopened / resolved 三个动作名齐全，detail 只放非敏感字段', async () => {
    const world = createWorld();
    world.configure('rule-service-health');

    await world.engine.tick(T0, serviceSnapshot('docker:gitea', 3, 'Gitea'));
    await world.engine.tick(T0 + 2 * MINUTE, serviceSnapshot('docker:gitea', 0, 'Gitea'));
    await world.engine.tick(T0 + 5 * MINUTE, serviceSnapshot('docker:gitea', 3, 'Gitea'));

    const actions = world.audits.map((call) => call.action);
    expect(actions).toEqual(['alert.fired', 'alert.resolved', 'alert.reopened']);

    const fired = world.audits[0]!.detail;
    expect(Object.keys(fired).sort()).toEqual(['eventId', 'kind', 'ruleId', 'severity', 'target', 'threshold', 'value']);
    expect(fired.ruleId).toBe('rule-service-health');
    expect(fired.kind).toBe('service_health');
    expect(fired.target).toBe('service:docker:gitea');

    const resolved = world.audits[1]!.detail;
    expect(resolved.notifyRecovery).toBe(true);
    expect(resolved.resolvedAt).toBe(new Date(T0 + 2 * MINUTE).toISOString());

    expect(world.audits[2]!.detail.reopenCount).toBe(1);
    world.close();
  });

  it('audit 也接受 AuditRepository 形态（装配处手上就是这个对象）', async () => {
    const world = createWorld({ auditSink: 'repository' });
    world.configure('rule-service-health');
    await world.engine.tick(T0, serviceSnapshot('docker:gitea', 3, 'Gitea'));

    const entries = new AuditRepository(world.db).list(10);
    expect(entries.map((entry) => entry.action)).toEqual(['alert.fired']);
    expect(entries[0]!.actorName).toBe('system');
    expect(entries[0]!.target).toBe('service:docker:gitea');
    // detail 是 JSON（机器可读），且不含任何凭据类字段
    const detail = JSON.parse(entries[0]!.detail ?? '{}') as Record<string, unknown>;
    expect(detail.ruleId).toBe('rule-service-health');
    expect(Object.keys(detail)).not.toContain('password');
    world.close();
  });
});

describe('告警引擎 · evaluateRule 纯函数与快照采集', () => {
  it('evaluateRule 不碰数据库：同一输入两次结果一致', () => {
    const world = createWorld();
    world.configure('rule-disk-percent', { durationSec: 0 });
    const rule = world.ruleRows().find((item) => item.id === 'rule-disk-percent')!;
    const snapshot = hostSnapshot({ disks: [{ label: 'C:', percent: 95 }] });

    const first = evaluateRule(rule, snapshot, T0, new Map());
    const second = evaluateRule(rule, snapshot, T0, new Map());
    expect(first).toEqual(second);
    expect(first.active).toHaveLength(1);
    expect(first.active[0]!.target).toBe('disk:C:');
    expect(world.count()).toBe(0);
    world.close();
  });

  it('createAlertSnapshotSource 把宿主/容器/服务映射成快照（标签从服务列表取）', async () => {
    const system: SystemSnapshot = {
      generatedAt: T0_ISO,
      host: { hostname: 'nas', platform: 'linux', kernel: 'k', arch: 'x64', cpuModel: 'c', cpuCores: 4, uptimeSec: 1, bootedAt: T0_ISO, osLabel: 'Linux', hostIsLinux: true },
      cpu: { percent: 12.5, perCore: [], loadAvg: [0, 0, 0] },
      memory: { usedBytes: 1, totalBytes: 2, availableBytes: 1, percent: 55.5, cachedBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0 },
      disks: [{ mount: '/', label: 'C:', fsType: 'ext4', usedBytes: 1, totalBytes: 2, availableBytes: 1, percent: 91.2, error: null }],
      gpu: null,
      sources: {
        cpu: { available: true, mode: 'host-proc', detail: null },
        memory: { available: true, mode: 'host-proc', detail: null },
        disk: { available: true, mode: 'statfs', detail: null },
        gpu: { available: false, mode: 'nvidia-smi', detail: null },
      },
    };
    const live = makeContainerList([makeContainer({ id: 'c-gitea', name: 'gitea', state: 'exited' })]);
    const source = createAlertSnapshotSource({
      config: { port: 8899 } as never,
      system: { snapshot: async () => system },
      containers: { list: async () => live },
      registry: {
        list: async () => ({
          items: [
            {
              id: 'svc-gitea',
              sourceRef: 'docker:gitea',
              displayName: 'Gitea',
            } as never,
          ],
          total: 1,
          categories: [],
          discovery: {} as never,
          generatedAt: T0_ISO,
        }),
      },
      health: {
        states: () => [
          {
            sourceRef: 'docker:gitea',
            serviceId: 'svc-gitea',
            verdict: 'down',
            dimensions: {} as never,
            consecutiveFailures: 3,
            consecutiveSuccesses: 0,
            changedAt: T0_ISO,
            lastEvaluatedAt: T0_ISO,
            lastProbeAt: null,
            reasons: [],
          },
        ],
      },
    });

    const snapshot = await source.capture(T0);
    expect(snapshot.at).toBe(T0);
    expect(snapshot.host.memoryPercent).toBe(55.5);
    expect(snapshot.host.disks).toEqual([{ label: 'C:', percent: 91.2 }]);
    expect(snapshot.containers).toEqual([
      { sourceRef: 'docker:gitea', label: 'gitea', containerId: 'c-gitea', state: 'exited', exitCode: null, startedAt: '2026-10-15T00:00:01.000Z' },
    ]);
    expect(snapshot.services).toEqual([
      { sourceRef: 'docker:gitea', serviceId: 'svc-gitea', label: 'Gitea', verdict: 'down', consecutiveFailures: 3 },
    ]);
  });

  it('createAlertSnapshotSource 单源失败只降级该部分（不抛错）', async () => {
    const source = createAlertSnapshotSource({
      config: { port: 8899 } as never,
      system: {
        snapshot: async () => {
          throw new Error('proc 读取失败');
        },
      },
      containers: {
        list: async () => {
          throw new Error('docker 不可用');
        },
      },
      registry: {
        list: async () => {
          throw new Error('发现失败');
        },
      },
      health: { states: () => [] },
      logger: createSilentLogger(),
    });

    const snapshot = await source.capture(T0);
    expect(snapshot.host.cpuPercent).toBeNull();
    expect(snapshot.host.memoryPercent).toBeNull();
    expect(snapshot.host.disks).toEqual([]);
    expect(snapshot.containers).toEqual([]);
    expect(snapshot.services).toEqual([]);
  });
});

describe('告警业务出口 · ensureBuiltinRules（§5.3）', () => {
  it('第一次补齐四条、第二次返回 0（幂等）', () => {
    const { db } = initDatabase({ file: ':memory:' });
    const service = new AlertsService({ db, audit: new AuditRepository(db), logger: createSilentLogger(), clock: () => T0 });

    expect(service.rules()).toEqual([]); // 迁移只建结构，不塞业务数据
    expect(service.ensureBuiltinRules(T0_ISO)).toBe(4);
    const afterFirst = service.rules();
    expect(afterFirst).toHaveLength(4);
    expect(afterFirst.every((rule) => rule.enabled === false && rule.builtin)).toBe(true);

    expect(service.ensureBuiltinRules(T0_ISO)).toBe(0);
    expect(service.rules()).toHaveLength(4);
    expect(service.rules().map((rule) => rule.id)).toEqual(afterFirst.map((rule) => rule.id));
    db.close();
  });
});