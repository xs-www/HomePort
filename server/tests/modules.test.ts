/**
 * 模块级单测：Docker 数据映射、tailnet 映射、nvidia-smi 解析、工具目录。
 *
 * 这些是「外部数据 → 门户契约」的转换层，用固定的输入快照验证输出，
 * 保证改动映射逻辑时不会悄悄破坏前端依赖的字段。
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  computeCpuPercent,
  endpointMode,
  normalizeNamedPipe,
  normalizeStats,
  resolveDockerEndpoint,
  describeDockerError,
  isNotFound,
  mapWithConcurrency,
} from '../src/modules/docker/provider.js';
import { buildCandidates, cleanName, detectTailscaleSidecar, joinCommand, mapContainer, mapNetworks, mapPorts, normalizeCommandList, pickPrimaryUrl, summarize } from '../src/modules/docker/service.js';
import { buildHostContext, portalUrl, splitHostPort } from '../src/modules/docker/hostContext.js';
import { mapCliPeer, mapCliStatus, splitIps, summarizePeers, unavailableStatus, withSocket, mapApiDevices } from '../src/modules/tailscale/provider.js';
import {
  describeFsType,
  diskPercent,
  parseNvidiaSmiCsv,
  parseNvidiaSmiProcesses,
  parseNvidiaSmiUuids,
} from '../src/modules/system/provider.js';
import { buildMetricsFrame, collectWarnings, hasDegradedSource } from '../src/modules/system/service.helpers.js';
import { BUILTIN_TOOLS, normalizeTool, parseExtraTools } from '../src/modules/tools/catalog.js';
import { buildToolUrls } from '../src/modules/tools/service.js';
import { loadConfig, parseMounts } from '../src/config.js';
import type { ContainerSummary, ContainerPortView } from '../src/modules/docker/types.js';
import type { SystemSnapshot } from '../src/modules/system/types.js';

const testConfig = loadConfig({
  env: 'test',
  publicHost: '',
  port: 8899,
  dataDir: '/tmp/hp-test',
  dbPath: ':memory:',
});

describe('config · 环境变量解析', () => {
  it('解析磁盘挂载点语法（含标签与 statfs 路径）', () => {
    const mounts = parseMounts('C:=/host/disk/C,D:=/host/disk/D|数据盘,/volume1=/host/volume1|存储池1|/host/volume1');
    expect(mounts).toHaveLength(3);
    expect(mounts[0]).toMatchObject({ path: 'C:', containerPath: '/host/disk/C', label: 'C', statPath: '/host/disk/C' });
    expect(mounts[1]).toMatchObject({ label: '数据盘' });
    expect(mounts[2]).toMatchObject({ label: '存储池1', statPath: '/host/volume1' });
  });

  it('挂载点语法非法时抛错', () => {
    expect(() => parseMounts('onlypath')).toThrow();
    expect(() => parseMounts('=/host/x')).toThrow();
  });

  it('默认配置含有合理默认值', () => {
    expect(testConfig.port).toBe(8899);
    expect(testConfig.session.cookieName).toBe('hp_session');
    expect(loadConfig().bootstrap.tokenFile.endsWith('setup-token.txt')).toBe(true);
    // 默认 webDistDir 应指向**仓库根**的 web/dist（而不是 server 包内）。
    // 这里刻意只断言相对结构，不断言仓库目录名 —— 目录名历史上叫 HomePage、
    // 现已改名 HomePort，断言目录名会让"改名"这种无关改动把测试打红。
    const webDist = loadConfig().webDistDir;
    expect(path.isAbsolute(webDist)).toBe(true);
    expect(path.basename(webDist)).toBe('dist');
    expect(path.basename(path.dirname(webDist))).toBe('web');
  });
});

describe('docker/provider · endpoint 解析', () => {
  it('归一化 named pipe 路径为 UNC 形式', () => {
    expect(normalizeNamedPipe('////./pipe/dockerDesktopLinuxEngine')).toBe('//./pipe/dockerDesktopLinuxEngine');
    expect(normalizeNamedPipe('//./pipe/x')).toBe('//./pipe/x');
    expect(normalizeNamedPipe('\\\\pipe\\x')).toBe('//pipe/x');
  });

  it('解析各类 endpoint 描述', () => {
    expect(resolveDockerEndpoint('npipe:////./pipe/dockerDesktopLinuxEngine')).toEqual({
      socketPath: '//./pipe/dockerDesktopLinuxEngine',
    });
    expect(resolveDockerEndpoint('unix:///var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(resolveDockerEndpoint('/var/run/docker.sock')).toEqual({ socketPath: '/var/run/docker.sock' });
    expect(resolveDockerEndpoint('tcp://1.2.3.4:2375')).toEqual({ host: '1.2.3.4', port: 2375, protocol: 'http' });
    expect(resolveDockerEndpoint('https://h:2376')).toEqual({ host: 'h', port: 2376, protocol: 'https' });
    expect(resolveDockerEndpoint('tcp://h')).toEqual({ host: 'h', port: 2375, protocol: 'http' });
  });

  it('推导模式名', () => {
    expect(endpointMode(resolveDockerEndpoint('npipe:////./pipe/x'))).toBe('npipe');
    expect(endpointMode(resolveDockerEndpoint('/var/run/docker.sock'))).toBe('socket');
    expect(endpointMode(resolveDockerEndpoint('https://h:2376'))).toBe('tcp+tls');
  });

  it('把错误翻译成可展示的中文原因', () => {
    expect(describeDockerError({ code: 'ENOENT' })).toContain('无法连接 Docker 守护进程');
    expect(describeDockerError({ statusCode: 403 })).toContain('拒绝访问');
    expect(describeDockerError({ statusCode: 404 })).toContain('不存在');
    expect(describeDockerError({ message: 'custom' })).toBe('custom');
  });

  it('识别 404', () => {
    expect(isNotFound({ statusCode: 404 })).toBe(true);
    expect(isNotFound({ statusCode: 500 })).toBe(false);
    expect(isNotFound(null)).toBe(false);
  });
});

describe('docker/provider · stats 归一化', () => {
  it('按 Docker 官方公式计算 CPU 百分比', () => {
    const stats = {
      cpu_stats: { cpu_usage: { total_usage: 300 }, system_cpu_usage: 2000, online_cpus: 4 },
      precpu_stats: { cpu_usage: { total_usage: 100 }, system_cpu_usage: 1000 },
    };
    // (200/1000) * 4 * 100 = 80
    expect(computeCpuPercent(stats)).toBeCloseTo(80);
  });

  it('系统增量非正时返回 null', () => {
    expect(
      computeCpuPercent({
        cpu_stats: { cpu_usage: { total_usage: 10 }, system_cpu_usage: 100 },
        precpu_stats: { cpu_usage: { total_usage: 5 }, system_cpu_usage: 100 },
      }),
    ).toBeNull();
  });

  it('内存扣除 inactive_file，网络与块设备求和', () => {
    const normalized = normalizeStats({
      memory_stats: { usage: 1000, limit: 2000, stats: { inactive_file: 200 } },
      networks: { eth0: { rx_bytes: 100, tx_bytes: 200 }, eth1: { rx_bytes: 50, tx_bytes: 60 } },
      blkio_stats: {
        io_service_bytes_recursive: [
          { op: 'Read', value: 10 },
          { op: 'Write', value: 20 },
          { op: 'Sync', value: 5 },
        ],
      },
      pids_stats: { current: 7 },
    });
    expect(normalized.memUsedBytes).toBe(800);
    expect(normalized.memLimitBytes).toBe(2000);
    expect(normalized.netRxBytes).toBe(150);
    expect(normalized.netTxBytes).toBe(260);
    expect(normalized.blockReadBytes).toBe(10);
    expect(normalized.blockWriteBytes).toBe(20);
    expect(normalized.pids).toBe(7);
  });

  it('limit 为 0 时视为未知（避免除零）', () => {
    expect(normalizeStats({ memory_stats: { usage: 100, limit: 0 } }).memLimitBytes).toBeNull();
  });
});

describe('docker/provider · 有限并发 map', () => {
  it('保持结果顺序且限制并发', async () => {
    let active = 0;
    let peak = 0;
    const results = await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item * 2;
    });
    expect(results).toEqual([2, 4, 6, 8, 10, 12]);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('空数组直接返回', async () => {
    expect(await mapWithConcurrency([], 4, async (x: number) => x)).toEqual([]);
  });
});

describe('docker/service · 容器映射', () => {
  /** 一个简化的单容器 inspect 结果。 */
  const inspect = (overrides: Record<string, unknown> = {}): never =>
    ({
      Id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      Name: '/cs22-web',
      Created: '2026-02-20T08:00:00Z',
      Image: 'sha256:imageid',
      State: { Status: 'running', StartedAt: '2026-02-25T06:00:00Z', FinishedAt: '0001-01-01T00:00:00Z', Health: { Status: 'healthy' } },
      Config: {
        Image: 'cs22-marketplace-web:local',
        Labels: {
          'com.docker.compose.project': 'cs22-marketplace',
          'com.docker.compose.service': 'web',
          'com.docker.compose.project.working_dir': '/opt/cs22',
        },
        Env: ['PATH=/usr/bin', 'DB_PASSWORD=s3cr3t'],
        Cmd: ['nginx', '-g', 'daemon off;'],
        Entrypoint: '/docker-entrypoint.sh',
        Tty: false,
        WorkingDir: '/app',
        User: 'node',
        Healthcheck: { Test: ['CMD', 'true'] },
      },
      HostConfig: {
        PortBindings: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] },
        RestartPolicy: { Name: 'unless-stopped' },
        NetworkMode: 'cs22-marketplace_default',
        Privileged: false,
      },
      NetworkSettings: {
        Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }], '9000/tcp': null },
        Networks: { cs22_marketplace_default: { IPAddress: '172.18.0.2', Aliases: ['web'] } },
      },
      Mounts: [
        { Type: 'bind', Source: '/opt/cs22/html', Destination: '/usr/share/nginx/html', RW: true },
        { Type: 'volume', Source: 'vol', Destination: '/data', RW: false },
      ],
      Platform: 'linux',
      ...overrides,
    }) as never;

  const hostContext = buildHostContext({
    config: testConfig,
    request: { protocol: 'http', hostname: '100.72.255.29', headers: { host: '100.72.255.29:8899' }, port: 8899 },
    tailscaleIpv4: '100.72.255.29',
    tailscaleDnsName: 'sisi-laptop.tail921448.ts.net',
  });

  it('映射容器基础字段与 compose 标签', () => {
    const container = mapContainer(inspect(), hostContext, ['100.72.255.29']);
    expect(container.name).toBe('cs22-web');
    expect(container.shortId).toBe('a1b2c3d4e5f6');
    expect(container.state).toBe('running');
    expect(container.health).toBe('healthy');
    expect(container.composeProject).toBe('cs22-marketplace');
    expect(container.composeService).toBe('web');
    expect(container.createdAt).toBe('2026-02-20T08:00:00.000Z');
    expect(container.finishedAt).toBeNull();
  });

  it('0.0.0.0 绑定 → tailnet 可达并生成 MagicDNS 首选入口', () => {
    const container = mapContainer(inspect(), hostContext, ['100.72.255.29']);
    const port = container.ports.find((p) => p.hostPort === 8080);
    expect(port?.reachability).toBe('tailnet');
    expect(port?.url).toBe('http://sisi-laptop.tail921448.ts.net:8080/');
    // 未发布的 9000 端口只标注不可用
    const unpublished = container.ports.find((p) => p.containerPort === 9000);
    expect(unpublished?.reachability).toBe('none');
    expect(unpublished?.url).toBeNull();
  });

  it('回环绑定 → 仅本机且给出提示', () => {
    const local = inspect({
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] } },
      NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }] }, Networks: {} },
    });
    const container = mapContainer(local, hostContext, []);
    expect(container.reachability).toBe('localhost-only');
    expect(container.primaryUrl).toBeNull();
    expect(container.ports[0]?.note).toContain('回环');
  });

  it('显式绑定 tailnet IP → tailnet 可达且入口使用该 IP', () => {
    const bound = inspect({
      HostConfig: { PortBindings: { '80/tcp': [{ HostIp: '100.72.255.29', HostPort: '8080' }] } },
      NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '100.72.255.29', HostPort: '8080' }] }, Networks: {} },
    });
    const container = mapContainer(bound, hostContext, ['100.72.255.29']);
    expect(container.ports[0]?.reachability).toBe('tailnet');
    expect(container.primaryUrl).toBe('http://100.72.255.29:8080/');
  });

  it('挂载与环境变量被正确映射（环境变量此处不脱敏，脱敏在 service 层）', () => {
    const container = mapContainer(inspect(), hostContext, []);
    expect(container.mounts).toHaveLength(2);
    expect(container.mounts[0]).toMatchObject({ type: 'bind', destination: '/usr/share/nginx/html', readOnly: false });
    expect(container.mounts[1]?.readOnly).toBe(true);
    expect(container.networks[0]).toMatchObject({ name: 'cs22_marketplace_default', ipv4: '172.18.0.2' });
  });

  it('缓存阶段（skipUrls）保留可达性但清空 URL', () => {
    const container = mapContainer(inspect(), hostContext, ['100.72.255.29'], { skipUrls: true });
    expect(container.reachability).toBe('tailnet');
    expect(container.primaryUrl).toBeNull();
    expect(container.ports.every((p) => p.url === null)).toBe(true);
    expect(container.urlCandidates).toEqual([]);
  });

  it('识别 tailscale sidecar（镜像名或 TS_* 环境变量）', () => {
    expect(detectTailscaleSidecar(inspect({ Config: { Image: 'tailscale/tailscale:latest' } }))).toBe(true);
    expect(detectTailscaleSidecar(inspect({ Config: { Image: 'x', Env: ['TS_AUTHKEY=abc'] } }))).toBe(true);
    expect(detectTailscaleSidecar(inspect({ Config: { Image: 'nginx', Env: ['PATH=/bin'] } }))).toBe(false);
  });

  it('拼接命令并规范化字符串形式 Entrypoint', () => {
    expect(joinCommand(['nginx', '-g', 'daemon off;'])).toBe('nginx -g daemon off;');
    expect(joinCommand([])).toBeNull();
    expect(joinCommand(undefined)).toBeNull();
    expect(normalizeCommandList('/entry.sh')).toEqual(['/entry.sh']);
    expect(normalizeCommandList(['a', 'b'])).toEqual(['a', 'b']);
    expect(normalizeCommandList(undefined)).toBeNull();
  });

  it('清洗容器名前导斜杠', () => {
    expect(cleanName('/foo')).toBe('foo');
    expect(cleanName(undefined)).toBe('');
  });

  it('汇总统计按「容器整体可达性」分级，而不是按端口数量重复计数', () => {
    const base: ContainerSummary = {
      id: 'x',
      shortId: 'x',
      name: 'n',
      image: 'i',
      imageId: null,
      state: 'running',
      status: 'running',
      health: null,
      createdAt: null,
      startedAt: null,
      finishedAt: null,
      composeProject: null,
      composeService: null,
      composeWorkingDir: null,
      labels: {},
      networks: [],
      mounts: [],
      reachability: 'tailnet',
      primaryUrl: 'http://x/',
      ports: [],
      urlCandidates: [],
      tailscaleSidecar: false,
      servePaths: [],
      servedUrl: null,
      stats: null,
    };
    const summary = summarize([
      { ...base, id: 'a', reachability: 'tailnet' },
      { ...base, id: 'b', reachability: 'lan' },
      { ...base, id: 'c', reachability: 'localhost-only' },
      { ...base, id: 'd', reachability: 'none' },
      { ...base, id: 'e', reachability: 'tailnet', state: 'exited' },
      { ...base, id: 'f', reachability: 'tailnet', health: 'unhealthy' },
    ]);
    expect(summary.total).toBe(6);
    expect(summary.running).toBe(5);
    expect(summary.stopped).toBe(1);
    // 每个容器只计入一次：tailnet 3（a/e/f）、lan 1、仅本机 1、无入口 1
    expect(summary.tailnetReachable).toBe(3);
    expect(summary.lanReachable).toBe(1);
    expect(summary.localhostOnly).toBe(1);
    // 不可达(d) + 已停止(e) + 不健康(f)
    expect(summary.attention).toBe(3);
  });

  it('首选入口按可达性排序取最优', () => {
    const ports: ContainerPortView[] = [
      { containerPort: 1, protocol: 'tcp', hostIp: '192.168.1.1', hostPort: 1, reachability: 'lan', url: 'http://lan/', note: null },
      { containerPort: 2, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 2, reachability: 'tailnet', url: 'http://ts/', note: null },
      { containerPort: 3, protocol: 'udp', hostIp: '0.0.0.0', hostPort: 3, reachability: 'none', url: null, note: null },
    ];
    expect(pickPrimaryUrl(ports)).toBe('http://ts/');
    const candidates = buildCandidates(ports, hostContext);
    // tailnet 端口上的 host 候选
    expect(candidates.some((c) => c.label === 'tailnet')).toBe(true);
    expect(candidates.some((c) => c.label === 'localhost')).toBe(true);
  });

  it('UDP 端口不生成 HTTP 入口', () => {
    const udp = inspect({
      HostConfig: { PortBindings: { '53/udp': [{ HostIp: '0.0.0.0', HostPort: '53' }] } },
      NetworkSettings: { Ports: { '53/udp': [{ HostIp: '0.0.0.0', HostPort: '53' }] }, Networks: {} },
    });
    const container = mapContainer(udp, hostContext, []);
    expect(container.ports[0]?.reachability).toBe('tailnet');
    expect(container.ports[0]?.url).toBeNull();
    expect(container.primaryUrl).toBeNull();
  });

  it('网络别名为非数组时不抛错', () => {
    const weird = inspect({ NetworkSettings: { Ports: {}, Networks: { net: { IPAddress: '', Aliases: null } } } });
    expect(mapNetworks(weird)[0]).toMatchObject({ name: 'net', ipv4: null, aliases: [] });
  });
});

