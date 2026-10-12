import { currentRequestSchema } from './current-request.js';
import { knowledgeSourceSchema } from './knowledge-evidence.js';
import { demandDraftSchema } from '@matchbot/domain';
import { z } from 'zod';
import type { MatchContext } from './context.js';
import { XHS_RESEARCH_LIMITS, xhsResearchQuerySchema } from './xhs-research.js';
import { xhsRecommendationSchema } from './xhs-recommendations.js';
import { marketPlanSchema } from './market-strategy.js';
import { MARKET_INTENTS } from '@matchbot/websearch';
import {
  marketCandidateSchema,
  marketResearchQuerySchema,
  MARKET_RESEARCH_LIMITS,
} from './market-research.js';

const contextSchema = z.object({
  userId: z.string(),
  chatId: z.string(),
  phase: z.union([z.literal(0), z.literal(1), z.literal(2)]),
  sourceMessageId: z.string(),
  groupId: z.string().nullable(),
  source: z.object({ messageId: z.string(), userId: z.string() }).optional(),
  demand: demandDraftSchema.optional(),
  currentRequest: currentRequestSchema.optional(),
  answerInputExhausted: z.boolean().optional(),
  isAnswerFinalization: z.boolean().optional(),
  isRequestStatusRun: z.boolean().optional(),
  outboundBlocked: z.boolean().optional(),
  knowledgeSources: z.array(knowledgeSourceSchema).max(16).optional(),
  informationQueries: z.array(z.string()).max(4).optional(),
  sourceFailures: z.array(z.string()).optional(),
  rateLimitPerDay: z.number().int().nonnegative().optional(),
  xhsNotes: z
    .array(
      z.object({
        ref: z.string(),
        title: z.string(),
        desc: z.string(),
        author: z.string(),
        likes: z.number().int().nonnegative(),
        url: z.url(),
        isDetailLoaded: z.boolean().optional(),
      }),
    )
    .max(XHS_RESEARCH_LIMITS.notes)
    .optional(),
  marketListings: z.array(marketCandidateSchema).max(MARKET_RESEARCH_LIMITS.listings).optional(),
  marketQueries: z.array(marketResearchQuerySchema).max(MARKET_RESEARCH_LIMITS.queries).optional(),
  marketDetailIds: z.array(z.string()).max(MARKET_RESEARCH_LIMITS.details).optional(),
  marketIntent: z.enum(MARKET_INTENTS).optional(),
  marketPlan: marketPlanSchema.optional(),
  marketTarget: z.enum(['SELL', 'BUY', 'PEER', 'ANY']).optional(),
  xhsQueries: z.array(xhsResearchQuerySchema).max(XHS_RESEARCH_LIMITS.queries).optional(),
  xhsDetailRefs: z.array(z.string()).max(XHS_RESEARCH_LIMITS.detailReads).optional(),
  xhsValidatedRecommendations: z.array(xhsRecommendationSchema).max(6).optional(),
  outboundPreviews: z.record(z.string(), z.string().max(4000)).optional(),
});
const snapshotSchema = z.object({
  context: z.object({ context: z.record(z.string(), z.unknown()) }),
});

/** 只读服务端解密快照。SDK 的 context override 只合并审批信息，不合并业务上下文（P14 实测）。 */
export function restoreSearchContext(ctx: MatchContext, snapshot: string): MatchContext {
  const raw = snapshotSchema.parse(JSON.parse(snapshot) as unknown).context.context;
  if (
    raw['xhsNotes'] === undefined &&
    raw['marketListings'] === undefined &&
    raw['outboundPreviews'] === undefined &&
    raw['currentRequest'] === undefined
  )
    return ctx;
  const saved = contextSchema.parse(raw);
  if (saved.userId !== ctx.userId || saved.chatId !== ctx.chatId || saved.phase !== ctx.phase) {
    throw new Error('Search snapshot context does not match the stored run');
  }
  return {
    ...ctx,
    ...(saved.outboundBlocked !== undefined ? { outboundBlocked: saved.outboundBlocked } : {}),
    ...(saved.isRequestStatusRun !== undefined
      ? { isRequestStatusRun: saved.isRequestStatusRun }
      : {}),
    ...(saved.answerInputExhausted !== undefined
      ? { answerInputExhausted: saved.answerInputExhausted }
      : {}),
    ...(saved.isAnswerFinalization !== undefined
      ? { isAnswerFinalization: saved.isAnswerFinalization }
      : {}),
    ...(saved.currentRequest
      ? { currentRequest: saved.currentRequest, demand: saved.currentRequest.demand }
      : {}),
    ...(saved.knowledgeSources ? { knowledgeSources: saved.knowledgeSources } : {}),
    ...(saved.informationQueries ? { informationQueries: saved.informationQueries } : {}),
    ...(saved.sourceFailures ? { sourceFailures: saved.sourceFailures } : {}),
    ...(saved.xhsNotes
      ? {
          xhsNotes: saved.xhsNotes.map(({ isDetailLoaded, ...note }) => ({
            ...note,
            ...(isDetailLoaded === undefined ? {} : { isDetailLoaded }),
          })),
        }
      : {}),
    ...(saved.marketListings ? { marketListings: saved.marketListings } : {}),
    ...(saved.marketQueries ? { marketQueries: saved.marketQueries } : {}),
    ...(saved.marketDetailIds ? { marketDetailIds: saved.marketDetailIds } : {}),
    ...(saved.marketIntent ? { marketIntent: saved.marketIntent } : {}),
    ...(saved.marketPlan
      ? {
          marketPlan: {
            intent: saved.marketPlan.intent,
            ...(saved.marketPlan.capacityKg !== undefined
              ? { capacityKg: saved.marketPlan.capacityKg }
              : {}),
            needs: saved.marketPlan.needs,
            preferences: saved.marketPlan.preferences,
            ...(saved.marketPlan.essentialPreferences
              ? { essentialPreferences: saved.marketPlan.essentialPreferences }
              : {}),
            ...(saved.marketPlan.budget !== undefined ? { budget: saved.marketPlan.budget } : {}),
            ...(saved.marketPlan.requiredArea
              ? { requiredArea: saved.marketPlan.requiredArea }
              : {}),
            ...(saved.marketPlan.requiredTerms
              ? { requiredTerms: saved.marketPlan.requiredTerms }
              : {}),
            ...(saved.marketPlan.excludeTerms
              ? { excludeTerms: saved.marketPlan.excludeTerms }
              : {}),
            ...(saved.marketPlan.route ? { route: saved.marketPlan.route } : {}),
            ...(saved.marketPlan.dateRange ? { dateRange: saved.marketPlan.dateRange } : {}),
          },
        }
      : {}),
    ...(saved.marketTarget ? { marketTarget: saved.marketTarget } : {}),
    ...(saved.xhsQueries ? { xhsQueries: saved.xhsQueries } : {}),
    ...(saved.xhsDetailRefs ? { xhsDetailRefs: saved.xhsDetailRefs } : {}),
    ...(saved.xhsValidatedRecommendations
      ? { xhsValidatedRecommendations: saved.xhsValidatedRecommendations }
      : {}),
    ...(saved.outboundPreviews ? { outboundPreviews: saved.outboundPreviews } : {}),
    sourceMessageId: saved.sourceMessageId,
    groupId: saved.groupId,
    ...(saved.source ? { source: saved.source } : {}),
    ...(saved.rateLimitPerDay !== undefined ? { rateLimitPerDay: saved.rateLimitPerDay } : {}),
    ...(!ctx.demand && saved.demand ? { demand: saved.demand } : {}),
  };
}
