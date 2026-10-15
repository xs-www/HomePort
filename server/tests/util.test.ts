/**
 * 工具函数的纯函数单测。
 *
 * 覆盖的是「算错就会让界面显示错误信息」的逻辑：可达性判定、URL 组装、
 * 脱敏、/proc 解析、Docker 日志解复用、nvidia-smi 解析。
 */
import { describe, expect, it } from 'vitest';
import {
  bestReachability,
  buildUrl,
  classifyBind,
  collectContainerIps,
  hostForUrl,
  isInternalHost,
  isLoopbackHost,
  isMagicDnsName,
  isPrivateLanIp,
  isTailscaleIp,
  isWildcardHost,
  parsePortKey,
  tailnetFromDnsName,
} from '../src/util/net.js';
import { isSensitiveKey, redactEnvList, redactLines, redactRecord, redactText } from '../src/util/redact.js';
import { formatBytes, formatDuration, normalizeLines, parseDockerTime, percentOf, round, toIso } from '../src/util/format.js';
import {
  cpuPercentBetween,
  osCpusToCpuTimes,
  parseCpuModel,
  parseLoadAvg,
  parseMemInfo,
  parseProcStat,
  parseProcStatPerCore,
  parseProcUptime,
} from '../src/util/proc.js';
import { demuxDockerLogs } from '../src/util/dockerStream.js';
import { TtlCache } from '../src/util/cache.js';