describe('docker/hostContext · 主机上下文', () => {
  it('解析 Host 头（含 IPv6 与缺省端口）', () => {
    expect(splitHostPort('example.com:8080', 80)).toEqual({ host: 'example.com', port: 8080 });
    expect(splitHostPort('example.com', 80)).toEqual({ host: 'example.com', port: 80 });
    expect(splitHostPort('[fd7a::1]:8080', 80)).toEqual({ host: 'fd7a::1', port: 8080 });
    expect(splitHostPort(undefined, 80)).toEqual({ host: '', port: 80 });
  });

  it('候选主机按优先级排列且去重', () => {
    const ctx = buildHostContext({
      config: testConfig,
      request: { protocol: 'http', hostname: '10.0.0.5', headers: { host: '10.0.0.5:8899' }, port: 8899 },
      tailscaleIpv4: '100.72.255.29',
      tailscaleDnsName: 'sisi-laptop.tail921448.ts.net',
    });
    expect(ctx.candidates.map((c) => c.label)).toEqual(['magicdns', 'tailnet', 'lan', 'localhost']);
    expect(ctx.primaryHost).toBe('sisi-laptop.tail921448.ts.net');
  });

  it('配置了公开主机时优先使用它', () => {
    const ctx = buildHostContext({
      config: loadConfig({ env: 'test', publicHost: 'portal.example.com', dataDir: '/tmp/x', dbPath: ':memory:' }),
      request: { protocol: 'http', hostname: '10.0.0.5', headers: { host: '10.0.0.5:8899' }, port: 8899 },
      tailscaleIpv4: null,
      tailscaleDnsName: null,
    });
    expect(ctx.primaryHost).toBe('portal.example.com');
  });

  it('无 tailnet 信息时回退到访问者主机', () => {
    const ctx = buildHostContext({
      config: testConfig,
      request: { protocol: 'http', hostname: '10.0.0.5', headers: { host: '10.0.0.5:8899' }, port: 8899 },
      tailscaleIpv4: null,
      tailscaleDnsName: null,
    });
    expect(ctx.primaryHost).toBe('10.0.0.5');
  });

  it('组装门户 URL 时省略默认端口', () => {
    const ctx = buildHostContext({
      config: testConfig,
      request: { protocol: 'http', hostname: 'h', headers: { host: 'h:80' }, port: 80 },
      tailscaleIpv4: null,
      tailscaleDnsName: null,
    });
    expect(portalUrl(ctx, 'h', 80)).toBe('http://h');
    expect(portalUrl(ctx, 'h', 8899)).toBe('http://h:8899');
  });
});

