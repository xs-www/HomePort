/**
 * `web/src/lib/format.ts` 单元测试（S0-05）。
 *
 * 每个导出函数都覆盖：正常值、0/边界值、极大值、以及 NaN / 负数 / null / undefined 等非法输入。
 * 时间相关用例用 `vi.useFakeTimers()` + `vi.setSystemTime()` 固定“现在”，
 * 且所有日期都用**本地时间**构造再转 ISO，避免受运行机器的时区影响。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  describeConnection,
  describeContainerState,
  describeHealth,
  describeOs,
  describeReachability,
  formatBytes,
  formatDateTime,
  formatLatency,
  formatPercent,
  formatRate,
  formatRelative,
  formatSince,
  formatUptime,
  truncate,
} from '../src/lib/format.js';

/** 非法数字输入的通用占位符。 */
const DASH = '—';

describe('formatBytes', () => {
  it('按 1024 进制换算并保留小数位', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 ** 2)).toBe('1.0 MB');
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1.5 GB');
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
    expect(formatBytes(1024 ** 5)).toBe('1.0 PB');
  });

  it('超过 PB 时封顶在 PB 单位（极大值）', () => {
    expect(formatBytes(1024 ** 6)).toBe('1024.0 PB');
    expect(formatBytes(Number.MAX_SAFE_INTEGER)).toBe('8.0 PB');
  });

  it('B 级不带小数，digits 参数只影响更大单位', () => {
    expect(formatBytes(512, 3)).toBe('512 B');
    expect(formatBytes(1536, 0)).toBe('2 KB');
    expect(formatBytes(1536, 2)).toBe('1.50 KB');
  });

  it('非法输入一律返回占位符', () => {
    expect(formatBytes(null)).toBe(DASH);
    expect(formatBytes(undefined)).toBe(DASH);
    expect(formatBytes(Number.NaN)).toBe(DASH);
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe(DASH);
    expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe(DASH);
    expect(formatBytes(-1)).toBe(DASH);
    expect(formatBytes(-1024)).toBe(DASH);
  });
});

describe('formatPercent', () => {
  it('正常值与 0', () => {
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(48.12)).toBe('48.1%');
    expect(formatPercent(100)).toBe('100.0%');
    expect(formatPercent(33.333, 0)).toBe('33%');
    expect(formatPercent(33.333, 3)).toBe('33.333%');
  });

  it('极大值与非法输入', () => {
    expect(formatPercent(1e9)).toBe('1000000000.0%');
    expect(formatPercent(-5.5)).toBe('-5.5%');
    expect(formatPercent(null)).toBe(DASH);
    expect(formatPercent(undefined)).toBe(DASH);
    expect(formatPercent(Number.NaN)).toBe(DASH);
    expect(formatPercent(Number.POSITIVE_INFINITY)).toBe(DASH);
  });
});

describe('formatUptime', () => {
  it('按天/小时/分/秒分段展示', () => {
    expect(formatUptime(0)).toBe('0 秒');
    expect(formatUptime(59)).toBe('59 秒');
    expect(formatUptime(60)).toBe('1 分');
    expect(formatUptime(3599)).toBe('59 分');
    expect(formatUptime(3600)).toBe('1 小时 0 分');
    expect(formatUptime(3661)).toBe('1 小时 1 分');
    expect(formatUptime(86400)).toBe('1 天 0 小时');
    expect(formatUptime(86400 + 3600 * 5)).toBe('1 天 5 小时');
    expect(formatUptime(2 * 86400 + 3600 * 5 + 60 * 7)).toBe('2 天 5 小时');
  });

  it('小数秒向下取整', () => {
    expect(formatUptime(90.9)).toBe('1 分');
    expect(formatUptime(0.9)).toBe('0 秒');
  });

  it('极大值不溢出、非法输入返回占位符', () => {
    expect(formatUptime(365 * 86400)).toBe('365 天 0 小时');
    expect(formatUptime(Number.MAX_SAFE_INTEGER)).toContain('天');
    expect(formatUptime(null)).toBe(DASH);
    expect(formatUptime(undefined)).toBe(DASH);
    expect(formatUptime(Number.NaN)).toBe(DASH);
    expect(formatUptime(-1)).toBe(DASH);
  });
});

describe('formatDateTime', () => {
  it('ISO → 本地 YYYY-MM-DD HH:mm（省略秒）', () => {
    const iso = new Date(2026, 1, 25, 10, 0, 37, 500).toISOString();
    expect(formatDateTime(iso)).toBe('2026-02-25 10:00');
    expect(formatDateTime(iso)).not.toContain('37');
  });

  it('个位数月/日/时/分补零', () => {
    expect(formatDateTime(new Date(2026, 0, 5, 3, 7).toISOString())).toBe('2026-01-05 03:07');
  });

  it('空值与非法字符串返回占位符', () => {
    expect(formatDateTime(null)).toBe(DASH);
    expect(formatDateTime(undefined)).toBe(DASH);
    expect(formatDateTime('')).toBe(DASH);
    expect(formatDateTime('not-a-date')).toBe(DASH);
    expect(formatDateTime('2026-13-45T99:99:99Z')).toBe(DASH);
  });
});

