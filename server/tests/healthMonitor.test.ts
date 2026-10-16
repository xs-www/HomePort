/**
 * 健康监视器单测（Sprint 2 §4.2 / §10）。
 *
 * 假世界：`registry.list` / `containers.list` / `probe` 全是注入的假实现，
 * 时钟也是假的 —— 因此"节流""并发上限""TTL 缓存"这些与时间/并发有关的性质
 * 可以**确定性**断言，不需要 `await sleep`，也不会因为 CI 慢而变脆。
 */
import { describe, expect, it } from 'vitest';
import { HealthMonitor } from '../src/modules/health/monitor.js';
import type { HealthProbeResult } from '../src/modules/services/healthProbe.js';
import type { ServiceHealthState } from '../src/modules/health/types.js';
import type { ServiceListResponse, ServiceView } from '../src/modules/services/types.js';
import type { ContainerSummary } from '../src/modules/docker/types.js';
import { loadConfig } from '../src/config.js';
import { createSilentLogger } from '../src/logger.js';
import { makeContainer, makeContainerList } from './support/serviceFixtures.js';

const T0 = Date.parse('2026-10-15T10:00:00.000Z');
const testConfig = loadConfig({ env: 'test', logLevel: 'error', port: 8899 });

/** 让 tick 内部的若干次微任务推进到"探测已经发出"（不是真实等待）。 */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function okResult(at = new Date(T0).toISOString()): HealthProbeResult {
  return { state: 'ok', statusCode: 200, durationMs: 5, detail: null, at };
}

function makeServiceView(partial: Partial<ServiceView> & { sourceRef: string }): ServiceView {
  return {
    id: `svc-${partial.sourceRef}`,
    slug: partial.sourceRef.replace(/[^a-z0-9]+/gi, '-').toLowerCase(),
    displayName: partial.sourceRef,
    description: null,
    icon: null,
    category: null,
    sourceType: 'docker',
    bindingRefs: [],
    visibility: 'visible',
    favorite: false,
    sortOrder: 10,
    preferredUrl: null,
    entry: null,
    entries: [],
    entryCount: 0,
    status: { container: null, reachable: null, health: 'unknown', reasons: [] },
    container: null,
    userEdited: false,
    healthTarget: null,
    healthPath: null,
    createdAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:00.000Z',
    ...partial,
  };
}

/** 一个带健康目标的服务（`healthTarget` 直接给出，绕开入口解析）。 */
function serviceWithTarget(name: string, target: string): ServiceView {
  return makeServiceView({
    sourceRef: `docker:${name}`,
    displayName: name,
    healthTarget: target,
    container: { id: `c-${name}`, name, state: 'running', image: `${name}:latest` },
  });
}

interface Harness {
  monitor: HealthMonitor;
  probeCalls: string[];
  containerListCalls: () => number;
  setServices(next: ServiceView[] | (() => Promise<ServiceListResponse>)): void;
  setContainers(next: ContainerSummary[]): void;
  setContainersError(message: string | null): void;
  setProbe(next: (target: string, options?: { timeoutMs?: number }) => Promise<HealthProbeResult>): void;
}

function createHarness(options: {
  services: ServiceView[];
  containers: ContainerSummary[];
  probe?: (target: string, options?: { timeoutMs?: number }) => Promise<HealthProbeResult>;
  intervalSec?: () => number;
  concurrency?: () => number;
}): Harness {
  let services: ServiceView[] | (() => Promise<ServiceListResponse>) = options.services;
  let containers = options.containers;
  let containersError: string | null = null;
  let probe = options.probe ?? (async () => okResult());
  const probeCalls: string[] = [];
  let containerListCalls = 0;

  const monitor = new HealthMonitor({
    config: testConfig,
    logger: createSilentLogger(),
    registry: {
      list: async () => {
        if (typeof services === 'function') return services();
        return {
          items: services,
          total: services.length,
          categories: [],
          discovery: {
            dockerAvailable: true,
            serveAvailable: true,
            serveDetail: null,
            discoveredAt: new Date(T0).toISOString(),
            notes: [],
          },
          generatedAt: new Date(T0).toISOString(),
        } satisfies ServiceListResponse;
      },
    },
    containers: {
      list: async () => {
        containerListCalls += 1;
        if (containersError) throw new Error(containersError);
        return makeContainerList(containers);
      },
    },
    probe: (target, opts) => {
      probeCalls.push(target);
      return probe(target, opts);
    },
    clock: () => T0,
    ...(options.intervalSec ? { intervalSec: options.intervalSec } : {}),
    ...(options.concurrency ? { concurrency: options.concurrency } : {}),
  });

  return {
    monitor,
    probeCalls,
    containerListCalls: () => containerListCalls,
    setServices: (next) => {
      services = next;
    },
    setContainers: (next) => {
      containers = next;
    },
    setContainersError: (message) => {
      containersError = message;
    },
    setProbe: (next) => {
      probe = next;
    },
  };
}

