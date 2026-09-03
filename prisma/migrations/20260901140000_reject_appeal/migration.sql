-- 거절 이의 (B1, 2026-09-01). 즉시 거절(BLOCK)은 큐에 안 와 사람 판정이 안 붙는다 — BLOCK 규칙의
-- 오탐 증거 채널이 0이었다. 리서처가 "이 인용문은 위반이 아니다"를 소명하면(거절 1건에 1회,
-- 미결 2건 상한, 반려 누적 3회면 창구 닫힘) 운영자 거절 훑기 큐 맨 앞에 선다.
ALTER TABLE "ComplianceReview" ADD COLUMN "appealStatement" TEXT;
ALTER TABLE "ComplianceReview" ADD COLUMN "appealAt" DATETIME;