describe('formatRelative（固定“现在”为 2026-02-25 12:00:00 本地时间）', () => {
  const NOW = new Date(2026, 1, 25, 12, 0, 0);

  /** 相对“现在”偏移若干秒的 ISO 字符串（负数表示未来）。 */
  const isoAgo = (seconds: number): string => new Date(NOW.getTime() - seconds * 1000).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('刚刚 / 秒前 / 分钟前 / 小时前 / 天前', () => {
    expect(formatRelative(isoAgo(0))).toBe('刚刚');
    expect(formatRelative(isoAgo(9))).toBe('刚刚');
    expect(formatRelative(isoAgo(10))).toBe('10 秒前');
    expect(formatRelative(isoAgo(59))).toBe('59 秒前');
    expect(formatRelative(isoAgo(60))).toBe('1 分钟前');
    expect(formatRelative(isoAgo(180))).toBe('3 分钟前');
    expect(formatRelative(isoAgo(3600))).toBe('1 小时前');
    expect(formatRelative(isoAgo(5400))).toBe('2 小时前');
    expect(formatRelative(isoAgo(86400))).toBe('1 天前');
    expect(formatRelative(isoAgo(86400 * 29))).toBe('29 天前');
  });

  it('超过 30 天回退为绝对时间', () => {
    const iso = new Date(2026, 0, 1, 8, 30).toISOString();
    expect(formatRelative(iso)).toBe('2026-01-01 08:30');
  });

  it('3599 秒显示为「60 分钟前」（取整边界，现状记录）', () => {
    // 已知瑕疵：Math.round(3599 / 60) === 60，还没跨入「小时前」分支（见报告）。
    expect(formatRelative(isoAgo(3599))).toBe('60 分钟前');
  });

  it('未来时间给出「后」文案，超过 1 小时回退为绝对时间', () => {
    expect(formatRelative(isoAgo(-30))).toBe('30 秒后');
    expect(formatRelative(isoAgo(-120))).toBe('2 分钟后');
    expect(formatRelative(isoAgo(-3600))).toBe('2026-02-25 13:00');
  });

  it('空值与非法字符串返回占位符', () => {
    expect(formatRelative(null)).toBe(DASH);
    expect(formatRelative(undefined)).toBe(DASH);
    expect(formatRelative('')).toBe(DASH);
    expect(formatRelative('nope')).toBe(DASH);
  });
});

describe('formatLatency', () => {
  it('小于 1 秒用毫秒，否则用秒', () => {
    expect(formatLatency(0)).toBe('0 ms');
    expect(formatLatency(0.4)).toBe('0 ms');
    expect(formatLatency(12.6)).toBe('13 ms');
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(1000)).toBe('1.0 s');
    expect(formatLatency(1500)).toBe('1.5 s');
    expect(formatLatency(60_000)).toBe('60.0 s');
  });

  it('负数不被拦截（源码无负数判断），非法输入返回占位符', () => {
    expect(formatLatency(-5)).toBe('-5 ms');
    expect(formatLatency(null)).toBe(DASH);
    expect(formatLatency(undefined)).toBe(DASH);
    expect(formatLatency(Number.NaN)).toBe(DASH);
    expect(formatLatency(Number.POSITIVE_INFINITY)).toBe(DASH);
  });
});

describe('formatRate', () => {
  it('复用 formatBytes 并追加 /s', () => {
    expect(formatRate(0)).toBe('0 B/s');
    expect(formatRate(1536)).toBe('1.5 KB/s');
    expect(formatRate(1024 ** 3)).toBe('1.0 GB/s');
  });

  it('非法输入的占位符处理', () => {
    expect(formatRate(null)).toBe(DASH);
    expect(formatRate(undefined)).toBe(DASH);
    expect(formatRate(Number.NaN)).toBe(DASH);
    // 已知瑕疵：formatBytes 对负数返回 '—'，这里再拼 /s 得到 '—/s'（见报告）。
    expect(formatRate(-100)).toBe(`${DASH}/s`);
  });
});

describe('describeContainerState', () => {
  it('已知状态映射为中文与颜色语义', () => {
    expect(describeContainerState('running')).toEqual({ label: '运行中', tone: 'ok' });
    expect(describeContainerState('exited')).toEqual({ label: '已停止', tone: 'idle' });
    expect(describeContainerState('paused')).toEqual({ label: '已暂停', tone: 'warn' });
    expect(describeContainerState('restarting')).toEqual({ label: '重启中', tone: 'warn' });
    expect(describeContainerState('created')).toEqual({ label: '已创建', tone: 'idle' });
    expect(describeContainerState('dead')).toEqual({ label: '已失效', tone: 'bad' });
    expect(describeContainerState('removing')).toEqual({ label: '删除中', tone: 'warn' });
  });

  it('未知状态原样展示，空串回退为「未知」', () => {
    expect(describeContainerState('weird')).toEqual({ label: 'weird', tone: 'idle' });
    expect(describeContainerState('')).toEqual({ label: '未知', tone: 'idle' });
  });
});

