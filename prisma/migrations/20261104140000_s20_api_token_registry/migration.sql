-- S20 — the API token registry. Bearer tokens were stateless HMAC payloads
-- since Stage 2: no listing, no revocation; a leaked key was live for 90
-- days and the only defense was rotating TUBEFORGE_AUTH_SECRET (which kills
-- every session too). This table gives tokens the Session treatment: every
-- mint persists a row keyed by the token's jti, resolution refuses
-- revoked/unknown/expired jtis, and the security card lists + revokes them.

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jti" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ApiToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_jti_key" ON "ApiToken"("jti");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- CreateIndex
CREATE INDEX "ApiToken_expiresAt_idx" ON "ApiToken"("expiresAt");

-- AddForeignKey
ALTER TABLE "ApiToken" ADD CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
