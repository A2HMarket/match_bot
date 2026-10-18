export function shouldStopActorLab(
  limits: {
    maxMessages: number;
    maxSeconds: number;
    tokenBudget: number;
    minRemainingTokens?: number;
  },
  state: { sent: number; elapsedMs: number; tokens: number; stopped: boolean },
): string | null {
  if (state.stopped) return 'stopped';
  if (state.sent >= limits.maxMessages) return 'message_budget';
  if (state.elapsedMs >= limits.maxSeconds * 1000) return 'time_budget';
  if (state.tokens >= limits.tokenBudget) return 'token_budget';
  if (limits.tokenBudget - state.tokens < (limits.minRemainingTokens ?? 0)) return 'token_reserve';
  return null;
}
export function actorRoute(
  row: { target: string; toolCallId: string | null },
  groupId: string,
  runId: string,
  actors: readonly string[],
): string {
  const parts = row.toolCallId?.split(':');
  if (
    row.target !== groupId ||
    parts?.length !== 4 ||
    parts[0] !== 'actor' ||
    parts[2] !== runId ||
    !parts[1] ||
    !actors.includes(parts[1]) ||
    !/^\d+$/.test(parts[3] ?? '')
  )
    throw new Error('actor_route_rejected');
  return parts[1];
}

type ObservedReply = {
  messageId: string | null;
  text: string;
  observation: 'telegram_update' | 'sent_outbound';
};

export class ActorLabInbox {
  private sent = new Map<string, string>();
  private seen = new Set<string>();
  private bySent = new Map<string, ObservedReply>();
  private replies = new Map<string, ObservedReply>();
  constructor(
    private groupId: string,
    private matchBotId: string,
    private startedAt: Date,
  ) {}
  registerSent(messageId: string, actorId: string): void {
    this.sent.set(`${actorId}:${messageId}`, actorId);
  }
  accept(
    message: {
      chatId: string;
      userId: string;
      messageId: string;
      replyToMessageId?: string | undefined;
      text: string;
      receivedAt: string;
    },
    receiverActorId: string,
  ): string | null {
    if (
      message.chatId !== this.groupId ||
      message.userId !== this.matchBotId ||
      Date.parse(message.receivedAt) < Math.floor(this.startedAt.getTime() / 1000) * 1000 ||
      this.seen.has(`${receiverActorId}:${message.messageId}`)
    )
      return null;
    const actor = message.replyToMessageId
      ? this.sent.get(`${receiverActorId}:${message.replyToMessageId}`)
      : undefined;
    if (!actor) return null;
    if (this.bySent.has(`${actor}:${message.replyToMessageId!}`)) return null;
    this.seen.add(`${receiverActorId}:${message.messageId}`);
    const reply: ObservedReply = {
      messageId: message.messageId,
      text: message.text.slice(0, 1800),
      observation: 'telegram_update',
    };
    this.bySent.set(`${actor}:${message.replyToMessageId!}`, reply);
    this.replies.set(actor, reply);
    return actor;
  }
  acceptDelivered(p: {
    actorId: string;
    originalMessageId: string;
    outboundId: string;
    text: string;
  }): boolean {
    const key = `${p.actorId}:${p.originalMessageId}`;
    if (
      this.sent.get(key) !== p.actorId ||
      this.bySent.has(key) ||
      this.seen.has('outbox:' + p.outboundId)
    )
      return false;
    const reply: ObservedReply = {
      messageId: null,
      text: p.text.slice(0, 1800),
      observation: 'sent_outbound',
    };
    this.bySent.set(key, reply);
    this.replies.set(p.actorId, reply);
    this.seen.add('outbox:' + p.outboundId);
    return true;
  }
  forMessage(messageId: string, actorId: string) {
    return this.bySent.get(`${actorId}:${messageId}`);
  }
  latest(actorId: string) {
    return this.replies.get(actorId);
  }
}

export function splitActorTurn(
  text: string,
  isShortFollowup: boolean,
  remaining: number,
): string[] {
  if (!isShortFollowup || remaining < 2) return [text];
  const at = text.search(/[，；]/);
  if (at < 3 || text.length - at - 1 < 3) return [text];
  return [text.slice(0, at).trim(), text.slice(at + 1).trim()];
}
