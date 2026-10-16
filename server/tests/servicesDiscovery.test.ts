/**
 * 服务发现的纯函数单测（spec §7.1 的逐条覆盖）。
 *
 * 为什么这么测：Sprint 1 最容易出错的三件事 —— **身份稳定**、**入口优先级**、
 * **可达性诚实** —— 全部落在 `registry.ts` 的纯函数里。用真实拓扑形状的夹具
 * （443 `/` → 门户 8899、8443 `/calendar` → sisi-calendar 36065、8443 `/git/` → gitea 3000）
 * 逐条断言，比"起一个 Docker 再祈祷它长成那样"可靠得多。
 *
 * 仓储部分只用 `:memory:` 库，验证"用户字段不被发现覆盖"这条纪律。
 */
import { describe, expect, it } from 'vitest';
import { loadConfig, type PortalConfig } from '../src/config.js';
import { initDatabase } from '../src/db/database.js';
import { ServicesRepository } from '../src/db/services.js';
import { AuditRepository } from '../src/db/users.js';
import { createSilentLogger } from '../src/logger.js';
import type { ContainerService } from '../src/modules/docker/service.js';
import { ServiceRegistryService } from '../src/modules/services/service.js';
import type { TailscaleService } from '../src/modules/tailscale/service.js';
import {
  buildServiceEntries,
  containerServiceRef,
  dedupeEntries,
  findContainerForService,
  normalizeUrl,
  pickEntry,
  planDiscovery,
  resolveServiceStatus,
  serveRoutesForService,
  type ServiceEntry,
} from '../src/modules/services/registry.js';
import {
  PORTAL_HOST_PORT,
  TS_HOST,
  makeContainer,
  makeContainerList,
  makeHostContext,
  makePort,
  makeServeRoute,
  realTopology,
} from './support/serviceFixtures.js';

const host = makeHostContext();

