-- CreateEnum
CREATE TYPE "OutboundKind" AS ENUM ('recommendation', 'clarification', 'notification', 'lead');

-- AlterTable
ALTER TABLE "outbound_messages" ADD COLUMN     "kind" "OutboundKind" NOT NULL DEFAULT 'recommendation';

-- CreateIndex
CREATE INDEX "outbound_messages_target_kind_sent_at_idx" ON "outbound_messages"("target", "kind", "sent_at");
