#!/usr/bin/env node
// S56/T-56.5 — the nightly route-probe battery runner (SELF-CONTAINED).
//
// Boots its OWN daemon in two phases and runs the DURABLE s-series route
// probes against it — the per-stage probes that were on-demand-only since
// the studio era (S33+ backlog P1-2).
//
//   PHASE 1 (enforce) — standard daemon (the S40 ship gate ENFORCING, the
//     deployment default): 16 probes, s5→s25 (minus the special-state and
//     gateway-dependent ones — see the exclusion list below).
//   PHASE 2 (report) — daemon rebooted with TUBEFORGE_QC_ENFORCEMENT=report
//     (the documented operator advisory mode): s29, whose export contract
//     predates the S40 gate — its "GET export streams a ZIP" law is the
//     pre-gate packaging contract, honestly re-run in the mode that still
//     carries it.
//
// 17 probes on the nightly schedule; s8 + s11 additionally verified
// in-sandbox (gateway TTS) — see the exclusion list at PHASE1_PROBES.
//
// Out of scope, on demand only (each needs daemon-state dances documented
// in its own header): s27 + s32 (TUBEFORGE_PRICING_VERIFIED + mid-suite
// restarts), s28 + s30 (cookie-samesite / allowed-origins overrides).
// Gateway-dependent (verified in the Z.ai sandbox, not on bare runners):
// s8 + s11 — see the exclusion note at PHASE1_PROBES.
//
// Two shared-IP realities the runner neutralizes, both disclosed:
//   * the middleware per-IP tiers are RAISED for the battery daemon
//     (TUBEFORGE_RATE_WRITE=3000 / READ=9000): the probe train through one
//     IP would otherwise exhaust the 90/min human tier mid-battery (observed
//     live: 429s from s20 onward). The tiers themselves are unit-proven.
//   * the S46 login lockout is DB-backed and durable BY DESIGN; probes that
//     DELIBERATELY fail logins would poison later probes' logins through
//     the shared IP (observed live: s16's lockout tests 429'd s17). The
//     runner clears AuthAttempt between probes — the throttle's own law is
//     S46-proven; the battery just needs a clean slate per probe.
//
// Usage: node scripts/run-route-battery.mjs          (BASE_URL default :3000)
// Exit 0 only if every probe in every phase exits 0.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const db = new PrismaClient();

// Out of scope, on demand only (each needs something a bare runner does
// not have — documented per probe header):
//   s8, s11  — their REAL-SYNTHESIS checks (voice swap / pace audition) ride
//              the default TTS provider (zai: the platform-bundled SDK —
//              works in the Z.ai sandbox, absent on a bare CI runner; the
//              first green nightly proved the split: every other check of
//              both probes passed, only the synthesis calls 400/502'd).
//              Both pass in-sandbox via the gateway (piecewise, 2026-11-08).
//   s27, s32  — TUBEFORGE_PRICING_VERIFIED + mid-suite restarts.
//   s28, s30  — cookie-samesite / allowed-origins env overrides.
const PHASE1_PROBES = [
  "s5", "s7", "s10", "s12", "s13", "s14",
  "s15", "s16", "s17", "s18", "s20", "s21", "s22", "s23",
  "s24", "s25",
];
const PHASE2_PROBES = ["s29"]; // advisory-gate daemon (see header)

const TIMEOUT_SEC = 480; // per-probe cap: a hang becomes attributable.
// 480 because the battery daemon boots COLD per phase and Next dev compiles
// routes on demand — the render-class probes (s11 re-reads, s29 full render
// + export) legitimately need minutes on a cold compile (observed: both
// SIGTERM'd at 240 on a cold daemon while passing warm).
const PROBE_TIMEOUT_OVERRIDES = { s29: 900 }; // cold render + export + cleanup
const BOOT_TIMEOUT_MS = 180_000;

let daemon = null;

// The battery serves the PRODUCTION build (`npm run start`, the standalone
// server) — the thing that actually ships — not `next dev`: a Turbopack dev
// server (~2 GB RSS) plus a 1080p render's ffmpeg pushed the sandbox's 4 GB
// cgroup over the OOM line mid-battery (silent kills, three nights of
// evidence); the standalone server runs at a fraction of that AND the
// probes test app laws, not dev-server behaviors. The runner builds once
// (fail-cast: a broken build aborts the leg before any daemon boots).
async function ensureBuild() {
  console.log("[battery] building the production server (one-time per run) …");
  const r = spawnSync("npm", ["run", "build"], { encoding: "utf8", timeout: 600_000 });
  if (r.status !== 0) {
    console.error("[battery] BUILD FAILED — aborting:");
    console.error((r.stdout ?? "").slice(-1500));
    console.error((r.stderr ?? "").slice(-1500));
    process.exit(1);
  }
  console.log("[battery] build ok");
}

