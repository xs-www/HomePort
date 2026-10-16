/**
 * S0-05「服务入口解析」单测：Docker inspect → 门户入口契约的**纯函数**映射。
 *
 * 只测 `modules/docker/mapper.ts` 的纯计算（不构造 dockerode、不起真实 Docker）：
 * 端口可达性判定、入口 URL、多候选入口、排序、去重、serve 路由覆盖标记。
 *
 * 输入形态对齐真实 `docker inspect` 输出，例如双栈绑定确实是
 * `{"0.0.0.0":8080}` + `{"::":8080}` 两条（本机实测 cs22-web 即如此），
 * 因此这里专门覆盖「同一入口不能出现两条」。
 */
import { describe, expect, it } from 'vitest';
import type { ContainerInspectInfo } from 'dockerode';
import { loadConfig } from '../src/config.js';
import { buildHostContext, type PortalHostContext } from '../src/modules/docker/hostContext.js';
import {
  attachHostContext,
  attachServePaths,
  buildCandidates,
  collectReachableHostPorts,
  dedupeIdenticalBindings,
  mapContainer,
  mapPorts,
  mapServeRoutes,
  pickPrimaryUrl,
  rebuildPortUrls,
  type ServeRouteInput,
} from '../src/modules/docker/mapper.js';
// 兼容性守卫：这些函数原先由 service.ts 导出，re-export 必须继续可用
import { mapPorts as mapPortsFromService } from '../src/modules/docker/service.js';
import type { ContainerPortView } from '../src/modules/docker/types.js';

const TSNET_IP = '100.72.255.29';
const TSNET_V6 = 'fd7a:115c:a1e0::2101:ffb9';
const MAGICDNS = 'sisi-laptop.tail921448.ts.net';

const testConfig = loadConfig({
  env: 'test',
  publicHost: '',
  port: 8899,
  dataDir: '/tmp/hp-test',
  dbPath: ':memory:',
});

/** 用名称派生一个稳定的假容器 ID（不同容器必须不同，否则 serve 归属会串）。 */
function idFor(name: string): string {
  return `${name}-`.repeat(8).slice(0, 64);
}

/** 构造一个 inspect 结果；默认 = bridge 模式 + 与 ports 一致的 PortBindings。 */
interface InspectInput {
  name?: string;
  /** 容器 ID；缺省按名称派生，保证多容器不共用同一 ID */
  id?: string;
  /** `NetworkSettings.Ports`（实际生效的宿主绑定） */
  ports?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  /** `HostConfig.PortBindings`（声明的绑定）；缺省与 ports 相同 */
  portBindings?: Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;
  networkMode?: string;
  image?: string;
  env?: string[];
  networks?: Record<string, { IPAddress?: string }>;
}

function makeInspect(input: InspectInput = {}): ContainerInspectInfo {
  const ports = input.ports ?? {};
  const name = input.name ?? 'cs22-web';
  return {
    Id: input.id ?? idFor(name),
    Name: `/${name}`,
    Created: '2026-02-20T08:00:00Z',
    Image: 'sha256:imageid',
    State: { Status: 'running', StartedAt: '2026-02-25T06:00:00Z', FinishedAt: '0001-01-01T00:00:00Z' },
    Config: { Image: input.image ?? 'cs22-marketplace-web:local', Env: input.env ?? ['PATH=/usr/bin'], Labels: {} },
    HostConfig: {
      NetworkMode: input.networkMode ?? 'bridge',
      PortBindings: input.portBindings ?? ports,
    },
    NetworkSettings: { Ports: ports, Networks: input.networks ?? {} },
    Mounts: [],
  } as unknown as ContainerInspectInfo;
}

/** 访客从 tailnet 访问门户时的主机上下文。 */
function tailnetContext(): PortalHostContext {
  return buildHostContext({
    config: testConfig,
    request: { protocol: 'http', hostname: TSNET_IP, headers: { host: `${TSNET_IP}:8899` }, port: 8899 },
    tailscaleIpv4: TSNET_IP,
    tailscaleDnsName: MAGICDNS,
  });
}

const ctx = tailnetContext();