describe('tailscale/provider · 设备映射', () => {
  it('分离 v4/v6 地址', () => {
    expect(splitIps(['fd7a::1', '100.72.255.29'])).toEqual({ ipv4: '100.72.255.29', ipv6: 'fd7a::1' });
    expect(splitIps(undefined)).toEqual({ ipv4: null, ipv6: null });
  });

  it('在线且有 CurAddr → 直连；仅 Relay → 中继；离线 → idle', () => {
    expect(mapCliPeer({ Online: true, CurAddr: '1.2.3.4:5', Relay: 'syd' }).connection).toBe('direct');
    expect(mapCliPeer({ Online: true, CurAddr: '', Relay: 'syd' }).connection).toBe('relay');
    expect(mapCliPeer({ Online: false, Relay: 'syd' }).connection).toBe('idle');
    expect(mapCliPeer({ Online: true }).connection).toBe('idle');
  });

  it('映射 CLI 状态：自身来自 Self，peer 单独列表并排序', () => {
    const status = mapCliStatus({
      BackendState: 'Running',
      Self: { ID: 'self', HostName: 'Sisi-Laptop', DNSName: 'sisi-laptop.tail921448.ts.net.', Online: true, TailscaleIPs: ['100.72.255.29'] },
      Peer: {
        a: { ID: 'a', HostName: 'offline-mac', Online: false },
        b: { ID: 'b', HostName: 'online-win', Online: true, OS: 'windows', CurAddr: '1.2.3.4:5' },
      },
      CurrentTailnet: { MagicDNSSuffix: 'tail921448.ts.net', Name: 'me@example.com' },
    });
    expect(status.self?.hostname).toBe('Sisi-Laptop');
    expect(status.self?.isSelf).toBe(true);
    expect(status.self?.dnsName).toBe('sisi-laptop.tail921448.ts.net');
    expect(status.peers).toHaveLength(2);
    // 在线设备排前面
    expect(status.peers[0]?.hostname).toBe('online-win');
    expect(status.summary).toEqual({ peersTotal: 2, peersOnline: 1, peersOffline: 1 });
    expect(status.tailnet.magicDnsSuffix).toBe('tail921448.ts.net');
    expect(status.source.available).toBe(true);
  });

  it('缺少 CurrentTailnet 时由自身 DNS 名推导 tailnet', () => {
    const status = mapCliStatus({
      Self: { HostName: 'h', DNSName: 'h.tail123.ts.net.', Online: true },
      Peer: {},
    });
    expect(status.tailnet.magicDnsSuffix).toBe('tail123.ts.net');
  });

  it('汇总与不可用状态', () => {
    const peers = [mapCliPeer({ Online: true }), mapCliPeer({ Online: false })];
    expect(summarizePeers(peers)).toEqual({ peersTotal: 2, peersOnline: 1, peersOffline: 1 });
    const unavailable = unavailableStatus('cli', '未找到可执行文件');
    expect(unavailable.source).toEqual({ available: false, mode: 'cli', detail: '未找到可执行文件' });
    expect(unavailable.peers).toEqual([]);
  });

  it('API 设备映射并标记本机', () => {
    const status = mapApiDevices(
      [
        { id: '1', hostname: 'Sisi-Laptop', name: 'sisi-laptop.tail.ts.net', addresses: ['100.1.1.1'], os: 'windows', connectedToControl: true },
        { id: '2', hostname: 'nas', name: 'nas.tail.ts.net', addresses: ['100.1.1.2'], os: 'linux', connectedToControl: false },
      ],
      'sisi-laptop',
    );
    expect(status.self?.id).toBe('1');
    expect(status.self?.isSelf).toBe(true);
    expect(status.peers).toHaveLength(1);
    expect(status.peers[0]?.hostname).toBe('nas');
    expect(status.source.mode).toBe('api');
  });

  it('自定义 socket 时把 --socket 插到子命令之前（全局 flag）', () => {
    // 默认路径 → 不插入参数
    expect(withSocket(['status', '--json'], '/var/run/tailscale/tailscaled.sock')).toEqual(['status', '--json']);
    // 非默认路径 → --socket 必须在子命令**之前**，否则 tailscale 报
    // "flag provided but not defined: -socket"（实测确认）
    expect(withSocket(['status', '--json'], '/custom.sock')).toEqual(['--socket', '/custom.sock', 'status', '--json']);
    expect(withSocket(['serve', 'status', '--json'], '/custom.sock')).toEqual([
      '--socket',
      '/custom.sock',
      'serve',
      'status',
      '--json',
    ]);
  });
});

