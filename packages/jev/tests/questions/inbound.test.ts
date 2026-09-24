import { INBOUND_QUESTION_IDS } from '@matchbot/domain';
import { describe, expect, it, vi } from 'vitest';
import type { JevClient } from '../../src/client.js';
import { evaluateInbound, inboundQuestions } from '../../src/questions/inbound.js';

describe('inboundQuestions', () => {
  it('covers exactly the domain question ids and category keys equal DemandCategory', () => {
    const q = inboundQuestions();
    expect(Object.keys(q).sort()).toEqual([...INBOUND_QUESTION_IDS].sort());
    const cat = q.category;
    expect(cat.type === 'choice' && Object.keys(cat.criteria).sort()).toEqual([
      'eot_cleaning',
      'furniture_service',
      'housing',
      'job',
      'man_and_van',
      'other',
      'second_hand',
    ]);
  });
});

describe('evaluateInbound', () => {
  it('maps answers to a verdict', async () => {
    const client: JevClient = {
      evaluate: vi.fn(() =>
        Promise.resolve({
          ok: true,
          usage: { input_tokens: 1 },
          answers: {
            is_demand: { type: 'noul', noul: 0.9 },
            is_supply: { type: 'noul', noul: 0.1 },
            category: {
              type: 'choice',
              choice: 'man_and_van',
              probabilities: { man_and_van: 0.9 },
              confidence: 0.85,
            },
            urgency: { type: 'score', score: 3.2, legend: {}, probabilities: {}, confidence: 0.7 },
            has_location: { type: 'noul', noul: 0.95 },
            is_sensitive: { type: 'noul', noul: 0.01 },
            is_move_event: { type: 'noul', noul: 0.2 },
            is_local_request: { type: 'noul', noul: 0.3 },
          },
        }),
      ) as never,
    };
    const v = await evaluateInbound(client, {
      text: 'van sunday E14',
      groupName: 'g',
      recentTexts: [],
      inputRef: 'm1',
      phase: 0,
    });
    expect(v).toMatchObject({
      ok: true,
      isDemand: 0.9,
      category: 'man_and_van',
      categoryConfidence: 0.85,
      urgency: 3.2,
      hasLocation: 0.95,
    });
  });
  it('passes through unavailability', async () => {
    const client: JevClient = {
      evaluate: vi.fn(() => Promise.resolve({ ok: false, reason: 'timeout' })) as never,
    };
    expect(
      await evaluateInbound(client, {
        text: 'x',
        groupName: 'g',
        recentTexts: [],
        inputRef: 'm2',
        phase: 0,
      }),
    ).toEqual({ ok: false, reason: 'timeout' });
  });
});
