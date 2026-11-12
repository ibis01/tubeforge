#!/usr/bin/env node
/**
 * S103 / P1.1 — the MEASURED restore drill (docs/production-readiness.md).
 *
 *   npm run test:drill [--out <dir>]
 *
 * The runbook's law (docs/runbooks/backup-restore.md): a backup that has
 * never been restored is a hypothesis, not a control. The quarterly manual
 * drill restores a pg_dump into a scratch Postgres; THIS script is the
 * always-on companion: it runs the full drill against the live SQLite
 * database on every CI push and MEASURES the recovery time.
 *
 * The drill, honestly:
 *   1. live      — the real DATABASE_URL (file: SQLite)
 *   2. backup    — VACUUM INTO a fresh snapshot (no sqlite3 CLI needed —
 *                  the statement runs through Prisma's raw execute)
 *   3. casualty  — a scratch "production" copy is DESTROYED (random bytes:
 *                  the lost-database scenario, not a polite delete)
 *   4. restore   — the backup bytes land in the casualty's place
 *   5. verify    — integrity_check = ok; row counts match the live DB; a
 *                  real query works; the S100 lease columns project (the
 *                  P2022 guard class); the restore actually replaced the
 *                  destroyed bytes
 *   6. RTO       — measured wall time across backup → destroy → restore →
 *                  verify
 *
 * Exit 0 = the drill held (RTO printed). Exit 1 = a restoration finding —
 * per the runbook: any error here is a finding, not a drill detail.
 */

import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The live SQLite file path — DATABASE_URL from .env, prisma-relative
 *  file: URLs resolve against prisma/ (the backup.sh parse, in Node). */
function liveDbPath(): string {
  let url = (process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    const envFile = path.join(ROOT, ".env");
    if (existsSync(envFile)) {
      const m = readFileSync(envFile, "utf8").match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
      url = m ? m[1].trim() : "";
    }
  }
  if (!url.startsWith("file:")) {
    console.error(
      "restore-drill: the automated drill runs on the SQLite lane only — the Postgres drill is the runbook's quarterly manual procedure",
    );
    process.exit(0);
  }
  let p = url.slice("file:".length);
  if (!path.isAbsolute(p)) p = path.join(ROOT, "prisma", p);
  if (!existsSync(p)) {
    console.error(`restore-drill: live database not found at ${p}`);
    process.exit(1);
  }
  return p;
}

async function withClient<T>(dbPath: string, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  const db = new PrismaClient({ datasources: { db: { url: `file:${dbPath}` } } });
  try {
    return await fn(db);
  } finally {
    await db.$disconnect().catch(() => {});
  }
}

type Counts = { videos: number; users: number; orgs: number; jobs: number };

async function counts(dbPath: string): Promise<Counts> {
  return withClient(dbPath, async (db) => ({
    videos: await db.video.count(),
    users: await db.user.count(),
    orgs: await db.organization.count(),
    jobs: await db.job.count(),
  }));
}

async function main(): Promise<void> {
  const live = liveDbPath();
  const argOut = process.argv.indexOf("--out");
  const outDir = argOut > -1 ? path.resolve(process.argv[argOut + 1]) : mkWorkDir();
  const t0 = Date.now();

  console.log(`[drill] live database: ${live}`);
  console.log(`[drill] work dir: ${outDir}`);

  // 2. backup — VACUUM INTO through the live client (hot, consistent).
  const backupPath = path.join(outDir, "drill-backup.db");
  await withClient(live, (db) => db.$executeRawUnsafe(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`));
  const backupBytes = statSync(backupPath).size;
  check("backup written (VACUUM INTO hot snapshot)", backupBytes > 0, `${backupBytes} bytes`);
  const backupHash = sha256(backupPath);

  // 3. casualty — a scratch stand-in for production, DESTROYED with noise.
  const casualty = path.join(outDir, "casualty.db");
  copyFileSync(live, casualty);
  const destroyedHash = sha256(casualty);
  writeFileSync(casualty, randomBytes(1 << 20));
  check(
    "casualty destroyed (lost-database scenario, not a polite delete)",
    destroyedHash !== sha256(casualty),
    `live copy ${destroyedHash.slice(0, 12)}… overwritten with noise`,
  );

  // 4. restore — the backup bytes land in the casualty's place.
  copyFileSync(backupPath, casualty);
  check(
    "restore executed (the artifact bytes land on the casualty path)",
    sha256(casualty) === backupHash,
    "byte-identical to the artifact",
  );

  // 5. verify the restored database is a REAL, healthy database.
  const integrity = await withClient(casualty, (db) =>
    db.$queryRawUnsafe<{ integrity_check: string }[]>("PRAGMA integrity_check"),
  );
  check("PRAGMA integrity_check = ok", integrity[0]?.integrity_check === "ok", integrity[0]?.integrity_check ?? "(no row)");

  const restored = await counts(casualty);
  const liveCounts = await counts(live);
  const same =
    restored.videos === liveCounts.videos &&
    restored.users === liveCounts.users &&
    restored.orgs === liveCounts.orgs &&
    restored.jobs === liveCounts.jobs;
  check(
    "row counts match the live database",
    same,
    `videos ${restored.videos}/${liveCounts.videos} · users ${restored.users}/${liveCounts.users} · orgs ${restored.orgs}/${liveCounts.orgs} · jobs ${restored.jobs}/${liveCounts.jobs}`,
  );

  const probeOrg = await withClient(casualty, (db) =>
    db.organization.findFirst({ select: { id: true, slug: true } }),
  );
  check(
    "a real query returns structured rows",
    probeOrg !== null && typeof probeOrg?.id === "string" && typeof probeOrg?.slug === "string",
    probeOrg ? `org ${probeOrg.id}` : "(no orgs — empty database is still a valid restore)",
  );

  await withClient(casualty, (db) => db.job.findMany({ take: 1 }));
  check("restored schema projects the S100 lease columns (the P2022 guard)", true);

  // 6. RTO — the measured recovery time.
  const rtoMs = Date.now() - t0;
  console.log("");
  console.log(`[drill] RTO (backup + destroy + restore + verify): ${rtoMs}ms`);

  if (failures > 0) {
    console.error(
      `\nrestore-drill: ${failures} assertion(s) FAILED — a restoration finding: fix before trusting the backups`,
    );
    process.exit(1);
  }
  console.log("restore-drill: the drill held — the backup is a control, not a hypothesis");
}

function mkWorkDir(): string {
  const dir = path.join(os.tmpdir(), `tf-drill-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

main().catch((err) => {
  console.error("restore-drill: crashed —", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
