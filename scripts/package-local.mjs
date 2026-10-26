// Build download/tubeforge-local.zip — a clean, reproducible source package
// for running TubeForge on a local PC (see LOCAL-SETUP.md).
//
// Includes: src, prisma, public, scripts (code only — no screenshots/logs/
// media artifacts), configs, bun.lock, .env.example, .z-ai-config.example,
// LOCAL-SETUP.md, db/.gitkeep + uploads/.gitkeep placeholders.
// Excludes: node_modules, .next, the live SQLite db, uploads media, credentials.
//
// Usage: node scripts/package-local.mjs

import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";

const ROOT = path.resolve(process.cwd());
const OUT = path.join(ROOT, "download", "tubeforge-local.zip");
const STAGE = path.join(ROOT, ".package-stage");

const files = [];
const walk = (dir, prefix = "") => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (prefix === "" && ["node_modules", ".next", ".git", "db", "uploads", "download", "tool-results", "skills", "examples", "mini-services", "tests", ".zscripts", "upload", ".package-stage"].includes(entry.name)) continue;
    const abs = path.join(dir, entry.name);
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walk(abs, rel);
    } else {
      files.push(rel);
    }
  }
};

// Root-level files (only the useful ones)
const ROOT_FILES = [
  "package.json", "bun.lock", "tsconfig.json", "next.config.ts",
  "postcss.config.mjs", "tailwind.config.ts", "components.json",
  "eslint.config.mjs", "next-env.d.ts", ".env.example",
  ".z-ai-config.example", "LOCAL-SETUP.md", ".gitignore",
];

// scripts/: keep code, drop generated artifacts (screenshots, logs, media)
const SCRIPT_KEEP = /\.(mjs|js|ts|py|sh|md)$/i;
const SCRIPT_DROP = /(probe-live\.log|\.png$|\.jpg$|\.webm$|\.mp4$|\.wav$|\.mp3$)/i;

// prisma: schema + migrations, no db file
const PRISMA_DROP = /\.db$|\.db-journal$|dev\.db/i;

const include = (rel) => {
  if (rel === "scripts" || rel.startsWith("scripts/"))
    return !SCRIPT_DROP.test(rel) && (rel === "scripts/restart-dev.py" || SCRIPT_KEEP.test(rel));
  if (rel.startsWith("prisma/")) return !PRISMA_DROP.test(rel);
  return true;
};

console.log("Staging package…");
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

for (const f of ROOT_FILES) {
  if (fs.existsSync(path.join(ROOT, f))) files.push(f);
}
walk(path.join(ROOT, "src"), "src");
walk(path.join(ROOT, "public"), "public");
walk(path.join(ROOT, "scripts"), "scripts");
walk(path.join(ROOT, "prisma"), "prisma");

let copied = 0;
for (const rel of files) {
  if (!include(rel)) continue;
  const dest = path.join(STAGE, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(ROOT, rel), dest);
  copied++;
}

// Placeholder dirs so unzip creates them
for (const p of ["db/.gitkeep", "uploads/.gitkeep"]) {
  const dest = path.join(STAGE, p);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, "");
  copied++;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.rmSync(OUT, { force: true });
execFileSync("zip", ["-rq", OUT, "."], { cwd: STAGE });
fs.rmSync(STAGE, { recursive: true, force: true });

const size = (fs.statSync(OUT).size / 1024).toFixed(0);
const count = Number(execFileSync("unzip", ["-l", OUT]).toString().match(/(\d+)\s+files?$/)?.[1] ?? "?");
console.log(`✓ ${path.relative(ROOT, OUT)} — ${count} files, ${size} KB`);
