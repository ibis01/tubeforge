#!/usr/bin/env node
// Stage 2 — multi-user transition. Idempotent; safe to run repeatedly.
//
// WHAT IT DOES
//   1. SQLite (local dev / sandbox):
//        phase 1 (raw SQL): add nullable organizationId to the 10 content
//          tables + nullable userId on Activity/Job, backfill existing rows to
//          the bootstrap organization 'default', RENAME Setting -> LegacySetting
//          (a rename, never a drop — legacy rows survive until claimed).
//        phase 2: prisma db push — creates the new identity tables (User,
//          Organization, Membership, Session, UserSetting, YouTubeAccount,
//          ProviderCredential) and tightens organizationId to NOT NULL + FK.
//        phase 3: create the bootstrap organization 'default' row (only when
//          legacy content exists) + the partial unique index that guarantees
//          at most one owner per organization.
//   2. Postgres (production / Vercel):
//        baseline detection + prisma migrate deploy. A database with tables
//        but no _prisma_migrations history (Vercel Postgres pushed with
//        `db push` in the Stage-1 era, before the migration chain existed)
//        gets the matching prefix of the chain marked as applied via
//        `migrate resolve` (sentinel tables/columns fingerprint the schema
//        state), then `migrate deploy` applies the rest — the designed
//        upgrade path (ADD COLUMN organizationId DEFAULT 'default' + DROP
//        DEFAULT, Setting -> LegacySetting rename, bootstrap org, partial
//        index, and every later stage). Runs from postinstall on every
//        deploy: idempotent (a fully-migrated database is a no-op).
//        S60 repairs (both idempotent, both observed live on the production
//        Vercel DB): the VoiceProfile missing-table repair below, and the
//        Setting_pkey survivor — stage2's ALTER TABLE RENAME leaves the PK
//        constraint's ORIGINAL name on LegacySetting, so auth_setting's
//        CREATE TABLE "Setting" collides with it (42P07) and the chain
//        wedges on every deploy until the survivor is renamed away.
//
// WHY THE BOOTSTRAP ORG EXISTS: legacy single-user data must keep a tenant
// after the schema change. It is parked under organization 'default' until the
// first person registers AND proves the old studio password; the register
// claim flow (src/app/api/auth/register) then transfers it to their own new
// organization and migrates the LegacySetting rows (see ROADMAP Stage 2).
//
// Run it with: npm run migrate:stage2 (also called by setup:local and by
// postinstall on every install, both providers).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const prismaBin = join(root, "node_modules", ".bin", "prisma");

const run = (args, opts = {}) =>
  execFileSync(prismaBin, args, { stdio: "inherit", cwd: root, ...opts });

const execSql = (schemaFile, sql) => {
  const child = execFileSync(
    prismaBin,
    ["db", "execute", "--schema", schemaFile, "--stdin"],
    { cwd: root, input: sql, stdio: ["pipe", "inherit", "inherit"] }
  );
  return child;
};

// --- resolve DATABASE_URL the same way postinstall.mjs does: platform env
// var FIRST (Vercel/CI inject it there and ship no .env file), then the local
// .env file, then the SQLite fallback. Reading only .env made this script
// classify a Postgres deployment as SQLite and run PRAGMA/SQLite SQL against
// it (hard crash) — the same bug class postinstall.mjs carried until d7816e3.
let url = (process.env.DATABASE_URL || "").trim();
const envPath = join(root, ".env");
if (!url && existsSync(envPath)) {
  const m = readFileSync(envPath, "utf8").match(
    /^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m
  );
  url = m ? m[1].trim() : "";
}
if (!url) url = "file:../db/custom.db";
const isSqlite = url.startsWith("file:");

// --- content tables that gain organizationId in phase 1 ---
const TENANT_TABLES = [
  "Channel",
  "Character",
  "Video",
  "Activity",
  "ResearchSession",
  "ScheduleSlot",
  "VideoStat",
  "VoiceProfile",
  "MusicTrack",
  "Job",
];

const log = (msg) => console.log(`[migrate-stage2] ${msg}`);

