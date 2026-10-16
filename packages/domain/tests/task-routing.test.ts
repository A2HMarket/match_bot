import { describe, expect, it } from 'vitest';
import { taskSchema } from '../src/task.js';
import { selectTask } from '../src/task-routing.js';

function task(id: string, ownerUserId = 'owner', chatId = 'group') {
  return taskSchema.parse({
    id,
    ownerUserId,
    scope: { channel: 'telegram', chatId },
    objective: id,
    category: 'other',
    status: 'active',
    revision: 0,
    goals: [],
    evidence: [],
    pendingQuestion: null,
    blockReason: null,
    delivery: { status: 'none', level: 'none' },
    userConfirmation: null,
  });
}
const scope = { channel: 'telegram' as const, chatId: 'group' };
describe('scoped task selection', () => {
  it('continues the sole task for a followup and treats explicit new intent separately', () => {
    const p = { ownerUserId: 'owner', scope, tasks: [task('badminton')] };
    expect(selectTask({ ...p, intent: 'continue' })).toEqual({
      kind: 'selected',
      taskId: 'badminton',
    });
    expect(selectTask({ ...p, intent: 'new' })).toEqual({ kind: 'new' });
    expect(selectTask({ ...p, intent: 'unsure' })).toEqual({
      kind: 'clarify',
      candidateIds: ['badminton'],
    });
  });
  it('uses an exact reply anchor across simultaneous tasks, never the most recent task', () => {
    const p = {
      ownerUserId: 'owner',
      scope,
      tasks: [task('housing'), task('desk')],
      intent: 'continue' as const,
    };
    expect(selectTask(p)).toEqual({ kind: 'clarify', candidateIds: ['housing', 'desk'] });
    expect(selectTask({ ...p, anchorTaskId: 'desk' })).toEqual({
      kind: 'selected',
      taskId: 'desk',
    });
    expect(selectTask({ ...p, referencedTaskId: 'desk' })).toEqual({
      kind: 'selected',
      taskId: 'desk',
    });
    expect(selectTask({ ...p, anchorTaskId: 'desk', referencedTaskId: 'housing' })).toEqual({
      kind: 'clarify',
      candidateIds: ['housing', 'desk'],
    });
  });
  it('does not expose or continue tasks from another owner, chat, channel or terminal state', () => {
    const foreignChannel = task('whatsapp');
    foreignChannel.scope.channel = 'whatsapp';
    const closed = task('closed');
    closed.status = 'completed';
    const p = {
      ownerUserId: 'owner',
      scope,
      intent: 'continue' as const,
      tasks: [
        task('other-owner', 'other'),
        task('private', 'owner', 'owner'),
        foreignChannel,
        closed,
      ],
    };
    expect(selectTask(p)).toEqual({ kind: 'unbound' });
    for (const anchorTaskId of ['other-owner', 'private', 'whatsapp', 'closed', 'missing'])
      expect(selectTask({ ...p, anchorTaskId })).toEqual({ kind: 'inaccessible' });
    expect(selectTask({ ...p, referencedTaskId: 'private' })).toEqual({ kind: 'inaccessible' });
  });
  it('does not create a task out of a bare answer without a known goal', () => {
    expect(selectTask({ ownerUserId: 'owner', scope, intent: 'continue', tasks: [] })).toEqual({
      kind: 'unbound',
    });
    expect(selectTask({ ownerUserId: 'owner', scope, intent: 'unsure', tasks: [] })).toEqual({
      kind: 'unbound',
    });
    expect(selectTask({ ownerUserId: 'owner', scope, intent: 'new', tasks: [] })).toEqual({
      kind: 'new',
    });
  });
});
