// Neon schema sync — bring the production PostgreSQL database up to the
// current prisma/schema.prisma without touching existing data.
//
//   NEON_URL="postgresql://…" node scripts/neon-sync.mjs
//
// Idempotent: every statement is IF NOT EXISTS / ADD COLUMN IF NOT EXISTS,
// so it is safe to re-run after every deploy that adds schema bits.
// (The `pg` driver is a devDependency; credentials NEVER live in this file.)
import pg from "pg";

const url = process.env.NEON_URL;
if (!url) {
  console.error("Set NEON_URL env var (never hardcode credentials here)");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: url,
  ssl: { rejectUnauthorized: false },
});

await client.connect();

// ── 2026-10 voice cloning: VoiceProfile table (mirrors prisma schema) ──
const ddl = `
CREATE TABLE IF NOT EXISTS "VoiceProfile" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "provider" TEXT NOT NULL DEFAULT 'zhipu',
  "providerVoiceId" TEXT NOT NULL,
  "sourceLabel" TEXT,
  "durationSec" DOUBLE PRECISION,
  "auditionWav" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "VoiceProfile_isActive_idx" ON "VoiceProfile"("isActive");
CREATE INDEX IF NOT EXISTS "VoiceProfile_provider_idx" ON "VoiceProfile"("provider");
`;
await client.query(ddl);
console.log("VoiceProfile DDL applied ✓");

// ── 2026-10 merge follow-up: the 7 nullable Video columns (idempotent) ──
const alters = `
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "brandAccent" TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "brandLogoOn" BOOLEAN;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "musicDucking" BOOLEAN;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "musicDuckingIntensity" TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "musicMood" TEXT;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "transitionDuration" DOUBLE PRECISION;
ALTER TABLE "Video" ADD COLUMN IF NOT EXISTS "transitionStyle" TEXT;
`;
await client.query(alters);
console.log("Video ALTERs applied ✓");

// ── Verify ──
const cols = await client.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='Video'
     AND column_name IN ('brandAccent','brandLogoOn','musicDucking','musicDuckingIntensity','musicMood','transitionDuration','transitionStyle')
   ORDER BY 1`
);
console.log("VIDEO NEW COLUMNS PRESENT:", cols.rows.map((r) => r.column_name).join(", "));

const vp = await client.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='VoiceProfile' ORDER BY ordinal_position`
);
console.log("VOICEPROFILE COLUMNS:", vp.rows.map((r) => r.column_name).join(", "));

// Setting keys only (values may hold secrets/hashes — never print them)
const settings = await client.query(`SELECT key FROM "Setting" ORDER BY key`);
console.log("SETTING KEYS:", settings.rows.map((r) => r.key).join(", "));

await client.end();
