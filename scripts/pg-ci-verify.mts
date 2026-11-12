// PostgreSQL CI verification battery (S61) — the lane the S60 incident
// proved missing. Runs INSIDE the CI `postgres` job (services: postgres:17)
// AFTER two authentic postinstall passes (see .github/workflows/ci.yml):
//
//   pass 1 (during `npm ci` + the explicit postinstall step): a CLEAN
//   database walks the chain and is EXPECTED to wedge at auth_setting —
//   Postgres's ALTER TABLE … RENAME keeps the old PK constraint name, so
//   auth_setting's CREATE TABLE "Setting" collides with the surviving
//   "Setting_pkey" (42P07). postinstall is non-fatal for Postgres by
//   design, so this pass ends with a WARNING — the exact production story.
//
//   pass 2: migrate-stage2's self-heal (pgRepairSettingPkeySurvivor →
//   stuck-row resolve → migrate deploy) completes the chain.
//
// THIS script then asserts the healed end state and probes the two
// portability bugs S60 actually fixed — the assertions fail the job if any
// regression reintroduces them:
//
//   1. chain complete      — every prisma/migrations/* has a finished row;
//                            nothing stuck (finished_at NULL, rolled_back NULL)
//   2. constraint names    — "Setting_pkey" on Setting,
//                            "LegacySetting_pkey" on LegacySetting
//   3. s40/s49 columns     — "Video"."qcOverrideAt" + "Video"."contentPolicy"
//                            exist (their absence P2022'd every full-select
//                            Video query → the production 500s)
//   4. usage sparkline SQL — the REAL shared function (src/lib/tubeforge/
//                            usage-sql.ts) runs on Postgres: quoted
//                            identifiers (42703 guard) + NOT "ok" boolean
//                            (42883 guard), verified with seeded rows
//   5. full-select Video   — prisma.video.findMany + a create/read roundtrip
//
// Usage:  DATABASE_URL=postgres://… node --import tsx scripts/pg-ci-verify.mts
// Exit:   0 = every assertion held · 1 = a regression is present.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";
import { dailyUsageSparkline } from "../src/lib/tubeforge/usage-sql";

const db = new PrismaClient();
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

async function scalar(sql: string): Promise<number> {
  const rows = (await db.$queryRawUnsafe(sql)) as { n: number | bigint }[];
  return Number(rows[0]?.n ?? -1);
}

