-- AlterTable
ALTER TABLE "Settlement" ADD COLUMN "payoutExecutedAt" DATETIME;
ALTER TABLE "Settlement" ADD COLUMN "payoutExecutedBy" TEXT;
ALTER TABLE "Settlement" ADD COLUMN "refundExecutedAt" DATETIME;
ALTER TABLE "Settlement" ADD COLUMN "refundExecutedBy" TEXT;
ALTER TABLE "Settlement" ADD COLUMN "refundMethod" TEXT;
