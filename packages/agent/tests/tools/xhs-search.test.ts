import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import type { XhsNote } from '@matchbot/websearch';
import { describe, expect, it, vi } from 'vitest';
import type { MatchContext } from '../../src/context.js';
import { replyWithXhsNotesTool } from '../../src/tools/reply-with-xhs-notes.js';
import { xhsSearchTool } from '../../src/tools/xhs-search.js';

const ART: XhsNote = {
  ref: 'x1',
  title: '伦敦 秋季看展',
  desc: '雷诺阿大展，Renoir and Love，在 National Gallery。展期 2026年10月3日至2027年1月31日，票价 £20。色彩和人物画适合喜欢印象派的观众。摄影展在同馆。',
  author: '作者甲',
  likes: 2,
  url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok',
};
const MORE: XhsNote = {
  ref: 'x2',
  title: 'Renoir and Love 看展攻略',
  desc: 'Renoir and Love 在 National Gallery；周末建议提前预约。票价 £25。',
  author: '作者乙',
  likes: 9,
  url: 'https://www.xiaohongshu.com/explore/n2?xsec_token=tok',
};
const PHOTO: XhsNote = {
  ...ART,
  ref: 'x3',
  title: '摄影展',
  desc: '摄影展记录城市生活，适合摄影爱好者。',
  url: 'https://www.xiaohongshu.com/explore/n3',
};
const deps = () => ({
  env: { OUTBOUND_UNSURE_ACTION: 'review' },
  repos: {
    traces: { create: vi.fn(() => Promise.resolve({})) },
    outbound: {
      create: vi.fn((d: unknown, status: string) =>
        Promise.resolve({ id: 'om', status, ...(d as object) }),
      ),
      countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
    },
  },
  xhsSearch: { find: vi.fn(() => Promise.resolve([ART])) },
  jev: { evaluate: vi.fn() },
  thresholds: DEFAULT_THRESHOLDS,
  evaluateOutbound: vi.fn(() =>
    Promise.resolve({ ok: true, worthReplying: 2.8, languageOk: 0.95, mentionsUnverified: 0 }),
  ),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
});
const ctx = (over: Partial<MatchContext> = {}): MatchContext => ({
  userId: 'u',
  chatId: '-1',
  groupId: 'g',
  phase: 0,
  sourceMessageId: 'm',
  source: { userId: '42', messageId: '77' },
  recentReplies: [],
  demand: { category: 'other', confidence: 0.9, lang: 'zh' },
  ...over,
});
const rc = (c: MatchContext) => ({ context: c }) as never;
const query = (keyword: string, entity: string | null = null, page = 1) => ({
  keyword,
  entity,
  page,
  sort: 'general',
  timeFilter: '不限',
});
const search = (queries = [query('伦敦 看展')], purpose = 'discover') => ({ queries, purpose });

