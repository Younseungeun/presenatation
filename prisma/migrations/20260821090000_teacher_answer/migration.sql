-- 수동 2차 검수(18차): 교사 답을 별도 표에 둔다.
-- ComplianceReview 에 칸을 더하지 않는 이유는 ShadowComplianceReview 와 같다 —
-- 같은 행에 두면 집계 쿼리의 WHERE 하나가 빠지는 날 교사 답이 운영자 판정과 합쳐진다.

-- CreateTable
CREATE TABLE "TeacherAnswer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "complianceReviewId" TEXT NOT NULL,
    "teacherTag" TEXT NOT NULL,
    "labelsJson" TEXT NOT NULL,
    "findingsValid" BOOLEAN,
    "rawAnswer" TEXT NOT NULL,
    "disagreed" BOOLEAN NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeacherAnswer_complianceReviewId_fkey" FOREIGN KEY ("complianceReviewId") REFERENCES "ComplianceReview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "TeacherAnswer_complianceReviewId_key" ON "TeacherAnswer"("complianceReviewId");

-- CreateIndex
CREATE INDEX "TeacherAnswer_disagreed_createdAt_idx" ON "TeacherAnswer"("disagreed", "createdAt");

-- CreateIndex
CREATE INDEX "TeacherAnswer_teacherTag_createdAt_idx" ON "TeacherAnswer"("teacherTag", "createdAt");

-- 질문지를 뽑은 시각. 없는 채로 내려진 결정 = 안 물어보고 처리한 건 (18차 V-7)
-- AlterTable
ALTER TABLE "ComplianceReview" ADD COLUMN "teacherAskedAt" DATETIME;
