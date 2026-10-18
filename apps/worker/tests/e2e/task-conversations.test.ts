import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { assistantMessage, functionCall, ScriptedModel } from '@openai/agents/testing';
import {
  configureModelProvider,
  createTraceProcessor,
  runInbound,
  type MatchContext,
} from '@matchbot/agent';
import { createLogger, envSchema } from '@matchbot/shared';
import { DEFAULT_THRESHOLDS } from '@matchbot/gating';
import type { UserTask } from '@matchbot/domain';
import {
  gradeTaskTurn,
  taskConversationsSchema,
} from '../../../../packages/eval/src/task-contract.js';
import { SCRIPTED_TASK_TURNS } from '../../../../packages/eval/fixtures/task-agent/scripted-turns.js';
import { withTestDb } from '../../../../packages/db/tests/integration/setup.js';
import { createTaskContractStore } from '../../../../packages/db/tests/integration/task-contract-store.js';
import { processInbound, type PipelineDeps } from '../../src/pipeline/inbound.js';
import { drainOutbound } from '../../../bot/src/outbound-loop.js';

declare module 'vitest' {
  export interface ProvidedContext {
    taskContractFault?: string;
  }
}
const frozen = taskConversationsSchema.parse(
  JSON.parse(
    readFileSync(
      new URL('../../../../packages/eval/fixtures/task-agent/conversations.json', import.meta.url),
      'utf8',
    ),
  ),
);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(frozen.frozenAt + 'T12:00:00Z'));
});
afterEach(() => vi.useRealTimers());
const logger = createLogger('task-contract', 'silent');
const env = envSchema.parse({
  DATABASE_URL: 'postgresql://synthetic/contract',
  REDIS_URL: 'redis://synthetic',
  DEEPSEEK_API_KEY: 'synthetic',
  JEV_API_KEY: 'synthetic',
  TELEGRAM_BOT_TOKEN: 'synthetic',
  TELEGRAM_OPS_CHAT_ID: '-999',
  SNAPSHOT_KEY: 'synthetic-task-contract-key-12345',
  DEFAULT_PHASE: 2,
});

