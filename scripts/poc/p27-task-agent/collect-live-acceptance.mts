/** Read-only collector for allowlisted synthetic inputs sent to the original two-member Telegram test group. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { getPrisma, createRepositories, disconnectPrisma } from '../../../packages/db/src/index.js';
import { loadEnv } from '../../../packages/shared/src/index.js';
import { taskConversationsSchema } from '../../../packages/eval/src/task-contract.js';

const startedAt = z.iso.datetime().parse(process.argv[2]);
const output = z
  .string()
  .regex(/^\/tmp\/matchbot-task-release\.[A-Za-z0-9]+\/[A-Za-z0-9._-]+\.json$/)
  .parse(process.argv[3]);
const groupId = '-5522461480';
const corpus = taskConversationsSchema.parse(
  JSON.parse(readFileSync('packages/eval/fixtures/task-agent/conversations.json', 'utf8')),
);
const selected = corpus.cases.filter((row) =>
  ['desk_chair', 'cat_housing', 'beginner_bad'].includes(row.id),
);
const inputs = [...new Set(selected.flatMap((row) => row.turns.map((turn) => turn.input)))];
inputs.push(
  '展开详细资料',
  '桌子和椅子都买到了，这个需求解决了',
  'E14想收二手A3彩色无线激光打印机，20镑以内，今天自提。',
  '打印机这条先不用找了，取消这个需求',
);
const allowed = inputs.flatMap((text) => [text, '@london_match_bot ' + text]);
const env = loadEnv(),
  destination = new URL(env.DATABASE_URL);
if (
  !['127.0.0.1', 'localhost'].includes(destination.hostname) ||
  destination.pathname !== '/matchbot'
)
  throw new Error('original local business DB required');
const p = getPrisma(env.DATABASE_URL),
  repos = createRepositories(p);
const hash = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);
const timer = setTimeout(() => process.exit(2), 15000);
try {
  const messages = await p.message.findMany({
    where: {
      group: { externalId: groupId, channel: 'telegram' },
      receivedAt: { gte: new Date(startedAt) },
      text: { in: allowed },
    },
    orderBy: { receivedAt: 'asc' },
    select: {
      id: true,
      externalId: true,
      text: true,
      receivedAt: true,
      executionStatus: true,
      executionError: true,
      taskId: true,
    },
  });
  const ids = messages.map((row) => row.id);
  const traces = await p.decisionTrace.findMany({
    where: { inputRef: { in: ids } },
    select: { inputRef: true, kind: true, output: true },
  });
  const safeGate = z.enum([
    'market_search',
    'market_enrich',
    'read_task_sources',
    'task_preparation',
    'request_status',
  ]);
  const safeFailure = z.enum([
    'invalid_response',
    'timeout',
    'rate_limited',
    'http_error',
    'trace_unavailable',
  ]);
  const outbounds = await p.outboundMessage.findMany({
    where: { sourceMessageId: { in: ids }, target: groupId, approvalRunStateId: null },
    orderBy: { createdAt: 'asc' },
    select: {
      sourceMessageId: true,
      status: true,
      kind: true,
      externalMessageId: true,
      sentAt: true,
      taskId: true,
      text: true,
      error: true,
    },
  });
  const headers = await p.task.findMany({
    where: { sourceMessageId: { in: ids }, channel: 'telegram', chatId: groupId },
    select: { id: true, userId: true },
  });
  const tasks = [];
  for (const row of headers) {
    const task = await repos.tasks.findById({
      id: row.id,
      access: { userId: row.userId, scope: { channel: 'telegram', chatId: groupId } },
    });
    if (!task) throw new Error('test task not found under its owner scope');
    tasks.push({
      taskHash: hash(task.id),
      category: task.category,
      status: task.status,
      revision: task.revision,
      requirementsVersion: task.requirementsVersion,
      goals: task.goals.map((g) => ({
        id: g.id,
        title: g.title,
        required: g.required,
        userConfirmed: !!g.userConfirmation,
      })),
      constraints: task.constraints.map(({ key, goalId, strength, value, budgetScope }) => ({
        key,
        goalId,
        strength,
        value,
        budgetScope,
      })),
      evidenceCount: task.evidence.length,
      question: task.pendingQuestion
        ? { key: task.pendingQuestion.constraintKey, status: task.pendingQuestion.deliveryStatus }
        : null,
      userConfirmed: !!task.userConfirmation,
    });
  }
  const report = {
    boundary:
      'real original Telegram test group, allowlisted synthetic test inputs only; no other history, user identity, provider text or credentials exported',
    startedAt,
    tasks,
    messages: messages.map((row) => ({
      input: row.text?.replace(/^@london_match_bot\s*/, ''),
      externalMessageId: row.externalId,
      receivedAt: row.receivedAt,
      executionStatus: row.executionStatus,
      executionError: row.executionError,
      taskHash: row.taskId ? hash(row.taskId) : null,
      researchGateCounts: Object.fromEntries(
        safeGate.options.map((gate) => [
          gate,
          traces.filter(
            (trace) =>
              trace.inputRef === row.id &&
              z.object({ gate: safeGate }).safeParse(trace.output).data?.gate === gate,
          ).length,
        ]),
      ),
      jevFailures: traces
        .filter((trace) => trace.inputRef === row.id && trace.kind === 'jev')
        .flatMap((trace) => {
          const result = z
            .object({ ok: z.literal(false), reason: safeFailure })
            .safeParse(trace.output);
          return result.success ? [result.data.reason] : [];
        }),
      outbounds: outbounds
        .filter((o) => o.sourceMessageId === row.id)
        .map((o) => ({
          status: o.status,
          kind: o.kind,
          externalMessageId: o.externalMessageId,
          sentAt: o.sentAt,
          error: o.error,
          taskHash: o.taskId ? hash(o.taskId) : null,
          sourceLinks: [...o.text.matchAll(/\]\((https?:\/\/[^\s)]+)\)/g)].map((match) => match[1]),
        })),
    })),
  };
  writeFileSync(output, JSON.stringify(report, null, 2));
  process.stdout.write(
    JSON.stringify({
      messages: report.messages.map((row) => ({
        id: row.externalMessageId,
        execution: row.executionStatus,
        outbound: row.outbounds.map((o) => ({
          id: o.externalMessageId,
          status: o.status,
          kind: o.kind,
          links: o.sourceLinks.length,
        })),
      })),
      tasks: tasks.map(({ taskHash, status, requirementsVersion }) => ({
        taskHash,
        status,
        requirementsVersion,
      })),
    }) + '\n',
  );
} finally {
  clearTimeout(timer);
  await disconnectPrisma();
}
