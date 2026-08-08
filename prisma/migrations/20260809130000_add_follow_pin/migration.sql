-- 리더보드 팔로우 섹션 고정 — 팔로우가 늘면 최신순만으로는 늘 보고 싶은 사람이 밀린다
ALTER TABLE "Follow" ADD COLUMN "pinnedAt" DATETIME;
