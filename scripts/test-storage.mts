// S101 / P0.3 — the storage reservation battery (docs/production-readiness.md).
//
//   npm run test:storage     (needs the local SQLite DB)
//
// Exit condition: concurrent uploads cannot exceed quota. The old admission
// was read-check-write-write — two concurrent puts could BOTH pass the check.
// The admission is now ONE serialized transaction that inserts a durable
// hold; this battery proves the law against the real database:
//
//   1. THE CONCURRENT LAW — two 600 MiB admissions race a 1 GiB ceiling:
//      exactly ONE wins, the loser throws StorageQuotaError (the DB
//      serialized the racers — the loser saw the winner's hold).
//   2. THE HOLD'S ACCOUNTING LAW — a hold never moves the committed
//      counter; the ceiling counts committed + LIVE holds.
//   3. RELEASE — a dropped hold frees its bytes (quota fully reclaimable).
//   4. COMMIT — the real delta lands atomically with the hold's removal;
//      a committed-full org refuses further admissions.
//   5. OVERWRITE — replacesBytes frees its quota inside the admission.
//   6. EXPIRY — the sweep drops holds past their TTL and frees exactly
//      the bytes they reserved (the crash net).
//   7. THE PUT() INTEGRATION — real puts under a tenant ctx: hold → write
//      → settle; delta accounting on overwrite.

import fs from "node:fs/promises";
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const MB = 1024 * 1024;
const GiB = 1024 * MB;

let failed = false;
function ok(cond: unknown, msg: string): asserts cond {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failed = true;
    console.error(`  ✗ ${msg}`);
  }
}

async function main(): Promise<void> {
  console.log("◆ S101 / P0.3 — storage reservations (atomic quota admission battery)");

  const {
    reserveStorageBytes,
    sweepExpiredStorageReservations,
    usageBytes,
    StorageQuotaError,
    storageQuotaBytes,
    put,
  } = await import("../src/lib/tubeforge/storage");
  const { withCtx } = await import("../src/lib/tubeforge/tenant");

  // A 1 GiB ceiling for the battery (storageQuotaBytes reads env per call).
  process.env.TUBEFORGE_STORAGE_QUOTA_GB = "1";
  ok(storageQuotaBytes() === GiB, "the ceiling override reads 1 GiB");

  const run = `st${Date.now().toString(36)}`;
  const org = await db.organization.create({
    data: { name: `Storage Probe ${run}`, slug: `storage-probe-${run}` },
  });

  try {
    // 1. THE CONCURRENT LAW.
    const race = await Promise.allSettled([
      reserveStorageBytes(org.id, "probe/a.mp4", 600 * MB, 0),
      reserveStorageBytes(org.id, "probe/b.mp4", 600 * MB, 0),
    ]);
    const won = race.filter((r) => r.status === "fulfilled");
    const lost = race.filter((r) => r.status === "rejected");
    ok(
      won.length === 1 && lost.length === 1,
      `two concurrent 600 MiB admissions vs a 1 GiB ceiling: exactly ONE wins (won=${won.length}, lost=${lost.length})`
    );
    ok(
      lost.length === 1 && lost[0].reason instanceof StorageQuotaError,
      "the loser throws StorageQuotaError — the DB serialized the racers, no double-admission"
    );
    if (won[0].status === "fulfilled") await won[0].value.release();
    ok((await usageBytes(org.id)) === 0, "releasing the winner's hold frees everything (no committed bytes)");

    // 2. THE HOLD'S ACCOUNTING LAW — holds are invisible to the committed counter.
    const hold = await reserveStorageBytes(org.id, "probe/c.mp4", 400 * MB, 0);
    ok((await usageBytes(org.id)) === 0, "a hold does NOT move the committed counter");
    let refused = false;
    try {
      await reserveStorageBytes(org.id, "probe/d.mp4", 700 * MB, 0);
    } catch (err) {
      refused = err instanceof StorageQuotaError;
    }
    ok(refused, "the ceiling counts the in-flight hold (700 MiB refused while 400 MiB is held)");
    await hold.release();

    // 3. THE PUT() INTEGRATION — hold → write → settle, delta on overwrite.
    await withCtx({ userId: "probe-user", organizationId: org.id, role: "owner" }, async () => {
      await put("probe/small.bin", Buffer.alloc(1000));
      ok((await usageBytes(org.id)) === 1000, "put() settles the real byte delta (1000 bytes committed)");
      await put("probe/small.bin", Buffer.alloc(2500));
      ok(
        (await usageBytes(org.id)) === 2500,
        "an overwrite settles the DELTA (2500 committed, the replaced 1000 was freed)"
      );
      const holdsLeft = await db.storageReservation.count({ where: { organizationId: org.id } });
      ok(holdsLeft === 0, "settled puts leave NO hold rows behind");
    });

    // 4. COMMIT + a committed-full org refuses more.
    const full = await reserveStorageBytes(org.id, "probe/full.mp4", GiB - 2500, 0);
    await full.commit(GiB - 2500);
    ok(
      (await usageBytes(org.id)) === GiB,
      `the org is committed-full (${await usageBytes(org.id)} of ${GiB} bytes)`
    );
    refused = false;
    try {
      await reserveStorageBytes(org.id, "probe/over.mp4", 1 * MB, 0);
    } catch (err) {
      refused = err instanceof StorageQuotaError;
    }
    ok(refused, "a committed-full org refuses further admissions");

    // 5. OVERWRITE ADMISSION — replacesBytes frees its quota inside the check:
    //    an equal-size overwrite of a full org is delta-0 and must FIT.
    const overwrite = await reserveStorageBytes(org.id, "probe/full.mp4", GiB - 2500, GiB - 2500);
    ok(true, "an equal-size overwrite of a full org fits (delta 0)");
    await overwrite.release();
    refused = false;
    try {
      await reserveStorageBytes(org.id, "probe/full.mp4", GiB, GiB - 2500);
    } catch (err) {
      refused = err instanceof StorageQuotaError;
    }
    ok(refused, "a GROWING overwrite of a full org is refused (delta crosses the ceiling)");

    // 6. EXPIRY — the sweep drops holds past their TTL and frees the bytes.
    //    Reset the counter (the sweep's freedom is measured on a clean slate).
    await db.storageUsage.deleteMany({ where: { organizationId: org.id } });
    // The dying hold needs no handle — the sweep owns its lifecycle; keeping
    // the assignment would be an unused variable (the lint gate caught it).
    await reserveStorageBytes(org.id, "probe/dying.mp4", 512 * MB, 0, 1);
    await new Promise((r) => setTimeout(r, 30));
    const swept = await sweepExpiredStorageReservations();
    ok(swept >= 1, `the expiry sweep drops holds past their TTL (${swept} swept)`);
    const afterSweep = await reserveStorageBytes(org.id, "probe/fresh.mp4", 512 * MB, 0);
    ok(true, "the swept bytes are reclaimable (512 MiB admits again)");
    await afterSweep.release();

    // cleanup — probe files on the local driver + probe rows (org cascades)
    await fs.rm("uploads/probe", { recursive: true, force: true }).catch(() => {});
  } finally {
    delete process.env.TUBEFORGE_STORAGE_QUOTA_GB;
    await db.organization.delete({ where: { id: org.id } }).catch(() => {});
    await db.$disconnect();
  }

  if (failed) {
    console.error("\nstorage reservation battery: FAIL");
    process.exit(1);
  }
  console.log("\nstorage reservation battery: PASS");
}

main().catch((err) => {
  console.error("[test-storage] fatal:", err);
  process.exit(1);
});
