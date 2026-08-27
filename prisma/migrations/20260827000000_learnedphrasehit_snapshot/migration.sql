-- 회신 20호 요청 1: 학습 표현 hit 의 매칭 스냅샷 (문장·출현형·부정·판정)
-- AlterTable
ALTER TABLE "LearnedPhraseHit" ADD COLUMN "matchedSentence" TEXT;
ALTER TABLE "LearnedPhraseHit" ADD COLUMN "matchedSurface" TEXT;
ALTER TABLE "LearnedPhraseHit" ADD COLUMN "negation" TEXT;
ALTER TABLE "LearnedPhraseHit" ADD COLUMN "verdict" TEXT;
