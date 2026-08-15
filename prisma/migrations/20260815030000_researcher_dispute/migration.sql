-- 판정 이의를 청구인 양쪽이 쓰는 한 표로 (2026-08-15).
--
-- 실패 판정에서 억울한 쪽은 리서처인데 그쪽에는 창구가 없었다. 표를 나누지 않은
-- 이유는 주장의 종류가 같기 때문이다 — "판정에 쓰인 데이터가 실제와 다르다".
-- 갈리는 것은 처분이지 사건이 아니다.
--
-- purchaseId를 NULL 허용으로 바꾼다(리서처 주장은 판정에 붙는다). SQLite의 unique는
-- NULL을 서로 다르게 보므로 리서처 이의가 여럿이어도 유일성 제약에 걸리지 않는다.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_JudgmentDispute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "judgmentId" TEXT,
    "actorRole" TEXT NOT NULL DEFAULT 'PURCHASER',
    "purchaseId" TEXT,
    "buyerId" TEXT,
    "researcherId" TEXT,
    "category" TEXT NOT NULL,
    "observed" TEXT,
    "claimedPrice" REAL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JudgmentDispute_judgmentId_fkey" FOREIGN KEY ("judgmentId") REFERENCES "Judgment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "JudgmentDispute_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_JudgmentDispute" ("id", "judgmentId", "purchaseId", "buyerId", "category", "observed", "status", "resolvedAt", "resolvedBy", "resolution", "createdAt")
SELECT "id", "judgmentId", "purchaseId", "buyerId", "category", "observed", "status", "resolvedAt", "resolvedBy", "resolution", "createdAt" FROM "JudgmentDispute";

DROP TABLE "JudgmentDispute";
ALTER TABLE "new_JudgmentDispute" RENAME TO "JudgmentDispute";

CREATE UNIQUE INDEX "JudgmentDispute_purchaseId_key" ON "JudgmentDispute"("purchaseId");
CREATE INDEX "JudgmentDispute_status_idx" ON "JudgmentDispute"("status");
CREATE INDEX "JudgmentDispute_judgmentId_idx" ON "JudgmentDispute"("judgmentId");
CREATE INDEX "JudgmentDispute_researcherId_idx" ON "JudgmentDispute"("researcherId");

PRAGMA foreign_keys=ON;
