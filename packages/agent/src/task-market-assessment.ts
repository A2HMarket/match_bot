import type { UserTask } from '@matchbot/domain';
import type { MarketListing } from '@matchbot/websearch';
import { assessMarketListing, type MarketAssessment, type MarketPlan } from './market-strategy.js';

const labels: Record<string, string> = {
  budget: '预算',
  area: '地点',
  pets: '宠物许可',
  move_in_date: '起租时间',
  room_type: '房型',
  max_travel_minutes: '总通勤时间',
  level: '活动水平',
  day: '活动日期',
  time: '活动时间',
  self_collect: '自提条件',
  bills: '账单',
  feature: '必要功能',
  condition: '成色',
  date: '日期',
  route_from: '出发方向',
  route_to: '目的地',
  capacity: '余量',
};

/** PRD §13: the cards must use the same verified conditions as the task, scoped to each actual offer. */
export function assessTaskMarketListing(
  listing: MarketListing,
  plan: MarketPlan,
  task: UserTask,
  name?: string,
): MarketAssessment {
  const views = plan.needs
    .map((need) => {
      const assessment = assessMarketListing(listing, { ...plan, needs: [need] }, name);
      const goal = task.goals.find((g) => g.id === need.id && !g.userConfirmation);
      if (!goal || !assessment.needs.length) return assessment;
      const checks = goal.criteria
        .filter(
          (c) =>
            c.strength === 'hard' && !['travel_origin', 'role'].includes(c.constraintKey ?? ''),
        )
        .map((c) => {
          const own = c.evidenceRefs
            .map((ref) => task.evidence.find((e) => e.id === ref))
            .filter((e) => e?.sourceRef === 'market:' + listing.id);
          const negative = (c.conflictingEvidenceRefs ?? [])
            .map((ref) => task.evidence.find((e) => e.id === ref))
            .find((e) => e?.sourceRef === 'market:' + listing.id);
          const status = negative
            ? 'mismatch'
            : own.length
              ? c.status === 'supported'
                ? 'met'
                : c.status === 'conflict'
                  ? 'mismatch'
                  : 'unknown'
              : 'unknown';
          return {
            label:
              'task:' +
              (labels[c.constraintKey ?? ''] ?? (c.constraintKey ? '必要条件' : '来源核对')),
            status,
            evidence: negative?.summary ?? own[0]?.summary ?? null,
          } as const;
        });
      const verifiedCondition = (key: string) => {
        const criterion = goal.criteria.find(
          (c) => c.constraintKey === key && c.status === 'supported',
        );
        return (
          criterion &&
          !criterion.conflictingEvidenceRefs?.some(
            (ref) => task.evidence.find((e) => e.id === ref)?.sourceRef === 'market:' + listing.id,
          ) &&
          criterion.evidenceRefs.some(
            (ref) => task.evidence.find((e) => e.id === ref)?.sourceRef === 'market:' + listing.id,
          )
        );
      };
      const legacy = assessment.checks.map((check) => {
        if (check.status !== 'unknown' || !check.label.startsWith('preference:')) return check;
        const term = check.label.slice(11);
        const condition = task.constraints.find(
          (c) =>
            (!c.goalId || c.goalId === goal.id) && c.value.kind === 'text' && c.value.text === term,
        );
        return condition && verifiedCondition(condition.key)
          ? { ...check, status: 'met' as const }
          : check;
      });
      return { ...assessment, checks: [...legacy, ...checks] };
    })
    .filter((view) => view.needs.length);
  if (!views.length) return assessMarketListing(listing, plan, name);
  const usable = views.filter((view) => !view.checks.some((c) => c.status === 'mismatch'));
  const selected = usable.length ? usable : views;
  const prices = selected.flatMap((view) => (view.itemPriceGBP ? [view.itemPriceGBP] : []));
  return {
    id: listing.id,
    needs: selected.flatMap((view) => view.needs),
    checks: selected.flatMap((view) => view.checks),
    score: selected.reduce((sum, view) => sum + view.score, 0),
    itemPriceEvidence:
      [
        ...new Set(
          selected.flatMap((view) => (view.itemPriceEvidence ? [view.itemPriceEvidence] : [])),
        ),
      ].join('\n') || null,
    ...(prices.length
      ? {
          itemPriceGBP: {
            min: Math.min(...prices.map((p) => p.min)),
            max: Math.max(...prices.map((p) => p.max)),
          },
        }
      : {}),
  };
}