describe('健康监视器 · 探测节流（§4.2）', () => {
  it('间隔内不重复探；到点后再次探', async () => {
    const harness = createHarness({
      services: [serviceWithTarget('alpha', 'http://127.0.0.1:8080/health'), serviceWithTarget('beta', 'http://127.0.0.1:8081/health')],
      containers: [makeContainer({ id: 'c-alpha', name: 'alpha' }), makeContainer({ id: 'c-beta', name: 'beta' })],
      intervalSec: () => 60,
      concurrency: () => 4,
    });

    const first = await harness.monitor.tick(T0);
    expect(first.probed).toBe(2);
    expect(harness.probeCalls).toEqual(['http://127.0.0.1:8080/health', 'http://127.0.0.1:8081/health']);

    // 30s 后：都在节流窗口内 → 一个都不探，但仍评估容器维度
    const second = await harness.monitor.tick(T0 + 30_000);
    expect(second.probed).toBe(0);
    expect(second.evaluated).toBe(2);
    expect(harness.probeCalls).toHaveLength(2);

    // 60s 后：到期，重新探
    const third = await harness.monitor.tick(T0 + 60_000);
    expect(third.probed).toBe(2);
    expect(harness.probeCalls).toHaveLength(4);
  });

  it('探测顺序按 sourceRef 稳定排序（并发上限下"谁先谁后"可复现）', async () => {
    const harness = createHarness({
      services: [
        serviceWithTarget('zeta', 'http://127.0.0.1:9003/'),
        serviceWithTarget('alpha', 'http://127.0.0.1:9001/'),
        serviceWithTarget('mid', 'http://127.0.0.1:9002/'),
      ],
      containers: [],
      intervalSec: () => 60,
      concurrency: () => 1,
    });

    const result = await harness.monitor.tick(T0);
    expect(result.probed).toBe(1);
    expect(harness.probeCalls).toEqual(['http://127.0.0.1:9001/']);
    expect(result.skippedForConcurrency).toBe(2);
  });

  it('探测超时按健康探测的 3s 约定传递（SSRF/截断在 runHealthProbe 里，这里只传超时）', async () => {
    const seen: Array<{ timeoutMs?: number } | undefined> = [];
    const harness = createHarness({
      services: [serviceWithTarget('alpha', 'http://127.0.0.1:8080/health')],
      containers: [makeContainer({ id: 'c-alpha', name: 'alpha' })],
      intervalSec: () => 60,
      probe: async (_target, options) => {
        seen.push(options);
        return okResult();
      },
    });

    await harness.monitor.tick(T0);
    expect(seen).toEqual([{ timeoutMs: 3000 }]);
  });

  it('间隔为 0（关闭自动探测）时完全不探测，但仍评估容器维度', async () => {
    const harness = createHarness({
      services: [serviceWithTarget('alpha', 'http://127.0.0.1:8080/health')],
      containers: [
        makeContainer({ id: 'c-alpha', name: 'alpha', state: 'exited', status: 'Exited (1) 2 minutes ago', finishedAt: '2026-10-15T09:58:00.000Z' }),
      ],
      intervalSec: () => 0,
    });

    for (const offset of [0, 30_000, 60_000]) {
      await harness.monitor.tick(T0 + offset);
    }

    expect(harness.probeCalls).toEqual([]);
    const state = harness.monitor.state('docker:alpha');
    expect(state?.verdict).toBe('down');
    expect(state?.dimensions.container.state).toBe('fail');
    expect(state?.dimensions.http.state).toBe('unknown');
    expect(harness.monitor.probeStats().intervalSec).toBe(0);
    expect(harness.monitor.view().notes.join(' ')).toContain('自动 HTTP 探测已关闭');
  });
});