describe('docker/mapper · 端口可达性判定', () => {
  it('0.0.0.0 与空 HostIp 都判定为 tailnet 可达并生成入口', () => {
    const inspect = makeInspect({
      ports: {
        '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
        '81/tcp': [{ HostPort: '8081' }],
      },
    });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'cs22-web');

    expect(ports.map((port) => [port.hostIp, port.reachability])).toEqual([
      ['0.0.0.0', 'tailnet'],
      ['', 'tailnet'],
    ]);
    expect(ports.map((port) => port.url)).toEqual([
      `http://${MAGICDNS}:8080/`,
      `http://${MAGICDNS}:8081/`,
    ]);
    expect(ports.every((port) => port.note === null)).toBe(true);
  });

  it(':: 与 0.0.0.0 同一端口的双栈重复绑定去重（不出现两条入口）', () => {
    // 本机实测：docker inspect cs22-web → [{"HostIp":"0.0.0.0","HostPort":"8080"},{"HostIp":"::","HostPort":"8080"}]
    const inspect = makeInspect({
      ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }, { HostIp: '::', HostPort: '8080' }] },
    });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'cs22-web');

    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ hostIp: '0.0.0.0', hostPort: 8080, reachability: 'tailnet' });
    // 「入口」维度同样只有一条：URL 集合大小 == 可点击端口数
    const clickable = ports.filter((port) => port.url !== null);
    expect(clickable).toHaveLength(1);
    expect(new Set(clickable.map((port) => port.url)).size).toBe(1);
    expect(pickPrimaryUrl(ports)).toBe(`http://${MAGICDNS}:8080/`);
  });

  it('去重判定收窄：只合并「除 hostIp 外渲染结果完全一致」的绑定', () => {
    const binding = (over: Partial<ContainerPortView>): ContainerPortView => ({
      containerPort: 80,
      protocol: 'tcp',
      hostIp: '0.0.0.0',
      hostPort: 8080,
      reachability: 'tailnet',
      url: 'http://h:8080/',
      note: null,
      ...over,
    });

    // 双栈：除 hostIp 外全同 → 只留先出现的一条
    const dualStack = dedupeIdenticalBindings([binding({ hostIp: '0.0.0.0' }), binding({ hostIp: '::' })]);
    expect(dualStack).toHaveLength(1);
    expect(dualStack[0]?.hostIp).toBe('0.0.0.0');

    // 可达性不同 → 不合并（回环 vs 通配绑同一宿主端口是两条不同的入口）
    const mixed = dedupeIdenticalBindings([
      binding({ hostIp: '127.0.0.1', reachability: 'localhost-only', url: null, note: '仅本机' }),
      binding({ hostIp: '0.0.0.0', reachability: 'tailnet' }),
    ]);
    expect(mixed.map((entry) => entry.reachability)).toEqual(['localhost-only', 'tailnet']);

    // 容器端口不同 → 不合并（即便宿主端口相同）
    const differentContainerPort = dedupeIdenticalBindings([
      binding({ containerPort: 80 }),
      binding({ containerPort: 81, hostIp: '::' }),
    ]);
    expect(differentContainerPort.map((entry) => entry.containerPort)).toEqual([80, 81]);

    // 协议 / 宿主端口 / URL 任一不同 → 不合并
    expect(dedupeIdenticalBindings([binding({}), binding({ protocol: 'udp' })])).toHaveLength(2);
    expect(dedupeIdenticalBindings([binding({}), binding({ hostPort: 8081 })])).toHaveLength(2);
    expect(dedupeIdenticalBindings([binding({}), binding({ url: 'http://other:8080/' })])).toHaveLength(2);
    // 空列表与单条列表是恒等变换
    expect(dedupeIdenticalBindings([])).toEqual([]);
    expect(dedupeIdenticalBindings([binding({})])).toHaveLength(1);
  });

  it('回环与通配绑同一端口时判定不同，两条都保留', () => {
    const inspect = makeInspect({
      ports: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
        '81/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
      },
    });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'x');

    // 容器端口不同 ⇒ 不是一个「同一端口的重复绑定」，不去重
    expect(ports).toHaveLength(2);

    // 同协议 + 同宿主端口，但可达性不同（仅本机 / tailnet）⇒ 两条都保留
    const sameContainerPort = mapPorts(
      makeInspect({
        ports: {
          '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }, { HostIp: '0.0.0.0', HostPort: '8080' }],
        },
      }),
      ctx,
      [TSNET_IP],
      'x',
    );
    expect(sameContainerPort.map((port) => [port.hostIp, port.reachability])).toEqual([
      ['0.0.0.0', 'tailnet'],
      ['127.0.0.1', 'localhost-only'],
    ]);
    expect(sameContainerPort.filter((port) => port.url !== null)).toHaveLength(1);
  });

  it('显式绑定 tailnet IP（100.x / fd7a:…）判定为 tailnet 并使用该 IP 生成入口', () => {
    const inspect = makeInspect({
      ports: {
        '80/tcp': [{ HostIp: TSNET_IP, HostPort: '8080' }],
        '81/tcp': [{ HostIp: TSNET_V6, HostPort: '8081' }],
        // 非内置 ULA 前缀，靠宿主 tailnet 地址列表识别
        '82/tcp': [{ HostIp: 'fd7a:115c:a1e1::5', HostPort: '8082' }],
      },
    });
    const ports = mapPorts(inspect, ctx, [TSNET_IP, 'fd7a:115c:a1e1::5'], 'x');

    expect(ports.find((port) => port.hostPort === 8080)).toMatchObject({
      reachability: 'tailnet',
      url: `http://${TSNET_IP}:8080/`,
    });
    expect(ports.find((port) => port.hostPort === 8081)).toMatchObject({
      reachability: 'tailnet',
      url: `http://[${TSNET_V6}]:8081/`,
    });
    expect(ports.find((port) => port.hostPort === 8082)?.reachability).toBe('tailnet');
  });

  it('宿主 LAN IP 判定为仅局域网，入口用门户对外主机', () => {
    const inspect = makeInspect({ ports: { '80/tcp': [{ HostIp: '192.168.1.101', HostPort: '8080' }] } });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'x');

    expect(ports[0]).toMatchObject({ reachability: 'lan', url: `http://${MAGICDNS}:8080/` });
    expect(pickPrimaryUrl(ports)).toBe(`http://${MAGICDNS}:8080/`);
  });

  it('127.0.0.1 / ::1 判定为仅本机，不给可点击入口', () => {
    const inspect = makeInspect({
      ports: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '4173' }],
        '81/tcp': [{ HostIp: '::1', HostPort: '4174' }],
      },
    });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'worldforge');

    expect(ports.map((port) => port.reachability)).toEqual(['localhost-only', 'localhost-only']);
    expect(ports.every((port) => port.url === null)).toBe(true);
    expect(ports.every((port) => port.note?.includes('回环') === true)).toBe(true);

    const container = mapContainer(inspect, ctx, [TSNET_IP]);
    expect(container.reachability).toBe('localhost-only');
    expect(container.primaryUrl).toBeNull();
    // 仅本机 ⇒ 没有候选入口，前端不会显示可点击链接
    expect(buildCandidates(container.ports, ctx)).toEqual([]);
  });

  it('未发布到宿主的端口没有入口，只标注原因', () => {
    const inspect = makeInspect({ ports: { '9000/tcp': null } });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'x');

    expect(ports).toEqual([
      {
        containerPort: 9000,
        protocol: 'tcp',
        hostIp: '',
        hostPort: null,
        reachability: 'none',
        url: null,
        note: '该端口未发布到宿主，容器网络内可见',
      },
    ]);
    expect(mapContainer(inspect, ctx, [TSNET_IP]).primaryUrl).toBeNull();
  });

  it('宿主端口未分配时也没有入口', () => {
    const inspect = makeInspect({ ports: { '80/tcp': [{ HostIp: '0.0.0.0' }] } });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'x');

    expect(ports[0]).toMatchObject({ hostPort: null, reachability: 'none', url: null, note: '宿主端口未分配' });
  });

  it('排序：可达性优先（tailnet → lan → 仅本机 → 无），其次宿主端口升序', () => {
    const inspect = makeInspect({
      ports: {
        '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '9090' }],
        '81/tcp': [{ HostIp: '192.168.1.5', HostPort: '80' }],
        '82/tcp': [{ HostIp: '0.0.0.0', HostPort: '80' }],
        '83/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
        '84/tcp': null,
      },
    });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'x');

    expect(ports.map((port) => [port.reachability, port.hostPort])).toEqual([
      ['tailnet', 80],
      ['tailnet', 9090],
      ['lan', 80],
      ['localhost-only', 8080],
      ['none', null],
    ]);
  });
});

