-- 액면분할 감지 앵커 (domain/corporateAction.ts) — 카드당 실수 하나 + 그 거래일
ALTER TABLE "PredictionCard" ADD COLUMN "baseCloseAnchor" REAL;
ALTER TABLE "PredictionCard" ADD COLUMN "baseCloseAnchorDate" TEXT;

-- 권리 사건으로 가격 기준을 옮긴 기록 (이미 팔린 상품의 조건 변경이라 감사 대상)
CREATE TABLE "CorporateActionLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "predictionCardId" TEXT NOT NULL,
    "anchorDate" TEXT NOT NULL,
    "anchorBefore" REAL NOT NULL,
    "anchorAfter" REAL NOT NULL,
    "factor" REAL NOT NULL,
    "basePriceBefore" REAL NOT NULL,
    "basePriceAfter" REAL NOT NULL,
    "targetBefore" REAL,
    "targetAfter" REAL,
    "applied" BOOLEAN NOT NULL DEFAULT true,
    "ksdEvent" TEXT,
    "ksdRatio" REAL,
    "detectedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CorporateActionLog_predictionCardId_fkey" FOREIGN KEY ("predictionCardId") REFERENCES "PredictionCard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "CorporateActionLog_predictionCardId_idx" ON "CorporateActionLog"("predictionCardId");
