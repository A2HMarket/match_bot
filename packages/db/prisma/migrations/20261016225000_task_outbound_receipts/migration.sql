-- AlterTable
ALTER TABLE "outbound_messages" ADD COLUMN     "task_id" TEXT,
ADD COLUMN     "task_requirements_version" INTEGER;

-- AddForeignKey
ALTER TABLE "outbound_messages" ADD CONSTRAINT "outbound_messages_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

