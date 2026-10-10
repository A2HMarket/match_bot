import { MARKET_INTENTS, MARKET_TRADE_TYPES, marketListingSchema } from '@matchbot/websearch';
import { z } from 'zod';
export const MARKET_RESEARCH_LIMITS = {
  queries: 8,
  discoveryQueries: 4,
  listings: 40,
  details: 8,
} as const;
export const marketQuerySchema = z.object({
  keyword: z.string().min(2).max(60),
  page: z.number().int().min(1).max(3),
  tradeType: z.enum(MARKET_TRADE_TYPES),
  entity: z.string().min(2).max(60).nullable(),
});
export const marketResearchQuerySchema = marketQuerySchema.extend({
  purpose: z.enum(['discover', 'enrich']),
  intent: z.enum(MARKET_INTENTS),
});
export type MarketResearchQuery = z.infer<typeof marketResearchQuerySchema>;
export const marketCandidateSchema = marketListingSchema.extend({ ref: z.string() });
export type MarketCandidate = z.infer<typeof marketCandidateSchema>;
export const getMarketQueryKey = (q: MarketResearchQuery) =>
  JSON.stringify([q.keyword.toLocaleLowerCase(), q.page, q.tradeType, q.intent]);
