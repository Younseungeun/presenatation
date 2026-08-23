-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RegressionCase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phraseId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "expectViolation" BOOLEAN NOT NULL,
    "category" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "quarantinedAt" DATETIME,
    "quarantinedBy" TEXT,
    "quarantineReason" TEXT,
    "lastGateFailAt" DATETIME,
    "lastGateFailSha" TEXT,
    "gateFailCount" INTEGER NOT NULL DEFAULT 0
);
INSERT INTO "new_RegressionCase" ("category", "createdAt", "createdBy", "expectViolation", "id", "phraseId", "quarantineReason", "quarantinedAt", "quarantinedBy", "text") SELECT "category", "createdAt", "createdBy", "expectViolation", "id", "phraseId", "quarantineReason", "quarantinedAt", "quarantinedBy", "text" FROM "RegressionCase";
DROP TABLE "RegressionCase";
ALTER TABLE "new_RegressionCase" RENAME TO "RegressionCase";
CREATE INDEX "RegressionCase_phraseId_idx" ON "RegressionCase"("phraseId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
