import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { createLogger, loadEnv } from '@matchbot/shared';
import { assistantMessage, functionCall, ScriptedModel } from '@openai/agents/testing';
import { describe, expect, it, vi } from 'vitest';
import { AGENT_VERSION } from '../src/agent.js';
import { resumeRun, runInbound } from '../src/run.js';

const VAN = { id: 'a', name: 'Van Co', roughPrice: '£40/h', telegram: '@vanco' };

function makeDeps(model: ScriptedModel) {
  const store: unknown[] = [];
  const runStates: Array<Record<string, unknown> & { id: string }> = [];
  const repos = {
    sessionItems: {
      list: vi.fn(() => Promise.resolve([...store])),
      append: vi.fn((_u: string, items: unknown[]) => {
        store.push(...items);
        return Promise.resolve();
      }),
      popLast: vi.fn(() => Promise.resolve(store.pop() ?? null)),
      clear: vi.fn(() => {
        store.length = 0;
        return Promise.resolve();
      }),
    },
    runStates: {
      create: vi.fn((p: Record<string, unknown>) => {
        const row = { id: `rs${runStates.length + 1}`, ...p };
        runStates.push(row);
        return Promise.resolve(row);
      }),
    },
    outbound: {
      create: vi.fn((d: unknown, status: string) =>
        Promise.resolve({ id: 'om', status, ...(d as object) }),
      ),
      countSentToTargetSince: vi.fn(() => Promise.resolve(0)),
    },
    traces: { create: vi.fn(() => Promise.resolve({})) },
    suppliers: {
      findByIds: vi.fn(() => Promise.resolve([VAN])),
      findCandidates: vi.fn(() => Promise.resolve([VAN])),
    },
    demands: {
      findOpenByUser: vi.fn(() => Promise.resolve([])),
      create: vi.fn((p: unknown) => Promise.resolve({ id: 'd1', ...(p as object) })),
      update: vi.fn(),
      setStatus: vi.fn(),
    },
    matches: { replaceForDemand: vi.fn(() => Promise.resolve([])) },
  };
  const deps = {
    env: loadEnv({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/d',
      REDIS_URL: 'redis://localhost:6379',
      DEEPSEEK_API_KEY: 'k',
      JEV_API_KEY: 'k',
      TELEGRAM_BOT_TOKEN: 'k',
      TELEGRAM_OPS_CHAT_ID: '-100ops',
      SNAPSHOT_KEY: 'test-snapshot-key-0123456789',
    }),
    repos,
    jev: { evaluate: vi.fn() },
    thresholds: DEFAULT_THRESHOLDS,
    logger: createLogger('test', 'silent'),
    evaluateOutbound: vi.fn(),
    modelProvider: { getModel: () => model },
  };
  return { deps, repos, runStates };
}

const ctx = (phase: 0 | 1 | 2) => ({
  userId: 'u1',
  chatId: '-1',
  groupId: 'g',
  phase: phase as 0,
  recentReplies: [] as string[],
  sourceMessageId: 'm1',
});

const replyCall = (callId = 'c1') =>
  functionCall(
    'reply_in_group',
    { text: 'Two van options for you', supplierIds: ['a'] },
    { callId },
  );

