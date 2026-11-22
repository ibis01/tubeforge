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
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');
const prismaBin = join(root, 'node_modules', '.bin', 'prisma');

// 1. Resolve DATABASE_URL. Precedence: platform env var FIRST (Vercel/CI
//    inject it there and ship no .env file — reading only .env made this
//    script pick SQLite mode on Vercel and crash `prisma db push` with P1012
//    "the URL must start with the protocol `file:`"), then the local .env
//    file, then the SQLite fallback for fresh clones.
let url = (process.env.DATABASE_URL || '').trim();
if (!url && existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(
    /^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m
  );
  url = m ? m[1].trim() : '';
}
if (!url) {
  // The sandbox contract (pinned verbatim by the clean-clone verifier):
  // the SQLite path is SCHEMA-DIR-relative — '../db/custom.db' means
  // <project>/db/custom.db. Prisma 6 resolved it against the schema dir;
  // under v7 the CLI resolves against the CWD, so the CLI children below
  // get the schema-ANCHORED ABSOLUTE form instead.
  url = 'file:../db/custom.db';
  try {
    writeFileSync(envPath, `DATABASE_URL=${url}\n`, { flag: 'wx' });
    console.log(`[postinstall] created .env with DATABASE_URL=${url}`);
  } catch {
    /* read-only fs (e.g. Vercel) — platform env vars are used instead */
  }
}

// Production guard: SQLite on Vercel's ephemeral serverless filesystem
// silently loses every DB write on cold start — settings, provider configs,
// users, jobs all vanish after a reload, which is exactly the
// "settings don't persist" symptom. The fallback above is correct for
// local dev / the sandbox, but on Vercel it is a data-loss trap. Fail the
// build LOUDLY so the missing DATABASE_URL is fixed in the Vercel dashboard
// instead of corrupting every user's data. (CI / GitHub Actions do not set
// VERCEL, so test suites that intentionally use SQLite are unaffected.)
if (
  (process.env.VERCEL === '1' || process.env.VERCEL_ENV) &&
  url.startsWith('file:')
) {
  console.error(
    '\n[postinstall] FATAL: SQLite (file: URL) detected on Vercel.\n' +
      "Vercel's serverless filesystem is EPHEMERAL — every DB write (settings, " +
      'provider configs, users) is lost on cold start, so the app appears to ' +
      'save correctly then reverts to defaults after reload.\n\n' +
      'FIX: set DATABASE_URL to a durable Postgres connection string in\n' +
      'Vercel → Project → Settings → Environment Variables.\n' +
      'Free options: Neon (neon.tech), Vercel Postgres, or Supabase.\n' +
      'Example: postgresql://user:pass@ep-xxx.us-east-2.aws.neon.tech/dbname?sslmode=require\n' +
      'Then redeploy. Local dev / sandbox (no VERCEL env) keeps the SQLite fallback.\n'
  );
  process.exit(1);
}

// S186 — the STABLE-SECRETS guard (same forcing function as the guard above).
// The pre-guard behavior provisioned a RANDOM TUBEFORGE_AUTH_SECRET /
// TUBEFORGE_ENCRYPTION_KEY into a build-time .env whenever the platform env
// lacked them — so every redeploy rotated the encryption key and made every
// saved provider credential unreadable (getCapability then silently showed
// defaults — the same "settings revert after redeploy" incident). Production
// must never boot with absent or rotating secrets: fail the build with the
// exact fix instead. Local dev / sandbox / CI (no VERCEL env) keep the
// auto-provisioning path below.
if (process.env.VERCEL === '1' || process.env.VERCEL_ENV) {
  const missing = [];
  for (const key of ['TUBEFORGE_AUTH_SECRET', 'TUBEFORGE_ENCRYPTION_KEY']) {
    const value = (process.env[key] || '').trim();
    if (value.length < 16) missing.push(key);
  }
  if (missing.length) {
    console.error(
      `\n[postinstall] FATAL: ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} missing or too short (<16 chars) on Vercel.\n` +
        'TUBEFORGE_AUTH_SECRET signs every session — without it sign-in 503s.\n' +
        'TUBEFORGE_ENCRYPTION_KEY encrypts saved provider API keys — without it\n' +
        'key saves fail, and auto-provisioning a fresh one per build would make\n' +
        'every previously saved key unreadable after each redeploy.\n\n' +
        'FIX: set BOTH in Vercel → Project → Settings → Environment Variables\n' +
        '(generate each once with `openssl rand -hex 32`) and NEVER rotate\n' +
        'TUBEFORGE_ENCRYPTION_KEY without re-entering saved provider keys.\n' +
        'Then redeploy. Local dev / sandbox keeps the auto-provision fallback.\n'
    );
    process.exit(1);
  }
}

