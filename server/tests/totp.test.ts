/**
 * TOTP 纯函数核心单测。
 *
 * 关键点是**RFC 6238 官方测试向量**：TOTP 最容易出错的三个地方
 * （Base32 编解码、动态截断、时间步取整）都能被这组向量一次性打住，
 * 自己"生成再校验"的往返测试反而抓不到（两端错得一样就仍然自洽）。
 */
import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RECOVERY_CODE_COUNT,
  TOTP_DIGITS,
  TOTP_PERIOD_SECONDS,
  buildOtpauthUri,
  decodeBase32,
  encodeBase32,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  normalizeRecoveryCode,
  totpCode,
  totpCodeAt,
  verifyTotp,
} from '../src/modules/auth/totp.js';

/** RFC 6238 附录 B 的 SHA1 种子：ASCII 字符串 "12345678901234567890"。 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

/** 官方向量（SHA1）：时间（秒）→ 8 位码。 */
const RFC_VECTORS: ReadonlyArray<{ time: number; code8: string }> = [
  { time: 59, code8: '94287082' },
  { time: 1111111109, code8: '07081804' },
  { time: 1111111111, code8: '14050471' },
  { time: 1234567890, code8: '89005924' },
  { time: 2000000000, code8: '69279037' },
  { time: 20000000000, code8: '65353130' },
];

describe('totp · RFC 6238 官方向量', () => {
  it('8 位码与官方向量逐条一致', () => {
    for (const vector of RFC_VECTORS) {
      const counter = Math.floor(vector.time / TOTP_PERIOD_SECONDS);
      expect(totpCodeAt(RFC_SECRET, counter, 8), `T=${vector.time}`).toBe(vector.code8);
    }
  });

  it('默认 6 位码等于 8 位码的后 6 位', () => {
    for (const vector of RFC_VECTORS) {
      const counter = Math.floor(vector.time / TOTP_PERIOD_SECONDS);
      expect(totpCodeAt(RFC_SECRET, counter), `T=${vector.time}`).toBe(vector.code8.slice(-6));
    }
  });

  it('种子由 ASCII 字符串正确 Base32 编码（向量前置条件）', () => {
    expect(encodeBase32(Buffer.from('12345678901234567890', 'ascii'))).toBe(RFC_SECRET);
    expect(decodeBase32(RFC_SECRET).toString('ascii')).toBe('12345678901234567890');
  });
});

describe('totp · Base32', () => {
  it('往返一致（任意字节长度）', () => {
    for (const length of [1, 5, 10, 20, 32, 64]) {
      const input = crypto.randomBytes(length);
      expect(decodeBase32(encodeBase32(input)).equals(input)).toBe(true);
    }
  });

  it('编码结果只含 RFC 4648 字母表且无 padding', () => {
    const encoded = encodeBase32(crypto.randomBytes(20));
    expect(encoded).toMatch(/^[A-Z2-7]+$/);
    expect(encoded).not.toContain('=');
  });

  it('解码容忍小写、空格、连字符与 = padding', () => {
    const expected = decodeBase32(RFC_SECRET);
    expect(decodeBase32(RFC_SECRET.toLowerCase()).equals(expected)).toBe(true);
    expect(decodeBase32(`${RFC_SECRET.slice(0, 8)} ${RFC_SECRET.slice(8)}`).equals(expected)).toBe(true);
    expect(decodeBase32(`${RFC_SECRET.slice(0, 8)}-${RFC_SECRET.slice(8)}`).equals(expected)).toBe(true);
    expect(decodeBase32(`${RFC_SECRET}====`).equals(expected)).toBe(true);
  });

  it('非法字符抛错（而不是静默忽略，避免把抄错的种子解成"永远对不上"的种子）', () => {
    expect(() => decodeBase32('ABC0DEF')).toThrow(/非法字符/);
    expect(() => decodeBase32('ABC1DEF')).toThrow(/非法字符/);
    expect(() => decodeBase32('AB@CD')).toThrow(/非法字符/);
  });

  it('空输入解码为空 Buffer', () => {
    expect(decodeBase32('').length).toBe(0);
    expect(decodeBase32('   ').length).toBe(0);
  });
});

