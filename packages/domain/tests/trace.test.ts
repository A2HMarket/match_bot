import { describe, expect, it } from 'vitest';
import { decisionTraceInputSchema, TRACE_KINDS } from '../src/trace.js';
import { INBOUND_QUESTION_IDS, OUTBOUND_QUESTION_IDS } from '../src/jev-questions.js';

describe('decisionTraceInputSchema', () => {
  it('defaults costMicro to 0', () => {
    const t = decisionTraceInputSchema.parse({
      kind: 'jev',
      inputRef: 'msg_1',
      output: { a: 1 },
      phase: 0,
      latencyMs: 12,
    });
    expect(t.costMicro).toBe(0);
  });
  it('rejects unknown kind', () => {
    expect(() =>
      decisionTraceInputSchema.parse({
        kind: 'llm',
        inputRef: 'x',
        output: {},
        phase: 0,
        latencyMs: 1,
      }),
    ).toThrow();
  });
  it('exposes all kinds', () => {
    expect(TRACE_KINDS).toEqual(['rule', 'jev', 'agent_run', 'gate']);
  });
});

describe('question ids', () => {
  it('inbound and outbound ids do not overlap', () => {
    const overlap = INBOUND_QUESTION_IDS.filter((id) =>
      (OUTBOUND_QUESTION_IDS as readonly string[]).includes(id),
    );
    expect(overlap).toEqual([]);
  });
});
