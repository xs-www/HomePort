/**
 * 健康状态机单测（Sprint 2 §4.1 / §10）。
 *
 * 纯函数测试：全部输入（信号、阈值、时间）都是参数，没有时钟、没有 I/O。
 * 因此这里可以把 7 条规则**逐条**锁死，而不必搭 Docker/HTTP 的假世界。
 *
 * 用例与规格的对应关系写在每个 `it` 的标题里，方便对着 §4.1 复核。
 */
import { describe, expect, it } from 'vitest';
import { evaluateHealth } from '../src/modules/health/state.js';
import type { HealthSignal, ServiceHealthState } from '../src/modules/health/types.js';

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const MINUTE = 60_000;

const OPTIONS = { failThreshold: 3, okThreshold: 2 };

function signal(overrides: Partial<HealthSignal> = {}): HealthSignal {
  return {
    container: 'ok',
    dockerHealth: 'ok',
    http: 'unknown',
    sourceRef: 'docker:sisi/calendar',
    serviceId: 'svc-calendar',
    ...overrides,
  };
}

/** 连续评估一串信号，返回全部中间状态（最后一个即最终状态）。 */
function evaluateAll(signals: readonly HealthSignal[], startAt = T0): ServiceHealthState[] {
  const states: ServiceHealthState[] = [];
  let previous: ServiceHealthState | null = null;
  signals.forEach((item, index) => {
    const state = evaluateHealth(previous, item, { ...OPTIONS, at: startAt + index * MINUTE });
    states.push(state);
    previous = state;
  });
  return states;
}

const CONTAINER_DOWN = signal({
  container: 'fail',
  details: { container: 'sisi-calendar 已退出（exited）' },
});

describe('健康状态机 · 规则 1：连续 failThreshold 次失败才判 down', () => {
  it('连续 2 次失败仍是 degraded，第 3 次才 down', () => {
    const states = evaluateAll([CONTAINER_DOWN, CONTAINER_DOWN, CONTAINER_DOWN]);

    expect(states[0]?.verdict).toBe('degraded');
    expect(states[0]?.consecutiveFailures).toBe(1);
    expect(states[1]?.verdict).toBe('degraded');
    expect(states[1]?.consecutiveFailures).toBe(2);
    expect(states[2]?.verdict).toBe('down');
    expect(states[2]?.consecutiveFailures).toBe(3);
  });

  it('首轮就是 fail 也只到 degraded（单次抖动不告警）', () => {
    const state = evaluateHealth(null, CONTAINER_DOWN, { ...OPTIONS, at: T0 });
    expect(state.verdict).toBe('degraded');
    expect(state.reasons.join(' ')).toContain('连续 1/3 次');
  });

  it('首轮全好直接是 healthy（没有前一状态可去抖，见 state.ts 文件头）', () => {
    const state = evaluateHealth(null, signal(), { ...OPTIONS, at: T0 });
    expect(state.verdict).toBe('healthy');
    expect(state.consecutiveSuccesses).toBe(1);
  });
});

describe('健康状态机 · 规则 1 续：中间夹一次成功则计数归零（抖动不告警）', () => {
  it('失败-失败-成功-失败-失败 始终不到 down', () => {
    const states = evaluateAll([
      CONTAINER_DOWN,
      CONTAINER_DOWN,
      signal(), // 抖动：一次成功
      CONTAINER_DOWN,
      CONTAINER_DOWN,
    ]);

    expect(states.map((state) => state.verdict)).toEqual(['degraded', 'degraded', 'degraded', 'degraded', 'degraded']);
    expect(states[4]?.consecutiveFailures).toBe(2);
    // 成功那一刻维度计数与整体计数都归零
    expect(states[2]?.dimensions.container.consecutiveFailures).toBe(0);
    expect(states[2]?.consecutiveFailures).toBe(0);
  });
});

describe('健康状态机 · 规则 2：恢复需要连续 okThreshold 次全好', () => {
  it('down 之后第 1 次全好仍是 degraded（正在恢复），第 2 次才 healthy', () => {
    const states = evaluateAll([CONTAINER_DOWN, CONTAINER_DOWN, CONTAINER_DOWN, signal(), signal()]);

    expect(states[3]?.verdict).toBe('degraded');
    expect(states[3]?.consecutiveSuccesses).toBe(1);
    expect(states[3]?.consecutiveFailures).toBe(0);
    expect(states[3]?.reasons.join(' ')).toContain('正在恢复：连续正常 1/2 次');
    expect(states[4]?.verdict).toBe('healthy');
    expect(states[4]?.consecutiveSuccesses).toBe(2);
    expect(states[4]?.reasons).toEqual([]);
  });

  it('单次全好后再次失败 → 只是 degraded，不会因为之前的 down 直接复现 down', () => {
    const states = evaluateAll([CONTAINER_DOWN, CONTAINER_DOWN, CONTAINER_DOWN, signal(), CONTAINER_DOWN]);
    expect(states[4]?.verdict).toBe('degraded');
    expect(states[4]?.consecutiveFailures).toBe(1);
  });
});

