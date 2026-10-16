/**
 * tailnet 数据源连通性测试。
 *
 * 用途：管理员在设置页粘贴 Token 后，**先测再存** —— 避免把一个错误的 Token
 * 存进数据库后只看到"数据源不可用"而不知原因。
 *
 * 与正式的数据源（`modules/tailscale/provider.ts`）刻意分开实现：
 * 这里要接受"候选 Token"并直接给出可读结论，不走缓存、不写状态。
 */
import type { SourceStatus } from './types.js';
import type { TailscaleDeviceSummary, TailscaleTestResult } from './types.js';

export interface TailscaleProbeInput {
  /** 当前生效的模式 */
  mode: 'auto' | 'cli' | 'api' | 'off';
  /** 用于测试的 Token（可能是尚未保存的候选值） */
  apiToken: string;
  tailnet: string;
  bin: string;
  socket: string;
  timeoutMs: number;
  /** 存储过程需要注入命令执行器以便测试 */
  runCommand?: CommandExecutor;
  fetchImpl?: typeof fetch;
  logger?: { debug: (msg: string, fields?: Record<string, unknown>) => void };
}

export type CommandExecutor = (
  command: string,
  args: readonly string[],
  options: { timeoutMs: number },
) => Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean; notFound: boolean; durationMs: number }>;

interface ApiDevice {
  hostname?: string;
  name?: string;
  os?: string;
  connectedToControl?: boolean;
  addresses?: string[];
}

/** 从 API 设备条目里提取用于展示的摘要。 */
export function summarizeApiDevices(devices: readonly ApiDevice[], limit = 5): TailscaleDeviceSummary[] {
  return devices.slice(0, limit).map((device) => ({
    hostname: device.hostname ?? (device.name ?? '').split('.')[0] ?? '',
    os: device.os ?? '',
    online: device.connectedToControl === true,
    ipv4: (device.addresses ?? []).find((ip) => !ip.includes(':')) ?? null,
  }));
}

/**
 * 解析实际要使用的模式（与 `selectTailscaleProvider` 的 auto 策略一致）。
 */
export function effectiveMode(mode: TailscaleProbeInput['mode'], hasToken: boolean): 'cli' | 'api' | 'off' {
  if (mode === 'off') return 'off';
  if (mode === 'api') return 'api';
  if (mode === 'cli') return 'cli';
  return hasToken ? 'api' : 'cli';
}

/**
 * 执行连通性测试。**永不抛异常**，所有结果通过返回值表达。
 *
 * 注意：这里**不读 `process.env`**。传进来的 `apiToken` 已经是三层优先级
 * （数据库 > 环境变量 > 默认值）解析后的生效值 —— 环境变量那一层由
 * `config.ts` 负责，探针再去看一眼 `process.env` 只会让结论与生效配置不一致，
 * 并且让测试结果取决于宿主机恰好设了什么变量。
 */
export async function probeTailscale(input: TailscaleProbeInput): Promise<TailscaleTestResult> {
  const token = input.apiToken.trim();
  const mode = effectiveMode(input.mode, token !== '');

  if (mode === 'off') {
    return {
      ok: false,
      mode: 'off',
      source: { available: false, mode: 'none', detail: 'tailnet 查询已关闭（PORTAL_TAILSCALE_MODE=off）' },
      deviceCount: null,
      onlineCount: null,
      devices: [],
      message: '当前配置为 off，不会查询 tailnet。把模式改为 auto 或 api 即可。',
    };
  }

  if (mode === 'cli') {
    return probeCli(input);
  }
  return probeApi(input, token);
}

async function probeCli(input: TailscaleProbeInput): Promise<TailscaleTestResult> {
  const run = input.runCommand ?? defaultRunCommand;
  const args = input.socket && input.socket !== '/var/run/tailscale/tailscaled.sock'
    ? ['status', '--json', '--socket', input.socket]
    : ['status', '--json'];

  const result = await run(input.bin, args, { timeoutMs: input.timeoutMs });

  if (result.notFound) {
    return {
      ok: false,
      mode: 'cli',
      source: {
        available: false,
        mode: 'cli',
        detail: `未找到 tailscale 可执行文件（${input.bin}）`,
      },
      deviceCount: null,
      onlineCount: null,
      devices: [],
      message:
        'CLI 模式需要在容器内能执行 tailscale。Windows 上容器是 Linux 环境，无法执行 tailscale.exe —— 请改用 api 模式并填 API Token；NAS 上可把宿主 tailscale 挂进容器。',
    };
  }
  if (result.timedOut) {
    return {
      ok: false,
      mode: 'cli',
      source: { available: false, mode: 'cli', detail: 'tailscale 命令执行超时' },
      deviceCount: null,
      onlineCount: null,
      devices: [],
      message: `tailscale 命令超过 ${input.timeoutMs}ms 未返回，请检查 socket 路径或调大超时。`,
    };
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim().split('\n')[0] ?? '';
    return {
      ok: false,
      mode: 'cli',
      source: {
        available: false,
        mode: 'cli',
        detail: `tailscale 命令失败（退出码 ${result.code}）${stderr ? `：${stderr}` : ''}`,
      },
      deviceCount: null,
      onlineCount: null,
      devices: [],
      message: 'CLI 调用失败。若容器内没有 tailscale，请改用 api 模式。',
    };
  }

  try {
    const json = JSON.parse(result.stdout) as {
      Peer?: Record<string, { HostName?: string; OS?: string; Online?: boolean; TailscaleIPs?: string[] }>;
      Self?: { HostName?: string; OS?: string; TailscaleIPs?: string[] };
    };
    const peers = Object.values(json.Peer ?? {});
    const devices: TailscaleDeviceSummary[] = peers.slice(0, 5).map((peer) => ({
      hostname: peer.HostName ?? '',
      os: peer.OS ?? '',
      online: peer.Online === true,
      ipv4: (peer.TailscaleIPs ?? []).find((ip) => !ip.includes(':')) ?? null,
    }));
    const online = peers.filter((peer) => peer.Online === true).length;
    return {
      ok: true,
      mode: 'cli',
      source: { available: true, mode: 'cli', detail: null },
      deviceCount: peers.length,
      onlineCount: online,
      devices,
      message: `CLI 模式可用：读到 ${peers.length} 台设备，其中 ${online} 台在线。`,
    };
  } catch {
    return {
      ok: false,
      mode: 'cli',
      source: { available: false, mode: 'cli', detail: 'tailscale 输出不是合法 JSON' },
      deviceCount: null,
      onlineCount: null,
      devices: [],
      message: 'tailscale 的返回无法解析，可能与版本不兼容。',
    };
  }
}

