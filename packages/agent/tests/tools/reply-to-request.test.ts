import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { bindCurrentRequest } from '../../src/current-request.js';
import { createKnowledgeSource } from '../../src/knowledge-evidence.js';
import { replyToRequestTool } from '../../src/tools/reply-to-request.js';

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
