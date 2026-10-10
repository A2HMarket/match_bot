import { describe, expect, it } from 'vitest';
import { assertSafeXhsKeyword, buildSearchQuery, UnsafeQueryError } from '../src/query.js';

describe('buildSearchQuery', () => {
  it('joins need and area and appends London', () => {
    expect(buildSearchQuery({ need: 'Chinese birthday cake', area: 'Battersea' })).toBe(
      'Chinese birthday cake Battersea London',
    );
    expect(buildSearchQuery({ need: 'locksmith', area: 'E15' })).toBe('locksmith E15 London');
  });
  it('does not repeat London', () => {
    expect(buildSearchQuery({ need: 'piano tuner north London' })).toBe('piano tuner north London');
  });
  // Tavily 会留存查询：任何像个人信息的东西都必须在出网前被拒
  it.each([
    ['a phone number', { need: 'call 07700 900123 locksmith' }],
    ['a long number', { need: 'locksmith 1234567' }],
    ['an email or handle', { need: 'ask @alice for cake' }],
    ['a URL', { need: 'https://example.com cake' }],
    ['a full postcode with house number in area', { need: 'plumber', area: '12 Baker St NW1 6XE' }],
    ['something far too long', { need: 'x'.repeat(61) }],
    ['markup or symbols', { need: 'cake <script>' }],
  ])('rejects %s', (_n, q) => {
    expect(() => buildSearchQuery(q)).toThrow(UnsafeQueryError);
  });
  it('accepts non-Latin letters', () => {
    expect(buildSearchQuery({ need: '华人理发店', area: 'Soho' })).toBe('华人理发店 Soho London');
  });
});

describe('assertSafeXhsKeyword', () => {
  it('allows public date and exhibit-number queries', () => {
    expect(assertSafeXhsKeyword('伦敦 2026年10月 展览')).toBe('伦敦 2026年10月 展览');
    expect(assertSafeXhsKeyword('伦敦 1015 梦华录')).toBe('伦敦 1015 梦华录');
    expect(assertSafeXhsKeyword('Knit + Stitch London Alexandra Palace 2026')).toBe(
      'Knit + Stitch London Alexandra Palace 2026',
    );
  });
  it.each([
    '找我 07700 900123',
    'user@example.com',
    '@alice 看展',
    'https://example.com',
    '<script>',
    '123456',
    'NW1 6XE 看展',
    '+44 7700 900123',
  ])('rejects private or unsafe query: %s', (keyword) => {
    expect(() => assertSafeXhsKeyword(keyword)).toThrow(UnsafeQueryError);
  });
});
