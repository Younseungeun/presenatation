-- CreateTable
CREATE TABLE "ShadowComplianceReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "complianceReviewId" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "findingsJson" TEXT NOT NULL,
    "latencyMs" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ShadowComplianceReview_complianceReviewId_fkey" FOREIGN KEY ("complianceReviewId") REFERENCES "ComplianceReview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ShadowComplianceReview_complianceReviewId_idx" ON "ShadowComplianceReview"("complianceReviewId");

-- CreateIndex
CREATE INDEX "ShadowComplianceReview_reviewer_createdAt_idx" ON "ShadowComplianceReview"("reviewer", "createdAt");
