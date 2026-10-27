#!/usr/bin/env bun
// TubeForge recovery — locked out? This switches the studio back to OPEN.
//
//   bun run auth:reset            turn the lock off (your saved password is kept)
//   bun run auth:reset --purge    turn the lock off AND forget the password
//                                 (next enable will ask for a brand-new one)
//
// Safe to run while the dev server is up: it edits the same SQLite file and
// removes the db/auth.lock flag the middleware hot-checks.

import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const purge = process.argv.includes("--purge") || process.argv.includes("-p");

// Resolve the SQLite file from DATABASE_URL (fall back to the usual spots).
function resolveDb(): string {
  const raw = (() => {
    try {
      const env = fs.readFileSync(path.join(root, ".env"), "utf8");
      return env.match(/^DATABASE_URL=(.*)$/m)?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
    } catch {
      return "";
    }
  })();
  const candidates: string[] = [];
  if (raw.startsWith("file:")) {
    const p = raw.slice(5);
    candidates.push(path.resolve(root, p), path.resolve(root, "prisma", p));
  }
  candidates.push(
    path.join(root, "db", "custom.db"),
    path.join(root, "prisma", "dev.db"),
    path.join(root, "dev.db")
  );
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("Could not locate the SQLite database — looked in:\n  " + candidates.join("\n  "));
}

const dbPath = resolveDb();
const db = new Database(dbPath);
db.exec("CREATE TABLE IF NOT EXISTS \"Setting\" (\"key\" TEXT PRIMARY KEY, \"value\" TEXT)");

const setLock = db.prepare(
  `INSERT INTO "Setting" ("key", "value", "updatedAt") VALUES ('auth.enabled', 'false', datetime('now'))
   ON CONFLICT("key") DO UPDATE SET "value" = 'false', "updatedAt" = datetime('now')`
);
setLock.run();

if (purge) {
  db.prepare(`DELETE FROM "Setting" WHERE "key" = 'auth.password'`).run();
}

const flag = path.join(root, "db", "auth.lock");
fs.rmSync(flag, { force: true });

const left = db.prepare(`SELECT "value" FROM "Setting" WHERE "key" = 'auth.enabled'`).get() as
  | { value: string }
  | undefined;
db.close();

console.log(`TubeForge: lock disabled (db: ${path.relative(root, dbPath)})`);
if (purge) console.log("  saved password forgotten — enabling the lock again will ask for a new one");
else console.log("  saved password kept — Settings → Studio access can re-enable it");
console.log(`  auth.enabled = ${left?.value ?? "false"} (flag file db/auth.lock removed)`);
console.log("Reload the app — the studio is open.");
