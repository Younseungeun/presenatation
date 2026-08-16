-- AlterTable
ALTER TABLE "PayoutAccount" ADD COLUMN "frozenAt" DATETIME;
ALTER TABLE "PayoutAccount" ADD COLUMN "frozenBy" TEXT;