describe('服务发现 · 稳定身份（S1-01）', () => {
  it('容器重建（新 ID、同 Compose 名）→ 同一 sourceRef，且不含容器 ID', () => {
    const before = realTopology({ containerIdSuffix: 'old' });
    const after = realTopology({ containerIdSuffix: 'new' });
    const calendarBefore = before.containers.find((item) => item.name === 'sisi-calendar');
    const calendarAfter = after.containers.find((item) => item.name === 'sisi-calendar');
    expect(calendarBefore?.id).not.toBe(calendarAfter?.id);

    const refBefore = containerServiceRef(calendarBefore!);
    const refAfter = containerServiceRef(calendarAfter!);
    expect(refBefore).toBe(refAfter);
    expect(refBefore).not.toContain(calendarBefore!.id);
    expect(refBefore).not.toContain('c-calendar');
  });

  it('无 Compose 标签时用规范化容器名（副本后缀被剥掉）', () => {
    expect(containerServiceRef({ name: 'sisi-calendar-1' })).toBe('docker:sisi-calendar');
    expect(containerServiceRef({ name: 'sisi-calendar_2' })).toBe('docker:sisi-calendar');
    expect(containerServiceRef({ name: 'Gitea' })).toBe('docker:gitea');
  });

  it('副本容器合并成一个服务（不会出现两张卡片）', () => {
    const replica = makeContainer({ id: 'c-1', name: 'web-1' });
    const plan = planDiscovery({
      containers: [replica, makeContainer({ id: 'c-2', name: 'web-2' })],
      serveRoutes: [],
      dockerAvailable: true,
      serveAvailable: true,
      serveDetail: null,
    });
    const web = plan.services.filter((service) => service.sourceRef === 'docker:web');
    expect(web).toHaveLength(1);
    expect(web[0]?.bindings).toHaveLength(2);
  });

  it('用户字段在重新发现后保留（仓储纪律：发现只写自动字段）', () => {
    const { db } = initDatabase({ file: ':memory:' });
    try {
      const repo = new ServicesRepository(db);
      const first = planDiscovery({
        containers: realTopology({ containerIdSuffix: 'old' }).containers,
        serveRoutes: [],
        dockerAvailable: true,
        serveAvailable: false,
        serveDetail: null,
      });
      const discovered = first.services.find((service) => service.sourceRef === 'docker:sisi-calendar');
      expect(discovered).toBeDefined();

      const id = 'svc-calendar';
      repo.insert({
        id,
        slug: repo.uniqueSlug('sisi-calendar'),
        displayName: discovered!.displayName,
        description: discovered!.description,
        icon: discovered!.icon,
        category: discovered!.category,
        sourceType: discovered!.sourceType,
        sourceRef: discovered!.sourceRef,
        bindingRefs: discovered!.bindingRefs,
        userEdited: false,
      });
      repo.replaceBindings(id, discovered!.bindings);

      // 用户改过展示属性 + 首选入口 + 收藏 + 排序
      repo.updateUserFields(
        id,
        {
          displayName: '我的日历',
          icon: 'calendar',
          category: '家庭',
          preferredUrl: 'https://family-nas.tail585599.ts.net:8443/calendar',
          favorite: true,
          sortOrder: 5,
        },
        'admin',
      );

      // 容器重建：新 ID、同 Compose 名
      const rebuilt = realTopology({ containerIdSuffix: 'new' });
      const second = planDiscovery({
        containers: rebuilt.containers,
        serveRoutes: [],
        dockerAvailable: true,
        serveAvailable: false,
        serveDetail: null,
      });
      const again = second.services.find((service) => service.sourceRef === discovered!.sourceRef);
      expect(again).toBeDefined();

      // 落库走的是"既有服务 → upsertDiscovered"这条路
      const existing = repo.findBySource(again!.sourceType, again!.sourceRef);
      expect(existing?.id).toBe(id);
      repo.upsertDiscovered(id, {
        displayName: again!.displayName,
        description: again!.description,
        icon: again!.icon,
        category: again!.category,
        bindingRefs: again!.bindingRefs,
      });
      repo.replaceBindings(id, again!.bindings);

      const after = repo.findById(id);
      expect(after?.displayName).toBe('我的日历');
      expect(after?.preferredUrl).toBe('https://family-nas.tail585599.ts.net:8443/calendar');
      expect(after?.favorite).toBe(true);
      expect(after?.sortOrder).toBe(5);
      expect(after?.userEdited).toBe(true);
      expect(repo.count()).toBe(1); // 没有新增第二行

      // 绑定快照指向新容器 ID（快照性质，不参与身份）
      expect(repo.listBindings([id])[0]?.containerId).toBe('c-calendar-new');

      // 用新 ID 也能找到实时容器（旧 ID 已失效：findContainerForService 靠名字/sourceRef 兜底）
      const calendar = rebuilt.containers.find((item) => item.name === 'sisi-calendar')!;
      const found = findContainerForService({
        sourceRef: after!.sourceRef,
        containerIds: ['c-calendar-old'],
        containerNames: ['sisi-calendar'],
        containers: rebuilt.containers,
      });
      expect(found?.id).toBe(calendar.id);
    } finally {
      db.close();
    }
  });
});