describe.each(['strict', 'targeted'] as const)(
  'frozen task conversation contracts (%s)',
  (policy) => {
    const policyEnv = { ...env, JEV_POLICY: policy };
    it.each(frozen.cases)(
      '$id',
      async (sample) =>
        withTestDb(async (tx) => {
          const actions = SCRIPTED_TASK_TURNS[sample.id];
          if (!actions || actions.length !== sample.turns.length)
            throw new Error('missing independent annotated model script');
          const store = await createTaskContractStore(tx),
            repos = store.repos,
            aliases = new Map<
              string,
              {
                id: string;
                access: { userId: string; scope: { channel: 'telegram'; chatId: string } };
              }
            >(),
            replies = new Map<string, string>(),
            processor = createTraceProcessor({ traces: repos.traces, logger });
          configureModelProvider(policyEnv, [processor]);
          let receiptId = 1000;
          const snapshots = async () => {
            const tasks: UserTask[] = [];
            for (const entry of aliases.values()) {
              const task = await repos.tasks.findById(entry);
              if (task) tasks.push(task);
            }
            return tasks.sort((a, b) => a.id.localeCompare(b.id));
          };
          try {
            for (const [index, turn] of sample.turns.entries()) {
              const action = actions[index]!,
                owner = action.owner ?? 'owner',
                scope = action.scope ?? 'group',
                user = store.user(owner),
                group = scope === 'private' ? null : store.group(scope),
                chatId = group?.externalId ?? user.externalId,
                before = await snapshots();
              const args = { ...action.prep.args };
              if (typeof args.taskRef === 'string' && args.taskRef.startsWith('$')) {
                const ref = aliases.get(args.taskRef.slice(1));
                if (!ref) throw new Error('missing scripted task reference');
                args.taskRef = ref.id;
              }
              if (
                inject('taskContractFault') === 'drop-chair' &&
                sample.id === 'desk_chair' &&
                index === 0 &&
                Array.isArray(args.goals)
              )
                args.goals = args.goals.slice(0, 1);
              const frames = [
                [functionCall(action.prep.tool, args, { callId: 'prepare-' + index })],
              ];
              if (action.react)
                frames.push([
                  functionCall('react', { emoji: '👍' }, { callId: 'reaction-' + index }),
                ]);
              else if (!action.deny) {
                if (action.intent)
                  frames.push([
                    functionCall(
                      'market_search',
                      {
                        intent: action.intent,
                        purpose: 'discover',
                        plan: {
                          needs: [
                            {
                              id:
                                sample.id === 'desk_chair' ||
                                action.alias === 'desk' ||
                                action.alias === 'furniture'
                                  ? 'desk'
                                  : action.alias === 'carry'
                                    ? 'carry'
                                    : action.intent === 'housing'
                                      ? 'home'
                                      : 'partner',
                              terms: [
                                action.intent === 'housing'
                                  ? '一居室'
                                  : action.intent === 'companion'
                                    ? '羽毛球'
                                    : action.intent === 'carry'
                                      ? '帮带'
                                      : '书桌',
                              ],
                            },
                          ],
                          preferences: [],
                          requiredTerms: [],
                          excludeTerms: [],
                          requiredArea: [],
                          budget: null,
                          route: null,
                          dateRange: null,
                        },
                        queries: [
                          {
                            keyword:
                              action.intent === 'housing'
                                ? '一居室'
                                : action.intent === 'companion'
                                  ? '羽毛球'
                                  : action.intent === 'carry'
                                    ? '帮带'
                                    : '书桌',
                            page: 1,
                            tradeType: action.intent === 'companion' ? 'PEER' : 'SELL',
                            entity: null,
                          },
                        ],
                      },
                      { callId: 'search-' + index },
                    ),
                  ]);
                if (action.alias)
                  frames.push([
                    functionCall(
                      'record_task_progress',
                      {
                        checks: [],
                        next: {
                          action: action.question ? 'ask_user' : 'deliver',
                          goalId: null,
                          constraintKey: action.question?.key ?? null,
                          reason: action.question
                            ? '补充影响选择的未知信息'
                            : '说明当前查询结果和条件缺口',
                        },
                      },
                      { callId: 'progress-' + index },
                    ),
                  ]);
                frames.push([
                  functionCall(
                    'reply_to_request',
                    {
                      kind: action.question
                        ? 'clarification'
                        : action.source === 'unavailable'
                          ? 'unavailable'
                          : action.alias
                            ? 'no_match'
                            : 'clarification',
                      text:
                        action.question?.text ??
                        (action.source === 'unavailable'
                          ? '这次查询没能完成，不能据此判断没有选项。'
                          : action.alias
                            ? '这次还没有确认到合适选项，当前条件已经保留。'
                            : '请在当前对话说明具体是哪一项需求。'),
                      refs: [],
                    },
                    { callId: 'reply-' + index },
                  ),
                ]);
              }
              frames.push([assistantMessage('done')]);
              const model = new ScriptedModel(frames),
                captured: { ctx?: MatchContext } = {},
                inputs: string[] = [],
                get = model.getResponse.bind(model);
              model.getResponse = async (...params: Parameters<typeof model.getResponse>) => {
                inputs.push(JSON.stringify(params[0]));
                return get(...params);
              };
              let searches = 0;
              const replyTo = action.replyTo ? replies.get(action.replyTo) : undefined;
              if (action.replyTo && !replyTo)
                throw new Error('script requires an actually sent reply anchor');
              await processInbound(
                {
                  env: policyEnv,
                  repos,
                  logger,
                  thresholds: DEFAULT_THRESHOLDS,
                  answerRequests: true,
                  taskRequests: true,
                  modelProvider: { getModel: () => model },
                  runInbound: async (p: Parameters<typeof runInbound>[0]) => {
                    captured.ctx = p.ctx;
                    return runInbound(p);
                  },
                  evaluateInbound: () => {
                    if (policy === 'targeted')
                      throw new Error('Direct request must not call Jev admission');
                    return Promise.resolve({
                      ok: true,
                      isDemand: 0.99,
                      isSupply: 0,
                      category:
                        action.intent === 'housing'
                          ? 'housing'
                          : action.intent === 'second_hand'
                            ? 'second_hand'
                            : 'other',
                      categoryConfidence: 0.99,
                      urgency: 1,
                      hasLocation: 1,
                      isSensitive: 0,
                      isMoveEvent: 0,
                      isLocalRequest: 0.99,
                    });
                  },
                  jev: {
                    evaluate: async (p: {
                      questions: Record<string, unknown>;
                      inputRef: string;
                      phase: 0 | 1 | 2;
                    }) => {
                      await repos.traces.create({
                        kind: 'jev',
                        inputRef: p.inputRef,
                        phase: p.phase,
                        latencyMs: 0,
                        costMicro: 0,
                        output: { synthetic: true },
                      });
                      return {
                        ok: true,
                        answers: Object.fromEntries(
                          Object.keys(p.questions).map((key) => [key, { type: 'noul', noul: 0 }]),
                        ),
                      };
                    },
                  },
                  evaluateOutbound: async (
                    _client: unknown,
                    p: Parameters<PipelineDeps['evaluateOutbound']>[1],
                  ) => {
                    await repos.traces.create({
                      kind: 'jev',
                      inputRef: p.inputRef,
                      phase: p.phase,
                      latencyMs: 0,
                      costMicro: 0,
                      output: { synthetic: true },
                    });
                    return { ok: true, worthReplying: 3, mentionsUnverified: 0, languageOk: 1 };
                  },
                  marketSearch: {
                    find: () => {
                      searches++;
                      if (action.source === 'unavailable')
                        return Promise.reject(new Error('synthetic source unavailable'));
                      return Promise.resolve({ items: [], hasNext: false, total: 0 });
                    },
                    detail: () =>
                      Promise.reject(new Error('no source detail in this structural contract')),
                  },
                  publishApproval: () =>
                    Promise.reject(new Error('unexpected approval under accepted synthetic gate')),
                  cards: { opsChatId: '-999', defaultPhase: 2 },
                } as never,
                {
                  channel: 'telegram',
                  userId: user.externalId,
                  chatId,
                  messageId: String(index + 1),
                  text: turn.input,
                  receivedAt: new Date().toISOString(),
                  addressedToBot: true,
                  ...(replyTo ? { replyToMessageId: replyTo } : {}),
                },
              );
              await processor.forceFlush();
              if (captured.ctx?.task && action.alias && !aliases.has(action.alias))
                aliases.set(action.alias, {
                  id: captured.ctx.task.id,
                  access: { userId: user.id, scope: { channel: 'telegram', chatId } },
                });
              await drainOutbound({
                repos,
                logger,
                defaultPhase: 2,
                sender: {
                  send: async (row, options) =>
                    !(await options.beforeSend())
                      ? { kind: 'not_started' }
                      : row.kind === 'reaction'
                        ? { kind: 'reaction', externalMessageId: null }
                        : { kind: 'message', externalMessageId: String(++receiptId) },
                },
              });
              const rows = captured.ctx ? await store.outbounds(captured.ctx.sourceMessageId) : [],
                sent = rows.find((row) => row.status === 'sent' && row.externalMessageId),
                after = await snapshots();
              if (action.question && sent?.externalMessageId)
                replies.set(action.question.alias, sent.externalMessageId);
              const alias = action.alias ? aliases.get(action.alias) : null,
                task = alias ? await repos.tasks.findById(alias) : (captured.ctx?.task ?? null);
              const privateIds = before
                .filter((old) => old.scope.chatId !== chatId)
                .map((old) => old.id);
              expect(
                privateIds.filter((id) => inputs.some((input) => input.includes(id))),
                sample.id + ': model received unrelated private task',
              ).toEqual([]);
              const issues = gradeTaskTurn(turn.expect, {
                task,
                before,
                after,
                replyText: rows
                  .filter((row) => row.status === 'sent')
                  .map((row) => row.text)
                  .join('\n'),
                ...(action.replyTo ? { replyAlias: action.replyTo } : {}),
                ...(captured.ctx?.taskUpdate ? { updateKind: captured.ctx.taskUpdate.kind } : {}),
                searches,
                owner,
                scope,
              });
              expect(issues, sample.id + ' turn ' + index + ': ' + turn.input).toEqual([]);
            }
          } finally {
            await processor.forceFlush();
          }
        }),
      30000,
    );
  },
);
