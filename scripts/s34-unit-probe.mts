// S34 unit probe — closing the spend-gate estimator's two remaining defects
// (the audit's Gap C, deferred by S32's own commit message):
//   1. Script-aware input floors — chars/3 under-reserved non-Latin text
//      ~4.5x (CJK tokenizes at ~1.5 tokens/CHAR, not 3 chars/token). The
//      estimator now floors ASCII at chars/3 (the S27 English+JSON law,
//      unchanged), CJK/complex scripts at 1.5 tokens/char, other non-ASCII
//      at 1/char, astral plane at 2/char.
//   2. Per-hold usage slices — settleFromSink read peekLastUsage(): the LAST
//      entry in the REQUEST-scoped sink. A no-usage dispatch settled at a
//      STALE usage an earlier dispatch emitted; a double-emitting transport
//      settled at only the second attempt. Holds now snapshot the sink at
//      admit time and settle on exactly their own entries.
//
// The probe exercises REAL admitDispatch holds (pricing verified via the env
// override, gate state pre-booted — the s32-probe pattern) against a real
// PrismaClient, and proves the settle costs from the SpendReservation rows.
//
// Run: node --import tsx scripts/s34-unit-probe.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";
process.env.TUBEFORGE_PRICING_VERIFIED ??= "1";

import { PrismaClient } from "@prisma/client";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import {
  estimateInputTokens,
  estimateDispatchMicroUsd,
  emitUsage,
  admitDispatch,
} from "../src/lib/tubeforge/spend";

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36);
const EMAIL = `s34-probe-${SUFFIX}@e2e.local`;
let userId = "";
let orgId = "";

const __BASELINE = {
  users: await prisma.user.count(),
  reservations: await prisma.spendReservation.count(),
};
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// The gate's global state — pre-boot so admitDispatch skips the DB bootstrap
// (the s32-unit-probe pattern; the durability laws are that probe's business).
const spendState = (globalThis as typeof globalThis & {
  __tfSpend?: {
    booted: boolean;
    bootFailed: boolean;
    bootPromise: Promise<void> | null;
    recordedMicro: number;
    holds: Map<string, number>;
    nextHoldId: number;
  };
}).__tfSpend!;
function resetGate() {
  spendState.booted = true;
  spendState.bootFailed = false;
  spendState.bootPromise ??= Promise.resolve();
  spendState.recordedMicro = 0;
  spendState.holds.clear();
}

// ---------- §1 the estimator's script-aware floors ----------
console.log("\n§1 script-aware input floors");
{
  check("ASCII law unchanged: 6000 ASCII chars → 2000 tokens",
    estimateInputTokens("a".repeat(6000)) === 2000, estimateInputTokens("a".repeat(6000)));
  check("CJK law: 6000 Han chars → 9000 tokens (was 2000 — the 4.5x under-reserve)",
    estimateInputTokens("好".repeat(6000)) === 9000, estimateInputTokens("好".repeat(6000)));
  check("astral law: 100 emoji → 200 tokens",
    estimateInputTokens("😀".repeat(100)) === 200, estimateInputTokens("😀".repeat(100)));
  check("dispatch-level: same-length CJK text reserves strictly more µ$",
    estimateDispatchMicroUsd("gpt-6.1-sol", ["好".repeat(6000)]) >
      estimateDispatchMicroUsd("gpt-6.1-sol", ["a".repeat(6000)]));
  check("dispatch-level: base64 runs are stripped before token math (a giant image payload prices as one small text)",
    estimateDispatchMicroUsd("gpt-6.1-sol", ["data:image/png;base64," + "A".repeat(100_000)]) ===
      estimateDispatchMicroUsd("gpt-6.1-sol", ["data:image/png;base64," + "B".repeat(100_000)]));
}

