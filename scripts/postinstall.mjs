// Conditional Prisma bootstrap — runs on every `npm install` (postinstall).
//
// Why: this project supports two database modes (see SETUP.md):
//   - SQLite  (local dev / sandbox preview):  DATABASE_URL=file:... + prisma/schema.sqlite.prisma
//   - Postgres (Vercel / production):         DATABASE_URL=postgres://... + prisma/schema.prisma
// A bare `prisma generate` (the old postinstall) always produced the Postgres
// client, which crashes at runtime when DATABASE_URL is a file: URL. This
// script picks the right schema from the URL protocol, and for SQLite mode
// also pushes the schema (creating the .db file if it is missing), so a fresh
// clone / sandbox relaunch boots straight into a working app.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const prismaBin = join(root, 'node_modules', '.bin', 'prisma');

const run = (args) =>
  execFileSync(prismaBin, args, { stdio: 'inherit', cwd: root });

// 1. Resolve DATABASE_URL (from .env, with a SQLite fallback if absent).
let url = '';
if (existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(
    /^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m
  );
  url = m ? m[1].trim() : '';
}
if (!url) {
  // Relative file: paths are resolved by Prisma against the schema directory
  // (prisma/), so ../db/custom.db lands in <project>/db/custom.db.
  url = 'file:../db/custom.db';
  writeFileSync(envPath, `DATABASE_URL=${url}\n`, { flag: 'wx' });
  console.log(`[postinstall] created .env with DATABASE_URL=${url}`);
}

// 2. Pick the matching schema and (re)generate the client.
const isSqlite = url.startsWith('file:');
const schema = isSqlite ? 'prisma/schema.sqlite.prisma' : 'prisma/schema.prisma';
console.log(`[postinstall] DATABASE_URL protocol: ${isSqlite ? 'file: (SQLite)' : 'postgres'}`);
console.log(`[postinstall] prisma generate --schema ${schema}`);
run(['generate', '--schema', schema]);

// 3. SQLite mode: push the schema so the .db file exists before first query.
//    (Idempotent — a no-op when the database is already in sync.)
if (isSqlite) {
  console.log('[postinstall] prisma db push (sqlite) — creates db file if missing');
  run(['db', 'push', '--schema', 'prisma/schema.sqlite.prisma', '--skip-generate']);
}

console.log('[postinstall] done');