// --- Postgres baseline sentinels -------------------------------------------
// Fingerprint of the schema state each migration leaves behind. Used ONLY
// when _prisma_migrations is absent (a database managed outside the chain,
// e.g. pushed with `prisma db push` before this repo grew migrations): the
// newest migration whose sentinel exists decides how much of the chain is
// marked as already applied. Keep in sync with prisma/migrations/*.
export const BASELINE_SENTINELS = [
  { migration: "000000000000_init", table: "Setting" },
  { migration: "20261101000000_stage2_multiuser", table: "User" },
  { migration: "20261101050000_stage3_queue", column: ["Job", "maxAttempts"] },
  { migration: "20261101060000_stage3b_usage_storage", table: "StorageUsage" },
  { migration: "20261101070000_stage3c_job_payload", column: ["Job", "payload"] },
  { migration: "20261101110000_stage5_director", column: ["Video", "shotList"] },
  { migration: "20261101123000_stage5_world", table: "Location" },
  { migration: "20261101140000_stage5_sources", column: ["Video", "researchSources"] },
  { migration: "20261102000000_stage6_publishing", column: ["Video", "timeline"] },
  { migration: "20261102010000_stage7_billing", table: "Plan" },
  { migration: "20261102020000_stage71_billing_integrity", table: "ProcessedWebhookEvent" },
  { migration: "20261102030000_stage72_credit_reservations", column: ["CreditLedger", "reconcilesId"] },
  // S60 — the tail sentinels. The list MUST track prisma/migrations/*; it
  // had silently stopped at stage72, so a legacy database db-push'd at any
  // newer era collided with the chain's CREATE TABLEs and wedged. Two
  // disambiguations worth knowing:
  //   • auth_setting's Setting has the same NAME as init's but a different
  //     shape — init's carried updatedAt, auth_setting's does not. An
  //     init-era fingerprint (Setting WITH updatedAt) must fall through to
  //     the init sentinel, never baseline the tail.
  //   • s40/s49 fingerprint on Video columns, the same fields the dashboard
  //     routes select — the exact columns whose absence 500s /api/videos.
  {
    migration: "20261102040000_auth_setting",
    table: "Setting",
    unlessColumn: ["Setting", "updatedAt"],
  },
  { migration: "20261104140000_s20_api_token_registry", table: "ApiToken" },
  { migration: "20261105000000_s32_spend_reservations", table: "SpendReservation" },
  { migration: "20261106000000_s40_qc_enforcement", column: ["Video", "qcOverrideAt"] },
  { migration: "20261107000000_s46_auth_attempt", table: "AuthAttempt" },
  { migration: "20261107000000_s49_content_policy", column: ["Video", "contentPolicy"] },
];

/** Pure decision: given the schema fingerprint, which migration prefix must
 *  be baselined as applied? [] when nothing matches (empty/unmanaged
 *  database — deploy the whole chain). Newest sentinel wins; the chain is
 *  cumulative, so an older sentinel implies everything before it ran. */
export function decideBaselinePrefix(
  sentinels,
  hasTable,
  hasColumn
) {
  for (let i = sentinels.length - 1; i >= 0; i--) {
    const s = sentinels[i];
    const present = s.table
      ? hasTable(s.table) &&
        !(s.unlessColumn && hasColumn(s.unlessColumn[0], s.unlessColumn[1]))
      : s.column
        ? hasColumn(s.column[0], s.column[1])
        : false;
    if (present) return sentinels.slice(0, i + 1).map((x) => x.migration);
  }
  return [];
}

/** Read the Postgres schema fingerprint: public tables + the sentinel
 *  (table, column) pairs. */
