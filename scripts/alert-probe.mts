#!/usr/bin/env node
/**
 * S103 / P1.1 — the operational alert probe (docs/production-readiness.md).
 *
 *   npm run alert:probe
 *
 * Exit 0 = healthy · exit 1 = one or more ALERTs. Designed for a cron job or
 * an uptime monitor: every failing check prints ONE actionable line
 * (`[ALERT] <check> — <what to do>`), and the last line is
 * `HEALTH <n> failed` for machine scraping. Checks are cheap (all O(1)
 * queries) so the probe can run every minute against production.
 *
 * Checks:
 *   db            — the database answers a trivial query
 *   columns       — full-projection probes on Job + StorageReservation: a
 *                   migration that failed to deploy surfaces HERE (the S60
 *                   P2022 class) instead of as mystery route 500s
 *   backlog       — the oldest pending job's age (a wedged queue)
 *   stale-leases  — running rows whose lease deadline passed (S100): a dead
 *                   worker without a live reaper
 *   migrations    — Postgres only: every migration dir has a finished row in
 *                   _prisma_migrations (a stuck chain)
 *   secrets       — TUBEFORGE_AUTH_SECRET + TUBEFORGE_ENCRYPTION_KEY present
 *                   (env or .env — the middleware fails closed without them)
 *   disk          — free bytes on the upload root
 *   backups       — opt-in (TUBEFORGE_ALERT_BACKUPS_DIR): the newest backup
 *                   artifact's age — the runbook's "nightly dump missing"
 *                   failure mode, detected instead of assumed
 *
 * Thresholds: TUBEFORGE_ALERT_PENDING_MAX_MS (default 15 min),
 * TUBEFORGE_ALERT_STALE_LEASES_MAX (default 5),
 * TUBEFORGE_ALERT_DISK_MIN_MB (default 500),
 * TUBEFORGE_ALERT_BACKUP_MAX_AGE_H (default 26).
 */

