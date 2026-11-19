// GET /api/diag — deployment diagnostic (added while fixing the Vercel
// registration 500s; kept for AUTHENTICATED incident triage). S61 removed it
// from PUBLIC_API: the S60 record's owner checklist and this file's own
// header both called for closing the public exposure once the incident was
// confirmed healed (it was — the DB self-healed ~4 minutes after the S60
// deploy). Since then a session cookie or Bearer token is required, like
// every other /api/* endpoint. Returns ONLY booleans/protocols and the
// redacted import/query error text — never env values, never connection
// strings.
//
// P0-2 (external security review, 2026-11) — the middleware's signature check
// alone let a revoked-but-unexpired session read this, and the shared DB rate
// limiter never ran for it. requireUser() now guards the route in-handler
// (instant revocation + the shared per-IP limiter), and the migration/
// table-name listing is SESSION-ONLY: a 90-day API bearer still triages
// booleans/protocols but never sees the schema inventory (the review's
// information-hygiene note).
import { NextRequest, NextResponse } from "next/server";
import { requireUser, sessionIdFromRequest } from "@/lib/tubeforge/tenant";

const redact = (s: string) =>
  s
    // any URL-ish token (postgres://user:pass@host/db) → scheme://[redacted]
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/gi, (m) => `${m.split("://")[0]}://[redacted]`)
    // host:port fragments Prisma prints in errors
    .replace(/\b([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?\b/gi, "[host]$2")
    .slice(0, 600);

export async function GET(req: NextRequest) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();
  const isSessionCaller = (await sessionIdFromRequest(req)) !== null;

  const g = globalThis as typeof globalThis & {
    __tfInstrumentation?: { ok: boolean; error?: string; at: string };
  };
  const out: Record<string, unknown> = {
    node: process.version,
    nodeEnv: process.env.NODE_ENV ?? null,
    instrumentation: g.__tfInstrumentation ?? "not-run",
    env: {
      // booleans + protocol only — never the values
      databaseUrl: process.env.DATABASE_URL
        ? { present: true, protocol: process.env.DATABASE_URL.split("://")[0] ?? "?" }
        : { present: false },
      authSecret: (process.env.TUBEFORGE_AUTH_SECRET ?? "").length >= 16,
      encryptionKey: (process.env.TUBEFORGE_ENCRYPTION_KEY ?? "").length >= 16,
    },
  };

  // 1. Can the db module even load? (module-level throw = the HTML-500 class)
  try {
    const mod = (await import("@/lib/db")) as { db: { $queryRawUnsafe: (sql: string) => Promise<unknown> } };
    out.dbImport = "ok";
    // 2. Can it talk to the database?
    try {
      await mod.db.$queryRawUnsafe("SELECT 1 AS ok");
      out.dbQuery = "ok";
      try {
        const tables = (await mod.db.$queryRawUnsafe(
          "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'"
        )) as { n: number }[];
        const migrations = (await mod.db.$queryRawUnsafe(
          "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_name = '_prisma_migrations'"
        )) as { n: number }[];
        const migrationsTable = Number(migrations?.[0]?.n ?? -1) === 1;
        const tableList = (await mod.db.$queryRawUnsafe(
          `SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public' ORDER BY 1`
        )) as { name: string }[];
        out.schema = {
          publicTables: Number(tables?.[0]?.n ?? -1),
          migrationsTable,
          // the table-name inventory is signed-in-browser triage only; bearer
          // callers get the counts without the names (P0-2 hygiene).
          tableNames: isSessionCaller ? tableList.map((t) => t.name) : "session-only",
        };
        if (migrationsTable) {
          if (!isSessionCaller) {
            out.migrations = "session-only";
          } else {
            const rows = (await mod.db.$queryRawUnsafe(
              `SELECT migration_name, finished_at, rolled_back_at, applied_steps_count, logs
                 FROM _prisma_migrations ORDER BY migration_name`
            )) as {
              migration_name: string;
              finished_at: Date | null;
              rolled_back_at: Date | null;
              applied_steps_count: number;
              logs: string | null;
            }[];
            out.migrations = rows.map((r) => ({
              name: r.migration_name,
              finished: r.finished_at !== null,
              rolledBack: r.rolled_back_at !== null,
              steps: Number(r.applied_steps_count ?? 0),
              log: redact(String(r.logs ?? "")).slice(0, 240),
            }));
          }
        }
      } catch (e) {
        out.schemaProbe = redact(e instanceof Error ? e.message : String(e));
      }
    } catch (e) {
      out.dbQuery = redact(e instanceof Error ? e.message : String(e));
    }
  } catch (e) {
    out.dbImport = redact(e instanceof Error ? `${e.message}` : String(e));
    out.dbImportStack = redact(e instanceof Error ? (e.stack ?? "").split("\n").slice(0, 5).join(" | ") : "");
  }

  return NextResponse.json(out);
}
