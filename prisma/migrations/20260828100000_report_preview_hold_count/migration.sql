-- 게시 전 되묻기 프리뷰 오라클 방어 카운터 (회신 22호 답장 수리 ①)
ALTER TABLE "Report" ADD COLUMN "previewHoldCount" INTEGER NOT NULL DEFAULT 0;
