import { z } from 'zod';
import type { Logger } from '@matchbot/shared';
import { assertSafeXhsKeyword } from './query.js';
import { redactMarketText } from './market.js';

export const knowledgeResultSchema = z.object({
  title: z.string(),
  url: z.url().refine((url) => {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !/^(?:localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|::|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(
        u.hostname,
      )
    );
  }),
  text: z.string().min(1).max(5000),
});
export type KnowledgeResult = z.infer<typeof knowledgeResultSchema>;
export type KnowledgeSearchResult = {
  status: 'ok' | 'unavailable';
  sources: KnowledgeResult[];
  reason?: 'rate_limited' | 'http_error' | 'timeout' | 'invalid_response';
};
const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      content: z.string(),
      raw_content: z.string().nullish(),
    }),
  ),
});

/** 独立信息检索，不把NHS/政府/博物馆当成缺联系电话的不合格商家。 */
export function createKnowledgeResearch(p: {
  apiKey: string;
  logger: Logger;
  fetchImpl: typeof fetch;
}) {
  return async (q: { query: string; domains?: string[] }): Promise<KnowledgeSearchResult> => {
    const query = assertSafeXhsKeyword(q.query);
    const domains = z
      .array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i))
      .max(5)
      .parse(q.domains ?? []);
    try {
      const response = await p.fetchImpl('https://api.tavily.com/search', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + p.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify({
          query,
          search_depth: 'advanced',
          max_results: 5,
          include_raw_content: 'text',
          ...(domains.length ? { include_domains: domains } : {}),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        p.logger.warn({ status: response.status }, 'information search unavailable');
        return {
          status: 'unavailable',
          sources: [],
          reason: response.status === 429 ? 'rate_limited' : 'http_error',
        };
      }
      const parsed = responseSchema.safeParse(await response.json());
      if (!parsed.success)
        return { status: 'unavailable', sources: [], reason: 'invalid_response' };
      const sources = parsed.data.results.flatMap((row) => {
        const source = knowledgeResultSchema.safeParse({
          title: row.title,
          url: row.url,
          text: redactMarketText(row.content + '\\n' + (row.raw_content ?? '')).slice(0, 5000),
        });
        if (!source.success) return [];
        const host = new URL(source.data.url).hostname;
        if (domains.length && !domains.some((d) => host === d || host.endsWith('.' + d))) return [];
        return [source.data];
      });
      return { status: 'ok', sources };
    } catch (error) {
      p.logger.warn(
        { errorKind: error instanceof Error ? error.name : 'UnknownError' },
        'information search failed',
      );
      return {
        status: 'unavailable',
        sources: [],
        reason: error instanceof Error && error.name === 'TimeoutError' ? 'timeout' : 'http_error',
      };
    }
  };
}
