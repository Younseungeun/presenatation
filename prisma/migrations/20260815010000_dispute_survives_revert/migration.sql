-- 이의 기록이 판정보다 오래 산다 (2026-08-15).
--
-- JudgmentDispute.judgmentId가 필수 관계(ON DELETE RESTRICT)여서 **이의가 걸린 판정은
-- 되돌릴 수 없었다.** 즉 "이의 접수 → 인정 → 되돌리기"의 마지막 걸음이 외래키 오류로
-- 죽고, 그 정산은 열린 이의에 막힌 채 DB를 직접 고치지 않으면 영원히 풀리지 않는다.
-- 이의 창구를 만든 커밋이 스스로 만든 덫이다.
--
-- 고르는 방법은 둘이었다: 이의를 함께 지우거나, 이의를 남기고 링크만 끊거나.
-- **남긴다.** 판정은 없던 일이 되어도 "누가 무엇을 문제 삼았고 우리가 어떻게
-- 판단했나"는 지워지면 안 된다 — 지표 ③의 분자이고, 소비자 분쟁이 커졌을 때
-- 우리가 제때 처리했음을 보이는 유일한 기록이다.
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_JudgmentDispute" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "judgmentId" TEXT,
    "purchaseId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "observed" TEXT,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedAt" DATETIME,
    "resolvedBy" TEXT,
    "resolution" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "JudgmentDispute_judgmentId_fkey" FOREIGN KEY ("judgmentId") REFERENCES "Judgment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "JudgmentDispute_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_JudgmentDispute" ("id","judgmentId","purchaseId","buyerId","category","observed","status","resolvedAt","resolvedBy","resolution","createdAt")
SELECT "id","judgmentId","purchaseId","buyerId","category","observed","status","resolvedAt","resolvedBy","resolution","createdAt" FROM "JudgmentDispute";

DROP TABLE "JudgmentDispute";
ALTER TABLE "new_JudgmentDispute" RENAME TO "JudgmentDispute";

CREATE UNIQUE INDEX "JudgmentDispute_purchaseId_key" ON "JudgmentDispute"("purchaseId");
CREATE INDEX "JudgmentDispute_status_idx" ON "JudgmentDispute"("status");
CREATE INDEX "JudgmentDispute_judgmentId_idx" ON "JudgmentDispute"("judgmentId");

PRAGMA foreign_keys=ON;