describe('docker/mapper · 多候选入口', () => {
  it('为可达端口生成 tailnet IP / MagicDNS / localhost 三个候选且去重', () => {
    const inspect = makeInspect({ ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } });
    const container = mapContainer(inspect, ctx, [TSNET_IP]);

    expect(container.primaryUrl).toBe(`http://${MAGICDNS}:8080/`);
    expect(container.urlCandidates.map((candidate) => candidate.label)).toEqual(['magicdns', 'tailnet', 'localhost']);
    expect(container.urlCandidates.map((candidate) => candidate.url)).toEqual([
      `http://${MAGICDNS}:8080/`,
      `http://${TSNET_IP}:8080/`,
      'http://localhost:8080/',
    ]);
    expect(new Set(container.urlCandidates.map((candidate) => candidate.url)).size).toBe(3);
    expect(container.urlCandidates[0]?.display).toBe('MagicDNS');
  });

  it('候选入口只跟随「可达性最优且有 URL」的那个端口', () => {
    const inspect = makeInspect({
      ports: {
        '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
        '81/tcp': [{ HostIp: '100.72.255.29', HostPort: '9090' }],
      },
    });
    const container = mapContainer(inspect, ctx, [TSNET_IP]);

    expect(container.primaryUrl).toBe(`http://${TSNET_IP}:9090/`);
    expect(container.urlCandidates.every((candidate) => candidate.url.includes(':9090'))).toBe(true);
  });

  it('缓存阶段（skipUrls）保留可达性但清空 URL，响应阶段按访问者重建', () => {
    const inspect = makeInspect({ ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } });
    const cached = mapContainer(inspect, ctx, [TSNET_IP], { skipUrls: true });
    expect(cached.reachability).toBe('tailnet');
    expect(cached.primaryUrl).toBeNull();
    expect(cached.ports.every((port) => port.url === null)).toBe(true);
    expect(cached.urlCandidates).toEqual([]);

    const served = attachHostContext([cached], ctx)[0]!;
    expect(served.primaryUrl).toBe(`http://${MAGICDNS}:8080/`);
    expect(served.urlCandidates.map((candidate) => candidate.url)).toContain(`http://${TSNET_IP}:8080/`);
    // 单端口重建：跳过 URL 的缓存条目也能恢复入口
    expect(rebuildPortUrls(cached.ports[0]!, ctx, cached.name).url).toBe(`http://${MAGICDNS}:8080/`);
  });
});

