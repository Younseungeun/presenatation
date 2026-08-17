-- CreateTable
CREATE TABLE "RecoveryUse" (
    "nonce" TEXT NOT NULL PRIMARY KEY,
    "usedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "targetUserId" TEXT NOT NULL,
    "note" TEXT
);
