-- CreateTable
CREATE TABLE "Follow" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "followerId" TEXT NOT NULL,
    "researcherId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Follow_followerId_fkey" FOREIGN KEY ("followerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Follow_researcherId_fkey" FOREIGN KEY ("researcherId") REFERENCES "ResearcherProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Follow_researcherId_idx" ON "Follow"("researcherId");

-- CreateIndex
CREATE UNIQUE INDEX "Follow_followerId_researcherId_key" ON "Follow"("followerId", "researcherId");