describe('system/provider · nvidia-smi 解析', () => {
  it('解析 GPU CSV（含 [N/A] 与 MiB → 字节）', () => {
    const csv = [
      '0, NVIDIA GeForce RTX 4060 Laptop GPU, 19, 532, 8188, 39, 22.50, 90.00, 30',
      '1, NVIDIA RTX A4000, [N/A], 100, 16376, 45, [N/A], 140.00, [Not Supported]',
    ].join('\n');
    const gpus = parseNvidiaSmiCsv(csv);
    expect(gpus).toHaveLength(2);
    expect(gpus[0]).toMatchObject({
      index: 0,
      name: 'NVIDIA GeForce RTX 4060 Laptop GPU',
      percent: 19,
      temperatureC: 39,
      powerWatts: 22.5,
      fanPercent: 30,
    });
    expect(gpus[0]?.memoryUsedBytes).toBe(532 * 1024 * 1024);
    expect(gpus[1]?.percent).toBeNull();
    expect(gpus[1]?.fanPercent).toBeNull();
  });

  it('忽略无法解析的行', () => {
    expect(parseNvidiaSmiCsv('garbage line\n\n')).toEqual([]);
  });

  it('解析进程与 UUID 映射', () => {
    const processes = parseNvidiaSmiProcesses('GPU-abc, 1234, ollama, 800\nGPU-abc, 5678, python, 200');
    expect(processes.get('GPU-abc')).toHaveLength(2);
    expect(processes.get('GPU-abc')?.[0]).toMatchObject({ pid: 1234, name: 'ollama', memoryUsedBytes: 800 * 1024 * 1024 });

    const uuids = parseNvidiaSmiUuids('0, GPU-abc\n1, GPU-def');
    expect(uuids.get(0)).toBe('GPU-abc');
    expect(uuids.get(1)).toBe('GPU-def');
  });

  it('文件系统魔数 → 名称', () => {
    expect(describeFsType(0xef53)).toBe('ext4');
    expect(describeFsType(0x01021994)).toBe('tmpfs');
    // 实测：WSL2 / Docker Desktop 挂载 Windows 盘时 statfs 报 0x01021997（9p）
    expect(describeFsType(0x01021997)).toBe('9p');
    expect(describeFsType(0x794c7630)).toBe('overlayfs');
    expect(describeFsType(0x958458f6)).toBe('virtiofs');
    expect(describeFsType(0x999999)).toBe('0x999999');
    expect(describeFsType(undefined)).toBeNull();
  });

  it('磁盘百分比基于 used+available', () => {
    expect(diskPercent(75, 25)).toBe(75);
    expect(diskPercent(0, 0)).toBeNull();
  });
});