describe('runInbound', () => {
  it('reads two shortlisted full notes, then preserves evidence and read budget through approval resume', async () => {
    const cards = [
      {
        ref: 'x1',
        title: 'Southbank 集市',
        desc: '摘要',
        author: '甲',
        likes: 1,
        url: 'https://www.xiaohongshu.com/explore/n1',
        isDetailLoaded: false,
      },
      {
        ref: 'x2',
        title: 'Southbank 集市攻略',
        desc: '摘要',
        author: '乙',
        likes: 2,
        url: 'https://www.xiaohongshu.com/explore/n2',
        isDetailLoaded: false,
      },
    ];
    const args = {
      intro: '这场可以先看：',
      recommendations: [
        {
          name: 'Southbank 集市',
          aliases: [],
          group: '市集',
          summary: '河边小吃与艺术摊位。',
          reason: '适合散步。',
          sources: [
            { ref: 'x1', passages: ['x1:p1'] },
            { ref: 'x2', passages: ['x2:p1'] },
          ],
          facts: [],
        },
      ],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'xhs_search',
          {
            purpose: 'discover',
            queries: [
              {
                keyword: '伦敦 Southbank 集市',
                page: 1,
                sort: 'general',
                timeFilter: '不限',
                entity: null,
              },
            ],
          },
          { callId: 'discover' },
        ),
      ],
      [functionCall('xhs_read_notes', { refs: ['x1', 'x2'] }, { callId: 'read' })],
      [functionCall('reply_with_xhs_notes', args, { callId: 'reply' })],
    ]);
    const { deps, repos, runStates } = makeDeps(model);
    const readNote = vi.fn((note: (typeof cards)[number]) =>
      Promise.resolve({
        ...note,
        desc: note.ref === 'x1' ? 'Southbank 集市有河边小吃摊。' : 'Southbank 集市还有艺术摊位。',
        isDetailLoaded: true,
      }),
    );
    const configured = {
      ...deps,
      env: { ...deps.env, XHS_RESEARCH_ENABLED: true },
      xhsSearch: { find: vi.fn(() => Promise.resolve(cards)), readNote },
    };
    const result = await runInbound({
      deps: configured as never,
      ctx: { ...ctx(1), demand: { category: 'other', confidence: 1, lang: 'zh' } },
      input: '伦敦有什么集市推荐',
    });
    expect(result.kind).toBe('interrupted');
    expect(readNote).toHaveBeenCalledTimes(2);
    const preview = (runStates[0]!['interruptions'] as Array<{ draftText?: string }>)[0]?.draftText;
    expect(preview).toContain('综合2篇');
    model.enqueue([assistantMessage('done')]);
    await resumeRun({
      deps: configured as never,
      runState: runStates[0]!,
      approval: { decision: 'approve' },
    });
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    expect(readNote).toHaveBeenCalledTimes(2);
    const [draft] = repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('综合2篇');
    expect(draft.text).toBe(preview);
  });
  it('returns schema field limits to the model with sensitive tracing disabled and recovers once', async () => {
    const note = {
      ref: 'x1',
      title: 'Southbank 集市',
      desc: 'Southbank 集市有河边小吃摊。',
      author: '作者',
      likes: 1,
      url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok',
    };
    const item = {
      name: 'Southbank 集市',
      aliases: [],
      group: '市集',
      summary: '河边小吃摊。',
      reason: '适合散步。',
      sources: [{ ref: 'x1', passages: ['x1:p1'] }],
      facts: [],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'reply_with_xhs_notes',
          {
            intro: '可以看这个：',
            recommendations: [
              { ...item, sources: Array.from({ length: 5 }, () => item.sources[0]) },
            ],
          },
          { callId: 'bad-schema' },
        ),
      ],
      [
        functionCall(
          'reply_with_xhs_notes',
          { intro: '可以看这个：', recommendations: [item] },
          { callId: 'repaired-schema' },
        ),
      ],
      [assistantMessage('done')],
    ]);
    const { deps, repos } = makeDeps(model);
    await runInbound({
      deps: {
        ...deps,
        env: { ...deps.env, XHS_RESEARCH_ENABLED: true },
        xhsSearch: { find: () => Promise.resolve([]) },
      } as never,
      ctx: {
        ...ctx(0),
        xhsNotes: [note],
        demand: { category: 'other', confidence: 1, lang: 'zh' },
      },
      input: '伦敦有什么集市推荐',
    });
    const session = await repos.sessionItems.list();
    const errors = JSON.stringify(
      session.filter(
        (i: unknown) =>
          typeof i === 'object' && i !== null && 'type' in i && i.type === 'function_call_result',
      ),
    );
    expect(errors).toContain('recommendations.0.sources');
    expect(errors).toContain('4');
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
  });
  it.each(['schema', 'evidence'] as const)(
    'ends after three invalid outbound calls (%s), with one trace per call',
    async (kind) => {
      const args =
        kind === 'schema'
          ? { text: '', supplierIds: ['a'] }
          : { text: 'A candidate', supplierIds: ['unknown'] };
      const model = new ScriptedModel([
        ...Array.from({ length: 3 }, (_, i) => [
          functionCall('reply_in_group', args, { callId: `invalid-${i}` }),
        ]),
        [assistantMessage('done')],
      ]);
      const { deps, repos } = makeDeps(model);
      if (kind === 'evidence') repos.suppliers.findByIds.mockResolvedValue([]);
      const result = await runInbound({ deps: deps as never, ctx: ctx(0), input: 'need a van' });
      expect(result.kind).toBe('completed');
      expect(repos.outbound.create).not.toHaveBeenCalled();
      const rows = repos.traces.create.mock.calls.map(
        ([row]) => row as { output?: { gate?: string; reason?: string } },
      );
      expect(rows.filter((row) => row.output?.gate === 'outbound_input')).toHaveLength(3);
      expect(rows.filter((row) => row.output?.reason === 'input_retry_limit')).toHaveLength(1);
      const errors = JSON.stringify(await repos.sessionItems.list());
      expect(errors).toContain('not sent: outbound input retry limit');
      expect(errors).not.toContain('unknown supplier id: unknown');
    },
  );
  it('repairs a short market fact quote using precise schema feedback without weakening evidence', async () => {
    const listing = {
      id: 'listing_a',
      ref: 'm1',
      title: '伦敦 硅胶锅铲',
      description: '硅胶锅铲，伦敦象堡自提。',
      tags: ['物品交易'],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/listing_a',
      sourceUrl: null,
      isRepost: false,
      priceLabel: '帖子未标价',
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: null,
      createdAt: null,
    };
    const item = {
      ref: 'm1',
      name: '硅胶锅铲',
      group: '厨房',
      summary: '可自提的硅胶锅铲。',
      reason: '符合要找的锅铲类型。',
      evidence: listing.description,
      facts: [{ label: 'location', value: '伦敦', quote: '伦敦' }],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'reply_with_market_results',
          { intro: '有闲找到这条公开帖子：', recommendations: [item] },
          { callId: 'bad-market' },
        ),
      ],
      [
        functionCall(
          'reply_with_market_results',
          {
            intro: 'A2H找到这条公开帖子：',
            recommendations: [
              {
                ...item,
                facts: [{ label: 'location', value: '伦敦象堡', quote: '伦敦象堡自提。' }],
              },
            ],
          },
          { callId: 'fixed-market' },
        ),
      ],
      [assistantMessage('done')],
    ]);
    const { deps, repos } = makeDeps(model);
    const c = { ...ctx(0), marketListings: [listing] };
    await runInbound({
      deps: { ...deps, marketSearch: { find: vi.fn(), detail: vi.fn() } } as never,
      ctx: c as never,
      input: '收 硅胶锅铲/炒菜木铲',
    });
    expect(repos.outbound.create).toHaveBeenCalledOnce();
    const errors = JSON.stringify(await repos.sessionItems.list());
    expect(errors).toContain('recommendations.0.facts.0.quote');
    expect(errors).toContain('4');
    const rows = repos.traces.create.mock.calls.map(
      ([row]) => row as { output?: { reason?: string; detail?: string[] } },
    );
    const denied = rows.find((row) => row.output?.reason === 'invalid_schema');
    expect(denied?.output?.detail).toEqual(['recommendations.0.facts.0.quote:too_small']);
    model.assertComplete();
  });
  it('researches public market offers, enriches them and resumes an approved grouped recommendation with stable refs', async () => {
    const listing = {
      id: 'listing_a',
      title: '伦敦小绿锅',
      description: '小绿锅成色新，Camberwell 自提。',
      tags: ['物品交易'],
      tradeType: 'SELL',
      status: 'ON_SALE',
      url: 'https://a2hmarket.ai/listings/listing_a',
      sourceUrl: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok',
      isRepost: true,
      priceLabel: '帖子未标价',
      availableFrom: null,
      availableUntil: null,
      sourcePublishedAt: '2026-09-01T00:00:00Z',
      createdAt: '2026-10-01T00:00:00Z',
    };
    const args = {
      intro: '这条可以先看成色和位置：',
      recommendations: [
        {
          ref: 'm1',
          name: '小绿锅',
          group: '厨房',
          summary: '成色新，可在 Camberwell 自提。',
          reason: '适合想自提的人。',
          evidence: '小绿锅成色新，Camberwell 自提',
          facts: [],
        },
      ],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'market_search',
          {
            intent: 'second_hand',
            purpose: 'discover',
            queries: [{ keyword: '小绿锅', page: 1, tradeType: 'SELL', entity: null }],
          },
          { callId: 'market1' },
        ),
      ],
      [functionCall('market_enrich', { refs: ['m1'] }, { callId: 'detail1' })],
      [functionCall('reply_with_market_results', args, { callId: 'market-reply' })],
    ]);
    const { deps, repos, runStates } = makeDeps(model);
    const marketSearch = {
      find: vi.fn(() => Promise.resolve({ items: [listing], hasNext: false, total: 1 })),
      detail: vi.fn(() => Promise.resolve(listing)),
    };
    const configured = { ...deps, marketSearch };
    expect(
      await runInbound({
        deps: configured as never,
        ctx: {
          ...ctx(1),
          source: { messageId: '77', userId: '42' },
          demand: { category: 'second_hand', confidence: 0.95, lang: 'zh' },
        },
        input: '伦敦收小绿锅',
      }),
    ).toMatchObject({ kind: 'interrupted' });
    expect(repos.outbound.create).not.toHaveBeenCalled();
    model.enqueue([assistantMessage('done')]);
    const state = runStates[0];
    if (!state) throw new Error('missing market snapshot');
    await resumeRun({
      deps: configured as never,
      runState: state,
      approval: { decision: 'approve' },
    });
    expect(repos.outbound.create).toHaveBeenCalledWith(
      expect.objectContaining({ replyToMessageId: '77', mentionUserId: '42' }),
      'pending',
    );
    const [draft] = repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('[A2H详情]');
    expect(draft.text).toContain('小红书原帖');
    expect(marketSearch.find).toHaveBeenCalledTimes(1);
    expect(marketSearch.detail).toHaveBeenCalledTimes(1);
    model.assertComplete();
  });
  it('searches notes, recommends a concrete option, persists approval and resumes the same draft', async () => {
    const args = {
      intro: '想逛河边集市的话，我会先看这个：',
      recommendations: [
        {
          name: 'Southbank 集市',
          aliases: [],
          group: '河边集市',
          summary: '河边的小吃集市，可以边逛边吃。',
          reason: '适合想散步又想吃小吃的人。',
          sources: [{ ref: 'x1', passages: ['x1:p1'] }],
          facts: [],
        },
      ],
    };
    const model = new ScriptedModel([
      [
        functionCall(
          'xhs_search',
          {
            purpose: 'discover',
            queries: [
              {
                keyword: '伦敦 圣诞集市',
                page: 1,
                sort: 'general',
                timeFilter: '不限',
                entity: null,
              },
            ],
          },
          { callId: 'search1' },
        ),
      ],
      [functionCall('reply_with_xhs_notes', args, { callId: 'reply1' })],
    ]);
    const { deps, repos, runStates } = makeDeps(model);
    const xhsSearch = {
      find: vi.fn(() =>
        Promise.resolve([
          {
            ref: 'x1',
            title: '伦敦圣诞集市攻略',
            author: '作者',
            desc: 'Southbank 集市有河边小吃摊，适合散步。',
            likes: 5,
            url: 'https://www.xiaohongshu.com/explore/n1?xsec_token=tok',
          },
        ]),
      ),
    };
    const configured = { ...deps, env: { ...deps.env, XHS_RESEARCH_ENABLED: true }, xhsSearch };
    const result = await runInbound({
      deps: configured as never,
      ctx: { ...ctx(1), demand: { category: 'other', confidence: 0.9, lang: 'zh' } },
      input: '伦敦有什么集市推荐',
    });
    expect(result.kind).toBe('interrupted');
    expect(repos.outbound.create).not.toHaveBeenCalled();
    expect(xhsSearch.find).toHaveBeenCalledTimes(1);
    model.enqueue([assistantMessage('done')]);
    const state = runStates[0];
    if (!state) throw new Error('missing approval snapshot');
    await resumeRun({
      deps: configured as never,
      runState: state,
      approval: { decision: 'approve' },
    });
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
    const [draft] = repos.outbound.create.mock.calls[0] as unknown as [{ text: string }];
    expect(draft.text).toContain('1. Southbank 集市');
    expect(draft.text).toContain(
      '[小红书原文 1](https://www.xiaohongshu.com/explore/n1?xsec_token=tok)',
    );
    expect(xhsSearch.find).toHaveBeenCalledTimes(1);
  });
  it('phase 1: outbound tool interrupts and an encrypted run_state row is written', async () => {
    const model = new ScriptedModel([[replyCall()]]);
    const { deps, repos, runStates } = makeDeps(model);
    const r = await runInbound({
      deps: deps as never,
      ctx: ctx(1),
      input: 'need a van Sunday E14',
    });
    expect(r).toEqual({ kind: 'interrupted', runStateId: 'rs1' });
    const created = (repos.runStates.create.mock.calls[0] as unknown[])[0] as Record<
      string,
      unknown
    >;
    expect(created['userId']).toBe('u1');
    expect(created['agentVersion']).toBe(AGENT_VERSION);
    expect(String(created['sdkVersion'])).toMatch(/^\d+\.\d+\.\d+/);
    expect(String(created['snapshot'])).toMatch(/^v1\./); // 已加密，不是明文 JSON
    expect(repos.outbound.create).not.toHaveBeenCalled(); // 未批准前不得写出站
    expect(runStates).toHaveLength(1);
  });

  it('phase 0: tools run end-to-end and outbound stays dry_run', async () => {
    const model = new ScriptedModel([
      [
        functionCall(
          'upsert_demand',
          {
            category: 'man_and_van',
            whenText: 'Sunday',
            whenAt: null,
            fromPostcode: 'E14',
            toPostcode: null,
            quantity: null,
            budgetPence: null,
            lang: 'en',
            confidence: 0.9,
          },
          { callId: 'c1' },
        ),
      ],
      [replyCall('c2')],
      [assistantMessage('done')],
    ]);
    const { deps, repos } = makeDeps(model);
    const r = await runInbound({
      deps: deps as never,
      ctx: ctx(0),
      input: 'need a van Sunday E14',
    });
    expect(r).toEqual({ kind: 'completed', toolsCalled: ['upsert_demand', 'reply_in_group'] });
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'dry_run');
    expect(repos.runStates.create).not.toHaveBeenCalled();
    model.assertComplete();
  });

  it('resumeRun: approved interruption executes the tool and queues a pending outbound', async () => {
    const model = new ScriptedModel([[replyCall()]]);
    const { deps, repos, runStates } = makeDeps(model);
    const interrupted = await runInbound({ deps: deps as never, ctx: ctx(1), input: 'need a van' });
    expect(interrupted.kind).toBe('interrupted');

    model.enqueue([assistantMessage('posted')]);
    const runState = runStates[0];
    if (!runState) throw new Error('expected a persisted run state');
    const r = await resumeRun({
      deps: deps as never,
      runState,
      approval: { decision: 'approve' },
    });
    expect(r).toEqual({ kind: 'completed', toolsCalled: ['reply_in_group'] });
    expect(repos.outbound.create).toHaveBeenCalledWith(expect.anything(), 'pending');
  });

  it('resumeRun: rejected interruption does not write outbound', async () => {
    const model = new ScriptedModel([[replyCall()]]);
    const { deps, repos, runStates } = makeDeps(model);
    await runInbound({ deps: deps as never, ctx: ctx(1), input: 'need a van' });
    model.enqueue([assistantMessage('ok, not posting')]);
    const runState = runStates[0];
    if (!runState) throw new Error('expected a persisted run state');
    const r = await resumeRun({
      deps: deps as never,
      runState,
      approval: { decision: 'reject' },
    });
    expect(r.kind).toBe('completed');
    expect(repos.outbound.create).not.toHaveBeenCalled();
  });
});