import { existsSync, readFileSync, statfsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaClient } from "@prisma/client";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function num(name: string, fallback: number): number {
  const v = Number(process.env[name] ?? "");
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
const PENDING_MAX_MS = num("TUBEFORGE_ALERT_PENDING_MAX_MS", 15 * 60_000);
const STALE_LEASES_MAX = num("TUBEFORGE_ALERT_STALE_LEASES_MAX", 5);
const DISK_MIN_MB = num("TUBEFORGE_ALERT_DISK_MIN_MB", 500);
const BACKUP_MAX_AGE_H = num("TUBEFORGE_ALERT_BACKUP_MAX_AGE_H", 26);

const alerts: string[] = [];
function alert(check: string, detail: string): void {
  alerts.push(check);
  console.log(`[ALERT] ${check} — ${detail}`);
}

function dbUrl(): string {
  let url = (process.env.DATABASE_URL ?? "").trim();
  if (!url) {
    const envFile = path.join(ROOT, ".env");
    if (existsSync(envFile)) {
      const m = readFileSync(envFile, "utf8").match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
      url = m ? m[1].trim() : "";
    }
  }
  return url;
}

/** env var from the environment or the .env file (the postinstall parse). */
function secret(key: string): string {
  if ((process.env[key] ?? "").trim()) return process.env[key] as string;
  const envFile = path.join(ROOT, ".env");
  if (existsSync(envFile)) {
    const m = readFileSync(envFile, "utf8").match(new RegExp(`^${key}=(.+)$`, "m"));
    if (m) return m[1].trim();
  }
  return "";
}

function isPostgres(): boolean {
  return dbUrl().startsWith("postgres");
}

async function main(): Promise<void> {
  const db = new PrismaClient();
  try {
    // 1. the database answers.
    try {
      await db.$queryRaw`SELECT 1`;
    } catch (err) {
      alert("db", `database unreachable — routes are down: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 2. column reality — full-projection probes (a failed migration 500s
    //    the queue + upload routes; surface it as an alert, not a mystery).
    try {
      await db.job.findMany({ take: 1 });
    } catch (err) {
      alert("columns", `Job projection failed (S100 lease columns deployed?) — ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await db.storageReservation.findMany({ take: 1 });
    } catch (err) {
      alert("columns", `StorageReservation projection failed (S101 deployed?) — ${err instanceof Error ? err.message : String(err)}`);
    }

    // 3. the pending backlog's age — a wedged queue surfaces here.
    try {
      const oldest = await db.job.findFirst({
        where: { status: "pending" },
        orderBy: { createdAt: "asc" },
        select: { createdAt: true, kind: true, entityId: true },
      });
      if (oldest) {
        const ageMs = Date.now() - oldest.createdAt.getTime();
        if (ageMs > PENDING_MAX_MS) {
          alert(
            "backlog",
            `oldest pending ${oldest.kind} job (${oldest.entityId}) is ${Math.round(ageMs / 60_000)} min old — check the worker process (npm run worker)`,
          );
        }
      }
    } catch (err) {
      alert("backlog", `could not read pending jobs — ${err instanceof Error ? err.message : String(err)}`);
    }

    // 4. stale leases — running rows past their lease deadline mean a dead
    //    worker whose reaper is not running (S100 reclaims on every tick).
    try {
      const stale = await db.job.count({
        where: { status: "running", leaseExpiresAt: { lt: new Date(Date.now() - 90_000) } },
      });
      if (stale > STALE_LEASES_MAX) {
        alert("stale-leases", `${stale} running jobs hold expired leases — the owning worker died and no reaper is ticking`);
      }
    } catch {
      /* covered by the columns probe */
    }

    // 5. migration chain completeness — Postgres only (SQLite is db-push).
    if (isPostgres()) {
      try {
        const rows = (await db.$queryRawUnsafe(
          `SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL`,
        )) as { n: number }[];
        if (Number(rows[0]?.n ?? 0) > 0) {
          alert("migrations", `${rows[0].n} migration(s) stuck (finished_at NULL) — run the S60 self-heal: node scripts/postinstall.mjs`);
        }
      } catch (err) {
        alert("migrations", `could not read _prisma_migrations — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 6. the fail-closed secrets exist.
    for (const key of ["TUBEFORGE_AUTH_SECRET", "TUBEFORGE_ENCRYPTION_KEY"]) {
      if (!secret(key)) alert("secrets", `${key} missing — the middleware fails closed; provision it before restart`);
    }

    // 7. disk headroom on the upload root.
    try {
      const uploadRoot = process.env.TUBEFORGE_UPLOAD_ROOT ?? path.join(ROOT, "uploads");
      if (existsSync(uploadRoot)) {
        const fs = statfsSync(uploadRoot);
        const freeMb = (Number(fs.bavail) * Number(fs.bsize)) / (1024 * 1024);
        if (freeMb < DISK_MIN_MB) {
          alert("disk", `${Math.round(freeMb)} MB free on ${uploadRoot} (floor ${DISK_MIN_MB} MB) — uploads will fail soon`);
        }
      }
    } catch {
      /* a missing/unreadable fs on exotic platforms is not an alert */
    }

    // 8. backup freshness — opt-in (the operator points the probe at the
    //    backup dir; the runbook's "nightly dump missing" failure mode).
    const backupsDir = process.env.TUBEFORGE_ALERT_BACKUPS_DIR ?? "";
    if (backupsDir && existsSync(backupsDir)) {
      const { readdirSync, statSync } = await import("node:fs");
      const newest = readdirSync(backupsDir)
        .map((f) => statSync(path.join(backupsDir, f)).mtimeMs)
        .sort((a, b) => b - a)[0];
      if (!newest) {
        alert("backups", `${backupsDir} is empty — the nightly dump cron is dead (runbook §2/§5)`);
      } else {
        const ageH = (Date.now() - newest) / 3_600_000;
        if (ageH > BACKUP_MAX_AGE_H) {
          alert("backups", `newest backup in ${backupsDir} is ${Math.round(ageH)} h old (max ${BACKUP_MAX_AGE_H} h) — the nightly dump cron is dead`);
        }
      }
    }
  } finally {
    await db.$disconnect().catch(() => {});
  }

  console.log(`HEALTH ${alerts.length} failed`);
  process.exit(alerts.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("alert-probe: crashed —", err instanceof Error ? err.message : String(err));
  console.log("HEALTH 1 failed");
  process.exit(1);
});
