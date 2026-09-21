-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('telegram', 'whatsapp');

-- CreateEnum
CREATE TYPE "DemandCategory" AS ENUM ('man_and_van', 'eot_cleaning', 'furniture_service', 'housing', 'job', 'second_hand', 'other');

-- CreateEnum
CREATE TYPE "DemandStatus" AS ENUM ('open', 'clarifying', 'matched', 'closed', 'expired');

-- CreateEnum
CREATE TYPE "SupplierPool" AS ENUM ('A', 'B');

-- CreateEnum
CREATE TYPE "OutboundStatus" AS ENUM ('dry_run', 'pending', 'sent', 'failed');

-- CreateEnum
CREATE TYPE "RunStateStatus" AS ENUM ('pending', 'consumed', 'expired');

-- CreateEnum
CREATE TYPE "TraceKind" AS ENUM ('rule', 'jev', 'agent_run', 'gate');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_id" TEXT NOT NULL,
    "languages" TEXT[],
    "home_postcode" TEXT,
    "profile" JSONB NOT NULL DEFAULT '{}',
    "last_seen_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "groups" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "external_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phase" INTEGER NOT NULL DEFAULT 0,
    "categories_enabled" TEXT[],
    "admin_contact" TEXT,
    "rate_limit_per_day" INTEGER NOT NULL DEFAULT 3,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" TEXT NOT NULL,
    "group_id" TEXT,
    "user_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "text_hash" TEXT NOT NULL,
    "lang" TEXT,
    "received_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "demands" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "category" "DemandCategory" NOT NULL,
    "status" "DemandStatus" NOT NULL DEFAULT 'open',
    "when_text" TEXT,
    "when_at" TIMESTAMPTZ,
    "from_postcode" TEXT,
    "to_postcode" TEXT,
    "quantity" TEXT,
    "budget_pence" INTEGER,
    "lang" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL,
    "is_move_event" BOOLEAN NOT NULL DEFAULT false,
    "source_message_ids" TEXT[],
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "demands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplies" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "category" "DemandCategory" NOT NULL,
    "availability" TEXT,
    "area" TEXT,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "source_message_id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppliers" (
    "id" TEXT NOT NULL,
    "category" "DemandCategory" NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "whatsapp" TEXT,
    "telegram" TEXT,
    "website" TEXT,
    "service_area" TEXT[],
    "base_postcode" TEXT,
    "price_type" TEXT,
    "rough_price" TEXT,
    "is_same_day" BOOLEAN NOT NULL DEFAULT false,
    "is_weekend" BOOLEAN NOT NULL DEFAULT false,
    "languages" TEXT[],
    "rating" DOUBLE PRECISION,
    "review_count" INTEGER,
    "source" TEXT,
    "source_url" TEXT,
    "pool" "SupplierPool" NOT NULL DEFAULT 'B',
    "last_verified_at" TIMESTAMPTZ,
    "is_contacted" BOOLEAN NOT NULL DEFAULT false,
    "is_willing_to_receive_leads" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "demand_id" TEXT NOT NULL,
    "supplier_id" TEXT,
    "supply_id" TEXT,
    "matcher_score" DOUBLE PRECISION NOT NULL,
    "jev_fit" DOUBLE PRECISION,
    "rank" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "sent_via" "Channel" NOT NULL,
    "sent_at" TIMESTAMPTZ NOT NULL,
    "supplier_response" TEXT,
    "is_converted" BOOLEAN NOT NULL DEFAULT false,
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "followed_up_at" TIMESTAMPTZ,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_items" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "item" JSONB NOT NULL,
    "operation_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_states" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "chat_id" TEXT NOT NULL,
    "phase" INTEGER NOT NULL,
    "snapshot" TEXT NOT NULL,
    "agent_version" TEXT NOT NULL,
    "sdk_version" TEXT NOT NULL,
    "status" "RunStateStatus" NOT NULL DEFAULT 'pending',
    "interruptions" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMPTZ,

    CONSTRAINT "run_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approvals" (
    "id" TEXT NOT NULL,
    "run_state_id" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "edited_text" TEXT,
    "decided_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbound_messages" (
    "id" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "target" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "status" "OutboundStatus" NOT NULL DEFAULT 'pending',
    "tool_call_id" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMPTZ,

    CONSTRAINT "outbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decision_traces" (
    "id" TEXT NOT NULL,
    "kind" "TraceKind" NOT NULL,
    "input_ref" TEXT NOT NULL,
    "output" JSONB NOT NULL,
    "phase" INTEGER NOT NULL,
    "latency_ms" INTEGER NOT NULL,
    "cost_micro" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decision_traces_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_channel_external_id_key" ON "users"("channel", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "groups_channel_external_id_key" ON "groups"("channel", "external_id");

-- CreateIndex
CREATE INDEX "messages_user_id_received_at_idx" ON "messages"("user_id", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_group_id_external_id_key" ON "messages"("group_id", "external_id");

-- CreateIndex
CREATE INDEX "demands_user_id_status_idx" ON "demands"("user_id", "status");

-- CreateIndex
CREATE INDEX "supplies_category_expires_at_idx" ON "supplies"("category", "expires_at");

-- CreateIndex
CREATE INDEX "suppliers_category_pool_idx" ON "suppliers"("category", "pool");

-- CreateIndex
CREATE INDEX "matches_demand_id_rank_idx" ON "matches"("demand_id", "rank");

-- CreateIndex
CREATE INDEX "session_items_user_id_operation_id_idx" ON "session_items"("user_id", "operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "session_items_user_id_seq_key" ON "session_items"("user_id", "seq");

-- CreateIndex
CREATE INDEX "run_states_status_expires_at_idx" ON "run_states"("status", "expires_at");

-- CreateIndex
CREATE INDEX "outbound_messages_status_created_at_idx" ON "outbound_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "decision_traces_kind_created_at_idx" ON "decision_traces"("kind", "created_at");

-- CreateIndex
CREATE INDEX "decision_traces_input_ref_idx" ON "decision_traces"("input_ref");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "demands" ADD CONSTRAINT "demands_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplies" ADD CONSTRAINT "supplies_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplies" ADD CONSTRAINT "supplies_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_demand_id_fkey" FOREIGN KEY ("demand_id") REFERENCES "demands"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_supply_id_fkey" FOREIGN KEY ("supply_id") REFERENCES "supplies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_items" ADD CONSTRAINT "session_items_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_states" ADD CONSTRAINT "run_states_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approvals" ADD CONSTRAINT "approvals_run_state_id_fkey" FOREIGN KEY ("run_state_id") REFERENCES "run_states"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
