/**
 * CI 质量门禁的**结构性回归测试**（Sprint 0 / S0-02）。
 *
 * 为什么需要它：工作流 YAML 不会被任何编译器或类型检查覆盖，
 * 删掉一个 `needs:`、把 `npm test` 挪走、给 CI 加上 `paths-ignore`，
 * 都不会有任何本地报错 —— 直到某天一个测试失败的提交把镜像推上了 GHCR。
 * 因此这里对两个工作流做结构断言，让"门禁被拆掉"变成一条会变红的测试。
 *
 * 用自带的极简缩进解析而不是引入 YAML 依赖：本项目刻意保持运行时与开发
 * 依赖精简（不引 js-yaml），而这里只需要"按缩进切出顶层块"这一件事。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../src/config.js';

const WORKFLOW_DIR = path.join(REPO_ROOT, '.github', 'workflows');

function readWorkflow(name: string): string {
  const file = path.join(WORKFLOW_DIR, name);
  expect(fs.existsSync(file), `缺少工作流文件 ${name}`).toBe(true);
  return fs.readFileSync(file, 'utf8');
}

/**
 * 去掉整行注释与行尾注释。
 *
 * 断言必须针对**生效的配置**：工作流里长篇解释"为什么不加 paths-ignore"
 * 这种注释，不应该让 `not.toContain('paths-ignore')` 误报。
 */
function effective(doc: string): string {
  return doc
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf('#');
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join('\n');
}

/** 取出缩进为 `indent` 的顶层块（例如 `jobs:` 下的某个 job）。 */
function blockOf(doc: string, key: string, indent = 0): string {
  const lines = doc.split(/\r?\n/);
  const header = new RegExp(`^${' '.repeat(indent)}${key}:\\s*$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return '';
  const collected: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === '') continue;
    const leading = line.length - line.trimStart().length;
    if (leading <= indent) break;
    collected.push(line);
  }
  return collected.join('\n');
}

/** `on:` 的触发器块。 */
function triggers(doc: string): string {
  return blockOf(doc, 'on');
}

/** `jobs:` 下的某个 job 块。 */
function job(doc: string, name: string): string {
  const jobs = blockOf(doc, 'jobs');
  return blockOf(jobs, name, 2);
}

describe('CI · ci.yml', () => {
  const ci = effective(readWorkflow('ci.yml'));

  it('在 PR 与 master 推送上都触发，且**没有** paths-ignore', () => {
    const on = triggers(ci);
    expect(on).toContain('pull_request');
    expect(on).toContain('push');
    // paths-ignore 会让纯文档 PR 不产生 check，配合分支保护会永久 pending
    expect(ci).not.toContain('paths-ignore');
  });

  it('权限最小化，且不引用任何 secret（外部 PR 拿不到生产密钥）', () => {
    expect(ci).toMatch(/permissions:\s*\n\s+contents:\s*read/);
    expect(ci).not.toMatch(/contents:\s*write/);
    expect(ci).not.toContain('secrets.');
  });

  it('quality job 跑类型检查 + 单元测试 + 生产构建', () => {
    const quality = job(ci, 'quality');
    expect(quality, 'ci.yml 必须有 quality job').not.toBe('');
    expect(quality).toContain('npm ci');
    expect(quality).toContain('npm run typecheck');
    expect(quality).toContain('npm test');
    expect(quality).toContain('npm run build');
  });

  it('e2e job 装 chromium 并跑 E2E，且排在 quality 之后', () => {
    const e2e = job(ci, 'e2e');
    expect(e2e, 'ci.yml 必须有 e2e job').not.toBe('');
    expect(e2e).toContain('npx playwright install');
    expect(e2e).toContain('npm run test:e2e');
    expect(e2e).toMatch(/needs:\s*quality/);
  });
});

describe('CI · docker-publish.yml 的发布门禁', () => {
  const publish = effective(readWorkflow('docker-publish.yml'));

  it('镜像发布必须等待 quality（测试不过就不出图）', () => {
    const build = job(publish, 'build-and-push');
    expect(build, 'docker-publish.yml 必须有 build-and-push job').not.toBe('');
    expect(build).toMatch(/needs:\s*(\[.*quality.*\]|quality)/);
    expect(build).toContain('push: true');
  });

  it('发布工作流自带质量门禁（不依赖另一个工作流被正确触发）', () => {
    const quality = job(publish, 'quality');
    expect(quality, 'docker-publish.yml 必须有 quality job').not.toBe('');
    expect(quality).toContain('npm ci');
    expect(quality).toContain('npm run typecheck');
    expect(quality).toContain('npm test');
    expect(quality).toContain('npm run build');
  });

  it('发布工作流不被 PR 触发，避免把 packages:write 与 Token 暴露给外部 PR', () => {
    expect(triggers(publish)).not.toContain('pull_request');
    expect(publish).toContain('packages: write');
  });

  it('多架构目标保留（NAS 是 amd64，工作站是 arm64）', () => {
    expect(publish).toContain('linux/amd64,linux/arm64');
    expect(publish).toContain('provenance: false');
    expect(publish).toContain('sbom: false');
  });
});