describe('totp · 校验与时间窗', () => {
  const secret = generateTotpSecret();
  const now = 1_700_000_000_000;

  it('当前时间的码通过，并返回命中的时间步', () => {
    const code = totpCode(secret, now);
    const result = verifyTotp(secret, code, { now });
    expect(result.ok).toBe(true);
    expect(result.counter).toBe(Math.floor(now / 1000 / TOTP_PERIOD_SECONDS));
  });

  it('容忍前后一个周期，拒绝更远的周期', () => {
    const previous = totpCode(secret, now - TOTP_PERIOD_SECONDS * 1000);
    const next = totpCode(secret, now + TOTP_PERIOD_SECONDS * 1000);
    const farPrevious = totpCode(secret, now - TOTP_PERIOD_SECONDS * 3 * 1000);

    expect(verifyTotp(secret, previous, { now, window: 1 }).ok).toBe(true);
    expect(verifyTotp(secret, next, { now, window: 1 }).ok).toBe(true);
    expect(verifyTotp(secret, farPrevious, { now, window: 1 }).ok).toBe(false);
    expect(verifyTotp(secret, previous, { now, window: 0 }).ok).toBe(false);
  });

  it('位数或字符不合法 → malformed', () => {
    expect(verifyTotp(secret, '12345', { now })).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyTotp(secret, '1234567', { now })).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyTotp(secret, 'abcdef', { now })).toMatchObject({ ok: false, reason: 'malformed' });
    expect(verifyTotp(secret, '', { now })).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('合法但错误的码 → mismatch', () => {
    const wrong = String((Number(totpCode(secret, now)) + 1) % 1_000_000).padStart(TOTP_DIGITS, '0');
    expect(verifyTotp(secret, wrong, { now })).toMatchObject({ ok: false, reason: 'mismatch' });
  });

  it('空种子 → malformed，不抛错', () => {
    expect(verifyTotp('', '123456', { now })).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('防重放：同一时间步用过一次后再用 → replayed', () => {
    const code = totpCode(secret, now);
    const counter = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
    expect(verifyTotp(secret, code, { now, lastCounter: counter })).toMatchObject({ ok: false, reason: 'replayed' });
    // 更早的时间步同样拒绝（防止"用掉一个码再回退窗口重放"）
    expect(verifyTotp(secret, code, { now, lastCounter: counter + 1 })).toMatchObject({ ok: false, reason: 'replayed' });
    // 记录早于当前步则正常通过
    expect(verifyTotp(secret, code, { now, lastCounter: counter - 5 }).ok).toBe(true);
  });

  it('时间步边界：同一周期内同码，跨周期换码', () => {
    const base = 500_000 * TOTP_PERIOD_SECONDS * 1000;
    expect(totpCode(secret, base)).toBe(totpCode(secret, base + TOTP_PERIOD_SECONDS * 1000 - 1));
    expect(totpCode(secret, base)).not.toBe(totpCode(secret, base + TOTP_PERIOD_SECONDS * 1000));
  });

  it('连续计算不抛错（1e3 次）', () => {
    let last = '';
    for (let i = 0; i < 1000; i += 1) last = totpCode(secret, now + i * 1000);
    expect(last).toMatch(/^\d{6}$/);
  });
});

describe('totp · 种子生成', () => {
  it('每次不同、长度为 20 字节的 Base32（32 个字符）', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Z2-7]{32}$/);
    expect(decodeBase32(a).length).toBe(20);
  });
});

describe('totp · otpauth URI', () => {
  it('包含全部必需参数', () => {
    const uri = buildOtpauthUri({ secret: RFC_SECRET, issuer: 'HomePort', account: 'admin' });
    expect(uri.startsWith('otpauth://totp/HomePort:admin?')).toBe(true);
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('issuer=HomePort');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('issuer / account 里的空格与冒号被正确编码（空格用 %20 而不是 +）', () => {
    const uri = buildOtpauthUri({ secret: RFC_SECRET, issuer: 'Home Port', account: 'a b:c' });
    expect(uri).toContain('Home%20Port:a%20b%3Ac');
    expect(uri).toContain('issuer=Home%20Port');
    expect(uri).not.toContain('+');
  });

  it('可覆盖位数与周期', () => {
    const uri = buildOtpauthUri({ secret: RFC_SECRET, issuer: 'I', account: 'a', digits: 8, period: 60 });
    expect(uri).toContain('digits=8');
    expect(uri).toContain('period=60');
  });
});

describe('totp · 恢复码', () => {
  it('默认生成 10 个，格式为 XXXX-XXXX 且不含易混字符', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(RECOVERY_CODE_COUNT);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });

  it('同批内不重复（不同批次也可能不同）', () => {
    const codes = generateRecoveryCodes(20);
    expect(new Set(codes).size).toBe(20);
    expect(generateRecoveryCodes(10)).not.toEqual(generateRecoveryCodes(10));
  });

  it('归一化：去分隔符、转大写', () => {
    expect(normalizeRecoveryCode('abcd-efgh')).toBe('ABCDEFGH');
    expect(normalizeRecoveryCode(' abcd efgh ')).toBe('ABCDEFGH');
    expect(normalizeRecoveryCode('ABCDEFGH')).toBe('ABCDEFGH');
  });

  it('摘要稳定、长度 64、且不含明文', () => {
    const code = generateRecoveryCodes(1)[0]!;
    const hash = hashRecoveryCode(code);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashRecoveryCode(code.toLowerCase()));
    expect(hash).toBe(hashRecoveryCode(` ${code} `));
    expect(hash).not.toContain(code.replace('-', ''));
  });
});