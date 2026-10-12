import { z } from 'zod';
import type { AgentDeps, MatchContext } from '../context.js';
import { makeOutboundTool } from './make-outbound-tool.js';
import { groupReplyAddressing } from './addressing.js';
import { buildMarketChoices } from '../market-choices.js';
import { renderMarketChoiceReply } from '../market-choice-presentation.js';

const parameters = z.object({
  kind: z.enum(['answer', 'partial', 'no_match', 'clarification', 'unavailable']),
  text: z
    .string()
    .trim()
    .min(1)
    .max(1400)
    .describe(
      'Useful answer in user language: reasoning, practical steps or ONE key question. Facts must be supported by supplied sources; mark interpretations/unknowns. No URLs, contacts, guarantees or promises to act for the user. For no_match/unavailable only explain the local search outcome and next step.',
    ),
  refs: z
    .array(z.string())
    .max(6)
    .describe(
      'Known k source refs or k:p passage IDs for evidence-backed answers; m refs for A2H offers. Empty only for clarification/no_match/unavailable. Never invent refs.',
    ),
});

function numericClaims(text: string): string[] {
  return text.replace(/(^|\n)\s*\d{1,2}[.、)）]\s*/g, '$1').match(/\d+(?:\.\d+)?/g) ?? [];
}
function hasSupportedNumber(support: string, value: string): boolean {
  return (support.match(/\d+(?:\.\d+)?/g) ?? []).some((n) => Number(n) === Number(value));
}

function hasUnsupportedDeparture(text: string, evidence: string): boolean {
  const normalize = (s: string) => s.replace(/^0(?=\d)/, '').replace('：', ':');
  const verified = new Set((evidence.match(/\b\d{1,2}[:：]\d{2}\b/g) ?? []).map(normalize));
  return [
    ...text.matchAll(/(\d{1,2}[:：]\d{2})(?=[^。！？\n]{0,20}(?:出发|出门|离开|depart|leave))/gi),
  ].some((m) => !verified.has(normalize(m[1] ?? '')));
}

function officialRequired(ctx: MatchContext): boolean {
  return /GP|NHS|注册.*医生/i.test(ctx.currentRequest?.text ?? '');
}
function renderMarketRefs(
  ctx: MatchContext,
  refs: string[],
  zh: boolean,
): { text: string; evidence: string[] } | null {
  if (!ctx.marketPlan) return null;
  const listings = (ctx.marketListings ?? []).filter((n) => refs.includes(n.ref));
  if (
    listings.length !== new Set(refs).size ||
    listings.some(
      (n) => ctx.marketTarget && ctx.marketTarget !== 'ANY' && n.tradeType !== ctx.marketTarget,
    )
  )
    return null;
  const choices = buildMarketChoices({ candidates: listings, plan: ctx.marketPlan });
  const usable = [...choices.primary, ...choices.backup].map((r) => r.listing);
  if (usable.length !== listings.length) return null;
  const terms = ctx.marketPlan.needs.flatMap((n) => n.terms);
  const selections = usable.map((n) => {
    const rows = n.description.split('\n');
    const bullets = rows.filter(
      (s) =>
        /^\s*[-•]/.test(s) &&
        terms.some((t) => s.toLowerCase().includes(t.toLowerCase())) &&
        !/已出|已售|❌|sold/i.test(s),
    );
    const evidence = bullets.length
      ? bullets.slice(0, 4).join('\n')
      : rows
          .filter((s) => /^(?:出售|出租|转租|求购|求帮带|找搭子|时间|地点|路线|要求)[：:]/.test(s))
          .slice(0, 5)
          .join('\n');
    const names = [
      ...new Set(
        bullets.map((line) =>
          line
            .replace(/^\s*[-•]\s*/, '')
            .split('｜')[0]!
            .trim(),
        ),
      ),
    ].slice(0, 3);
    return {
      ref: n.ref,
      name: names.length ? names.join(' / ') : n.title,
      evidence: evidence || n.description.slice(0, 180),
    };
  });
  const rendered = renderMarketChoiceReply({
    listings: usable,
    selections,
    plan: ctx.marketPlan,
    zh,
    assessWholeOffer: true,
  });
  return {
    text: rendered.text,
    evidence: usable.map((n) => n.title + '\n' + n.description.slice(0, 1600)),
  };
}

