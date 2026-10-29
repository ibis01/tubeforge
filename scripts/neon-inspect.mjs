// One-off Neon inspection: list public tables + Video columns + row counts.
// Run with: NEON_URL="postgresql://…" node scripts/neon-inspect.mjs
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

const tables = await client.query(
  `SELECT table_name FROM information_schema.tables
   WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY 1`
);
console.log("TABLES:", tables.rows.map((r) => r.table_name).join(", ") || "(none)");

if (tables.rows.some((r) => r.table_name === "Video")) {
  const cols = await client.query(
    `SELECT column_name, data_type FROM information_schema.columns
     WHERE table_schema='public' AND table_name='Video' ORDER BY ordinal_position`
  );
  console.log("VIDEO COLUMNS:", cols.rows.map((r) => r.column_name).join(", "));
  const count = await client.query(`SELECT count(*)::int AS n FROM "Video"`);
  console.log("VIDEO ROWS:", count.rows[0].n);
  for (const t of ["Channel", "Activity", "Setting"]) {
    try {
      const c = await client.query(`SELECT count(*)::int AS n FROM "${t}"`);
      console.log(`${t} ROWS:`, c.rows[0].n);
    } catch (e) {
      console.log(`${t} ROWS: error — ${e.message.split("\n")[0]}`);
    }
  }
}

await client.end();