describe('健康监视器 · 全局并发上限（§4.2）', () => {
  it('在飞探测数不超过 concurrency，超出的计入 skippedForConcurrency 并留到下一 tick', async () => {
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const services = names.map((name, index) => serviceWithTarget(name, `http://127.0.0.1:910${index}/`));

    let inFlight = 0;
    let maxInFlight = 0;
    const pending: Array<() => void> = [];
    const harness = createHarness({
      services,
      containers: [],
      intervalSec: () => 60,
      concurrency: () => 2,
      probe: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => pending.push(resolve));
        inFlight -= 1;
        return okResult();
      },
    });

    const firstTick = harness.monitor.tick(T0);
    await flush();
    await flush();

    // 这一刻：2 个探测在飞，另外 3 个被推迟
    expect(pending).toHaveLength(2);
    expect(inFlight).toBe(2);
    expect(maxInFlight).toBe(2);
    expect(harness.monitor.probeStats().inFlight).toBe(2);

    for (const resolve of pending.splice(0)) resolve();
    const first = await firstTick;
    expect(first.probed).toBe(2);
    expect(first.skippedForConcurrency).toBe(3);
    expect(maxInFlight).toBe(2);
    expect(harness.monitor.probeStats().inFlight).toBe(0);

    // 下一 tick（30s 后）：刚探过的 2 个还在节流窗口内，被推迟的 3 个到期 → 仍然只放 2 个在飞
    const secondTick = harness.monitor.tick(T0 + 30_000);
    await flush();
    await flush();
    expect(pending).toHaveLength(2);
    expect(maxInFlight).toBe(2);
    for (const resolve of pending.splice(0)) resolve();
    const second = await secondTick;
    expect(second.probed).toBe(2);
    expect(second.skippedForConcurrency).toBe(1);
  });
});

describe('健康监视器 · 三维信号组装', () => {
  it('没有 healthTarget 时完全不探测，http 维固定 unknown 且 detail 说明原因', async () => {
    const harness = createHarness({
      services: [makeServiceView({ sourceRef: 'docker:alpha', displayName: 'alpha', container: { id: 'c-alpha', name: 'alpha', state: 'running', image: 'a' } })],
      containers: [makeContainer({ id: 'c-alpha', name: 'alpha' })],
      intervalSec: () => 60,
    });

    await harness.monitor.tick(T0);

    expect(harness.probeCalls).toEqual([]);
    const state = harness.monitor.state('docker:alpha');
    expect(state?.dimensions.http.state).toBe('unknown');
    expect(state?.dimensions.http.detail).toBe('未配置健康检查目标，不探测');
    expect(state?.verdict).toBe('healthy');
    expect(state?.lastProbeAt).toBeNull();
  });

  it('healthPath + 首选入口 会拼出探测目标（复用 Sprint 1 的解析）', async () => {
    const harness = createHarness({
      services: [
        makeServiceView({
          sourceRef: 'docker:alpha',
          healthPath: '/healthz',
          entry: 'http://127.0.0.1:8080/',
          container: { id: 'c-alpha', name: 'alpha', state: 'running', image: 'a' },
        }),
      ],
      containers: [makeContainer({ id: 'c-alpha', name: 'alpha' })],
      intervalSec: () => 60,
    });

    await harness.monitor.tick(T0);
    expect(harness.probeCalls).toEqual(['http://127.0.0.1:8080/healthz']);
    expect(harness.monitor.state('docker:alpha')?.lastProbeAt).toBe(new Date(T0).toISOString());
  });

  it('多副本里只要有一个不在 running，容器维度就是 fail（证据带容器名与状态）', async () => {
    const harness = createHarness({
      services: [
        makeServiceView({
          sourceRef: 'docker:alpha',
          container: { id: 'c-alpha-1', name: 'alpha-1', state: 'running', image: 'a' },
        }),
      ],
      containers: [
        makeContainer({ id: 'c-alpha-1', name: 'alpha-1' }),
        makeContainer({ id: 'c-alpha-2', name: 'alpha-2', state: 'exited', status: 'Exited (0)' }),
      ],
      intervalSec: () => 0,
    });

    await harness.monitor.tick(T0);
    const state = harness.monitor.state('docker:alpha');
    expect(state?.dimensions.container.state).toBe('fail');
    expect(state?.dimensions.container.detail).toContain('alpha-2 已退出（exited）');
  });

  it('docker health：unhealthy → fail；starting → unknown（不猜成功也不猜失败）', async () => {
    const harness = createHarness({
      services: [
        makeServiceView({ sourceRef: 'docker:unhealthy', container: { id: 'c-1', name: 'unhealthy', state: 'running', image: 'a' } }),
        makeServiceView({ sourceRef: 'docker:starting', container: { id: 'c-2', name: 'starting', state: 'running', image: 'a' } }),
      ],
      containers: [
        makeContainer({ id: 'c-1', name: 'unhealthy', health: 'unhealthy' }),
        makeContainer({ id: 'c-2', name: 'starting', health: 'starting' }),
      ],
      intervalSec: () => 0,
    });

    await harness.monitor.tick(T0);
    expect(harness.monitor.state('docker:unhealthy')?.dimensions.dockerHealth.state).toBe('fail');
    expect(harness.monitor.state('docker:starting')?.dimensions.dockerHealth.state).toBe('unknown');
    expect(harness.monitor.state('docker:starting')?.dimensions.dockerHealth.detail).toContain('starting');
  });

  it('没有绑定容器（纯 serve / 手工服务）时容器与 dockerHealth 都是 unknown', async () => {
    const harness = createHarness({
      services: [makeServiceView({ sourceRef: 'serve:nas:443/app', sourceType: 'serve' })],
      containers: [],
      intervalSec: () => 0,
    });

    await harness.monitor.tick(T0);
    const state = harness.monitor.state('serve:nas:443/app');
    expect(state?.dimensions.container.state).toBe('unknown');
    expect(state?.dimensions.dockerHealth.state).toBe('unknown');
    expect(state?.verdict).toBe('unknown');
  });
});

