import { expect, it, vi } from 'vitest';
import { evaluateOutbound } from '../src/questions/outbound.js';

it('preserves user requirements separately from provider source evidence', async () => {
  const evaluate = vi.fn(() =>
    Promise.resolve({
      ok: true,
      answers: {
        worth_replying: { type: 'score', score: 3 },
        language_ok: { type: 'noul', noul: 1 },
        mentions_unverified: { type: 'noul', noul: 0 },
      },
    }),
  );
  await evaluateOutbound({ evaluate } as never, {
    draft: '书桌£40，椅子£45，符合各自£70/£50的预算。',
    demand: { category: 'second_hand', confidence: 1 },
    requestContext: '书桌上限£70；椅子上限£50',
    supplierSummaries: ['书桌£40', '椅子£45'],
    recentReplies: [],
    inputRef: 'synthetic',
    phase: 0,
  });
  const [call] = evaluate.mock.calls[0] as unknown as [{ state: unknown }];
  expect(call.state).toMatchObject({
    request_context: '书桌上限£70；椅子上限£50',
    source_evidence: ['书桌£40', '椅子£45'],
  });
});
