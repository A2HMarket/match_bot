import { describe, expect, it } from 'vitest';
import { buildMarketChoices, buildMarketResearchTasks } from '../src/market-choices.js';
import type { MarketCandidate } from '../src/market-research.js';
import type { MarketPlan } from '../src/market-strategy.js';
const candidate = (
  ref: string,
  description: string,
  sourceUrl: string | null = null,
): MarketCandidate => ({
  id: `listing_${ref}`,
  ref,
  title: '伦敦出激光打印机',
  description,
  sourceUrl,
  tags: [],
  tradeType: 'SELL',
  status: 'ON_SALE',
  url: `https://a2hmarket.ai/listings/listing_${ref}`,
  isRepost: !!sourceUrl,
  priceLabel: '帖内报价范围：£5–£100（单品价格需确认）',
  availableFrom: null,
  availableUntil: null,
  sourcePublishedAt: null,
  createdAt: null,
});
const plan: MarketPlan = {
  intent: 'second_hand',
  needs: [{ id: 'printer', terms: ['激光打印机'] }],
  preferences: [],
  budget: 60,
};
describe('market choices', () => {
  it('separates confirmed budget offers from unknown prices and excludes conflicts', () => {
    const choices = buildMarketChoices({
      candidates: [
        candidate('m1', '- 激光打印机｜£40'),
        candidate('m2', '激光打印机，价格私聊'),
        candidate('m3', '- 激光打印机｜£100'),
      ],
      plan,
    });
    expect(choices.primary.map((c) => c.listing.ref)).toEqual(['m1']);
    expect(choices.backup.map((c) => c.listing.ref)).toEqual(['m2']);
    expect(choices.primary[0]?.reasons).toContain('单品报价符合预算');
    expect(choices.backup[0]?.missing).toContain('价格/计价单位');
  });
  it('keeps soft preferences distinct from essential requirements', () => {
    const n = candidate('m1', '- 激光打印机｜£40');
    const soft = buildMarketChoices({
      candidates: [n],
      plan: { ...plan, preferences: ['无线'], essentialPreferences: [] },
    });
    expect(soft.primary).toHaveLength(1);
    expect(soft.primary[0]?.missing).toContain('无线');
    const essential = buildMarketChoices({
      candidates: [n],
      plan: { ...plan, preferences: ['无线'], essentialPreferences: ['无线'] },
    });
    expect(essential.primary).toHaveLength(0);
    expect(essential.backup).toHaveLength(1);
  });
  it('does not treat a missing-feature statement as positive feature evidence', () => {
    const n = candidate('m1', '- 激光打印机｜£40｜无线功能没有说明');
    const choices = buildMarketChoices({
      candidates: [n],
      plan: { ...plan, preferences: ['无线'], essentialPreferences: ['无线'] },
    });
    expect(choices.primary).toHaveLength(0);
    expect(choices.backup[0]?.missing).toContain('无线');
  });
  it('deduplicates only the same original post, preserving distinct owners with identical titles', () => {
    const choices = buildMarketChoices({
      candidates: [
        candidate('m1', '- 激光打印机｜£40', 'https://www.xiaohongshu.com/explore/n1?xsec_token=a'),
        candidate(
          'm2',
          '- 激光打印机｜£40',
          'https://www.xiaohongshu.com/discovery/item/n1?xsec_token=b',
        ),
        candidate('m3', '- 激光打印机｜£40', 'https://www.xiaohongshu.com/explore/n2'),
      ],
      plan,
    });
    expect(choices.primary.map((c) => c.listing.ref)).toEqual(['m1', 'm3']);
  });
  it('ranks an explicit item risk behind other budget matches without borrowing a sibling risk', () => {
    const risky = candidate('m1', '- 激光打印机｜£40\n激光打印机，8成新，两年没用了');
    const other = candidate('m2', '- 激光打印机｜£40\n- 椅子｜£10｜有划痕');
    const choices = buildMarketChoices({ candidates: [risky, other], plan });
    expect(choices.primary.map((r) => r.listing.ref)).toEqual(['m2', 'm1']);
    expect(choices.primary[0]?.warning).toBeNull();
    expect(choices.primary[1]?.warning).toContain('两年没用了');
  });
  it('prefers the cheaper bound item when fit and stated risk are otherwise equal', () => {
    const choices = buildMarketChoices({
      candidates: [candidate('m1', '- 激光打印机｜£50'), candidate('m2', '- 激光打印机｜£40')],
      plan,
    });
    expect(choices.primary.map((c) => c.listing.ref)).toEqual(['m2', 'm1']);
  });
  it('does not flag an explicit no-scratches statement as a defect', () => {
    const choices = buildMarketChoices({
      candidates: [candidate('m1', '- 激光打印机｜£40｜无划痕，功能正常')],
      plan,
    });
    expect(choices.primary[0]?.warning).toBeNull();
  });
  it('does not shortlist a listing that detail lookup marked sold', () => {
    const n = { ...candidate('m1', '- 激光打印机｜£40'), status: 'SOLD' };
    expect(buildMarketChoices({ candidates: [n], plan })).toEqual({ primary: [], backup: [] });
  });
  it('preserves different items within the same original post', () => {
    const url = 'https://www.xiaohongshu.com/explore/n1';
    const choices = buildMarketChoices({
      candidates: [
        candidate('m1', '- Brother激光打印机｜£40', url),
        candidate('m2', '- HP激光打印机｜£50', url),
      ],
      plan,
      names: { m1: 'Brother激光打印机', m2: 'HP激光打印机' },
    });
    expect(choices.primary).toHaveLength(2);
  });
  it('limits priority to three and backups to two, or three clues when nothing is confirmed', () => {
    const candidates = Array.from({ length: 8 }, (_, i) =>
      candidate(`m${i}`, i < 4 ? '- 激光打印机｜£40' : '激光打印机'),
    );
    const choices = buildMarketChoices({ candidates, plan });
    expect(choices.primary).toHaveLength(3);
    expect(choices.backup).toHaveLength(2);
    expect(buildMarketChoices({ candidates: candidates.slice(4), plan }).backup).toHaveLength(3);
  });
  it('directs missing information to detail first, then source-attested searches without repeating them', () => {
    const n = candidate('m1', '激光打印机，无线功能没有说明');
    const p = { ...plan, preferences: ['无线'], essentialPreferences: ['无线'] };
    const choices = buildMarketChoices({ candidates: [n], plan: p });
    expect(
      buildMarketResearchTasks({
        choices,
        plan: p,
        detailIds: [],
        queries: [],
        remainingDetails: 8,
        remainingQueries: 8,
      })[0],
    ).toMatchObject({ action: 'detail', ref: 'm1' });
    const tasks = buildMarketResearchTasks({
      choices,
      plan: p,
      detailIds: [n.id],
      queries: [],
      remainingDetails: 7,
      remainingQueries: 8,
    });
    expect(tasks[0]).toMatchObject({ action: 'search', ref: 'm1', entity: '激光打印机' });
    expect(tasks[0]?.keyword).toContain('激光打印机');
    expect(
      buildMarketResearchTasks({
        choices,
        plan: p,
        detailIds: [n.id],
        queries: [tasks[0]!.keyword!],
        remainingDetails: 7,
        remainingQueries: 0,
      }),
    ).toEqual([]);
  });
});