describe('xhs_search research', () => {
  it('continues valid enrichment queries when another query in the batch is unsafe or unknown', async () => {
    const d = deps(),
      c = ctx({ xhsNotes: [ART] });
    const out = JSON.parse(
      await xhsSearchTool(d as never).invoke(
        rc(c),
        JSON.stringify(
          search(
            [
              query('雷诺阿大展 票价', '雷诺阿大展'),
              query('联系 07700 900123', '雷诺阿大展'),
              query('不存在的展', '不存在的展'),
            ],
            'enrich',
          ),
        ),
      ),
    ) as { rejectedQueries: Array<{ index: number; reason: string }> };
    expect(d.xhsSearch.find).toHaveBeenCalledOnce();
    expect(out.rejectedQueries.map((q) => q.index)).toEqual([1, 2]);
    expect(c.xhsQueries).toHaveLength(1);
  });
  it('runs multiple topic queries, merges duplicate note URLs and keeps refs stable through enrichment', async () => {
    const d = deps(),
      c = ctx();
    d.xhsSearch.find
      .mockResolvedValueOnce([ART])
      .mockResolvedValueOnce([{ ...ART, url: ART.url.replace('tok', 'different') }, PHOTO])
      .mockResolvedValueOnce([MORE]);
    const t = xhsSearchTool(d as never);
    const first = JSON.parse(
      await t.invoke(rc(c), JSON.stringify(search([query('伦敦 艺术展'), query('伦敦 摄影展')]))),
    ) as { notes: XhsNote[]; remainingQueries: number };
    expect(first.notes.map((n) => n.ref)).toEqual(['x1', 'x2']);
    expect(first.remainingQueries).toBe(6);
    await t.invoke(
      rc(c),
      JSON.stringify(search([query('伦敦 Renoir and Love', 'Renoir and Love')], 'enrich')),
    );
    expect(c.xhsNotes?.map((n) => n.ref)).toEqual(['x1', 'x2', 'x3']);
    expect(c.xhsNotes?.[2]?.url).toBe(MORE.url);
    expect(d.repos.traces.create).toHaveBeenCalledTimes(2);
  });
  it('remembers empty searches, allows another query but never repeats the same query', async () => {
    const d = deps(),
      c = ctx(),
      t = xhsSearchTool(d as never);
    d.xhsSearch.find.mockResolvedValueOnce([]);
    await t.invoke(rc(c), JSON.stringify(search()));
    await t.invoke(rc(c), JSON.stringify(search()));
    await t.invoke(rc(c), JSON.stringify(search([query('伦敦 摄影展')])));
    expect(d.xhsSearch.find).toHaveBeenCalledTimes(2);
  });
  it('limits discovery to four queries, reserving the rest of the eight-query budget for enrichment', async () => {
    const d = deps(),
      c = ctx(),
      t = xhsSearchTool(d as never);
    for (const keyword of ['伦敦 艺术', '伦敦 摄影', '伦敦 设计', '伦敦 免费'])
      await t.invoke(rc(c), JSON.stringify(search([query(keyword)])));
    expect(await t.invoke(rc(c), JSON.stringify(search([query('伦敦 其他')])))).toContain(
      'discovery budget',
    );
    for (const suffix of ['预约', '票价', '位置', '看点'])
      await t.invoke(
        rc(c),
        JSON.stringify(search([query(`雷诺阿大展 ${suffix}`, '雷诺阿大展')], 'enrich')),
      );
    expect(
      await t.invoke(
        rc(c),
        JSON.stringify(search([query('雷诺阿大展 攻略', '雷诺阿大展')], 'enrich')),
      ),
    ).toContain('budget exhausted');
    expect(d.xhsSearch.find).toHaveBeenCalledTimes(8);
  });
  it('rejects enrichment of an entity not yet discovered, without calling the search service', async () => {
    const d = deps();
    expect(
      await xhsSearchTool(d as never).invoke(
        rc(ctx({ xhsNotes: [ART] })),
        JSON.stringify(search([query('不存在的展', '不存在的展')], 'enrich')),
      ),
    ).toContain('discovered entity');
    expect(d.xhsSearch.find).not.toHaveBeenCalled();
  });
  it('rejects private queries before making any network call and accepts a year/month query', async () => {
    const d = deps(),
      t = xhsSearchTool(d as never),
      c = ctx();
    expect(await t.invoke(rc(c), JSON.stringify(search([query('找我 07700 900123')])))).toContain(
      'rejected',
    );
    expect(d.xhsSearch.find).not.toHaveBeenCalled();
    await t.invoke(rc(c), JSON.stringify(search([query('伦敦 2026年10月 看展')])));
    expect(d.xhsSearch.find).toHaveBeenCalledTimes(1);
  });
  it('does not search after outbound was declined or web search already ran', async () => {
    for (const over of [{ outboundBlocked: true }, { searchResults: [] }]) {
      const d = deps();
      await xhsSearchTool(d as never).invoke(rc(ctx(over)), JSON.stringify(search()));
      expect(d.xhsSearch.find).not.toHaveBeenCalled();
    }
  });
  it('requires the own-catalogue lookup for service categories', async () => {
    const d = deps();
    await xhsSearchTool(d as never).invoke(
      rc(ctx({ demand: { category: 'man_and_van', confidence: 0.9 } })),
      JSON.stringify(search()),
    );
    expect(d.xhsSearch.find).not.toHaveBeenCalled();
  });
  it('caps source excerpts at 600 characters', async () => {
    const d = deps();
    d.xhsSearch.find.mockResolvedValueOnce([{ ...ART, desc: 'x'.repeat(3000) }]);
    const r = JSON.parse(
      await xhsSearchTool(d as never).invoke(rc(ctx()), JSON.stringify(search())),
    ) as { notes: Array<{ passages: Array<{ id: string; text: string }> }> };
    expect(r.notes[0]?.passages.map((p) => p.text).join('').length).toBe(600);
  });
});

