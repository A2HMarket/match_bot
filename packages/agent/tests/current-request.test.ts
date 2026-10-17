import { describe, expect, it } from 'vitest';
import { bindCurrentRequest } from '../src/current-request.js';
import type { MatchContext } from '../src/context.js';
import { taskSchema } from '@matchbot/domain';
describe('current request binding', () => {
  it.each(['狗岛找止疼药', 'E14想买止痛药', 'Isle of Dogs pharmacy for painkillers'])(
    'routes medicine access to public information despite an item-category guess: %s',
    (input) => {
      const ctx = {
        userId: 'u',
        chatId: 'c',
        groupId: null,
        phase: 0,
        sourceMessageId: 'm',
        recentReplies: [],
        requestCategory: 'second_hand',
      } as MatchContext;
      bindCurrentRequest(ctx, input);
      expect(ctx.currentRequest?.demand.category).toBe('other');
    },
  );
  it('does not collapse different effective item budgets back to the shared default', () => {
    const task = taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: 'c' },
      objective: '买桌椅',
      category: 'second_hand',
      status: 'active',
      revision: 0,
      goals: ['desk', 'chair'].map((id) => ({
        id,
        title: id,
        required: true,
        criteria: [
          { id: 'fit', label: '适配', strength: 'hard', status: 'unknown', evidenceRefs: [] },
        ],
      })),
      constraints: [
        {
          key: 'budget',
          strength: 'hard',
          value: { kind: 'money', amountPence: 5000, unit: 'item' },
          origin: { kind: 'user', sourceMessageId: 'old' },
        },
        {
          key: 'budget',
          goalId: 'desk',
          strength: 'hard',
          value: { kind: 'money', amountPence: 7000, unit: 'item' },
          origin: { kind: 'user', sourceMessageId: 'm' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    const ctx: MatchContext = {
      userId: 'u',
      chatId: 'c',
      groupId: null,
      phase: 0,
      sourceMessageId: 'm',
      recentReplies: [],
      task,
    };
    bindCurrentRequest(ctx, '桌子可以到70');
    expect(ctx.demand?.budgetPence).toBeUndefined();
  });
  it('keeps the selected task goal and constraints when the user answers a radius question', () => {
    const task = taskSchema.parse({
      id: 'badminton',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: 'c' },
      objective: '找羽毛球搭子',
      category: 'other',
      status: 'active',
      revision: 2,
      requirementsVersion: 1,
      goals: [
        {
          id: 'activity',
          title: '周末适合初学者的羽毛球活动',
          required: true,
          criteria: [
            {
              id: 'fit',
              label: '时间/水平/通勤符合',
              strength: 'hard',
              status: 'unknown',
              evidenceRefs: [],
            },
          ],
        },
      ],
      constraints: [
        {
          key: 'area',
          strength: 'hard',
          value: { kind: 'location', area: 'E14' },
          origin: { kind: 'user', sourceMessageId: 'original' },
        },
        {
          key: 'radius',
          strength: 'hard',
          value: { kind: 'duration', minutes: 30 },
          origin: { kind: 'user', sourceMessageId: 'm' },
        },
      ],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    const ctx: MatchContext = {
      userId: 'u',
      chatId: 'c',
      groupId: null,
      phase: 0,
      sourceMessageId: 'm',
      recentReplies: [],
      task,
    };
    bindCurrentRequest(ctx, '半小时以内');
    expect(ctx.currentRequest?.isActionable).toBe(true);
    expect(ctx.currentRequest?.text).toContain('羽毛球');
    expect(ctx.currentRequest?.text).toContain('初学者');
    expect(ctx.currentRequest?.text).toContain('30');
    expect(ctx.demand?.fromPostcode).toBe('E14');
    expect(ctx.demand?.category).toBe('other');
    expect(ctx.currentRequest?.text).not.toContain('sourceMessageId');
    expect(() => bindCurrentRequest({ ...ctx, userId: 'another' }, '继续')).toThrow('scope');
    expect(() => bindCurrentRequest({ ...ctx, chatId: 'elsewhere' }, '继续')).toThrow('scope');
    expect(() => bindCurrentRequest({ ...ctx, channel: 'whatsapp' }, '继续')).toThrow('scope');
  });
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
