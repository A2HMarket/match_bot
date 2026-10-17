import type { DemandDraft, OutboundQuestionId, Phase } from '@matchbot/domain';
import type { JevClient } from '../client.js';
import type { JevQuestion } from '../types.js';

/** P23: calibrated on frozen source-grounded positive/negative pairs; see the Jev request-status evaluation. */
export function outboundQuestions(): Record<OutboundQuestionId, JevQuestion> {
  return {
    worth_replying: {
      type: 'score',
      instructions:
        'Evaluate usefulness for THIS request. A relevant explanation of why no exact match was confirmed, a practical alternative, or one necessary clarification is useful even without a perfect match. Explicit unknowns and failed searches are not off-topic. Penalize unrelated, empty boilerplate and needless repetition, not honest uncertainty.',
      criteria: ['Not useful or off-topic', 'Marginal', 'Useful', 'Clearly useful and specific'],
    },
    language_ok: {
      type: 'noul',
      instructions: 'Is the draft written in the same language as the demand?',
    },
    mentions_unverified: {
      type: 'noul',
      instructions:
        'Does the draft assert a provider/entity, price, date, capability, availability or fit not supported by the supplied source_evidence (legacy suppliers field)? Check every practical inference, not only numbers. Restated USER limits/preferences must agree with demand and request_context for the SAME subgoal and scope: each/per-item caps are not a shared total. Claiming two items exceed a total cap that was only per item invents a condition. Swapping item budgets, silently loosening a cap, or inventing a user condition counts as unsupported even when each number occurs elsewhere. User budget caps are not provider prices and do not need a listing to attest them. Separate posts do NOT prove different sellers, separate pickup addresses or one shared trip. A partially included package does NOT prove all equipment/services are included: venue and balls do not establish rackets or an empty-handed visit. Disassembly does not prove one person can carry an item or that assistance is unnecessary. This agent only performs synchronous read-only research: it has NO background watcher, later alerts, contacting or booking capability. A first-person offer or promise to keep watching later is an unsupported capability even if it does not claim the action already occurred. Advice for the USER to check later is allowed. Public listings/pages are evidence of what their text says, not independently verified real-world availability. Explicitly describing a missing condition or an unverified lead as unknown is NOT an unsupported claim. Conditional advice to confirm weight, equipment or location is useful and is not a guarantee. Reject inferred guarantees, wrong roles/dates, stale prices stated as current, and treating new students as beginner players. Do not require supplier-catalogue membership for official procedures, exhibitions or peer listings. For request_status, assess the fixed acknowledgement/next step, not the rejected recommendation.',
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
    requestContext?: string;
    supplierSummaries: string[];
    recentReplies: string[];
    inputRef: string;
    phase: Phase;
    replyPurpose?: 'answer' | 'request_status';
  },
): Promise<OutboundVerdict | { ok: false; reason: string }> {
  const r = await client.evaluate({
    state: {
      draft: p.draft,
      demand: p.demand,
      ...(p.requestContext ? { request_context: p.requestContext } : {}),
      source_evidence: p.supplierSummaries,
      reply_purpose: p.replyPurpose ?? 'answer',
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
