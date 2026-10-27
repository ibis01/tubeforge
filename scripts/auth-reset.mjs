#!/usr/bin/env node
// TubeForge recovery — locked out? This switches the studio back to OPEN.
// Node version: works anywhere the app runs (no bun required).
//
//   npm run auth:reset            turn the lock off (your saved password is kept)
//   npm run auth:reset --purge    turn the lock off AND forget the password
//                                 (next enable will ask for a brand-new one)
//
// Safe to run while the dev server is up: it flips the auth.enabled row via
// prisma and removes the db/auth.lock flag file the middleware hot-checks.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const purge = process.argv.includes("--purge") || process.argv.includes("-p");
const root = process.cwd();

if (!fs.existsSync(path.join(root, "prisma", "schema.prisma"))) {
  console.error("Run this from the tubeforge folder (prisma/schema.prisma not found).");
  process.exit(1);
}

const sql = `INSERT INTO "Setting" ("key", "value", "updatedAt")
VALUES ('auth.enabled', 'false', datetime('now'))
ON CONFLICT("key") DO UPDATE SET "value" = 'false', "updatedAt" = datetime('now');
${purge ? `DELETE FROM "Setting" WHERE "key" = 'auth.password';\n` : ""}`;

const r = spawnSync(
  "npx",
  ["prisma", "db", "execute", "--stdin", "--schema", "prisma/schema.prisma"],
  { input: sql, encoding: "utf8", shell: process.platform === "win32" }
);
if (r.status !== 0) {
  console.error(r.stderr || "prisma db execute failed");
  process.exit(1);
}

fs.rmSync(path.join(root, "db", "auth.lock"), { force: true });

console.log("TubeForge: lock disabled");
if (purge) console.log("  saved password forgotten — enabling the lock again will ask for a new one");
else console.log("  saved password kept — Settings → Studio access can re-enable it");
console.log("Reload the app — the studio is open.");
