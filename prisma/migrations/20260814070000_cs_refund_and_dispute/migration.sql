-- CS 환불(판정 전 거래 무효화)과 차지백 분쟁을 기존 구조에 들인다.
--
-- RefundAttempt를 새 표로 나누지 않은 이유: 멱등키가 **시도 id**라(같은 키로 두 번
-- 불러도 한 번만 나간다) 그 성질을 두 벌로 나누면 한쪽에서 조용히 어긋난다.
-- 표를 나누면 돈을 옮기는 코드가 두 벌이 되는데, 이 시스템에서 가장 위험한 중복이다.
--
-- settlementId를 nullable로 푸는 대신 type으로 갈래를 나누고, 어느 쪽에 무엇이
-- 필수인지는 서비스가 강제한다 (SQLite에 조건부 CHECK 제약이 없다).
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RefundAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL DEFAULT 'JUDGMENT_FAIL',
    "settlementId" TEXT,
    "purchaseId" TEXT,
    "amountKrw" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "operatorId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "bankReference" TEXT,
    "escalatedAt" DATETIME,
    CONSTRAINT "RefundAttempt_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "Settlement" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "RefundAttempt_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_RefundAttempt" ("amountKrw", "bankReference", "createdAt", "error", "escalatedAt", "finishedAt", "id", "method", "operatorId", "settlementId", "status") SELECT "amountKrw", "bankReference", "createdAt", "error", "escalatedAt", "finishedAt", "id", "method", "operatorId", "settlementId", "status" FROM "RefundAttempt";
DROP TABLE "RefundAttempt";
ALTER TABLE "new_RefundAttempt" RENAME TO "RefundAttempt";
CREATE INDEX "RefundAttempt_settlementId_idx" ON "RefundAttempt"("settlementId");
CREATE INDEX "RefundAttempt_purchaseId_idx" ON "RefundAttempt"("purchaseId");
CREATE UNIQUE INDEX "RefundAttempt_settlementId_bankReference_key" ON "RefundAttempt"("settlementId", "bankReference");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
