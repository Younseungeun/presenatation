-- CreateTable
CREATE TABLE "PhraseRescanHit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phraseId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "quote" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolution" TEXT,
    "resolvedBy" TEXT,
    CONSTRAINT "PhraseRescanHit_phraseId_fkey" FOREIGN KEY ("phraseId") REFERENCES "LearnedPhrase" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PhraseRescanHit_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PhraseRescanHit_resolvedAt_idx" ON "PhraseRescanHit"("resolvedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PhraseRescanHit_phraseId_reportId_key" ON "PhraseRescanHit"("phraseId", "reportId");
