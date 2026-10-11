import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { marketListingSchema } from '../../../packages/websearch/src/index.js';
import { rankMarketListings } from './strategy.mjs';
import type { MarketPlan } from './strategy.mjs';
const payload = z
  .object({
    batches: z.array(
      z.object({
        case: z.record(z.string(), z.unknown()),
        results: z.array(
          z.object({ keyword: z.string(), items: z.array(marketListingSchema).optional() }),
        ),
      }),
    ),
  })
  .parse(JSON.parse(readFileSync(process.argv[2] ?? '/tmp/p18-benchmark-v2.json', 'utf8')));
const reports = [];
for (const batch of payload.batches) {
  const c = batch.case as unknown as MarketPlan & { id: string; baseline: string; split: string };
  const baseline = batch.results.find((r) => r.keyword === c.baseline)?.items ?? [];
  const map = new Map(batch.results.flatMap((r) => (r.items ?? []).map((n) => [n.id, n] as const)));
  const ranked = rankMarketListings([...map.values()], c);
  const top = ranked
    .filter((r) => !r.assessment.checks.some((c) => c.status === 'mismatch'))
    .slice(0, 5);
  const current = new Map(
    batch.results
      .filter((r) => r.keyword !== c.baseline)
      .flatMap((r) => (r.items ?? []).slice(0, 10).map((n) => [n.id, n] as const)),
  );
  reports.push({
    id: c.id,
    split: c.split,
    baselineCount: baseline.length,
    currentPrefixCount: current.size,
    pooledCount: map.size,
    rankedCount: ranked.length,
    top: top.map((r) => ({
      id: r.listing.id,
      title: r.listing.title,
      description: r.listing.description,
      checks: r.assessment.checks,
      needs: r.assessment.needs,
      price: r.assessment.itemPriceEvidence,
    })),
    baselineTop: baseline
      .slice(0, 5)
      .map((n) => ({ id: n.id, title: n.title, description: n.description })),
  });
  process.stdout.write(
    JSON.stringify({
      id: c.id,
      baseline: baseline.length,
      pool: map.size,
      ranked: ranked.length,
      top: top.map((r) => ({ title: r.listing.title, checks: r.assessment.checks })),
    }) + '\n',
  );
}
writeFileSync(process.argv[3] ?? '/tmp/p18-scored-v2.json', JSON.stringify(reports, null, 2));
