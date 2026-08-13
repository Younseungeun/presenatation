-- AlterTable
ALTER TABLE "PredictionCard" ADD COLUMN "deferCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "PredictionCard" ADD COLUMN "nextAttemptAt" DATETIME;
