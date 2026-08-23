-- AlterTable
ALTER TABLE "ComplianceReview" ADD COLUMN "studentAbsence" TEXT;

-- AlterTable
ALTER TABLE "LearnedPhrase" ADD COLUMN "graduatedAt" DATETIME;

-- AlterTable
ALTER TABLE "RegressionCase" ADD COLUMN "quarantineReason" TEXT;
ALTER TABLE "RegressionCase" ADD COLUMN "quarantinedAt" DATETIME;
ALTER TABLE "RegressionCase" ADD COLUMN "quarantinedBy" TEXT;

-- CreateTable
CREATE TABLE "GraduationWatchHit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phraseId" TEXT NOT NULL,
    "complianceReviewId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "studentFlagged" BOOLEAN NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "GraduationWatchHit_phraseId_createdAt_idx" ON "GraduationWatchHit"("phraseId", "createdAt");
