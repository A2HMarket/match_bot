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
