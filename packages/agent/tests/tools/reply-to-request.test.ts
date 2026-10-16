import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { bindCurrentRequest } from '../../src/current-request.js';
import { createKnowledgeSource } from '../../src/knowledge-evidence.js';
import { replyToRequestTool } from '../../src/tools/reply-to-request.js';
import { taskSchema } from '@matchbot/domain';

function setup(phase: 0 | 1 | 2, ok = true) {
  const d = {
    env: { OUTBOUND_UNSURE_ACTION: 'review' },
    jev: {},
    thresholds: DEFAULT_THRESHOLDS,
    repos: {
      traces: { create: vi.fn(() => Promise.resolve({})) },
      outbound: {
        create: vi.fn(() => Promise.resolve({ id: 'o' })),
        countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
      },
    },
    logger: { info: vi.fn() },
    evaluateOutbound: vi.fn(() =>
      Promise.resolve(
        ok
          ? { ok: true, worthReplying: 3, languageOk: 1, mentionsUnverified: 0 }
          : { ok: false, reason: 'timeout' },
      ),
    ),
  };
  const c: MatchContext = {
    userId: 'u',
    chatId: '-1',
    groupId: null,
    phase,
    sourceMessageId: 'm',
    recentReplies: [],
    demand: { category: 'other', need: 'old carry topic', confidence: 1 },
  };
  bindCurrentRequest(c, '住E14没有NHS number，怎么注册GP？');
  c.knowledgeSources = [
    createKnowledgeSource(
      {
        title: 'NHS register',
        url: 'https://www.nhs.uk/register/',
        text: 'Everyone in England can register. You do not need an NHS number. Registration is free.',
      },
      1,
    ),
  ];
  return { d, c, t: replyToRequestTool(d as never) };
}
const args = {
  kind: 'answer',
  text: '没有NHS number也能注册GP，注册免费。先按居住邮编选择接受注册的诊所。',
  refs: ['k1'],
};
describe('reply_to_request', () => {
  it('accepts a structural reference to the first cited option without accepting an invented price', async () => {
    const { d, c, t } = setup(0);
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, text: '我会先看第1条官方说明：没有NHS number也能注册GP。' }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ ...args, text: '第1条官方说明注册需要£15。' }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('does not treat the platform name A2H as a numerical factual claim', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, '找允许养猫的一居室');
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'no_match',
        refs: [],
        text: '这次在A2H没有确认到允许养猫的房源，我会优先核对原帖的宠物许可。你还接受哪些相邻区域？',
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('requires source progress before a selected-task answer but does not turn this into a gate rejection', async () => {
    const { d, c } = setup(0);
    Object.assign(d, { taskRequests: true });
    c.task = taskSchema.parse({
      id: 't',
      ownerUserId: 'u',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '注册GP',
      status: 'active',
      revision: 0,
      goals: [],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    });
    const tool = replyToRequestTool(d as never);
    expect(await tool.invoke({ context: c } as never, JSON.stringify(args))).toContain(
      'record_task_progress',
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    expect(c.outboundBlocked).not.toBe(true);
  });
  it('retains later source facts for Jev when a single relevant item does not need bundle filtering', async () => {
    const { d, c, t } = setup(2);
    bindCurrentRequest(c, '伦敦收无线激光打印机，预算60镑');
    c.marketTarget = 'SELL';
    c.marketPlan = {
      intent: 'second_hand',
      needs: [{ id: 'printer', terms: ['打印机'] }],
      budget: 60,
      preferences: ['无线'],
    };
    c.marketListings = [
      {
        ref: 'm1',
        id: 'printer',
        title: '伦敦激光打印机',
        description:
          '出售：HP激光打印机\n价格：£50\n地点：E14 自提\n' +
          '普通使用说明。'.repeat(60) +
          '\n原帖明确：支持无线打印。',
        tags: [],
        tradeType: 'SELL',
        status: 'ON_SALE',
        url: 'https://a2hmarket.ai/listings/printer',
        sourceUrl: null,
        isRepost: false,
        priceLabel: '£50',
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ];
    await t.needsApproval(
      { context: c } as never,
      {
        kind: 'partial',
        text: '我先看m1这条，原帖写支持无线打印，收货前可以请贴主演示。',
        refs: ['m1'],
      },
      'long-source',
    );
    const input = d.evaluateOutbound.mock.calls[0] as unknown as [
      unknown,
      { supplierSummaries: string[] },
    ];
    expect(input[1].supplierSummaries.join('\n')).toContain('支持无线打印');
    expect(JSON.stringify(input[1])).not.toContain('m1这条');
  });
  it('renders only the affordable item from a bundle under separate task budgets', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, 'E14买书桌和办公椅，桌子70镑，椅子50镑');
    c.marketTarget = 'SELL';
    c.marketPlan = {
      intent: 'second_hand',
      needs: [
        { id: 'desk', terms: ['书桌'], budget: 70 },
        { id: 'chair', terms: ['办公椅'], budget: 50 },
      ],
      preferences: [],
      requiredArea: ['E14'],
    };
    c.marketListings = [
      {
        ref: 'm1',
        id: 'bundle',
        title: '伦敦桌椅',
        description: '- 书桌｜£60\n- 办公椅｜£65\n地点：E14 自提',
        tags: [],
        tradeType: 'SELL',
        status: 'ON_SALE',
        url: 'https://a2hmarket.ai/listings/bundle',
        sourceUrl: null,
        isRepost: false,
        priceLabel: '帖子报价',
        availableFrom: null,
        availableUntil: null,
        sourcePublishedAt: null,
        createdAt: null,
      },
    ];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'partial', text: '我会先看这张书桌，椅子还要继续找。', refs: ['m1'] }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('£60');
    expect(draft.text).not.toContain('£65');
    expect(draft.text).toContain('尚未确认到：办公椅');
  });
  it('does not match a smaller price as a substring of another price', async () => {
    const { d, c, t } = setup(0);
    c.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'NHS price example',
          url: 'https://www.nhs.uk/example',
          text: 'Example price is £135.',
        },
        1,
      ),
    ];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'answer', text: '费用35镑。', refs: ['k1'] }),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not invent an airport departure time from unrelated numeric evidence', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, '住E14，早上8点希思罗航班，两件行李');
    c.knowledgeSources = [
      createKnowledgeSource(
        {
          title: 'Heathrow',
          url: 'https://www.heathrow.com/transport',
          text: 'Fares £5.15. Trains every 15 minutes. Check your actual journey.',
        },
        1,
      ),
    ];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({ kind: 'answer', text: '建议5:15出发。', refs: ['k1'] }),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('allows a gated failure explanation after modern input exhaustion without marking a gate rejection', async () => {
    const { d, c, t } = setup(0);
    Object.assign(d, { answerRequests: true });
    for (let i = 0; i < 3; i++)
      await t.invoke({ context: c } as never, JSON.stringify({ ...args, refs: ['unknown'] }));
    expect(c.outboundBlocked).not.toBe(true);
    expect(c.answerInputExhausted).toBe(true);
    c.isAnswerFinalization = true;
    c.sourceFailures = ['processing:invalid_evidence'];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'unavailable',
        text: '这次没能完成可靠核对，请先确认2个条件。',
        refs: [],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it.each([
    [0, true, false, 'dry_run'],
    [1, true, true, 'pending'],
    [2, true, false, 'pending'],
    [2, false, true, 'pending'],
  ] as const)('preserves phase %i and Jev availability=%s', async (phase, ok, approval, status) => {
    const { d, c, t } = setup(phase, ok);
    expect(await t.needsApproval({ context: c } as never, args, 'call')).toBe(approval);
    await t.invoke({ context: c } as never, JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), status);
    if (phase === 2)
      expect(d.evaluateOutbound).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ demand: c.currentRequest?.demand }),
      );
  });
  it('declines rather than automatically sends when Jev is unavailable and review is disabled', async () => {
    const { d, c } = setup(2, false);
    d.env.OUTBOUND_UNSURE_ACTION = 'drop';
    const t = replyToRequestTool(d as never);
    await t.needsApproval({ context: c } as never, args, 'call');
    await t.invoke({ context: c } as never, JSON.stringify(args));
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it.each([
    { ...args, refs: ['invented'] },
    { ...args, text: '注册GP收费£300' },
    { ...args, text: '到https://evil.example注册' },
    { ...args, refs: [] },
  ])('rejects unsupported sources/facts/typed links', async (input) => {
    const { d, c, t } = setup(0);
    expect(await t.invoke({ context: c } as never, JSON.stringify(input))).toContain('invalid');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not treat valid citation IDs as numerical factual claims', async () => {
    const { d, c, t } = setup(0);
    const source = c.knowledgeSources![0]!;
    source.passages = [{ id: 'k1:p7', text: source.text }];
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'answer',
        text: '没有NHS number也能免费注册。（k1:p7）',
        refs: ['k1:p7'],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [draft] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).not.toContain('k1:p7');
  });
  it('returns a useful local no-match rather than a global absence claim', async () => {
    const { d, c, t } = setup(0);
    bindCurrentRequest(c, '伦敦收无线激光打印机，预算60镑');
    await t.invoke(
      { context: c } as never,
      JSON.stringify({
        kind: 'no_match',
        text: '无线功能没有确认，可以先向贴主索要型号和无线打印视频。',
        refs: [],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
  });
  it('requires an actual failure before describing unavailability', async () => {
    const { d, c, t } = setup(0);
    const input = { kind: 'unavailable', text: '可以稍后重试这次查询。', refs: [] };
    expect(await t.invoke({ context: c } as never, JSON.stringify(input))).toContain(
      'no recorded source failure',
    );
    c.sourceFailures = ['xiaohongshu:rate_limited'];
    await t.invoke({ context: c } as never, JSON.stringify(input));
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
});
