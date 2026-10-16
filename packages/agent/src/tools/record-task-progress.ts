import { assessTaskReadiness, recordTaskProgress, TaskTransitionError } from '@matchbot/domain';
import { tool, type RunContext } from '@openai/agents';
import type { AgentDeps, MatchContext } from '../context.js';
import {
  buildTaskProgress,
  buildTaskSourceReview,
  taskProgressParameters,
  TaskEvidenceError,
} from '../task-source-evidence.js';
import { evaluateSourceSupport } from '@matchbot/jev';
import { hashText } from '@matchbot/shared';

/** Source/plan ledger only; sending still uses the original outbound tool and gates. */
export function recordTaskProgressTool(deps: AgentDeps) {
  return tool({
    name: 'record_task_progress',
    description:
      'Record verified source evidence and a responsible next step for the selected task. Use known goal/criterion IDs and source refs. Each criterion describes the best coherent option: every source you attach must support that SAME status and option; do not include rejected alternatives as supporting evidence. Use exact quotes; quote=null only for a returned computed budget/area/route/date fact. Never combine different offers into one matching option, treat public listing status as a guarantee, or mark the user goal complete. Choose research, one necessary ask_user, wait_source only after a real failure, or deliver an honest partial/full answer with unknowns. This sends nothing.',
    parameters: taskProgressParameters,
    needsApproval: false,
    errorFunction: async (rc) => {
      const ctx = rc.context as MatchContext;
      ctx.taskProgressCalls = (ctx.taskProgressCalls ?? 0) + 1;
      await trace(deps, ctx, 'invalid_schema');
      return 'invalid task progress: use the small checks/next schema and known IDs; unknown checks use sources=[]';
    },
    execute: async (args, rc, details) => {
      const ctx = (rc as RunContext<MatchContext>).context;
      ctx.taskProgressCalls = (ctx.taskProgressCalls ?? 0) + 1;
      if (ctx.taskProgressCalls > 4) {
        await trace(deps, ctx, 'budget_exhausted');
        return 'task progress budget exhausted; provide the best honest partial answer or request status';
      }
      if (ctx.outboundBlocked) {
        await trace(deps, ctx, 'outbound_declined');
        return 'not allowed: outbound already declined';
      }
      try {
        const progress = buildTaskProgress({ ctx, ...args });
        const rejected = await reviewSources(deps, ctx, args.checks);
        const rejectedCriteria: string[] = [];
        for (const [index, sourceIndexes] of rejected) {
          const check = progress.checks[index];
          if (check) {
            check.evidenceRefs = [
              ...new Set(check.evidenceRefs.filter((_, i) => !sourceIndexes.has(i))),
            ];
            if (!check.evidenceRefs.length) {
              check.status = 'unknown';
              rejectedCriteria.push(check.criterionId);
            }
          }
        }
        progress.checks = mergeChecks(ctx, progress);
        progress.coherence = await reviewCoherence(deps, ctx, progress);
        if (ctx.runDeadlineAt !== undefined && Date.now() >= ctx.runDeadlineAt) {
          await trace(deps, ctx, 'deadline');
          return 'research deadline reached; do not continue or save obsolete work';
        }
        const current = ctx.task!;
        recordTaskProgress({ task: current, ...progress });
        const result = await deps.repos.tasks.recordProgress({
          access: {
            userId: ctx.userId,
            scope: { channel: ctx.channel ?? 'telegram', chatId: ctx.chatId },
          },
          id: current.id,
          expectedRevision: current.revision,
          sourceMessageId: ctx.sourceMessageId,
          operationKey:
            'progress:' +
            (details?.toolCall?.callId ?? ctx.sourceMessageId + ':' + ctx.taskProgressCalls),
          progress,
        });
        if (result.kind !== 'applied' && result.kind !== 'replayed') {
          await trace(deps, ctx, 'version_conflict');
          return 'task changed while researching; do not overwrite or answer using obsolete conditions';
        }
        ctx.task = result.task;
        ctx.taskProgressVersion = result.task.requirementsVersion;
        await trace(deps, ctx, 'recorded');
        return JSON.stringify({
          recorded: true,
          rejectedCriteria,
          rejectedSourceCount: [...rejected.values()].reduce((sum, s) => sum + s.size, 0),
          readiness: assessTaskReadiness(result.task),
          next: result.task.nextStep,
          checks: progress.checks.map((c) => ({
            goalId: c.goalId,
            criterionId: c.criterionId,
            status: c.status,
          })),
        });
      } catch (error) {
        await trace(
          deps,
          ctx,
          error instanceof TaskEvidenceError || error instanceof TaskTransitionError
            ? error.message
            : error instanceof Error
              ? error.name
              : 'unknown_error',
        );
        return error instanceof TaskEvidenceError || error instanceof TaskTransitionError
          ? 'task progress rejected: ' + error.message
          : 'task progress could not be saved; stop and explain the current processing gap';
      }
    },
  });
}
async function reviewCoherence(
  deps: AgentDeps,
  ctx: MatchContext,
  progress: ReturnType<typeof buildTaskProgress>,
) {
  const proposed = recordTaskProgress({ task: ctx.task!, ...progress });
  const goals = proposed.goals.filter((goal) => !goal.userConfirmation);
  const result: Array<{ goalId: string; status: 'unknown' | 'supported' }> = goals.map((goal) => ({
    goalId: goal.id,
    status: 'unknown',
  }));
  const ready = goals.filter((goal) => {
    const hard = goal.criteria.filter((c) => c.strength === 'hard');
    return hard.length && hard.every((c) => c.status === 'supported');
  });
  if (!ready.length) return result;
  const facts = proposed.goals.map((goal) => ({
    goal: goal.title,
    required: goal.required,
    checks: goal.criteria.map((c) => ({
      criterion: c.label,
      strength: c.strength,
      status: c.status,
      sources: c.evidenceRefs
        .map((id) => proposed.evidence.find((e) => e.id === id))
        .filter((e) => !!e)
        .map((e) => ({ source: e.sourceRef, entity: e.entityKey, text: e.summary, url: e.url })),
      refutations: (c.conflictingEvidenceRefs ?? [])
        .map((id) => proposed.evidence.find((e) => e.id === id))
        .filter((e) => !!e)
        .map((e) => ({ source: e.sourceRef, entity: e.entityKey, text: e.summary })),
    })),
  }));
  const sourceText = JSON.stringify(facts);
  if (sourceText.length > 6000) return result;
  const cacheKey =
    'coherence:' +
    hashText(
      JSON.stringify([
        proposed.requirementsVersion,
        ctx.currentRequest?.text ?? proposed.objective,
        sourceText,
      ]),
    );
  ctx.sourceReviewCache ??= {};
  if (ctx.sourceReviewCache[cacheKey] !== undefined) {
    for (const row of result)
      if (ctx.sourceReviewCache[cacheKey + ':' + row.goalId]) row.status = 'supported';
    return result;
  }
  const claims = ready.map((goal) => ({
    goalId: goal.id,
    criterionId: '__source_coherence',
    goal: goal.title,
    requirement:
      'All hard information criteria must be coherent for the goal and compatible with overall task conditions.',
    proposedStatus: 'supported' as const,
    sourceId: 'validated_facts',
    quote: goal.title,
  }));
  const response = await evaluateSourceSupport(deps.jev, {
    taskContext:
      'Current date (Europe/London): ' +
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()) +
      '\n' +
      (ctx.currentRequest?.text ?? proposed.objective),
    claims,
    sources: [{ id: 'validated_facts', text: sourceText }],
    inputRef: ctx.sourceMessageId,
    phase: ctx.phase,
    ...(ctx.runDeadlineAt !== undefined ? { deadlineAt: ctx.runDeadlineAt } : {}),
  });
  if (response.ok) {
    for (const [index, goal] of ready.entries())
      if ((response.scores[index] ?? 0) >= deps.thresholds.T_SOURCE_SUPPORT_ACCEPT)
        result.find((r) => r.goalId === goal.id)!.status = 'supported';
  } else {
    ctx.sourceFailures ??= [];
    ctx.sourceFailures.push('processing:jev_coherence_' + response.reason);
  }
  // Only cache collective success/failure when it applies to this same eligible goal set.
  // Per-goal verdicts are retained below, so a partial pass never upgrades the other goals.
  for (const row of result)
    ctx.sourceReviewCache[cacheKey + ':' + row.goalId] = row.status === 'supported';
  ctx.sourceReviewCache[cacheKey] = true;
  return result;
}
function mergeChecks(ctx: MatchContext, progress: ReturnType<typeof buildTaskProgress>) {
  const groups = new Map<string, typeof progress.checks>();
  for (const check of progress.checks) {
    const key = JSON.stringify([check.goalId, check.criterionId]);
    const group = groups.get(key) ?? [];
    group.push(check);
    groups.set(key, group);
  }
  const evidence = [...(ctx.task?.evidence ?? []), ...progress.evidence];
  return [...groups.values()].map((group) => {
    const supported = group.filter((c) => c.status === 'supported' && c.evidenceRefs.length);
    const conflicting = group.filter((c) => c.status === 'conflict' && c.evidenceRefs.length);
    const positive = [...new Set(supported.flatMap((c) => c.evidenceRefs))];
    const positiveSources = new Set(
      positive.map((id) => evidence.find((e) => e.id === id)?.sourceRef),
    );
    const inherited = group
      .flatMap((c) => c.conflictingEvidenceRefs ?? [])
      .filter((id) => !positiveSources.has(evidence.find((e) => e.id === id)?.sourceRef));
    const negative = [...new Set([...inherited, ...conflicting.flatMap((c) => c.evidenceRefs)])];
    const refs = positive.length
      ? positive
      : conflicting.length
        ? [...new Set(conflicting.flatMap((c) => c.evidenceRefs))]
        : [...new Set(group.flatMap((c) => c.evidenceRefs))];
    return {
      ...group[0]!,
      status: positive.length
        ? ('supported' as const)
        : conflicting.length
          ? ('conflict' as const)
          : ('unknown' as const),
      evidenceRefs: refs,
      conflictingEvidenceRefs: negative,
    };
  });
}
async function reviewSources(
  deps: AgentDeps,
  ctx: MatchContext,
  checks: Parameters<typeof buildTaskSourceReview>[1],
): Promise<Map<number, Set<number>>> {
  const review = buildTaskSourceReview(ctx, checks);
  const rejected = new Map<number, Set<number>>();
  ctx.sourceReviewCache ??= {};
  const pending = review.claims.map((claim, index) => ({
    claim,
    index,
    key: hashText(
      JSON.stringify([
        ctx.task?.requirementsVersion,
        claim,
        review.sources.find((s) => s.id === claim.sourceId)?.text,
      ]),
    ),
  }));
  for (let offset = 0; offset < pending.length; offset += 24) {
    const batch = pending
      .slice(offset, offset + 24)
      .filter((item) => ctx.sourceReviewCache![item.key] === undefined);
    if (batch.length) {
      const response = await evaluateSourceSupport(deps.jev, {
        taskContext:
          'Current date (Europe/London): ' +
          new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date()) +
          '\n' +
          (ctx.currentRequest?.text ?? ctx.task!.objective),
        claims: batch.map((item) => item.claim),
        sources: review.sources.filter((s) => batch.some((item) => item.claim.sourceId === s.id)),
        inputRef: ctx.sourceMessageId,
        phase: ctx.phase,
        ...(ctx.runDeadlineAt !== undefined ? { deadlineAt: ctx.runDeadlineAt } : {}),
      });
      if (!response.ok) {
        ctx.sourceFailures ??= [];
        ctx.sourceFailures.push('processing:jev_source_' + response.reason);
      }
      for (const [index, item] of batch.entries())
        ctx.sourceReviewCache[item.key] =
          response.ok && (response.scores[index] ?? 0) >= deps.thresholds.T_SOURCE_SUPPORT_ACCEPT;
    }
  }
  for (const item of pending)
    if (!ctx.sourceReviewCache[item.key]) {
      const checkIndex = review.indexes[item.index]!,
        sources = rejected.get(checkIndex) ?? new Set<number>();
      sources.add(review.sourceIndexes[item.index]!);
      rejected.set(checkIndex, sources);
    }
  return rejected;
}
async function trace(deps: AgentDeps, ctx: MatchContext, result: string) {
  await deps.repos.traces.create({
    kind: 'gate',
    inputRef: ctx.sourceMessageId,
    phase: ctx.phase,
    latencyMs: 0,
    costMicro: 0,
    output: {
      gate: 'task_source_progress',
      result,
      taskId: ctx.task?.id ?? null,
      requirementsVersion: ctx.task?.requirementsVersion ?? null,
      attempt: ctx.taskProgressCalls ?? 0,
    },
  });
}
