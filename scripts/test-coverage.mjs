#!/usr/bin/env node
// S56/T-56.4 — the money-path coverage harness (S33+ backlog P1-5).
//
// Measures line/branch coverage of the MONEY PATHS (billing / spend /
// render + their close kin) while running the REAL suites — the same
// unit + billing + queue batteries CI already runs — under Node's
// built-in V8 coverage, accumulated across runs by c8 (--clean=false).
// No mocks-of-convenience, no separate "coverage tests": what is measured
// is exactly what ships.
//
//   node scripts/test-coverage.mjs                # measure + report (text)
//   TUBEFORGE_COV_FLOOR_LINES=80 node …           # + enforce a lines floor
//   npm run test:coverage                         # same, floor baked in
//
// The FLOOR was set from the first full measurement (2026-11-08,
// docs/baselines/s56-coverage-baseline-2026-11-08.txt) minus a churn
// margin — normal refactoring should not trip it, a suite losing its
// grip on a money path will.
//
// Fail-closed: any suite exiting non-zero aborts with its exit code —
// coverage numbers from a half-run are lies.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname), "..");
const COV_DIR = process.env.TUBEFORGE_COV_DIR ?? "/tmp/tf-cov";
// Floor for --check-coverage (aggregate lines % across the money paths).
// Default 50: first full measurement (2026-11-08) read 53.63% — the margin
// absorbs normal churn, while losing any one suite's grip drops the
// aggregate by 5-13pp and trips it. Set TUBEFORGE_COV_FLOOR_LINES=0 to
// measure without enforcing.
const FLOOR_LINES = Number(process.env.TUBEFORGE_COV_FLOOR_LINES ?? 50);

// The money paths (P1-5's "billing / spend / render" + the ship gate and
// job machinery that carry them). These are --include patterns for c8.
const MONEY_PATHS = [
  "src/lib/tubeforge/billing.ts",
  "src/lib/tubeforge/spend.ts",
  "src/lib/tubeforge/render.ts",
  "src/lib/tubeforge/video-jobs.ts",
  "src/lib/tubeforge/qc.ts",
  "src/lib/tubeforge/qc-policy.ts",
  "src/lib/tubeforge/audiomix.ts",
  "src/lib/tubeforge/jobs.ts",
  "src/lib/tubeforge/queue.ts",
];

const SUITES = [
  { name: "unit", script: "scripts/test-unit.mts" },
  { name: "billing", script: "scripts/test-billing.mts" },
  { name: "queue", script: "scripts/test-queue.mts" },
];

fs.rmSync(COV_DIR, { recursive: true, force: true });

for (const [i, suite] of SUITES.entries()) {
  process.stdout.write(`[coverage] suite ${suite.name} … `);
  const args = [
    "node", "node_modules/c8/bin/c8.js",
    ...(i > 0 ? ["--clean=false"] : []),
    "--silent",
    "--tmp-directory", COV_DIR,
    ...MONEY_PATHS.flatMap((p) => ["--include", p]),
    "--reporter=text-summary",
    "--report-dir", COV_DIR,
    "node", "--import", "tsx", suite.script,
  ];
  const r = spawnSync(args[0], args.slice(1), { cwd: ROOT, stdio: ["ignore", "ignore", "inherit"] });
  if (r.status !== 0) {
    process.stdout.write("FAILED\n");
    process.stderr.write(`[coverage] suite "${suite.name}" FAILED (exit ${r.status}) — aborting, no report.\n`);
    process.exit(r.status ?? 1);
  }
  process.stdout.write("ok\n");
}

const reportArgs = [
  "node", "node_modules/c8/bin/c8.js",
  "report",
  "--tmp-directory", COV_DIR,
  ...MONEY_PATHS.flatMap((p) => ["--include", p]),
  "--reporter=text",
  "--reporter=text-summary",
];
if (FLOOR_LINES > 0) {
  reportArgs.push("--check-coverage", "--lines", String(FLOOR_LINES));
}
const rep = spawnSync(reportArgs[0], reportArgs.slice(1), { cwd: ROOT, stdio: "inherit" });
process.exit(rep.status ?? 1);
