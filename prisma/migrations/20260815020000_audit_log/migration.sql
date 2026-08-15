-- 감사 로그 — 돈의 근거가 언제 어떻게 바뀌었는지의 단일 기록 (2026-08-15).
--
-- 도메인 표는 상태를 관리하고 이 표는 사건을 남긴다. 중복은 감수한다 —
-- 표 다섯 개를 조인해 만든 뷰는 "조작되지 않았다"를 증명하지 못하기 때문이다.
--
-- 사건 하나에 한 줄이다. 판정 한 번이 정산 3건을 만들어도 로그는 한 줄이고,
-- "정산 s_1이 왜 생겼나"는 도메인 외래키를 타고 올라와 targetId로 조회한다.
-- 하위 id를 JSON에 담아 검색하게 만들면 SQLite에는 JSON 인덱스가 없어 풀스캔이 된다.
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "actorType" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "before" TEXT,
    "after" TEXT,
    "reason" TEXT
);

CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");
CREATE INDEX "AuditLog_at_idx" ON "AuditLog"("at");
CREATE INDEX "AuditLog_actor_idx" ON "AuditLog"("actor");
