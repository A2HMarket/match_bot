import type { JevClient } from '../client.js';
import type { JevQuestion } from '../types.js';
import type { evaluateOutbound, OutboundVerdict } from './outbound.js';

/** P31: server-selected user-role assessment; normal assistant answers retain their own rubric. */
export function participantOutboundQuestions() {
  return {
    goal_relevance: {
      type: 'score',
      instructions:
        'How relevant is participant_message as a USER request or clarification of participant_goal? The user is asking for help, not answering. Partial disclosure is relevant.',
      criteria: [
        'Unrelated or impersonating another role',
        'Only loosely related',
        'Relevant user request',
        'Directly states or clarifies this personal goal',
      ],
    },
    is_same_language: {
      type: 'noul',
      instructions:
        'Are participant_message and participant_goal in the same language? Chinese with English place names counts as Chinese.',
      criteria: { true: 'Same language', false: 'Different language' },
    },
    contradicts_goal: {
      type: 'noul',
      instructions:
        'Does participant_message contradict participant_goal or invent personal requirements, supplier facts, stock, delivery, prices or completed actions? Omitted conditions are allowed. A user asking for options asserts no supplier availability. Personal budgets, places and dates stated in participant_goal are supported user facts.',
      criteria: {
        true: 'Contradicts the fixed goal, introduces other personal requirements, or fabricates supplier facts/actions',
        false:
          'Only requests help or discloses facts already in the fixed goal, without unsupported assertions',
      },
    },
  } satisfies Record<string, JevQuestion>;
}
export async function evaluateParticipantOutbound(
  client: JevClient,
  p: Parameters<typeof evaluateOutbound>[1],
): Promise<OutboundVerdict | { ok: false; reason: string }> {
  const result = await client.evaluate({
    state: { participant_goal: p.demand.need, participant_message: p.draft },
    questions: participantOutboundQuestions(),
    inputRef: p.inputRef,
    phase: p.phase,
  });
  if (!result.ok) return result;
  const a = result.answers;
  return {
    ok: true,
    worthReplying: a.goal_relevance.type === 'score' ? a.goal_relevance.score : 0,
    languageOk: a.is_same_language.type === 'noul' ? a.is_same_language.noul : 0,
    mentionsUnverified: a.contradicts_goal.type === 'noul' ? a.contradicts_goal.noul : 1,
  };
}
