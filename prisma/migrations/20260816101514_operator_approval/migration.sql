-- CreateTable
CREATE TABLE "OperatorApproval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "action" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "amountKrw" INTEGER,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedBy" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "executedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "OperatorApproval_status_requestedAt_idx" ON "OperatorApproval"("status", "requestedAt");

-- CreateIndex
CREATE INDEX "OperatorApproval_action_targetId_idx" ON "OperatorApproval"("action", "targetId");
