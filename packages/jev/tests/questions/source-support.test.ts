import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createJevClient } from '../../src/client.js';
import { evaluateSourceSupport, type SourceClaim } from '../../src/questions/source-support.js';
const fixture = readFileSync(new URL('../fixtures/source-support.json', import.meta.url), 'utf8');
const claims: SourceClaim[] = [
  {
    goalId: 'home',
    criterionId: 'pets',
    goal: '一居室',
    requirement: '可养猫',
    proposedStatus: 'supported',
    sourceId: 'a',
    quote: '允许养猫',
  },
  {
    goalId: 'home',
    criterionId: 'pets',
    goal: '一居室',
    requirement: '可养猫',
    proposedStatus: 'supported',
    sourceId: 'b',
    quote: '允许养猫',
  },
];
describe('source support evaluator', () => {
  it('maps fixture probabilities without replacing a failed claim with a default success', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response(fixture)),
    ) as unknown as typeof fetch;
    const client = createJevClient({
      baseUrl: 'https://jev.test',
      apiKey: 'fixture',
      model: 'fixture',
      fetchImpl,
      traces: { create: () => Promise.resolve({}) } as never,
      logger: { warn: vi.fn() } as never,
    });
    expect(
      await evaluateSourceSupport(client, {
        taskContext: '找可养猫一居室',
        claims,
        sources: [
          { id: 'a', text: '允许养猫' },
          { id: 'b', text: '不允许养猫' },
        ],
        inputRef: 'm',
        phase: 0,
      }),
    ).toEqual({ ok: true, scores: [0.89, 0.02] });
  });
  it('propagates unavailable outcomes and skips a zero-claim model call', async () => {
    const evaluate = vi.fn(() => Promise.resolve({ ok: false, reason: 'timeout' }));
    const p = {
      taskContext: 'synthetic',
      claims: [],
      sources: [],
      inputRef: 'm',
      phase: 0 as const,
    };
    expect(await evaluateSourceSupport({ evaluate } as never, p)).toEqual({ ok: true, scores: [] });
    expect(evaluate).not.toHaveBeenCalled();
    expect(await evaluateSourceSupport({ evaluate } as never, { ...p, claims })).toEqual({
      ok: false,
      reason: 'timeout',
    });
  });
});