describe('docker/mapper · tailscale serve 路径级路由', () => {
  const routes: ServeRouteInput[] = [
    {
      host: MAGICDNS,
      port: 443,
      scheme: 'https',
      path: '/worldforge',
      url: `https://${MAGICDNS}/worldforge`,
      proxy: 'http://127.0.0.1:4173',
      targetHost: '127.0.0.1',
      targetPort: 4173,
    },
    {
      host: MAGICDNS,
      port: 443,
      scheme: 'https',
      path: '/dsh',
      url: `https://${MAGICDNS}/dsh`,
      proxy: 'http://127.0.0.1:3081',
      targetHost: '127.0.0.1',
      targetPort: 3081,
    },
  ];

  /** 4173 已发布到宿主（可达），3081 只绑回环（靠 serve 才可达）。 */
  const worldforge = mapContainer(
    makeInspect({ name: 'worldforge', ports: { '4173/tcp': [{ HostIp: '0.0.0.0', HostPort: '4173' }] } }),
    ctx,
    [TSNET_IP],
  );
  const dsh = mapContainer(
    makeInspect({ name: 'dsh', ports: { '3081/tcp': [{ HostIp: '127.0.0.1', HostPort: '3081' }] } }),
    ctx,
    [TSNET_IP],
  );

  it('目标端口已被容器端口覆盖时标记 coveredByContainerPort（不重复列入口）', () => {
    const view = mapServeRoutes(routes, [worldforge, dsh]);
    const covered = view.find((route) => route.path === '/worldforge');

    expect(covered).toMatchObject({
      coveredByContainerPort: true,
      containerName: 'worldforge',
      containerId: worldforge.id,
      targetPort: 4173,
      url: `https://${MAGICDNS}/worldforge`,
    });
    // UI 只列未被覆盖的路由 ⇒ 4173 不会出现第二次
    expect(view.filter((route) => !route.coveredByContainerPort).map((route) => route.path)).toEqual(['/dsh']);
  });

  it('仅绑回环的目标端口未被覆盖，作为独立入口出现', () => {
    const view = mapServeRoutes(routes, [worldforge, dsh]);
    const independent = view.find((route) => route.path === '/dsh');

    expect(independent).toMatchObject({
      coveredByContainerPort: false,
      containerName: 'dsh',
      containerId: dsh.id,
      url: `https://${MAGICDNS}/dsh`,
    });
    // 只绑 127.0.0.1 的端口不算「已展示的可达端口」
    expect(collectReachableHostPorts([worldforge, dsh])).toEqual(new Set([4173]));
  });

  it('目标端口匹配不到容器时仍作为独立入口，且不带容器归属', () => {
    const view = mapServeRoutes(
      [
        {
          host: MAGICDNS,
          port: 8443,
          scheme: 'https',
          path: '/external',
          url: `https://${MAGICDNS}:8443/external`,
          proxy: 'http://127.0.0.1:5000',
          targetHost: '127.0.0.1',
          targetPort: 5000,
        },
      ],
      [worldforge],
    );

    expect(view[0]).toMatchObject({ coveredByContainerPort: false, containerName: null, containerId: null });
  });

  it('没有代理目标（targetPort 为 null）时不参与覆盖判定', () => {
    const view = mapServeRoutes(
      [
        {
          host: MAGICDNS,
          port: 443,
          scheme: 'https',
          path: '/',
          url: `https://${MAGICDNS}/`,
          proxy: 'http://127.0.0.1:443/',
          targetHost: '127.0.0.1',
          targetPort: null,
        },
      ],
      [worldforge],
    );

    expect(view[0]?.coveredByContainerPort).toBe(false);
    expect(view[0]?.containerId).toBeNull();
  });

  it('serve 路径回填到对应容器（卡片标记用）', () => {
    const items = attachServePaths([worldforge, dsh], mapServeRoutes(routes, [worldforge, dsh]));

    expect(items[0]).toMatchObject({ servePaths: ['/worldforge'], servedUrl: `https://${MAGICDNS}/worldforge` });
    expect(items[1]).toMatchObject({ servePaths: ['/dsh'], servedUrl: `https://${MAGICDNS}/dsh` });
  });

  it('没有 serve 路由的容器清空标记', () => {
    const other = mapContainer(makeInspect({ name: 'cs22-web', ports: {} }), ctx, []);
    const items = attachServePaths([other], mapServeRoutes(routes, [other, worldforge, dsh]));

    expect(items[0]).toMatchObject({ servePaths: [], servedUrl: null });
  });
});

