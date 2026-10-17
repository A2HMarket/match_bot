-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "OutboundStatus" ADD VALUE 'sending';
ALTER TYPE "OutboundStatus" ADD VALUE 'delivery_unknown';

-- AlterTable
ALTER TABLE "outbound_messages" ADD COLUMN     "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "attempt_started_at" TIMESTAMPTZ,
ADD COLUMN     "external_message_id" TEXT,
ADD COLUMN     "lease_expires_at" TIMESTAMPTZ,
ADD COLUMN     "lease_token" TEXT,
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ,
ADD COLUMN     "phase" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "outbound_messages_status_lease_expires_at_idx" ON "outbound_messages"("status", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_channel_target_external_message_id_key" ON "outbound_messages"("channel", "target", "external_message_id");
