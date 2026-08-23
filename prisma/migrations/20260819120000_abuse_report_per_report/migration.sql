-- 신고를 리포트에 붙인다 (2026-08-19).
--
-- reportId는 원래 "링크를 아는 경우"의 선택 항목이라 아무도 채우지 않았고, 그래서 같은
-- 리포트를 여럿이 신고해도 시스템이 한 건인 줄 몰랐다. 리포트 화면의 신고 버튼이 id를
-- 실어 보내면서 이 두 인덱스가 필요해진다.

-- 신고자 누적 집계 — 한 리포트의 PENDING 신고를 훑는다
CREATE INDEX "AbuseReport_reportId_status_idx" ON "AbuseReport"("reportId", "status");

-- 같은 사람이 같은 리포트를 두 번 신고할 수 없다. 문턱이 "서로 다른 신고자 수"라
-- 한 사람이 3번 눌러 3이 되면 문턱이 아무것도 막지 않는다 (하루 한도가 정확히 3이라
-- 혼자서 닿는다). NULL은 서로 다른 값으로 취급되므로 자유 입력 신고는 영향이 없다.
CREATE UNIQUE INDEX "AbuseReport_reporterId_reportId_key" ON "AbuseReport"("reporterId", "reportId");
