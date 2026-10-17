import { taskSchema, reviseTaskRequirements, transitionTaskStatus } from '@matchbot/domain';
import { RunContext } from '@openai/agents';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDeps, MatchContext } from '../../src/context.js';
import { planTaskTool, taskPlanningTools } from '../../src/tools/plan-task.js';
import { bindCurrentRequest } from '../../src/current-request.js';

function task(id = 'existing') {
  return taskSchema.parse({
    id,
    ownerUserId: 'u',
    scope: { channel: 'telegram', chatId: 'g' },
    objective: '周末羽毛球',
    category: 'other',
    status: 'active',
    revision: 0,
    goals: [
      {
        id: 'activity',
        title: '初学者羽毛球',
        required: true,
        criteria: [
          {
            id: 'fit',
            label: '初学者/周末适配',
            strength: 'hard',
            status: 'unknown',
            evidenceRefs: [],
          },
        ],
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
function fixture(text: string, candidates = [task()]) {
  const rows = new Map(candidates.map((t) => [t.id, t]));
  const ctx: MatchContext = {
    userId: 'u',
    chatId: 'g',
    groupId: 'group',
    channel: 'telegram',
    phase: 2,
    sourceMessageId: 'm',
    recentReplies: [],
    taskCandidates: candidates,
  };
  const repos = {
    tasks: {
      create: vi.fn((p: Parameters<AgentDeps['repos']['tasks']['create']>[0]) => {
        const value = {
          ...task('new'),
          objective: p.objective,
          category: p.category,
          goals: [],
          counterparty: p.counterparty ?? null,
        };
        rows.set(value.id, value);
        return Promise.resolve(value);
      }),
      applyUserTurn: vi.fn(
        (p: {
          id: string;
          patch: Parameters<typeof reviseTaskRequirements>[0]['patch'] | null;
          outcome: { intent: 'achieved' | 'cancelled'; goalIds: string[] } | null;
        }) => {
          let value = rows.get(p.id) ?? { ...task('new'), goals: [] };
          if (p.patch)
            value = reviseTaskRequirements({
              task: value,
              source: { messageId: 'm', text },
              patch: p.patch,
            });
          if (p.outcome)
            value = transitionTaskStatus({
              task: value,
              next: p.outcome.intent === 'achieved' ? 'completed' : 'cancelled',
              actor: { kind: 'user', userId: 'u', messageId: 'm', intent: p.outcome.intent },
            });
          rows.set(value.id, value);
          return Promise.resolve({ kind: 'applied', task: value });
        },
      ),
    },
    traces: { create: vi.fn(() => Promise.resolve({})) },
  };
  Object.assign(repos.tasks, {
    planTurn: vi.fn(async (p: Parameters<AgentDeps['repos']['tasks']['planTurn']>[0]) => {
      const current = p.creation
        ? await repos.tasks.create({
            ...p.creation,
            access: p.access,
            sourceMessageId: p.sourceMessageId,
          })
        : rows.get(p.taskId ?? '');
      if (!current) throw new Error('missing task');
      return repos.tasks.applyUserTurn({ id: current.id, patch: p.patch, outcome: p.outcome });
    }),
  });
  return { ctx, repos, tool: planTaskTool({ repos } as unknown as AgentDeps, text) };
}
const base = {
  route: 'continue',
  taskRef: 'existing',
  referenceQuote: null,
  objective: null,
  category: null,
  patch: null,
  outcome: null,
};
describe('delivery receipt task revision race', () => {
  it.each([false, true])(
    'refreshes once only when the requirements are unchanged (changed=%s)',
    async (changed) => {
      const initial = task();
      initial.revision = 12;
      initial.requirementsVersion = 1;
      initial.delivery = { status: 'queued', level: 'partial', outboundMessageId: 'previous' };
      const latest = {
        ...initial,
        revision: 13,
        requirementsVersion: changed ? 2 : 1,
        delivery: { ...initial.delivery, status: 'sent' as const },
      };
      const { ctx, repos, tool } = fixture('头痛', [initial]);
      const findById = vi.fn().mockResolvedValue(latest);
      const planTurn = vi
        .fn()
        .mockResolvedValueOnce({ kind: 'conflict' })
        .mockResolvedValueOnce({ kind: 'applied', task: { ...latest, revision: 14 } });
      Object.assign(repos.tasks, { findById, planTurn });
      await tool.invoke(new RunContext(ctx), JSON.stringify(base));
      expect(planTurn).toHaveBeenCalledTimes(changed ? 1 : 2);
      if (!changed) {
        expect(planTurn.mock.calls[1]?.[0]).toMatchObject({
          taskId: 'existing',
          expectedRevision: 13,
        });
        expect(ctx.task?.id).toBe('existing');
      } else expect(ctx.task).toBeUndefined();
    },
  );
});

describe('plan_task', () => {
  it('does not use a catch-all proposal to create a task for an unsupported job request', async () => {
    const { tool, ctx, repos } = fixture('伦敦找工作', []);
    bindCurrentRequest(ctx, '伦敦找工作');
    await tool.invoke(
      new RunContext(ctx),
      JSON.stringify({
        ...base,
        route: 'new',
        taskRef: null,
        objective: '找工作',
        category: 'other',
        patch: {
          goals: [
            {
              id: 'work',
              title: '工作',
              required: true,
              sourceQuote: '找工作',
              criteria: [{ id: 'subject', label: '工作', strength: 'hard' }],
            },
          ],
          constraints: [],
        },
      }),
    );
    expect(ctx.task).toBeUndefined();
    expect(repos.tasks.create).not.toHaveBeenCalled();
  });
  it('keeps the server-bound specific category when the planner proposes the catch-all category', async () => {
    const { tool, ctx } = fixture('E14想收书桌，每件50镑以内', []);
    bindCurrentRequest(ctx, 'E14想收书桌，每件50镑以内');
    await tool.invoke(
      new RunContext(ctx),
      JSON.stringify({
        ...base,
        route: 'new',
        taskRef: null,
        objective: '求购书桌',
        category: 'other',
        patch: {
          goals: [
            {
              id: 'desk',
              title: '书桌',
              required: true,
              sourceQuote: '书桌',
              criteria: [{ id: 'subject', label: '书桌', strength: 'hard' }],
            },
          ],
          constraints: [],
        },
      }),
    );
    expect(ctx.task?.category).toBe('second_hand');
    expect(ctx.task?.counterparty).toBe('supply');
  });
  it('does not accept ambiguity between tasks when there is only one scoped candidate', async () => {
    const { ctx, repos } = fixture('室内的，收费也可以');
    const tools = taskPlanningTools({ repos } as unknown as AgentDeps, '室内的，收费也可以', [
      'existing',
    ]);
    const clarify = tools.find((t) => t.name === 'clarify_task')!;
    const answer = await clarify.invoke(
      new RunContext(ctx),
      JSON.stringify({ reason: 'ambiguous_reference' }),
    );
    expect(answer).toContain('only one scoped task');
    expect(ctx.taskUpdate).toBeUndefined();
    expect(repos.tasks.applyUserTurn).not.toHaveBeenCalled();
    const update = tools.find((t) => t.name === 'update_task')!;
    await update.invoke(
      new RunContext(ctx),
      JSON.stringify({
        taskRef: 'existing',
        referenceQuote: null,
        goals: [],
        constraints: [
          {
            key: 'feature',
            goalId: null,
            strength: 'hard',
            value: { kind: 'text', text: '室内' },
            sourceQuote: '室内',
          },
        ],
        outcome: null,
      }),
    );
    expect(ctx.taskUpdate?.kind).toBe('continued');
  });
  it('still permits missing-goal questions and genuine multi-task ambiguity', async () => {
    for (const [candidates, reason] of [
      [[], 'missing_goal'],
      [[task(), task('second')], 'ambiguous_reference'],
    ] as const) {
      const { ctx, repos } = fixture('可以加一点', [...candidates]);
      const clarify = taskPlanningTools(
        { repos } as unknown as AgentDeps,
        '可以加一点',
        candidates.map((t) => t.id),
      ).find((t) => t.name === 'clarify_task')!;
      await clarify.invoke(new RunContext(ctx), JSON.stringify({ reason }));
      expect(ctx.taskUpdate?.kind).toBe('ambiguous');
      expect(repos.tasks.applyUserTurn).not.toHaveBeenCalled();
    }
  });
  it('explains an invalid outcome interpretation so the planner can correct it without erasing completion', async () => {
    const { tool, ctx } = fixture('房子找好了，不用继续了');
    const reply = await tool.invoke(
      new RunContext(ctx),
      JSON.stringify({
        ...base,
        outcome: { intent: 'cancelled', goalIds: [], quote: '不用继续了' },
      }),
    );
    expect(reply).toContain('already solved');
    expect(ctx.taskUpdate).toBeUndefined();
    await tool.invoke(
      new RunContext(ctx),
      JSON.stringify({
        ...base,
        outcome: { intent: 'achieved', goalIds: [], quote: '房子找好了' },
      }),
    );
    expect(ctx.task?.status).toBe('completed');
  });
  it('persists the counterparty from the original carry offer instead of a lossy task title', async () => {
    const text = '我2026年11月1日伦敦飞上海，有2公斤空余行李，帮我找需求方';
    const { tool, ctx } = fixture(text, []);
    await tool.invoke(
      new RunContext(ctx),
      JSON.stringify({
        ...base,
        route: 'new',
        taskRef: null,
        objective: '提供帮带空间并寻找需求方',
        category: 'other',
        patch: {
          goals: [
            {
              id: 'carry',
              title: '帮带需求方',
              required: true,
              sourceQuote: text,
              criteria: [{ id: 'source', label: '有真实需求来源', strength: 'hard' }],
            },
          ],
          constraints: [],
        },
      }),
    );
    expect(ctx.task?.counterparty).toBe('demand');
  });
  it('binds a short answer to the existing task and only proposes fresh-source constraints', async () => {
    const { tool, ctx, repos } = fixture('半小时以内');
    const result = await tool.invoke(
      new RunContext(ctx),
      JSON.stringify({
        ...base,
        patch: {
          goals: [],
          constraints: [
            {
              key: 'max_travel_minutes',
              goalId: null,
              strength: 'hard',
              value: { kind: 'duration', minutes: 30 },
              sourceQuote: '半小时以内',
            },
          ],
        },
      }),
    );
    expect(result).toContain('task prepared');
    expect(ctx.task?.id).toBe('existing');
    expect(ctx.task?.constraints[0]?.value).toEqual({ kind: 'duration', minutes: 30 });
    expect(repos.tasks.create).not.toHaveBeenCalled();
    expect(repos.tasks.applyUserTurn).toHaveBeenCalledOnce();
  });
  it('does not mutate any task when two plausible requests are ambiguous', async () => {
    const { tool, ctx, repos } = fixture('可以加一点预算', [task(), task('housing')]);
    await tool.invoke(new RunContext(ctx), JSON.stringify({ ...base, taskRef: null }));
    expect(ctx.taskUpdate?.kind).toBe('ambiguous');
    expect(repos.tasks.applyUserTurn).not.toHaveBeenCalled();
  });
  it('does not let the model choose an arbitrary task for a generic budget reference', async () => {
    const { tool, ctx, repos } = fixture('可以加一点预算', [task(), task('housing')]);
    await tool.invoke(
      new RunContext(ctx),
      JSON.stringify({ ...base, referenceQuote: '可以加一点预算' }),
    );
    expect(ctx.taskUpdate?.kind).toBe('ambiguous');
    expect(repos.tasks.applyUserTurn).not.toHaveBeenCalled();
  });
  it('refuses inaccessible task references and does not accept an arbitrary snapshot', async () => {
    const { tool, ctx, repos } = fixture('继续');
    expect(
      await tool.invoke(new RunContext(ctx), JSON.stringify({ ...base, taskRef: 'foreign' })),
    ).toContain('task proposal rejected');
    expect(ctx.task).toBeUndefined();
    expect(repos.tasks.applyUserTurn).not.toHaveBeenCalled();
  });
  it('checks the entire proposal before creating a new task', async () => {
    const { tool, ctx, repos } = fixture('E14找书桌', []);
    const args = {
      ...base,
      route: 'new',
      taskRef: null,
      objective: '找书桌',
      category: 'second_hand',
      patch: {
        goals: [
          {
            id: 'desk',
            title: '书桌',
            required: true,
            sourceQuote: '我想找车',
            criteria: [{ id: 'fit', label: '适配', strength: 'hard' }],
          },
        ],
        constraints: [],
      },
    };
    expect(await tool.invoke(new RunContext(ctx), JSON.stringify(args))).toContain(
      'task proposal rejected',
    );
    expect(repos.tasks.create).not.toHaveBeenCalled();
    args.patch.goals[0]!.sourceQuote = '找书桌';
    expect(await tool.invoke(new RunContext(ctx), JSON.stringify(args))).toContain('task prepared');
    expect(ctx.task?.id).toBe('new');
    expect(repos.tasks.create).toHaveBeenCalledOnce();
  });
  it('keeps thanks and conditional outcomes from closing the task', async () => {
    const { tool, ctx, repos } = fixture('如果找到了就告诉你');
    expect(
      await tool.invoke(
        new RunContext(ctx),
        JSON.stringify({ ...base, outcome: { intent: 'achieved', goalIds: [], quote: '找到了' } }),
      ),
    ).toContain('task proposal rejected');
    expect(repos.tasks.applyUserTurn).not.toHaveBeenCalled();
    expect(ctx.taskUpdate).toBeUndefined();
  });
});
