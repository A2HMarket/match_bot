-- AlterTable
ALTER TABLE "outbound_messages" ADD COLUMN     "mention_user_id" TEXT,
ADD COLUMN     "reply_to_message_id" TEXT;
