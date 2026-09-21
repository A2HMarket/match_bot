import type { createTelegramSender } from '@matchbot/channel-telegram';
import type { Repositories } from '@matchbot/db';
import type { Logger } from '@matchbot/shared';

/** 消费 outbound_messages 中 status=pending 的行；dry_run 永远不会是 pending（AGENTS.md §3.3 第 4 条）。 */
export async function drainOutbound(p: {
  repos: Repositories;
  sender: ReturnType<typeof createTelegramSender>;
  logger: Logger;
}): Promise<void> {
  for (const m of await p.repos.outbound.claimPending(20)) {
    try {
      await p.sender.send(m);
      await p.repos.outbound.markSent(m.id);
    } catch (e) {
      await p.repos.outbound.markFailed(m.id, e instanceof Error ? e.message : String(e));
      p.logger.error({ outboundMessageId: m.id }, 'send failed');
    }
  }
}

export function startOutboundLoop(
  p: Parameters<typeof drainOutbound>[0] & { intervalMs?: number },
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void drainOutbound(p).finally(() => {
      running = false;
    });
  }, p.intervalMs ?? 2000);
  return () => clearInterval(timer);
}
