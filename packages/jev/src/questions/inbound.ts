import {
  DEMAND_CATEGORIES,
  type DemandCategory,
  type InboundQuestionId,
  type Phase,
} from '@matchbot/domain';
import type { JevClient } from '../client.js';
import type { JevQuestion } from '../types.js';

/**
 * 文案逐字采用 PoC V4 校准后的 QUESTIONS_V3（scripts/poc/v4-jev-inbound/main.ts:184-198，
 * 见 scripts/poc/v4-jev-inbound/RESULT.md）。P5 的门控阈值（如 T_IS_DEMAND_ENTER=0.70）
 * 是针对这版文案校准的，不要改动措辞。
 */
export function inboundQuestions(): Record<InboundQuestionId, JevQuestion> {
  const CATEGORY_CRITERIA = {
    man_and_van: 'Moving home or transporting boxes/furniture by van, single-item delivery',
    eot_cleaning: 'End of tenancy, checkout, move-out or deep cleaning of a property',
    furniture_service: 'Furniture assembly, disassembly, mounting, delivery or disposal/clearance',
    housing: 'Looking for or offering a room, flat or house share',
    job: 'Looking for work or offering a job/shift to others',
    second_hand: 'Buying, selling or giving away used items',
    other: 'None of the above (chit-chat, questions, admin, currency exchange, news)',
  };
  const URGENCY_CRITERIA = [
    'No time given',
    'Within a week',
    'Within three days',
    'Tomorrow',
    'Today',
  ];
  return {
    is_demand: {
      type: 'noul',
      instructions:
        'The author is a member of a London community Telegram group. Is this message the author asking OTHERS for a paid local service for themselves — man & van / moving, end of tenancy cleaning, or furniture assembly, delivery or removal? Asking the group to recommend a provider counts as asking.',
      criteria: {
        true: 'The author needs the service done for them and wants a provider, a recommendation or a quote. Counts even if the time or address is missing.',
        false:
          'The author OFFERS the service themselves, advertises their own van or cleaning business, is looking for a room or a flat, is looking for or offering a job, is buying or selling second-hand items, or is just chatting, asking for information or exchanging currency.',
      },
    },
    is_supply: {
      type: 'noul',
      instructions:
        'Is the author OFFERING to perform a local service for others (has a van, can clean, can assemble furniture), i.e. advertising themselves as the provider?',
      criteria: {
        true: 'The author can do the job for someone else, advertises their van, team, rates or availability.',
        false:
          'The author needs the service done for them, or the message is about housing, jobs, second-hand items or chit-chat.',
      },
    },
    category: {
      type: 'choice',
      instructions:
        'Which category is this message about? Classify by SUBJECT MATTER only — a message offering a van and a message asking for a van are both man_and_van. If the author is looking for or offering work, choose job even when the work itself is cleaning or driving.',
      criteria: CATEGORY_CRITERIA,
    },
    urgency: {
      type: 'score',
      instructions:
        'How soon does the author need the service? Judge from the message only; if no time at all is mentioned, choose level 0.',
      criteria: URGENCY_CRITERIA,
    },
    has_location: {
      type: 'noul',
      instructions:
        'Does the message contain a usable London location — a UK postcode or outcode (E14, SE1, SW6), a borough or area name (Stratford, Ilford, Croydon), a station, or a zone?',
      criteria: {
        true: 'At least one postcode, outcode, area, borough or station is named.',
        false: 'No place is named, or only "London" / "anywhere" in general.',
      },
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
    // P14：库外需求走 web search。is_demand 的措辞写死了三个品类且已按 PoC V4 校准，
    // 不能改；「在找本地商家/店铺/地方」单独一题，阈值见 P14 §4 的校准记录。
    is_local_request: {
      type: 'noul',
      instructions:
        'The author is a member of a London community group. Is the author asking the group to recommend, or point them to, a local business, service provider, shop, clinic, restaurant or place in or around London, for their own use? Asking where to buy or find something counts.',
      criteria: {
        true: 'The author wants a provider, shop, place or contact for themselves, e.g. a locksmith, plumber, dentist, hairdresser, bakery, Asian supermarket, repair shop or a man and van. Counts even if no location is given.',
        false:
          'The author offers their own service or advertises a business; is looking for a room, flat or tenant; is looking for or offering a job; is buying, selling or giving away second-hand items; asks about rules, documents, visas or transport; exchanges currency; or is just chatting.',
      },
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
  isLocalRequest: number;
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
    isLocalRequest: noul(a.is_local_request),
  };
}