try {
  // ---------- 1. the migration chain is complete and healthy ----------
  const chainDir = join(process.cwd(), "prisma", "migrations");
  const chainNames = readdirSync(chainDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => d.name);

  const managed = await scalar(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'`
  );
  check("_prisma_migrations exists (the chain is managed)", managed === 1);

  const stuck = await scalar(
    `SELECT COUNT(*)::int AS n FROM "_prisma_migrations"
      WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL`
  );
  check("no stuck migration rows", stuck === 0, `${stuck} stuck`);

  for (const name of chainNames) {
    const rows = (await db.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM "_prisma_migrations"
        WHERE "migration_name" = $1 AND "finished_at" IS NOT NULL`,
      name
    )) as { n: number | bigint }[];
    check(`migration applied: ${name}`, Number(rows[0]?.n ?? 0) >= 1);
  }

  // ---------- 2. the S60 wedge's fingerprint is gone ----------
  // The constraint the rename survived with must be gone from LegacySetting,
  // and both tables must carry correctly named primary keys.
  const pk = (await db.$queryRawUnsafe(
    `SELECT c.relname AS table_name, con.conname AS constraint_name
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
      WHERE con.contype = 'p'
        AND c.relname IN ('Setting', 'LegacySetting')`
  )) as { table_name: string; constraint_name: string }[];
  const pkOf = (t: string) => pk.find((r) => r.table_name === t)?.constraint_name ?? "(none)";
  check(`Setting PK is "Setting_pkey"`, pkOf("Setting") === "Setting_pkey", pkOf("Setting"));
  check(
    `LegacySetting PK is "LegacySetting_pkey"`,
    pkOf("LegacySetting") === "LegacySetting_pkey",
    pkOf("LegacySetting")
  );
  const survivor = await scalar(
    `SELECT COUNT(*)::int AS n FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
      WHERE con.conname = 'Setting_pkey' AND c.relname = 'LegacySetting'`
  );
  check("no surviving Setting_pkey on LegacySetting (the 42P07 seed)", survivor === 0);

  // ---------- 3. the s40/s49 Video columns exist (the P2022 guard) ----------
  for (const col of ["qcOverrideAt", "contentPolicy"]) {
    const present = await scalar(
      `SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Video' AND column_name = '${col}'`
    );
    check(`Video.${col} exists (s40/s49 landed)`, present === 1);
  }

  // ---------- 4. the usage sparkline SQL — the REAL shared function ----------
  // Seed Org → User → two UsageRecords (one ok, one failed, same day). The
  // `NOT "ok"` predicate must type-check as a boolean (42883 guard) and the
  // quoted identifiers must resolve (42703 guard).
  const org = await db.organization.create({
    data: { name: "S61 CI Probe", slug: `s61-ci-${Date.now()}` },
  });
  const user = await db.user.create({
    data: {
      email: `s61-ci-${Date.now()}@probe.invalid`,
      passwordHash: "pbkdf2$1$c2FsdA$aGFzaA", // never used — probe account
      name: "S61 CI Probe",
    },
  });
  // Membership backfill happens lazily in the app; the probe inserts rows directly.
  await db.$executeRawUnsafe(
    `INSERT INTO "Membership" ("id", "userId", "organizationId", "role", "createdAt")
     VALUES ('s61probe-mem', $1, $2, 'owner', NOW())
     ON CONFLICT DO NOTHING`,
    user.id,
    org.id
  );
  await db.usageRecord.createMany({
    data: [
      { organizationId: org.id, userId: user.id, capability: "generic", provider: "probe", ok: true },
      { organizationId: org.id, userId: user.id, capability: "generic", provider: "probe", ok: false },
    ],
  });
  const daily = await dailyUsageSparkline(db, user.id, new Date(Date.now() - 24 * 3600 * 1000));
  const today = daily[daily.length - 1];
  check(
    "usage sparkline runs on Postgres and counts failures via NOT \"ok\"",
    !!today && today.calls === 2 && today.failures === 1,
    today ? `calls=${today.calls} failures=${today.failures}` : "no rows returned"
  );

  // ---------- 5. full-select Video — the query shape that 500'd production ----------
  const video = await db.video.create({
    data: { organizationId: org.id, topic: "S61 probe", niche: "probe" },
  });
  const readBack = await db.video.findMany({ where: { organizationId: org.id } });
  check(
    "full-select Video query works (P2022 guard)",
    readBack.length === 1 && readBack[0].id === video.id
  );

  // ---------- 6. column-reality probes (the P2022 guard, S100/S101) ----------
  // findMany projects EVERY scalar column: a migration that failed to deploy
  // (leaseToken/leaseExpiresAt, StorageReservation) 500s the queue and the
  // upload routes. count() would not catch it — projection does.
  await db.job.findMany({ take: 1 });
  check("Job probe — leaseToken/leaseExpiresAt present (S100 migration deployed)", true);
  await db.storageReservation.findMany({ take: 1 });
  check("StorageReservation probe — S101 migration deployed", true);

  // ---------- cleanup (probe rows; the DB itself is disposable) ----------
  await db.video.delete({ where: { id: video.id } });
  await db.usageRecord.deleteMany({ where: { userId: user.id } });
  await db.$executeRawUnsafe(`DELETE FROM "Membership" WHERE "id" = 's61probe-mem'`);
  await db.user.delete({ where: { id: user.id } });
  await db.organization.delete({ where: { id: org.id } });

  if (failures > 0) {
    console.error(`\npg-ci-verify: ${failures} assertion(s) FAILED`);
    process.exit(1);
  }
  console.log("\npg-ci-verify: all assertions held — the Postgres lane is healthy");
} catch (err) {
  console.error(
    "pg-ci-verify: crashed —",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
} finally {
  await db.$disconnect();
}
