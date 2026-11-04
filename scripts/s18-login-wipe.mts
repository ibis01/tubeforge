// S18 prelude — the fresh door. The user asked: "delete all the previous
// login detail so I can login." The AuthGate replaces the whole app until
// the browser holds a session, and with a user row present it shows LOGIN
// mode for an account whose password the USER never chose (the S16 reseed).
// Wiping the auth state flips the gate to REGISTER mode (configured: false
// — the first-run experience), where the user mints their OWN account and
// is auto-signed-in.
//
// What dies: every Session, every Membership, every User, every org with no
// members left (e2e litter included), and any legacy auth Setting rows (the
// single-user lock's remnants — they would demand the OLD studio password at
// the first registration). What survives: videos and their media trees (none
// exist today — 0 rows; if any did, they'd be orphaned to their org rows and
// left in place, NOT deleted).
// Run: node --import tsx scripts/s18-login-wipe.mts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
try {
  const usersBefore = await db.user.count();
  const sessions = await db.session.deleteMany({});
  const memberships = await db.membership.deleteMany({});
  const users = await db.user.deleteMany({});

  // Legacy single-user lock remnants — the first registration would have to
  // prove this password (status.legacyClaim.required). An empty key list is
  // the expected state on this install; the sweep is future-proofing.
  const legacyKeys = ["auth.enabled", "auth.password"];
  const settings = await db.setting.deleteMany({ where: { key: { in: legacyKeys } } });

  // Orgs with no members left (the reseeded owner's + e2e litter).
  const orphans = await db.organization.findMany({
    where: { memberships: { none: {} } },
    select: { id: true, name: true },
  });
  for (const o of orphans) await db.organization.delete({ where: { id: o.id } });

  const videos = await db.video.count();
  const after = await db.user.count();
  console.log(JSON.stringify({
    wiped: {
      users: users.count,
      sessions: sessions.count,
      memberships: memberships.count,
      legacySettingRows: settings.count,
      orphanOrgs: orphans.length,
    },
    usersBefore,
    usersAfter: after,
    videosUntouched: videos,
  }, null, 1));

  if (after !== 0) throw new Error("users remain — wipe incomplete");
  console.log("OK — the gate now shows REGISTER (first-run); the next visitor mints the owner account.");
} finally {
  await db.$disconnect();
}
