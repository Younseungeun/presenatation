-- 되돌린 판정의 묘비. Judgment는 predictionCardId가 unique라 다시 판정하려면 행을
-- 지워야 하는데, 판정은 돈과 점수를 동시에 움직인 사건이라 흔적 없이 사라지면
-- "왜 이 카드가 두 번 판정됐나"에 답할 수 없다. 지우기 전에 통째로 옮겨 적는다.
CREATE TABLE "JudgmentRevert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "predictionCardId" TEXT NOT NULL,
    "judgmentId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "score" REAL,
    "info" REAL,
    "judgedAt" DATETIME NOT NULL,
    "judgmentJson" TEXT NOT NULL,
    "settlementsJson" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "revertedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "JudgmentRevert_predictionCardId_idx" ON "JudgmentRevert"("predictionCardId");
