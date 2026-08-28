-- CreateTable: 운영자 정의 위반 유형 (2026-08-28)
CREATE TABLE "ViolationType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "createdBy" TEXT,
    "sourceReportId" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ViolationType_label_key" ON "ViolationType"("label");
CREATE INDEX "ViolationType_active_idx" ON "ViolationType"("active");
