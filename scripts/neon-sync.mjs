// One-off Neon schema sync: add the 7 merged-schema columns (all nullable) + report Setting keys.
// Run with: NEON_URL="postgresql://…" node scripts/neon-sync.mjs
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
console.log("ALTERs applied ✓");

// Verify
const cols = await client.query(
  `SELECT column_name FROM information_schema.columns
   WHERE table_schema='public' AND table_name='Video'
     AND column_name IN ('brandAccent','brandLogoOn','musicDucking','musicDuckingIntensity','musicMood','transitionDuration','transitionStyle')
   ORDER BY 1`
);
console.log("NEW COLUMNS PRESENT:", cols.rows.map((r) => r.column_name).join(", "));

// Setting keys only (values may hold secrets/hashes — never print them)
const settings = await client.query(`SELECT key FROM "Setting" ORDER BY key`);
console.log("SETTING KEYS:", settings.rows.map((r) => r.key).join(", "));

await client.end();
