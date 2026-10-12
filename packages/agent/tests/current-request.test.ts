import { describe, expect, it } from 'vitest';
import { bindCurrentRequest } from '../src/current-request.js';
import type { MatchContext } from '../src/context.js';
describe('current request binding', () => {
  it('does not inherit a carry topic or old budget into a food request', () => {
    const ctx: MatchContext = {
      userId: 'u',
      chatId: 'c',
      groupId: null,
      phase: 2,
      sourceMessageId: 'm',
      recentReplies: [],
      demandId: 'old',
      demand: {
        category: 'other',
        confidence: 1,
        need: 'carry-on help Shanghai to London',
        budgetPence: 6000,
      },
    };
    bindCurrentRequest(ctx, '四个人想在伦敦唐人街吃火锅，有什么推荐？');
    expect(ctx.currentRequest?.demand.need).toContain('火锅');
    expect(ctx.currentRequest?.demand.budgetPence).toBeUndefined();
    expect(ctx.demandId).toBeUndefined();
  });
  it('uses the explicitly quoted bot reply instead of the latest unrelated demand', () => {
    const ctx: MatchContext = {
      userId: 'u',
      chatId: 'c',
      groupId: null,
      phase: 0,
      sourceMessageId: 'm',
      recentReplies: [],
      replyToBotText: 'HP激光打印机，报价50镑，是否无线待确认',
      demand: { category: 'other', need: '上海伦敦帮带', budgetPence: 2000, confidence: 1 },
    };
    bindCurrentRequest(ctx, '这台有无线吗？');
    expect(ctx.demand?.category).toBe('second_hand');
    expect(ctx.demand?.need).not.toContain('帮带');
    expect(ctx.demand?.budgetPence).toBeUndefined();
    expect(ctx.currentRequest?.isActionable).toBe(true);
  });
  it('binds an explicit monthly rent budget', () => {
    const ctx: MatchContext = {
      userId: 'u',
      chatId: 'c',
      groupId: null,
      phase: 0,
      sourceMessageId: 'm',
      recentReplies: [],
    };
    bindCurrentRequest(ctx, 'E14找长租单间，月租1200镑以内');
    expect(ctx.demand?.budgetPence).toBe(120000);
  });
  it('binds each-item budget and outcode from the new message', () => {
    const ctx: MatchContext = {
      userId: 'u',
      chatId: 'c',
      groupId: null,
      phase: 0,
      sourceMessageId: 'm',
      recentReplies: [],
    };
    bindCurrentRequest(ctx, 'E14想收书桌和办公椅，每件50镑以内');
    expect(ctx.demand).toMatchObject({
      category: 'second_hand',
      budgetPence: 5000,
      fromPostcode: 'E14',
    });
  });
});
