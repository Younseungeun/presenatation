-- 감시 해제 연속 관측 카운터 (domain/quoteWatch.ts)
ALTER TABLE "InstrumentQuote" ADD COLUMN "exitStreak" INTEGER NOT NULL DEFAULT 0;
