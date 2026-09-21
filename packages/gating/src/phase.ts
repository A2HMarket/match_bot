import type { Phase } from '@matchbot/domain';

/** 群级 phase 覆盖全局默认；群未接入（null）用默认（架构 §7）。 */
export function resolvePhase(p: { group: { phase: number } | null; defaultPhase: Phase }): Phase {
  const v = p.group?.phase ?? p.defaultPhase;
  return v === 0 || v === 1 || v === 2 ? v : p.defaultPhase;
}
