-- 마켓 규모 스냅샷 — 띠지의 증감(+3)을 내려면 과거 값이 남아 있어야 한다
CREATE TABLE "MarketSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "takenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verifying" INTEGER NOT NULL,
    "judged" INTEGER NOT NULL,
    "researchers" INTEGER NOT NULL,
    "refundedKrw" INTEGER NOT NULL,
    "escrowKrw" INTEGER NOT NULL
);
CREATE INDEX "MarketSnapshot_takenAt_idx" ON "MarketSnapshot"("takenAt");
