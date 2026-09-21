# V5 grammY 收群消息

## 结论

**待人工步骤。**

已验证的部分（脚本侧全通）：

- `TELEGRAM_BOT_TOKEN` 可用，`getMe` 成功，Bot = `@london_match_bot`（id `8919809920`）。
- 未设置 webhook（`getWebhookInfo.url = ""`，`pending_update_count = 0`），长轮询可用。
- grammY 1.46.0 + tsx 能正常启动长轮询、注册 `message:text` / `message` / `my_chat_member` 处理器、并在超时后 `bot.stop()` 干净退出。

**未验证的部分：** 至今**没有收到任何真实群消息**，因此 `chat.id` / `from.id` / `language_code` 等字段的实际取值**尚未观测到**，本文件不做臆测。

当前 privacy 标志（来自真实 `getMe`）：

- `can_join_groups: true`
- `can_read_all_group_messages: **false**` ← privacy mode **仍处于开启状态**，此状态下 Bot 只能收到 @ 它的消息、`/命令` 和对它的回复，收不到群里的普通文本。

剩余人工步骤（必须由人完成，agent 无法代劳）：

1. 在 Telegram 里打开 **@BotFather** → 发送 `/setprivacy` → 选择 **`@london_match_bot`** → 点 **Disable**。
   （成功后 BotFather 会回 "Success! The new status is: DISABLED. ..."）
2. **把 Bot 重新加入测试群**（privacy 设置只对「设置之后加入的群」生效；如果 Bot 已在群里，需要先移除再重新加入，或把它设为群管理员——管理员同样能收全量消息）。
3. 用**另一个账号**在该群里发一条**不 @ Bot、不是命令**的普通文本，例如：`周日有人有 van 吗，E14 搬到 SE1，大概 8 个箱子`。
4. 回到仓库跑：
   ```bash
   cd /Users/huanghaibin/Workspace/match_bot && set -a && . ./.env && set +a && \
     POC_V5_TIMEOUT_MS=90000 ./node_modules/.bin/tsx scripts/poc/v5-telegram-groups/main.ts
   ```
   （脚本 90 秒自动停止；注意**不要**同时跑 `getUpdates`，会 409 Conflict。）
5. 终端出现 `MESSAGE_TEXT {...}` 即通过，把该 JSON 贴回本文件「## 证据」。

验收判据：`MESSAGE_TEXT` 中 `chatType` 为 `group`/`supergroup`、`mentionsBot` 为 `false`、`chatIdIsNegative` 为 `true`。

## 证据

### getMe（token 已打码）

```
GET /bot<REDACTED>/getMe
{"ok":true,"result":{"id":8919809920,"is_bot":true,"first_name":"London Match Bot",
"username":"london_match_bot","can_join_groups":true,"can_read_all_group_messages":false,
"supports_inline_queries":false,"supports_guest_queries":false,"can_connect_to_business":false,
"has_main_web_app":false,"has_topics_enabled":false,"allows_users_to_create_topics":false,
"can_manage_bots":false,"supports_join_request_queries":false}}
```

### getWebhookInfo

```
{"ok":true,"result":{"url":"","has_custom_certificate":false,"pending_update_count":0}}
```

### getUpdates（`timeout=0&limit=100`，未传 offset，不消费任何 update）

```
{"ok":true,"result":[]}
```

队列为空 —— 此前没有任何群消息到达过（与 privacy mode 开启、且 Bot 可能尚未入群一致）。

### 长轮询试跑（60s 有界运行）

```
GET_ME {"id":8919809920,"username":"london_match_bot","canJoinGroups":true,"canReadAllGroupMessages":false}
WARN privacy mode 仍开启（can_read_all_group_messages=false）：...
listening (long polling); post messages in a test group and observe
STARTED {"username":"london_match_bot","id":8919809920}
STOP 已监听 60000ms，自动停止
DONE polling stopped
```

无 `UPDATE_SEEN` / `MESSAGE_TEXT` / `MY_CHAT_MEMBER` 输出 —— 期间没有任何 update（人工步骤未做）。

### 捕获到的消息 JSON

**（空 —— 待人工步骤完成后补录。不填任何未观测到的字段值。）**

## 对 P8 的影响（实为 P7 `packages/channel-telegram` / P10 `apps/bot`）

以下第 1 条来自本次真实观测，第 2–6 条标注了来源（Bot API 文档 / grammY 类型），**未经本次真实群消息验证**，P7 落地时应以脚本跑出的第一条真实消息为准复核。