describe('健康监视器 · 失败与降级（探测失败不清空既有状态）', () => {
  it('探测失败只把 http 维判 fail，容器维度与既有状态都保留', async () => {
    const harness = createHarness({
      services: [serviceWithTarget('alpha', 'http://127.0.0.1:8080/health')],
      containers: [makeContainer({ id: 'c-alpha', name: 'alpha' })],
      intervalSec: () => 60,
    });

    await harness.monitor.tick(T0);
    const healthy = harness.monitor.state('docker:alpha');
    expect(healthy?.verdict).toBe('healthy');
    expect(healthy?.lastProbeAt).toBe(new Date(T0).toISOString());

    harness.setProbe(async () => ({ state: 'fail', statusCode: null, durationMs: 3000, detail: '探测超时（>3000ms）', at: new Date(T0).toISOString() }));
    const result = await harness.monitor.tick(T0 + 60_000);

    expect(result.failures).toBe(1);
    const failed = harness.monitor.state('docker:alpha');
    expect(failed?.verdict).toBe('degraded');
    expect(failed?.dimensions.http.state).toBe('fail');
    expect(failed?.dimensions.http.detail).toBe('探测超时（>3000ms）');
    // 既有状态没被清空：容器维度仍然 ok，身份与"上次探测时间"在
    expect(failed?.dimensions.container.state).toBe('ok');
    expect(failed?.serviceId).toBe('svc-docker:alpha');
    expect(failed?.lastProbeAt).toBe(new Date(T0 + 60_000).toISOString());
    expect(harness.monitor.states()).toHaveLength(1);
  });

  it('探测实现抛错也不崩：记为 fail 并带上异常信息', async () => {
    const harness = createHarness({
      services: [serviceWithTarget('alpha', 'http://127.0.0.1:8080/health')],
      containers: [],
      intervalSec: () => 60,
      probe: async () => {
        throw new Error('连接被拒绝');
      },
    });

    const result = await harness.monitor.tick(T0);
    expect(result.failures).toBe(1);
    expect(harness.monitor.state('docker:alpha')?.dimensions.http.detail).toContain('探测异常：连接被拒绝');
  });

  it('容器列表不可用 → 容器维度 unknown（不拿过期快照冒充现状），并在 notes 里说明降级', async () => {
    const harness = createHarness({
      services: [serviceWithTarget('alpha', 'http://127.0.0.1:8080/health')],
      containers: [makeContainer({ id: 'c-alpha', name: 'alpha' })],
      intervalSec: () => 60,
    });

    await harness.monitor.tick(T0);
    expect(harness.monitor.state('docker:alpha')?.dimensions.container.state).toBe('ok');

    harness.setContainersError('docker socket 不可用');
    await harness.monitor.tick(T0 + 3_000); // 越过 2s TTL → 真的重新取数并失败

    const state = harness.monitor.state('docker:alpha');
    expect(state?.dimensions.container.state).toBe('unknown');
    expect(state?.dimensions.dockerHealth.state).toBe('unknown');
    // http 维仍是正常探测结果 → 判定由它决定
    expect(state?.verdict).toBe('healthy');
    expect(harness.monitor.view().notes.join(' ')).toContain('容器列表不可用：docker socket 不可用');
  });

  it('服务列表取不到时不评估，也不清空已有状态', async () => {
    const harness = createHarness({
      services: [serviceWithTarget('alpha', 'http://127.0.0.1:8080/health')],
      containers: [makeContainer({ id: 'c-alpha', name: 'alpha' })],
      intervalSec: () => 60,
    });
    await harness.monitor.tick(T0);
    expect(harness.monitor.state('docker:alpha')?.verdict).toBe('healthy');

    harness.setServices(async () => {
      throw new Error('docker socket 不可用');
    });
    const result = await harness.monitor.tick(T0 + 60_000);

    expect(result.evaluated).toBe(0);
    // 既有判定保留（取数失败 ≠ 服务消失）
    expect(harness.monitor.state('docker:alpha')?.verdict).toBe('healthy');
    expect(harness.monitor.view().notes.join(' ')).toContain('服务列表不可用：docker socket 不可用');
  });
});

