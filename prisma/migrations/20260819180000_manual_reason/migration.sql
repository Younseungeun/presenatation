-- 수동 판정 큐에 온 사유 (2026-08-19)
-- 플래그만으로는 "사람이 봐야 한다"까지만 알고 **무엇을 볼지**는 모른다.
-- 기존 행은 null로 남는다 — 그 값은 "시세를 못 구해 이월된 건"과 같은 뜻이라 맞다.
ALTER TABLE "PredictionCard" ADD COLUMN "manualReason" TEXT;
