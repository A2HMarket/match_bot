/** Telegram Update -> InboundMessage；OutboundMessage -> sendMessage。群配置读取。 */
export { toInboundMessage } from './inbound.js';
export { createTelegramSender, TelegramSendError } from './sender.js';
export {
  createOpsCardSender,
  parseApprovalCallback,
  renderApprovalCard,
  type ApprovalCard,
  type Decision,
} from './ops-card.js';
