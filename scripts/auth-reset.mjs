// TubeForge auth reset — restored in Stage 1 (task T-1.1; was referenced by
// package.json "auth:reset" and SETUP.md/SECURITY.md but missing from the
// shipped tree).
//
// Unlocks the studio: force-disables the opt-in lock (Setting "auth.enabled"
// = "false" + removes the db/auth.lock flag mirror) so you can sign back in
// to a studio you are locked out of. With --purge it also forgets the owner
// password hash (Setting "auth.password"), so the next / visit offers the
// first-run setup screen again.
//
// Usage:
//   npm run auth:reset           # keep the password, turn the lock off
//   npm run auth:reset -- --purge  # also forget the password entirely
//
// Uses the generated Prisma client, so it works for BOTH database modes
// (SQLite local dev and Postgres) without duplicating schema knowledge here.

import { existsSync, rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const purge = process.argv.includes("--purge");

async function main() {
  // The client is generated for whichever schema postinstall picked.
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();

  try {
    // 1. Remove the flag-file mirror the middleware hot-checks.
    const flag = path.join(root, "db", "auth.lock");
    if (existsSync(flag)) {
      rmSync(flag, { force: true });
      console.log("[auth:reset] removed db/auth.lock");
    }

    // 2. Turn the lock off in the Setting table (source of truth for the UI).
    await db.setting.upsert({
      where: { key: "auth.enabled" },
      update: { value: "false" },
      create: { key: "auth.enabled", value: "false" },
    });
    console.log("[auth:reset] Setting auth.enabled = false — the studio is OPEN");

    // 3. Optional: forget the password so first-run setup is offered again.
    if (purge) {
      await db.setting.deleteMany({ where: { key: "auth.password" } });
      console.log("[auth:reset] purged auth.password — next visit shows the setup screen");
    } else {
      console.log("[auth:reset] password kept (add --purge to forget it too)");
    }

    console.log("[auth:reset] done. Restart the dev server if it was running.");
  } finally {
    await db.$disconnect();
  }
}

main().catch((err) => {
  console.error("[auth:reset] failed:", err?.message ?? err);
  console.error("         (did `npm install` run? The Prisma client must be generated first.)");
  process.exit(1);
});
