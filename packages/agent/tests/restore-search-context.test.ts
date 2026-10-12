import { describe, expect, it } from 'vitest';
import type { MatchContext } from '../src/context.js';
import { restoreSearchContext } from '../src/restore-search-context.js';

const ctx: MatchContext = {
  userId: 'u',
  chatId: '-1',
  phase: 1,
  groupId: null,
  sourceMessageId: 'run',
  recentReplies: [],
};
const note = {
  ref: 'x1',
  title: 'title',
  desc: 'evidence',
  author: 'author',
  url: 'https://www.xiaohongshu.com/explore/n1',
  likes: 2,
};
const snapshot = (over: Record<string, unknown>) =>
  JSON.stringify({
    context: {
      context: {
        ...ctx,
        xhsNotes: [note],
        xhsQueries: [
          {
            keyword: '伦敦 看展',
            page: 1,
            sort: 'general',
            timeFilter: '不限',
            entity: null,
            purpose: 'discover',
          },
        ],
        ...over,
      },
    },
  });

describe('restoreSearchContext', () => {
  it('restores current request and canonical failure state for approval resumption', () => {
    const currentRequest = {
      text: 'E14找房',
      demand: { category: 'housing', need: 'E14找房', confidence: 1 },
      isActionable: true,
    };
    const restored = restoreSearchContext(
      ctx,
      snapshot({
        currentRequest,
        answerInputExhausted: true,
        isAnswerFinalization: true,
        sourceFailures: ['processing:invalid_evidence'],
      }),
    );
    expect(restored.currentRequest).toEqual(currentRequest);
    expect(restored.demand).toEqual(currentRequest.demand);
    expect(restored.answerInputExhausted).toBe(true);
    expect(restored.isAnswerFinalization).toBe(true);
  });
  it('keeps normalized requirements through encrypted approval snapshot reconstruction', () => {
    const plan = {
      intent: 'second_hand',
      needs: [{ id: 'desk', terms: ['书桌', 'desk'] }],
      preferences: ['白色'],
      essentialPreferences: ['白色'],
      requiredTerms: [],
      excludeTerms: [],
      requiredArea: ['E14'],
      budget: 50,
    };
    const restored = restoreSearchContext(ctx, snapshot({ marketPlan: plan }));
    expect(restored.marketPlan).toEqual(plan);
  });
  it('restores evidence, addressing and limits, keeping the latest demand from the database', () => {
    const demand = { category: 'other', confidence: 0.95, lang: 'en' } as const;
    const restored = restoreSearchContext(
      { ...ctx, demand },
      snapshot({
        groupId: 'g',
        sourceMessageId: 'm',
        source: { messageId: '7', userId: '42' },
        rateLimitPerDay: 3,
        xhsNotes: [{ ...note, isDetailLoaded: true }],
        xhsDetailRefs: ['x1'],
        xhsQueries: [
          {
            keyword: '伦敦 看展',
            page: 1,
            sort: 'general',
            timeFilter: '不限',
            entity: null,
            purpose: 'discover',
          },
        ],
        demand: { ...demand, lang: 'zh' },
      }),
    );
    expect(restored).toMatchObject({
      groupId: 'g',
      sourceMessageId: 'm',
      source: { messageId: '7', userId: '42' },
      rateLimitPerDay: 3,
      demand,
      xhsNotes: [{ ...note, isDetailLoaded: true }],
      xhsDetailRefs: ['x1'],
      xhsQueries: [
        {
          keyword: '伦敦 看展',
          page: 1,
          sort: 'general',
          timeFilter: '不限',
          entity: null,
          purpose: 'discover',
        },
      ],
    });
  });

  it.each([
    { userId: 'other' },
    { chatId: '-2' },
    { phase: 2 },
    { xhsNotes: [{ ...note, url: 'not-a-url' }] },
  ])('rejects a mismatched or malformed server context: %j', (over) => {
    expect(() => restoreSearchContext(ctx, snapshot(over))).toThrow();
  });

  it('leaves runs without Xiaohongshu search unchanged', () => {
    expect(restoreSearchContext(ctx, JSON.stringify({ context: { context: ctx } }))).toBe(ctx);
  });
});
