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
//   2. Postgres (production):
//        prisma migrate deploy — prisma/migrations/*_stage2_multiuser does all
//        of the above in SQL (ADD COLUMN ... DEFAULT 'default' + DROP DEFAULT,
//        RENAME, bootstrap org, partial index).
//
// WHY THE BOOTSTRAP ORG EXISTS: legacy single-user data must keep a tenant
// after the schema change. It is parked under organization 'default' until the
// first person registers AND proves the old studio password; the register
// claim flow (src/app/api/auth/register) then transfers it to their own new
// organization and migrates the LegacySetting rows (see ROADMAP Stage 2).
//
// Run it with: npm run migrate:stage2 (also called by setup:local).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

// --- resolve DATABASE_URL the same way postinstall.mjs does ---
let url = "";
const envPath = join(root, ".env");
if (existsSync(envPath)) {
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

async function main() {
  const { PrismaClient } = await import(join(root, "node_modules", "@prisma/client", "index.js"));
  const prisma = new PrismaClient();

  try {
    if (!isSqlite) {
      log("Postgres detected — running prisma migrate deploy");
      run(["migrate", "deploy", "--schema", "prisma/schema.prisma"]);
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

main().catch((err) => {
  console.error("[migrate-stage2] FAILED:", err);
  process.exit(1);
});
