-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_LearnedPhrase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phrase" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "note" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "sourceReportId" TEXT,
    "matchCount" INTEGER NOT NULL DEFAULT 0,
    "confirmedCount" INTEGER NOT NULL DEFAULT 0,
    "lastMatchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vectorJson" TEXT,
    "vectorModel" TEXT,
    "phoneticEligible" BOOLEAN NOT NULL DEFAULT false,
    "capExempt" BOOLEAN NOT NULL DEFAULT false,
    "graduatedAt" DATETIME
);
INSERT INTO "new_LearnedPhrase" ("active", "category", "confirmedCount", "createdAt", "createdBy", "graduatedAt", "id", "lastMatchedAt", "matchCount", "normalized", "note", "phoneticEligible", "phrase", "sourceReportId", "vectorJson", "vectorModel") SELECT "active", "category", "confirmedCount", "createdAt", "createdBy", "graduatedAt", "id", "lastMatchedAt", "matchCount", "normalized", "note", "phoneticEligible", "phrase", "sourceReportId", "vectorJson", "vectorModel" FROM "LearnedPhrase";
DROP TABLE "LearnedPhrase";
ALTER TABLE "new_LearnedPhrase" RENAME TO "LearnedPhrase";
CREATE INDEX "LearnedPhrase_active_idx" ON "LearnedPhrase"("active");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
