-- 종목 실현 변동성 캐시 (작성 화면 가이드용 — 카드는 게시 시점 값을 따로 고정한다)
ALTER TABLE "Instrument" ADD COLUMN "sigmaDaily" REAL;
ALTER TABLE "Instrument" ADD COLUMN "sigmaSyncedAt" DATETIME;
