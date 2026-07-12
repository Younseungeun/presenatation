-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "penName" TEXT,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "identityHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "ResearcherProfile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'BRONZE',
    "careerBadge" TEXT,
    "advisoryRegistered" BOOLEAN NOT NULL DEFAULT false,
    "promoFeeUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ResearcherProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "researcherId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "priceKrw" INTEGER NOT NULL,
    "prepaymentRatio" INTEGER NOT NULL DEFAULT 0,
    "feeRateBp" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "publishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Report_researcherId_fkey" FOREIGN KEY ("researcherId") REFERENCES "ResearcherProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PredictionCard" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "ticker" TEXT NOT NULL,
    "assetName" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetValue" REAL NOT NULL,
    "basePrice" REAL NOT NULL,
    "deadline" DATETIME NOT NULL,
    "confidence" INTEGER,
    "withdrawnAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PredictionCard_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Judgment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "predictionCardId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "undecidableReason" TEXT,
    "settledPrice" REAL,
    "judgedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Judgment_predictionCardId_fkey" FOREIGN KEY ("predictionCardId") REFERENCES "PredictionCard" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "reportId" TEXT NOT NULL,
    "buyerId" TEXT NOT NULL,
    "amountKrw" INTEGER NOT NULL,
    "escrowStatus" TEXT NOT NULL DEFAULT 'HELD',
    "paidAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Purchase_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "Report" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Purchase_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Settlement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "purchaseId" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "researcherPayoutKrw" INTEGER NOT NULL,
    "platformFeeKrw" INTEGER NOT NULL,
    "buyerRefundKrw" INTEGER NOT NULL,
    "refundType" TEXT,
    "settledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Settlement_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "Purchase" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Credit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "amountKrw" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Credit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TierHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "researcherId" TEXT NOT NULL,
    "season" TEXT NOT NULL,
    "fromTier" TEXT NOT NULL,
    "toTier" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TierHistory_researcherId_fkey" FOREIGN KEY ("researcherId") REFERENCES "ResearcherProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "User_identityHash_key" ON "User"("identityHash");

-- CreateIndex
CREATE UNIQUE INDEX "ResearcherProfile_userId_key" ON "ResearcherProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PredictionCard_reportId_key" ON "PredictionCard"("reportId");

-- CreateIndex
CREATE UNIQUE INDEX "Judgment_predictionCardId_key" ON "Judgment"("predictionCardId");

-- CreateIndex
CREATE UNIQUE INDEX "Purchase_reportId_buyerId_key" ON "Purchase"("reportId", "buyerId");

-- CreateIndex
CREATE UNIQUE INDEX "Settlement_purchaseId_key" ON "Settlement"("purchaseId");
