// Prisma 7 runtime factory (the P1012 migration): the generated client no
// longer accepts a connection URL — `datasourceUrl`/`datasources` are gone
// and every construction site must pass a driver adapter. ONE factory picks
// the adapter per DATABASE_URL protocol so the app (src/lib/db.ts), the
// boot/worker path, and every operator script share the same law:
//   file:…           → @prisma/adapter-better-sqlite3 (busy timeout 10s —
//                      the S136 contention floor, formerly the URL param)
//   postgres(ql)://… → @prisma/adapter-pg
// Plain ESM on purpose: tsx (.mts), plain node (.mjs) and the Next server
// bundler all import it without a build step.
//
// URL params: the Prisma 6 connector consumed engine params riding the URL
// (busy_timeout, socket_timeout, connection_limit…). The better-sqlite3
// adapter's url is a FILESYSTEM PATH — a param-bearing string would open a
// literal `custom.db?connection_limit=12` file (empty database, "table does
// not exist"). Strip the params: busy_timeout maps onto the adapter's
// `timeout` option; engine pool params are inert under the adapter model
// (SQLite serializes on the writer lock + busy timeout, the S136 law).
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

// DATABASE_URL resolution — the SAME precedence postinstall.mjs establishes:
// the platform env FIRST (Vercel/CI/compose inject it there), then the
// project .env. The .env fallback is NOT cosmetic: Prisma 6's client
// auto-loaded .env at runtime, the Prisma 7 adapter model does NOT — under
// U2 every tsx script, the worker and any plain-node entry without an
// exported DATABASE_URL starved ("DATABASE_URL is not set") the moment they
// touched the db; the U2 sweep was validated in a shell that carried the
// export, masking exactly this. npm scripts / next dev / the standalone
// server all run from the project root, so the CWD .env is the project's.
function resolveDatabaseUrl() {
  const direct = (process.env.DATABASE_URL || "").trim();
  if (direct) return direct;
  try {
    const envText = fs.readFileSync(path.join(process.cwd(), ".env"), "utf8");
    const m = envText.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
    if (m) return m[1].trim();
  } catch {
    /* no .env — the caller throws the honest error */
  }
  return "";
}

export function createPrismaAdapter(url = resolveDatabaseUrl()) {
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set — the Prisma 7 client needs a driver adapter and no URL to derive it from",
    );
  }
  if (url.startsWith("file:")) {
    const [pathPart, queryPart] = url.slice("file:".length).split("?", 2);
    let timeout = 10000; // the S136 busy_timeout floor (ms)
    if (queryPart) {
      for (const kv of queryPart.split("&")) {
        const [k, v] = kv.split("=", 2);
        if (k === "busy_timeout" && v && !Number.isNaN(Number(v))) {
          timeout = Number(v);
        }
      }
    }
    // ONE convention for relative SQLite paths: SCHEMA-DIR-relative (the v6
    // connector's rule, still codified in restore-drill.mts:71 and
    // test-backup.mts:71 — '../db/custom.db' = <root>/db/custom.db). Prisma
    // 7 resolves relative file: URLs against the process CWD instead, so
    // translate explicitly; absolute URLs (CI/nightly/the clean-clone probe)
    // pass through untouched.
    let dbPath = pathPart;
    if (dbPath && !dbPath.startsWith("/")) {
      dbPath = path.join(process.cwd(), "prisma", dbPath);
    }
    return new PrismaBetterSqlite3({ url: `file:${dbPath}`, timeout });
  }
  return new PrismaPg(url);
}

export function createPrisma(options = {}) {
  return new PrismaClient({ adapter: createPrismaAdapter(), ...options });
}
