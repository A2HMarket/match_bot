export const DEMAND_CATEGORIES = [
  'man_and_van',
  'eot_cleaning',
  'furniture_service',
  'housing',
  'job',
  'second_hand',
  'other',
] as const;
export type DemandCategory = (typeof DEMAND_CATEGORIES)[number];

/** 付费主品类；其余只打标签不撮合（PRD §2.1）。 */
export const SERVICE_CATEGORIES: readonly DemandCategory[] = [
  'man_and_van',
  'eot_cleaning',
  'furniture_service',
];

export function isServiceCategory(c: DemandCategory): boolean {
  return SERVICE_CATEGORIES.includes(c);
}

export const DEMAND_STATUSES = ['open', 'clarifying', 'matched', 'closed', 'expired'] as const;
export type DemandStatus = (typeof DEMAND_STATUSES)[number];

const TRANSITIONS: Record<DemandStatus, readonly DemandStatus[]> = {
  open: ['clarifying', 'matched', 'closed', 'expired'],
  clarifying: ['open', 'matched', 'closed', 'expired'],
  matched: ['closed', 'expired', 'open'],
  closed: [],
  expired: [],
};

export function canTransition(from: DemandStatus, to: DemandStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: DemandStatus,
    readonly to: DemandStatus,
  ) {
    super(`demand status ${from} -> ${to} is not allowed`);
    this.name = 'IllegalTransitionError';
  }
}

export function transition(from: DemandStatus, to: DemandStatus): DemandStatus {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
  return to;
}