describe('健康监视器 · 成功读到空列表必须清理（P1 回归）', () => {
  /** viewer 视角下"还在的服务"：隐藏/删除后这个数组里就没有它了（假 registry 不自己过滤）。 */
  const alpha = serviceWithTarget('alpha', 'http://127.0.0.1:8080/health');
  const secret = makeServiceView({
    sourceRef: 'docker:secret',
    displayName: 'Secret Service',
    healthTarget: 'http://127.0.0.1:8090/health',
    container: { id: 'c-secret', name: 'secret', state: 'running', image: 'secret:latest' },
  });
  const containers = [makeContainer({ id: 'c-alpha', name: 'alpha' }), makeContainer({ id: 'c-secret', name: 'secret' })];

  it('隐藏最后一个服务后：状态与服务名一起清除，view() 里连名字都不再出现', async () => {
    const harness = createHarness({ services: [alpha, secret], containers, intervalSec: () => 60 });

    await harness.monitor.tick(T0);
    // 基线：两个服务都在，标签是用户看到的名字
    expect(harness.monitor.view().services.map((item) => item.sourceRef)).toEqual(['docker:alpha', 'docker:secret']);
    expect(harness.monitor.view().services.find((item) => item.sourceRef === 'docker:secret')?.label).toBe('Secret Service');

    // 隐藏 secret（viewer 列表里不再有它）→ 状态与名字都必须消失
    harness.setServices([alpha]);
    await harness.monitor.tick(T0 + 1_000);
    expect(harness.monitor.states().map((state) => state.sourceRef)).toEqual(['docker:alpha']);
    expect(harness.monitor.state('docker:secret')).toBeNull();
    expect(JSON.stringify(harness.monitor.view())).not.toContain('docker:secret');
    expect(JSON.stringify(harness.monitor.view())).not.toContain('Secret Service');

    // 再隐藏最后一个（成功读到空列表）→ 全部清空，旧服务名不得残留
    harness.setServices([]);
    await harness.monitor.tick(T0 + 2_000);
    expect(harness.monitor.states()).toEqual([]);
    expect(harness.monitor.view().services).toEqual([]);
    const serialized = JSON.stringify(harness.monitor.view());
    expect(serialized).not.toContain('docker:secret');
    expect(serialized).not.toContain('Secret Service');
    expect(serialized).not.toContain('docker:alpha');
    expect(harness.monitor.view().notes.join(' ')).toContain('还没有可监测的服务');

    // 之后的 tick 不会让旧状态"复活"（内存里已经没有它们的标签了）
    await harness.monitor.tick(T0 + 62_000);
    expect(harness.monitor.states()).toEqual([]);
  });

  it('删除全部服务后集合为空（区别于"读取失败"）', async () => {
    const harness = createHarness({ services: [alpha, secret], containers, intervalSec: () => 60 });
    await harness.monitor.tick(T0);
    expect(harness.monitor.states()).toHaveLength(2);

    harness.setServices([]); // 服务被删除（成功读到空列表）
    const result = await harness.monitor.tick(T0 + 60_000);
    expect(result.evaluated).toBe(0);
    expect(harness.monitor.states()).toEqual([]);
    expect(harness.monitor.view().services).toEqual([]);
    // 清理 ≠ 降级：列表读取是成功的，不该报"服务列表不可用"
    expect(harness.monitor.view().notes.join(' ')).not.toContain('服务列表不可用');
  });

  it('服务列表读取失败：旧状态与服务名都保留，并在 notes 里说明原因', async () => {
    const harness = createHarness({ services: [alpha, secret], containers, intervalSec: () => 60 });
    await harness.monitor.tick(T0);
    expect(harness.monitor.view().services).toHaveLength(2);

    harness.setServices(async () => {
      throw new Error('docker socket 不可用');
    });
    const result = await harness.monitor.tick(T0 + 60_000);

    expect(result.evaluated).toBe(0);
    // 取数失败不是"服务消失"：状态与名字都原样保留
    expect(harness.monitor.states().map((state) => state.sourceRef)).toEqual(['docker:alpha', 'docker:secret']);
    expect(harness.monitor.view().services.find((item) => item.sourceRef === 'docker:secret')?.label).toBe('Secret Service');
    expect(harness.monitor.view().notes.join(' ')).toContain('服务列表不可用：docker socket 不可用');
  });

  it('读路径纵深防御：即使 reconcile 漏清，view()/states() 也不发出不在可见集合里的状态', async () => {
    const harness = createHarness({ services: [alpha, secret], containers, intervalSec: () => 60 });
    await harness.monitor.tick(T0);
    const leaked = harness.monitor.state('docker:secret');
    expect(leaked).not.toBeNull();

    harness.setServices([alpha]);
    await harness.monitor.tick(T0 + 1_000);

    // 模拟"写路径又出问题"：绕过 dropStaleStates 直接塞回一个已不可见的状态与标签
    const internals = harness.monitor as unknown as {
      statesByRef: Map<string, ServiceHealthState>;
      labelsByRef: Map<string, { serviceId: string; label: string }>;
    };
    internals.statesByRef.set('docker:ghost', { ...(leaked as ServiceHealthState), sourceRef: 'docker:ghost' });
    internals.labelsByRef.set('docker:ghost', { serviceId: leaked?.serviceId ?? 'svc-ghost', label: 'Secret Service' });

    expect(harness.monitor.states().map((state) => state.sourceRef)).toEqual(['docker:alpha']);
    expect(harness.monitor.state('docker:ghost')).toBeNull();
    expect(JSON.stringify(harness.monitor.view())).not.toContain('docker:ghost');
    expect(JSON.stringify(harness.monitor.view())).not.toContain('Secret Service');
  });
});