describe('util/net · IP 分类', () => {
  it('识别 tailnet 地址（v4 CGNAT 段与 v6 ULA 段）', () => {
    expect(isTailscaleIp('100.72.255.29')).toBe(true);
    expect(isTailscaleIp('100.64.0.1')).toBe(true);
    expect(isTailscaleIp('100.127.255.254')).toBe(true);
    expect(isTailscaleIp('fd7a:115c:a1e0::2101:ffb9')).toBe(true);
    // 边界：100.63.x 与 100.128.x 不属于 100.64.0.0/10
    expect(isTailscaleIp('100.63.0.1')).toBe(false);
    expect(isTailscaleIp('100.128.0.1')).toBe(false);
    expect(isTailscaleIp('192.168.1.1')).toBe(false);
  });

  it('识别回环与通配地址', () => {
    for (const host of ['', 'localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBe(true);
    }
    expect(isLoopbackHost('100.72.255.29')).toBe(false);

    for (const host of ['', '0.0.0.0', '::', '[::]', '*']) {
      expect(isWildcardHost(host)).toBe(true);
    }
    expect(isWildcardHost('192.168.1.5')).toBe(false);
  });

  it('识别私网地址', () => {
    expect(isPrivateLanIp('10.0.0.5')).toBe(true);
    expect(isPrivateLanIp('192.168.1.101')).toBe(true);
    expect(isPrivateLanIp('172.16.0.1')).toBe(true);
    expect(isPrivateLanIp('172.31.255.255')).toBe(true);
    expect(isPrivateLanIp('172.32.0.1')).toBe(false);
    expect(isPrivateLanIp('8.8.8.8')).toBe(false);
  });
});

describe('util/net · 可达性判定（F1 核心）', () => {
  it('通配绑定 → tailnet 可达', () => {
    expect(classifyBind('0.0.0.0')).toBe('tailnet');
    expect(classifyBind('::')).toBe('tailnet');
    expect(classifyBind('')).toBe('tailnet');
  });

  it('回环绑定 → 仅本机', () => {
    expect(classifyBind('127.0.0.1')).toBe('localhost-only');
    expect(classifyBind('::1')).toBe('localhost-only');
  });

  it('显式绑定 tailnet 地址 → tailnet 可达', () => {
    expect(classifyBind('100.72.255.29')).toBe('tailnet');
    // 依赖宿主 tailnet IP 列表识别非 CGNAT 写法
    expect(classifyBind('fd7a:115c:a1e0::1', ['fd7a:115c:a1e0::1'])).toBe('tailnet');
  });

  it('绑定局域网地址 → 仅局域网', () => {
    expect(classifyBind('192.168.1.101')).toBe('lan');
    expect(classifyBind('10.8.0.1')).toBe('lan');
  });

  it('取更优等级时 tailnet 优先于 lan，lan 优先于仅本机', () => {
    expect(bestReachability('lan', 'tailnet')).toBe('tailnet');
    expect(bestReachability('localhost-only', 'lan')).toBe('lan');
    expect(bestReachability('none', 'localhost-only')).toBe('localhost-only');
    expect(bestReachability('tailnet', 'tailnet')).toBe('tailnet');
  });
});

describe('util/net · URL 组装', () => {
  it('省略默认端口', () => {
    expect(buildUrl({ host: 'example.com', port: 80 })).toBe('http://example.com/');
    expect(buildUrl({ scheme: 'https', host: 'example.com', port: 443 })).toBe('https://example.com/');
  });

  it('保留非默认端口', () => {
    expect(buildUrl({ host: 'example.com', port: 8080 })).toBe('http://example.com:8080/');
  });

  it('IPv6 加方括号', () => {
    expect(hostForUrl('fd7a:115c:a1e0::1')).toBe('[fd7a:115c:a1e0::1]');
    expect(hostForUrl('100.72.255.29')).toBe('100.72.255.29');
    expect(buildUrl({ host: 'fd7a:115c:a1e0::1', port: 8080 })).toBe('http://[fd7a:115c:a1e0::1]:8080/');
  });

  it('空主机返回 null', () => {
    expect(buildUrl({ host: '' })).toBeNull();
    expect(buildUrl({ host: '   ' })).toBeNull();
  });

  it('补全路径前导斜杠', () => {
    expect(buildUrl({ host: 'h', port: 1, path: 'web/' })).toBe('http://h:1/web/');
  });
});

describe('util/net · 内部主机与端口键', () => {
  it('识别需要在浏览器侧替换的内部别名', () => {
    expect(isInternalHost('host.docker.internal')).toBe(true);
    expect(isInternalHost('127.0.0.1')).toBe(true);
    expect(isInternalHost('gateway.docker.internal')).toBe(true);
    expect(isInternalHost('100.72.255.29')).toBe(false);
  });

  it('解析 Docker 端口键', () => {
    expect(parsePortKey('8080/tcp')).toEqual({ port: 8080, protocol: 'tcp' });
    expect(parsePortKey('53/udp')).toEqual({ port: 53, protocol: 'udp' });
    expect(parsePortKey('80')).toEqual({ port: 80, protocol: 'tcp' });
    expect(parsePortKey('abc/tcp')).toBeNull();
    expect(parsePortKey('0/tcp')).toBeNull();
    expect(parsePortKey('70000/tcp')).toBeNull();
  });

  it('收集容器 IP 时跳过空值', () => {
    expect(
      collectContainerIps({
        a: { IPAddress: '172.18.0.2' },
        b: { IPAddress: '' },
        c: {},
      }),
    ).toEqual(['172.18.0.2']);
    expect(collectContainerIps(undefined)).toEqual([]);
  });

  it('从 MagicDNS 名推导 tailnet 名', () => {
    expect(isMagicDnsName('sisi-laptop.tail921448.ts.net')).toBe(true);
    expect(isMagicDnsName('example.com')).toBe(false);
    expect(tailnetFromDnsName('sisi-laptop.tail921448.ts.net.')).toBe('tail921448.ts.net');
    expect(tailnetFromDnsName('example.com')).toBeNull();
  });
});

describe('util/redact · 敏感信息脱敏', () => {
  it('识别敏感 key', () => {
    for (const key of ['PASSWORD', 'db_password', 'API_KEY', 'OPENAI_APIKEY', 'SECRET', 'AUTH_TOKEN', 'cookie', 'PRIVATE_KEY']) {
      expect(isSensitiveKey(key)).toBe(true);
    }
    for (const key of ['PORT', 'HOSTNAME', 'IMAGE', 'PATH']) {
      expect(isSensitiveKey(key)).toBe(false);
    }
  });

  it('对自由文本脱敏 KEY=VALUE 与大模型密钥', () => {
    expect(redactText('OLLAMA_API_KEY=abc123')).toBe('OLLAMA_API_KEY=***');
    expect(redactText('PASSWORD: hunter2')).toBe('PASSWORD: ***');
    expect(redactText('token=sk-abcdefghijklmnop')).toBe('token=***');
    expect(redactText('Authorization: Bearer abcdefghijklmnopqrst')).toContain('***');
    expect(redactText('普通日志行')).toBe('普通日志行');
  });

  it('对日志行数组逐行脱敏', () => {
    expect(redactLines(['ok', 'SECRET_TOKEN=xyz'])).toEqual(['ok', 'SECRET_TOKEN=***']);
  });

  it('对象浅层脱敏保留非敏感字段', () => {
    expect(redactRecord({ port: 8080, apiKey: 'k' })).toEqual({ port: 8080, apiKey: '***' });
  });

  it('容器环境变量列表转脱敏对象', () => {
    expect(redactEnvList(['PATH=/usr/bin', 'DB_PASSWORD=s3cr3t', 'TS_AUTHKEY=tskey-x'])).toEqual({
      PATH: '/usr/bin',
      DB_PASSWORD: '***',
      TS_AUTHKEY: '***',
    });
    expect(redactEnvList(undefined)).toEqual({});
  });
});

describe('util/format', () => {
  it('字节格式化使用二进制单位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.00 KB');
    expect(formatBytes(1536, 1)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 3)).toBe('1.00 GB');
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
  });

  it('百分比与四舍五入', () => {
    expect(percentOf(50, 100)).toBe(50);
    expect(percentOf(1, 3, 2)).toBe(33.33);
    expect(percentOf(1, 0)).toBeNull();
    expect(round(null)).toBeNull();
    expect(round(1.2345, 2)).toBe(1.23);
  });

  it('时长格式化', () => {
    expect(formatDuration(30)).toBe('30秒');
    expect(formatDuration(90)).toBe('1分');
    expect(formatDuration(3700)).toBe('1小时 1分');
    expect(formatDuration(90000)).toBe('1天 1小时');
  });

  it('解析 Docker 时间戳并过滤零值', () => {
    expect(parseDockerTime('2026-02-25T06:00:00Z')?.toISOString()).toBe('2026-02-25T06:00:00.000Z');
    expect(parseDockerTime('0001-01-01T00:00:00Z')).toBeNull();
    expect(parseDockerTime('')).toBeNull();
    expect(parseDockerTime(undefined)).toBeNull();
    expect(toIso(null)).toBeNull();
  });

  it('日志行规范化会剥离 ANSI 并窗口化', () => {
    const { lines, truncated } = normalizeLines('\u001b[31merror\u001b[0m\nok\n\nfoo\n', 2);
    expect(lines).toEqual(['ok', 'foo']);
    expect(truncated).toBe(true);
  });
});

