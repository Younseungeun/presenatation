-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PredictionCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "assetClass" TEXT NOT NULL DEFAULT 'KR_EQUITY',
    "ticker" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "assetName" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetValue" REAL NOT NULL,
    "basePrice" REAL,
    "deadline" DATETIME NOT NULL,
    "confidence" INTEGER,
    "withdrawnAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PredictionCard_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PredictionCard" ("assetClass", "assetName", "basePrice", "confidence", "createdAt", "currency", "deadline", "direction", "id", "reportId", "targetType", "targetValue", "ticker", "withdrawnAt") SELECT "assetClass", "assetName", "basePrice", "confidence", "createdAt", "currency", "deadline", "direction", "id", "reportId", "targetType", "targetValue", "ticker", "withdrawnAt" FROM "PredictionCard";
DROP TABLE "PredictionCard";
ALTER TABLE "new_PredictionCard" RENAME TO "PredictionCard";
CREATE UNIQUE INDEX "PredictionCard_reportId_key" ON "PredictionCard"("reportId");
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
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_researcherId_fkey" FOREIGN KEY ("researcherId") REFERENCES "ResearcherProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Report" ("content", "createdAt", "feeRateBp", "id", "prepaymentRatio", "priceKrw", "publishedAt", "researcherId", "status", "summary", "title") SELECT "content", "createdAt", "feeRateBp", "id", "prepaymentRatio", "priceKrw", "publishedAt", "researcherId", "status", "summary", "title" FROM "Report";
DROP TABLE "Report";
ALTER TABLE "new_Report" RENAME TO "Report";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