async function pgFingerprint(prisma) {
  const tables = await prisma.$queryRawUnsafe(
    `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`
  );
  const tableSet = new Set(tables.map((t) => t.name));
  const wantedTables = new Set(
    BASELINE_SENTINELS.filter((s) => s.column || s.unlessColumn)
      .map((s) => (s.column ?? s.unlessColumn)[0])
      .filter((t) => tableSet.has(t))
  );
  const columns = new Set();
  for (const table of wantedTables) {
    const cols = await prisma.$queryRawUnsafe(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = '${table}'`
    );
    for (const c of cols) columns.add(`${table}.${c.name}`);
  }
  return {
    hasTable: (t) => tableSet.has(t),
    hasColumn: (t, c) => columns.has(`${t}.${c}`),
  };
}

/** S60 — the auth_setting wedge repair. Postgres's ALTER TABLE … RENAME TO
 * renames the table but NOT its constraints: stage2's Setting →
 * LegacySetting rename leaves a PK still named "Setting_pkey" on
 * LegacySetting. auth_setting later re-creates Setting with CONSTRAINT
 * "Setting_pkey" — the names collide (42P07) and `migrate deploy` fails on
 * EVERY deploy, retried and re-failed by the recovery loop forever
 * (observed live: ~90 rolled-back auth_setting rows on the production
 * Vercel DB, one per build since 2026-11-02 — and every full-select Video
 * query 500ing because s40/s49's columns never landed). Renaming the
 * survivor un-wedges the chain. Idempotent: the guard is exactly the
 * wedge's fingerprint (survivor present, Setting absent). */
async function pgRepairSettingPkeySurvivor(prisma) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN pg_namespace ns ON ns.oid = t.relnamespace
      WHERE ns.nspname = 'public' AND t.relname = 'LegacySetting'
        AND c.conname = 'Setting_pkey'`
  );
  if (Number(rows?.[0]?.n ?? 0) === 0) return;
  const setting = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'Setting'`
  );
  if (Number(setting?.[0]?.n ?? 0) > 0) return; // auth_setting-era DB — not our wedge
  log('repair: renaming the surviving "Setting_pkey" constraint on LegacySetting (the auth_setting wedge)');
  execSql(
    "prisma/schema.prisma",
    `ALTER TABLE "LegacySetting" RENAME CONSTRAINT "Setting_pkey" TO "LegacySetting_pkey";`
  );
}

/** Pre-deploy repair for unmanaged legacy databases: the chain assumes the
 *  init schema's table set, but a legacy DB pushed from a slightly OLDER
 *  Stage-1 snapshot can be missing tables init expects (observed live: no
 *  VoiceProfile on the production Vercel DB — stage2's
 *  `ALTER TABLE "VoiceProfile" ADD COLUMN …` then fails on a missing
 *  relation, wedging the chain). Creating the missing table in init's exact
 *  shape (CREATE TABLE IF NOT EXISTS — a no-op on healthy databases) lets
 *  the unmodified chain apply cleanly. */
async function pgRepairMissingInitTables(prisma) {
  const REPAIRS = [
    {
      table: "VoiceProfile",
      sql: `CREATE TABLE IF NOT EXISTS "VoiceProfile" (
        "id" TEXT NOT NULL,
        "name" TEXT NOT NULL,
        "provider" TEXT NOT NULL DEFAULT 'zhipu',
        "providerVoiceId" TEXT NOT NULL,
        "sourceLabel" TEXT,
        "durationSec" DOUBLE PRECISION,
        "auditionWav" TEXT,
        "sampleWav" TEXT,
        "isActive" BOOLEAN NOT NULL DEFAULT true,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL,
        CONSTRAINT "VoiceProfile_pkey" PRIMARY KEY ("id")
      );
      CREATE INDEX IF NOT EXISTS "VoiceProfile_isActive_idx" ON "VoiceProfile"("isActive");
      CREATE INDEX IF NOT EXISTS "VoiceProfile_provider_idx" ON "VoiceProfile"("provider");`,
    },
  ];
  for (const r of REPAIRS) {
    const present = await prisma.$queryRawUnsafe(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '${r.table}'`
    );
    if (Number(present?.[0]?.n ?? 0) === 0) {
      log(`repair: creating missing legacy table ${r.table} (init shape)`);
      execSql("prisma/schema.prisma", r.sql);
    }
  }
}

/** Baseline + deploy for a Postgres database (see header). Drops nothing:
 *  `migrate resolve --applied` only RECORDS history; `migrate deploy`
 *  applies pending migrations from the chain. */
async function postgresMigrate(prisma) {
  await pgRepairMissingInitTables(prisma);
  await pgRepairSettingPkeySurvivor(prisma);

  const historyRows = await prisma.$queryRawUnsafe(
    `SELECT COUNT(*)::int AS n FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = '_prisma_migrations'`
  );
  const managed = Number(historyRows?.[0]?.n ?? 0) > 0;

  if (!managed) {
    const fp = await pgFingerprint(prisma);
    const prefix = decideBaselinePrefix(BASELINE_SENTINELS, fp.hasTable, fp.hasColumn);
    if (prefix.length > 0) {
      log(
        `unmanaged schema detected (newest sentinel: ${prefix[prefix.length - 1]}) — ` +
          `baselining ${prefix.length} migration(s) as applied`
      );
      for (const migration of prefix) {
        run(["migrate", "resolve", "--applied", migration, "--schema", "prisma/schema.prisma"]);
      }
    } else {
      log("empty/unfingerprinted database — the full chain will be applied");
    }
  } else {
    // Recovery: a migration row stuck finished_at=NULL / rolled_back_at=NULL
    // (a deploy interrupted mid-run — e.g. a cancelled build — or a genuinely
    // failing migration) BLOCKS the whole chain: "New migrations cannot be
    // applied before the error is recovered from". The transaction already
    // rolled the SQL back, so resolving as rolled-back is safe and is
    // Prisma's documented production recovery; deploy then retries it.
    const failed = await prisma.$queryRawUnsafe(
      `SELECT migration_name FROM "_prisma_migrations"
        WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL`
    );
    for (const row of failed) {
      log(`failed migration row detected (${row.migration_name}) — resolving as rolled back for retry`);
      run(["migrate", "resolve", "--rolled-back", String(row.migration_name), "--schema", "prisma/schema.prisma"]);
    }
  }

  log("running prisma migrate deploy");
  run(["migrate", "deploy", "--schema", "prisma/schema.prisma"]);
}