describe('服务发现 · serve 归属与门户自身（S1-01 / 验收用例）', () => {
  const { containers, serveRoutes } = realTopology();
  const plan = planDiscovery({
    containers,
    serveRoutes,
    dockerAvailable: true,
    serveAvailable: true,
    serveDetail: null,
  });

  it('三条 serve 路由都归属到容器，不产生额外的 serve 服务', () => {
    expect(plan.services.map((service) => service.sourceRef).sort()).toEqual([
      'docker:gitea',
      'docker:homeport/homeport',
      'docker:sisi-calendar',
    ]);
  });

  it('门户容器：443 `/` 归到门户服务，首选根域名 HTTPS', () => {
    const portal = plan.services.find((service) => service.sourceRef === 'docker:homeport/homeport')!;
    expect(portal.bindingRefs).toContain(`serve:${TS_HOST}:443/`);

    const container = findContainerForService({
      sourceRef: portal.sourceRef,
      containerIds: [],
      containerNames: [],
      containers,
    });
    const routes = serveRoutesForService({ bindingRefs: portal.bindingRefs, container, serveRoutes });
    const entries = buildServiceEntries({ preferredUrl: null, container, serveRoutes: routes, hostContext: host });
    const entry = pickEntry(entries);
    expect(entry?.url).toBe(`https://${TS_HOST}/`);
    expect(entry?.kind).toBe('serve');
  });

  it('日历：首选 serve `/calendar`，而不是只绑本机的 `:36065`', () => {
    const calendar = plan.services.find((service) => service.sourceRef === 'docker:sisi-calendar')!;
    const container = findContainerForService({
      sourceRef: calendar.sourceRef,
      containerIds: [],
      containerNames: [],
      containers,
    });
    const routes = serveRoutesForService({ bindingRefs: calendar.bindingRefs, container, serveRoutes });
    const entries = buildServiceEntries({ preferredUrl: null, container, serveRoutes: routes, hostContext: host });

    expect(pickEntry(entries)?.url).toBe(`https://${TS_HOST}:8443/calendar`);
    // 不可达的候选仍保留（"查看所有候选入口"要能列出它），但必须标成不可达
    const local = entries.find((entry) => entry.url.includes(':36065'));
    expect(local?.accessible).toBe(false);
    expect(local?.kind).toBe('localhost');
    expect(routes[0]?.proxy).toBe('http://127.0.0.1:36065/calendar');
  });

  it('Gitea：取 `/git/`（serve 优先级高于 tailnet 端口）', () => {
    const gitea = plan.services.find((service) => service.sourceRef === 'docker:gitea')!;
    const container = findContainerForService({ sourceRef: gitea.sourceRef, containerIds: [], containerNames: [], containers });
    const routes = serveRoutesForService({ bindingRefs: gitea.bindingRefs, container, serveRoutes });
    const entries = buildServiceEntries({ preferredUrl: null, container, serveRoutes: routes, hostContext: host });

    expect(pickEntry(entries)?.url).toBe(`https://${TS_HOST}:8443/git/`);
    // tailnet 端口仍在候选里（rank 2），只是不是首选
    expect(entries.some((entry) => entry.kind === 'tailnet')).toBe(true);
    expect(entries.map((entry) => entry.rank)).toEqual([...entries.map((entry) => entry.rank)].sort((a, b) => a - b));
  });

  it('多容器端口冲突：不做归属猜测，作为独立 serve 服务并在 notes 里说明', () => {
    const a = makeContainer({ id: 'c-a', name: 'app-a', ports: [makePort({ hostPort: 9000 })] });
    const b = makeContainer({ id: 'c-b', name: 'app-b', ports: [makePort({ hostPort: 9000 })] });
    // 关键：**故意按真实 mapper 的行为**把 owner 指到第一个匹配容器（`containers.find`）。
    // 如果夹具让 containerName 为 null，这条用例只能证明"mapper 客气时我们不猜"；
    // 真实冲突下 mapper 是会给出一个 owner 的（停掉的容器也会报告自己的端口绑定），
    // 所以这里必须给 owner，验证 registry 会**自己否决**这个不可信的归属。
    const conflict = planDiscovery({
      containers: [a, b],
      serveRoutes: [
        makeServeRoute({ path: '/conflict', targetPort: 9000, containerName: 'app-a', containerId: 'c-a' }),
      ],
      dockerAvailable: true,
      serveAvailable: true,
      serveDetail: null,
    });

    const independent = conflict.services.find((service) => service.sourceType === 'serve');
    expect(independent?.sourceRef).toBe(`serve:${TS_HOST}:8443/conflict`);
    // 既不猜 a 也不猜 b
    const aService = conflict.services.find((service) => service.sourceRef === 'docker:app-a');
    const bService = conflict.services.find((service) => service.sourceRef === 'docker:app-b');
    expect(aService?.bindingRefs).not.toContain(`serve:${TS_HOST}:8443/conflict`);
    expect(bService?.bindingRefs).not.toContain(`serve:${TS_HOST}:8443/conflict`);
    // 快照里也不许留下那个不可信的 owner（否则"下次找回关联"会一路错下去）
    expect(independent?.bindings[0]?.containerName).toBeNull();
    expect(independent?.bindings[0]?.containerId).toBeNull();
    expect(conflict.notes.join('\n')).toContain('无法确定归属');
  });

  it('serve 不可用时给出可读解释（而不是静默少几条入口）', () => {
    const withoutServe = planDiscovery({
      containers,
      serveRoutes: [],
      dockerAvailable: true,
      serveAvailable: false,
      serveDetail: 'API 模式读不到 serve 配置',
    });
    const text = withoutServe.notes.join('\n');
    expect(text).toContain('API 模式读不到 serve 配置');
    expect(text).toContain('CLI 模式');

    // 状态层也要解释清楚
    const calendar = withoutServe.services.find((service) => service.sourceRef === 'docker:sisi-calendar')!;
    const container = findContainerForService({ sourceRef: calendar.sourceRef, containerIds: [], containerNames: [], containers });
    const entries = buildServiceEntries({ preferredUrl: null, container, serveRoutes: [], hostContext: host });
    const status = resolveServiceStatus({
      sourceType: 'docker',
      container,
      entries,
      health: null,
      hasHealthTarget: false,
      dockerAvailable: true,
      serveAvailable: false,
    });
    expect(status.reasons.join('\n')).toContain('Serve 配置读不到');
  });

  it('Docker 不可达时如实说明（不是"0 个服务"了事）', () => {
    const plan = planDiscovery({
      containers: [],
      serveRoutes: [],
      dockerAvailable: false,
      serveAvailable: false,
      serveDetail: null,
    });
    expect(plan.services).toHaveLength(0);
    expect(plan.notes.join('\n')).toContain('Docker 不可达');
  });
});

