import { describe, expect, it } from 'vitest';
import { inboundRuleReason } from '../src/inbound-rule.js';
describe('shared admission rules', () => {
  it.each([
    ['  ', true, true, true, 'empty_text'],
    ['/start', true, true, true, 'command'],
    ['有人换汇吗', true, true, true, 'blacklist'],
    ['找书桌', false, false, false, 'group_not_registered'],
    ['找书桌', false, true, false, 'group_inactive'],
    ['找书桌', false, true, true, null],
    ['找书桌', true, false, false, null],
  ] as const)('checks %s', (text, isPrivate, hasGroup, isGroupActive, expected) => {
    expect(inboundRuleReason({ text, isPrivate, hasGroup, isGroupActive })).toBe(expected);
  });
});