describe('util/proc · /proc 解析', () => {
  it('解析 /proc/stat 首行', () => {
    const content = 'cpu  100 0 50 1000 10 0 0 0 0 0\ncpu0 50 0 25 500 5 0 0 0 0 0\n';
    const times = parseProcStat(content);
    expect(times).not.toBeNull();
    expect(times?.user).toBe(100);
    expect(times?.system).toBe(50);
    expect(times?.idle).toBe(1000);
    expect(times?.iowait).toBe(10);
    expect(times?.idleAll).toBe(1010);
    expect(times?.total).toBe(1160);
  });

  it('解析各核心行', () => {
    const content = 'cpu  100 0 50 1000 0 0 0 0\ncpu0 50 0 25 500 0 0 0 0\ncpu1 50 0 25 500 0 0 0 0\n';
    const cores = parseProcStatPerCore(content);
    expect(cores).toHaveLength(2);
    expect(cores[0]).toEqual({ index: 0, total: 575, idleAll: 500 });
  });

  it('解析 /proc/meminfo（kB → 字节）', () => {
    const content = [
      'MemTotal:       16000000 kB',
      'MemFree:         2000000 kB',
      'MemAvailable:    4000000 kB',
      'Buffers:          100000 kB',
      'Cached:          3000000 kB',
      'SwapTotal:       2000000 kB',
      'SwapFree:        1500000 kB',
    ].join('\n');
    const mem = parseMemInfo(content);
    expect(mem?.totalBytes).toBe(16000000 * 1024);
    expect(mem?.availableBytes).toBe(4000000 * 1024);
    expect(mem?.usedBytes).toBe((16000000 - 4000000) * 1024);
    expect(mem?.swapUsedBytes).toBe(500000 * 1024);
  });

  it('无 MemAvailable 时用 Free+Cached+Buffers 兜底', () => {
    const content = ['MemTotal: 1000 kB', 'MemFree: 100 kB', 'Cached: 200 kB', 'Buffers: 50 kB'].join('\n');
    const mem = parseMemInfo(content);
    expect(mem?.availableBytes).toBe(350 * 1024);
  });

  it('解析运行时长与负载', () => {
    expect(parseProcUptime('12345.67 98765.43\n')).toBeCloseTo(12345.67);
    expect(parseLoadAvg('0.52 0.48 0.45 1/500 12345')).toEqual([0.52, 0.48, 0.45]);
  });

  it('解析 CPU 型号', () => {
    expect(parseCpuModel('vendor_id : GenuineIntel\nmodel name : Intel(R) Core(TM) i7-13650HX\n')).toBe(
      'Intel(R) Core(TM) i7-13650HX',
    );
  });

  it('CPU 使用率由两次采样差值计算', () => {
    const prev = { user: 0, nice: 0, system: 0, idle: 100, iowait: 0, irq: 0, softirq: 0, steal: 0, total: 100, idleAll: 100 };
    const next = { user: 50, nice: 0, system: 0, idle: 150, iowait: 0, irq: 0, softirq: 0, steal: 0, total: 200, idleAll: 150 };
    // 总增量 100，空闲增量 50 → 忙碌 50%
    expect(cpuPercentBetween(prev, next)).toBeCloseTo(50);
  });

  it('无增量时返回 null（避免除零给出假读数）', () => {
    const same = { user: 0, nice: 0, system: 0, idle: 100, iowait: 0, irq: 0, softirq: 0, steal: 0, total: 100, idleAll: 100 };
    expect(cpuPercentBetween(same, same)).toBeNull();
  });

  it('os.cpus() 兜底路径返回可用的累计值', () => {
    const times = osCpusToCpuTimes();
    // 运行测试的机器必有 CPU
    expect(times).not.toBeNull();
    expect(times?.total).toBeGreaterThan(0);
    expect(times?.idleAll).toBeGreaterThanOrEqual(0);
  });
});

