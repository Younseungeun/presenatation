-- 게시 시점 실현 변동성 (안정성 별점의 원천 — domain/stability.ts)
ALTER TABLE "PredictionCard" ADD COLUMN "sigmaDaily" REAL;