describe('system/service.helpers · SSE 帧与告警', () => {
  const snapshot: SystemSnapshot = {
    generatedAt: '2026-02-25T10:00:00.000Z',
    host: {
      hostname: 'h',
      platform: 'win32',
      kernel: '10.0',
      arch: 'x64',
      cpuModel: 'cpu',
      cpuCores: 8,
      uptimeSec: 100,
      bootedAt: '2026-02-25T00:00:00.000Z',
      osLabel: 'Windows',
      hostIsLinux: false,
    },
    cpu: { percent: 12, perCore: [10], loadAvg: [0, 0, 0] },
    memory: { usedBytes: 1, totalBytes: 2, availableBytes: 1, percent: 50, cachedBytes: 0, swapUsedBytes: 0, swapTotalBytes: 0 },
    disks: [],
    gpu: null,
    sources: {
      cpu: { available: true, mode: 'os-cpus', detail: null },
      memory: { available: true, mode: 'container-proc', detail: '降级说明' },
      disk: { available: false, mode: 'statfs', detail: '磁盘不可用' },
      gpu: { available: false, mode: 'none', detail: 'GPU 不可用' },
    },
  };

  it('裁剪掉 host 段以减小带宽', () => {
    const frame = buildMetricsFrame(snapshot);
    expect(frame).not.toHaveProperty('host');
    expect(frame.cpu.percent).toBe(12);
    expect(frame.sources.cpu.mode).toBe('os-cpus');
  });

  it('识别降级数据源', () => {
    expect(hasDegradedSource(snapshot)).toBe(true);
    expect(
      hasDegradedSource({
        ...snapshot,
        sources: {
          cpu: { available: true, mode: 'host-proc', detail: null },
          memory: { available: true, mode: 'host-proc', detail: null },
          disk: { available: true, mode: 'statfs', detail: null },
          gpu: { available: true, mode: 'nvidia-smi', detail: null },
        },
      }),
    ).toBe(false);
  });

  it('收集告警时排除完全正常的源', () => {
    const warnings = collectWarnings(snapshot);
    expect(warnings.map((w) => w.area).sort()).toEqual(['disk', 'gpu', 'memory']);
  });
});

