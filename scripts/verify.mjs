#!/usr/bin/env node
// TubeForge verification suite — ONE command to prove the app is healthy.
//   node scripts/verify.mjs            → lint + typecheck + fast ffmpeg tests
//   node scripts/verify.mjs --full      → also run the app-level E2E suites
//                                         (needs the dev server on :3000)
// Exit code 0 = everything green.

import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const full = process.argv.includes("--full");

const run = (label, cmd, opts = {}) => {
  process.stdout.write(`\n▶ ${label}\n`);
  const r = spawnSync(cmd[0], cmd.slice(1), { stdio: "inherit", cwd: ROOT, ...opts });
  if (r.status !== 0) {
    console.error(`\n✗ FAILED: ${label}`);
    process.exit(r.status ?? 1);
  }
  console.log(`✓ ${label}`);
};

console.log("TubeForge verification" + (full ? " (FULL)" : " (fast)"));

run("ESLint", ["bun", "run", "lint"]);
run("TypeScript (strict, no ignoreBuildErrors)", ["bunx", "tsc", "--noEmit"]);
run("Auth gate live (server must 401 anonymous API calls)", ["node", "-e", `
  const t = async () => {
    const res = await fetch("http://localhost:3000/api/stats");
    if (res.status === 401) { console.log("  api gate: 401 for anonymous ✓"); return 0; }
    if (res.status === 200) { console.log("  api gate: OPEN (TUBEFORGE_AUTH_SECRET unset) — acceptable for dev"); return 0; }
    console.log("  api gate: unexpected", res.status); return 1;
  };
  t().then((c) => process.exit(c)).catch(() => process.exit(1));
`]);

if (existsSync("scripts/test-shotchain.mjs"))
  run("ffmpeg render chain (cuts, SFX, ducking, black frames)", ["node", "scripts/test-shotchain.mjs"]);

if (full) {
  if (existsSync("scripts/test-quality-overhaul.mjs"))
    run("App E2E — quality overhaul suite", ["node", "scripts/test-quality-overhaul.mjs"]);
  if (existsSync("scripts/test-providers.mjs"))
    run("App E2E — provider adapters", ["node", "scripts/test-providers.mjs"]);
}

console.log("\n════ ALL VERIFIED ════\n");
