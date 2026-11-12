#!/usr/bin/env node
/**
 * S99 / P0.1 — the clean-clone verifier (docs/production-readiness.md).
 *
 *   node --import tsx scripts/test-clean-clone.mts [--keep]
 *
 * Exit condition: a FRESH clone of this repository installs, bootstraps, and
 * generates deterministic Prisma clients for BOTH dialects — with zero hidden
 * local state. Every assertion prints PASS/FAIL; on failure the clone is KEPT
 * for forensics (the path is printed), on success it is removed.
 *
 * Why a second npm ci: the CI check/build/coverage jobs install the CHECKOUT,
 * which proves the tree installs but says nothing about what a contributor's
 * `git clone` experiences — tracked runtime state, a drifted SQLite schema
 * mirror, a Postgres-only generate breakage, non-deterministic client output.
 * This script is the contributor's story, executed for real:
 * clone → npm ci → boot → generate → generate again → compare bytes.
 *
 * Assertions:
 *   1. forbidden-state law — the fresh clone contains NO runtime artifacts
 *      (node_modules / .env / .next / coverage / next-env.d.ts / test-results
 *      / playwright-report / .vercel) and db/ carries only .gitkeep;
 *   2. boot proof — `npm ci` with NO injected DATABASE_URL bootstraps SQLite
 *      end-to-end: .env (file:../db/custom.db), provisioned
 *      TUBEFORGE_AUTH_SECRET + TUBEFORGE_ENCRYPTION_KEY, next-env.d.ts,
 *      the generated client, and the pushed db/custom.db;
 *   3. boot probe — the generated SQLITE client queries the pushed Stage-2
 *      schema (organization.count() against db/custom.db);
 *   4. determinism law — regenerating the SQLite client is byte-identical
 *      (sha256 manifest over node_modules/.prisma/client); the POSTGRES
 *      client generates cleanly in the same clone and regenerates
 *      byte-identically; the two dialect manifests DIFFER (a silent provider
 *      swap cannot pass);
 *   5. hygiene law — install + generation mutate NO tracked file
 *      (git status --porcelain stays empty inside the clone).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const KEEP = process.argv.includes("--keep");
let failures = 0;

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  return execFileSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).toString();
}

function shInherit(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): void {
  execFileSync(cmd, args, { cwd: opts.cwd ?? ROOT, env: opts.env, stdio: "inherit" });
}

// The fresh-clone story: NO injected database. postinstall must pick SQLite
// by the ABSENCE of a postgres URL — a leaked DATABASE_URL from the caller's
// shell would test the wrong dialect and prove nothing.
const freshEnv: NodeJS.ProcessEnv = { ...process.env };
delete freshEnv.DATABASE_URL;

// The forbidden-state law (mirrored by the S99 unit pins in test-unit.mts —
// the two lists must stay in lockstep; .gitignore is pinned separately).
const FORBIDDEN = [
  "node_modules",
  ".env",
  ".next",
  "coverage",
  "next-env.d.ts",
  "test-results",
  "playwright-report",
  ".vercel",
];

// sha256 over a sorted "relpath hash" manifest of the generated client dir.
function clientManifest(rootDir: string): string {
  const dir = join(rootDir, "node_modules", ".prisma", "client");
  const lines: string[] = [];
  const walk = (p: string, rel: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const rp = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(p, e.name), rp);
      else lines.push(`${rp} ${createHash("sha256").update(readFileSync(join(p, e.name))).digest("hex")}`);
    }
  };
  walk(dir, "");
  return lines.sort().join("\n");
}
const manifestDigest = (m: string): string => createHash("sha256").update(m).digest("hex");

const work = join(tmpdir(), `tubeforge-clean-clone-${process.pid}`);

try {
  rmSync(work, { recursive: true, force: true });

  // A dirty workspace warns (the clone tests committed HEAD only — the push
  // gate's CI run covers the delta); a clone failure fails here.
  let dirty = "";
  try {
    dirty = sh("git", ["status", "--porcelain"], { cwd: ROOT });
  } catch {
    /* git hiccups must not block the verifier itself */
  }
  if (dirty.trim()) {
    console.log(
      `[warn] workspace has uncommitted changes — the clone tests committed HEAD only (the push-gate CI run covers the delta):\n${dirty}`,
    );
  }

  console.log(`[clean-clone] git clone --depth 1 → ${work}`);
  shInherit("git", ["clone", "--depth", "1", "--quiet", `file://${ROOT}`, work], { env: freshEnv });

  // 1. forbidden state — nothing generated/ephemeral may be tracked.
  for (const f of FORBIDDEN) {
    check(`fresh clone has no ${f} (not tracked, not leaked)`, !existsSync(join(work, f)));
  }
  const dbDir = join(work, "db");
  const dbEntries = existsSync(dbDir) ? readdirSync(dbDir) : [];
  check(
    "fresh clone's db/ carries only .gitkeep",
    dbEntries.every((e) => e === ".gitkeep"),
    dbEntries.length ? dbEntries.join(", ") : "(no db dir)",
  );

  // 2. the boot proof — a real npm ci, SQLite lane, no injected URL.
  console.log(
    "[clean-clone] npm ci (postinstall bootstraps SQLite: .env + secrets + next-env.d.ts + generate + db push + stage-2)",
  );
  shInherit("npm", ["ci", "--no-audit", "--no-fund"], { cwd: work, env: freshEnv });

  const envText = readFileSync(join(work, ".env"), "utf8");
  check(".env was created with the SQLite DATABASE_URL", /DATABASE_URL=file:\.\.\/db\/custom\.db/.test(envText), "file:../db/custom.db");
  check("TUBEFORGE_AUTH_SECRET was provisioned", /^TUBEFORGE_AUTH_SECRET=.+/m.test(envText));
  check("TUBEFORGE_ENCRYPTION_KEY was provisioned", /^TUBEFORGE_ENCRYPTION_KEY=.+/m.test(envText));
  check("next-env.d.ts was created", existsSync(join(work, "next-env.d.ts")));
  check("db/custom.db was pushed", existsSync(join(work, "db", "custom.db")));

  const clientSchema = readFileSync(join(work, "node_modules", ".prisma", "client", "schema.prisma"), "utf8");
  check('generated client is the SQLITE dialect (provider = "sqlite")', /provider\s*=\s*"sqlite"/.test(clientSchema));

  // 3. the boot probe — the generated client actually queries the pushed
  //    Stage-2 schema. An ABSOLUTE file: URL keeps the probe independent of
  //    relative-path resolution semantics; the .env contract above is already
  //    asserted verbatim.
  // `node -e` resolves bare requires against CWD — the probe runs from the
  // clone root and needs NO file written into it (writing one would dirty
  // the git-status hygiene assertion below).
  const probeEnv = { ...freshEnv, DATABASE_URL: `file:${join(work, "db", "custom.db")}` };
  const probeOut = sh(
    "node",
    [
      "-e",
      `const { PrismaClient } = require("@prisma/client");
const db = new PrismaClient({ log: ["error"] });
db.organization.count()
  .then((n) => { console.log("PROBE_OK organizations=" + n); process.exit(0); })
  .catch((e) => { console.error("PROBE_FAIL " + ((e && e.message) || String(e))); process.exit(1); });`,
    ],
    { cwd: work, env: probeEnv },
  ).trim();
  check(
    "fresh clone BOOTS — the generated client queries the pushed Stage-2 schema",
    /PROBE_OK organizations=\d+/.test(probeOut),
    probeOut.split("\n").slice(-1)[0] ?? "",
  );

  // 4. the determinism law — generate → hash → regenerate → hash must hold
  //    for BOTH dialects, and the dialects must produce DIFFERENT artifacts.
  const sqliteHash1 = manifestDigest(clientManifest(work));
  console.log("[clean-clone] prisma generate (sqlite, regenerate for determinism)");
  shInherit("npx", ["--no-install", "prisma", "generate", "--schema", "prisma/schema.sqlite.prisma"], { cwd: work, env: freshEnv });
  const sqliteHash2 = manifestDigest(clientManifest(work));
  check(
    "SQLite client generation is deterministic (regenerate → byte-identical manifest)",
    sqliteHash1 === sqliteHash2,
    `${sqliteHash1.slice(0, 12)} vs ${sqliteHash2.slice(0, 12)}`,
  );

  console.log("[clean-clone] prisma generate (postgres, regenerate for determinism)");
  shInherit("npx", ["--no-install", "prisma", "generate", "--schema", "prisma/schema.prisma"], { cwd: work, env: freshEnv });
  const pgHash1 = manifestDigest(clientManifest(work));
  const pgSchema = readFileSync(join(work, "node_modules", ".prisma", "client", "schema.prisma"), "utf8");
  check('POSTGRES client generates cleanly in the fresh clone (provider = "postgresql")', /provider\s*=\s*"postgresql"/.test(pgSchema));
  shInherit("npx", ["--no-install", "prisma", "generate", "--schema", "prisma/schema.prisma"], { cwd: work, env: freshEnv });
  const pgHash2 = manifestDigest(clientManifest(work));
  check(
    "Postgres client generation is deterministic (regenerate → byte-identical manifest)",
    pgHash1 === pgHash2,
    `${pgHash1.slice(0, 12)} vs ${pgHash2.slice(0, 12)}`,
  );
  check(
    "the two dialect clients are DIFFERENT artifacts (a silent provider swap cannot pass)",
    sqliteHash1 !== pgHash1,
  );

  // 5. the hygiene law — nothing tracked was mutated by install/generate.
  const dirtyAfter = sh("git", ["status", "--porcelain"], { cwd: work, env: freshEnv });
  check(
    "install + generation touched NO tracked file (gitignored hygiene holds)",
    dirtyAfter.trim() === "",
    dirtyAfter.trim().split("\n").slice(0, 5).join(" | "),
  );

  console.log("");
  if (failures > 0) {
    console.error(`clean-clone: ${failures} assertion(s) FAILED — clone preserved for forensics at ${work}`);
    process.exit(1);
  }
  if (!KEEP) rmSync(work, { recursive: true, force: true });
  console.log(`clean-clone: all assertions held${KEEP ? ` (clone kept at ${work})` : " — a fresh clone boots without hidden local state"}`);
} catch (err) {
  console.error(
    "clean-clone: crashed —",
    err instanceof Error ? err.message : String(err),
    `\nclone preserved for forensics at ${work}`,
  );
  process.exit(1);
}
