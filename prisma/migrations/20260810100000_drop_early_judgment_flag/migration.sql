-- 조기 판정 플래그 제거 (2026-08-10): 판정 규칙이 "기한 내 종가 도달 = 적중" 하나로
-- 통합되면서 도달 판정(reachedJudgmentBatch)이 전 카드에 적용된다 — 켜고 끌 대상이 없다.
ALTER TABLE "PredictionCard" DROP COLUMN "earlyJudgment";
