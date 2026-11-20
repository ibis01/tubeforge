// The dialect-by-protocol law for the bare `db:push` entry — the same law
// postinstall.mjs already enforces for generate/push during install.
//
// Why: the boot chain (.zscripts/dev.sh) runs `bun run db:push` with no
// --schema flag. A bare `prisma db push` reads prisma.config.ts, whose
// schema is the POSTGRES one, so a SQLite sandbox (DATABASE_URL=file:...)
// crashed the boot with P1012 — "the URL must start with the protocol
// `file:`" — even after a successful install. This script picks the right
// schema from the URL protocol, exactly like postinstall.mjs does.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const envPath = join(root, '.env');

// Resolve DATABASE_URL with the postinstall.mjs precedence: process env
// FIRST (Vercel/CI inject it there), then the local .env, then the SQLite
// fallback for fresh clones (postinstall will already have written the .env
// by the time the boot chain reaches db:push, so this branch is a safety
// net for bare invocations).
let url = (process.env.DATABASE_URL || '').trim();
if (!url && existsSync(envPath)) {
  const m = readFileSync(envPath, 'utf8').match(
    /^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m
  );
  url = m ? m[1].trim() : '';
}
if (!url) url = 'file:../db/custom.db';

const isSqlite = url.startsWith('file:');
const schema = isSqlite ? 'prisma/schema.sqlite.prisma' : 'prisma/schema.prisma';
console.log(`[db-push] DATABASE_URL protocol: ${isSqlite ? 'file: (SQLite)' : 'postgres'}`);
console.log(`[db-push] prisma db push --schema ${schema}`);

execFileSync(
  'prisma',
  ['db', 'push', '--accept-data-loss', '--schema', schema],
  { stdio: 'inherit', cwd: root }
);