const citation = (ref: string, _quote: string) => ({ ref, passages: [`${ref}:p1`] });
const exhibition = {
  name: '雷诺阿大展',
  aliases: ['Renoir and Love'],
  group: '绘画与艺术',
  summary: '以人物画和色彩为看点的展览。',
  reason: '喜欢印象派可以优先看。',
  sources: [citation('x1', ART.desc), citation('x2', MORE.desc)],
  facts: [
    {
      label: 'dates',
      status: 'known',
      passages: ['x1:p1'],
    },
    {
      label: 'venue',
      status: 'known',
      passages: ['x2:p1'],
    },
    {
      label: 'price',
      status: 'conflicting',
      passages: ['x1:p1', 'x2:p1'],
    },
    {
      label: 'booking',
      status: 'known',
      passages: ['x2:p1'],
    },
  ],
};
const args = { intro: '按类型整理，喜欢人物画可以先看雷诺阿：', recommendations: [exhibition] };

describe('entity recommendations', () => {
  it('removes an unattested optional alias without losing grounded sources, while still rejecting an invented main name', async () => {
    const d = deps(),
      c = ctx({ xhsNotes: [ART, MORE] });
    await replyWithXhsNotesTool(d as never).invoke(
      rc(c),
      JSON.stringify({
        ...args,
        recommendations: [{ ...exhibition, aliases: [...exhibition.aliases, '编造的翻译别名'] }],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    expect(c.xhsValidatedRecommendations?.[0]?.aliases).toEqual(exhibition.aliases);
  });
  it('links a formal exhibition name to a note naming both artist and exhibition separately, but not the artist alone', async () => {
    const formal = {
      ...ART,
      title: 'Es Devlin: Other Worlds',
      desc: 'Es Devlin: Other Worlds 在设计博物馆展出。',
      isDetailLoaded: true,
    };
    const related = {
      ...MORE,
      title: 'Es Devlin看展',
      desc: 'Es Devlin 的作品回顾。\n在 Other Worlds 中，书籍组成沉浸装置。',
      isDetailLoaded: true,
    };
    for (const [note, allowed] of [
      [related, true],
      [{ ...related, desc: 'Es Devlin 的另一个展览。' }, false],
    ] as const) {
      const d = deps();
      await replyWithXhsNotesTool(d as never).invoke(
        rc(ctx({ xhsNotes: [formal, note] })),
        JSON.stringify({
          ...args,
          recommendations: [
            {
              ...exhibition,
              name: 'Es Devlin: Other Worlds',
              aliases: [],
              sources: [citation('x1', ''), citation('x2', '')],
              facts: [],
            },
          ],
        }),
      );
      expect(d.repos.outbound.create.mock.calls.length).toBe(allowed ? 1 : 0);
    }
  });
  it('does not finish broad research with mostly single-source entries while more reading is possible', async () => {
    const d = { ...deps(), xhsSearch: { ...deps().xhsSearch, readNote: vi.fn() } };
    const c = ctx({
      xhsNotes: [ART, MORE, PHOTO],
      xhsDetailRefs: ['x1', 'x2', 'x3'],
      xhsQueries: [
        { ...query('伦敦 艺术'), purpose: 'discover' },
        { ...query('伦敦 免费'), purpose: 'discover' },
      ] as never,
    });
    const p = {
      ...args,
      recommendations: [
        exhibition,
        { ...exhibition, name: '摄影展', aliases: [], sources: [citation('x3', '')], facts: [] },
        {
          ...exhibition,
          name: 'National Gallery',
          aliases: [],
          sources: [citation('x1', '')],
          facts: [],
        },
      ],
    };
    const out = await replyWithXhsNotesTool(d as never).invoke(rc(c), JSON.stringify(p));
    expect(out).toContain('broad research needs');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    c.xhsDetailRefs = Array.from({ length: 12 }, (_, i) => `x${i + 1}`);
    const limited = await replyWithXhsNotesTool(d as never).invoke(rc(c), JSON.stringify(p));
    expect(limited).toContain('dry-run');
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toContain('整理了2个');
    expect(row.text).toContain('综合2篇');
  });
  it('retains a grounded multi-source entry when a later rewrite loses its second source', async () => {
    const d = { ...deps(), xhsSearch: { ...deps().xhsSearch, readNote: vi.fn() } };
    const c = ctx({
      xhsNotes: [
        { ...ART, isDetailLoaded: true },
        { ...MORE, isDetailLoaded: true },
        { ...PHOTO, isDetailLoaded: true },
      ],
      xhsDetailRefs: ['x1', 'x2', 'x3'],
      xhsQueries: [
        { ...query('伦敦 艺术'), purpose: 'discover' },
        { ...query('伦敦 免费'), purpose: 'discover' },
      ] as never,
    });
    const wrong = {
      ...exhibition,
      name: '摄影展',
      aliases: [],
      sources: [citation('x3', '')],
      facts: [{ label: 'price', status: 'known', passages: ['x3:p1'] }],
    };
    const t = replyWithXhsNotesTool(d as never);
    await t.invoke(rc(c), JSON.stringify({ ...args, recommendations: [exhibition, wrong] }));
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    expect(c.xhsValidatedRecommendations).toHaveLength(1);
    c.xhsDetailRefs = Array.from({ length: 12 }, (_, i) => `x${i + 1}`);
    await t.invoke(
      rc(c),
      JSON.stringify({
        ...args,
        recommendations: [{ ...exhibition, sources: [citation('x1', '')] }, wrong],
      }),
    );
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toContain('综合2篇');
    expect(row.text).not.toContain('摄影展\n');
  });
  it('keeps a grounded multi-note entity at the read limit but marks an unsupported practical field unconfirmed', async () => {
    const d = { ...deps(), xhsSearch: { ...deps().xhsSearch, readNote: vi.fn() } };
    const c = ctx({
      xhsNotes: [
        { ...ART, isDetailLoaded: true },
        { ...MORE, isDetailLoaded: true },
      ],
      xhsDetailRefs: Array.from({ length: 12 }, (_, i) => `x${i + 1}`),
      xhsQueries: [
        { ...query('伦敦 艺术'), purpose: 'discover' },
        { ...query('伦敦 免费'), purpose: 'discover' },
      ] as never,
    });
    await replyWithXhsNotesTool(d as never).invoke(
      rc(c),
      JSON.stringify({
        ...args,
        recommendations: [
          { ...exhibition, facts: [{ label: 'price', status: 'known', passages: ['x1:p99'] }] },
        ],
      }),
    );
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toContain('综合2篇');
    expect(row.text).toContain('票价：未确认');
    expect(c.xhsValidatedRecommendations?.[0]?.facts).toEqual([
      { label: 'price', status: 'unknown', passages: [] },
    ]);
  });
  it('rejects a generic London roundup as an entity and a non-price passage as price', async () => {
    const note = {
      ...ART,
      title: '伦敦0元景点',
      desc: '伦敦0元景点推荐：National Gallery。\nNational Gallery 馆藏丰富。',
      isDetailLoaded: true,
    };
    const d = deps(),
      t = replyWithXhsNotesTool(d as never),
      c = ctx({ xhsNotes: [note] });
    const base = {
      ...exhibition,
      aliases: [],
      sources: [{ ref: 'x1', passages: ['x1:p1'] }],
      facts: [],
    };
    expect(
      await t.invoke(
        rc(c),
        JSON.stringify({ ...args, recommendations: [{ ...base, name: '伦敦0元景点' }] }),
      ),
    ).toContain('collection');
    const out = await t.invoke(
      rc(c),
      JSON.stringify({
        ...args,
        recommendations: [
          {
            ...base,
            name: 'National Gallery',
            facts: [{ label: 'price', status: 'known', passages: ['x1:p2'] }],
          },
        ],
      }),
    );
    expect(out).toContain('facts.price');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('requires combining available full notes about an entity instead of rephrasing one roundup', async () => {
    const d = deps();
    const c = ctx({
      xhsNotes: [
        { ...ART, isDetailLoaded: true },
        { ...MORE, isDetailLoaded: true },
      ],
    });
    const out = await replyWithXhsNotesTool(d as never).invoke(
      rc(c),
      JSON.stringify({
        ...args,
        recommendations: [{ ...exhibition, sources: [citation('x1', '')], facts: [] }],
      }),
    );
    expect(out).toContain('combine at least two');
    expect(out).toContain('x2');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not treat two copied bodies as complementary sources', async () => {
    const d = deps();
    const out = await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [ART, { ...MORE, desc: ART.desc }] })),
      JSON.stringify({ ...args, recommendations: [{ ...exhibition, facts: [] }] }),
    );
    expect(out).toContain('duplicated original bodies');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('rejects discovery cards as final evidence and labels a genuinely single-source result', async () => {
    const d = deps(),
      t = replyWithXhsNotesTool(d as never);
    const p = {
      ...args,
      recommendations: [{ ...exhibition, sources: [citation('x1', '')], facts: [] }],
    };
    expect(
      await t.invoke(rc(ctx({ xhsNotes: [{ ...ART, isDetailLoaded: false }] })), JSON.stringify(p)),
    ).toContain('xhs_read_notes');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    await t.invoke(rc(ctx({ xhsNotes: [{ ...ART, isDetailLoaded: true }] })), JSON.stringify(p));
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toContain('单篇资料');
  });
  it('accepts punctuation and casing variants of a source name but preserves words, years and line boundaries', async () => {
    const note = {
      ...ART,
      title: 'Frida：The Making of an Icon',
      desc: 'Frida：The Making of an Icon，2026年的展览。\nFrida\n卡罗',
    };
    for (const [name, shouldAccept] of [
      ['Frida: The Making of an Icon', true],
      ['FRIDA: THE MAKING OF AN ICON', true],
      ['Frida: The Making of an Icon 2027', false],
      ['Frida卡罗', false],
      ['++', false],
    ] as const) {
      const d = deps();
      await replyWithXhsNotesTool(d as never).invoke(
        rc(ctx({ xhsNotes: [note] })),
        JSON.stringify({
          ...args,
          recommendations: [
            {
              ...exhibition,
              name,
              aliases: [],
              sources: [{ ref: 'x1', passages: ['x1:p1'] }],
              facts: [],
            },
          ],
        }),
      );
      expect(d.repos.outbound.create.mock.calls.length).toBe(shouldAccept ? 1 : 0);
    }
  });
  it('returns every invalid entity/field in one repair instead of hiding subsequent failures', async () => {
    const d = deps();
    const out = await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [ART, MORE] })),
      JSON.stringify({
        ...args,
        recommendations: [
          { ...exhibition, name: 'Renoir and Love 雷诺阿与爱' },
          {
            ...exhibition,
            name: '摄影展',
            aliases: [],
            sources: [citation('x1', '')],
            facts: [{ label: 'price', status: 'known', passages: ['x1:p99'] }],
          },
        ],
      }),
    );
    expect(out).toContain('recommendations[0]');
    expect(out).toContain('name/aliases');
    expect(out).toContain('recommendations[1]');
    expect(out).toContain('facts.price');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('binds facts to cited notes rather than accepting a passage from an uncited note', async () => {
    const note = {
      ...ART,
      desc: '雷诺阿大展，Renoir and Love，人物画与色彩。\n票价 £20，National Gallery。',
    };
    const d = deps(),
      t = replyWithXhsNotesTool(d as never),
      c = ctx({ xhsNotes: [note] });
    const recommendation = {
      ...exhibition,
      sources: [{ ref: 'x1', passages: ['x1:p1'] }],
      facts: [{ label: 'price', status: 'known', passages: ['x2:p1'] }],
    };
    expect(
      await t.invoke(rc(c), JSON.stringify({ ...args, recommendations: [recommendation] })),
    ).toContain('facts.price');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    await t.invoke(
      rc(c),
      JSON.stringify({
        ...args,
        recommendations: [
          {
            ...recommendation,
            sources: [{ ref: 'x1', passages: ['x1:p1'] }],
            facts: [{ label: 'price', status: 'known', passages: ['x1:p2'] }],
          },
        ],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
  });
  it('takes practical fact text from the selected source without model copying or rewriting', async () => {
    const note = {
      ...ART,
      desc: '雷诺阿大展，Renoir and Love，人物画与色彩。\n票价：£20 起；会员免费\n展期：2026.10.03 — 2027.01.31',
    };
    const d = deps();
    await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [note] })),
      JSON.stringify({
        ...args,
        recommendations: [
          {
            ...exhibition,
            sources: [{ ref: 'x1', passages: ['x1:p1', 'x1:p2', 'x1:p3'] }],
            facts: [
              { label: 'price', status: 'known', passages: ['x1:p2'] },
              { label: 'dates', status: 'known', passages: ['x1:p3'] },
            ],
          },
        ],
      }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalledOnce();
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toContain('票价：£20 起；会员免费');
    expect(row.text).toContain('时间：2026.10.03 — 2027.01.31');
    expect(row.text).not.toContain('票价：票价：');
  });
  it('rejects invented passage IDs and IDs from a different source', async () => {
    const d = deps();
    const out = await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [ART, MORE] })),
      JSON.stringify({
        ...args,
        recommendations: [{ ...exhibition, sources: [{ ref: 'x1', passages: ['x2:p1'] }] }],
      }),
    );
    expect(out).toContain('unknown ID x2:p1');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('does not crash approval evaluation on malformed model arguments and never writes them', async () => {
    const d = deps(),
      c = ctx({ xhsNotes: [ART, MORE] }),
      t = replyWithXhsNotesTool(d as never);
    const malformed = { ...args, recommendations: [{ ...exhibition, summary: 'x'.repeat(221) }] };
    expect(await t.needsApproval(rc(c), malformed, 'bad-call')).toBe(false);
    const error = await t.invoke(rc(c), JSON.stringify(malformed));
    expect(error).toContain('recommendations.0.summary');
    expect(error).toContain('220');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
    expect(d.evaluateOutbound).not.toHaveBeenCalled();
  });
  it('reports an oversized source list even when SDK tracing redacts invalid input details', async () => {
    const d = deps(),
      c = ctx({ xhsNotes: [ART, MORE] }),
      t = replyWithXhsNotesTool(d as never);
    const malformed = {
      ...args,
      recommendations: [
        { ...exhibition, sources: Array.from({ length: 5 }, () => citation('x1', '')) },
      ],
    };
    await t.needsApproval(rc(c), malformed, 'oversized');
    const out = await t.invoke(rc(c), JSON.stringify(malformed));
    expect(out).toContain('recommendations.0.sources');
    expect(out).toContain('4');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('merges posts into one exhibition with practical facts, conflict markers and multiple sources', async () => {
    const d = deps();
    await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [ART, MORE] })),
      JSON.stringify(args),
    );
    const [row, status] = d.repos.outbound.create.mock.calls[0] as unknown as [
      { text: string },
      string,
    ];
    expect(status).toBe('dry_run');
    expect(row.text).toContain('【绘画与艺术】');
    expect(row.text).toContain('1. 雷诺阿大展');
    expect(row.text).toContain(exhibition.summary);
    expect(row.text).toContain('National Gallery');
    expect(row.text).toContain('票价：信息冲突');
    expect(row.text).toContain(ART.url);
    expect(row.text).toContain(MORE.url);
    expect(row.text).not.toContain('笔记提到：');
  });
  it('lets one roundup support multiple distinct exhibitions and permits six recommendations', async () => {
    const d = deps();
    const notes = Array.from({ length: 6 }, (_, i) => ({
      ...PHOTO,
      ref: `x${i + 1}`,
      desc: `摄影展${i}记录城市生活，适合摄影爱好者。`,
      url: `https://www.xiaohongshu.com/explore/n${i + 1}`,
    }));
    const recommendations = notes.map((n, i) => ({
      name: `摄影展${i}`,
      aliases: [],
      group: '摄影',
      summary: '城市生活摄影作品。',
      reason: '适合摄影爱好者。',
      sources: [citation(n.ref, '记录城市生活')],
      facts: [{ label: 'dates', status: 'unknown', passages: [] }],
    }));
    await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: notes })),
      JSON.stringify({ ...args, recommendations }),
    );
    expect(d.repos.outbound.create).toHaveBeenCalled();
    const [row] = d.repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(row.text).toContain('6. 摄影展5');
    expect(row.text).toContain('时间：未确认');
    const second = deps();
    await replyWithXhsNotesTool(second as never).invoke(
      rc(ctx({ xhsNotes: [ART, MORE] })),
      JSON.stringify({
        ...args,
        recommendations: [
          exhibition,
          {
            ...exhibition,
            name: '摄影展',
            aliases: [],
            sources: [citation('x1', '摄影展在同馆')],
            facts: [],
          },
        ],
      }),
    );
    expect(second.repos.outbound.create).toHaveBeenCalled();
  });
  it.each([
    { name: '编造的展' },
    { sources: [citation('x9', '不存在的原文')] },
    { sources: [{ ref: 'x1', passages: ['x1:p99'] }] },
    {
      facts: [{ label: 'price', status: 'known', passages: ['x1:p99'] }],
    },
    {
      facts: [
        {
          label: 'price',
          status: 'conflicting',
          passages: ['x1:p1'],
        },
      ],
    },
  ])('rejects unsupported names, source quotes and practical facts: %j', async (patch) => {
    const d = deps();
    const out = await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [ART, MORE] })),
      JSON.stringify({ ...args, recommendations: [{ ...exhibition, ...patch }] }),
    );
    expect(out).toContain('invalid recommendation');
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it('rejects duplicate entity aliases instead of listing the same exhibition twice', async () => {
    const d = deps();
    await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ xhsNotes: [ART, MORE] })),
      JSON.stringify({
        ...args,
        recommendations: [
          exhibition,
          { ...exhibition, name: 'Renoir and Love', aliases: ['雷诺阿大展'] },
        ],
      }),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
  it.each([
    [0, true, false, 'dry_run'],
    [1, true, true, 'pending'],
    [2, true, false, 'pending'],
    [2, false, true, 'pending'],
  ] as const)('keeps phase %i gate semantics', async (phase, ok, approval, status) => {
    const d = deps();
    if (!ok)
      d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'unavailable' } as never);
    const c = ctx({ phase, xhsNotes: [ART, MORE] }),
      t = replyWithXhsNotesTool(d as never);
    expect(await t.needsApproval(rc(c), args, 'c')).toBe(approval);
    await t.invoke(rc(c), JSON.stringify(args));
    expect(d.repos.outbound.create).toHaveBeenCalledWith(expect.anything(), status);
  });
  it('retains the unattended unavailable-Jev drop behavior', async () => {
    const d = { ...deps(), env: { OUTBOUND_UNSURE_ACTION: 'drop' } };
    d.evaluateOutbound.mockResolvedValueOnce({ ok: false, reason: 'unavailable' } as never);
    await replyWithXhsNotesTool(d as never).invoke(
      rc(ctx({ phase: 2, xhsNotes: [ART, MORE] })),
      JSON.stringify(args),
    );
    expect(d.repos.outbound.create).not.toHaveBeenCalled();
  });
});
