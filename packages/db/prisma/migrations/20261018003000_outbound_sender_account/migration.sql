-- Keep the replacement receipt constraint atomic for active single-bot writers.
BEGIN;

-- DropIndex
DROP INDEX "outbound_messages_channel_target_external_message_id_key";

-- AlterTable
ALTER TABLE "outbound_messages" ADD COLUMN     "sender_account_id" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_channel_sender_account_id_target_external_key" ON "outbound_messages"("channel", "sender_account_id", "target", "external_message_id");

COMMIT;
