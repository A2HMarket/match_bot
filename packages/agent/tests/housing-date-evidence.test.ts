import { expect, it } from 'vitest';
import { assessHousingMoveIn } from '../src/housing-date-evidence.js';
const wanted = { from: '2026-11-05', to: '2026-11-05' };
it('matches an explicit labelled source date as a published term, and rejects a later start', () => {
  expect(assessHousingMoveIn('出租：一居室\n入住：2026年11月5日起', wanted)).toEqual({
    status: 'met',
    evidence: '入住：2026年11月5日起',
    decisive: true,
  });
  expect(assessHousingMoveIn('Available from 2026-11-05', wanted)?.status).toBe('met');
  expect(assessHousingMoveIn('起租：2026-11-10', wanted)?.status).toBe('mismatch');
});
it('keeps earlier, yearless, uncertain, invalid and multi-property dates unresolved', () => {
  for (const text of [
    '入住：2026-11-01起',
    '入住：11月5日起',
    '预计入住：2026-11-05',
    '入住：2026-11-05后',
    '入住：2026-02-31',
    '发布：2026-11-05',
    '入住：2026-11-05\n起租：2026-11-10',
  ])
    expect(assessHousingMoveIn(text, wanted)).toBeUndefined();
});
