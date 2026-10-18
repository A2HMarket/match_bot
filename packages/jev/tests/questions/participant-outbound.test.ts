import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { evaluateParticipantOutbound } from '../../src/questions/participant-outbound.js';
import { jevResponseSchema } from '../../src/schema.js';
const fixture = z
  .object({
    cases: z.array(
      z.object({
        id: z.number(),
        goal: z.string(),
        text: z.string(),
        expected: z.string(),
        response: z.object({ ok: z.literal(true), answers: jevResponseSchema.shape.answers }),
      }),
    ),
  })
  .parse(
    JSON.parse(
      readFileSync(new URL('../fixtures/participant-outbound.json', import.meta.url), 'utf8'),
    ),
  );
describe('recorded participant-role decisions', () => {
  it.each(fixture.cases)('maps case $id without reusing assistant-answer questions', async (c) => {
    const evaluate = vi.fn().mockResolvedValue({ ok: true, ...c.response });
    const verdict = await evaluateParticipantOutbound({ evaluate } as never, {
      draft: c.text,
      demand: { category: 'other', confidence: 1, need: c.goal },
      supplierSummaries: [],
      recentReplies: [],
      inputRef: 'synthetic',
      phase: 2,
    });
    const [call] = evaluate.mock.calls[0] as unknown as [
      { state: unknown; questions: Record<string, unknown> },
    ];
    expect(call.state).toEqual({ participant_goal: c.goal, participant_message: c.text });
    expect(Object.keys(call.questions).sort()).toEqual([
      'contradicts_goal',
      'goal_relevance',
      'is_same_language',
    ]);
    expect(verdict).toMatchObject({ ok: true });
    if (!verdict.ok) throw new Error('recorded decision failed');
    expect(verdict.worthReplying).toBe(
      c.response.answers.goal_relevance?.type === 'score'
        ? c.response.answers.goal_relevance.score
        : 0,
    );
    expect(verdict.mentionsUnverified).toBe(
      c.response.answers.contradicts_goal?.type === 'noul'
        ? c.response.answers.contradicts_goal.noul
        : 1,
    );
  });
  it.each(['timeout', 'rate_limited', 'invalid_response', 'trace_unavailable'] as const)(
    'retains fail-closed outcome: %s',
    async (reason) => {
      const evaluate = vi.fn().mockResolvedValue({ ok: false, reason });
      await expect(
        evaluateParticipantOutbound({ evaluate } as never, {
          draft: '找书桌',
          demand: { category: 'other', confidence: 1 },
          supplierSummaries: [],
          recentReplies: [],
          inputRef: 'synthetic',
          phase: 2,
        }),
      ).resolves.toEqual({ ok: false, reason });
    },
  );
});