function bootDaemon(extraEnv) {
  // Daemon output goes to a file (append) — when the daemon dies mid-leg,
  // its own crash/kill story is the evidence.
  const daemonLog = fs.openSync("/tmp/s56-battery-daemon.log", "a");
  daemon = spawn("npm", ["run", "start"], {
    env: {
      ...process.env,
      TUBEFORGE_RATE_WRITE: "3000",
      TUBEFORGE_RATE_READ: "9000",
      ...extraEnv,
    },
    stdio: ["ignore", daemonLog, daemonLog],
    detached: false,
  });
  const pid = daemon.pid;
  daemon.on("exit", (code, signal) => {
    console.log(`[battery] daemon (pid ${pid}) exited: code=${code} signal=${signal}`);
  });
}

function killDaemon() {
  if (!daemon) return;
  // npm run start spawns the standalone server as its child; kill the tree.
  try {
    process.kill(-daemon.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  try {
    daemon.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  // Belt and braces for any straggler listening on the battery port. NOTE:
  // Next.js RENAMES its server process to "next-server (vX)" at boot, so a
  // cmdline pattern for the launch command alone misses it (observed live:
  // EADDRINUSE on the phase-2 boot because phase-1's server survived the
  // "standalone/server.js" pkill under its renamed title).
  spawnSync("pkill", ["-f", "next-server"], { stdio: "ignore" });
  spawnSync("pkill", ["-f", "standalone/server.js"], { stdio: "ignore" });
  spawnSync("pkill", ["-f", "next dev"], { stdio: "ignore" });
  daemon = null;
}

// The sandbox's 4 GB cgroup could not hold two daemons AND their compile
// trees: killing phase 1's daemon and immediately booting phase 2's
// overlapped them long enough for the OOM killer to SIGKILL the runner
// mid-boundary — a SILENT death (no stderr, log just stops). The phase gap
// now waits for the port to actually free AND the server processes to
// actually exit before rebooting.
async function waitUntilDown() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const portBusy = await new Promise((resolve) => {
      fetch(`${BASE}/login`, { redirect: "manual", signal: AbortSignal.timeout(2000) })
        .then(() => resolve(true))
        .catch(() => resolve(false));
    });
    const procs = spawnSync("pgrep", ["-fc", "next-server|standalone/server.js|next dev"], { encoding: "utf8" });
    const serverCount = Number((procs.stdout ?? "").trim()) || 0;
    if (!portBusy && serverCount === 0) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function waitUntilUp() {
  // The dev server binds its port BEFORE it can serve heavy routes; a single
  // /login 200 is not readiness (observed: phase-2 probes crash on transient
  // connection resets / mid-compile 500s when started at first-200). Require
  // THREE consecutive 200s at least 10s apart — the settle the manual runs
  // (fixed 25s sleeps) always had and the early battery runs did not.
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let consecutive = 0;
  let firstOkAt = 0;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/login`, { redirect: "manual" });
      if (res.status < 500) {
        consecutive += 1;
        if (!firstOkAt) firstOkAt = Date.now();
        if (consecutive >= 3 && Date.now() - firstOkAt >= 10_000) return true;
      } else {
        consecutive = 0;
      }
    } catch {
      consecutive = 0;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function clearAuthThrottle() {
  try {
    await db.authAttempt.deleteMany({});
  } catch (err) {
    console.warn(`[battery] AuthAttempt clear failed (continuing): ${err instanceof Error ? err.message : err}`);
  }
}

// Janitor for INTERRUPTED runs: every probe cleans up in-band, but a probe
// killed mid-course (timeout, crash, Ctrl-C) leaves its fixtures behind, and
// the next run's baseline checks either trip over them (s29's "zero s29
// accounts") or worse, absorb them into the baseline and stop detecting
// leaks. Before each phase the runner sweeps every probe-marked fixture:
// orgs slugged '*-e2e-*' (content rows cascade from Organization), then
// users emailed '*-e2e-*'. The real owner's org never matches the pattern.
// Disk upload-trees under uploads/ are left alone (CI checks out fresh;
// locally they are inert garbage, never read by checks).
async function sweepResidue() {
  const orgs = await db.organization.findMany({
    where: { slug: { contains: "-e2e-" } },
    select: { id: true, slug: true },
  });
  const users = await db.user.findMany({
    where: { email: { contains: "-e2e-" } },
    select: { id: true, email: true },
  });
  let removed = 0;
  for (const o of orgs) {
    await db.organization.delete({ where: { id: o.id } }).catch(() => {});
    removed += 1;
  }
  for (const u of users) {
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
    removed += 1;
  }
  if (removed > 0) {
    console.log(`[battery] janitor: swept ${orgs.length} orphaned fixture org(s), ${users.length} user(s) from interrupted runs`);
  }
}

async function runPhase(label, probes) {
  console.log(`[battery] ── phase: ${label} (${probes.length} probes)`);
  let failed = 0;
  const failedNames = [];
  for (const p of probes) {
    await clearAuthThrottle();
    process.stdout.write(`[battery] ${p} … `);
    const r = spawnSync(
      "node",
      ["--import", "tsx", `scripts/${p}-route-e2e.mjs`],
      {
        env: { ...process.env, BASE_URL: BASE },
        encoding: "utf8",
        timeout: (PROBE_TIMEOUT_OVERRIDES[p] ?? TIMEOUT_SEC) * 1000,
      },
    );
    const ok = r.status === 0;
    if (!ok) {
      failed += 1;
      failedNames.push(p);
    }
    const tail = (r.stdout ?? "").trim().split("\n").filter(Boolean);
    if (ok) {
      console.log(`PASS (${(tail.pop() ?? "").slice(0, 90)})`);
    } else {
      console.log(`FAIL exit=${r.status} signal=${r.signal} — ${(tail.pop() ?? "").slice(0, 120)}`);
      // The probe's own check lines carry the WHY — surface them (the
      // first nightly run failed 13 probes with only tail lines visible).
      const detail = (r.stdout ?? "").split("\n").filter((l) => /FAIL|Error|error/i.test(l)).slice(0, 8);
      for (const line of detail) console.log(`      ${line.slice(0, 190)}`);
      const errLines = (r.stderr ?? "").trim().split("\n").filter(Boolean);
      for (const line of errLines.slice(-3)) console.log(`      stderr: ${line.slice(0, 190)}`);
    }
  }
  return { failed, failedNames };
}

// CHUNKED like the S54/S55 harnesses (the sandbox reaps long runs): the
// leg is selected by S56_BATTERY_LEG — "phase1" (enforce daemon, 18
// probes), "phase2" (report daemon, s29), or "all" (both, for CI's single
// job where no reaper exists). Each leg boots and kills its own daemon and
// reports its own summary; exit 0 only if the leg's probes all pass.
const LEG = process.env.S56_BATTERY_LEG ?? "all";

const total = { failed: 0, phases: [] };

await ensureBuild();

if (LEG === "phase1" || LEG === "all") {
  await sweepResidue();
  bootDaemon({});
  if (!(await waitUntilUp())) {
    console.error("[battery] daemon did not come up (phase enforce) — aborting");
    killDaemon();
    process.exit(1);
  }
  const r1 = await runPhase("enforce", PHASE1_PROBES);
  total.failed += r1.failed;
  total.phases.push({ phase: "enforce", failed: r1.failed, failedNames: r1.failedNames });
  killDaemon();
  if (!(await waitUntilDown())) {
    console.error("[battery] phase-1 daemon did not fully exit — aborting before the OOM overlap");
    await db.$disconnect();
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 5000));
}

if (LEG === "phase2" || LEG === "all") {
  await sweepResidue();
  bootDaemon({ TUBEFORGE_QC_ENFORCEMENT: "report" });
  if (!(await waitUntilUp())) {
    console.error("[battery] daemon did not come up (phase report) — aborting");
    killDaemon();
    process.exit(1);
  }
  const r2 = await runPhase("report", PHASE2_PROBES);
  total.failed += r2.failed;
  total.phases.push({ phase: "report", failed: r2.failed, failedNames: r2.failedNames });
  killDaemon();
}

await db.$disconnect();

console.log("[battery] ============================================");
const ran = total.phases.reduce((n, ph) => n + (ph.phase === "enforce" ? PHASE1_PROBES.length : PHASE2_PROBES.length), 0);
console.log(`[battery] leg=${LEG}: ${ran - total.failed}/${ran} probes passed`);
for (const ph of total.phases) {
  for (const name of ph.failedNames) console.log(`[battery] FAILED: ${name} (phase ${ph.phase})`);
}
process.exit(total.failed === 0 ? 0 : 1);
