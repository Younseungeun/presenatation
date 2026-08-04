-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Purchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "amountKrw" INTEGER NOT NULL,
    "paymentMethod" TEXT NOT NULL DEFAULT 'CARD',
    "paymentInfo" TEXT,
    "escrowStatus" TEXT NOT NULL DEFAULT 'HELD',
    "paidAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Purchase_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Purchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Purchase" ("amountKrw", "buyerId", "escrowStatus", "id", "paidAt", "reportId") SELECT "amountKrw", "buyerId", "escrowStatus", "id", "paidAt", "reportId" FROM "Purchase";
DROP TABLE "Purchase";
ALTER TABLE "new_Purchase" RENAME TO "Purchase";
CREATE UNIQUE INDEX "Purchase_reportId_buyerId_key" ON "Purchase"("reportId", "buyerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
