import { OUTBOUND_QUESTION_IDS } from '@matchbot/domain';
import { describe, expect, it, vi } from 'vitest';
import type { JevClient } from '../../src/client.js';
import { evaluateOutbound, outboundQuestions } from '../../src/questions/outbound.js';

describe('outbound', () => {
  it('question ids match domain', () => {
    expect(Object.keys(outboundQuestions()).sort()).toEqual([...OUTBOUND_QUESTION_IDS].sort());
  });
  it('maps to verdict', async () => {
    const client: JevClient = {
      evaluate: vi.fn(() =>
        Promise.resolve({
          ok: true,
          usage: { input_tokens: 1 },
          answers: {
            worth_replying: {
              type: 'score',
              score: 2.6,
              legend: {},
              probabilities: {},
              confidence: 0.8,
            },
            language_ok: { type: 'noul', noul: 0.97 },
            mentions_unverified: { type: 'noul', noul: 0.02 },
          },
        }),
      ) as never,
    };
    const v = await evaluateOutbound(client, {
      draft: 'Here are 3 options',
      demand: { category: 'man_and_van', confidence: 0.9 },
      supplierSummaries: ['Van Co £40/h'],
      recentReplies: [],
      inputRef: 'r1',
      phase: 1,
    });
    expect(v).toEqual({ ok: true, worthReplying: 2.6, languageOk: 0.97, mentionsUnverified: 0.02 });
  });
});
