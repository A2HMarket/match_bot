import { readFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps } from '@matchbot/agent';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import { runActorLab } from '../src/actor-lab-run.js';
import type { ActorLabRuntime } from '../src/actor-lab-runtime.js';
import { actorLabConfigSchema, ACTOR_PROFILES } from '../src/actor-lab-config.js';
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
        row.externalMessageId = String(repos.outbound.create.mock.calls.length);
      }
      return Promise.resolve();
    }),
  };
  return { r, stop: () => onStop() };
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