describe('docker/mapper · 边界输入', () => {
  it('空端口列表 → 无端口、无可达性、无入口', () => {
    const container = mapContainer(makeInspect({ ports: {} }), ctx, [TSNET_IP]);

    expect(container.ports).toEqual([]);
    expect(container.reachability).toBe('none');
    expect(container.primaryUrl).toBeNull();
    expect(container.urlCandidates).toEqual([]);
  });

  it('非法或缺字段的端口键被跳过而不是抛错', () => {
    const inspect = makeInspect({
      ports: {
        'abc/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
        '0/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
        '70000/tcp': null,
        '443': [{ HostIp: '0.0.0.0', HostPort: '8443' }],
      },
    });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'x');

    // 只有合法的 `443`（缺协议时默认 tcp）留下
    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ containerPort: 443, protocol: 'tcp', reachability: 'tailnet', url: `http://${MAGICDNS}:8443/` });
  });

  it('HostConfig.PortBindings 缺失时回退到声明值', () => {
    const inspect = makeInspect({ ports: {}, portBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } });
    const ports = mapPorts(inspect, ctx, [TSNET_IP], 'x');

    expect(ports).toHaveLength(1);
    expect(ports[0]).toMatchObject({ containerPort: 80, hostPort: 8080, reachability: 'tailnet' });
  });

  it('network mode = host 时没有端口映射，容器无入口', () => {
    const inspect = makeInspect({ networkMode: 'host', ports: {} });
    const container = mapContainer(inspect, ctx, [TSNET_IP]);

    expect(container.ports).toEqual([]);
    expect(container.reachability).toBe('none');
    expect(container.primaryUrl).toBeNull();
    expect(container.urlCandidates).toEqual([]);
  });
});

describe('docker/mapper · service.ts 兼容性', () => {
  it('service.ts 仍 re-export 映射函数（旧调用方不受拆分影响）', () => {
    expect(mapPortsFromService).toBe(mapPorts);
  });
});