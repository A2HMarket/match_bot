// scripts/poc/v5-telegram-groups/main.ts
//
// V5: 验证 Bot 在关闭 privacy mode（或成为群管理员）后，grammY 长轮询能否收到
// 群内「不 @ Bot」的普通文本，并记录 update.message 各字段的真实取值。
//
// 运行（务必带时限，长轮询不会自己退出）：
//   set -a && . ./.env && set +a && \
//   POC_V5_TIMEOUT_MS=90000 pnpm exec tsx scripts/poc/v5-telegram-groups/main.ts
//
// 人工前置步骤见同目录 RESULT.md。

import { Bot } from 'grammy';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

// 默认 90s 自动停止，避免无限阻塞；传 0 表示不自动停止（仅人工交互时使用）。
const timeoutMs = Number(process.env.POC_V5_TIMEOUT_MS ?? '90000');

const bot = new Bot(token);

function log(kind: string, payload: unknown): void {
  console.log(`${kind} ${JSON.stringify(payload)}`);
}

// 0) 兜底：先记录每一条 update 的类型，确保「收到但没被具体 handler 命中」也可见
bot.use(async (ctx, next) => {
  const keys = Object.keys(ctx.update).filter((k) => k !== 'update_id');
  log('UPDATE_SEEN', { updateId: ctx.update.update_id, keys });
  await next();
});

// 1) 目标事件：任何聊天里的文本消息（group / supergroup / private / channel 都记录）
bot.on('message:text', (ctx) => {
  const m = ctx.message;
  log('MESSAGE_TEXT', {
    updateId: ctx.update.update_id,
    chatType: m.chat.type,
    chatId: m.chat.id,
    chatIdIsNegative: m.chat.id < 0,
    chatIdAsString: String(m.chat.id),
    chatTitle: 'title' in m.chat ? m.chat.title : undefined,
    messageId: m.message_id,
    messageThreadId: m.message_thread_id,
    date: m.date,
    fromId: m.from?.id,
    fromIsBot: m.from?.is_bot,
    fromUsername: m.from?.username,
    lang: m.from?.language_code,
    hasLang: m.from?.language_code !== undefined,
    entityTypes: (m.entities ?? []).map((e) => e.type),
    mentionsBot: (m.entities ?? []).some((e) => e.type === 'mention' || e.type === 'text_mention'),
    replyToMessageId: m.reply_to_message?.message_id,
    replyToFromId: m.reply_to_message?.from?.id,
    textLength: m.text.length,
    text: m.text.slice(0, 120),
  });
  // 完整 update，作为 PoC 证据留底
  log('RAW_UPDATE', ctx.update);
});

// 2) 非文本消息也记一笔，便于分辨「收到了但不是 text」与「根本没收到」
bot.on('message', (ctx) => {
  if ('text' in ctx.message) return;
  log('MESSAGE_NON_TEXT', {
    updateId: ctx.update.update_id,
    chatType: ctx.message.chat.type,
    chatId: ctx.message.chat.id,
    messageId: ctx.message.message_id,
    keys: Object.keys(ctx.message),
  });
});

// 3) Bot 被拉进群 / 权限变化，验证「已加入哪个群」
bot.on('my_chat_member', (ctx) => {
  const u = ctx.myChatMember;
  log('MY_CHAT_MEMBER', {
    chatType: u.chat.type,
    chatId: u.chat.id,
    chatTitle: 'title' in u.chat ? u.chat.title : undefined,
    oldStatus: u.old_chat_member.status,
    newStatus: u.new_chat_member.status,
    actorId: u.from.id,
  });
});

bot.catch((err) => {
  // 注意：grammY 的错误里可能含带 token 的 URL，这里只打印 message 概要
  console.error('BOT_ERROR', String(err.message ?? err).replace(token!, '<REDACTED>'));
});

const me = await bot.api.getMe();
log('GET_ME', {
  id: me.id,
  username: me.username,
  canJoinGroups: me.can_join_groups,
  canReadAllGroupMessages: me.can_read_all_group_messages,
});
if (!me.can_read_all_group_messages) {
  console.warn(
    'WARN privacy mode 仍开启（can_read_all_group_messages=false）：' +
      '只有 @' +
      me.username +
      ' 的消息、/命令、回复 Bot 的消息才会送达。' +
      '请在 BotFather 执行 /setprivacy -> Disable，然后把 Bot 重新加入群。',
  );
}

if (timeoutMs > 0) {
  const timer = setTimeout(() => {
    console.log(`STOP 已监听 ${timeoutMs}ms，自动停止`);
    void bot.stop();
  }, timeoutMs);
  timer.unref?.();
}

console.log('listening (long polling); post messages in a test group and observe');
await bot.start({
  allowed_updates: ['message', 'edited_message', 'my_chat_member', 'chat_member'],
  onStart: (info) => log('STARTED', { username: info.username, id: info.id }),
});
console.log('DONE polling stopped');
