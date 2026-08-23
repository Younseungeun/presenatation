-- 운영자 공지 발송 기록 (2026-08-19)
-- 알림(Notification)은 사람마다 한 행씩 생기고, 이 표는 **발송 한 번에 한 행**이다.
-- 되돌릴 수 없는 행위라 "무엇을 언제 누구에게 보냈나"가 한 줄로 남아야 한다.
CREATE TABLE "Notice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "recipients" INTEGER NOT NULL,
    "sentBy" TEXT NOT NULL,
    "sentAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX "Notice_sentAt_idx" ON "Notice"("sentAt");
