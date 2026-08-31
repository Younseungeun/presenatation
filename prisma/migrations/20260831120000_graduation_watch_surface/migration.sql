-- 졸업 관찰 기록에 표면형을 남긴다 (2026-08-31 졸업 강등 트리거 재정의).
-- 졸업 강등의 증거는 IRIS 의 미탐(실패)이 아니라 "형태가 굳어 코드가 완전히 잡는다"는
-- 적합성이고, 그 실측은 졸업 후 출현의 표면형 분포다. 기존 행은 null(측정 불가).
ALTER TABLE "GraduationWatchHit" ADD COLUMN "matchedSurface" TEXT;
