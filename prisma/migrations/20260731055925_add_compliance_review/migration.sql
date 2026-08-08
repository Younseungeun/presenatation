-- CreateTable
CREATE TABLE "ComplianceReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "reviewer" TEXT NOT NULL,
    "findingsJson" TEXT NOT NULL,
    "needsOperatorReview" BOOLEAN NOT NULL DEFAULT false,
    "operatorReviewedAt" DATETIME,
    "operatorReviewedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ComplianceReview_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ComplianceReview_reportId_idx" ON "ComplianceReview"("reportId");

-- CreateIndex
CREATE INDEX "ComplianceReview_needsOperatorReview_operatorReviewedAt_idx" ON "ComplianceReview"("needsOperatorReview", "operatorReviewedAt");
