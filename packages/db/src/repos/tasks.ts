import { createHash } from 'node:crypto';
import {
  DEMAND_CATEGORIES,
  TASK_STATUSES,
  taskActorSchema,
  confirmTaskGoal,
  reviseTaskRequirements,
  taskRequirementPatchSchema,
  taskPayloadSchema,
  taskSchema,
  transitionTaskStatus,
  type UserTask,
} from '@matchbot/domain';
import { z } from 'zod';
import { Prisma, type PrismaClient, type Task } from '../generated/client.js';

const id = z.string().min(1).max(160);
const accessSchema = z.strictObject({
  userId: id,
  scope: taskSchema.shape.scope,
});
export type TaskAccess = z.infer<typeof accessSchema>;
const createSchema = z.strictObject({
  access: accessSchema,
  sourceMessageId: id,
  intentKey: id,
  objective: taskSchema.shape.objective,
  category: z.enum(DEMAND_CATEGORIES),
  counterparty: taskSchema.shape.counterparty,
});
const mutationSchema = z.strictObject({
  access: accessSchema,
  id,
  expectedRevision: z.number().int().nonnegative(),
  operationKey: id,
});
const transitionSchema = mutationSchema.extend({
  next: z.enum(TASK_STATUSES),
  actor: taskActorSchema,
});
const reviseSchema = mutationSchema.extend({
  sourceMessageId: id,
  patch: taskRequirementPatchSchema,
});
const confirmGoalSchema = mutationSchema.extend({ goalId: id, actor: taskActorSchema });
const userTurnSchema = mutationSchema.extend({
  sourceMessageId: id,
  patch: taskRequirementPatchSchema.nullable(),
  outcome: z
    .strictObject({ intent: z.enum(['achieved', 'cancelled']), goalIds: z.array(id).max(24) })
    .nullable(),
});
export type TaskMutationResult =
  { kind: 'applied' | 'replayed'; task: UserTask } | { kind: 'conflict' | 'not_found' };

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function scopeWhere(access: TaskAccess) {
  return { userId: access.userId, channel: access.scope.channel, chatId: access.scope.chatId };
}
function readTask(row: Task): UserTask {
  return taskSchema.parse({
    ...taskPayloadSchema.parse(row.state),
    id: row.id,
    ownerUserId: row.userId,
    scope: { channel: row.channel, chatId: row.chatId },
    category: row.category,
    status: row.status,
    revision: row.revision,
    requirementsVersion: row.requirementsVersion,
  });
}
function payload(task: UserTask) {
  const {
    id: _id,
    ownerUserId: _owner,
    scope: _scope,
    category: _category,
    status: _status,
    revision: _revision,
    requirementsVersion: _version,
    ...state
  } = task;
  return taskPayloadSchema.parse(state);
}
function checkpoint(task: UserTask) {
  // Identity and revision are immutable columns on the event/task, not duplicated JSON authority.
  return {
    state: payload(task),
    category: task.category,
    status: task.status,
    requirementsVersion: task.requirementsVersion,
  };
}
async function requireMessage(prisma: PrismaClient, access: TaskAccess, sourceMessageId: string) {
  const message = await prisma.message.findFirst({
    where: { id: sourceMessageId, userId: access.userId },
    include: { group: true, user: true },
  });
  if (
    !message ||
    (message.group?.channel ?? message.user.channel) !== access.scope.channel ||
    (message.group?.externalId ?? message.user.externalId) !== access.scope.chatId
  )
    throw new Error('task source message missing or inaccessible');
  return message;
}
function assertReplay(actual: string, expected: string): void {
  if (actual !== expected) throw new Error('task operation replay payload mismatch');
}

type Mutation = z.infer<typeof mutationSchema> & {
  requestHash: string;
  kind: 'status_changed' | 'requirements_revised' | 'goal_confirmed' | 'user_turn';
  actorKind: 'agent' | 'user' | 'system';
  sourceMessageId?: string;
  compute: (task: UserTask, source: Awaited<ReturnType<typeof requireMessage>> | null) => UserTask;
};

