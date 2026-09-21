import type { Supply } from '@matchbot/db';
import type { DemandDraft } from '@matchbot/domain';
import { normalizePostcode } from '@matchbot/shared';
import type { ScoredCandidate } from './types.js';

/** 群内同伴供给：信息少，只看品类、区域、时间文本重叠、新鲜度。分数上限 0.7，低于 A 池供应商。 */
export function scorePeerSupplies(p: {
  demand: DemandDraft;
  supplies: Supply[];
  now: Date;
}): ScoredCandidate[] {
  const want = p.demand.fromPostcode
    ? normalizePostcode(p.demand.fromPostcode)?.outward
    : undefined;
  const out: ScoredCandidate[] = [];
  for (const s of p.supplies) {
    if (s.category !== p.demand.category || s.expiresAt.getTime() <= p.now.getTime()) continue;
    const reasons: string[] = [];
    let score = 0.2;
    const area = s.area ? normalizePostcode(s.area)?.outward : undefined;
    if (want && area && want === area) {
      score += 0.3;
      reasons.push(`same area ${want}`);
    }
    const a = (s.availability ?? '').toLowerCase();
    const w = (p.demand.whenText ?? '').toLowerCase();
    if (a && w && (a.includes(w) || w.includes(a))) {
      score += 0.15;
      reasons.push('availability matches');
    }
    if (p.now.getTime() - s.createdAt.getTime() < 3 * 86400e3) {
      score += 0.05;
      reasons.push('posted recently');
    }
    out.push({
      id: s.id,
      kind: 'supply',
      score: Math.min(0.7, Math.round(score * 100) / 100),
      reasons,
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
