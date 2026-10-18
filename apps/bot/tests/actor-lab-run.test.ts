import { readFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { generateSimulatedUserTurn, type AgentDeps } from '@matchbot/agent';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { runActorLab } from '../src/actor-lab-run.js';
import type { ActorLabRuntime } from '../src/actor-lab-runtime.js';
import type { ActorLabInbox } from '../src/actor-lab-state.js';
import { actorLabConfigSchema, ACTOR_PROFILES } from '../src/actor-lab-config.js';
vi.mock(import('@matchbot/agent'), async (importOriginal) => ({
  ...(await importOriginal()),
  generateSimulatedUserTurn: vi.fn(),
}));
function runtime() {
  const cfg = actorLabConfigSchema.parse({
    groupId: '-123',
    groupTitle: 'A2H 测试',
    matchBotId: '999999',
    matchBotUsername: 'match_bot',
    controlDatabaseUrl: 'postgresql://a:b@127.0.0.1/matchbot_actor_lab',
    actors: ACTOR_PROFILES.map((p, i) => ({
      ...p,
      name: undefined,
      id: String(111111 + i),
      username: `actor_${i}_bot`,
      token: `${111111 + i}:${'x'.repeat(32)}`,
    })).map(({ name: _name, ...p }) => p),
    maxMessages: 3,
  });
  let row: Record<string, unknown> | null = null,
    onStop = () => {};
  const repos = {
    traces: {
      create: vi.fn().mockResolvedValue({}),
      summarizeUsage: vi
        .fn()
        .mockResolvedValue({ calls: 0, inputTokens: 0, outputTokens: 0, missingUsageCalls: 0 }),
    },
    outbound: {
      countUnfinished: vi.fn().mockResolvedValue(0),
      countSentToTargetSince: vi.fn().mockResolvedValue(0),
      create: vi.fn((d: unknown, status: string) => {
        row = { ...(d as object), id: 'out', status };
        return Promise.resolve(row);
      }),
      findByToolCallId: vi.fn(() => Promise.resolve(row)),
    },
  };
  const deps = {
    env: { OUTBOUND_UNSURE_ACTION: 'drop' },
    repos,
    logger: { info: vi.fn() },
    jev: {},
    thresholds: DEFAULT_THRESHOLDS,
    evaluateOutbound: vi
      .fn()
      .mockResolvedValue({ ok: true, worthReplying: 3, languageOk: 1, mentionsUnverified: 0 }),
  } as unknown as AgentDeps;
  const r = {
    cfg,
    repos,
    deps,
    depsForActor: () => deps,
    mainRepos: {
      groups: { findByExternal: vi.fn().mockResolvedValue(null) },
      users: { findByExternal: vi.fn().mockResolvedValue(null) },
      traces: repos.traces,
    },
    processor: { forceFlush: vi.fn().mockResolvedValue(undefined) },
    verify: vi.fn().mockResolvedValue(undefined),
    assertActive: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    startInbox: vi.fn((_inbox: unknown, _reply: unknown, stop: () => void) => {
      onStop = stop;
      return [];
    }),
    drain: vi.fn(() => {
      if (row) {
        row.status = 'sent';
        row.sentAt = new Date();
        row.externalMessageId = String(repos.outbound.create.mock.calls.length);
      }
      return Promise.resolve();
    }),
  };
  return { r, stop: () => onStop(), lastRow: () => row };
}
function report(path: string) {
  const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
  unlinkSync(path);
  return data;
}
describe('finite actor runs', () => {
  it('dry-runs first turns without polling, model generation or Telegram sender', async () => {
    const { r } = runtime();
    const result = await runActorLab(r as unknown as ActorLabRuntime, true);
    expect(result.sent).toBe(0);
    expect(r.startInbox).not.toHaveBeenCalled();
    expect(r.drain).not.toHaveBeenCalled();
    expect(r.deps.evaluateOutbound).not.toHaveBeenCalled();
    expect(report(result.report)).toMatchObject({
      mode: 'dry_run',
      events: [{ kind: 'dry_run' }, { kind: 'dry_run' }, { kind: 'dry_run' }],
    });
  });
  it('sends at most the configured number and records actual receipts', async () => {
    const { r } = runtime();
    const result = await runActorLab(r as unknown as ActorLabRuntime);
    expect(result.sent).toBe(3);
    expect(r.drain).toHaveBeenCalledTimes(3);
    expect(report(result.report)).toMatchObject({
      mode: 'live',
      history: [{ speaker: 'self' }, { speaker: 'self' }, { speaker: 'self' }],
    });
    expect(r.close).toHaveBeenCalledOnce();
  });
  it('counts receiver-account model usage and stops before the next send', async () => {
    const { r } = runtime();
    r.cfg.tokenBudget = 1000;
    let sent = false;
    const drain = r.drain.getMockImplementation()!;
    r.drain.mockImplementation(() => {
      sent = true;
      return drain();
    });
    const mainRepos = {
      groups: { findByExternal: vi.fn().mockResolvedValue({ id: 'group' }) },
      users: { findByExternal: vi.fn((_channel: string, id: string) => Promise.resolve({ id })) },
      messages: {
        recentByUser: vi.fn((id: string) =>
          Promise.resolve(
            sent && id === r.cfg.actors[0]!.id
              ? [
                  {
                    id: 'main-263',
                    externalId: '263',
                    userId: id,
                    groupId: 'group',
                    receivedAt: new Date(),
                    text: r.cfg.actors[0]!.firstMessage,
                  },
                ]
              : [],
          ),
        ),
      },
      traces: {
        summarizeUsage: vi.fn((p: { inputRefs: string[] }) =>
          Promise.resolve({
            calls: p.inputRefs.length,
            inputTokens: p.inputRefs.length ? 1001 : 0,
            outputTokens: 0,
            missingUsageCalls: 0,
          }),
        ),
      },
    };
    const result = await runActorLab({ ...r, mainRepos } as unknown as ActorLabRuntime);
    expect(result).toMatchObject({ sent: 1, reason: 'token_budget' });
    expect(mainRepos.traces.summarizeUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({ inputRefs: ['main-263'] }),
    );
    expect(report(result.report)).toMatchObject({ usage: { tokens: 1001 } });
  });
  it('honors a human stop before dispatching another actor', async () => {
    const { r, stop } = runtime(),
      drain = r.drain.getMockImplementation()!;
    r.drain.mockImplementation(() => {
      stop();
      return drain();
    });
    const result = await runActorLab(r as unknown as ActorLabRuntime);
    expect(result.sent).toBe(1);
    expect(result.reason).toBe('stopped');
    report(result.report);
  });
  it('runs consecutive turns for one actor from actual sent-reply transcripts without reusing main-account IDs', async () => {
    const { r, lastRow } = runtime();
    r.cfg.turnOrder = ['short', 'short', 'short'];
    r.cfg.waitForEachReply = true;
    const generate = vi
      .mocked(generateSimulatedUserTurn)
      .mockReset()
      .mockResolvedValueOnce({ text: '我坐地铁', done: false })
      .mockResolvedValueOnce({ text: '单程最多半小时', done: false });
    const actor = r.cfg.actors[0]!;
    const mainRepos = {
      ...r.mainRepos,
      groups: { findByExternal: vi.fn().mockResolvedValue({ id: 'group' }) },
      users: { findByExternal: vi.fn().mockResolvedValue({ id: 'user' }) },
      messages: {
        recentByUser: vi.fn(() =>
          Promise.resolve(
            lastRow()
              ? [
                  {
                    id: 'main-' + String(lastRow()!.externalMessageId),
                    userId: 'user',
                    groupId: 'group',
                    text: lastRow()!.text,
                    receivedAt: lastRow()!.sentAt,
                    executionStatus: 'completed',
                  },
                ]
              : [],
          ),
        ),
      },
      outbound: {
        findReplyForSource: vi
          .fn(() =>
            Promise.resolve({
              id: 'main-out-' + String(lastRow()!.externalMessageId),
              status: 'sent',
              externalMessageId: '999',
              sentAt: new Date(),
              text: '真实已发的回复：取货点还没写清。',
            }),
          )
          .mockResolvedValueOnce({
            id: 'pending-only',
            status: 'pending',
            externalMessageId: '999',
            sentAt: new Date(),
            text: 'pending_unseen_reply',
          }),
      },
    };
    const result = await runActorLab({ ...r, mainRepos } as unknown as ActorLabRuntime);
    expect(result.sent).toBe(3);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(generate.mock.calls)).not.toContain('pending_unseen_reply');
    expect(generate.mock.calls[0]?.[1].history).toContainEqual({
      speaker: 'match_bot',
      text: '真实已发的回复：取货点还没写清。',
    });
    expect(generate.mock.calls[1]?.[1].history).toContainEqual({
      speaker: 'self',
      text: '我坐地铁',
    });
    expect(r.deps.evaluateOutbound).toHaveBeenCalledTimes(3);
    expect(r.repos.outbound.create.mock.calls[1]?.[0]).not.toHaveProperty('replyToMessageId');
    expect(report(result.report)).toMatchObject({
      history: [
        { actorId: actor.id, speaker: 'self' },
        { actorId: actor.id, speaker: 'match_bot' },
        { actorId: actor.id, speaker: 'self' },
        { actorId: actor.id, speaker: 'match_bot' },
        { actorId: actor.id, speaker: 'self' },
        { actorId: actor.id, speaker: 'match_bot' },
      ],
    });
    generate.mockReset();
  });
  it('does not generate a new turn from an older reply when the current message has no reply', async () => {
    vi.useFakeTimers();
    const generate = vi
      .mocked(generateSimulatedUserTurn)
      .mockReset()
      .mockResolvedValue({ done: true, text: '' });
    const { r } = runtime();
    r.cfg.maxMessages = 2;
    r.cfg.turnOrder = ['short', 'short'];
    r.cfg.replyWaitSeconds = 5;
    r.startInbox.mockImplementation((candidate) => {
      const inbox = candidate as ActorLabInbox;
      inbox.registerSent('old', '111111');
      inbox.acceptDelivered({
        actorId: '111111',
        originalMessageId: 'old',
        outboundId: 'old-main',
        text: '旧答复，不能当成本条的回复',
      });
      return [];
    });
    try {
      const pending = runActorLab(r as unknown as ActorLabRuntime);
      await vi.advanceTimersByTimeAsync(5100);
      const result = await pending;
      expect(result.sent).toBe(1);
      expect(generate).not.toHaveBeenCalled();
      report(result.report);
    } finally {
      vi.useRealTimers();
      generate.mockReset();
    }
  });
  it('leaves a sanitized failure report and releases the lock', async () => {
    const { r } = runtime(),
      before = new Set(existsSync('logs/actor-lab') ? readdirSync('logs/actor-lab') : []);
    r.verify.mockRejectedValueOnce(new Error('SECRET must not be reported'));
    await expect(runActorLab(r as unknown as ActorLabRuntime)).rejects.toThrow();
    const path = 'logs/actor-lab/' + readdirSync('logs/actor-lab').find((f) => !before.has(f))!;
    const result = report(path);
    expect(result).toMatchObject({ reason: 'controller_error', errorKind: 'Error', usage: null });
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(r.close).toHaveBeenCalledOnce();
  });
});