describe('健康状态机 · 规则 3：unknown 不参与成败判定', () => {
  it('三维全 unknown → verdict unknown，且计数不变', () => {
    const state = evaluateHealth(null, signal({ container: 'unknown', dockerHealth: 'unknown', http: 'unknown' }), {
      ...OPTIONS,
      at: T0,
    });
    expect(state.verdict).toBe('unknown');
    expect(state.dimensions.container.state).toBe('unknown');
    expect(state.reasons.join(' ')).toContain('三维均为未知');
  });

  it('连续失败中插入全 unknown：不清零也不推进（没信号 ≠ 恢复）', () => {
    const states = evaluateAll([
      CONTAINER_DOWN,
      CONTAINER_DOWN,
      signal({ container: 'unknown', dockerHealth: 'unknown', http: 'unknown' }),
      CONTAINER_DOWN,
    ]);

    expect(states[2]?.verdict).toBe('unknown');
    expect(states[2]?.consecutiveFailures).toBe(2);
    // 第 4 次失败把连续数推到 3 → down（unknown 没有抹掉已有计数）
    expect(states[3]?.verdict).toBe('down');
    expect(states[3]?.consecutiveFailures).toBe(3);
  });

  it('部分 unknown（容器 ok + http unknown）不阻塞 healthy', () => {
    const state = evaluateHealth(null, signal({ http: 'unknown' }), { ...OPTIONS, at: T0 });
    expect(state.verdict).toBe('healthy');
  });
});

describe('健康状态机 · 规则 4：三维计数互相独立', () => {
  it('HTTP 连续失败 2 次而容器正常：http 计数 2、container 计数 0、verdict degraded', () => {
    const httpFail = signal({ http: 'fail', details: { http: '连接超时' } });
    const states = evaluateAll([httpFail, httpFail]);
    const state = states[1]!;

    expect(state.dimensions.http.consecutiveFailures).toBe(2);
    expect(state.dimensions.container.consecutiveFailures).toBe(0);
    expect(state.dimensions.dockerHealth.consecutiveFailures).toBe(0);
    expect(state.consecutiveFailures).toBe(2);
    expect(state.verdict).toBe('degraded');
  });

  it('dockerHealth 单独失败也会推进整体判定', () => {
    const unhealthy = signal({ dockerHealth: 'fail', details: { dockerHealth: 'sisi-calendar: unhealthy' } });
    const states = evaluateAll([unhealthy, unhealthy, unhealthy]);
    expect(states[2]?.verdict).toBe('down');
    expect(states[2]?.dimensions.dockerHealth.consecutiveFailures).toBe(3);
    expect(states[2]?.dimensions.container.consecutiveFailures).toBe(0);
  });
});

describe('健康状态机 · 规则 5：状态变化即归零，changedAt 只在 verdict 变化时更新', () => {
  it('http 失败-成功-失败 → 计数归零重算（不是 2）', () => {
    const fail = signal({ http: 'fail' });
    const states = evaluateAll([fail, signal({ http: 'ok' }), fail]);
    expect(states[0]?.dimensions.http.consecutiveFailures).toBe(1);
    expect(states[1]?.dimensions.http.consecutiveFailures).toBe(0);
    expect(states[2]?.dimensions.http.consecutiveFailures).toBe(1);
  });

  it('verdict 不变时 changedAt 保持第一次的时刻', () => {
    const states = evaluateAll([CONTAINER_DOWN, CONTAINER_DOWN, CONTAINER_DOWN]);
    const firstDegraded = new Date(T0).toISOString();
    expect(states[0]?.changedAt).toBe(firstDegraded);
    expect(states[1]?.changedAt).toBe(firstDegraded); // 还是 degraded → 不变
    expect(states[2]?.changedAt).toBe(new Date(T0 + 2 * MINUTE).toISOString()); // 变成 down → 更新
    expect(states[2]?.lastEvaluatedAt).toBe(new Date(T0 + 2 * MINUTE).toISOString());
  });
});

