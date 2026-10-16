/**
 * 环境变量边界的**可执行约定**：`server/src` 下只有 `config.ts` 读 `process.env`。
 *
 * 为什么值得单独测：这条约定被破坏时不会有任何编译或运行错误，症状是
 * "本机恰好设了某个变量时行为不一样"——在测试里尤其隐蔽：
 * 同一个用例在 CI 上走 A 分支、在开发机上走 B 分支，断言一条条都写得没错，
 * 但结论完全不同（真实案例：tailnet 连通性测试因宿主环境里存在
 * `PORTAL_TAILSCALE_API_TOKEN` 而走进 API 分支、真的发起网络请求）。
 *
 * 所以这里做两件事：
 * 1. 扫描源码，钉住"只有一个环境变量读取点"；
 * 2. 直接验证探针**不看**环境变量，只认传进来的已解析配置。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, readEnvVar } from '../src/config.js';
import { probeTailscale, type CommandExecutor } from '../src/modules/settings/tailscaleProbe.js';

const SRC_DIR = path.resolve(__dirname, '..', 'src');
const ENV_PROBE_KEY = 'PORTAL_ENV_BOUNDARY_PROBE';

function listTsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** 去掉注释与字符串里的干扰：注释中"提到 process.env"不算违规。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 假的命令执行器：报告"可执行文件不存在"，避免真的去 spawn 进程。 */
const missingCommand: CommandExecutor = async () => ({
  code: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  notFound: true,
  durationMs: 1,
});

/** 记录是否有人试图访问网络。 */
function countingFetch(): { calls: () => number; impl: typeof fetch } {
  let calls = 0;
  const impl = (async () => {
    calls += 1;
    throw new Error('本用例不应发起网络请求');
  }) as unknown as typeof fetch;
  return { calls: () => calls, impl };
}

/** 临时设置一个环境变量并在结束时恢复原状。 */
function withEnv(key: string, value: string | undefined, run: () => void): void {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    run();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

describe('环境变量边界 · 只有一个读取点', () => {
  it('server/src 下除 config.ts 外没有任何文件接触 process.env', () => {
    const offenders = listTsFiles(SRC_DIR)
      .filter((file) => path.relative(SRC_DIR, file).split(path.sep).join('/') !== 'config.ts')
      .filter((file) => /process\.env\b/.test(stripComments(fs.readFileSync(file, 'utf8'))))
      .map((file) => path.relative(SRC_DIR, file).split(path.sep).join('/'))
      .sort();

    expect(
      offenders,
      `以下文件绕过了 config.ts 直接读 process.env：\n${offenders.join('\n')}\n` +
        '请改为从 config 取值（需要环境变量原值时用 config.readEnvVar / config.envVars）。',
    ).toEqual([]);
  });

  it('readEnvVar 去空白，并把空串当作未设置', () => {
    withEnv(ENV_PROBE_KEY, '  value  ', () => {
      expect(readEnvVar(ENV_PROBE_KEY)).toBe('value');
    });
    withEnv(ENV_PROBE_KEY, '   ', () => {
      expect(readEnvVar(ENV_PROBE_KEY)).toBeNull();
    });
    withEnv(ENV_PROBE_KEY, undefined, () => {
      expect(readEnvVar(ENV_PROBE_KEY)).toBeNull();
    });
  });

  it('config.envVars 是 process.env 的快照，且可被测试注入覆盖', () => {
    // 只验语义：快照里能读到真实环境变量，注入的值优先
    withEnv(ENV_PROBE_KEY, 'from-process-env', () => {
      const inherited = loadConfig({ envVars: { [ENV_PROBE_KEY]: 'from-override' } });
      expect(inherited.envVars[ENV_PROBE_KEY]).toBe('from-override');
      expect(inherited.envVars['PATH']).toBe(process.env['PATH']);
    });
  });
});

describe('tailnet 连通性探针 · 只认传入的已解析配置', () => {
  it('宿主环境里有 PORTAL_TAILSCALE_API_TOKEN 也不影响判定（auto 模式仍按无 Token 处理）', async () => {
    const network = countingFetch();
    await withEnvAsync('PORTAL_TAILSCALE_API_TOKEN', 'tskey-api-from-ambient-env', async () => {
      const result = await probeTailscale({
        mode: 'auto',
        apiToken: '', // 三层优先级解析后的生效值就是空
        tailnet: '-',
        bin: '/nonexistent/tailscale',
        socket: '/nonexistent',
        timeoutMs: 50,
        fetchImpl: network.impl,
        runCommand: missingCommand,
      });

      expect(network.calls(), '没有 Token 就不该发起网络请求').toBe(0);
      expect(result.mode).toBe('cli'); // auto + 无 Token → cli
      expect(result.ok).toBe(false);
      expect(result.message).toMatch(/Token|令牌/);
    });
  });

  it('api 模式下没有 Token 时直接给出获取指引，不发请求', async () => {
    const network = countingFetch();
    const result = await probeTailscale({
      mode: 'api',
      apiToken: '   ',
      tailnet: '-',
      bin: 'tailscale',
      socket: '/nonexistent',
      timeoutMs: 50,
      fetchImpl: network.impl,
      runCommand: missingCommand,
    });

    expect(network.calls()).toBe(0);
    expect(result.mode).toBe('api');
    expect(result.ok).toBe(false);
    expect(result.source.detail).toContain('Token');
    expect(result.message).toMatch(/Keys|Token/);
  });

  it('有 Token 时才会走 API 分支（用注入的 fetch 验证，不碰真实网络）', async () => {
    let received = '';
    const impl = (async (_url: string, init?: RequestInit) => {
      received = String((init?.headers as Record<string, string> | undefined)?.['Authorization'] ?? '');
      return new Response(JSON.stringify({ devices: [{ hostname: 'nas', os: 'linux', connectedToControl: true }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const result = await probeTailscale({
      mode: 'auto',
      apiToken: 'tskey-api-candidate',
      tailnet: 'example.ts.net',
      bin: 'tailscale',
      socket: '/nonexistent',
      timeoutMs: 500,
      fetchImpl: impl,
      runCommand: missingCommand,
    });

    expect(received).toBe('Bearer tskey-api-candidate');
    expect(result.mode).toBe('api');
    expect(result.ok).toBe(true);
    expect(result.deviceCount).toBe(1);
  });
});

/** withEnv 的异步版本（探针是 async 的）。 */
async function withEnvAsync(key: string, value: string | undefined, run: () => Promise<void>): Promise<void> {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await run();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}