describe('入口优先级与去重（S1-02）', () => {
  it('路径浅的优先，同 rank 内按 路径深度 → 端口 → URL 稳定排序', () => {
    const routes = [
      makeServeRoute({ path: '/calendar.ics', targetPort: 36065 }),
      makeServeRoute({ path: '/', port: 443, targetPort: PORTAL_HOST_PORT }),
      makeServeRoute({ path: '/calendar', targetPort: 36065 }),
    ];
    const entries = buildServiceEntries({ preferredUrl: null, container: null, serveRoutes: routes, hostContext: host });
    expect(entries.map((entry) => entry.url)).toEqual([
      `https://${TS_HOST}/`,
      `https://${TS_HOST}:8443/calendar`,
      `https://${TS_HOST}:8443/calendar.ics`,
    ]);
  });

  it('`0.0.0.0` 与 `::` 的同一映射只出现一次（去重后仍可读）', () => {
    const entries = buildServiceEntries({
      preferredUrl: null,
      container: makeContainer({
        id: 'c-dup',
        name: 'dup',
        ports: [
          makePort({ containerPort: 80, hostPort: 8080, hostIp: '0.0.0.0', url: 'http://0.0.0.0:8080/' }),
          makePort({ containerPort: 80, hostPort: 8080, hostIp: '::', url: 'http://[::]:8080/' }),
        ],
      }),
      serveRoutes: [],
      hostContext: host,
    });
    expect(entries).toHaveLength(1);
    expect(normalizeUrl('http://0.0.0.0:8080/', host)).toBe(normalizeUrl('http://[::]:8080/', host));
  });

  it('127.0.0.1 与 localhost 视为同一主机（保留优先度更高的那条）', () => {
    const raw: ServiceEntry[] = [
      { kind: 'localhost', label: '仅本机', url: 'http://localhost:8080/', rank: 4, accessible: false, detail: null },
      { kind: 'tailnet', label: 'Tailnet', url: `http://${TS_HOST}:8080/`, rank: 2, accessible: true, detail: null },
      { kind: 'localhost', label: '仅本机', url: 'http://127.0.0.1:8080/', rank: 4, accessible: false, detail: 'x' },
    ];
    const entries = dedupeEntries(raw, host);
    expect(entries.filter((entry) => entry.url.includes(':8080'))).toHaveLength(2);
    expect(entries.find((entry) => entry.rank === 2)?.url).toBe(`http://${TS_HOST}:8080/`);
  });

  it('默认端口与尾斜杠被规范化（同一入口不重复出现）', () => {
    expect(normalizeUrl('https://Example.COM:443/app/', host)).toBe('https://example.com/app');
    expect(normalizeUrl('http://example.com:80/', host)).toBe('http://example.com/');
  });

  it('用户指定的入口永远排第一（rank 0），且首选可达', () => {
    const entries = buildServiceEntries({
      preferredUrl: 'https://example.ts.net/app',
      container: makeContainer({ id: 'c', name: 'app', ports: [makePort({ hostPort: 8080 })] }),
      serveRoutes: [makeServeRoute({ path: '/app', targetPort: 8080 })],
      hostContext: host,
    });
    expect(entries[0]?.kind).toBe('user');
    expect(pickEntry(entries)?.url).toBe('https://example.ts.net/app');
  });

  it('一个可达候选都没有时 entry 为 null（"无可达入口"，但候选全保留）', () => {
    const container = makeContainer({
      id: 'c-local',
      name: 'local-only',
      reachability: 'localhost-only',
      primaryUrl: null,
      ports: [makePort({ hostPort: 3000, hostIp: '127.0.0.1', reachability: 'localhost-only', url: null })],
    });
    const entries = buildServiceEntries({ preferredUrl: null, container, serveRoutes: [], hostContext: host });
    expect(entries).toHaveLength(1);
    expect(entries.every((entry) => !entry.accessible)).toBe(true);
    expect(pickEntry(entries)).toBeNull();
  });
});

