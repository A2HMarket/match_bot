import type { Supplier } from '@matchbot/db';
import type { DemandDraft } from '@matchbot/domain';
import { normalizePostcode } from '@matchbot/shared';
import type { ScoredCandidate } from './types.js';

const W = { area: 0.35, pool: 0.2, timing: 0.15, language: 0.15, price: 0.05, fresh: 0.1 } as const;
const B_POOL_CAP = 0.6;
const STALE_DAYS = 60;

function coversArea(area: string[], postcode: string | undefined): boolean {
  if (!postcode) return true; // 需求没给地点时不因区域排除，靠 agent 追问
  if (area.includes('LONDON')) return true;
  const pc = normalizePostcode(postcode);
  return !!pc && area.some((a) => a.toUpperCase() === pc.outward);
}
function isWeekend(iso: string | undefined): boolean {
  if (!iso) return false;
  const d = new Date(iso).getUTCDay();
  return d === 0 || d === 6;
}
function isSoon(iso: string | undefined, now: Date): boolean {
  return !!iso && new Date(iso).getTime() - now.getTime() < 36 * 3600e3;
}

/** 确定性打分；分数 0–1，理由给审批卡和回复用（架构 §4.2）。 */
export function scoreSuppliers(p: {
  demand: DemandDraft;
  suppliers: Supplier[];
  now: Date;
}): ScoredCandidate[] {
  const out: ScoredCandidate[] = [];
  for (const s of p.suppliers) {
    if (s.category !== p.demand.category) continue;
    if (!coversArea(s.serviceArea, p.demand.fromPostcode)) continue;
    const reasons: string[] = [];
    let score = 0;
    if (p.demand.fromPostcode && !s.serviceArea.includes('LONDON')) {
      score += W.area;
      reasons.push(`covers ${p.demand.fromPostcode}`);
    } else {
      score += W.area * 0.5;
    }
    if (s.pool === 'A') {
      score += W.pool;
      reasons.push('verified partner');
    }
    if (isWeekend(p.demand.whenAt) && s.isWeekend) {
      score += W.timing;
      reasons.push('works weekends');
    } else if (isSoon(p.demand.whenAt, p.now) && s.isSameDay) {
      score += W.timing;
      reasons.push('same-day');
    } else if (!p.demand.whenAt) {
      score += W.timing * 0.5;
    }
    if (p.demand.lang && s.languages.includes(p.demand.lang)) {
      score += W.language;
      reasons.push(`speaks ${p.demand.lang}`);
    }
    if (s.priceType === 'hourly' || s.priceType === 'fixed') {
      score += W.price;
      reasons.push(`${s.priceType} price known`);
    }
    const ageDays = s.lastVerifiedAt
      ? (p.now.getTime() - s.lastVerifiedAt.getTime()) / 86400e3
      : Infinity;
    if (ageDays <= STALE_DAYS) {
      score += W.fresh;
    } else {
      reasons.push('verification stale');
    }
    if (s.pool === 'B') score = Math.min(score, B_POOL_CAP);
    out.push({ id: s.id, kind: 'supplier', score: Math.round(score * 100) / 100, reasons });
  }
  return out.sort((a, b) => b.score - a.score);
}
