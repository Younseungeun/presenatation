-- 보상 안내 완료 시각.
-- 없으면 "안내 대기" 목록에서 나갈 방법이 없어 큐가 영영 줄지 않는다.
ALTER TABLE "AbuseReport" ADD COLUMN "rewardNoticedAt" DATETIME;
