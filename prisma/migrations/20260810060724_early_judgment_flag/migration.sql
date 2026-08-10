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
    "baseMode" TEXT NOT NULL DEFAULT 'FIXED_AT_PUBLISH',
    "basePrice" REAL,
    "deadline" DATETIME NOT NULL,
    "confidence" INTEGER NOT NULL DEFAULT 5,
    "selfStability" INTEGER NOT NULL DEFAULT 1,
    "earlyJudgment" BOOLEAN NOT NULL DEFAULT false,
    "withdrawnAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PredictionCard_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PredictionCard" ("assetClass", "assetName", "baseMode", "basePrice", "confidence", "createdAt", "currency", "deadline", "direction", "id", "reportId", "selfStability", "targetType", "targetValue", "ticker", "withdrawnAt") SELECT "assetClass", "assetName", "baseMode", "basePrice", "confidence", "createdAt", "currency", "deadline", "direction", "id", "reportId", "selfStability", "targetType", "targetValue", "ticker", "withdrawnAt" FROM "PredictionCard";
DROP TABLE "PredictionCard";
ALTER TABLE "new_PredictionCard" RENAME TO "PredictionCard";
CREATE UNIQUE INDEX "PredictionCard_reportId_key" ON "PredictionCard"("reportId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
