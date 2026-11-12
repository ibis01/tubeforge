// Storage quota accounting (S106 / P1.2 extraction) — the S101 atomic
// admission: ONE serialized transaction checks the ceiling and inserts a
// durable StorageReservation hold; settle moves the REAL bytes; release
// frees on failure; the sweep reclaims expired holds. The committed counter
// (StorageUsage.bytes) counts settled bytes only.
//
// The dependency arrow points one way: the facade imports THIS.

import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { rawDatabase as rawDb } from "./tenant-db";
import { log } from "./log";

/** Per-organization quota ceiling. Default 10 GiB; 0 = unlimited. */
export function storageQuotaBytes(): number {
  const gb = Number(process.env.TUBEFORGE_STORAGE_QUOTA_GB ?? "");
  if (!Number.isFinite(gb) || gb <= 0) return 10 * 1024 ** 3;
  return Math.floor(gb * 1024 ** 3);
}

export class StorageQuotaError extends Error {
  constructor(public readonly organizationId: string, public readonly used: number, public readonly quota: number) {
    super(`Storage quota exceeded for organization (${used} of ${quota} bytes) — delete old videos or ask an admin to raise the cap.`);
    this.name = "StorageQuotaError";
  }
}

async function currentUsage(orgId: string): Promise<number> {
  const row = await rawDb.storageUsage.findUnique({ where: { organizationId: orgId } });
  return row ? Number(row.bytes) : 0;
}

/** Org usage in bytes (0 when the driver-level quota is disabled). */
export async function usageBytes(orgId: string): Promise<number> {
  return currentUsage(orgId);
}

export async function bumpUsage(orgId: string, delta: number): Promise<void> {
  await rawDb.storageUsage.upsert({
    where: { organizationId: orgId },
    update: { bytes: { increment: delta } },
    create: { organizationId: orgId, bytes: BigInt(Math.max(0, delta)) },
  });
}

// ---------------------------------------------------------------------------
// Reservations (S101 / P0.3 — atomic quota admission with durable holds)
//
// The old flow was read-check-write-write: assertQuota read the counter, the
// object was written, bumpUsage moved the counter AFTER the bytes landed —
// two concurrent uploads could both pass the check and exceed the org cap.
// Admission is now ONE serializable transaction (Serializable on Postgres;
// SQLite is single-writer — the S32 spend-admission pattern): read the
// committed counter, sum the org's live holds, check the ceiling, insert
// THIS upload's hold. The DB serializes the racers — the loser sees the
// winner's hold and is refused.
//
// Counter semantics: StorageUsage.bytes counts COMMITTED bytes only. A hold
// is the durable record of in-flight bytes: a process that dies between
// admission and settle leaves the hold behind, and sweepExpiredStorage
// Reservations() drops it — a hold never moved the committed counter, so
// dropping one always frees exactly the bytes it reserved. Settle (the
// object landed) deletes the hold and moves the REAL delta (actual -
// replaces) into the counter, atomically with the hold's removal.

function reservationTtlMs(): number {
  const v = Number(process.env.TUBEFORGE_STORAGE_RESERVATION_TTL_MS ?? "");
  return Number.isFinite(v) && v > 0 ? v : 60 * 60_000;
}

export interface StoragePutReservation {
  /** The upload failed — drop the hold (quota freed). Idempotent. */
  release(): Promise<void>;
  /** The object landed — settle the REAL byte delta and drop the hold. */
  commit(actualBytes: number): Promise<void>;
}

/** Serializable on Postgres with P2034 conflict retry; default on SQLite. */
async function storageAdmissionTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const serializable = !`${process.env.DATABASE_URL ?? ""}`.startsWith("file:");
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await rawDb.$transaction(fn, serializable ? { isolationLevel: "Serializable" } : undefined);
    } catch (err) {
      // P2034 — the transaction conflict Serializable exists to produce.
      // Retry against the winner's committed rows (spend.ts's
      // admitWithConflictRetry law).
      if ((err as { code?: string })?.code === "P2034" && attempt < 4) {
        await new Promise((r) => setTimeout(r, 25 * attempt));
        continue;
      }
      throw err;
    }
  }
}

