-- 졸업 관문 보강 (2026-09-01 창업자 확정).
-- 졸업 = "코드로 못 적으니 IRIS로"인데 관문이 그 시도를 묻지 않아, 늘 같은 꼴 "원금 보장"도
-- 졸업이 통과됐다(탐침 실측). ① 공식화 시도와 실패 이유를 적어야 졸업된다
-- ② 항목 질문지를 한 번은 뽑은 항목만 졸업된다(묻지 않고 내리는 것을 구조로 막는다).
ALTER TABLE "LearnedPhrase" ADD COLUMN "graduationReason" TEXT;
ALTER TABLE "LearnedPhrase" ADD COLUMN "itemPackAskedAt" DATETIME;