describe('tools/catalog · 目录加载与校验', () => {
  it('内置目录含 Ollama / DSH / ComfyUI 且端口正确', () => {
    const byId = new Map(BUILTIN_TOOLS.map((tool) => [tool.id, tool]));
    expect(byId.get('ollama')?.port).toBe(11434);
    expect(byId.get('dsh')?.port).toBe(3080);
    expect(byId.get('comfyui')?.port).toBe(8188);
    expect(byId.get('ollama')?.featured).toBe(true);
  });

  it('校验并补全目录项', () => {
    const warnings: string[] = [];
    const tool = normalizeTool({ id: 'jellyfin', name: 'Jellyfin', port: 8096, probePath: 'health', deepLinkPath: 'web/' }, warnings, 'test');
    expect(tool?.probePath).toBe('/health');
    expect(tool?.deepLinkPath).toBe('/web/');
    expect(warnings).toEqual([]);
  });

  it('拒绝非法 id 与端口', () => {
    const warnings: string[] = [];
    expect(normalizeTool({ id: 'bad id!', port: 1 }, warnings, 'test')).toBeNull();
    expect(normalizeTool({ id: 'ok', port: 70000 }, warnings, 'test')).toBeNull();
    expect(warnings).toHaveLength(2);
  });

  it('解析 PORTAL_TOOLS_EXTRA 条目（id:名称:端口）', () => {
    const warnings: string[] = [];
    const tools = parseExtraTools(['immich:Immich:2283', 'broken', 'x:Y:notaport'], warnings);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({ id: 'immich', name: 'Immich', port: 2283 });
    expect(warnings).toHaveLength(2);
  });
});

describe('tools/service · 入口 URL 与汇总', () => {
  const ctx = buildHostContext({
    config: testConfig,
    request: { protocol: 'http', hostname: '100.72.255.29', headers: { host: '100.72.255.29:8899' }, port: 8899 },
    tailscaleIpv4: '100.72.255.29',
    tailscaleDnsName: 'sisi-laptop.tail921448.ts.net',
  });

  it('生成 MagicDNS 首选入口与多个候选', () => {
    const urls = buildToolUrls(BUILTIN_TOOLS[0]!, ctx);
    expect(urls.primary).toBe('http://sisi-laptop.tail921448.ts.net:11434/');
    expect(urls.candidates.map((c) => c.label)).toContain('localhost');
    expect(urls.deepLink?.url).toBe(urls.primary);
  });

  it('未配置端口时不生成任何入口', () => {
    const tool = normalizeTool({ id: 'noport', name: 'NoPort', port: null }, [], 'test');
    const urls = buildToolUrls(tool!, ctx);
    expect(urls.primary).toBeNull();
    expect(urls.candidates).toEqual([]);
    expect(urls.deepLink).toBeNull();
  });
});