async function persistMutation(input: {
  prisma: PrismaClient;
  mutation: Mutation;
  row: Task;
  task: UserTask;
  source: Awaited<ReturnType<typeof requireMessage>> | null;
}): Promise<TaskMutationResult> {
  const { prisma, mutation: p, row, task, source } = input;
  try {
    const updated = await prisma.task.update({
      where: { id: row.id, revision: p.expectedRevision, ...scopeWhere(p.access) },
      data: {
        status: task.status,
        state: payload(task),
        revision: task.revision,
        requirementsVersion: task.requirementsVersion,
        ...(source
          ? {
              lastUserActivityAt: new Date(
                Math.max(source.receivedAt.getTime(), row.lastUserActivityAt.getTime()),
              ),
            }
          : {}),
        events: {
          create: {
            revision: task.revision,
            operationKey: p.operationKey,
            requestHash: p.requestHash,
            kind: p.kind,
            actorKind: p.actorKind,
            sourceMessageId: source?.id ?? null,
            checkpoint: checkpoint(task),
          },
        },
      },
    });
    return { kind: 'applied', task: readTask(updated) };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025')
      return { kind: 'conflict' };
    throw error;
  }
}

async function commitMutation(prisma: PrismaClient, p: Mutation): Promise<TaskMutationResult> {
  const row = await prisma.task.findFirst({ where: { id: p.id, ...scopeWhere(p.access) } });
  if (!row) return { kind: 'not_found' };
  const current = readTask(row);
  const event = await prisma.taskEvent.findUnique({
    where: { taskId_operationKey: { taskId: p.id, operationKey: p.operationKey } },
  });
  if (event) {
    assertReplay(event.requestHash, p.requestHash);
    return { kind: 'replayed', task: current };
  }
  if (current.revision !== p.expectedRevision) return { kind: 'conflict' };
  const source = p.sourceMessageId
    ? await requireMessage(prisma, p.access, p.sourceMessageId)
    : null;
  const updated = p.compute(current, source);
  return persistMutation({ prisma, mutation: p, row, task: updated, source });
}

