-- 되돌린 판정이 같은 오답으로 되돌아오지 않게 한다.
-- 원인이 시세 소스였다면 재판정도 같은 소스를 쓰므로 사람이 무한히 되돌리게 된다.
-- 그때만 자동 배치에서 빼고 운영자 판정 큐로 보낸다 (판정 로직 버그였다면 세우지 않는다).
ALTER TABLE "PredictionCard" ADD COLUMN "manualJudgmentOnly" BOOLEAN NOT NULL DEFAULT false;
