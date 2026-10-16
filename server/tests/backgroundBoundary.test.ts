/**
 * 后台任务的**可执行约定**：默认不外发、不写 Docker、探测只读。
 *
 * 为什么用"扫源码"而不是行为测试：计划 §5 的验收原文是
 * 「默认配置不向外发送告警，也不自动重启容器」—— 这类要求描述的是**没有发生某事**，
 * 用行为测试很难证完（总有没走到的分支、没 mock 到的路径，而且"这次没发"不等于"不能发"）。
 * 但"代码里根本不具备这种能力"是可判定的：所以钉住能力边界本身。
 * 同一模式仓库里已有先例：`envBoundary.test.ts`（钉住"只有一个环境变量读取点"）。
 *
 * 边界怎么钉：
 * 1. **值导入**才算能力 —— `import type` 不产生运行期依赖，所以允许；
 *    于是"后台代码不得 value-import `modules/docker/service.js` / `provider.js` / `dockerode`"
 *    就等价于"后台代码拿不到能写 Docker 的连接对象"。
 * 2. **出站能力**：不许出现 `fetch(`、`node:http(s).request`、`net.connect`、子进程、
 *    以及任何通知客户端（nodemailer/axios/node-fetch/undici/webhook）。
 * 3. **探测只读**：`healthProbe.ts` 的方法只能是 `GET`、且不许带请求体。
 *
 * 反向保护：如果三个后台模块目录不存在或为空，**用例必须失败**而不是静默通过 ——
 * 否则某天一次重命名就能让这个守卫变成"永远为真"的空断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_DIR = path.resolve(__dirname, '..', 'src');

/** Sprint 2 的后台任务目录（相对 `server/src`）。 */
const BACKGROUND_DIRS = ['modules/metrics', 'modules/health', 'modules/alerts'];

/** 后台任务用到的共享件：它虽在 `docker/` 下，但正是**允许**被后台代码取用的那一个。 */
const SHARED_FILES = ['modules/docker/backgroundContext.ts'];

/** 后台代码**不得值导入**的模块（后缀比对：覆盖 `../docker/service.js` 这类相对写法）。 */
const FORBIDDEN_VALUE_IMPORTS = ['docker/service.js', 'docker/provider.js', 'dockerode'];

/** 出站 / 执行外部命令的能力（注释里的提及不算）。 */
const FORBIDDEN_CAPABILITIES: Array<[string, RegExp]> = [
  ['fetch 调用', /\bfetch\s*\(/],
  ['node:http(s) 请求', /\bhttps?\.(?:request|get)\s*\(/],
  ['net.connect', /\bnet\.connect\s*\(/],
  ['子进程', /\bchild_process\b|\bspawn\s*\(|\bexecFile\s*\(/],
  ['通知客户端依赖', /nodemailer|axios|node-fetch|undici/],
  ['Docker socket 路径', /\/var\/run\/docker\.sock/],
];

function filesIn(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesIn(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}

/** 去掉注释：注释里"提到 fetch"不算违规（本文档自身就是例子）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 后台任务涉及的全部文件（相对 `server/src` 的 posix 路径 + 绝对路径）。 */
function backgroundFiles(): Array<{ rel: string; full: string }> {
  const collected = [
    ...BACKGROUND_DIRS.flatMap((dir) => filesIn(path.join(SRC_DIR, dir))),
    ...SHARED_FILES.map((rel) => path.join(SRC_DIR, rel.split('/').join(path.sep))),
  ];
  return collected
    .filter((full) => fs.existsSync(full))
    .map((full) => ({ rel: path.relative(SRC_DIR, full).split(path.sep).join('/'), full }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
}

/** 取"值导入"的模块说明符（`import type …` 不产生运行期能力，直接跳过）。 */
function valueImports(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/^[ \t]*import\s+([\s\S]*?)\s+from\s+'([^']+)'/gm)) {
    const clause = match[1] ?? '';
    if (/^\s*type\b/.test(clause)) continue;
    out.push(match[2] ?? '');
  }
  return out;
}

describe('后台任务边界 · 默认不外发、不写 Docker', () => {
  it('三个后台模块目录都存在且非空（否则本守卫会静默失效）', () => {
    for (const dir of BACKGROUND_DIRS) {
      const files = filesIn(path.join(SRC_DIR, dir));
      expect(
        files.length,
        `${dir} 不存在或没有 .ts 文件 —— 守卫会退化成空断言，请确认模块是否被改名/移走`,
      ).toBeGreaterThan(0);
    }
  });

  it('没有任何出站或执行外部命令的能力', () => {
    const offenders: string[] = [];
    for (const { rel, full } of backgroundFiles()) {
      const code = stripComments(fs.readFileSync(full, 'utf8'));
      for (const [label, pattern] of FORBIDDEN_CAPABILITIES) {
        if (pattern.test(code)) offenders.push(`${rel} → ${label}`);
      }
    }
    expect(
      offenders,
      `后台任务（采样/健康/告警）不得具备外发或执行命令的能力：\n${offenders.join('\n')}\n` +
        '告警只产生站内事件，出站通道是 Sprint 4 的事；健康探测请复用 modules/services/healthProbe.ts。',
    ).toEqual([]);
  });

  it('不持有 Docker 写能力（只能类型导入，不能值导入）', () => {
    const offenders: string[] = [];
    for (const { rel, full } of backgroundFiles()) {
      for (const spec of valueImports(fs.readFileSync(full, 'utf8'))) {
        const forbidden = FORBIDDEN_VALUE_IMPORTS.find(
          (candidate) => spec === candidate || spec.endsWith(`/${candidate}`),
        );
        if (forbidden) offenders.push(`${rel} → import … from '${spec}'`);
      }
    }
    expect(
      offenders,
      `后台任务不得值导入 Docker 客户端（会获得 start/stop/restart/exec 能力）：\n${offenders.join('\n')}\n` +
        '需要类型时用 `import type`；需要主机上下文时用 modules/docker/backgroundContext.ts。',
    ).toEqual([]);
  });

  it('健康探测是只读的：只有 GET，且不带请求体', () => {
    const probePath = path.join(SRC_DIR, 'modules', 'services', 'healthProbe.ts');
    const code = stripComments(fs.readFileSync(probePath, 'utf8'));

    const methods = [...code.matchAll(/method:\s*'([A-Z]+)'/g)].map((match) => match[1]);
    // 先钉住"确实声明了方法"，否则下面的断言会在方法被删掉时静默通过
    expect(methods.length, 'healthProbe 应当显式声明探测方法').toBeGreaterThan(0);
    expect(methods.filter((method) => method !== 'GET'), '探测方法只允许 GET').toEqual([]);

    // 只读的第二层含义：不许带请求体（带体就可能被当成写操作）
    expect(/\bbody\s*:/.test(code), '探测不应带请求体').toBe(false);
  });
});