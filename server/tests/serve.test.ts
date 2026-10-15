/**
 * `tailscale serve` 路由解析的单测。
 *
 * 输入取自真实环境的 `tailscale serve status --json` 输出（本机 1.102.4，实测抓取），
 * 这样能覆盖「同一端口多个路径」「多端口」「指向宿主服务而非容器」这些真实形态。
 */
import { describe, expect, it } from 'vitest';
import {
  describeServeFailure,
  normalizePath,
  parseHostPort,
  parseProxyTarget,
  parseServeStatus,
  type ServeStatusJson,
} from '../src/modules/tailscale/serveProvider.js';
import { withSocket } from '../src/modules/tailscale/provider.js';

/** 实测抓取的真实输出（脱敏后原样保留结构）。 */
const REAL_STATUS: ServeStatusJson = {
  TCP: {
    '443': { HTTPS: true },
    '8443': { HTTPS: true },
  },
  Web: {
    'sisi-laptop.tail921448.ts.net:443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:8899' },
        '/api/addSchedule': { Proxy: 'http://127.0.0.1:443/api/agent/events' },
        '/calendar': { Proxy: 'http://127.0.0.1:443/calendar' },
        '/calendar.ics': { Proxy: 'http://127.0.0.1:443/calendar.ics' },
        '/dsh': { Proxy: 'http://127.0.0.1:3081' },
        '/salecapitai': { Proxy: 'http://127.0.0.1:8080' },
        '/worldforge': { Proxy: 'http://127.0.0.1:4173' },
      },
    },
    'sisi-laptop.tail921448.ts.net:8443': {
      Handlers: {
        '/': { Proxy: 'http://127.0.0.1:8899' },
      },
    },
  },
};

describe('serveProvider · 解析 serve 配置', () => {
  it('把每个路径 handler 解析为一条路由', () => {
    const routes = parseServeStatus(REAL_STATUS);
    // 443 上 7 条 + 8443 上 1 条
    expect(routes).toHaveLength(8);
  });

  it('正确提取主机、端口、路径与代理目标', () => {
    const routes = parseServeStatus(REAL_STATUS);
    const calendar = routes.find((route) => route.path === '/calendar');
    expect(calendar).toMatchObject({
      host: 'sisi-laptop.tail921448.ts.net',
      port: 443,
      scheme: 'https',
      targetHost: '127.0.0.1',
      targetPort: 443,
      targetPath: '/calendar',
      url: 'https://sisi-laptop.tail921448.ts.net/calendar',
    });
  });

  it('443 端口在 URL 中省略，非默认端口保留', () => {
    const routes = parseServeStatus(REAL_STATUS);
    const root443 = routes.find((route) => route.port === 443 && route.path === '/');
    const root8443 = routes.find((route) => route.port === 8443 && route.path === '/');
    expect(root443?.url).toBe('https://sisi-laptop.tail921448.ts.net/');
    expect(root8443?.url).toBe('https://sisi-laptop.tail921448.ts.net:8443/');
  });

  it('同一宿主端口上的多个路径各自成条（不合并）', () => {
    const routes = parseServeStatus(REAL_STATUS).filter((route) => route.port === 443);
    const paths = routes.map((route) => route.path);
    expect(paths).toContain('/');
    expect(paths).toContain('/calendar');
    expect(paths).toContain('/calendar.ics');
    expect(paths).toContain('/api/addSchedule');
    // 三条都指向 443 端口，但路径不同 → 必须分开，否则会丢信息
    const toPort443 = routes.filter((route) => route.targetPort === 443);
    expect(toPort443.length).toBe(3);
    expect(new Set(toPort443.map((route) => route.targetPath)).size).toBe(3);
  });

  it('按主机 → 端口 → 路径排序，且 `/` 优先', () => {
    const routes = parseServeStatus(REAL_STATUS);
    const first443 = routes.findIndex((route) => route.port === 443);
    // 443 组的第一条应是 `/`
    expect(routes[first443]?.path).toBe('/');
    // 8443 应排在 443 之后
    const first8443 = routes.findIndex((route) => route.port === 8443);
    expect(first8443).toBeGreaterThan(first443);
  });

  it('按主机名过滤（忽略大小写与尾随点）', () => {
    const routes = parseServeStatus(REAL_STATUS, ['SISI-LAPTOP.Tail921448.ts.net.']);
    expect(routes).toHaveLength(8);
    const none = parseServeStatus(REAL_STATUS, ['other-host.ts.net']);
    expect(none).toEqual([]);
  });

  it('没有 Proxy 的 handler 被跳过（serve 也支持静态文案）', () => {
    const withText: ServeStatusJson = {
      Web: {
        'host.ts.net:443': {
          Handlers: {
            '/': { Proxy: 'http://127.0.0.1:80' },
            '/note': { Text: 'hello' },
          },
        },
      },
    };
    const routes = parseServeStatus(withText);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe('/');
  });

  it('空配置返回空数组（未配置 serve 时不报错）', () => {
    expect(parseServeStatus({})).toEqual([]);
    expect(parseServeStatus({ Web: {} })).toEqual([]);
  });

  it('非法 key 被跳过而不是抛错', () => {
    const bad: ServeStatusJson = {
      Web: {
        'no-port-here': { Handlers: { '/': { Proxy: 'http://127.0.0.1:80' } } },
        'host.ts.net:notanumber': { Handlers: { '/': { Proxy: 'http://127.0.0.1:80' } } },
        ':443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:80' } } },
        'good.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:80' } } },
      },
    };
    const routes = parseServeStatus(bad);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.host).toBe('good.ts.net');
  });
});

