-- CreateTable
CREATE TABLE "CompensationInstruction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseId" TEXT NOT NULL,
    "predictionCardId" TEXT NOT NULL,
    "researcherUserId" TEXT NOT NULL,
    "amountKrw" INTEGER NOT NULL,
    "cause" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "executedAt" DATETIME,
    "executedBy" TEXT,
    "bankReference" TEXT,
    CONSTRAINT "CompensationInstruction_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_JudgmentDispute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "judgmentId" TEXT,
    "actorRole" TEXT NOT NULL DEFAULT 'PURCHASER',
    "purchaseId" TEXT,
    "buyerId" TEXT,
    "researcherId" TEXT,
    "category" TEXT NOT NULL,
    "observed" TEXT,
    "claimedPrice" REAL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JudgmentDispute_judgmentId_fkey" FOREIGN KEY ("judgmentId") REFERENCES "Judgment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "JudgmentDispute_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_JudgmentDispute" ("actorRole", "buyerId", "category", "claimedPrice", "createdAt", "id", "judgmentId", "observed", "purchaseId", "researcherId", "resolution", "resolvedAt", "resolvedBy", "status") SELECT "actorRole", "buyerId", "category", "claimedPrice", "createdAt", "id", "judgmentId", "observed", "purchaseId", "researcherId", "resolution", "resolvedAt", "resolvedBy", "status" FROM "JudgmentDispute";
DROP TABLE "JudgmentDispute";
ALTER TABLE "new_JudgmentDispute" RENAME TO "JudgmentDispute";
CREATE UNIQUE INDEX "JudgmentDispute_purchaseId_key" ON "JudgmentDispute"("purchaseId");
CREATE INDEX "JudgmentDispute_status_idx" ON "JudgmentDispute"("status");
CREATE INDEX "JudgmentDispute_judgmentId_idx" ON "JudgmentDispute"("judgmentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CompensationInstruction_purchaseId_key" ON "CompensationInstruction"("purchaseId");

-- CreateIndex
CREATE INDEX "CompensationInstruction_status_createdAt_idx" ON "CompensationInstruction"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CompensationInstruction_predictionCardId_idx" ON "CompensationInstruction"("predictionCardId");
