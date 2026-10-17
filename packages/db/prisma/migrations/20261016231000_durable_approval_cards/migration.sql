-- AlterTable
ALTER TABLE "outbound_messages" ADD COLUMN     "approval_run_state_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "outbound_messages_approval_run_state_id_key" ON "outbound_messages"("approval_run_state_id");

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_approval_run_state_id_fkey" FOREIGN KEY ("approval_run_state_id") REFERENCES "run_states"("id") ON DELETE SET NULL ON UPDATE CASCADE;

