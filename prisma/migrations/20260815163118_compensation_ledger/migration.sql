-- 플랫폼 귀책 보상 원장 (2026-08-16).
--
-- Settlement에 얹지 않고 표를 나눈 이유는 **돈의 출처가 다르기 때문**이다 —
-- 정산은 구매자가 낸 돈을 나누는 위탁이고(우리 자산이 아니다), 보상은 우리 자본에서
-- 나가는 손해 보전이다. 한 표에 섞으면 에스크로 계좌 잔액과 장부가 영원히 안 맞는다.
--
-- 공유하는 것은 **이체 실행 레일뿐**이다: 일일 출금 한도·감사 로그·은행 참조번호.
-- 쿨다운·이의 차단·PG 입금 지연은 지나지 않는다(뒤집힐 판정이 없고, 이의는 판정에
-- 거는 것이며, 이 돈은 PG를 거치지 않는다).
--
-- JudgmentDispute 재작성은 스키마 드리프트 정리다(컬럼·데이터 변화 없음).

-- CreateTable
CREATE TABLE "CompensationInstruction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseId" TEXT NOT NULL,
    "predictionCardId" TEXT NOT NULL,
    "researcherUserId" TEXT NOT NULL,
    "amountKrw" INTEGER NOT NULL,
    "cause" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedBy" TEXT,
    "reviewNote" TEXT,
    "executedAt" DATETIME,
    "executedBy" TEXT,
    "bankReference" TEXT,
    CONSTRAINT "CompensationInstruction_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
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
    CONSTRAINT "JudgmentDispute_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_JudgmentDispute" ("actorRole", "buyerId", "category", "claimedPrice", "createdAt", "id", "judgmentId", "observed", "purchaseId", "researcherId", "resolution", "resolvedAt", "resolvedBy", "status") SELECT "actorRole", "buyerId", "category", "claimedPrice", "createdAt", "id", "judgmentId", "observed", "purchaseId", "researcherId", "resolution", "resolvedAt", "resolvedBy", "status" FROM "JudgmentDispute";
DROP TABLE "JudgmentDispute";
ALTER TABLE "new_JudgmentDispute" RENAME TO "JudgmentDispute";
CREATE UNIQUE INDEX "JudgmentDispute_purchaseId_key" ON "JudgmentDispute"("purchaseId");
CREATE INDEX "JudgmentDispute_status_idx" ON "JudgmentDispute"("status");
CREATE INDEX "JudgmentDispute_judgmentId_idx" ON "JudgmentDispute"("judgmentId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "CompensationInstruction_purchaseId_key" ON "CompensationInstruction"("purchaseId");

-- CreateIndex
CREATE INDEX "CompensationInstruction_status_createdAt_idx" ON "CompensationInstruction"("status", "createdAt");

-- CreateIndex
CREATE INDEX "CompensationInstruction_predictionCardId_idx" ON "CompensationInstruction"("predictionCardId");
