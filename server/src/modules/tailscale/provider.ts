/**
 * tailnet 数据源。
 *
 * 两种模式，按可用性自动选择（`PORTAL_TAILSCALE_MODE=auto`）：
 *
 * 1. **CLI 模式**：执行 `tailscale status --json`。
 *    在 Docker 内需要把宿主的 tailscale 可执行文件挂载进来
 *    （Windows：`C:\Program Files\Tailscale\tailscale.exe`；Linux/NAS：`/usr/bin/tailscale` + `/var/run/tailscale`）。
 *    优点：零配置、与宿主状态完全一致；缺点：依赖挂载。
 *
 * 2. **API 模式**：调用 Tailscale 官方 REST API（`/api/v2/tailnet/-/devices`）。
 *    需要 `PORTAL_TAILSCALE_API_TOKEN`（只读 scope `devices:read` 即可）。
 *    优点：完全云端、不受宿主挂载影响；缺点：需要 API Token，且有网络依赖与延迟。
 *
 * 两种模式的输出统一为 `TailnetStatus`，上层无感。
 */
import type { PortalConfig } from '../../config.js';
import type { Logger } from '../../logger.js';
import { isSuccess, runCommandJson, type RunCommandResult } from '../../util/exec.js';
import { tailnetFromDnsName } from '../../util/net.js';
import { toIso } from '../../util/format.js';
import type { SourceStatus, TailnetDevice, TailnetStatus } from './types.js';

/** 可注入的命令执行器（测试用假实现）。 */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<Pick<RunCommandResult, 'code' | 'stdout' | 'stderr' | 'timedOut' | 'notFound'>>;

export interface TailscaleProvider {
  readonly mode: string;
  isConfigured(): boolean;
  fetchStatus(): Promise<TailnetStatus>;
}

/** `tailscale status --json` 的响应结构（只声明用到的字段）。 */
export interface TailscaleStatusJson {
  Version?: string;
  BackendState?: string;
  TailscaleIPs?: string[];
  Self?: TailscalePeerJson;
  Peer?: Record<string, TailscalePeerJson>;
  MagicDNSSuffix?: string;
  CurrentTailnet?: { Name?: string; MagicDNSSuffix?: string };
  User?: Record<string, { LoginName?: string; DisplayName?: string }>;
}

export interface TailscalePeerJson {
  ID?: string;
  HostName?: string;
  DNSName?: string;
  OS?: string;
  TailscaleIPs?: string[];
  Online?: boolean;
  LastSeen?: string;
  Created?: string;
  ExitNode?: boolean;
  ExitNodeOption?: boolean;
  Tags?: string[];
  Relay?: string;
  CurAddr?: string;
  RxBytes?: number;
  TxBytes?: number;
  Active?: boolean;
  UserID?: number;
}

/** Tailscale REST API `/devices` 的元素结构（只声明用到的字段）。 */
export interface TailscaleApiDevice {
  id?: string;
  nodeId?: string;
  name?: string;
  hostname?: string;
  addresses?: string[];
  os?: string;
  created?: string;
  lastSeen?: string;
  connectedToControl?: boolean;
  isExternal?: boolean;
  tags?: string[];
  clientVersion?: string;
}

/** 从 IP 列表分离 v4/v6。 */
export function splitIps(ips: readonly string[] | undefined): { ipv4: string | null; ipv6: string | null } {
  const list = ips ?? [];
  return {
    ipv4: list.find((ip) => !ip.includes(':')) ?? null,
    ipv6: list.find((ip) => ip.includes(':')) ?? null,
  };
}

/** 去掉 MagicDNS 名末尾的点。 */
export function normalizeDnsName(name: string | undefined): string {
  return (name ?? '').trim().replace(/\.$/, '');
}

/**
 * 把 `tailscale status --json` 的 peer 映射为统一设备模型。
 *
 * 连接方式判定：有 `CurAddr` → direct；无 `CurAddr` 但 `Relay` 非空 → relay；
 * 否则 idle（离线）。
 */
