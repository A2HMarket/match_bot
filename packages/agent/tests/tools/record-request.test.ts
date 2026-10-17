import { expect, it, vi } from 'vitest';
import { taskSchema } from '@matchbot/domain';
import { recordRequestTool } from '../../src/tools/record-request.js';

it('records a scoped task request rather than overwriting the user latest same-category demand', async () => {
  const task = taskSchema.parse({
      id: 'moving-saturday',
      ownerUserId: 'owner',
      scope: { channel: 'telegram', chatId: '-1' },
      objective: '周六搬家',
      category: 'man_and_van',
      status: 'active',
      revision: 1,
      requirementsVersion: 1,
      goals: [],
      evidence: [],
      pendingQuestion: null,
      blockReason: null,
      delivery: { status: 'none', level: 'none' },
      userConfirmation: null,
    }),
    recordForTask = vi.fn().mockResolvedValue({ id: 'saturday-demand' }),
    findOpenByUser = vi.fn().mockResolvedValue([{ id: 'sunday-demand', category: 'man_and_van' }]),
    update = vi.fn(),
    tool = recordRequestTool({
      repos: { demands: { recordForTask, findOpenByUser, update } },
    } as never),
    ctx = {
      userId: 'owner',
      chatId: '-1',
      sourceMessageId: 'message',
      task,
      currentRequest: { demand: { category: 'man_and_van', confidence: 1, whenText: '周六' } },
    };
  await tool.invoke({ context: ctx } as never, JSON.stringify({ need: 'moving service' }));
  expect(recordForTask).toHaveBeenCalledWith(
    expect.objectContaining({
      taskId: task.id,
      sourceMessageId: 'message',
      requirementsVersion: 1,
    }),
  );
  expect(findOpenByUser).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
