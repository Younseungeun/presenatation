-- 판정 이의제기 — 구매자 → 플랫폼의 단방향 클레임.
--
-- 이 창구가 없으면 "판정이 틀렸다"고 생각한 구매자가 갈 곳은 카드사뿐이다.
-- 차지백은 우리가 아무것도 못 하는 자리에서 돈이 빠지는 것이고, 그 전에 우리 안에서
-- 끝낼 기회를 스스로 없애는 셈이다.
--
-- Purchase.escrowStatus의 DISPUTED(차지백)와 **다른 표**다: 그건 돈이 실제로 빠져나간
-- 사건이고 이건 돈은 그대로인 채 판정의 정확성을 다투는 것이다. 처분이 비슷하다고
-- 한 칸에 담으면 나중에 둘을 쿼리로 구분할 수 없다.
CREATE TABLE "JudgmentDispute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "judgmentId" TEXT NOT NULL,
    "purchaseId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "observed" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JudgmentDispute_judgmentId_fkey" FOREIGN KEY ("judgmentId") REFERENCES "Judgment" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "JudgmentDispute_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "JudgmentDispute_purchaseId_key" ON "JudgmentDispute"("purchaseId");
CREATE INDEX "JudgmentDispute_status_idx" ON "JudgmentDispute"("status");
CREATE INDEX "JudgmentDispute_judgmentId_idx" ON "JudgmentDispute"("judgmentId");
