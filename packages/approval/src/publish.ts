import type { createOpsCardSender } from '@matchbot/channel-telegram';
import type { Repositories, RunState } from '@matchbot/db';
import { z } from 'zod';

const interruptionSchema = z.object({ tool: z.string(), args: z.string() });
const replyArgsSchema = z.object({
  text: z.string(),
  supplierIds: z.array(z.string()).default([]),
});

/** 把中断快照渲染成运营群审批卡（架构 §4.3，Phase 1 审批台即运营群）。 */
export async function publishApproval(p: {
  repos: Repositories;
  cards: ReturnType<typeof createOpsCardSender>;
  runState: RunState;
}): Promise<void> {
  const interruptions = z.array(interruptionSchema).parse(p.runState.interruptions);
  const first = interruptions[0];
  if (!first) return;
  const args = replyArgsSchema.safeParse(JSON.parse(first.args));
  const text = args.success ? args.data.text : first.args;
  const ids = args.success ? args.data.supplierIds : [];
  const suppliers = ids.length ? await p.repos.suppliers.findByIds(ids) : [];
  const byId = new Map(suppliers.map((s) => [s.id, s]));
  const supplierLines = ids.map((id, i) => {
    const s = byId.get(id);
    return s
      ? `${i + 1}. ${s.name}${s.roughPrice ? ` ${s.roughPrice}` : ''} (${s.pool})`
      : `${i + 1}. ${id} (unknown)`;
  });
  const demand = (await p.repos.demands.findOpenByUser(p.runState.userId))[0];
  await p.cards.sendApprovalCard({
    runStateId: p.runState.id,
    title: `${first.tool} · ${demand?.category ?? 'unknown'}`,
    draftText: text,
    supplierLines,
    confidence: demand?.confidence ?? 0,
  });
}
