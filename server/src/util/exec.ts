/**
 * 通用子进程执行：带超时、输出上限、可注入环境变量。
 *
 * 用于调用 `tailscale`、`nvidia-smi`、`df` 等外部命令。
 * 注意：容器内执行宿主二进制（如挂载进来的 `/usr/bin/tailscale`）是设计内的用法，
 * 见 docs/static/03-server-modules.md 的 `runCommand` 说明。
 */
import { spawn } from 'node:child_process';

export interface RunCommandOptions {
  /** 超时毫秒数；超时后发送 SIGKILL */
  timeoutMs?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 追加到 stdout 的字节上限，超出截断 */
  maxBufferBytes?: number;
  /** 输入到 stdin 的内容 */
  stdin?: string;
}

export interface RunCommandResult {
  command: string;
  args: string[];
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** 是否因超时被杀 */
  timedOut: boolean;
  /** 是否可执行文件不存在（ENOENT） */
  notFound: boolean;
  durationMs: number;
}

/**
 * 执行命令并收集输出。**不抛异常**（除参数错误），一切结果通过返回值表达，
 * 因为调用方通常需要按 `notFound` / `code` 分支降级。
 *
 * @param command 可执行文件路径或 PATH 中的名字
 * @param args 参数数组（不经 shell，避免注入）
 */
export async function runCommand(
  command: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): Promise<RunCommandResult> {
  const {
    timeoutMs = 5000,
    cwd,
    env,
    maxBufferBytes = 1024 * 1024,
    stdin,
  } = options;

  const startedAt = Date.now();
  const argList = [...args];

  return new Promise<RunCommandResult>((resolve) => {
    let child;
    try {
      child = spawn(command, argList, {
        cwd,
        env: env ?? process.env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        command,
        args: argList,
        code: null,
        signal: null,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error),
        timedOut: false,
        notFound: true,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (
      code: number | null,
      signal: NodeJS.Signals | null,
      notFound = false,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command,
        args: argList,
        code,
        signal,
        stdout,
        stderr: truncated ? `${stderr}\n[output truncated]` : stderr,
        timedOut,
        notFound,
        durationMs: Date.now() - startedAt,
      });
    };

    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      if (target === 'stdout') {
        if (stdout.length + text.length > maxBufferBytes) {
          stdout += text.slice(0, Math.max(0, maxBufferBytes - stdout.length));
          truncated = true;
        } else {
          stdout += text;
        }
      } else {
        stderr = stderr.length + text.length > maxBufferBytes ? stderr : stderr + text;
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr?.on('data', (chunk: Buffer) => append('stderr', chunk));

    child.on('error', (error: NodeJS.ErrnoException) => {
      const notFound = error.code === 'ENOENT' || error.code === 'EACCES';
      if (error.message && stderr.length === 0) stderr = error.message;
      finish(null, null, notFound);
    });

    child.on('close', (code, signal) => finish(code, signal));

    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    } else {
      child.stdin?.end();
    }
  });
}

/** 命令是否成功（退出码 0 且未超时）。 */
export function isSuccess(result: RunCommandResult): boolean {
  return !result.timedOut && !result.notFound && result.code === 0;
}

/**
 * 执行命令并解析为 JSON。
 *
 * @returns 解析成功返回对象；命令失败或输出非 JSON 返回 null
 */
export async function runCommandJson<T>(
  command: string,
  args: readonly string[] = [],
  options: RunCommandOptions = {},
): Promise<{ data: T | null; result: RunCommandResult }> {
  const result = await runCommand(command, args, options);
  if (!isSuccess(result)) return { data: null, result };
  const text = result.stdout.trim();
  if (text === '') return { data: null, result };
  try {
    return { data: JSON.parse(text) as T, result };
  } catch {
    return { data: null, result };
  }
}