export function tasksRepo(prisma: PrismaClient) {
  async function findById(input: { access: TaskAccess; id: string }): Promise<UserTask | null> {
    const p = z.strictObject({ access: accessSchema, id }).parse(input);
    const row = await prisma.task.findFirst({ where: { id: p.id, ...scopeWhere(p.access) } });
    return row ? readTask(row) : null;
  }
  return {
    findById,
    async findOpenByScope(input: TaskAccess): Promise<UserTask[]> {
      const access = accessSchema.parse(input);
      const rows = await prisma.task.findMany({
        where: {
          ...scopeWhere(access),
          status: { notIn: ['completed', 'cancelled', 'expired'] },
        },
        orderBy: { updatedAt: 'desc' },
      });
      return rows.map(readTask);
    },
    async deleteInactiveBefore(input: Date): Promise<number> {
      const cutoff = z.date().parse(input);
      const result = await prisma.task.deleteMany({
        where: { lastUserActivityAt: { lt: cutoff } },
      });
      return result.count;
    },
    async create(input: z.input<typeof createSchema>): Promise<UserTask> {
      const p = createSchema.parse(input);
      const source = await requireMessage(prisma, p.access, p.sourceMessageId);
      const originHash = fingerprint(p);
      const state = taskPayloadSchema.parse({
        objective: p.objective,
        counterparty: p.counterparty,
        goals: [],
        evidence: [],
        pendingQuestion: null,
        blockReason: null,
        delivery: { status: 'none', level: 'none' },
        userConfirmation: null,
      });
      const identity = {
        ...scopeWhere(p.access),
        sourceMessageId: p.sourceMessageId,
        intentKey: p.intentKey,
      };
      const row = await prisma.task.upsert({
        where: { userId_channel_chatId_sourceMessageId_intentKey: identity },
        update: {},
        create: {
          ...identity,
          originHash,
          category: p.category,
          state,
          lastUserActivityAt: source.receivedAt,
          events: {
            create: {
              revision: 0,
              operationKey: 'created',
              requestHash: originHash,
              kind: 'created',
              actorKind: 'user',
              sourceMessageId: source.id,
              checkpoint: {
                state,
                category: p.category,
                status: 'active',
                requirementsVersion: 0,
              },
            },
          },
        },
      });
      assertReplay(row.originHash, originHash);
      return readTask(row);
    },
    async transition(input: z.input<typeof transitionSchema>): Promise<TaskMutationResult> {
      const p = transitionSchema.parse(input);
      return commitMutation(prisma, {
        ...p,
        kind: 'status_changed',
        actorKind: p.actor.kind,
        requestHash: fingerprint({
          expectedRevision: p.expectedRevision,
          next: p.next,
          actor: p.actor,
        }),
        ...(p.actor.kind === 'user' ? { sourceMessageId: p.actor.messageId } : {}),
        compute: (task) => transitionTaskStatus({ task, next: p.next, actor: p.actor }),
      });
    },
    async reviseRequirements(input: z.input<typeof reviseSchema>): Promise<TaskMutationResult> {
      const p = reviseSchema.parse(input);
      return commitMutation(prisma, {
        ...p,
        kind: 'requirements_revised',
        actorKind: 'agent',
        requestHash: fingerprint({
          expectedRevision: p.expectedRevision,
          sourceMessageId: p.sourceMessageId,
          patch: p.patch,
        }),
        compute: (task, source) => {
          if (!source) throw new Error('requirement source missing');
          return reviseTaskRequirements({
            task,
            source: { messageId: source.id, text: source.text },
            patch: p.patch,
          });
        },
      });
    },
    async confirmGoal(input: z.input<typeof confirmGoalSchema>): Promise<TaskMutationResult> {
      const p = confirmGoalSchema.parse(input);
      return commitMutation(prisma, {
        ...p,
        kind: 'goal_confirmed',
        actorKind: p.actor.kind,
        requestHash: fingerprint({
          expectedRevision: p.expectedRevision,
          goalId: p.goalId,
          actor: p.actor,
        }),
        ...(p.actor.kind === 'user' ? { sourceMessageId: p.actor.messageId } : {}),
        compute: (task) => confirmTaskGoal({ task, goalId: p.goalId, actor: p.actor }),
      });
    },
    async applyUserTurn(input: z.input<typeof userTurnSchema>): Promise<TaskMutationResult> {
      const p = userTurnSchema.parse(input);
      return commitMutation(prisma, {
        ...p,
        kind: 'user_turn',
        actorKind: 'user',
        requestHash: fingerprint({
          expectedRevision: p.expectedRevision,
          sourceMessageId: p.sourceMessageId,
          patch: p.patch,
          outcome: p.outcome,
        }),
        compute: (current, source) => {
          if (!source) throw new Error('task turn source missing');
          let task = p.patch
            ? reviseTaskRequirements({
                task: current,
                source: { messageId: source.id, text: source.text },
                patch: p.patch,
              })
            : current;
          if (p.outcome) {
            const actor = {
              kind: 'user' as const,
              userId: p.access.userId,
              messageId: source.id,
              intent: p.outcome.intent,
            };
            if (p.outcome.goalIds.length) {
              for (const goalId of p.outcome.goalIds)
                task = confirmTaskGoal({ task, goalId, actor });
            } else
              task = transitionTaskStatus({
                task,
                actor,
                next: p.outcome.intent === 'achieved' ? 'completed' : 'cancelled',
              });
          }
          return { ...task, revision: current.revision + 1 };
        },
      });
    },
  };
}
