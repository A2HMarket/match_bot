-- AlterTable
ALTER TABLE "approvals" ADD COLUMN     "resume_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "resume_error" TEXT,
ADD COLUMN     "resume_fence" INTEGER,
ADD COLUMN     "resume_queued_at" TIMESTAMPTZ,
ADD COLUMN     "resume_status" "ExecutionStatus";

-- CreateIndex
CREATE INDEX "approvals_resume_status_resume_queued_at_idx" ON "approvals"("resume_status", "resume_queued_at");