describe('三维状态（S1-05）', () => {
  const running = makeContainer({ id: 'c', name: 'app', ports: [makePort({ hostPort: 8080 })] });
  const entries = buildServiceEntries({ preferredUrl: null, container: running, serveRoutes: [], hostContext: host });

  it('容器未知时 container=absent（不是"服务挂了"）', () => {
    const status = resolveServiceStatus({
      sourceType: 'docker',
      container: null,
      entries: [],
      health: null,
      hasHealthTarget: false,
      dockerAvailable: true,
      serveAvailable: true,
    });
    expect(status.container).toBe('absent');
    expect(status.reachable).toBe(false);
    expect(status.health).toBe('skipped');
  });

  it('数据源都不可用时 reachable=null（不确定 ≠ 不可达）', () => {
    const status = resolveServiceStatus({
      sourceType: 'docker',
      container: null,
      entries: [],
      health: null,
      hasHealthTarget: false,
      dockerAvailable: false,
      serveAvailable: false,
    });
    expect(status.reachable).toBeNull();
    expect(status.reasons.join('\n')).toContain('数据源不可用');
  });

  it('只绑本机但经 Serve 可达 → reachable=true，且 reasons 说明原因', () => {
    const local = makeContainer({
      id: 'c-local',
      name: 'local',
      reachability: 'localhost-only',
      primaryUrl: null,
      ports: [makePort({ hostPort: 36065, hostIp: '127.0.0.1', reachability: 'localhost-only', url: null })],
    });
    const routes = [makeServeRoute({ path: '/calendar', targetPort: 36065 })];
    const localEntries = buildServiceEntries({ preferredUrl: null, container: local, serveRoutes: routes, hostContext: host });
    const status = resolveServiceStatus({
      sourceType: 'docker',
      container: local,
      entries: localEntries,
      health: null,
      hasHealthTarget: false,
      dockerAvailable: true,
      serveAvailable: true,
    });
    expect(status.reachable).toBe(true);
    expect(status.reasons.join('\n')).toContain('容器端口仅绑本机，经 Serve 提供 tailnet 入口');
    expect(status.reasons.join('\n')).not.toContain('局域网与 tailnet 都访问不到');
  });

  it('健康检查三维独立：skipped / unknown / fail', () => {
    const base = {
      sourceType: 'docker' as const,
      container: running,
      entries,
      dockerAvailable: true,
      serveAvailable: true,
    };
    expect(resolveServiceStatus({ ...base, health: null, hasHealthTarget: false }).health).toBe('skipped');
    expect(resolveServiceStatus({ ...base, health: null, hasHealthTarget: true }).health).toBe('unknown');
    const failed = resolveServiceStatus({
      ...base,
      health: { state: 'fail', detail: '目标返回 HTTP 500', at: '2026-10-16T00:00:00.000Z' },
      hasHealthTarget: true,
    });
    expect(failed.health).toBe('fail');
    expect(failed.reasons).toContain('目标返回 HTTP 500');
    // 容器仍在运行 → 不允许因为健康检查失败就说容器挂了
    expect(failed.container).toBe('running');
  });
});

