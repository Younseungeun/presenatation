-- AlterTable
ALTER TABLE "Purchase" ADD COLUMN "priceGate" TEXT;

-- AlterTable
ALTER TABLE "RefundAttempt" ADD COLUMN "bankReference" TEXT;

-- RedefineTables
-- PaymentIntent.reportId(단수) → itemsJson(목록 스냅샷).
-- 기존 행은 1건짜리 목록으로 옮긴다 — 의미가 같고 데이터를 버리지 않는다.
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PaymentIntent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "itemsJson" TEXT NOT NULL,
    "amountKrw" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PaymentIntent_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_PaymentIntent" ("amountKrw", "buyerId", "createdAt", "id", "orderId", "status", "itemsJson")
SELECT "amountKrw", "buyerId", "createdAt", "id", "orderId", "status",
       '[{"reportId":"' || "reportId" || '","priceKrw":' || "amountKrw" || '}]'
FROM "PaymentIntent";
DROP TABLE "PaymentIntent";
ALTER TABLE "new_PaymentIntent" RENAME TO "PaymentIntent";
CREATE UNIQUE INDEX "PaymentIntent_orderId_key" ON "PaymentIntent"("orderId");
CREATE INDEX "PaymentIntent_buyerId_idx" ON "PaymentIntent"("buyerId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "RefundAttempt_settlementId_bankReference_key" ON "RefundAttempt"("settlementId", "bankReference");
