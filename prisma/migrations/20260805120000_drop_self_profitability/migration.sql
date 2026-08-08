-- 수익성은 리서처 입력이 아니라 예측 크기에서 자동 산출된다 (domain/profitability.ts).
-- 저장된 자기 평가 값은 어디에도 쓰이지 않으므로 컬럼째 제거한다.
ALTER TABLE "PredictionCard" DROP COLUMN "selfProfitability";
