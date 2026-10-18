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

export class ActorLabInbox {
  private sent = new Map<string, string>();
  private seen = new Set<string>();
  private bySent = new Map<string, { messageId: string; text: string }>();
  private replies = new Map<string, { messageId: string; text: string }>();
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
    this.seen.add(`${receiverActorId}:${message.messageId}`);
    const reply = { messageId: message.messageId, text: message.text.slice(0, 1800) };
    this.bySent.set(`${actor}:${message.replyToMessageId!}`, reply);
    this.replies.set(actor, reply);
    return actor;
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
