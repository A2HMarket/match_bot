-- AlterTable
ALTER TABLE "demands" ADD COLUMN     "task_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "demands_task_id_key" ON "demands"("task_id");

-- AddForeignKey
ALTER TABLE "demands" ADD CONSTRAINT "demands_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

