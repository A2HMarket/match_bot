import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from '../src/crypto.js';

const KEY = 'a-snapshot-key-at-least-16-chars';
const PLAIN = '{"originalInput":"周日有人有 van 吗，E14 搬到 SE1"}';

describe('encrypt / decrypt', () => {
  it('round-trips, including non-ascii', () => {
    expect(decrypt(encrypt(PLAIN, KEY), KEY)).toBe(PLAIN);
  });

  it('never emits the plaintext and is non-deterministic across calls', () => {
    // 随机 IV：同一份快照两次加密必须不同，否则能从密文相等推断内容相等。
    const a = encrypt(PLAIN, KEY);
    const b = encrypt(PLAIN, KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain('E14');
    expect(decrypt(b, KEY)).toBe(PLAIN);
  });

  it('carries a version prefix so the format can be migrated', () => {
    expect(encrypt(PLAIN, KEY).startsWith('v1.')).toBe(true);
  });

  it('rejects a tampered ciphertext instead of returning garbage', () => {
    // GCM 认证标签：快照来自数据库，被改过就必须失败而不是解出半截内容。
    const [v, iv, tag, data] = encrypt(PLAIN, KEY).split('.') as [string, string, string, string];
    const flipped = Buffer.from(data, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64')].join('.'), KEY)).toThrow();
  });

  it('rejects a tampered auth tag', () => {
    const [v, iv, tag, data] = encrypt(PLAIN, KEY).split('.') as [string, string, string, string];
    const flipped = Buffer.from(tag, 'base64');
    flipped[0] ^= 0xff;
    expect(() => decrypt([v, iv, flipped.toString('base64'), data].join('.'), KEY)).toThrow();
  });

  it('rejects the wrong key', () => {
    expect(() => decrypt(encrypt(PLAIN, KEY), 'another-key-at-least-16-chars')).toThrow();
  });

  it('rejects a malformed payload', () => {
    expect(() => decrypt('not-encrypted', KEY)).toThrow(/unrecognized/);
    expect(() => decrypt('v2.a.b.c', KEY)).toThrow(/unrecognized/);
  });
});
