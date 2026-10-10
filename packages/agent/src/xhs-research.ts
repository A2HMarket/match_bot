import { z } from 'zod';

/** P14 泛需求先扩召回再补搜；预算固定，模型不能靠反复查询绕过出站决定。 */
export const XHS_RESEARCH_LIMITS = {
  queries: 8,
  discoveryQueries: 4,
  notes: 40,
  detailReads: 12,
  excerptChars: 2000,
} as const;
export const xhsQuerySchema = z.object({
  keyword: z.string().min(2).max(60),
  page: z.union([z.literal(1), z.literal(2)]),
  sort: z.enum(['general', 'time_descending']),
  timeFilter: z.enum(['不限', '半年内']),
  entity: z.string().min(2).max(60).nullable(),
});
export const xhsResearchQuerySchema = xhsQuerySchema.extend({
  purpose: z.enum(['discover', 'enrich']),
});
export type XhsResearchQuery = z.infer<typeof xhsResearchQuerySchema>;
export const getXhsQueryKey = (q: z.infer<typeof xhsQuerySchema>) =>
  JSON.stringify([q.keyword.toLocaleLowerCase(), q.page, q.sort, q.timeFilter]);
export const getXhsNoteKey = (url: string) => new URL(url).pathname;
