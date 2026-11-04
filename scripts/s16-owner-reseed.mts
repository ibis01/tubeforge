// S16 recovery — reseed the owner after the lost-segment wipe. Somewhere in
// the gap between S15's push and this session, every User row vanished (the
// DB shows 0 users / 0 memberships / 0 sessions but 6 orphan e2e orgs — a
// user-level wipe that never touched orgs; the same lost segment that
// deleted storyboard/upload/route.ts from the working tree). The owner's
// original org and videos are unrecoverable, so this mints a fresh identity:
//   · the 6 orphan orgs (zero memberships — pure e2e litter) are removed;
//   · a fresh org "ibis01's Studio" + the owner user (ibis01abc@gmail.com,
//     password from argv, default the documented tubeforge2026) + the owner
//     membership, in the register route's exact row shape;
//   · the login is then proven live against the daemon (the caller does
//     this — the script only writes rows).
// Run: node --import tsx scripts/s16-owner-reseed.mts [password]
import { hashPassword } from "../src/lib/tubeforge/tenant";
import { PrismaClient } from "@prisma/client";

const EMAIL = "ibis01abc@gmail.com";
const password = process.argv[2] ?? "tubeforge2026";
if (password.length < 8) {
  console.error("usage: s16-owner-reseed.mts [password >= 8 chars]");
  process.exit(1);
}

const db = new PrismaClient();
try {
  // 1. orphan orgs (zero memberships) are e2e litter — remove them
  const orphans = await db.organization.findMany({
    select: { id: true, name: true },
    where: { memberships: { none: {} } },
  });
  for (const o of orphans) await db.organization.delete({ where: { id: o.id } });
  console.log(`removed ${orphans.length} orphan org(s): ${orphans.map((o) => o.name).join(", ") || "—"}`);

  // 2. idempotent reseed: existing user just gets the fresh hash
  const existing = await db.user.findUnique({ where: { email: EMAIL } });
  const hash = await hashPassword(password);
  const user = existing
    ? await db.user.update({
        where: { id: existing.id },
        data: { passwordHash: hash, passwordResetTokenHash: null, passwordResetExpiresAt: null },
      })
    : await db.user.create({ data: { email: EMAIL, passwordHash: hash, name: "ibis01" } });
  console.log("owner user ready:", user.email);

  // 3. the org + owner membership (register's exact shape)
  let membership = await db.membership.findFirst({ where: { userId: user.id } });
  if (!membership) {
    const org = await db.organization.create({
      data: { name: "ibis01's Studio", slug: `ibis01-studio-${Math.random().toString(36).slice(2, 6)}` },
    });
    membership = await db.membership.create({
      data: { userId: user.id, organizationId: org.id, role: "owner" },
    });
    console.log("org minted:", org.name);
  }
  console.log("membership role:", membership.role, "org:", membership.organizationId);
  console.log("OK — verify with: curl -X POST :3000/api/auth/login " + JSON.stringify({ email: EMAIL, password }));
} finally {
  await db.$disconnect();
}
