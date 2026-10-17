import { expect, it } from 'vitest';
import { hasUnsupportedActionClaim, hasUnsupportedModelAction } from '../src/reply-boundaries.js';

it.each([
  '我也会继续留意明确写包bills的房源。',
  '我可以帮你盯着，有合适的通知你。',
  'I will keep an eye on new listings and let you know.',
  "I'll monitor new offers for you.",
  '我已经联系了卖家。',
  '我替你预约好了。',
  'I have booked the session for you.',
  'I have already booked it for you.',
  '我会优先问书桌那单能不能拆开搬走。',
  '我会先联系卖家确认。',
])('rejects an action or background promise without a capability/receipt: %s', (text) => {
  expect(hasUnsupportedActionClaim(text)).toBe(true);
});
it('checks authored questions and intros but not a quoted provider or a user demand summary', () => {
  expect(hasUnsupportedModelAction({ question: '我会继续留意，你方便哪天？' })).toBe(true);
  expect(hasUnsupportedModelAction({ intro: '我会继续留意' })).toBe(true);
  expect(
    hasUnsupportedModelAction({
      sources: [{ text: '我会继续留意' }],
      demandSummary: '用户说我会继续留意',
    }),
  ).toBe(false);
});
it.each([
  '建议你留意新房源，重新来问时我可以再查。',
  '我不能替你监控库存，联系前请确认。',
  'If you ask again later, I can search then.',
  'I cannot monitor listings or contact sellers for you.',
  '我先比较这两条现有结果。',
  '我会先问你哪天方便？',
  '你已经预约好了，就按你确认的时间安排。',
])('allows current advice, explicit limits and user actions: %s', (text) => {
  expect(hasUnsupportedActionClaim(text)).toBe(false);
});
