import { describe, expect, it } from 'vitest';
import { isBlacklisted } from '../src/blacklist.js';

describe('isBlacklisted', () => {
  it.each([
    ['有人换汇吗 人民币换英镑', true],
    ['need USDT for cash', true],
    ['can someone pay on my behalf and I transfer later', true],
    ['need a van on sunday', false],
    ['exchange student looking for a room', false],
    ['кто-нибудь обменяю фунты', true],
    ['preciso trocar libras, câmbio', true],
  ])('%s -> %s', (text, expected) => {
    expect(isBlacklisted(text)).toBe(expected);
  });
});
