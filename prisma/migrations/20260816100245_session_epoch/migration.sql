-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "penName" TEXT,
    "identityVerified" BOOLEAN NOT NULL DEFAULT false,
    "identityHash" TEXT,
    "realNameEnc" TEXT,
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_User" ("createdAt", "email", "id", "identityHash", "identityVerified", "penName", "realNameEnc", "role") SELECT "createdAt", "email", "id", "identityHash", "identityVerified", "penName", "realNameEnc", "role" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_identityHash_key" ON "User"("identityHash");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