export function mapCliPeer(peer: TailscalePeerJson, isSelf = false): TailnetDevice {
  const { ipv4, ipv6 } = splitIps(peer.TailscaleIPs);
  const curAddr = (peer.CurAddr ?? '').trim();
  const relay = (peer.Relay ?? '').trim();
  const online = peer.Online === true;
  const connection: TailnetDevice['connection'] = !online ? 'idle' : curAddr !== '' ? 'direct' : relay !== '' ? 'relay' : 'idle';

  return {
    id: peer.ID ?? '',
    hostname: peer.HostName ?? normalizeDnsName(peer.DNSName).split('.')[0] ?? '',
    dnsName: normalizeDnsName(peer.DNSName),
    os: peer.OS ?? '',
    ipv4,
    ipv6,
    online,
    lastSeen: toIso(peer.LastSeen ? new Date(peer.LastSeen) : null),
    createdAt: toIso(peer.Created ? new Date(peer.Created) : null),
    exitNode: peer.ExitNode === true,
    exitNodeOption: peer.ExitNodeOption === true,
    tags: peer.Tags ?? [],
    relay: relay !== '' ? relay : null,
    isSelf,
    rxBytes: typeof peer.RxBytes === 'number' ? peer.RxBytes : null,
    txBytes: typeof peer.TxBytes === 'number' ? peer.TxBytes : null,
    connection,
  };
}

/**
 * 把 CLI 的完整 JSON 映射为 `TailnetStatus`。
 *
 * 注意：`Peer` 只包含**其它**设备，自身信息在 `Self`。
 */
export function mapCliStatus(json: TailscaleStatusJson): TailnetStatus {
  const self = json.Self ? mapCliPeer({ ...json.Self, Online: true }, true) : null;
  const peers = Object.values(json.Peer ?? {}).map((peer) => mapCliPeer(peer));
  peers.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.hostname.localeCompare(b.hostname, 'zh-Hans-CN');
  });

  const dnsSuffix =
    (json.CurrentTailnet?.MagicDNSSuffix ?? json.MagicDNSSuffix ?? '').trim() ||
    (self ? tailnetFromDnsName(self.dnsName) : null) ||
    null;

  return {
    self,
    tailnet: {
      name: json.CurrentTailnet?.Name ?? dnsSuffix,
      magicDnsSuffix: dnsSuffix,
    },
    peers,
    summary: summarizePeers(peers),
    backendState: json.BackendState ?? null,
    source: { available: true, mode: 'cli', detail: null },
  };
}

/** 把 REST API 设备映射为统一模型。 */
export function mapApiDevice(device: TailscaleApiDevice, selfIds: ReadonlySet<string>): TailnetDevice {
  const { ipv4, ipv6 } = splitIps(device.addresses);
  const dnsName = normalizeDnsName(device.name);
  const id = device.id ?? device.nodeId ?? '';
  const online = device.connectedToControl === true;
  return {
    id,
    hostname: device.hostname ?? dnsName.split('.')[0] ?? '',
    dnsName,
    os: device.os ?? '',
    ipv4,
    ipv6,
    online,
    lastSeen: toIso(device.lastSeen ? new Date(device.lastSeen) : null),
    createdAt: toIso(device.created ? new Date(device.created) : null),
    exitNode: false,
    exitNodeOption: false,
    tags: (device.tags ?? []).map((tag) => tag.replace(/^tag:/, '')),
    relay: null,
    isSelf: selfIds.has(id),
    rxBytes: null,
    txBytes: null,
    connection: online ? 'direct' : 'idle',
  };
}

/** 由 API 设备列表组装 `TailnetStatus`。 */
export function mapApiDevices(devices: readonly TailscaleApiDevice[], selfHostname: string): TailnetStatus {
  const mapped = devices.map((device) => mapApiDevice(device, new Set()));
  const self =
    mapped.find((device) => device.hostname.toLowerCase() === selfHostname.toLowerCase()) ?? null;
  if (self) self.isSelf = true;
  const peers = mapped.filter((device) => device !== self);
  peers.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return a.hostname.localeCompare(b.hostname, 'zh-Hans-CN');
  });
  const suffix = self ? tailnetFromDnsName(self.dnsName) : null;
  return {
    self,
    tailnet: { name: suffix, magicDnsSuffix: suffix },
    peers,
    summary: summarizePeers(peers),
    backendState: 'Running',
    source: { available: true, mode: 'api', detail: null },
  };
}

/** 统计在线/离线设备。 */
export function summarizePeers(peers: readonly TailnetDevice[]): TailnetStatus['summary'] {
  const peersOnline = peers.filter((p) => p.online).length;
  return {
    peersTotal: peers.length,
    peersOnline,
    peersOffline: peers.length - peersOnline,
  };
}

/** 不可用状态的空结果。 */
export function unavailableStatus(mode: string, detail: string): TailnetStatus {
  return {
    self: null,
    tailnet: { name: null, magicDnsSuffix: null },
    peers: [],
    summary: { peersTotal: 0, peersOnline: 0, peersOffline: 0 },
    backendState: null,
    source: { available: false, mode, detail },
  };
}