/**
 * Atomically admit `incomingBytes` for an org (accounting for `replacesBytes`
 * freed by an overwrite) and return the hold that settles or releases it.
 * Throws StorageQuotaError when the ceiling would be crossed — concurrently
 * SAFE: the check and the hold are one serialized transaction.
 */
export async function reserveStorageBytes(
  organizationId: string,
  key: string,
  incomingBytes: number,
  replacesBytes: number,
  ttlMs: number = reservationTtlMs(),
): Promise<StoragePutReservation> {
  const quota = storageQuotaBytes();

  // Quota disabled — no admission gate, but the counter still tracks real bytes.
  if (quota <= 0) {
    return {
      release: async () => {},
      commit: async (actual) => {
        if (actual - replacesBytes !== 0) await bumpUsage(organizationId, actual - replacesBytes);
      },
    };
  }

  const holdId = `stor-${randomUUID()}`;
  await storageAdmissionTx(async (tx) => {
    // Write FIRST: ensure the counter row exists (an org's FIRST upload has
    // none). On SQLite this takes the database write lock at transaction
    // open, so concurrent admissions serialize HERE — the loser's reads see
    // the winner's hold. On Postgres the Serializable snapshot does the
    // same job; the upsert also guarantees the counter row the settle path
    // increments actually exists.
    await tx.storageUsage.upsert({
      where: { organizationId },
      update: {},
      create: { organizationId, bytes: 0 },
    });
    const [usage, holds] = await Promise.all([
      tx.storageUsage.findUnique({ where: { organizationId } }),
      tx.storageReservation.aggregate({
        _sum: { bytes: true },
        where: { organizationId, expiresAt: { gt: new Date() } }, // LIVE holds only
      }),
    ]);
    const committed = usage ? Number(usage.bytes) : 0;
    const inFlight = holds._sum.bytes ? Number(holds._sum.bytes) : 0;
    if (committed + inFlight - replacesBytes + Math.max(0, incomingBytes) > quota) {
      throw new StorageQuotaError(organizationId, committed + inFlight, quota);
    }
    await tx.storageReservation.create({
      data: {
        id: holdId,
        organizationId,
        key,
        bytes: BigInt(Math.max(0, incomingBytes)),
        expiresAt: new Date(Date.now() + ttlMs),
      },
    });
  });

  return {
    release: async () => {
      await rawDb.storageReservation.deleteMany({ where: { id: holdId } });
    },
    commit: async (actual) => {
      // Settle atomically: the hold comes off and the REAL delta lands in
      // the counter in one transaction (a crash cannot split them).
      const delta = actual - replacesBytes;
      await storageAdmissionTx(async (tx) => {
        await tx.storageReservation.deleteMany({ where: { id: holdId } });
        if (delta !== 0) {
          await tx.storageUsage.upsert({
            where: { organizationId },
            update: { bytes: { increment: delta } },
            create: { organizationId, bytes: BigInt(Math.max(0, delta)) },
          });
        }
      });
    },
  };
}

/** Drop every expired hold (crashed uploaders' TTL passed). Holds never
 *  moved the committed counter, so dropping is pure quota reclaim. */
export async function sweepExpiredStorageReservations(): Promise<number> {
  const rows = await rawDb.storageReservation.findMany({
    where: { expiresAt: { lt: new Date() } },
    select: { id: true },
    take: 200,
  });
  for (const r of rows) {
    await rawDb.storageReservation.deleteMany({ where: { id: r.id } }).catch(() => {});
  }
  if (rows.length) log.info("storage: expired reservations swept (quota freed)", { count: rows.length });
  return rows.length;
}