// Prisma 7 resolves relative file: URLs against the process CWD — the v6
// connector resolved them against the SCHEMA directory (prisma/), and
// restore-drill.mts + test-backup.mts still do exactly that. Keep ONE
// convention: anchor every relative file: URL at <root>/prisma/ so the CLI
// children push <project>/db/custom.db regardless of the v7 CWD rule.
if (url.startsWith('file:')) {
  const p = url.slice('file:'.length);
  if (p && !p.startsWith('/')) url = `file:${join(root, 'prisma', p)}`;
}

// Prisma 7 (the U2 migration): the CLI no longer auto-loads .env —
// prisma.config.ts's env("DATABASE_URL") reads the PROCESS env only. This
// script is the component that resolved the URL above (platform env → .env
// → SQLite fallback), so it must HAND it to every CLI child. Without this,
// a fresh clone / CI runner (no platform env var) crashed `prisma generate`
// with PrismaConfigEnvError: "Cannot resolve environment variable:
// DATABASE_URL" — five of eight CI jobs died in this one step.
const run = (args) =>
  execFileSync(prismaBin, args, {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
  });

// 1b. Stage 2 — provision the signing + encryption secrets when missing so a
// fresh clone / CI checkout boots usable (the middleware fails CLOSED without
// them). Best-effort: on read-only filesystems the platform provides them.
if (existsSync(envPath)) {
  try {
    let env = readFileSync(envPath, 'utf8');
    // P1-1 (external security review) — 32 random bytes as 64 hex chars: the
    // 256-bit entropy SECURITY.md documents ("32+ hex chars"). The old
    // base64url(24 bytes) was ~32 chars of mixed alphabet, which the
    // getAuthSecret weak-secret warning would flag forever.
    const rand = () => randomBytes(32).toString('hex');
    for (const [key, note] of [
      ['TUBEFORGE_AUTH_SECRET', 'signs session/api tokens'],
      ['TUBEFORGE_ENCRYPTION_KEY', 'encrypts secrets at rest'],
    ]) {
      if (!new RegExp(`^${key}=.*`, 'm').test(env)) {
        env += (env.endsWith('\n') || env === '' ? '' : '\n') + `${key}=${rand()}\n`;
        console.log(`[postinstall] provisioned ${key} (${note}) — replace it in production`);
      }
    }
    writeFileSync(envPath, env);
  } catch {
    /* best-effort only */
  }
}

// 1c. Ensure next-env.d.ts exists before any `tsc --noEmit` can run.
//     Next regenerates this file on `next dev`/`next build`, but it is
//     gitignored — so a fresh clone (or a CI runner that typechecks before
//     building) lacks it and tsc fails on static image imports
//     (`@/assets/scene-a.jpg` etc. need next/image-types/global).
//     Idempotent: never overwrites an existing (possibly newer) file.
const nextEnvPath = join(root, 'next-env.d.ts');
if (!existsSync(nextEnvPath)) {
  try {
    writeFileSync(
      nextEnvPath,
      '/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// NOTE: This file should NOT be checked into version control.\n// It is regenerated by `next dev` / `next build`.\n'
    );
    console.log('[postinstall] created next-env.d.ts (image import types for tsc)');
  } catch {
    /* read-only fs — `next build` will create it later */
  }
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
  run(['db', 'push', '--schema', 'prisma/schema.sqlite.prisma']);
}

// 4. Stage 2+ transition — BOTH providers, idempotent. On SQLite this is the
//    legacy column/rename/bootstrap-org transition; on Postgres (Vercel) it
//    baselines an unmanaged database against prisma/migrations and deploys
//    the chain — a deploy is the only moment the production schema gets
//    synced, so without this every route fails on missing tables (P2021)
//    the moment a new migration lands.
//    Postgres failures are NON-FATAL by design: an unreachable database at
//    build time (or a migration that needs human review) must not wedge the
//    deployment pipeline — the runtime errors stay readable in the API
//    responses, and the warning below lands in the build logs.
console.log('[postinstall] running scripts/migrate-stage2.mjs (idempotent)');
try {
  // 150s cap — a hung database connection (unreachable host, blackholed TCP)
  // must not wedge the install until the platform's build timeout kills it.
  // DATABASE_URL is injected so the child's prisma.config.ts resolves the
  // same URL this script resolved (Prisma 7 reads the process env only).
  execFileSync('node', ['scripts/migrate-stage2.mjs'], {
    stdio: 'inherit',
    cwd: root,
    timeout: 150_000,
    env: { ...process.env, DATABASE_URL: url },
  });
} catch (err) {
  if (isSqlite) throw err; // local dev wants loud failures
  console.warn(
    '[postinstall] WARNING: Postgres migration failed — deploying WITHOUT schema sync. ' +
      'Database-backed routes will surface the underlying error until this is fixed. ' +
      `Reason: ${String(err?.message ?? err).slice(0, 200)}`
  );
}

console.log('[postinstall] done');
