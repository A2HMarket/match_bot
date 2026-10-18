import { z } from 'zod';
import type { Logger } from '@matchbot/shared';
import {
  assertSafeXhsKeyword,
  knowledgeResultSchema,
  redactMarketText,
  type KnowledgeSearchResult,
  type WebSearch,
} from '@matchbot/websearch';

const responseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.string(),
      snippet: z.string(),
      summary: z.string(),
      content: z.string(),
    }),
  ),
});

/** Raw search, not a generation call. P34 PoC verified content and domain operators. */
export function createDeepSeekSearch(p: {
  apiKey: string;
  logger: Logger;
  fetchImpl?: typeof fetch;
  businessSearch?: WebSearch;
}): WebSearch {
  const fetchImpl = p.fetchImpl ?? fetch;
  return {
    // Supplier contact verification stays in the existing business-search path.
    find: (query) => p.businessSearch?.find(query) ?? Promise.resolve([]),
    async research(q): Promise<KnowledgeSearchResult> {
      const terms = assertSafeXhsKeyword(q.query);
      const domains = z
        .array(z.string().regex(/^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i))
        .max(5)
        .parse(q.domains ?? [])
        .map((d) => d.toLowerCase());
      const query =
        terms + (domains.length ? ' ' + domains.map((d) => 'site:' + d).join(' OR ') : '');
      if ([...query].length > 128)
        return { status: 'unavailable', sources: [], reason: 'invalid_response' };
      try {
        const response = await fetchImpl('https://api.deepseek.com/v1/tools/search', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + p.apiKey, 'content-type': 'application/json' },
          body: JSON.stringify({ query, count: 5, need_content: true }),
          signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) {
          p.logger.warn({ status: response.status }, 'DeepSeek information search unavailable');
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
          const text = redactMarketText(row.content || row.summary || row.snippet).slice(0, 5000);
          const source = knowledgeResultSchema.safeParse({ title: row.title, url: row.url, text });
          if (!source.success) return [];
          const host = new URL(source.data.url).hostname;
          if (domains.length && !domains.some((d) => host === d || host.endsWith('.' + d)))
            return [];
          return [source.data];
        });
        return { status: 'ok', sources };
      } catch (error) {
        const name = error instanceof Error ? error.name : 'UnknownError';
        p.logger.warn({ errorKind: name }, 'DeepSeek information search failed');
        return {
          status: 'unavailable',
          sources: [],
          reason:
            name === 'TimeoutError'
              ? 'timeout'
              : name === 'SyntaxError'
                ? 'invalid_response'
                : 'http_error',
        };
      }
    },
  };
}
