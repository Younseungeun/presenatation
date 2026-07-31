-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Instrument" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetClass" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'KRW',
    "shortable" BOOLEAN NOT NULL DEFAULT false,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "riskLevel" TEXT NOT NULL DEFAULT 'NONE',
    "riskNote" TEXT,
    "riskSyncedAt" DATETIME,
    "delistingRisk" BOOLEAN NOT NULL DEFAULT false,
    "marketCap" REAL,
    "source" TEXT NOT NULL,
    "syncedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Instrument" ("active", "assetClass", "currency", "id", "name", "riskLevel", "riskNote", "riskSyncedAt", "shortable", "source", "syncedAt", "ticker") SELECT "active", "assetClass", "currency", "id", "name", "riskLevel", "riskNote", "riskSyncedAt", "shortable", "source", "syncedAt", "ticker" FROM "Instrument";
DROP TABLE "Instrument";
ALTER TABLE "new_Instrument" RENAME TO "Instrument";
CREATE INDEX "Instrument_assetClass_name_idx" ON "Instrument"("assetClass", "name");
CREATE UNIQUE INDEX "Instrument_assetClass_ticker_key" ON "Instrument"("assetClass", "ticker");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
