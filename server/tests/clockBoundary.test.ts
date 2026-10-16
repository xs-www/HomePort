/**
 * 墙钟边界的**可执行约定**：`schedulerIntegration.test.ts` 与 `metricsApi.test.ts`
 * 这两条线只许用**固定 epoch**，不许读真实墙钟。
 *
 * ## 为什么值得单独测
 *
 * 这两条线断言的是"某个整分钟 / 某个整点落了几行"。一旦 T0/BASE 来自 `Date.now()`，
 * "跑测试的真实时刻"就成了输入的一部分：22:59 跑会跨整点（整点滚动凭空多出 hour 行，
 * 于是 `total === flushed` 变成 `10 === 5`），23:01 跑又会把 hour 桶滚出来而断言仍写着
 * "hour 窗口为空"。同一份代码在一天里时红时绿，而且**不会编译报错、不会运行时抛错**，
 * 只在某些时刻红 —— 这类缺陷靠"重跑一次看看"几乎定位不到。
 *
 * 所以把约定变成断言：这两个文件里出现 `Date.now(` / `new Date(` / `performance.now(`
 * 就失败。需要"秒 → ISO"时用 `modules/metrics/history.ts` 的 `bucketAtToIso`，
 * 或者写成常量字符串 —— 两者都不读时钟。
 *
 * ## 范围是**这两个文件**，别的测试文件不受影响
 *
 * 例如 `metricsSampler.test.ts` 用 `performance.now()` 量"单 tick 耗时上界"、
 * 若干测试用 `new Date(...)` 只是为了拼出期望的 ISO 串 —— 那些读墙钟是正当的。
 * 这条约定只针对"用墙钟构造 T0/BASE"的这两条线。
 *
 * 同一手法在仓库里已有两个先例：`envBoundary.test.ts`（钉住"只有一个环境变量读取点"）、
 * `backgroundBoundary.test.ts`（钉住"后台代码不具备出站能力"）。三者都是把
 * 说不清、看不见的约定写成**可执行的断言**。
 *
 * ## 反向保护
 *
 * 如果目标文件不存在或内容为空，用例必须**失败**而不是静默通过 ——
 * 否则某天一次重命名就能让这个守卫退化成"永远为真"的空断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const TESTS_DIR = __dirname;

/** 受约束的文件（相对 `server/tests`）。 */
const GUARDED_FILES = ['schedulerIntegration.test.ts', 'metricsApi.test.ts'];

/**
 * 两条线共用的固定 epoch 字面量 `1_700_000_000`（= `2023-11-14T22:13:20Z`）。
 *
 * 写成**字符串**是因为守卫扫的是文本（源码里带数字分隔符）；去掉分隔符的数值
 * 与断言消息里的 `1_700_000_000` 是同一个数。取值只为确定性，不是用来回避边界。
 */
const FIXED_EPOCH_LITERAL = '1_700_000_000';

/** 墙钟取值：出现即违规。 */
const WALL_CLOCK_PATTERNS: Array<[string, RegExp]> = [
  ['Date.now(', /\bDate\.now\s*\(/],
  ['new Date(', /\bnew\s+Date\s*\(/],
  ['performance.now(', /\bperformance\.now\s*\(/],
];

/**
 * 三个"外部世界"的注入点：宿主快照 / 容器列表 / 服务注册表。
 *
 * 这两条线必须把三者全部换成假夹具，否则断言会跟着"这台机器恰好有没有 Docker、
 * CPU 首次采样有没有基线"漂移。这里钉的是**注入这个动作存在**（文本扫描，
 * 与 envBoundary/backgroundBoundary 的手法一致）：删掉某一行注入 → 本用例红。
 */
const REQUIRED_SOURCE_INJECTIONS = ['ctx.system.snapshot', 'ctx.containers.list', 'ctx.services.list'];

/** 去掉注释与字符串里的干扰：注释中"提到 Date.now"不算违规（本文档自身就是例子）。 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** 读受约束的文件；不存在或为空直接失败（反向保护）。 */
function readGuarded(relative: string): string {
  const full = path.join(TESTS_DIR, relative);
  expect(
    fs.existsSync(full),
    `${relative} 不存在 —— 守卫会退化成空断言，请确认文件是否被改名/移走`,
  ).toBe(true);
  return fs.readFileSync(full, 'utf8');
}

/** 去掉注释后的代码（"注释里提到 Date.now"不算违规）。 */
function codeOf(relative: string): string {
  return stripComments(readGuarded(relative));
}

describe('墙钟边界 · 这两个文件只许用固定 epoch', () => {
  it('受约束的就是这两个文件（范围明确：其它测试文件读墙钟不受限）', () => {
    expect(GUARDED_FILES).toEqual(['schedulerIntegration.test.ts', 'metricsApi.test.ts']);
  });

  it('没有任何墙钟取值：Date.now / new Date / performance.now', () => {
    const offenders: string[] = [];
    for (const relative of GUARDED_FILES) {
      const text = readGuarded(relative);
      expect(text.trim().length, `${relative} 内容为空 —— 守卫会退化成空断言`).toBeGreaterThan(0);
      const lines = codeOf(relative).split('\n');
      for (const [label, pattern] of WALL_CLOCK_PATTERNS) {
        lines.forEach((line, index) => {
          if (pattern.test(line)) offenders.push(`${relative}:${index + 1} → ${label}`);
        });
      }
    }
    expect(
      offenders,
      `这两条线的时间必须来自固定 epoch（不许读真实墙钟），违规处：\n${offenders.join('\n')}\n` +
        '需要"秒 → ISO"时用 modules/metrics/history.ts 的 bucketAtToIso，或写成常量字符串。',
    ).toEqual([]);
  });

  it('两条线钉的是同一个固定 epoch（并写明取值只为确定性）', () => {
    for (const relative of GUARDED_FILES) {
      // 常量本身在代码里（去注释后扫），"为什么取这个值"在注释里（用原文扫）。
      expect(codeOf(relative), `${relative} 必须声明 const EPOCH = ${FIXED_EPOCH_LITERAL}`).toContain(
        `const EPOCH = ${FIXED_EPOCH_LITERAL}`,
      );
      const text = readGuarded(relative);
      expect(text, `${relative} 必须写明取固定 epoch 是"为了确定性"`).toContain('确定性');
      expect(
        text,
        `${relative} 必须写明取值"不是为了回避边界"（跨整点由专门用例显式覆盖）`,
      ).toContain('回避边界');
    }
  });

  it('三个数据源都被换成注入的假夹具（不碰真实 Docker / 真实宿主采样器）', () => {
    for (const relative of GUARDED_FILES) {
      const code = codeOf(relative);
      for (const injection of REQUIRED_SOURCE_INJECTIONS) {
        expect(code, `${relative} 必须把 ${injection} 换成假夹具`).toContain(injection);
      }
    }
  });
});