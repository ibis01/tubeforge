-- AuthGate: restore the deployment-level Setting table (key/value store for
-- app-wide flags — auth gate switch, access-password hash in auth.ts).
-- The Stage-3 cleanup (R-CRIT-2) removed the legacy table together with its
-- last reader; the new AuthGate feature reintroduces it with a minimal shape.

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);