describe('util/dockerStream · Docker 日志解复用', () => {
  /** 构造一个多路复用帧。 */
  const frame = (streamType: number, text: string): Buffer => {
    const payload = Buffer.from(text, 'utf8');
    const header = Buffer.alloc(8);
    header.writeUInt8(streamType, 0);
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  };

  it('分离 stdout 与 stderr', () => {
    const buffer = Buffer.concat([frame(1, 'hello\n'), frame(2, 'oops\n'), frame(1, 'world\n')]);
    const result = demuxDockerLogs(buffer, false);
    expect(result.stdout).toBe('hello\nworld\n');
    expect(result.stderr).toBe('oops\n');
    expect(result.combined).toBe('hello\noops\nworld\n');
  });

  it('TTY 容器直接当作文本', () => {
    const result = demuxDockerLogs(Buffer.from('plain text\n'), true);
    expect(result.stdout).toBe('plain text\n');
    expect(result.stderr).toBe('');
  });

  it('无有效帧时退化为纯文本', () => {
    const result = demuxDockerLogs(Buffer.from('no headers here'), false);
    expect(result.combined).toBe('no headers here');
  });

  it('尾部不完整帧作为文本追加，不丢日志', () => {
    const partial = Buffer.concat([frame(1, 'ok\n'), Buffer.from('dangling')]);
    const result = demuxDockerLogs(partial, false);
    expect(result.combined).toContain('ok');
    expect(result.combined).toContain('dangling');
  });
});

describe('util/cache · TtlCache', () => {
  it('命中缓存时不重复调用 loader', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    let calls = 0;
    const loader = async (): Promise<number> => {
      calls += 1;
      return 42;
    };
    expect(await cache.get('k', loader)).toBe(42);
    expect(await cache.get('k', loader)).toBe(42);
    expect(calls).toBe(1);
  });

  it('TTL 过期后重新加载', async () => {
    const cache = new TtlCache<string>({ ttlMs: 10 });
    let calls = 0;
    const loader = async (): Promise<string> => {
      calls += 1;
      return `v${calls}`;
    };
    await cache.get('k', loader);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await cache.get('k', loader)).toBe('v2');
    expect(calls).toBe(2);
  });

  it('并发同 key 只触发一次 loader（single-flight）', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    let calls = 0;
    const loader = async (): Promise<number> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return calls;
    };
    const results = await Promise.all([cache.get('k', loader), cache.get('k', loader), cache.get('k', loader)]);
    expect(calls).toBe(1);
    expect(results).toEqual([1, 1, 1]);
  });

  it('loader 抛错不写缓存', async () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    let calls = 0;
    const loader = async (): Promise<number> => {
      calls += 1;
      throw new Error('boom');
    };
    await expect(cache.get('k', loader)).rejects.toThrow('boom');
    await expect(cache.get('k', loader)).rejects.toThrow('boom');
    expect(calls).toBe(2);
  });

  it('按前缀删除', () => {
    const cache = new TtlCache<number>({ ttlMs: 1000 });
    cache.set('tool:a', 1);
    cache.set('tool:b', 2);
    cache.set('other', 3);
    expect(cache.deleteByPrefix('tool:')).toBe(2);
    expect(cache.peek('other')).toBe(3);
  });
});
