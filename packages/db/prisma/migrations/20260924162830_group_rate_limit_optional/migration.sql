-- AlterTable
ALTER TABLE "groups" ALTER COLUMN "rate_limit_per_day" DROP NOT NULL,
ALTER COLUMN "rate_limit_per_day" DROP DEFAULT;

-- 2026-09-25：去掉默认每天 3 次的推荐额度。现有群一律改为不限。
UPDATE "groups" SET "rate_limit_per_day" = NULL;