describe('构造与发现时机（不在启动时拉数据）', () => {
  const config: PortalConfig = loadConfig({
    env: 'test',
    logLevel: 'error',
    dataDir: '.',
    dbPath: ':memory:',
    tailscale: { mode: 'off', bin: '', socket: '/nonexistent', apiToken: '', tailnet: '-', timeoutMs: 100 },
    bootstrap: { token: 'x', tokenFile: 'setup-token.txt' },
    session: { ttlHours: 1, rememberTtlHours: 1, cookieName: 'hp_session' },
    cache: { containersTtlMs: 60_000, tailscaleTtlMs: 60_000 },
  });

  function countingContainers(): { calls: () => number; containers: ContainerService } {
    let calls = 0;
    const containers = {
      list: async () => {
        calls += 1;
        return makeContainerList(realTopology().containers);
      },
    } as unknown as ContainerService;
    return { calls: () => calls, containers };
  }

  it('new ServiceRegistryService() 不发任何请求；第一次 sync 才拉数据，之后走 TTL 缓存', async () => {
    const { db } = initDatabase({ file: ':memory:' });
    try {
      const network = countingContainers();
      const registry = new ServiceRegistryService({
        containers: network.containers,
        tailscale: { getTailscaleIpv4: () => null, getTailscaleDnsName: () => null } as unknown as TailscaleService,
        repository: new ServicesRepository(db),
        audit: new AuditRepository(db),
        config,
        logger: createSilentLogger(),
      });

      // 构造期必须零请求（settings.initialize() 之前不得发请求）
      expect(network.calls()).toBe(0);

      await registry.sync();
      expect(network.calls()).toBe(1);

      // 命中 TTL 缓存 → 不再重复发现（多个客户端同时刷新不会把 docker.sock 打爆）
      await registry.sync();
      expect(network.calls()).toBe(1);

      // 显式 force 才重新发现
      await registry.sync(undefined, { force: true });
      expect(network.calls()).toBe(2);
    } finally {
      db.close();
    }
  });
});

describe('解析性能（spec §7：100 个服务 < 150ms）', () => {
  function manyContainers(count: number) {
    return Array.from({ length: count }, (_, index) =>
      makeContainer({
        id: `c-${index}`,
        name: `svc-${index}`,
        // 用 Compose 标签保证 sourceRef 唯一：容器名里的数字后缀会被规范化剥掉（副本语义）
        composeProject: 'bench',
        composeService: `svc-${index}`,
        ports: [makePort({ hostPort: 9000 + index })],
      }),
    );
  }

  function measure(count: number): { ms: number; entryCount: number } {
    const containers = manyContainers(count);
    const plan = planDiscovery({
      containers,
      serveRoutes: [],
      dockerAvailable: true,
      serveAvailable: true,
      serveDetail: null,
    });
    const byRef = new Map(containers.map((container) => [containerServiceRef(container), container]));
    const started = performance.now();
    let entryCount = 0;
    for (const service of plan.services) {
      const container = byRef.get(service.sourceRef) ?? null;
      entryCount += buildServiceEntries({ preferredUrl: null, container, serveRoutes: [], hostContext: host }).length;
    }
    return { ms: performance.now() - started, entryCount };
  }

  it('0 / 1 / 20 / 100 个服务都能算完，100 个总耗时 < 150ms', () => {
    expect(measure(0)).toMatchObject({ entryCount: 0 });
    expect(measure(1).entryCount).toBe(1);
    expect(measure(20).entryCount).toBe(20);

    const hundred = measure(100);
    expect(hundred.entryCount).toBe(100);
    expect(hundred.ms).toBeLessThan(150);
  });
});