/** 追加 `--socket` 参数（若配置了非默认 socket）。 */
export function withSocket(args: readonly string[], socket: string): string[] {
  if (!socket || socket === '/var/run/tailscale/tailscaled.sock') return [...args];
  return [...args, '--socket', socket];
}

/** CLI 数据源。 */
export class CliTailscaleProvider implements TailscaleProvider {
  readonly mode = 'cli';

  constructor(
    private readonly config: PortalConfig,
    private readonly logger: Logger,
    private readonly run: CommandRunner,
  ) {}

  isConfigured(): boolean {
    return this.config.tailscale.bin.trim() !== '';
  }

  async fetchStatus(): Promise<TailnetStatus> {
    const args = withSocket(['status', '--json'], this.config.tailscale.socket);
    const result = await this.run(this.config.tailscale.bin, args);

    if (result.notFound) {
      return unavailableStatus(
        'cli',
        `未找到 tailscale 可执行文件（${this.config.tailscale.bin}）。请把宿主 tailscale 挂载进容器，或改用 PORTAL_TAILSCALE_MODE=api`,
      );
    }
    if (result.timedOut) {
      return unavailableStatus('cli', 'tailscale 命令执行超时');
    }
    if (result.code !== 0) {
      const stderr = (result.stderr ?? '').trim().split('\n')[0] ?? '';
      return unavailableStatus('cli', `tailscale 命令失败（退出码 ${result.code}）${stderr ? `：${stderr}` : ''}`);
    }

    try {
      const json = JSON.parse(result.stdout) as TailscaleStatusJson;
      return mapCliStatus(json);
    } catch (error) {
      this.logger.warn('tailscale status 输出解析失败', { error });
      return unavailableStatus('cli', 'tailscale 输出不是合法 JSON');
    }
  }
}

/** REST API 数据源。 */
export class ApiTailscaleProvider implements TailscaleProvider {
  readonly mode = 'api';

  constructor(
    private readonly config: PortalConfig,
    private readonly logger: Logger,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  isConfigured(): boolean {
    return this.config.tailscale.apiToken.trim() !== '';
  }

  async fetchStatus(): Promise<TailnetStatus> {
    const token = this.config.tailscale.apiToken.trim();
    if (token === '') {
      return unavailableStatus('api', '未配置 PORTAL_TAILSCALE_API_TOKEN，无法使用 API 模式');
    }
    const tailnet = this.config.tailscale.tailnet.trim() || '-';
    const url = `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/devices`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.tailscale.timeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!response.ok) {
        const text = await safeText(response);
        return unavailableStatus('api', `Tailscale API 返回 ${response.status}${text ? `：${text.slice(0, 200)}` : ''}`);
      }
      const payload = (await response.json()) as { devices?: TailscaleApiDevice[] };
      return mapApiDevices(payload.devices ?? [], this.config.publicHost || process.env.HOSTNAME || '');
    } catch (error) {
      const detail = error instanceof Error && error.name === 'AbortError' ? 'Tailscale API 请求超时' : `Tailscale API 请求失败：${String(error)}`;
      this.logger.warn('Tailscale API 调用失败', { error });
      return unavailableStatus('api', detail);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 读取响应文本，失败时返回空串（用于错误详情）。 */
async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** 关闭状态的数据源。 */
export class DisabledTailscaleProvider implements TailscaleProvider {
  readonly mode = 'none';

  isConfigured(): boolean {
    return false;
  }

  async fetchStatus(): Promise<TailnetStatus> {
    return unavailableStatus('none', 'tailnet 查询已通过 PORTAL_TAILSCALE_MODE=off 关闭');
  }
}

/**
 * 按配置与可用性选择数据源。
 *
 * `auto` 策略：配置了 API Token → API；否则 CLI；两者都没有 → 返回 CLI 实例
 * （它会给出"未找到可执行文件"的明确提示，比静默失败更有诊断价值）。
 */
export async function selectTailscaleProvider(
  config: PortalConfig,
  logger: Logger,
  run: CommandRunner,
): Promise<TailscaleProvider> {
  const mode = config.tailscale.mode;
  if (mode === 'off') return new DisabledTailscaleProvider();

  const api = new ApiTailscaleProvider(config, logger);
  const cli = new CliTailscaleProvider(config, logger, run);

  if (mode === 'api') return api;
  if (mode === 'cli') return cli;

  if (api.isConfigured()) return api;
  return cli;
}
