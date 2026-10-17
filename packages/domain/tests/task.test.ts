import { describe, expect, it } from 'vitest';
import {
  assessTaskReadiness,
  confirmTaskGoal,
  confirmTaskOutcome,
  taskSchema,
  transitionTaskStatus,
} from '../src/task.js';

function fixture() {
  return taskSchema.parse({
    id: 'task-a',
    ownerUserId: 'user-a',
    scope: { channel: 'telegram', chatId: 'chat-a' },
    objective: '找到桌椅',
    status: 'active',
    revision: 0,
    goals: [
      {
        id: 'desk',
        title: '书桌候选',
        required: true,
        criteria: [
          {
            id: 'price',
            label: '单品不超预算',
            strength: 'hard',
            status: 'supported',
            evidenceRefs: ['desk-price'],
          },
        ],
      },
      {
        id: 'chair',
        title: '办公椅候选',
        required: true,
        criteria: [
          {
            id: 'price',
            label: '单品不超预算',
            strength: 'hard',
            status: 'unknown',
            evidenceRefs: [],
          },
        ],
      },
    ],
    evidence: [
      {
        id: 'desk-price',
        goalId: 'desk',
        kind: 'source_excerpt',
        sourceRef: 'fixture:desk',
        summary: '帖子写单品£40',
        observedAt: '2026-10-17T00:00:00Z',
      },
    ],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
describe('task outcome contract', () => {
  it('completes only after the owner has confirmed every required goal, including separate turns', () => {
    const actor = {
      kind: 'user' as const,
      userId: 'user-a',
      messageId: 'chair-done',
      intent: 'achieved' as const,
    };
    const first = confirmTaskOutcome({ task: fixture(), goalIds: ['chair'], actor });
    expect(first.status).toBe('active');
    const last = confirmTaskOutcome({
      task: first,
      goalIds: ['desk'],
      actor: { ...actor, messageId: 'desk-done' },
    });
    expect(last.status).toBe('completed');
    expect(last.userConfirmation?.sourceMessageId).toBe('desk-done');
    expect(last.goals[1]?.criteria[0]?.status).toBe('unknown');
    expect(confirmTaskOutcome({ task: fixture(), goalIds: ['desk', 'chair'], actor }).status).toBe(
      'completed',
    );
    expect(confirmTaskOutcome({ task: fixture(), goalIds: [], actor }).status).toBe('completed');
    expect(
      confirmTaskOutcome({
        task: fixture(),
        goalIds: ['chair'],
        actor: { ...actor, intent: 'cancelled' },
      }).status,
    ).toBe('active');
    expect(
      confirmTaskOutcome({ task: fixture(), goalIds: [], actor: { ...actor, intent: 'cancelled' } })
        .status,
    ).toBe('cancelled');
    expect(() =>
      confirmTaskOutcome({ task: fixture(), goalIds: [], actor: { kind: 'agent' } }),
    ).toThrow('confirmation');
    const onlyOptional = fixture();
    onlyOptional.goals.forEach((g) => {
      g.required = false;
    });
    expect(confirmTaskOutcome({ task: onlyOptional, goalIds: ['chair'], actor }).status).toBe(
      'active',
    );
  });
  it('keeps budget scope typed as monetary information rather than applying it to an unrelated condition', () => {
    const t = fixture();
    t.constraints = [
      {
        key: 'budget',
        strength: 'hard',
        value: { kind: 'money', amountPence: 160000, unit: 'month' },
        budgetScope: 'rent_only',
        origin: { kind: 'user', sourceMessageId: 'input' },
      },
    ];
    expect(assessTaskReadiness(t).ready).toBe(false);
    t.constraints[0]!.value = { kind: 'text', text: '周末' };
    expect(() => assessTaskReadiness(t)).toThrow('monetary');
  });
  it('records a chair bought outside the bot without closing the desk or the whole task', () => {
    const t = confirmTaskGoal({
      task: fixture(),
      goalId: 'chair',
      actor: {
        kind: 'user',
        userId: 'user-a',
        messageId: 'bought-chair',
        intent: 'achieved',
      },
    });
    expect(t.goals[1]?.userConfirmation).toEqual({
      userId: 'user-a',
      sourceMessageId: 'bought-chair',
      intent: 'achieved',
    });
    expect(t.goals[0]?.userConfirmation).toBeNull();
    expect(t.goals[1]?.criteria[0]?.status).toBe('unknown');
    expect(t.status).toBe('active');
    expect(t.revision).toBe(1);
    expect(assessTaskReadiness(t).ready).toBe(true);
  });
  it('does not treat a model judgement, thanks or a foreign user as subgoal completion', () => {
    for (const actor of [
      { kind: 'agent' as const },
      {
        kind: 'user' as const,
        userId: 'user-a',
        messageId: 'thanks',
        intent: 'unspecified' as const,
      },
      { kind: 'user' as const, userId: 'user-b', messageId: 'fake', intent: 'achieved' as const },
    ])
      expect(() => confirmTaskGoal({ task: fixture(), goalId: 'chair', actor })).toThrow(
        'owner confirmation',
      );
    expect(() =>
      confirmTaskGoal({
        task: fixture(),
        goalId: 'missing',
        actor: { kind: 'user', userId: 'user-a', messageId: 'bought', intent: 'achieved' },
      }),
    ).toThrow('existing goal');
    expect(() =>
      confirmTaskGoal({
        task: { ...fixture(), status: 'completed' },
        goalId: 'chair',
        actor: { kind: 'user', userId: 'user-a', messageId: 'bought', intent: 'achieved' },
      }),
    ).toThrow('terminal');
  });
  it('rejects a forged owner on a persisted subgoal confirmation', () => {
    const t = fixture();
    t.goals[1]!.userConfirmation = {
      userId: 'user-b',
      sourceMessageId: 'forged',
      intent: 'achieved',
    };
    expect(() => assessTaskReadiness(t)).toThrow('owner');
  });
  it('retains unresolved goals and does not consider an empty plan ready', () => {
    const t = fixture();
    expect(assessTaskReadiness(t)).toMatchObject({
      ready: false,
      missing: [{ goalId: 'chair', criterionId: 'price', status: 'unknown' }],
    });
    expect(assessTaskReadiness({ ...t, goals: [], evidence: [] }).ready).toBe(false);
  });
  it('does not allow source evidence from another goal to satisfy a criterion', () => {
    const t = fixture();
    t.goals[1]?.criteria.push({
      id: 'condition',
      label: '成色',
      strength: 'hard',
      status: 'supported',
      evidenceRefs: ['desk-price'],
    });
    expect(() => assessTaskReadiness(t)).toThrow('evidence');
  });
  it('does not let an agent declare a user goal achieved', () => {
    expect(() =>
      transitionTaskStatus({ task: fixture(), next: 'completed', actor: { kind: 'agent' } }),
    ).toThrow('user confirmation');
  });
  it('only permits the owner explicit confirmation to complete a goal', () => {
    const t = fixture();
    const completed = transitionTaskStatus({
      task: t,
      next: 'completed',
      actor: { kind: 'user', userId: 'user-a', messageId: 'message-a', intent: 'achieved' },
    });
    expect(completed.status).toBe('completed');
    expect(completed.userConfirmation?.sourceMessageId).toBe('message-a');
    expect(completed.goals[1]?.criteria[0]?.status).toBe('unknown');
    expect(() =>
      transitionTaskStatus({
        task: t,
        next: 'completed',
        actor: { kind: 'user', userId: 'user-b', messageId: 'message-b', intent: 'achieved' },
      }),
    ).toThrow('owner');
    expect(() =>
      transitionTaskStatus({
        task: t,
        next: 'completed',
        actor: { kind: 'user', userId: 'user-a', messageId: 'message-a', intent: 'unspecified' },
      }),
    ).toThrow('user confirmation');
  });
  it('requires a pending question before waiting for a user', () => {
    expect(() =>
      transitionTaskStatus({ task: fixture(), next: 'waiting_user', actor: { kind: 'agent' } }),
    ).toThrow('question');
    const t = fixture();
    t.pendingQuestion = {
      id: 'radius',
      constraintKey: 'max_travel_minutes',
      text: '多久单程？',
      answerType: 'duration',
      deliveryStatus: 'sent',
      outboundMessageId: 'question-outbound',
    };
    expect(
      transitionTaskStatus({ task: t, next: 'waiting_user', actor: { kind: 'agent' } }).status,
    ).toBe('waiting_user');
  });
  it('does not confuse queued delivery or partial advice with a fully delivered result', () => {
    const t = fixture();
    t.delivery = { status: 'queued', level: 'ready' };
    expect(() =>
      transitionTaskStatus({ task: t, next: 'delivered', actor: { kind: 'system' } }),
    ).toThrow('delivery');
    t.delivery = { status: 'sent', level: 'partial' };
    expect(() =>
      transitionTaskStatus({ task: t, next: 'delivered', actor: { kind: 'system' } }),
    ).toThrow('delivery');
  });
});

function readyTask() {
  const t = fixture();
  const criterion = t.goals[1]?.criteria[0];
  if (!criterion) throw new Error('missing fixture criterion');
  criterion.status = 'supported';
  criterion.evidenceRefs = ['chair-price'];
  t.evidence.push({
    id: 'chair-price',
    goalId: 'chair',
    kind: 'source_excerpt',
    sourceRef: 'fixture:chair',
    summary: '帖子写单品£20',
    observedAt: '2026-10-17T00:00:00Z',
  });
  return t;
}

describe('task contract validation and transitions', () => {
  it('validates ordered user date constraints without turning preferences into evidence', () => {
    const t = fixture();
    t.constraints = [
      {
        key: 'dates',
        goalId: 'desk',
        strength: 'hard',
        value: { kind: 'date_range', from: '2026-11-01', to: '2026-11-30' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
      {
        key: 'area',
        strength: 'preference',
        value: { kind: 'location', area: 'E14' },
        origin: { kind: 'agent_proposal', acceptedByMessageId: 'accepted' },
      },
    ];
    expect(assessTaskReadiness(t).ready).toBe(false);
    t.constraints[0]!.value = { kind: 'date_range', from: '2026-11-30', to: '2026-11-01' };
    expect(() => taskSchema.parse(t)).toThrow('ordered');
  });
  it('separates a supported information delivery from real-world completion', () => {
    const t = readyTask();
    t.delivery = { status: 'sent', level: 'ready' };
    expect(assessTaskReadiness(t).ready).toBe(true);
    const delivered = transitionTaskStatus({
      task: t,
      next: 'delivered',
      actor: { kind: 'system' },
    });
    expect(delivered.status).toBe('delivered');
    expect(delivered.userConfirmation).toBeNull();
    expect(delivered.revision).toBe(1);
  });
  it('keeps missing preferences and optional goals from blocking hard-condition readiness', () => {
    const t = readyTask();
    t.goals[0]?.criteria.push({
      id: 'colour',
      label: '最好白色',
      strength: 'preference',
      status: 'unknown',
      evidenceRefs: [],
    });
    t.goals.push({
      id: 'lamp',
      title: '可选台灯',
      required: false,
      userConfirmation: null,
      criteria: [
        { id: 'price', label: '价格', strength: 'hard', status: 'unknown', evidenceRefs: [] },
      ],
    });
    expect(assessTaskReadiness(t).ready).toBe(true);
  });
  it('does not consider a required goal with no hard acceptance criteria ready', () => {
    const t = readyTask();
    const goal = t.goals[0];
    if (!goal) throw new Error('missing fixture goal');
    goal.criteria = [
      {
        id: 'colour',
        label: '白色更好',
        strength: 'preference',
        status: 'unknown',
        evidenceRefs: [],
      },
    ];
    expect(assessTaskReadiness(t).ready).toBe(false);
  });
  it('rejects declared support without evidence and keeps conflict distinct from unknown', () => {
    const t = readyTask(),
      criterion = t.goals[0]?.criteria[0];
    if (!criterion) throw new Error('missing fixture criterion');
    criterion.status = 'conflict';
    expect(assessTaskReadiness(t).missing).toContainEqual({
      goalId: 'desk',
      criterionId: 'price',
      status: 'conflict',
    });
    criterion.evidenceRefs = [];
    expect(() => assessTaskReadiness(t)).toThrow('require evidence');
  });
  it.each(['goals', 'evidence', 'criteria'] as const)('rejects duplicate %s IDs', (field) => {
    const t = fixture();
    const goal = t.goals[0],
      evidence = t.evidence[0],
      criterion = goal?.criteria[0];
    if (!goal || !evidence || !criterion) throw new Error('invalid fixture');
    if (field === 'goals') t.goals.push(goal);
    else if (field === 'evidence') t.evidence.push(evidence);
    else goal.criteria.push(criterion);
    expect(() => assessTaskReadiness(t)).toThrow('unique');
  });
  it('rejects orphaned evidence, missing references and incorrectly scoped constraints', () => {
    const t = fixture(),
      evidence = t.evidence[0];
    if (!evidence) throw new Error('missing fixture evidence');
    evidence.goalId = 'missing';
    expect(() => assessTaskReadiness(t)).toThrow('existing goal');
    evidence.goalId = 'desk';
    const criterion = t.goals[0]?.criteria[0];
    if (!criterion) throw new Error('missing fixture criterion');
    criterion.evidenceRefs = ['missing'];
    expect(() => assessTaskReadiness(t)).toThrow('same goal');
    criterion.evidenceRefs = ['desk-price'];
    t.constraints = [
      {
        key: 'budget',
        goalId: 'missing',
        strength: 'hard',
        value: { kind: 'money', amountPence: 5000, unit: 'item' },
        origin: { kind: 'user', sourceMessageId: 'm' },
      },
    ];
    expect(() => assessTaskReadiness(t)).toThrow('constraint');
    t.constraints = [{ ...t.constraints[0], goalId: 'desk' }] as typeof t.constraints;
    t.constraints.push(t.constraints[0] as (typeof t.constraints)[number]);
    expect(() => assessTaskReadiness(t)).toThrow('unique per goal');
  });
  it('retains explicit cancellation provenance and forbids an agent cancellation', () => {
    const cancelled = transitionTaskStatus({
      task: fixture(),
      next: 'cancelled',
      actor: { kind: 'user', userId: 'user-a', messageId: 'cancel-message', intent: 'cancelled' },
    });
    expect(cancelled.userConfirmation).toMatchObject({
      intent: 'cancelled',
      sourceMessageId: 'cancel-message',
    });
    expect(() =>
      transitionTaskStatus({ task: fixture(), next: 'cancelled', actor: { kind: 'agent' } }),
    ).toThrow('user confirmation');
    expect(() =>
      transitionTaskStatus({ task: cancelled, next: 'active', actor: { kind: 'agent' } }),
    ).toThrow('terminal');
  });
  it.each(['completed', 'cancelled', 'expired'] as const)(
    'does not reopen %s tasks implicitly',
    (status) => {
      expect(() =>
        transitionTaskStatus({
          task: { ...fixture(), status },
          next: 'active',
          actor: { kind: 'agent' },
        }),
      ).toThrow('terminal');
    },
  );
  it('records waiting reasons and queued deliveries without falsely claiming delivery', () => {
    const t = fixture();
    expect(() =>
      transitionTaskStatus({ task: t, next: 'waiting_source', actor: { kind: 'agent' } }),
    ).toThrow('reason');
    t.blockReason = 'API unavailable';
    expect(
      transitionTaskStatus({ task: t, next: 'waiting_source', actor: { kind: 'agent' } }).status,
    ).toBe('waiting_source');
    expect(() =>
      transitionTaskStatus({ task: t, next: 'waiting_delivery', actor: { kind: 'agent' } }),
    ).toThrow('queued');
    t.delivery = { status: 'queued', level: 'partial' };
    expect(
      transitionTaskStatus({ task: t, next: 'waiting_delivery', actor: { kind: 'agent' } }).status,
    ).toBe('waiting_delivery');
    t.pendingQuestion = {
      id: 'q',
      constraintKey: 'radius',
      text: '通勤多久？',
      answerType: 'duration',
      deliveryStatus: 'proposed',
      outboundMessageId: 'o',
    };
    expect(() =>
      transitionTaskStatus({ task: t, next: 'waiting_user', actor: { kind: 'agent' } }),
    ).toThrow('delivered question');
    t.delivery = { status: 'sent', level: 'ready' };
    expect(() =>
      transitionTaskStatus({ task: t, next: 'delivered', actor: { kind: 'system' } }),
    ).toThrow('fully supported');
  });
  it('only expires through retention policy and accepts ordinary progress', () => {
    const t = fixture();
    expect(() =>
      transitionTaskStatus({ task: t, next: 'expired', actor: { kind: 'agent' } }),
    ).toThrow('retention policy');
    expect(
      transitionTaskStatus({ task: t, next: 'expired', actor: { kind: 'system' } }).status,
    ).toBe('expired');
    expect(
      transitionTaskStatus({ task: t, next: 'active', actor: { kind: 'agent' } }).userConfirmation,
    ).toBeNull();
  });
});