// ---------- §2 the stale-usage regression + multi-emit sum, on real holds ----------
console.log("\n§2 per-hold usage slices (real admitDispatch holds)");
{
  const user = await prisma.user.create({
    data: { email: EMAIL, passwordHash: await hashPassword("probe-pw-123"), name: "s34 probe" },
  });
  userId = user.id;
  const org = await prisma.organization.create({
    data: {
      name: "s34 probe org",
      slug: `s34-probe-${SUFFIX}`,
      memberships: { create: { userId, role: "owner" } },
    },
  });
  orgId = org.id;

  await withCtx({ userId, organizationId: orgId, role: "owner" }, async () => {
    resetGate();
    const MODEL = "gpt-6.1-sol"; // registry: 2 µ$/in-token, 10 µ$/out-token
    const est = estimateDispatchMicroUsd(MODEL, ["a".repeat(300)]);

    // Dispatch A — provider reports usage. The hold must settle at the
    // REPORTED cost: (200 in × 2) + (900 out × 10) = 9400 µ$.
    const holdA = await admitDispatch({ provider: "openai", model: MODEL, estimatedMicro: est });
    check("A: admit returns a hold (pricing verified via env)", holdA !== null);
    emitUsage({ inputTokens: 200, outputTokens: 900 });
    await holdA!.settleFromSink();
    const settledRows = async () =>
      prisma.spendReservation.findMany({ where: { userId, status: "settled" } });
    let rows = await settledRows();
    check("A: exactly one settled row so far", rows.length === 1, rows.length);
    const idA = rows[0]?.id ?? "";
    check("A: settled at the REPORTED usage cost (9400 µ$)",
      rows[0]?.actualCostMicroUsd === 9400, rows[0]?.actualCostMicroUsd);

    // Dispatch B — provider answers WITHOUT a usage block. The pre-S34 bug:
    // peekLastUsage() still saw A's entry → B settled at 9400 (A's cost).
    // The fix: B settles at its own reserved estimate.
    const holdB = await admitDispatch({ provider: "openai", model: MODEL, estimatedMicro: est });
    check("B: admit returns a hold", holdB !== null);
    await holdB!.settleFromSink(); // NO emitUsage — nothing reported
    rows = await settledRows();
    const rowB = rows.find((r) => r.id !== idA);
    check("B: exactly one new settled row", rows.length === 2, rows.length);
    check("B: no-usage dispatch settles at the ESTIMATE, not A's stale usage",
      rowB?.actualCostMicroUsd === est, { rowB: rowB?.actualCostMicroUsd, est });
    check("B: the stale read is provably gone (settled ≠ A's 9400)",
      rowB?.actualCostMicroUsd !== 9400);

    // Dispatch C — an internally retried transport where BOTH attempts got
    // billed responses. The slice sums: (100+50 in × 2) + (50+25 out × 10) = 1050.
    const holdC = await admitDispatch({ provider: "openai", model: MODEL, estimatedMicro: est });
    emitUsage({ inputTokens: 100, outputTokens: 50 });
    emitUsage({ inputTokens: 50, outputTokens: 25 });
    await holdC!.settleFromSink();
    rows = await settledRows();
    const rowC = rows.find((r) => r.id !== idA && r.id !== rowB?.id);
    check("C: exactly three settled rows", rows.length === 3, rows.length);
    check("C: double-emitting transport settles at the SUM of both attempts (1050 µ$)",
      rowC?.actualCostMicroUsd === 1050, rowC?.actualCostMicroUsd);

    // The recorded total took all three settlements.
    const expectedRecorded = 9400 + est + 1050;
    check("the in-memory recorded total sums all three settlements",
      spendState.recordedMicro === expectedRecorded,
      { recorded: spendState.recordedMicro, expectedRecorded });
  });
}

// ---------- §3 teardown ----------
await prisma.spendReservation.deleteMany({ where: { userId: userId || undefined } });
await prisma.usageRecord.deleteMany({ where: { userId: userId || undefined } });
await prisma.creditLedger.deleteMany({ where: { userId: userId || undefined } });
if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
const leftoverUsers = await prisma.user.count();
const leftoverReservations = await prisma.spendReservation.count();
check("teardown: nothing behind (users + reservations back to baseline)",
  leftoverUsers === __BASELINE.users && leftoverReservations === __BASELINE.reservations,
  { leftoverUsers, leftoverReservations, __BASELINE });

console.log(`\n${failures === 0 ? "S34 UNIT PROBE: ALL PASS" : `S34 UNIT PROBE: ${failures} FAILURE(S)`}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
