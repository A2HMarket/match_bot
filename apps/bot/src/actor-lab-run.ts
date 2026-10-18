import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { setTimeout as pause } from 'node:timers/promises';
import { generateSimulatedUserTurn, queueSimulatedUserTurn } from '@matchbot/agent';
import { ActorLabInbox, shouldStopActorLab, splitActorTurn } from './actor-lab-state.js';
import {
  observeActorMessage,
  observeActorMessages,
  type ActorLabRuntime,
} from './actor-lab-runtime.js';

export async function runActorLab(runtime: ActorLabRuntime, dryRun = false) {
  const { cfg } = runtime,
    started = Date.now(),
    since = new Date(started),
    runId = randomUUID();
  const lockPath = '.env.actor-lab.lock';
  const lock = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lock, String(process.pid));
  const inbox = new ActorLabInbox(cfg.groupId, cfg.matchBotId, since),
    sent: Array<{ actorId: string; externalMessageId: string; text: string; sentAt: Date }> = [],
    history: Array<{ actorId: string; speaker: 'self' | 'match_bot'; text: string }> = [],
    modelRefs: string[] = [],
    events: unknown[] = [];
  let stopped = false,
    reason = 'finished',
    tokens = 0,
    dispatched = 0;
  const done = new Set<string>();
  const stop = () => {
    stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const deadline = setTimeout(stop, cfg.maxSeconds * 1000);
  let polling: Promise<void>[] = [];
  const path = `logs/actor-lab/${runId}.json`;
  async function usage() {
    const messages = await observeActorMessages(runtime.mainRepos, {
      groupId: cfg.groupId,
      actorIds: cfg.actors.map((a) => a.id),
      since,
    });
    const ids = messages.map((m) => m.id);
    const [actor, target] = await Promise.all([
      runtime.repos.traces.summarizeUsage({ since, inputRefs: modelRefs }),
      runtime.mainRepos.traces.summarizeUsage({ since, inputRefs: ids }),
    ]);
    if (actor.missingUsageCalls || target.missingUsageCalls) throw new Error('actor_usage_missing');
    tokens = actor.inputTokens + actor.outputTokens + target.inputTokens + target.outputTokens;
    return { actor, target, tokens };
  }
  async function waitForReply(actorId: string, lastMessageId: string, turn: number) {
    const waitStarted = Date.now();
    let observation = 'timeout';
    while (!stopped && Date.now() - waitStarted < cfg.replyWaitSeconds * 1000) {
      const latest = inbox.forMessage(lastMessageId, actorId);
      if (latest) {
        observation = 'replied';
        break;
      }
      const message = await observeActorMessage(runtime.mainRepos, {
        groupId: cfg.groupId,
        actorId,
        text: sent.findLast((s) => s.actorId === actorId && s.externalMessageId === lastMessageId)!
          .text,
        sentAt: sent.findLast(
          (s) => s.actorId === actorId && s.externalMessageId === lastMessageId,
        )!.sentAt,
      });
      if (message?.executionStatus === 'failed') {
        observation = 'processing_failed';
        break;
      }
      if (message?.executionStatus === 'completed' && Date.now() - waitStarted > 8000) {
        observation = 'completed_without_text';
        done.add(actorId);
        break;
      }
      await pause(500);
    }
    events.push({ turn, actorId, observation });
  }
  function writeReport(used: Awaited<ReturnType<typeof usage>> | null, errorKind?: string) {
    mkdirSync('logs/actor-lab', { recursive: true, mode: 0o700 });
    writeFileSync(
      path,
      JSON.stringify(
        {
          runId,
          startedAt: since.toISOString(),
          mode: dryRun ? 'dry_run' : 'live',
          reason,
          limits: { messages: cfg.maxMessages, seconds: cfg.maxSeconds, tokens: cfg.tokenBudget },
          usage: used,
          ...(errorKind ? { errorKind } : {}),
          events,
          history,
          deliveries: sent,
          boundary:
            'synthetic test participants only; sender receipts and matched pipeline observations, not a human satisfaction score; in-flight calls can exceed observed token budget',
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  }
  try {
    if (!dryRun) {
      await runtime.verify();
      await runtime.assertActive();
      if (await runtime.repos.outbound.countUnfinished()) throw new Error('actor_outbox_not_idle');
      polling = runtime.startInbox(
        inbox,
        (actorId, text) => history.push({ actorId, speaker: 'match_bot', text }),
        stop,
      );
    }
    steps: for (let turn = 0; turn < cfg.maxMessages; turn++) {
      await runtime.processor.forceFlush();
      if (!dryRun) await usage();
      const bound = shouldStopActorLab(cfg, {
        sent: dispatched,
        elapsedMs: Date.now() - started,
        tokens,
        stopped,
      });
      if (bound) {
        reason = bound;
        break;
      }
      const actor = cfg.actors[turn % cfg.actors.length]!;
      if (done.has(actor.id)) continue;
      if (!dryRun && turn >= cfg.actors.length) {
        const prior = sent.filter((s) => s.actorId === actor.id).at(-1);
        if (prior && !inbox.forMessage(prior.externalMessageId, actor.id))
          await waitForReply(actor.id, prior.externalMessageId, turn);
        if (stopped || done.has(actor.id)) continue;
        await usage();
        const afterWait = shouldStopActorLab(cfg, {
          sent: dispatched,
          elapsedMs: Date.now() - started,
          tokens,
          stopped,
        });
        if (afterWait) {
          reason = afterWait;
          break;
        }
      }
      const previous = inbox.latest(actor.id);
      let text = actor.firstMessage;
      if (turn >= cfg.actors.length) {
        if (!previous) {
          done.add(actor.id);
          continue;
        }
        const inputRef = `actor-model:${actor.id}:${runId}:${turn}`;
        modelRefs.push(inputRef);
        const proposal = await generateSimulatedUserTurn(runtime.deps, {
          actorId: actor.id,
          inputRef,
          goal: actor.goal,
          style: actor.style,
          phase: dryRun ? 0 : 2,
          history: history.slice(-10).map((h) => ({
            speaker: h.actorId === actor.id ? h.speaker : 'other_actor',
            text: h.text.slice(0, 1800),
          })),
        });
        if (proposal.done) {
          done.add(actor.id);
          continue;
        }
        text = proposal.text;
      }
      await runtime.processor.forceFlush();
      if (!dryRun) await usage();
      const afterGeneration = shouldStopActorLab(cfg, {
        sent: dispatched,
        elapsedMs: Date.now() - started,
        tokens,
        stopped,
      });
      if (afterGeneration) {
        reason = afterGeneration;
        break;
      }
      const parts = splitActorTurn(
        text,
        actor.role === 'short' && turn >= cfg.actors.length,
        cfg.maxMessages - dispatched,
      );
      let lastMessageId: string | undefined;
      for (const [partIndex, part] of parts.entries()) {
        const beforeSend = shouldStopActorLab(cfg, {
          sent: dispatched,
          elapsedMs: Date.now() - started,
          tokens,
          stopped,
        });
        if (beforeSend) {
          reason = beforeSend;
          break steps;
        }
        const result = await queueSimulatedUserTurn(runtime.deps, {
          actorId: actor.id,
          runId,
          turn: dispatched++,
          groupId: cfg.groupId,
          goal: actor.goal,
          text: part,
          phase: dryRun ? 0 : 2,
          replyToMessageId: partIndex === 0 ? (previous?.messageId ?? null) : null,
        });
        events.push({ turn, actorId: actor.id, kind: result.kind });
        if (result.kind !== (dryRun ? 'dry_run' : 'queued')) {
          reason = 'outbound_not_authorized';
          break steps;
        }
        if (dryRun) continue;
        await runtime.drain(runId, () => !stopped && Date.now() - started < cfg.maxSeconds * 1000);
        const row = await runtime.repos.outbound.findByToolCallId(result.callId);
        if (row?.status !== 'sent' || !row.externalMessageId || !row.sentAt) {
          reason = 'delivery_unconfirmed';
          break steps;
        }
        lastMessageId = row.externalMessageId;
        sent.push({
          actorId: actor.id,
          externalMessageId: row.externalMessageId,
          text: part,
          sentAt: row.sentAt,
        });
        inbox.registerSent(row.externalMessageId, actor.id);
        history.push({ actorId: actor.id, speaker: 'self', text: part });
      }
      if (dryRun || !lastMessageId) continue;
      if (turn >= cfg.actors.length) await waitForReply(actor.id, lastMessageId, turn);
    }
    if (stopped) reason = 'stopped';
    await runtime.processor.forceFlush();
    const used = dryRun ? null : await usage();
    writeReport(used);
    return { runId, reason, sent: sent.length, report: path };
  } catch (error) {
    reason = 'controller_error';
    writeReport(null, error instanceof Error ? error.name : 'unknown_error');
    throw error;
  } finally {
    clearTimeout(deadline);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await runtime.close();
    await Promise.allSettled(polling);
    closeSync(lock);
    unlinkSync(lockPath);
  }
}