async function main() {
  const { PrismaClient } = await import(join(root, "node_modules", "@prisma/client", "index.js"));
  const prisma = new PrismaClient();

  try {
    if (!isSqlite) {
      log("Postgres detected — baseline detection + migrate deploy");
      await postgresMigrate(prisma);
      const orgs = await prisma.organization.count();
      log(`organizations present: ${orgs}`);
      return;
    }

    log("SQLite detected — stage 2 transition");

    // ---------- phase 1: nullable columns + backfill + rename ----------
    const videoCols = await prisma.$queryRawUnsafe(
      `PRAGMA table_info("Video")`
    );
    const hasOrgCol = videoCols.some((c) => c.name === "organizationId");
    const tables = await prisma.$queryRawUnsafe(
      `SELECT name FROM sqlite_master WHERE type='table'`
    );
    const tableNames = new Set(tables.map((t) => t.name));
    const hasSetting = tableNames.has("Setting");
    const hasLegacy = tableNames.has("LegacySetting");

    if (!hasOrgCol) {
      const statements = [];
      for (const t of TENANT_TABLES) {
        if (!tableNames.has(t)) continue; // fresh db — db push creates it outright
        statements.push(`ALTER TABLE "${t}" ADD COLUMN "organizationId" TEXT;`);
      }
      if (tableNames.has("Activity"))
        statements.push(`ALTER TABLE "Activity" ADD COLUMN "userId" TEXT;`);
      if (tableNames.has("Job"))
        statements.push(`ALTER TABLE "Job" ADD COLUMN "userId" TEXT;`);
      for (const t of TENANT_TABLES) {
        if (!tableNames.has(t)) continue;
        statements.push(
          `UPDATE "${t}" SET "organizationId" = 'default' WHERE "organizationId" IS NULL;`
        );
      }
      log(`phase 1: ${statements.length} statements (add columns + backfill)`);
      execSql("prisma/schema.sqlite.prisma", statements.join("\n"));
    } else {
      log("phase 1: organizationId already present — skipping");
    }

    if (hasSetting && !hasLegacy) {
      log("phase 1: renaming Setting -> LegacySetting (data preserved)");
      execSql("prisma/schema.sqlite.prisma", `ALTER TABLE "Setting" RENAME TO "LegacySetting";`);
    } else if (hasLegacy) {
      log("phase 1: LegacySetting already present — skipping rename");
    }

    // ---------- phase 2: db push (idempotent) ----------
    log("phase 2: prisma db push (sqlite)");
    run(["db", "push", "--schema", "prisma/schema.sqlite.prisma", "--skip-generate"]);

    // ---------- phase 3: bootstrap org + one-owner-per-org index ----------
    // Only rows still parked under 'default' count as legacy content — rows
    // owned by registered users' organizations must never re-trigger this.
    const counts = await Promise.all([
      prisma.video.count({ where: { organizationId: "default" } }),
      prisma.channel.count({ where: { organizationId: "default" } }),
      prisma.character.count({ where: { organizationId: "default" } }),
      prisma.researchSession.count({ where: { organizationId: "default" } }),
      prisma.scheduleSlot.count({ where: { organizationId: "default" } }),
      prisma.activity.count({ where: { organizationId: "default" } }),
      prisma.voiceProfile.count({ where: { organizationId: "default" } }),
      prisma.musicTrack.count({ where: { organizationId: "default" } }),
      prisma.job.count({ where: { organizationId: "default" } }),
    ]);
    const legacyContent = counts.reduce((a, b) => a + b, 0);
    if (legacyContent > 0) {
      await prisma.organization.upsert({
        where: { id: "default" },
        update: {},
        create: {
          id: "default",
          name: "Studio",
          slug: "studio",
        },
      });
      log(`phase 3: bootstrap organization 'default' ensured (${legacyContent} legacy rows parked under it)`);
    } else {
      log("phase 3: no legacy content under 'default' — bootstrap org not needed");
      // An earlier run may have created an empty 'default' org (pre-fix the
      // count included owned rows) — drop it when it is truly empty.
      const members = await prisma.membership.count({ where: { organizationId: "default" } });
      if (members === 0) {
        await prisma.organization
          .deleteMany({ where: { id: "default" } })
          .catch(() => {});
      }
    }

    execSql(
      "prisma/schema.sqlite.prisma",
      `CREATE UNIQUE INDEX IF NOT EXISTS "Membership_one_owner_per_org"
       ON "Membership"("organizationId") WHERE "role" = 'owner';`
    );
    log("phase 3: Membership_one_owner_per_org partial index ensured");
  } finally {
    await prisma.$disconnect();
  }
}

// Run as a script; the exports above (BASELINE_SENTINELS, decideBaselinePrefix)
// stay importable from the unit suite.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[migrate-stage2] FAILED:", err);
    process.exit(1);
  });
}
