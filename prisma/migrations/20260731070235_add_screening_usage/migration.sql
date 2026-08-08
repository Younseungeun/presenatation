-- AlterTable
ALTER TABLE "ComplianceReview" ADD COLUMN "deliberationRatio" REAL;
ALTER TABLE "ComplianceReview" ADD COLUMN "inputTokens" INTEGER;
ALTER TABLE "ComplianceReview" ADD COLUMN "outputTokens" INTEGER;
