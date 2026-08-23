-- CreateTable
CREATE TABLE "LearnedPhraseHit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phraseId" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "researcherId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "LearnedPhraseHit_phraseId_researcherId_idx" ON "LearnedPhraseHit"("phraseId", "researcherId");

-- CreateIndex
CREATE INDEX "LearnedPhraseHit_reportId_idx" ON "LearnedPhraseHit"("reportId");