describe('健康监视器 · 取数成本与视图', () => {
  it('容器列表走 2s TTL 缓存：相邻 tick 只问一次 Docker', async () => {
    const harness = createHarness({
      services: [makeServiceView({ sourceRef: 'docker:alpha' })],
      containers: [makeContainer({ id: 'c-alpha', name: 'alpha' })],
      intervalSec: () => 0,
    });

    await harness.monitor.tick(T0);
    await harness.monitor.tick(T0 + 1_000);
    expect(harness.containerListCalls()).toBe(1);

    await harness.monitor.tick(T0 + 3_000);
    expect(harness.containerListCalls()).toBe(2);
  });

  it('view() 透出阈值、探测统计与降级说明；没有服务时不允许静默为空', async () => {
    const harness = createHarness({
      services: [],
      containers: [],
      intervalSec: () => 30,
      concurrency: () => 2,
    });

    await harness.monitor.tick(T0);
    const view = harness.monitor.view();
    expect(view.thresholds).toEqual({ failThreshold: 3, okThreshold: 2 });
    expect(view.probe.intervalSec).toBe(30);
    expect(view.probe.concurrency).toBe(2);
    expect(view.probe.lastRunAt).toBe(new Date(T0).toISOString());
    expect(view.services).toEqual([]);
    expect(view.notes.join(' ')).toContain('还没有可监测的服务');
  });

  it('states() 按 sourceRef 稳定排序', async () => {
    const harness = createHarness({
      services: [
        makeServiceView({ sourceRef: 'docker:zeta' }),
        makeServiceView({ sourceRef: 'docker:alpha' }),
        makeServiceView({ sourceRef: 'docker:mid' }),
      ],
      containers: [],
      intervalSec: () => 0,
    });

    await harness.monitor.tick(T0);
    expect(harness.monitor.states().map((state) => state.sourceRef)).toEqual(['docker:alpha', 'docker:mid', 'docker:zeta']);
  });
});