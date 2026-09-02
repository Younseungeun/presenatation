-- 공식화 샌드박스 (12차 검토 C-4 채택, 2026-09-01).
-- 졸업 관문의 "20자 사유"는 1인 운영에서 보일러플레이트가 된다 — 대신 후보 표현/패턴을
-- 항목이 잡은 문장 + 대조군에 돌린 정탐/오탐 수를 기록하고, "공식화가 실패했다"는 숫자가
-- 있을 때만 졸업을 연다. 사유는 선택 메모로 남는다.
ALTER TABLE "LearnedPhrase" ADD COLUMN "formalizeProbeJson" TEXT;
ALTER TABLE "LearnedPhrase" ADD COLUMN "formalizeProbeAt" DATETIME;
