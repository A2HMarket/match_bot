import {
  DEMAND_CATEGORIES,
  type DemandCategory,
  type InboundQuestionId,
  type Phase,
} from '@matchbot/domain';
import type { JevClient } from '../client.js';
import type { JevQuestion } from '../types.js';

/** 文案以 PoC V4 校准后的版本为准；这里是 docs/reference/jev-decision-model.md §6 的初版。 */
export function inboundQuestions(): Record<InboundQuestionId, JevQuestion> {
  return {
    is_demand: {
      type: 'noul',
      instructions:
        'Is the author asking for a paid local service (moving, cleaning, furniture assembly/removal) for themselves?',
      criteria: {
        true: 'Explicit request for a service',
        false: 'Chit-chat, offering a service, selling items, housing/job search',
      },
    },
    is_supply: {
      type: 'noul',
      instructions: 'Is the author OFFERING a service (has a van, can clean, can assemble)?',
    },
    category: {
      type: 'choice',
      instructions: 'Which category best fits the message?',
      criteria: {
        man_and_van: 'Moving, van, transport of boxes/furniture',
        eot_cleaning: 'End of tenancy / deep cleaning',
        furniture_service: 'Assembly, disassembly, furniture delivery or disposal',
        housing: 'Looking for or offering a room/flat',
        job: 'Looking for or offering work',
        second_hand: 'Buying or selling used items',
        other: 'None of the above',
      },
    },
    urgency: {
      type: 'score',
      instructions: 'How soon is the service needed?',
      criteria: ['No time given', 'Within a week', 'Within three days', 'Tomorrow', 'Today'],
    },
    has_location: {
      type: 'noul',
      instructions: 'Does the message contain a usable location (postcode, area, station)?',
    },
    is_sensitive: {
      type: 'noul',
      instructions:
        "Does the message involve currency exchange, crypto, or paying on someone's behalf?",
    },
    is_move_event: {
      type: 'noul',
      instructions:
        'Does the message imply the author is about to move home (looking for a room, leaving a tenancy, bought large furniture)?',
    },
  };
}

export interface InboundVerdict {
  ok: true;
  isDemand: number;
  isSupply: number;
  category: DemandCategory;
  categoryConfidence: number;
  urgency: number;
  hasLocation: number;
  isSensitive: number;
  isMoveEvent: number;
}

function noul(a: { type: string; noul?: number }): number {
  return a.type === 'noul' && typeof a.noul === 'number' ? a.noul : 0;
}

export async function evaluateInbound(
  client: JevClient,
  p: {
    text: string;
    groupName: string;
    lang?: string;
    recentTexts: string[];
    inputRef: string;
    phase: Phase;
  },
): Promise<InboundVerdict | { ok: false; reason: string }> {
  const r = await client.evaluate({
    state: {
      text: p.text,
      group: p.groupName,
      lang: p.lang,
      recent_messages_from_author: p.recentTexts,
    },
    questions: inboundQuestions(),
    inputRef: p.inputRef,
    phase: p.phase,
  });
  if (!r.ok) return r;
  const a = r.answers;
  const cat = a.category.type === 'choice' ? a.category : null;
  const category =
    cat && (DEMAND_CATEGORIES as readonly string[]).includes(cat.choice)
      ? (cat.choice as DemandCategory)
      : 'other';
  return {
    ok: true,
    isDemand: noul(a.is_demand),
    isSupply: noul(a.is_supply),
    category,
    categoryConfidence: cat?.confidence ?? 0,
    urgency: a.urgency.type === 'score' ? a.urgency.score : 0,
    hasLocation: noul(a.has_location),
    isSensitive: noul(a.is_sensitive),
    isMoveEvent: noul(a.is_move_event),
  };
}
