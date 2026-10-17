import { describe, expect, it } from 'vitest';
import { taskSchema } from '../src/task.js';
import {
  queueTaskDelivery,
  recordTaskDeliveryReceipt,
  beginTaskUserTurn,
} from '../src/task-delivery.js';

function task() {
  return taskSchema.parse({
    id: 'task',
    ownerUserId: 'owner',
    scope: { channel: 'telegram', chatId: '-1' },
    objective: '找羽毛球搭子',
    status: 'active',
    revision: 0,
    goals: [
      {
        id: 'partner',
        title: '羽毛球搭子',
        required: true,
        criteria: [
          {
            id: 'subject',
            label: '活动',
            strength: 'hard',
            status: 'supported',
            evidenceRefs: ['source'],
          },
        ],
      },
    ],
    evidence: [
      {
        id: 'source',
        goalId: 'partner',
        kind: 'source_excerpt',
        sourceRef: 'offer:1',
        summary: '周末招初学者',
        observedAt: '2026-10-17T00:00:00Z',
      },
    ],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
const question = {
  constraintKey: 'max_travel_minutes',
  answerType: 'duration' as const,
  text: '最多接受多久单程通勤？',
  goalId: 'partner',
};
describe('task delivery and question receipts', () => {
  it('can refine an unresolved date window without re-asking an already exact date', () => {
    const t = task();
    t.constraints = [
      {
        key: 'move_in_date',
        strength: 'hard',
        value: { kind: 'date_range', from: '2026-11-01', to: '2026-11-30' },
        origin: { kind: 'user', sourceMessageId: 'input' },
      },
    ];
    const input = {
      task: t,
      requirementsVersion: 0,
      outboundMessageId: 'out',
      level: 'partial' as const,
      question: {
        constraintKey: 'move_in_date',
        answerType: 'date' as const,
        text: '十一月具体哪天入住？',
      },
    };
    expect(queueTaskDelivery(input).pendingQuestion?.deliveryStatus).toBe('proposed');
    t.constraints[0]!.value = { kind: 'date_range', from: '2026-11-05', to: '2026-11-05' };
    expect(() => queueTaskDelivery({ ...input, task: t })).toThrow('known');
  });
  it('supersedes the previous reply on a new user turn without changing constraints, evidence or a terminal outcome', () => {
    const queued = queueTaskDelivery({
      task: task(),
      requirementsVersion: 0,
      outboundMessageId: 'old',
      level: 'partial',
      question,
    });
    const next = beginTaskUserTurn(queued);
    expect(next).toMatchObject({
      status: 'active',
      delivery: { status: 'none', level: 'none' },
      pendingQuestion: null,
      nextStep: null,
      requirementsVersion: 0,
    });
    expect(next.evidence).toEqual(queued.evidence);
    const terminal = { ...task(), status: 'completed' as const };
    expect(beginTaskUserTurn(terminal)).toEqual(terminal);
  });
  it('waits for a receipt before waiting for the user, and never confirms the real-world outcome', () => {
    const queued = queueTaskDelivery({
      task: task(),
      requirementsVersion: 0,
      outboundMessageId: 'out',
      level: 'ready',
      question,
    });
    expect(queued.status).toBe('waiting_delivery');
    expect(queued.pendingQuestion?.deliveryStatus).toBe('proposed');
    expect(queued.delivery).toMatchObject({
      status: 'queued',
      level: 'partial',
      outboundMessageId: 'out',
    });
    const sent = recordTaskDeliveryReceipt({
      task: queued,
      requirementsVersion: 0,
      outboundMessageId: 'out',
      status: 'sent',
    });
    expect(sent.status).toBe('waiting_user');
    expect(sent.pendingQuestion?.deliveryStatus).toBe('sent');
    expect(sent.nextStep).toMatchObject({ owner: 'user', action: 'wait_user' });
    expect(sent.userConfirmation).toBeNull();
    expect(
      recordTaskDeliveryReceipt({
        task: sent,
        requirementsVersion: 0,
        outboundMessageId: 'out',
        status: 'sent',
      }),
    ).toEqual(sent);
  });
  it('marks a fully evidenced answer delivered, keeps partial answers active, and caps unfounded ready claims', () => {
    const queued = queueTaskDelivery({
      task: task(),
      requirementsVersion: 0,
      outboundMessageId: 'out',
      level: 'ready',
    });
    const sent = recordTaskDeliveryReceipt({
      task: queued,
      requirementsVersion: 0,
      outboundMessageId: 'out',
      status: 'sent',
    });
    expect(sent.status).toBe('delivered');
    expect(sent.userConfirmation).toBeNull();
    const partial = queueTaskDelivery({
      task: task(),
      requirementsVersion: 0,
      outboundMessageId: 'partial',
      level: 'partial',
    });
    expect(
      recordTaskDeliveryReceipt({
        task: partial,
        requirementsVersion: 0,
        outboundMessageId: 'partial',
        status: 'sent',
      }).status,
    ).toBe('active');
    const missing = task();
    missing.goals[0]!.criteria[0]!.status = 'unknown';
    missing.goals[0]!.criteria[0]!.evidenceRefs = [];
    expect(
      queueTaskDelivery({
        task: missing,
        requirementsVersion: 0,
        outboundMessageId: 'out',
        level: 'ready',
      }).delivery.level,
    ).toBe('partial');
    queued.goals[0]!.criteria[0]!.status = 'unknown';
    expect(
      recordTaskDeliveryReceipt({
        task: queued,
        requirementsVersion: 0,
        outboundMessageId: 'out',
        status: 'sent',
      }).delivery.level,
    ).toBe('partial');
  });
  it.each(['unknown', 'failed'] as const)(
    'does not treat %s as a delivered question; a late authoritative receipt can resolve unknown',
    (status) => {
      const queued = queueTaskDelivery({
        task: task(),
        requirementsVersion: 0,
        outboundMessageId: 'out',
        level: 'partial',
        question,
      });
      const lost = recordTaskDeliveryReceipt({
        task: queued,
        requirementsVersion: 0,
        outboundMessageId: 'out',
        status,
      });
      expect(lost.status).toBe('active');
      expect(lost.pendingQuestion?.deliveryStatus).toBe('proposed');
      expect(lost.delivery.status).toBe(status);
      expect(lost.nextStep?.owner).toBe('agent');
      if (status === 'unknown')
        expect(
          recordTaskDeliveryReceipt({
            task: lost,
            requirementsVersion: 0,
            outboundMessageId: 'out',
            status: 'sent',
          }).status,
        ).toBe('waiting_user');
      else
        expect(() =>
          recordTaskDeliveryReceipt({
            task: lost,
            requirementsVersion: 0,
            outboundMessageId: 'out',
            status: 'sent',
          }),
        ).toThrow('confirmed');
    },
  );
  it('rejects stale receipts, already known questions, invalid goal references and terminal mutations', () => {
    const base = {
      task: task(),
      requirementsVersion: 0,
      outboundMessageId: 'out',
      level: 'partial' as const,
    };
    expect(() => queueTaskDelivery({ ...base, requirementsVersion: 1 })).toThrow('requirements');
    expect(() => queueTaskDelivery({ ...base, task: { ...task(), status: 'completed' } })).toThrow(
      'terminal',
    );
    expect(() =>
      queueTaskDelivery({ ...base, question: { ...question, goalId: 'missing' } }),
    ).toThrow('goal');
    const confirmed = task();
    confirmed.goals[0]!.userConfirmation = {
      userId: 'owner',
      sourceMessageId: 'owner-confirmed',
      intent: 'achieved',
    };
    expect(() => queueTaskDelivery({ ...base, task: confirmed, question })).toThrow('goal');
    const known = task();
    known.constraints.push({
      key: 'max_travel_minutes',
      goalId: 'partner',
      strength: 'hard',
      value: { kind: 'duration', minutes: 30 },
      origin: { kind: 'user', sourceMessageId: 'input' },
    });
    expect(() => queueTaskDelivery({ ...base, task: known, question })).toThrow('known');
    const queued = queueTaskDelivery(base);
    expect(() =>
      recordTaskDeliveryReceipt({
        task: queued,
        requirementsVersion: 1,
        outboundMessageId: 'out',
        status: 'sent',
      }),
    ).toThrow('requirements');
    expect(() =>
      recordTaskDeliveryReceipt({
        task: queued,
        requirementsVersion: 0,
        outboundMessageId: 'other',
        status: 'sent',
      }),
    ).toThrow('outbound');
    const sent = recordTaskDeliveryReceipt({
      task: queued,
      requirementsVersion: 0,
      outboundMessageId: 'out',
      status: 'sent',
    });
    expect(() =>
      recordTaskDeliveryReceipt({
        task: sent,
        requirementsVersion: 0,
        outboundMessageId: 'out',
        status: 'unknown',
      }),
    ).toThrow('confirmed');
  });
  it('replaces an old question when a new answer is queued and supports shared questions', () => {
    const previous = queueTaskDelivery({
      task: task(),
      requirementsVersion: 0,
      outboundMessageId: 'old',
      level: 'partial',
      question,
    });
    expect(
      queueTaskDelivery({
        task: previous,
        requirementsVersion: 0,
        outboundMessageId: 'new',
        level: 'partial',
      }).pendingQuestion,
    ).toBeNull();
    const { goalId: _goal, ...shared } = question;
    const queued = queueTaskDelivery({
      task: task(),
      requirementsVersion: 0,
      outboundMessageId: 'shared',
      level: 'partial',
      question: shared,
    });
    expect(queued.pendingQuestion?.goalId).toBeUndefined();
    expect(
      recordTaskDeliveryReceipt({
        task: queued,
        requirementsVersion: 0,
        outboundMessageId: 'shared',
        status: 'sent',
      }).status,
    ).toBe('waiting_user');
    const known = task();
    known.constraints.push({
      key: 'max_travel_minutes',
      strength: 'hard',
      value: { kind: 'duration', minutes: 30 },
      origin: { kind: 'user', sourceMessageId: 'input' },
    });
    expect(() =>
      queueTaskDelivery({
        task: known,
        requirementsVersion: 0,
        outboundMessageId: 'shared',
        level: 'partial',
        question: shared,
      }),
    ).toThrow('known');
  });
});