describe('serveProvider · 小工具函数', () => {
  it('parseHostPort 兼容 IPv6 方括号', () => {
    expect(parseHostPort('host.ts.net:443')).toEqual({ host: 'host.ts.net', port: 443 });
    expect(parseHostPort('[fd7a::1]:8443')).toEqual({ host: 'fd7a::1', port: 8443 });
    expect(parseHostPort('host.ts.net')).toBeNull();
    expect(parseHostPort('host.ts.net:0')).toBeNull();
    expect(parseHostPort('host.ts.net:99999')).toBeNull();
    expect(parseHostPort('')).toBeNull();
  });

  it('parseProxyTarget 解析协议、端口与路径', () => {
    expect(parseProxyTarget('http://127.0.0.1:443/calendar')).toEqual({
      host: '127.0.0.1',
      port: 443,
      path: '/calendar',
    });
    // 缺省端口按协议补全
    expect(parseProxyTarget('http://127.0.0.1/x')).toEqual({ host: '127.0.0.1', port: 80, path: '/x' });
    expect(parseProxyTarget('https://svc/x')).toEqual({ host: 'svc', port: 443, path: '/x' });
    // 无路径时归一化为 /
    expect(parseProxyTarget('http://127.0.0.1:8080')).toEqual({ host: '127.0.0.1', port: 8080, path: '/' });
    expect(parseProxyTarget('not a url')).toBeNull();
  });

  it('normalizePath 保证前导斜杠', () => {
    expect(normalizePath('')).toBe('/');
    expect(normalizePath('calendar')).toBe('/calendar');
    expect(normalizePath('/calendar')).toBe('/calendar');
  });

  it('describeServeFailure 把失败翻译成可操作原因', () => {
    const notFound = describeServeFailure(
      { code: null, stderr: '', timedOut: false, notFound: true },
      '/usr/bin/tailscale',
    );
    expect(notFound?.detail).toContain('未找到 tailscale');

    const timedOut = describeServeFailure({ code: -1, stderr: '', timedOut: true, notFound: false }, 'tailscale');
    expect(timedOut?.detail).toContain('超时');

    const failed = describeServeFailure(
      { code: 1, stderr: 'getting serve config: ...', timedOut: false, notFound: false },
      'tailscale',
    );
    expect(failed?.detail).toContain('退出码 1');

    // 成功时返回 null（表示无需报告失败）
    expect(describeServeFailure({ code: 0, stderr: '', timedOut: false, notFound: false }, 'tailscale')).toBeNull();
  });
});

describe('tailscale/provider · --socket 参数位置（回归）', () => {
  it('--socket 是全局 flag，必须放在子命令之前', () => {
    // 实测：`tailscale status --json --socket X` 会报
    // "flag provided but not defined: -socket"
    expect(withSocket(['status', '--json'], '/custom/tailscaled.sock')).toEqual([
      '--socket',
      '/custom/tailscaled.sock',
      'status',
      '--json',
    ]);
    expect(withSocket(['serve', 'status', '--json'], '/custom/tailscaled.sock')).toEqual([
      '--socket',
      '/custom/tailscaled.sock',
      'serve',
      'status',
      '--json',
    ]);
  });

  it('默认 socket 路径时不插入参数（tailscale 自带默认值）', () => {
    expect(withSocket(['status', '--json'], '/var/run/tailscale/tailscaled.sock')).toEqual(['status', '--json']);
    expect(withSocket(['status', '--json'], '')).toEqual(['status', '--json']);
  });
});
