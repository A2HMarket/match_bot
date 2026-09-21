import type { DemandDraft, OutboundQuestionId, Phase } from '@matchbot/domain';
import type { JevClient } from '../client.js';
import type { JevQuestion } from '../types.js';

export function outboundQuestions(): Record<OutboundQuestionId, JevQuestion> {
  return {
    worth_replying: {
      type: 'score',
      instructions:
        'Given the demand and the draft reply, how valuable is posting this reply in the group?',
      criteria: ['Not useful or off-topic', 'Marginal', 'Useful', 'Clearly useful and specific'],
    },
    language_ok: {
      type: 'noul',
      instructions: 'Is the draft written in the same language as the demand?',
    },
    mentions_unverified: {
      type: 'noul',
      instructions:
        'Does the draft mention any supplier not present in the provided supplier list?',
    },
  };
}

export interface OutboundVerdict {
  ok: true;
  worthReplying: number;
  languageOk: number;
  mentionsUnverified: number;
}

export async function evaluateOutbound(
  client: JevClient,
  p: {
    draft: string;
    demand: DemandDraft;
    supplierSummaries: string[];
    recentReplies: string[];
    inputRef: string;
    phase: Phase;
  },
): Promise<OutboundVerdict | { ok: false; reason: string }> {
  const r = await client.evaluate({
    state: {
      draft: p.draft,
      demand: p.demand,
      suppliers: p.supplierSummaries,
      recent_group_replies: p.recentReplies,
    },
    questions: outboundQuestions(),
    inputRef: p.inputRef,
    phase: p.phase,
  });
  if (!r.ok) return r;
  const a = r.answers;
  return {
    ok: true,
    worthReplying: a.worth_replying.type === 'score' ? a.worth_replying.score : 0,
    languageOk: a.language_ok.type === 'noul' ? a.language_ok.noul : 0,
    mentionsUnverified: a.mentions_unverified.type === 'noul' ? a.mentions_unverified.noul : 1,
  };
}
