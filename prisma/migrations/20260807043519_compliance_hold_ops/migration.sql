-- AlterTable
ALTER TABLE "ComplianceReview" ADD COLUMN "escalatedAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "researcherId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priceKrw" INTEGER NOT NULL,
    "prepaymentRatio" INTEGER NOT NULL DEFAULT 0,
    "feeRateBp" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "rejectionCount" INTEGER NOT NULL DEFAULT 0,
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_researcherId_fkey" FOREIGN KEY ("researcherId") REFERENCES "ResearcherProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Report" ("content", "createdAt", "feeRateBp", "id", "prepaymentRatio", "priceKrw", "publishedAt", "researcherId", "status", "summary", "title") SELECT "content", "createdAt", "feeRateBp", "id", "prepaymentRatio", "priceKrw", "publishedAt", "researcherId", "status", "summary", "title" FROM "Report";
DROP TABLE "Report";
ALTER TABLE "new_Report" RENAME TO "Report";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
