import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { describe, expect, it, vi } from 'vitest';
import { processInbound } from '../../src/pipeline/inbound.js';

const msg = {
  channel: 'telegram' as const,
  chatId: '-1',
  messageId: '5',
  userId: '42',
  text: 'need a van E14 to SE1 sunday',
  receivedAt: new Date().toISOString(),
};

const verdict = {
  ok: true as const,
  isDemand: 0.92,
  isSupply: 0.05,
  category: 'man_and_van' as const,
  categoryConfidence: 0.9,
  urgency: 3,
  hasLocation: 0.9,
  isSensitive: 0.01,
  isMoveEvent: 0.1,
  isLocalRequest: 0.2,
};

function makeDeps(over: Record<string, unknown> = {}) {
  const traces = { create: vi.fn(() => Promise.resolve({})) };
  const users = { upsertByExternal: vi.fn(() => Promise.resolve({ id: 'u1' })) };
  const groups = {
    findByExternal: vi.fn(() => Promise.resolve({ id: 'g1', name: 'G', phase: 0, isActive: true })),
  };
  const messages = {
    findExisting: vi.fn(() => Promise.resolve(null)),
    create: vi.fn(() => Promise.resolve({ id: 'm1' })),
    recentByUser: vi.fn(() => Promise.resolve([])),
  };
  const demands = {
    findOpenByUser: vi.fn(() => Promise.resolve([])),
    create: vi.fn(() => Promise.resolve({ id: 'd1' })),
  };
  const runStates = { findById: vi.fn(() => Promise.resolve({ id: 'rs1' })) };
  const repos = { traces, users, groups, messages, demands, runStates };
  const evaluateInbound = vi.fn(() => Promise.resolve(verdict));
  const runInbound = vi.fn(() =>
    Promise.resolve({ kind: 'completed', toolsCalled: ['upsert_demand', 'reply_in_group'] }),
  );
  const publishApproval = vi.fn(() => Promise.resolve());
  const deps = {
    env: { DEFAULT_PHASE: 0 },
    repos,
    jev: { evaluate: vi.fn() },
    thresholds: DEFAULT_THRESHOLDS,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    evaluateOutbound: vi.fn(),
    evaluateInbound,
    runInbound,
    publishApproval,
    cards: { sendApprovalCard: vi.fn() },
    ...over,
  };
  return { deps, repos, traces, evaluateInbound, runInbound, publishApproval, demands, runStates };
}

/** 取某个 mock 的第一次调用的第一个参数（vitest 推不出形状，测试里显式收窄）。 */
function firstArg<T>(fn: { mock: { calls: unknown[][] } }): T {
  const call = fn.mock.calls[0];
  expect(call, 'expected the mock to have been called').toBeDefined();
  return (call as unknown[])[0] as T;
}

interface RunInboundArg {
  ctx: Record<string, unknown>;
  input: string;
}

/** 断言写过一条带该 outcome 的 trace，并返回它。 */
function traceWith(traces: { create: ReturnType<typeof vi.fn> }, outcome: string) {
  const call = traces.create.mock.calls.find(
    (c) => (c[0] as { output: { outcome?: string } }).output.outcome === outcome,
  );
  expect(call, `expected a trace with outcome=${outcome}`).toBeDefined();
  return (call as unknown[])[0] as {
    kind: string;
    inputRef: string;
    output: Record<string, unknown>;
  };
}

