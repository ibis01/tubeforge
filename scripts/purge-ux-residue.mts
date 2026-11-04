// One-time end-state purge, run as part of the S31 battery.
//
// The end-state sweep after the e2e battery found yesterday's leftovers:
// seven throwaway "ux-*@tubeforge.test" accounts (an uncommitted UX-probe
// run) with two probe videos, while the owner's real account and their
// in-progress Phoenician-history video are PRODUCTION data and stay.
// E2E law: residue is purged, orphan orgs are deleted, the sweep re-runs.
//
// Run: node --import tsx scripts/purge-ux-residue.mts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

const before = {
  users: await db.user.count(),
  orgs: await db.organization.count(),
  videos: await db.video.count(),
};

// 1. the probe accounts — test-domain convention, never the owner's.
const probeUsers = await db.user.findMany({
  where: { email: { startsWith: "ux-", endsWith: "@tubeforge.test" } },
  select: { id: true, email: true },
});
console.log(`purging ${probeUsers.length} probe users:`, probeUsers.map((u) => u.email).join(", "));
for (const u of probeUsers) {
  await db.user.delete({ where: { id: u.id } }).catch(() => {});
}

// 2. orphan orgs — the probe orgs that just lost their last member.
const orphans = await db.organization.findMany({
  where: { memberships: { none: {} } },
  select: { id: true },
});
console.log(`purging ${orphans.length} orphan orgs`);
for (const o of orphans) {
  await db.organization.delete({ where: { id: o.id } }).catch(() => {});
}

const after = {
  users: await db.user.count(),
  orgs: await db.organization.count(),
  videos: await db.video.count(),
  jobs: await db.job.count(),
  usage: await db.usageRecord.count(),
  credits: await db.creditLedger.count(),
  orphanOrgs: (await db.organization.findMany({ where: { memberships: { none: {} } } })).length,
};
console.log("before:", JSON.stringify(before));
console.log("after: ", JSON.stringify(after));

const clean =
  after.users === 1 && // the owner only
  after.orphanOrgs === 0 &&
  after.videos === 1; // the owner's video only
console.log(clean ? "PURGE CLEAN" : "PURGE INCOMPLETE");
await db.$disconnect();
process.exit(clean ? 0 : 1);