export function replyToRequestTool(deps: AgentDeps) {
  return makeOutboundTool(deps, {
    name: 'reply_to_request',
    description:
      'SENDS a useful, source-grounded reply to the current request: advice/steps, partial matches, local no-match explanation, ONE clarification or source unavailability. Complete the user goal even without a perfect offer. Use k refs from search_information for facts, m refs for valid A2H offers; code formats their facts and links. Keep explicit role/date/area/budget; never relax must-have constraints or contact people. This remains subject to phase/Jev/rate gates.',
    parameters,
    toDraft: async (ctx, args: z.infer<typeof parameters>) => {
      if (ctx.answerInputExhausted && ctx.isAnswerFinalization) {
        const zhFailure = ctx.currentRequest?.demand.lang !== 'en';
        const next =
          ctx.currentRequest?.demand.category === 'housing'
            ? '看房前请让房东逐项确认月租、入住时间、房型和宠物许可，宠物要求最好取得书面确认。'
            : ctx.currentRequest?.demand.category === 'second_hand'
              ? '联系候选前请逐项核对具体型号、成色、实际价格与自提地点，未确认的条件不能当成已满足。'
              : '请以提供方或主办方公布的信息核对时间、地点及适用条件，未核实前不能据此做安排。';
        // A failed evidence draft is not a gate rejection. The bounded final response still passes the same gate.
        args = {
          kind: 'unavailable',
          refs: [],
          text: zhFailure
            ? '本次回答的证据核对没有完成，暂时无法可靠推荐。' + next + '你可以稍后重试。'
            : 'This answer could not complete reliable evidence checks. Confirm the exact terms, dates, location and price with the provider before making plans; please try again later.',
        };
      }
      if (
        /https?:\/\/|@[A-Za-z0-9_]{3,}|(?:微信|whatsapp|电话)[：:]\s*\S+|(?:付款|转账|打款|支付).{0,10}(?:给我|由我|代收)|guarantee|保证一定|(?:我|I).{0,20}(?:替你|帮你|will).{0,20}(?:联系|预约|订票|contact|book)|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?(?:44|86)[\d ()-]{8,}\d|\b0\d[\d ()-]{7,}\d\b)/i.test(
          args.text,
        )
      )
        return {
          error: 'invalid answer: omit typed URLs/contacts, guarantees or transaction actions',
        };
      const inlineRefs = args.text.match(/\bk\d+(?::p\d+)?\b/g) ?? [];
      args = {
        ...args,
        refs: [...new Set([...args.refs, ...inlineRefs])],
        text: args.text
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/[（(]\s*(?:k\d+(?::p\d+)?[\s、,]*)+[)）]/g, '')
          .replace(/\bk\d+(?::p\d+)?\b/g, '')
          .trim(),
      };
      const zh = ctx.currentRequest?.demand.lang === 'zh' || /\p{Script=Han}/u.test(args.text);
      const market = args.refs.filter((r) => /^m\d+$/.test(r));
      let text = args.text;
      let evidence: string[] = [];
      if (market.length) {
        if (market.length !== args.refs.length)
          return { error: 'use A2H offer refs separately from general information evidence' };
        const rendered = renderMarketRefs(ctx, market, zh);
        if (!rendered)
          return {
            error:
              'invalid answer: offer is unknown, inactive or conflicts with the original hard conditions; choose useful valid leads or no_match',
          };
        const support = rendered.evidence.join('\n') + '\n' + (ctx.currentRequest?.text ?? '');
        if (numericClaims(args.text).some((n) => !hasSupportedNumber(support, n)))
          return {
            error:
              'invalid answer: unsupported numerical values ' +
              [
                ...new Set(
                  numericClaims(args.text).filter(
                    (n) => !hasSupportedNumber(support, n) && n.length <= 4,
                  ),
                ),
              ].join(', ') +
              '; omit or cite supporting offer evidence.',
          };
        const advice = args.text.length > 320 ? args.text.slice(0, 320) + '…' : args.text;
        text = advice + '\n\n' + rendered.text;
        evidence = rendered.evidence;
      } else {
        const sources = args.refs.map((ref) =>
          (ctx.knowledgeSources ?? []).find(
            (s) => s.ref === ref || s.passages.some((p) => p.id === ref),
          ),
        );
        if (sources.some((s) => !s))
          return { error: 'invalid answer: use only returned source or passage refs' };
        if (['answer', 'partial'].includes(args.kind) && !sources.length)
          return {
            error:
              'invalid answer: information facts need sources: search_information first, or use no_match/clarification/unavailable without inventing facts',
          };
        if (
          officialRequired(ctx) &&
          ['answer', 'partial'].includes(args.kind) &&
          !sources.every((s) => /(^|\.)nhs\.uk$/i.test(new URL(s!.url).hostname))
        )
          return { error: 'GP registration facts require NHS official evidence' };
        evidence = [...new Set(sources.filter((s) => !!s))].map((s) => s.title + '\n' + s.text);
        const support = evidence.join('\n') + '\n' + (ctx.currentRequest?.text ?? '');
        if (
          /希思罗|机场|heathrow/i.test(ctx.currentRequest?.text ?? '') &&
          hasUnsupportedDeparture(args.text, evidence.join('\n'))
        )
          return {
            error:
              'Departure time is not verified by the cited official timetable. Omit a precise departure time and say it must be checked for the actual date; do not infer it from fares or frequencies.',
            kind: 'research_required',
          };

        if (
          args.kind !== 'clarification' &&
          numericClaims(args.text).some((n) => !hasSupportedNumber(support, n))
        )
          return {
            error:
              'invalid answer: unsupported numerical values ' +
              [
                ...new Set(
                  numericClaims(args.text).filter(
                    (n) => !hasSupportedNumber(support, n) && n.length <= 4,
                  ),
                ),
              ].join(', ') +
              '; omit these factual claims or cite supporting evidence. Citation IDs are not user text.',
          };
        if (
          ['answer', 'partial'].includes(args.kind) &&
          /免费|free entry/i.test(args.text) &&
          !/免费|free/i.test(evidence.join('\n'))
        )
          return { error: 'invalid answer: free admission requires source evidence' };
        if (args.kind === 'no_match')
          text =
            (zh
              ? '这次没有确认到完全匹配的结果。\n'
              : 'This search did not confirm a complete match.\n') + args.text;
        if (args.kind === 'unavailable') {
          if (!ctx.sourceFailures?.length)
            return { error: 'no recorded source failure; do not claim a service outage' };
          text =
            (zh
              ? '这次查询没能完成，不能据此判断没有匹配结果。\n'
              : 'A source is currently unavailable; that does not prove no offers exist.\n') +
            args.text;
        }
        const unique = [...new Set(sources.filter((s) => !!s))];
        if (unique.length)
          text +=
            '\n\n' +
            (zh ? '来源：' : 'Source: ') +
            unique
              .map(
                (s, i) =>
                  '[' +
                  (i + 1) +
                  '. ' +
                  s.title.replace(/[\[\]()\r\n]/g, '').slice(0, 38) +
                  '](' +
                  s.url +
                  ')',
              )
              .join(' · ');
      }
      if (text.length > 3700) return { error: 'answer too long: choose fewer sources or offers' };
      await deps.repos.traces.create({
        kind: 'gate',
        inputRef: ctx.sourceMessageId,
        output: {
          gate: 'request_answer',
          kind: args.kind,
          refs: args.refs,
          sourceBound: !!ctx.currentRequest,
        },
        phase: ctx.phase,
        latencyMs: 0,
        costMicro: 0,
      });
      return {
        kind: args.kind === 'clarification' ? 'clarification' : 'recommendation',
        target: ctx.chatId,
        text,
        supplierSummaries: evidence,
        inputRef: ctx.sourceMessageId,
        ...(market.length ? { disclaimer: 'market' as const } : {}),
        ...groupReplyAddressing(ctx),
      };
    },
  });
}