async function probeApi(input: TailscaleProbeInput, token: string): Promise<TailscaleTestResult> {
  if (token === '') {
    return {
      ok: false,
      mode: 'api',
      source: { available: false, mode: 'api', detail: '未配置 API Token' },
      deviceCount: null,
      onlineCount: null,
      devices: [],
      message:
        'API 模式需要一个 access token。在 Tailscale 管理后台 → Settings → Keys → Generate access token 生成，粘贴后点「测试连接」。',
    };
  }

  const tailnet = input.tailnet.trim() || '-';
  const url = `https://api.tailscale.com/api/v2/tailnet/${encodeURIComponent(tailnet)}/devices`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    });

    if (response.status === 401) {
      return {
        ok: false,
        mode: 'api',
        source: { available: false, mode: 'api', detail: 'Tailscale API 返回 401' },
        deviceCount: null,
        onlineCount: null,
        devices: [],
        message: 'Token 无效、已过期或被吊销。请重新生成一个 access token（注意只显示一次，需立即复制）。',
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        mode: 'api',
        source: { available: false, mode: 'api', detail: 'Tailscale API 返回 403' },
        deviceCount: null,
        onlineCount: null,
        devices: [],
        message:
          'Token 有效但权限不足，读不到设备列表。请检查 tailnet 的 ACL 策略，确认该令牌身份能查看这些设备。',
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        mode: 'api',
        source: { available: false, mode: 'api', detail: 'Tailscale API 返回 404' },
        deviceCount: null,
        onlineCount: null,
        devices: [],
        message: `tailnet 标识 "${tailnet}" 不存在。保持为 - 表示使用当前令牌所属的 tailnet。`,
      };
    }
    if (!response.ok) {
      return {
        ok: false,
        mode: 'api',
        source: { available: false, mode: 'api', detail: `Tailscale API 返回 ${response.status}` },
        deviceCount: null,
        onlineCount: null,
        devices: [],
        message: `Tailscale API 返回 HTTP ${response.status}，请稍后重试或检查网络出口。`,
      };
    }

    const payload = (await response.json()) as { devices?: ApiDevice[] };
    const devices = payload.devices ?? [];
    const online = devices.filter((device) => device.connectedToControl === true).length;
    return {
      ok: true,
      mode: 'api',
      source: { available: true, mode: 'api', detail: null },
      deviceCount: devices.length,
      onlineCount: online,
      devices: summarizeApiDevices(devices),
      message: `API 模式可用：读到 ${devices.length} 台设备，其中 ${online} 台在线。`,
    };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    const detail = aborted
      ? 'Tailscale API 请求超时'
      : `Tailscale API 请求失败：${error instanceof Error ? error.message : String(error)}`;
    input.logger?.debug('tailscale 连通性测试失败', { error });
    return {
      ok: false,
      mode: 'api',
      source: { available: false, mode: 'api', detail },
      deviceCount: null,
      onlineCount: null,
      devices: [],
      message: aborted
        ? `请求超过 ${input.timeoutMs}ms。容器需要能访问外网 api.tailscale.com；若网络受限请改用 cli 模式。`
        : '无法访问 api.tailscale.com。确认容器有外网出口（DNS 与 HTTPS）。',
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 默认命令执行器（延迟导入 exec，避免测试时拉起子进程）。 */
const defaultRunCommand: CommandExecutor = async (command, args, options) => {
  const { runCommand } = await import('../../util/exec.js');
  return runCommand(command, args, { timeoutMs: options.timeoutMs });
};

/** 供 API 层复用的 SourceStatus 类型别名（保持 import 面整洁）。 */
export type { SourceStatus };