describe('健康状态机 · 规则 6：reasons 说清维度、次数与证据', () => {
  it('容器失败 → 含容器名与状态，以及连续次数', () => {
    const states = evaluateAll([CONTAINER_DOWN, CONTAINER_DOWN, CONTAINER_DOWN]);
    const reasons = states[2]!.reasons;
    expect(reasons[0]).toBe('连续失败 3 次（阈值 3），判定为不可用');
    expect(reasons.join(' ')).toContain('容器 sisi-calendar 已退出（exited）（连续 3/3 次）');
  });

  it('HTTP 失败 → 文案形如「HTTP 探测失败 2/3 次：连接超时」', () => {
    const fail = signal({ http: 'fail', details: { http: '连接超时' } });
    const states = evaluateAll([fail, fail]);
    expect(states[1]?.reasons.join(' ')).toContain('HTTP 探测失败 2/3 次：连接超时');
  });

  it('docker health 失败 → 含证据与次数', () => {
    const unhealthy = signal({ dockerHealth: 'fail', details: { dockerHealth: 'sisi-calendar: unhealthy' } });
    const states = evaluateAll([unhealthy]);
    expect(states[0]?.reasons.join(' ')).toContain('容器健康检查未通过（sisi-calendar: unhealthy）（连续 1/3 次）');
  });

  it('健康时不编造原因（reasons 为空）', () => {
    const state = evaluateHealth(null, signal(), { ...OPTIONS, at: T0 });
    expect(state.reasons).toEqual([]);
  });

  it('没有证据时只报维度与次数，不猜原因', () => {
    const state = evaluateHealth(null, signal({ container: 'fail' }), { ...OPTIONS, at: T0 });
    expect(state.reasons.join(' ')).toContain('容器维度异常（连续 1/3 次）');
  });
});

describe('健康状态机 · 规则 7：没有 healthTarget 时 http 维固定 unknown', () => {
  it('http unknown + 容器正常 → healthy；http 维 detail 说明"不探测"', () => {
    const state = evaluateHealth(null, signal({ http: 'unknown', details: { http: '未配置健康检查目标，不探测' } }), {
      ...OPTIONS,
      at: T0,
    });
    expect(state.verdict).toBe('healthy');
    expect(state.dimensions.http.state).toBe('unknown');
    expect(state.dimensions.http.detail).toBe('未配置健康检查目标，不探测');
    expect(state.lastProbeAt).toBeNull();
  });

  it('http unknown + 容器退出 → 由容器维度决定 verdict（不受 unknown 干扰）', () => {
    const containerFail = signal({ container: 'fail', http: 'unknown' });
    const states = evaluateAll([containerFail, containerFail, containerFail]);
    expect(states[2]?.verdict).toBe('down');
    expect(states[2]?.dimensions.http.state).toBe('unknown');
  });
});

describe('健康状态机 · 边界与时间戳', () => {
  it('阈值非法（0 / NaN）退回默认 3 / 2', () => {
    const first = evaluateHealth(null, CONTAINER_DOWN, { failThreshold: 0, okThreshold: Number.NaN, at: T0 });
    expect(first.dimensions.container.consecutiveFailures).toBe(1);
    expect(first.reasons.join(' ')).toContain('连续 1/3 次');

    // 默认 failThreshold = 3：用非法阈值评估两次也仍然是 degraded
    const second = evaluateHealth(first, CONTAINER_DOWN, { failThreshold: -1, okThreshold: Number.NaN, at: T0 + MINUTE });
    expect(second.verdict).toBe('degraded');
    expect(second.consecutiveFailures).toBe(2);
  });

  it('threshold = 1 时首轮失败即 down', () => {
    const state = evaluateHealth(null, CONTAINER_DOWN, { failThreshold: 1, okThreshold: 1, at: T0 });
    expect(state.verdict).toBe('down');
  });

  it('lastProbeAt 只在真的探测过（probedAt 有值）时推进', () => {
    const probed = evaluateHealth(null, signal({ http: 'ok', probedAt: new Date(T0).toISOString() }), {
      ...OPTIONS,
      at: T0,
    });
    expect(probed.lastProbeAt).toBe(new Date(T0).toISOString());

    const throttled = evaluateHealth(probed, signal({ http: 'ok', probedAt: null }), { ...OPTIONS, at: T0 + MINUTE });
    expect(throttled.lastProbeAt).toBe(new Date(T0).toISOString());
  });

  it('首轮从 signal 取身份；后续沿用 previous（并允许 signal 覆盖）', () => {
    const first = evaluateHealth(null, signal({ sourceRef: 'docker:sisi/calendar', serviceId: 'svc-1' }), {
      ...OPTIONS,
      at: T0,
    });
    expect(first.sourceRef).toBe('docker:sisi/calendar');
    expect(first.serviceId).toBe('svc-1');

    const second = evaluateHealth(first, { container: 'ok', dockerHealth: 'ok', http: 'unknown' }, { ...OPTIONS, at: T0 + MINUTE });
    expect(second.sourceRef).toBe('docker:sisi/calendar');
    expect(second.serviceId).toBe('svc-1');
  });

  it('接受秒制时间戳（调度器传的是 unix 秒）', () => {
    const state = evaluateHealth(null, signal(), { ...OPTIONS, at: Math.floor(T0 / 1000) });
    expect(state.lastEvaluatedAt).toBe(new Date(Math.floor(T0 / 1000) * 1000).toISOString());
  });

  it('未知的维度取值按 unknown 处理（不崩、不猜成功）', () => {
    const state = evaluateHealth(null, signal({ container: 'ok' as never, dockerHealth: 'wat' as never, http: 'ok' }), {
      ...OPTIONS,
      at: T0,
    });
    expect(state.dimensions.dockerHealth.state).toBe('unknown');
    expect(state.verdict).toBe('healthy');
  });
});