describe('describeHealth', () => {
  it('已知状态映射为中文', () => {
    expect(describeHealth('healthy')).toEqual({ label: '健康', tone: 'ok' });
    expect(describeHealth('unhealthy')).toEqual({ label: '不健康', tone: 'bad' });
    expect(describeHealth('starting')).toEqual({ label: '启动中', tone: 'warn' });
  });

  it('none / null / 空串返回 null（表示不展示）', () => {
    expect(describeHealth('none')).toBeNull();
    expect(describeHealth(null)).toBeNull();
    expect(describeHealth('')).toBeNull();
  });

  it('未知取值原样展示并归为 idle', () => {
    expect(describeHealth('custom')).toEqual({ label: 'custom', tone: 'idle' });
  });
});

describe('describeReachability', () => {
  it('四种可达性都有标签、语义与提示', () => {
    expect(describeReachability('tailnet')).toEqual({
      label: 'tailnet 可达',
      tone: 'ok',
      hint: 'tailnet 内任意设备均可访问',
    });
    expect(describeReachability('lan')).toEqual({
      label: '仅局域网',
      tone: 'warn',
      hint: '绑定在局域网地址上，tailnet 设备需走子网路由',
    });
    expect(describeReachability('localhost-only')).toEqual({
      label: '仅本机',
      tone: 'warn',
      hint: '绑定在 127.0.0.1，远程无法直接访问',
    });
    expect(describeReachability('none')).toEqual({
      label: '无入口',
      tone: 'idle',
      hint: '没有发布到宿主的端口',
    });
  });

  it('未知取值回退为「无入口」', () => {
    expect(describeReachability('something-else')).toEqual({
      label: '无入口',
      tone: 'idle',
      hint: '没有发布到宿主的端口',
    });
    expect(describeReachability('')).toEqual({
      label: '无入口',
      tone: 'idle',
      hint: '没有发布到宿主的端口',
    });
  });
});

describe('describeOs', () => {
  it('已知系统名映射为友好展示', () => {
    expect(describeOs('windows')).toBe('Windows');
    expect(describeOs('linux')).toBe('Linux');
    expect(describeOs('android')).toBe('Android');
    expect(describeOs('macOS')).toBe('macOS');
    expect(describeOs('iOS')).toBe('iOS');
  });

  it('大小写不敏感回退', () => {
    expect(describeOs('WINDOWS')).toBe('Windows');
    expect(describeOs('Linux')).toBe('Linux');
  });

  it('未知系统名原样展示，空值回退为「未知」', () => {
    expect(describeOs('freebsd')).toBe('freebsd');
    expect(describeOs('')).toBe('未知');
  });
});

describe('describeConnection', () => {
  it('直连/中继/其他', () => {
    expect(describeConnection('direct')).toBe('直连');
    expect(describeConnection('relay')).toBe('中继');
    expect(describeConnection('offline')).toBe('离线');
    expect(describeConnection('')).toBe('离线');
  });
});

describe('truncate', () => {
  it('未超长时原样返回', () => {
    expect(truncate('hello')).toBe('hello');
    expect(truncate('a'.repeat(60))).toBe('a'.repeat(60));
    expect(truncate('')).toBe('');
  });

  it('超长时截断并追加省略号，总长不超过 max', () => {
    const result = truncate('a'.repeat(80));
    expect(result).toBe(`${'a'.repeat(59)}…`);
    expect(result.length).toBe(60);
    expect(truncate('abcdef', 4)).toBe('abc…');
    expect(truncate('abcdef', 1)).toBe('…');
  });

  it('max 为 0 时结果反而长于 max（边界瑕疵，见报告）', () => {
    // max=0 → slice(0, -1) 只砍掉最后一个字符，再补省略号，长度 3 > max。
    expect(truncate('abc', 0)).toBe('ab…');
    expect(truncate('abc', 0).length).toBeGreaterThan(0);
  });
});

describe('formatSince', () => {
  const NOW = new Date(2026, 1, 25, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('空值表示「从未」', () => {
    expect(formatSince(null)).toBe('从未');
    expect(formatSince(undefined)).toBe('从未');
    expect(formatSince('')).toBe('从未');
  });

  it('有值时委托 formatRelative', () => {
    const iso = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    expect(formatSince(iso)).toBe('5 分钟前');
    expect(formatSince('bad-input')).toBe(DASH);
  });
});