describe('processInbound', () => {
  it('blacklisted text is dropped by rule and jev is never called', async () => {
    const t = makeDeps();
    await processInbound(t.deps as never, { ...msg, text: '有人换汇吗' });
    expect(t.evaluateInbound).not.toHaveBeenCalled();
    expect(t.runInbound).not.toHaveBeenCalled();
    expect(traceWith(t.traces, 'dropped_by_rule').kind).toBe('rule');
  });

  it('empty text and bot commands are dropped by rule before any IO', async () => {
    for (const text of ['   ', '/start']) {
      const t = makeDeps();
      await processInbound(t.deps as never, { ...msg, text });
      expect(traceWith(t.traces, 'dropped_by_rule').kind).toBe('rule');
      expect(t.repos.messages.create).not.toHaveBeenCalled();
      expect(t.evaluateInbound).not.toHaveBeenCalled();
    }
  });

  it('inactive group is dropped by rule', async () => {
    const t = makeDeps();
    t.repos.groups.findByExternal.mockResolvedValue({
      id: 'g1',
      name: 'G',
      phase: 0,
      isActive: false,
    });
    await processInbound(t.deps as never, msg);
    expect(traceWith(t.traces, 'dropped_by_rule').output['reason']).toBe('group_inactive');
    expect(t.evaluateInbound).not.toHaveBeenCalled();
  });

  it('service demand enters agent with user-scoped context', async () => {
    const t = makeDeps();
    await processInbound(t.deps as never, msg);
    const arg = firstArg<RunInboundArg>(t.runInbound);
    expect(arg.input).toBe(msg.text);
    expect(arg.ctx).toMatchObject({
      userId: 'u1',
      chatId: '-1',
      groupId: 'g1',
      phase: 0,
      sourceMessageId: 'm1',
    });
    expect(traceWith(t.traces, 'entered_agent').kind).toBe('gate');
    expect(traceWith(t.traces, 'agent_completed').output['toolsCalled']).toEqual([
      'upsert_demand',
      'reply_in_group',
    ]);
  });

  it('jev unavailable -> no agent (AGENTS.md §3.3 第 5 条)', async () => {
    const t = makeDeps({
      evaluateInbound: vi.fn(() => Promise.resolve({ ok: false, reason: 'timeout' })),
    });
    await processInbound(t.deps as never, msg);
    expect(t.runInbound).not.toHaveBeenCalled();
    const tr = traceWith(t.traces, 'dropped_by_jev');
    expect(tr.output['reason']).toBe('timeout');
    expect(tr.output['jevAvailable']).toBe(false);
  });

  it('sensitive verdict drops without entering agent', async () => {
    const t = makeDeps({
      evaluateInbound: vi.fn(() => Promise.resolve({ ...verdict, isSensitive: 0.95 })),
    });
    await processInbound(t.deps as never, msg);
    expect(t.runInbound).not.toHaveBeenCalled();
    expect(traceWith(t.traces, 'dropped_by_jev').output['reason']).toBe('sensitive');
  });

  it('non-service category with move-event signal is tagged, not routed to agent', async () => {
    const t = makeDeps({
      evaluateInbound: vi.fn(() =>
        Promise.resolve({ ...verdict, category: 'housing', isMoveEvent: 0.9 }),
      ),
    });
    await processInbound(t.deps as never, msg);
    expect(t.runInbound).not.toHaveBeenCalled();
    expect(t.demands.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', isMoveEvent: true, sourceMessageId: 'm1' }),
    );
    expect(traceWith(t.traces, 'tagged_move_event').kind).toBe('gate');
  });

  it('interrupted run publishes an approval card and leaves a trace', async () => {
    const t = makeDeps({
      runInbound: vi.fn(() => Promise.resolve({ kind: 'interrupted', runStateId: 'rs1' })),
    });
    await processInbound(t.deps as never, msg);
    expect(t.runStates.findById).toHaveBeenCalledWith('rs1');
    expect(firstArg<{ runState: { id: string } }>(t.publishApproval).runState).toEqual({
      id: 'rs1',
    });
    expect(traceWith(t.traces, 'agent_interrupted').output['runStateId']).toBe('rs1');
  });

  it('open demand of the same category is carried into the agent context', async () => {
    const t = makeDeps();
    t.repos.demands.findOpenByUser.mockResolvedValue([
      {
        id: 'd9',
        category: 'man_and_van',
        confidence: 0.8,
        fromPostcode: 'E14',
        toPostcode: null,
        whenText: 'sunday',
        whenAt: null,
        quantity: null,
        budgetPence: null,
        lang: 'en',
      },
    ] as never);
    await processInbound(t.deps as never, msg);
    expect(firstArg<RunInboundArg>(t.runInbound).ctx).toMatchObject({
      demandId: 'd9',
      demand: { category: 'man_and_van', fromPostcode: 'E14', whenText: 'sunday', lang: 'en' },
    });
  });

  it('private chat skips the group lookup and uses the default phase', async () => {
    const t = makeDeps({ env: { DEFAULT_PHASE: 1 } });
    await processInbound(t.deps as never, { ...msg, chatId: '42' });
    expect(t.repos.groups.findByExternal).not.toHaveBeenCalled();
    expect(firstArg<RunInboundArg>(t.runInbound).ctx).toMatchObject({ groupId: null, phase: 1 });
  });
});

describe('processInbound — redelivery and agent failures', () => {
  it('does not reprocess a message that was already stored (queue redelivery)', async () => {
    const { deps, repos, traces, runInbound, evaluateInbound } = makeDeps();
    repos.messages.findExisting.mockResolvedValueOnce({ id: 'm-old' } as never);
    await processInbound(deps as never, msg);
    expect(repos.messages.create).not.toHaveBeenCalled();
    expect(evaluateInbound).not.toHaveBeenCalled();
    expect(runInbound).not.toHaveBeenCalled();
    expect(traceWith(traces, 'dropped_by_rule')).toMatchObject({
      output: { reason: 'duplicate_delivery' },
    });
  });

  it('contains an agent crash instead of throwing it back to the queue', async () => {
    const boom = Object.assign(new Error('Max turns (8) exceeded'), {
      name: 'MaxTurnsExceededError',
    });
    const { deps, traces } = makeDeps({ runInbound: vi.fn(() => Promise.reject(boom)) });
    await expect(processInbound(deps as never, msg)).resolves.toBeUndefined();
    expect(traceWith(traces, 'agent_failed')).toMatchObject({
      output: { error: 'MaxTurnsExceededError' },
    });
  });

  it('lets an out-of-catalogue local request into the agent as category other', async () => {
    const local = { ...verdict, category: 'other' as const, isDemand: 0.2, isLocalRequest: 0.95 };
    const { deps, runInbound } = makeDeps({ evaluateInbound: vi.fn(() => Promise.resolve(local)) });
    await processInbound(deps as never, { ...msg, text: '哪里能订中式生日蛋糕' });
    expect(runInbound).toHaveBeenCalled();
  });
});
