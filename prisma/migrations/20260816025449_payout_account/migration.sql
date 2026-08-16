-- CreateTable
CREATE TABLE "PayoutAccount" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "researcherUserId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "holderName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" DATETIME,
    "changedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "PayoutAccountHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "researcherUserId" TEXT NOT NULL,
    "bankCode" TEXT NOT NULL,
    "accountNumberEnc" TEXT NOT NULL,
    "accountLast4" TEXT NOT NULL,
    "holderName" TEXT,
    "status" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "recordedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "PayoutAccount_researcherUserId_key" ON "PayoutAccount"("researcherUserId");

-- CreateIndex
CREATE INDEX "PayoutAccountHistory_researcherUserId_recordedAt_idx" ON "PayoutAccountHistory"("researcherUserId", "recordedAt");
