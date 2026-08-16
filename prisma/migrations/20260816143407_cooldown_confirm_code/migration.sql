-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PayoutAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "researcherUserId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "holderName" TEXT,
    "verifiedNameEnc" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" DATETIME,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cooldownUntil" DATETIME,
    "cooldownCode" TEXT,
    "cooldownCodeAttempts" INTEGER NOT NULL DEFAULT 0,
    "frozenAt" DATETIME,
    "frozenBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_PayoutAccount" ("accountLast4", "accountNumberEnc", "bankCode", "changedAt", "cooldownUntil", "createdAt", "frozenAt", "frozenBy", "holderName", "id", "researcherUserId", "status", "verifiedAt", "verifiedNameEnc") SELECT "accountLast4", "accountNumberEnc", "bankCode", "changedAt", "cooldownUntil", "createdAt", "frozenAt", "frozenBy", "holderName", "id", "researcherUserId", "status", "verifiedAt", "verifiedNameEnc" FROM "PayoutAccount";
DROP TABLE "PayoutAccount";
ALTER TABLE "new_PayoutAccount" RENAME TO "PayoutAccount";
CREATE UNIQUE INDEX "PayoutAccount_researcherUserId_key" ON "PayoutAccount"("researcherUserId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
