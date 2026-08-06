-- AlterTable
ALTER TABLE "ComplianceReview" ADD COLUMN "aiFindingsValid" BOOLEAN;
ALTER TABLE "ComplianceReview" ADD COLUMN "operatorCategories" TEXT;
ALTER TABLE "ComplianceReview" ADD COLUMN "operatorReason" TEXT;
ALTER TABLE "ComplianceReview" ADD COLUMN "operatorVerdict" TEXT;
