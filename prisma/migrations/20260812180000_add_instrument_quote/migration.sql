-- 종목 시세 스냅샷 — 목록이 시세 호출 없이 "지금 살 수 있는가"를 답하게 한다
CREATE TABLE "InstrumentQuote" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetClass" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "price" REAL NOT NULL,
    "at" DATETIME NOT NULL,
    "watching" BOOLEAN NOT NULL DEFAULT false,
    "minQ" REAL,
    "source" TEXT NOT NULL DEFAULT 'batch',
    "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "InstrumentQuote_assetClass_ticker_key" ON "InstrumentQuote"("assetClass", "ticker");
CREATE INDEX "InstrumentQuote_watching_idx" ON "InstrumentQuote"("watching");
