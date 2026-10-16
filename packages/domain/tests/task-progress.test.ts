import { describe, expect, it } from 'vitest';
import { assessTaskReadiness, taskSchema } from '../src/task.js';
import { recordTaskProgress } from '../src/task-progress.js';

function task() {
  return taskSchema.parse({
    id: 't',
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'c' },
    objective: '找允许养猫的房子',
    category: 'housing',
    status: 'active',
    revision: 1,
    requirementsVersion: 1,
    goals: [
      {
        id: 'home',
        title: '一居室',
        required: true,
        criteria: ['rent', 'pets'].map((id) => ({
          id,
          label: id,
          strength: 'hard',
          status: 'unknown',
          evidenceRefs: [],
        })),
      },
    ],
    constraints: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
const source = (id: string, entityKey: string) => ({
  id,
  goalId: 'home',
  kind: 'source_excerpt' as const,
  sourceRef: 'market:' + entityKey,
  entityKey,
  summary: id,
  observedAt: '2026-10-17T00:00:00Z',
});
const nextStep = {
  action: 'research' as const,
  owner: 'agent' as const,
  reason: '补充宠物许可',
  goalId: 'home',
};
describe('task source progress', () => {
  it('retains counterevidence for another offer without overwriting the supported option', () => {
    const p = {
      task: task(),
      requirementsVersion: 1,
      evidence: [source('rent-a', 'a'), source('pets-a', 'a'), source('pets-b', 'b')],
      checks: [
        {
          goalId: 'home',
          criterionId: 'rent',
          status: 'supported' as const,
          evidenceRefs: ['rent-a'],
        },
        {
          goalId: 'home',
          criterionId: 'pets',
          status: 'supported' as const,
          evidenceRefs: ['pets-a'],
          conflictingEvidenceRefs: ['pets-b'],
        },
      ],
      nextStep,
    };
    const result = recordTaskProgress(p);
    expect(result.goals[0]?.criteria[1]).toMatchObject({
      status: 'supported',
      evidenceRefs: ['pets-a'],
      conflictingEvidenceRefs: ['pets-b'],
    });
    expect(assessTaskReadiness(result).ready).toBe(true);
    p.evidence[2]!.entityKey = 'a';
    expect(assessTaskReadiness(recordTaskProgress(p)).ready).toBe(false);
    const { entityKey: _entity, ...withoutAlias } = p.evidence[2]!;
    expect(
      assessTaskReadiness(
        recordTaskProgress({ ...p, evidence: [p.evidence[0]!, p.evidence[1]!, withoutAlias] }),
      ).ready,
    ).toBe(true);
    expect(() =>
      recordTaskProgress({
        ...p,
        checks: [{ ...p.checks[1]!, conflictingEvidenceRefs: ['foreign'] }],
      }),
    ).toThrow('same goal');
  });
  it('persists partial evidence and the next responsible step without closing a user goal', () => {
    const t = recordTaskProgress({
      task: task(),
      requirementsVersion: 1,
      evidence: [source('rent-a', 'offer-a')],
      checks: [
        { goalId: 'home', criterionId: 'rent', status: 'supported', evidenceRefs: ['rent-a'] },
      ],
      nextStep,
    });
    expect(t.goals[0]?.criteria[0]?.status).toBe('supported');
    expect(t.goals[0]?.criteria[1]?.status).toBe('unknown');
    expect(t.nextStep).toEqual(nextStep);
    expect(t.status).toBe('active');
    expect(t.userConfirmation).toBeNull();
    expect(t.revision).toBe(2);
    expect(t.requirementsVersion).toBe(1);
    expect(assessTaskReadiness(t).ready).toBe(false);
  });
  it('does not assemble a matching house from different owners or mark source availability as user completion', () => {
    const p = {
      task: task(),
      requirementsVersion: 1,
      evidence: [source('rent-a', 'offer-a'), source('pets-b', 'offer-b')],
      checks: [
        {
          goalId: 'home',
          criterionId: 'rent',
          status: 'supported' as const,
          evidenceRefs: ['rent-a'],
        },
        {
          goalId: 'home',
          criterionId: 'pets',
          status: 'supported' as const,
          evidenceRefs: ['pets-b'],
        },
      ],
      nextStep,
    };
    const split = recordTaskProgress(p);
    expect(assessTaskReadiness(split).ready).toBe(false);
    p.evidence[1]!.entityKey = 'offer-a';
    const coherent = recordTaskProgress(p);
    expect(assessTaskReadiness(coherent).ready).toBe(true);
    expect(coherent.status).toBe('active');
  });
  it('rejects obsolete requirements, unknown criteria and missing evidence atomically', () => {
    const p = {
      task: task(),
      requirementsVersion: 1,
      evidence: [],
      checks: [
        { goalId: 'home', criterionId: 'pets', status: 'supported' as const, evidenceRefs: [] },
      ],
      nextStep,
    };
    expect(() => recordTaskProgress({ ...p, requirementsVersion: 0 })).toThrow('requirements');
    expect(() =>
      recordTaskProgress({ ...p, checks: [{ ...p.checks[0]!, criterionId: 'foreign' }] }),
    ).toThrow('criterion');
    expect(() => recordTaskProgress(p)).toThrow('evidence');
    expect(task().revision).toBe(1);
  });
  it('records a source wait only for an observed outage and never waits for an unsent question', () => {
    const p = {
      task: task(),
      requirementsVersion: 1,
      evidence: [],
      checks: [],
      nextStep: {
        action: 'wait_source' as const,
        owner: 'source' as const,
        reason: '查询暂不可用',
      },
    };
    expect(() => recordTaskProgress(p)).toThrow('source failure');
    const waiting = recordTaskProgress({ ...p, hasSourceFailure: true });
    expect(waiting.status).toBe('waiting_source');
    expect(waiting.blockReason).toBe('查询暂不可用');
    expect(() =>
      recordTaskProgress({
        ...p,
        nextStep: { action: 'wait_user', owner: 'user', reason: '等回答' },
      }),
    ).toThrow('delivery');
  });
  it('rejects terminal tasks, foreign or resolved goals and incorrect responsibility', () => {
    const p = { task: task(), requirementsVersion: 1, evidence: [], checks: [], nextStep };
    expect(() => recordTaskProgress({ ...p, task: { ...task(), status: 'completed' } })).toThrow(
      'terminal',
    );
    expect(() =>
      recordTaskProgress({ ...p, nextStep: { ...nextStep, goalId: 'foreign' } }),
    ).toThrow('unresolved goal');
    const resolved = task();
    resolved.goals[0]!.userConfirmation = {
      userId: 'u',
      sourceMessageId: 'done',
      intent: 'achieved',
    };
    expect(() => recordTaskProgress({ ...p, task: resolved })).toThrow('unresolved goal');
    expect(() =>
      recordTaskProgress({
        ...p,
        task: resolved,
        nextStep: { action: 'research', owner: 'agent', reason: '查资料' },
        checks: [{ goalId: 'home', criterionId: 'pets', status: 'unknown', evidenceRefs: [] }],
      }),
    ).toThrow('criterion');
    expect(() => recordTaskProgress({ ...p, nextStep: { ...nextStep, owner: 'user' } })).toThrow(
      'owner',
    );
  });
  it('keeps immutable evidence identity while allowing a refreshed observation', () => {
    const initial = recordTaskProgress({
      task: task(),
      requirementsVersion: 1,
      evidence: [source('e', 'a')],
      checks: [],
      nextStep,
    });
    const p = { task: initial, requirementsVersion: 1, checks: [], nextStep };
    for (const changed of [{ goalId: 'foreign' }, { sourceRef: 'market:b' }, { entityKey: 'b' }]) {
      expect(() =>
        recordTaskProgress({ ...p, evidence: [{ ...source('e', 'a'), ...changed }] }),
      ).toThrow('identity');
    }
    expect(
      recordTaskProgress({ ...p, evidence: [{ ...source('e', 'a'), summary: '重新读取原帖' }] })
        .evidence[0]?.summary,
    ).toBe('重新读取原帖');
  });
  it('requires external evidence, and checks semantic coherence without merging market offers', () => {
    const t = task();
    const p = {
      task: t,
      requirementsVersion: 1,
      evidence: [source('r', 'a'), source('p', 'b')],
      checks: [
        { goalId: 'home', criterionId: 'rent', status: 'supported' as const, evidenceRefs: ['r'] },
        { goalId: 'home', criterionId: 'pets', status: 'supported' as const, evidenceRefs: ['p'] },
      ],
      nextStep,
    };
    for (const status of ['unknown', 'conflict', 'supported'] as const) {
      const result = recordTaskProgress({ ...p, coherence: [{ goalId: 'home', status }] });
      expect(assessTaskReadiness(result).ready).toBe(false);
      expect(assessTaskReadiness(result).missing[0]?.status).toBe(
        status === 'unknown' ? 'unknown' : 'conflict',
      );
    }
    const information = recordTaskProgress({
      ...p,
      task: { ...t, category: 'other' },
      coherence: [{ goalId: 'home', status: 'supported' }],
    });
    expect(assessTaskReadiness(information).ready).toBe(true);
    expect(
      recordTaskProgress({
        task: information,
        requirementsVersion: 1,
        checks: [],
        evidence: [],
        nextStep,
      }).goals[0]?.sourceCoherence,
    ).toBe('unknown');
    const userOnly = recordTaskProgress({
      ...p,
      evidence: p.evidence.map((e) => ({ ...e, kind: 'user_statement' as const })),
    });
    expect(assessTaskReadiness(userOnly).ready).toBe(false);
    const noEntity = p.evidence.map(({ entityKey: _entityKey, ...e }) => ({
      ...e,
      sourceRef: 'market:a',
    }));
    expect(assessTaskReadiness(recordTaskProgress({ ...p, evidence: noEntity })).ready).toBe(true);
    expect(() =>
      recordTaskProgress({ ...p, coherence: [{ goalId: 'foreign', status: 'supported' }] }),
    ).toThrow('unresolved goal');
    t.goals[0]!.userConfirmation = { userId: 'u', sourceMessageId: 'done', intent: 'achieved' };
    expect(() =>
      recordTaskProgress({
        ...p,
        task: t,
        checks: [],
        nextStep: { action: 'deliver', owner: 'agent', reason: '已解决' },
        coherence: [{ goalId: 'home', status: 'supported' }],
      }),
    ).toThrow('unresolved goal');
  });
});
