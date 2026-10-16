/**
 * `secretBox` 单测：AES-256-GCM 敏感值加密盒。
 *
 * 覆盖：往返、随机 IV、篡改检测、错密钥、密钥轮换、密钥文件读写与权限。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createSecretBox,
  ENCRYPTED_PREFIX,
  encodeKey,
  KEY_BYTES,
  loadOrCreateKey,
  parseKey,
  parsePreviousKeys,
  SecretBoxError,
} from '../src/modules/settings/secretBox.js';

const tmpDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'homeport-secretbox-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('secretBox · 加密与解密', () => {
  const key = crypto.randomBytes(KEY_BYTES);

  it('明文往返一致，且带 enc:v1: 前缀', () => {
    const box = createSecretBox({ key });
    const enc = box.encrypt('tskey-api-abc123');
    expect(enc.startsWith(ENCRYPTED_PREFIX)).toBe(true);
    expect(box.isEncrypted(enc)).toBe(true);
    expect(box.decrypt(enc)).toBe('tskey-api-abc123');
  });

  it('同一明文两次加密得到不同密文（随机 IV，语义安全）', () => {
    const box = createSecretBox({ key });
    const a = box.encrypt('same-value');
    const b = box.encrypt('same-value');
    expect(a).not.toBe(b);
    expect(box.decrypt(a)).toBe('same-value');
    expect(box.decrypt(b)).toBe('same-value');
  });

  it('支持空串与多字节字符', () => {
    const box = createSecretBox({ key });
    expect(box.decrypt(box.encrypt(''))).toBe('');
    expect(box.decrypt(box.encrypt('中文密钥🔐'))).toBe('中文密钥🔐');
  });

  it('对已是密文的输入幂等（不会二次加密）', () => {
    const box = createSecretBox({ key });
    const once = box.encrypt('value');
    expect(box.encrypt(once)).toBe(once);
  });

  it('GCM 认证：密文被篡改时解密失败而不是解出垃圾', () => {
    const box = createSecretBox({ key });
    const enc = box.encrypt('value');
    const blob = Buffer.from(enc.slice(ENCRYPTED_PREFIX.length), 'base64');
    blob[blob.length - 1] = blob[blob.length - 1]! ^ 0xff;
    const tampered = ENCRYPTED_PREFIX + blob.toString('base64');
    expect(() => box.decrypt(tampered)).toThrow(SecretBoxError);
  });

  it('密钥不匹配时解密失败', () => {
    const other = createSecretBox({ key: crypto.randomBytes(KEY_BYTES) });
    const enc = other.encrypt('value');
    expect(() => createSecretBox({ key }).decrypt(enc)).toThrow(/主密钥不匹配/);
  });

  it('非密文（迁移前的旧明文）拒绝解密，避免把明文当密文吞掉', () => {
    const box = createSecretBox({ key });
    expect(box.isEncrypted('tskey-plain')).toBe(false);
    expect(() => box.decrypt('tskey-plain')).toThrow(/不是密文/);
  });

  it('密钥长度不合法直接抛错', () => {
    expect(() => createSecretBox({ key: crypto.randomBytes(16) })).toThrow(SecretBoxError);
  });
});

describe('secretBox · 密钥轮换', () => {
  it('用旧密钥加密的值可用 previousKeys 解开，且被标记为需要轮换', () => {
    const oldKey = crypto.randomBytes(KEY_BYTES);
    const newKey = crypto.randomBytes(KEY_BYTES);
    const legacy = createSecretBox({ key: oldKey }).encrypt('token');

    const rotated = createSecretBox({ key: newKey, previousKeys: [oldKey] });
    expect(rotated.decrypt(legacy)).toBe('token');
    // 仍是老密钥加的 → 调用方可据此在下次写入时升级
    expect(rotated.isCurrentKey(legacy)).toBe(false);

    const reEncrypted = rotated.encrypt(rotated.decrypt(legacy));
    expect(rotated.isCurrentKey(reEncrypted)).toBe(true);
    expect(createSecretBox({ key: newKey }).decrypt(reEncrypted)).toBe('token');
  });

  it('不带 previousKeys 时旧密钥密文无法解开', () => {
    const oldKey = crypto.randomBytes(KEY_BYTES);
    const legacy = createSecretBox({ key: oldKey }).encrypt('token');
    const strict = createSecretBox({ key: crypto.randomBytes(KEY_BYTES) });
    expect(strict.isCurrentKey(legacy)).toBe(false);
    expect(() => strict.decrypt(legacy)).toThrow(SecretBoxError);
  });

  it('非密文视为"无需轮换"', () => {
    const box = createSecretBox({ key: crypto.randomBytes(KEY_BYTES) });
    expect(box.isCurrentKey('plain')).toBe(true);
  });
});

describe('secretBox · 密钥解析', () => {
  const key = crypto.randomBytes(KEY_BYTES);

  it('接受 64 位十六进制、base64 与显式前缀', () => {
    expect(parseKey(key.toString('hex')).equals(key)).toBe(true);
    expect(parseKey(key.toString('base64')).equals(key)).toBe(true);
    expect(parseKey(`hex:${key.toString('hex')}`).equals(key)).toBe(true);
    expect(parseKey(`base64:${key.toString('base64')}`).equals(key)).toBe(true);
  });

  it('长度不符时给出可操作错误', () => {
    expect(() => parseKey('short')).toThrow(/主密钥长度非法/);
    expect(() => parseKey('')).toThrow(/为空/);
  });

  it('encodeKey 与 parseKey 互为逆运算', () => {
    expect(parseKey(encodeKey(key)).equals(key)).toBe(true);
  });

  it('parsePreviousKeys 解析逗号分隔列表并忽略空项', () => {
    const a = crypto.randomBytes(KEY_BYTES);
    const b = crypto.randomBytes(KEY_BYTES);
    const parsed = parsePreviousKeys(`${a.toString('hex')}, ,${b.toString('base64')}`);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.equals(a)).toBe(true);
    expect(parsed[1]!.equals(b)).toBe(true);
    expect(parsePreviousKeys(null)).toEqual([]);
  });

  it('密钥指纹稳定且不泄露密钥', () => {
    const box = createSecretBox({ key });
    const fp = box.keyFingerprint();
    expect(fp).toMatch(/^[0-9a-f]{8}$/);
    expect(fp).toBe(createSecretBox({ key }).keyFingerprint());
    expect(fp).not.toBe(createSecretBox({ key: crypto.randomBytes(KEY_BYTES) }).keyFingerprint());
    expect(key.toString('hex')).not.toContain(fp);
  });
});

describe('secretBox · 密钥文件', () => {
  it('文件不存在时生成 0600 权限的新密钥，且第二次调用复用同一把', () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, 'nested', 'secret.key');

    const first = loadOrCreateKey({ explicit: null, keyFile });
    expect(first.source).toBe('generated');
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(parseKey(fs.readFileSync(keyFile, 'utf8')).equals(first.key)).toBe(true);

    const second = loadOrCreateKey({ explicit: null, keyFile });
    expect(second.source).toBe('file');
    expect(second.key.equals(first.key)).toBe(true);

    if (process.platform !== 'win32') {
      expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
    }
  });

  it('显式密钥优先于密钥文件', () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, 'secret.key');
    const explicit = crypto.randomBytes(KEY_BYTES);
    loadOrCreateKey({ explicit: null, keyFile });

    const loaded = loadOrCreateKey({ explicit: explicit.toString('hex'), keyFile });
    expect(loaded.source).toBe('env');
    expect(loaded.key.equals(explicit)).toBe(true);
  });

  it('密钥文件为空时报错而不是静默生成新密钥（否则老数据永远解不开）', () => {
    const dir = tmpDir();
    const keyFile = path.join(dir, 'secret.key');
    fs.writeFileSync(keyFile, '   \n');
    expect(() => loadOrCreateKey({ explicit: null, keyFile })).toThrow(/为空/);
  });
});