1. **【已观测】运维前置条件是硬门槛。** `can_read_all_group_messages` 目前是 `false`。`packages/channel-telegram` 必须在启动时调用 `getMe` 并断言该标志为 `true`，否则打醒目 WARN（或直接拒绝启动）——否则 Bot 在群里静默收不到消息，且没有任何报错，是最容易踩的坑。同时要在部署文档里写明：**privacy 设置只对之后加入的群生效，改完必须重新入群或设为管理员**。
2. **【文档】群 `chat.id` 为负数，用户 `from.id` 为正数**（supergroup 形如 `-100…`）。`channel-telegram` 不应依赖符号做类型判断，应以 `chat.type ∈ {group, supergroup}` 判群、`private` 判私聊。脚本里已埋 `chatIdIsNegative` 字段，真实消息一到即可确认。
3. **【契约，AGENTS.md §4.1】Telegram 的 id 是 int64，必须以 string 落库。** JS `number` 在 2^53 以上丢精度（用户 id 已在向 10 位以上增长，supergroup 的 `-100…` id 已到 13–14 位）。边界处一律 `String(chat.id)` / `String(from.id)` / `String(message_id)`，Prisma 侧对应 `externalId String` + 渠道字段，**禁止**在 domain 层出现 `number` 型 Telegram id。
4. **字段 → `InboundMessage` 映射建议：**
   | Telegram                                       | InboundMessage                                                                                       |
   | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
   | `message.chat.id` → string                     | `chatExternalId`（配 `channel: 'telegram'`）                                                         |
   | `message.chat.type`                            | 区分群/私聊，决定是否进撮合流程                                                                      |
   | `message.chat.title`                           | 群名，仅群聊有（`private` 无此字段），用于日志/运营                                                  |
   | `message.message_id` → string                  | `externalId`（注意：**仅在同一 chat 内唯一**，唯一键必须是 `(channel, chatExternalId, externalId)`） |
   | `message.from.id` → string                     | `senderExternalId`                                                                                   |
   | `message.from.language_code`                   | `lang`                                                                                               |
   | `message.date`（秒）                           | `receivedAt = new Date(date * 1000)`，UTC                                                            |
   | `message.reply_to_message.message_id` → string | `replyToExternalId`，用于会话串联                                                                    |
   | `message.text`                                 | `text`                                                                                               |
5. **【文档】`language_code` 不可靠。** Bot API 里 `User.language_code` 是 optional，用户未在客户端设置语言时不会下发；且它是客户端界面语言（如 `zh-hans`、`en`、`ru`），**不等于消息正文语种**。因此 `lang` 字段必须可空，且**不能**作为 LLM 语种判定的唯一依据——正文语种应由 agent 从文本判断，`language_code` 只作为弱先验/回复语言默认值。
6. **收 update 的类型要显式声明。** grammY 默认的 `allowed_updates` 不含 `my_chat_member`，`apps/bot` 若想感知「被拉进群/被踢出群/被提管理员」，必须像本脚本一样显式传 `allowed_updates: ['message', 'edited_message', 'my_chat_member', 'chat_member']`（`chat_member` 还额外要求 Bot 是管理员）。另外长轮询与 `getUpdates` 互斥（409 Conflict），本地调试与线上实例不能同时跑。

---

## 补充：人工步骤完成后的实跑结果（2026-09-21，协调者执行）

上文的"待人工步骤"已解除。人工在 BotFather 关闭 privacy mode 并新建群、把 bot 拉入、发了一条不 @ bot 的中文消息后，45s 有界监听实收该消息。**结论修正为「通过」。**

```
GET_ME {"id":8919809920,"username":"london_match_bot","canJoinGroups":true,"canReadAllGroupMessages":true}
MY_CHAT_MEMBER {"chatType":"group","chatId":-5522461480,"chatTitle":"london happy life","oldStatus":"left","newStatus":"member","actorId":8804415352}
MESSAGE_NON_TEXT {"chatType":"group","chatId":-5522461480,"messageId":3,"keys":["message_id","from","chat","date","group_chat_created"]}
MESSAGE_TEXT {"updateId":184620030,"chatType":"group","chatId":-5522461480,"chatIdIsNegative":true,"chatIdAsString":"-5522461480","chatTitle":"london happy life","messageId":4,"date":1789981600,"fromId":8804415352,"fromIsBot":false,"hasLang":false,"entityTypes":[],"mentionsBot":false,"textLength":31,"text":"周日有人有 van 吗，E14 搬到 SE1，大概 8 个箱子"}
RAW_UPDATE {"update_id":184620030,"message":{"message_id":4,"from":{"id":8804415352,"is_bot":false,"first_name":"karas"},"chat":{"id":-5522461480,"title":"london happy life","type":"group","all_members_are_administrators":false},"date":1789981600,"text":"周日有人有 van 吗，E14 搬到 SE1，大概 8 个箱子"}}
```

### 由推断转为实测的四点

1. `can_read_all_group_messages` 由 `false` 变 `true`，且**新建群**后才收得到消息 —— 证实"privacy 设置只对之后加入的群生效"。
2. `chat.id = -5522461480`（负）、`from.id = 8804415352`（正），**两者都超出 32 位有符号整数范围** —— AGENTS.md §4.1 要求 Telegram int64 存字符串是必需的，不是保守做法。
3. **`language_code` 实测缺失**（`hasLang: false`、`from` 只有 `id`/`is_bot`/`first_name`）。该消息是中文却拿不到任何语言信息 —— `lang` 必须可空，语种必须由文本推断，`language_code` 只能当弱先验。原文档推断"可选且不可靠"在第一条真实消息上即被证实。
4. 建群会自动产生 `group_chat_created` 服务消息（本次 `messageId` 1/2/3 全为非文本）。`channel-telegram` 必须在规范化前过滤服务消息，否则会被当成用户输入送进 agent —— 这一点原报告未覆盖。
