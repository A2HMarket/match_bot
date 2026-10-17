-- CreateEnum
CREATE TYPE "ExecutionStatus" AS ENUM ('accepted', 'running', 'waiting_approval', 'completed', 'failed');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "execution_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "execution_error" TEXT,
ADD COLUMN     "execution_fence" INTEGER,
ADD COLUMN     "execution_key" TEXT,
ADD COLUMN     "execution_phase" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "execution_queued_at" TIMESTAMPTZ,
ADD COLUMN     "execution_snapshot" TEXT,
ADD COLUMN     "execution_status" "ExecutionStatus",
ADD COLUMN     "is_addressed_to_bot" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reply_to_bot_text" TEXT,
ADD COLUMN     "reply_to_message_id" TEXT,
ADD COLUMN     "task_id" TEXT,
ADD COLUMN     "task_requirements_version" INTEGER;

-- AlterTable
ALTER TABLE "outbound_messages" ADD COLUMN     "request_key" TEXT,
ADD COLUMN     "source_message_id" TEXT;

-- AlterTable
ALTER TABLE "run_states" ADD COLUMN     "message_id" TEXT;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "execution_fence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "execution_lease_expires_at" TIMESTAMPTZ,
ADD COLUMN     "execution_lease_token" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "messages_execution_key_key" ON "messages"("execution_key");

-- CreateIndex
CREATE INDEX "messages_user_id_execution_status_received_at_idx" ON "messages"("user_id", "execution_status", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_request_key_key" ON "outbound_messages"("request_key");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_states" ADD CONSTRAINT "run_states_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
