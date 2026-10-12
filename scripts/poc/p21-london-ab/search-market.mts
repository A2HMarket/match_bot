/** A组只读召回：查询由评估者预置，不运行Bot规划或推荐规则。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { createLogger } from '../../../packages/shared/src/index.js';
import { createMarketSearch } from '../../../packages/websearch/src/index.js';
const cases = z
  .object({
    cases: z.array(
      z.object({ id: z.string(), aSource: z.string(), aInitialQueries: z.array(z.string()) }),
    ),
  })
  .parse(JSON.parse(readFileSync('scripts/poc/p21-london-ab/cases.json', 'utf8'))).cases;
const search = createMarketSearch({ logger: createLogger('ab-direct-search', 'silent') });
const batches: Array<Record<string, unknown>> = [];
for (const c of cases.filter((row) => ['SELL', 'BUY', 'PEER'].includes(row.aSource))) {
  const started = Date.now();
  const results = await Promise.allSettled(
    c.aInitialQueries.map((keyword) =>
      search.find({
        keyword,
        page: 1,
        tradeType: z.enum(['SELL', 'BUY', 'PEER']).parse(c.aSource),
      }),
    ),
  );
  const unique = new Map<string, unknown>();
  const queries = results.map((result, index) => {
    if (result.status === 'rejected')
      return {
        keyword: c.aInitialQueries[index],
        errorKind: result.reason instanceof Error ? result.reason.name : 'UnknownError',
      };
    for (const item of result.value.items) unique.set(item.id, item);
    return {
      keyword: c.aInitialQueries[index],
      total: result.value.total,
      returned: result.value.items.length,
      hasNext: result.value.hasNext,
    };
  });
  const batch = {
    case: c.id,
    source: 'A2H public API',
    elapsedMs: Date.now() - started,
    queries,
    listings: [...unique.values()],
  };
  batches.push(batch);
  writeFileSync('/tmp/p21-a-market.json', JSON.stringify(batches, null, 2));
  process.stdout.write(JSON.stringify({ case: c.id, returnedUnique: unique.size, queries }) + '\n');
}
