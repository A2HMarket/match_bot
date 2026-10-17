import { expect, it } from 'vitest';
import { hasUnqualifiedSellerIdentity } from '../src/seller-identity-claims.js';
it.each([
  '两条只是不同卖家的发帖。',
  '可以跟两位发布者确认取货时间。',
  '下一步分别向两位发帖人确认取货地址。',
  '这两名房东分别有两套房。',
  '椅子属于另一个卖家，不一定能一趟取完。',
  '椅子是另外一位发帖人的。',
  '先问对方是否能同一天取——两件不同卖家，能否一趟拿完尚未确认。',
  '两件是同一卖家，可以一起取。',
  'Different sellers posted these, so arrange two pickups.',
])('rejects identity inferred from anonymous offers: %s', (text) => {
  expect(hasUnqualifiedSellerIdentity(text)).toBe(true);
});
it.each([
  '是否同一卖家还没确认，先问清楚。',
  '两条帖子不代表不同卖家。',
  '如果是不同卖家，需分别确认地址。',
  '同一卖家尚未确认，不能据此安排一起取。',
  '原文称“同一卖家”，仍需核实。',
  'It is not known whether these are different sellers.',
  '你希望同一卖家，现有帖子还无法核实。',
])('allows explicit unknowns, conditional advice and attributed source wording: %s', (text) => {
  expect(hasUnqualifiedSellerIdentity(text)).toBe(false);
});
