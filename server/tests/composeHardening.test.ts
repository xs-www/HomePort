/**
 * 部署硬化的**结构性**断言（Sprint 0 · S0-04）。
 *
 * 为什么要有这个测试：compose 文件是最容易被"顺手改回去"的地方 ——
 * 有人为了图方便把 `:ro` 去掉、把 `POST: 0` 改成 1、或者把硬编码的 Windows 盘挂回来，
 * 单测和 E2E 都不会有任何反应，而安全性已经悄悄退回原样。
 *
 * 这里只做**静态**断言（解析 YAML 文本），运行时的真实行为另有实测记录：
 * 临时代理容器上 GET 4 个读接口 → 200、未放行读接口 → 403、POST/DELETE → 403，
 * 且真实门户产物经代理能列容器 / inspect / 读日志（见 IMPLEMENTATION_REPORT_S0.md §2.5）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** 去掉注释与空行后的有效内容（注释里提到 `POST: 1` 之类的说明不该被判为配置）。 */
function effective(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

const compose = effective(fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.yml'), 'utf8'));
const proxyOverlay = effective(
  fs.readFileSync(path.join(REPO_ROOT, 'docker-compose.socket-proxy.yml'), 'utf8'),
);

describe('docker-compose.yml · 默认部署的最小权限', () => {
  it('docker.sock 以只读挂载', () => {
    expect(compose).toMatch(/\/var\/run\/docker\.sock:ro/);
    // 不允许出现"挂了 socket 但没带 :ro"的行（去掉注释后仍必须全部带 :ro）
    expect(compose).not.toMatch(/:\/var\/run\/docker\.sock\s*$/m);
  });

  it('丢弃全部 capability，并禁止提权', () => {
    expect(compose).toMatch(/cap_drop:\s*\n\s*- ALL/);
    expect(compose).toContain('no-new-privileges:true');
  });

  it('不再硬编码 Windows 的 C:/ 挂载（Linux/NAS 上会直接起不来）', () => {
    expect(compose).not.toMatch(/-\s*"C:\/:/);
    expect(compose).not.toMatch(/-\s*C:\/:\/host\/disk/);
  });

  it('透传 Sprint 0 新增的安全与两步验证配置', () => {
    for (const key of [
      'PORTAL_SECURITY_HEADERS',
      'PORTAL_HSTS',
      'PORTAL_TRUST_PROXY',
      'PORTAL_SECRET_KEY',
      'PORTAL_SECRET_KEY_PREVIOUS',
      'PORTAL_TOTP_ENABLED',
      'PORTAL_TOTP_ISSUER',
    ]) {
      expect(compose, `docker-compose.yml 应透传 ${key}`).toContain(key);
    }
  });

  it('默认信任边界是 loopback（不是"信任全部"）', () => {
    expect(compose).toMatch(/PORTAL_TRUST_PROXY:\s*"\$\{PORTAL_TRUST_PROXY:-loopback\}"/);
  });

  it('保留了健康检查与数据卷（硬化不该顺手删掉它们）', () => {
    expect(compose).toContain('/api/health');
    expect(compose).toContain('homeport-data:/data');
    expect(compose).toContain('healthcheck:');
  });
});

describe('docker-compose.socket-proxy.yml · 只读代理覆盖文件', () => {
  it('只放行门户实际用到的读接口', () => {
    for (const key of ['CONTAINERS', 'INFO', 'VERSION', 'PING']) {
      expect(proxyOverlay, `${key} 应放行`).toMatch(new RegExp(`${key}:\\s*1\\b`));
    }
    // 门户不读镜像/网络/卷/事件，一律不开（最小放行面）
    for (const key of ['IMAGES', 'NETWORKS', 'VOLUMES', 'EVENTS', 'SECRETS', 'SERVICES', 'NODES']) {
      expect(proxyOverlay, `${key} 不该放行`).toMatch(new RegExp(`${key}:\\s*0\\b`));
    }
  });

  it('显式关闭所有写操作', () => {
    for (const key of ['POST', 'EXEC', 'BUILD', 'COMMIT', 'AUTH', 'SWARM', 'PLUGINS', 'SYSTEM']) {
      expect(proxyOverlay, `${key} 必须为 0`).toMatch(new RegExp(`${key}:\\s*0\\b`));
    }
  });

  it('代理端口不发布到宿主，只在 compose 网络内可达', () => {
    expect(proxyOverlay).toContain('expose:');
    expect(proxyOverlay).not.toMatch(/^\s*ports:/m);
  });

  it('代理自己读 socket 也保持只读，并禁止提权', () => {
    expect(proxyOverlay).toMatch(/\/var\/run\/docker\.sock:ro/);
    expect(proxyOverlay).toContain('no-new-privileges:true');
  });

  it('门户改连代理，并依赖代理先启动', () => {
    expect(proxyOverlay).toContain('DOCKER_ENDPOINT: "tcp://docker-socket-proxy:2375"');
    expect(proxyOverlay).toMatch(/depends_on:\s*\n\s*- docker-socket-proxy/);
    expect(proxyOverlay).toContain('homeport-docker-proxy');
  });

  it('覆盖文件不覆盖默认 compose 的其它硬化项（仍带 socket 只读与 cap_drop）', () => {
    // `-f a.yml -f b.yml` 是合并：这里确认覆盖文件只做增量，没有把基础文件的关键项重写掉
    expect(proxyOverlay).not.toMatch(/cap_drop:\s*\n\s*- ALL/);
    expect(proxyOverlay).not.toContain('homeport-data:/data');
  });
});