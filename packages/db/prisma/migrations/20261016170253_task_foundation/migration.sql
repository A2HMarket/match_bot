-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('active', 'waiting_user', 'waiting_source', 'waiting_delivery', 'delivered', 'completed', 'cancelled', 'expired');

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "chat_id" TEXT NOT NULL,
    "source_message_id" TEXT NOT NULL,
    "intent_key" TEXT NOT NULL,
    "origin_hash" TEXT NOT NULL,
    "category" "DemandCategory" NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'active',
    "revision" INTEGER NOT NULL DEFAULT 0,
    "requirements_version" INTEGER NOT NULL DEFAULT 0,
    "state" JSONB NOT NULL,
    "last_user_activity_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" TEXT NOT NULL,
    "task_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL,
    "operation_key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor_kind" TEXT NOT NULL,
    "source_message_id" TEXT,
    "checkpoint" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_user_id_channel_chat_id_status_idx" ON "tasks"("user_id", "channel", "chat_id", "status");

-- CreateIndex
CREATE INDEX "tasks_last_user_activity_at_idx" ON "tasks"("last_user_activity_at");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_user_id_channel_chat_id_source_message_id_intent_key_key" ON "tasks"("user_id", "channel", "chat_id", "source_message_id", "intent_key");

-- CreateIndex
CREATE UNIQUE INDEX "task_events_task_id_revision_key" ON "task_events"("task_id", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "task_events_task_id_operation_key_key" ON "task_events"("task_id", "operation_key");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
