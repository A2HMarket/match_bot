/** 放行阶段（PRD §7、架构 §7）。群级可覆盖全局默认。 */
export const PHASES = { SHADOW: 0, REVIEW: 1, AUTO: 2 } as const;
export type Phase = (typeof PHASES)[keyof typeof PHASES];
