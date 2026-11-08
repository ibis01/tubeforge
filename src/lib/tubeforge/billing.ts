// billing.ts — Stage 7 T-7.5: Stripe billing scaffolding.
//
// This module is the public surface for billing — every route and job that
// needs "what plan is this user on" or "did this spend leave credits" goes
// through here. The ROADMAP calls this a "Stage 6 deliverable" picked up
// here; the reconciliation tests are the real ask.
//
// Design (per MASTER_PLAN §5 + the audit's R-HIGH-12):
//
//   * Three plans: starter (free), creator (paid), studio (paid).
//   * One Subscription row per user. A user with no row gets the default
//     Starter plan (resolved in code, never written) — fresh installs
//     don't need to seed rows for existing users.
//   * CreditGrant rows are monthly allotments; CreditLedger rows are
//     individual spends (and refunds — signed microCredits).
//   * CANONICAL UNIT (Stage 7.1): every credit number in this module's
//     math is a MICROCREDIT (1 UI credit = 1,000 microCredits). Plan
//     allowances are quoted in UI credits (marketing unit) and converted
//     once, at grant time; balances convert back to credits only for
//     display (microToCredits in the API/UI layer).
//   * Subscription-status access rules (Stage 7.1): active/trialing get
//     the paid plan, past_due keeps it on a grace period, canceled (and
//     any unknown status) falls back to Starter — enforced in
//     resolveUserPlan, tested per status.
//   * The remaining balance is PERIOD-SCOPED (Stage 7.2 fix A): grants
//     covering now minus ledger activity recorded inside the grants'
//     window — never lifetime spending. Credits do not roll over; each
//     period starts fresh. USER-SCOPED (never via the subscription's
//     ledger relation) so legacy null-linked in-window rows still count.
//     Computed on demand; never denormalized into Subscription.
//   * AI calls RESERVE before they run (Stage 7.2 fix B): reserveCredits
//     holds the estimated cost transactionally, the call executes, then
//     settleCreditHold reconciles the hold to the actual cost (or releases
//     it on failure). A double settlement is impossible — the settlement
//     row's reconcilesId is UNIQUE at the database level.
//   * The Stripe webhook updates the Subscription on `invoice.paid` /
//     `customer.subscription.updated`; `customer.subscription.deleted` →
//     status:"canceled"; the resolver then falls back to Starter.
//   * Webhook idempotency (Stage 7.1): every handled event id is recorded
//     in ProcessedWebhookEvent BEFORE the handler runs; a retried delivery
//     hits the primary key and is acked as a duplicate. invoice.paid
//     grants additionally upsert on CreditGrant.stripeInvoiceId (unique),
//     so a grant is physically impossible to double-apply.
//   * Overspend prevention (Stage 7.1): spendCredits() is the enforcement
//     primitive — a transactional check-and-spend that re-reads the
//     balance INSIDE the transaction, so concurrent metered spends can
//     never push a paid balance below zero.
//
// What this module does NOT do (deliberate scope):
//   * Stripe Checkout / Customer Portal integration — those routes are
//     added in a follow-up. This module + the webhook + the resolver are
//     the foundation; the checkout can be wired in later.
//   * Auto-creating a Subscription on registration. The resolver returns
//     the Starter plan when no Subscription exists, so this is unnecessary
//     and avoids a write on every register.

import { Prisma } from "@prisma/client";
import { db as rawDb } from "@/lib/db";
import { log } from "@/lib/tubeforge/log";

// S57/T-57.2 — the module's loggers (the old [billing]/[billing/webhook]
// string prefixes became bindings).
const billingLog = log.child({ mod: "billing" });
const webhookLog = log.child({ mod: "billing:webhook" });

// ---------- plan catalog ----------

export interface PlanInfo {
  id: string;
  tier: string; // starter | creator | studio
  name: string;
  monthlyCredits: number;
  maxResolution: string;
  priorityRendering: boolean;
  teamMembers: number;
}

/** The three plans, hardcoded as the fallback when no Plan rows exist in
 *  the DB. New installs seed the rows once at deploy time; the fallback
 *  keeps this module functional before the seed runs. */
export const PLAN_DEFAULTS: Record<string, PlanInfo> = {
  starter: {
    id: "starter",
    tier: "starter",
    name: "Starter",
    monthlyCredits: 1000, // ~10 short renders / month at the prod cost-per-render estimate
    maxResolution: "1080p",
    priorityRendering: false,
    teamMembers: 1,
  },
  creator: {
    id: "creator",
    tier: "creator",
    name: "Creator",
    monthlyCredits: 10000,
    maxResolution: "1440p",
    priorityRendering: true,
    teamMembers: 1,
  },
  studio: {
    id: "studio",
    tier: "studio",
    name: "Studio",
    monthlyCredits: 50000,
    maxResolution: "2160p",
    priorityRendering: true,
    teamMembers: 10,
  },
};

// ---------- canonical credit unit ----------
//
// Stage 7.1 fix: the ledger used to mix UI credits (grants) with
// microCredits (spends) in one sum, so a Creator's stated 10,000-credit
// allowance failed the 50,000-microCredit render pre-check. There is now
// ONE canonical unit for all ledger math: the MICROCREDIT. UI credits
// exist only at the edges — plan allowances (marketing) and display.

export const MICROS_PER_CREDIT = 1000; // 1 UI credit = 1,000 microCredits = $0.001 (placeholder pricing)

/** UI credits → microCredits (the canonical ledger unit). */
export function creditsToMicro(credits: number): number {
  return Math.round(credits * MICROS_PER_CREDIT);
}

/** microCredits → UI credits for DISPLAY (floored — never overstate a
 *  balance). e.g. 9,999 microCredits shows as 9 credits. */
export function microToCredits(micro: number): number {
  return Math.floor(micro / MICROS_PER_CREDIT);
}

// ---------- period-scoped balance (Stage 7.2 fix A) ----------
//
// Problem A (external review): the resolver and spendCredits subtracted the
// user's ALL-TIME ledger from the CURRENT period's grants, so month 2's
// balance came out as grant2 − (month 1 + month 2 spending) — a customer who
// used 9,000 of 10,000 credits saw 1,000 after renewal instead of 10,000.
//
// ROLLOVER RULE (explicit): credits do NOT roll over. A period's balance =
// that period's grants − net ledger activity recorded INSIDE that period.
// Leftover credits expire at period end; a refund benefits whichever period
// it is RECORDED in.
//
// The window follows the GRANTS: CreditGrant.periodStart/End are the
// periods Stripe actually invoiced (invoice.paid handler), so they are the
// ground truth of "now is inside period N" — the Subscription row only
// carries currentPeriodEnd and can lag the webhook.

export interface PeriodBalance {
  /** Covering grants' total, in microCredits. */
  granted: number;
  /** Positive (spend-side) ledger rows inside the window. */
  spent: number;
  /** |negative| ledger rows inside the window (refunds / releases). */
  refunded: number;
  /** granted − spent + refunded. */
  balance: number;
  /** Earliest covering grant's periodStart — where the ledger window opens. */
  windowStart: Date | null;
}

type BalanceDbx = Pick<Prisma.TransactionClient, "creditGrant" | "creditLedger">;

/** Compute the period-scoped balance. Works against the raw client OR an
 *  open transaction client (spendCredits / reserveCredits run it inside
 *  the tx so the check and the write commit atomically). */
async function computePeriodBalance(dbx: BalanceDbx, userId: string, now: Date): Promise<PeriodBalance> {
  const grants = await dbx.creditGrant.findMany({
    where: { userId, periodStart: { lte: now }, periodEnd: { gte: now } },
    select: { grantedMicroCredits: true, periodStart: true },
    orderBy: { periodStart: "asc" },
  });
  const granted = grants.reduce((acc, g) => acc + g.grantedMicroCredits, 0);
  if (!grants.length) return { granted: 0, spent: 0, refunded: 0, balance: 0, windowStart: null };
  // Widest window wins: several covering grants (operator top-ups, a late
  // webhook racing a renewal) open the ledger at the EARLIEST periodStart —
  // the conservative reading that favors the platform.
  const windowStart = grants[0].periodStart;
  const ledger = await dbx.creditLedger.findMany({
    where: { userId, createdAt: { gte: windowStart } },
    select: { microCredits: true },
  });
  const spent = ledger.reduce((acc, l) => acc + Math.max(0, l.microCredits), 0);
  const refunded = ledger.reduce((acc, l) => acc + Math.abs(Math.min(0, l.microCredits)), 0);
  return { granted, spent, refunded, balance: granted - spent + refunded, windowStart };
}

// ---------- resolver ----------

export interface ResolvedPlan {
  plan: PlanInfo;
  subscription: {
    id: string;
    status: string;
    currentPeriodEnd: Date | null;
    stripeCustomerId: string | null;
  } | null;
  /** The remaining credit balance in MICROCREDITS (canonical unit —
   *  convert with microToCredits for display). Negative = overdrawn. */
  creditBalance: number;
  /** Stage 7.1: "full" (active/trialing), "grace" (past_due — paid plan
   *  continues while dunning runs), or "none" (canceled/etc. — the plan
   *  fell back to Starter). UI reads this to show payment-failure banners. */
  access: "full" | "grace" | "none";
}

// ---------- subscription status → access rules ----------
//
// Stage 7.1 fix: the resolver used to return the subscription's plan
// regardless of status, so a canceled subscription kept paid entitlements
// forever. The rules are now explicit and tested per status:
//
//   active              → "full"   — paying, everything works.
//   trialing            → "full"   — trial of a paid plan, full access.
//   past_due            → "grace"  — dunning in progress (Smart Retries):
//                                    the paid plan keeps working (credits
//                                    for the period were already granted)
//                                    but the UI shows a payment-failed
//                                    banner. If dunning exhausts, Stripe
//                                    moves the sub to canceled/unpaid.
//   canceled / unpaid /
//   incomplete /
//   incomplete_expired /
//   paused / anything
//   unknown             → "none"   — no paid entitlements; the resolver
//                                    falls back to the Starter plan.

export type SubscriptionAccess = "full" | "grace" | "none";

const STATUS_ACCESS: Record<string, SubscriptionAccess> = {
  active: "full",
  trialing: "full",
  past_due: "grace",
  canceled: "none",
  unpaid: "none",
  incomplete: "none",
  incomplete_expired: "none",
  paused: "none",
};

/** Map a Stripe subscription status to the access level it buys. Unknown
 *  statuses fail CLOSED ("none") — a new Stripe status never grants
 *  entitlements until it is explicitly allow-listed here. */
export function subscriptionAccess(status: string | null | undefined): SubscriptionAccess {
  if (!status) return "none";
  return STATUS_ACCESS[status] ?? "none";
}

/** Resolve the user's current plan + credit balance. Returns the Starter
 *  plan (hardcoded) when the user has no Subscription row — fresh installs
 *  never need to seed rows for existing users. A subscription whose status
 *  buys no access (canceled/unpaid/incomplete — see subscriptionAccess)
 *  ALSO resolves to Starter, keeping its subscription record for the UI.
 *
 *  The balance is computed USER-SCOPED (grants and ledger both filtered by
 *  userId directly, never via the subscription's relations) — Stage 7.1 fix
 *  for the linkage defect: spends recorded before the subscription existed
 *  (subscriptionId: null) still count, and a spend row that failed to link
 *  can never silently resurrect spent credits.
 *
 *  Runs UN-SCOPED (rawDb) — the resolver is called from outside a request
 *  scope by the billing webhook, and from inside one by the auth-status
 *  route; both paths need the same answer. */
export async function resolveUserPlan(userId: string): Promise<ResolvedPlan> {
  const subscription = await rawDb.subscription.findUnique({
    where: { userId },
    include: { plan: true },
  });

  if (!subscription) {
    return {
      plan: PLAN_DEFAULTS.starter,
      subscription: null,
      creditBalance: creditsToMicro(PLAN_DEFAULTS.starter.monthlyCredits),
      access: "none",
    };
  }

  const access = subscriptionAccess(subscription.status);

  // Canceled (or otherwise access-less) subscriptions fall back to the
  // Starter plan — the documented design. The subscription record is still
  // returned so the UI can render "canceled" instead of "free tier".
  if (access === "none") {
    return {
      plan: PLAN_DEFAULTS.starter,
      subscription: {
        id: subscription.id,
        status: subscription.status,
        currentPeriodEnd: subscription.currentPeriodEnd,
        stripeCustomerId: subscription.stripeCustomerId,
      },
      creditBalance: creditsToMicro(PLAN_DEFAULTS.starter.monthlyCredits),
      access: "none",
    };
  }

  const plan: PlanInfo = subscription.plan
    ? {
        id: subscription.plan.id,
        tier: subscription.plan.tier,
        name: subscription.plan.name,
        monthlyCredits: subscription.plan.monthlyCredits,
        maxResolution: subscription.plan.maxResolution,
        priorityRendering: subscription.plan.priorityRendering,
        teamMembers: subscription.plan.teamMembers,
      }
    : PLAN_DEFAULTS[subscription.planId] ?? PLAN_DEFAULTS.starter;

  // Stage 7.2 fix A: the balance is PERIOD-SCOPED — grants covering now
  // minus ledger activity recorded inside the grants' window (never
  // lifetime spending). USER-SCOPED on both sides, so the unit story is:
  // grants are written in microCredits (converted from the plan's
  // UI-credit allowance at grant time) and ledger rows are microCredits.
  const { balance: creditBalance } = await computePeriodBalance(rawDb, userId, new Date());

  return {
    plan,
    subscription: {
      id: subscription.id,
      status: subscription.status,
      currentPeriodEnd: subscription.currentPeriodEnd,
      stripeCustomerId: subscription.stripeCustomerId,
    },
    creditBalance,
    access,
  };
}

// ---------- ledger writes ----------

export type CreditSpendKind =
  | "ai_call" // unmetered (starter) post-call record
  | "render_minute"
  | "publish"
  | "storage"
  | "topup"
  | "refund"
  // Stage 7.2 — reservation kinds (pre-call AI spend enforcement):
  | "hold" // positive — estimated cost reserved BEFORE the provider call
  | "adjustment" // signed — settlement delta: actual − estimate (ok calls)
  | "hold_release"; // negative — reservation refunded (call failed)

export interface CreditSpendOptions {
  userId: string;
  /** Optional — the ledger links to the user's ACTIVE subscription
   *  automatically when omitted/null (Stage 7.1 linkage fix: callers no
   *  longer write null-linked rows; the resolver attaches the id).
   *  Pass it explicitly only when the spend belongs to a subscription the
   *  resolver can't find (e.g. a grant top-up on a brand-new checkout). */
  subscriptionId?: string | null;
  kind: CreditSpendKind;
  microCredits: number;
  usageRecordId?: string | null;
  note?: string | null;
}

/** Resolve the subscription id a spend should link to. Prefers an explicit
 *  id, then the user's subscription row — but only when that subscription
 *  currently buys access (a canceled subscription must not collect new
 *  spend rows; its spends stay null-linked and the user-scoped balance
 *  still counts them). Returns null when there is nothing to link. */
async function resolveSubscriptionIdForSpend(
  userId: string,
  explicitId?: string | null
): Promise<string | null> {
  if (explicitId) return explicitId;
  const sub = await rawDb.subscription.findUnique({
    where: { userId },
    select: { id: true, status: true },
  });
  if (sub && subscriptionAccess(sub.status) !== "none") return sub.id;
  return null;
}

/** Append a credit-spend row to the ledger WITHOUT an entitlement check —
 *  accounting truth, not enforcement. Use this when the cost already
 *  happened (e.g. a finished render's measured seconds) or for refunds.
 *  Negative `microCredits` = a refund (the kind should be "refund").
 *  Idempotent on the caller — never call this twice for the same spend.
 *
 *  For metered, pre-checkable spends use spendCredits() instead — it wraps
 *  this with a transactional balance check so concurrency cannot overspend.
 *
 *  Runs UN-SCOPED — billing writes are global, not per-tenant. */
export async function recordCreditSpend(opts: CreditSpendOptions): Promise<void> {
  const subscriptionId = await resolveSubscriptionIdForSpend(opts.userId, opts.subscriptionId);
  await rawDb.creditLedger.create({
    data: {
      userId: opts.userId,
      subscriptionId,
      kind: opts.kind,
      microCredits: opts.microCredits,
      usageRecordId: opts.usageRecordId ?? null,
      note: opts.note ?? null,
    },
  });
}

export interface SpendResult {
  recorded: boolean;
  /** "insufficient_credits" when the transactional check rejected the
   *  spend; null when recorded (or when force bypassed the check). */
  reason: "insufficient_credits" | null;
  /** Balance in microCredits as observed inside the committing transaction
   *  (post-spend when recorded, as-was when rejected). */
  balanceMicro: number;
}

// Transient transaction failures worth retrying: Prisma's serializable
// conflict / timeout codes (Postgres) plus the SQLite busy/locked family —
// SQLite serializes writers at the file level, so a concurrent interactive
// transaction can surface "database is locked"; a retry re-reads the
// balance, which is exactly the correctness we need.
function isTransientTxError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  if (code === "P2034" || code === "P2024") return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /database is locked|database table is locked|SQLITE_BUSY|Transaction not found/i.test(msg);
}

// In-process serialization for spendCredits. The check+insert must be
// atomic per caller; queuing in-process makes the single-process case
// (web app or worker) deterministic and fast — metering bursts queue on a
// promise chain instead of starving the connection pool with concurrent
// interactive transactions (10 parallel $transaction calls tripped
// Prisma's 5s tx timeout on SQLite). Cross-PROCESS safety is unchanged:
// the transaction still runs BEGIN IMMEDIATE, which takes SQLite's file
// lock, and Postgres runs Serializable with the P2034 retry below.
let spendChain: Promise<unknown> = Promise.resolve();
function queueSpend<T>(fn: () => Promise<T>): Promise<T> {
  const next = spendChain.then(fn, fn);
  spendChain = next.catch(() => {});
  return next;
}

// Shared transaction wrapper for every check-and-write billing primitive
// (spendCredits / reserveCredits / settleCreditHold): Postgres runs
// SERIALIZABLE so two transactions can't both read "balance = 100" and both
// spend 80; SQLite serializes writers at the file level. Transient
// conflicts (P2034 / SQLite busy) retry with exponential backoff.
async function runBilledTx<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const isPostgres = (process.env.DATABASE_URL ?? "").startsWith("postgres");
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await rawDb.$transaction(fn, isPostgres ? { isolationLevel: "Serializable" } : undefined);
    } catch (err) {
      if (attempt < MAX_ATTEMPTS && isTransientTxError(err)) {
        // Exponential backoff — concurrent metering bursts resolve in ms.
        await new Promise((r) => setTimeout(r, 25 * 2 ** (attempt - 1)));
        continue;
      }
      throw err;
    }
  }
  // Unreachable (the loop returns or throws) — keeps TS happy.
  throw new Error("runBilledTx: transaction retry loop exhausted");
}

/** Transactionally check-and-spend credits — THE overspend guard (Stage 7.1
 *  fix #6). Reads the balance INSIDE the transaction (period-scoped grants
 *  − ledger, the same math as resolveUserPlan), rejects the spend when the
 *  paid balance can't cover `microCredits`, and only then inserts the
 *  ledger row (linking the user's active subscription). Concurrent calls
 *  are serialized — in-process by the queue above, cross-process by the
 *  transaction (SQLite file lock / Postgres Serializable with retry) — so
 *  parallel metered spends can never drive a balance below zero.
 *
 *  `force: true` bypasses the check and records unconditionally — for
 *  costs that already happened (the enforcement point is the pre-gate,
 *  not the post-hoc record). The Starter/free tier is never hard-blocked
 *  (mirrors hasCredits) — the check still runs and reports the balance.
 *
 *  Idempotent on the caller — never call this twice for the same spend. */
export async function spendCredits(opts: CreditSpendOptions & { force?: boolean }): Promise<SpendResult> {
  return queueSpend(() =>
    runBilledTx(async (tx) => {
      const subscription = await tx.subscription.findUnique({
        where: { userId: opts.userId },
        select: { id: true, status: true, planId: true, plan: { select: { tier: true } } },
      });
      const access = subscriptionAccess(subscription?.status);
      // Enforcement tier follows the ACCESS decision, not the stored
      // plan row: a canceled creator subscription has already fallen
      // back to Starter (resolveUserPlan), so it must not be gated
      // against its stale creator grants here either.
      const tier = access === "none" ? "starter" : (subscription?.plan?.tier ?? "starter");

      // Stage 7.2 fix A: the balance is PERIOD-SCOPED — grants covering
      // now minus ledger activity recorded inside the grants' window.
      const balance = await computePeriodBalance(tx, opts.userId, new Date());

      // Enforcement: paid tiers must cover the spend; the free tier
      // never hard-blocks (documented overdraft design).
      const enough = balance.balance >= opts.microCredits;
      if (!enough && !opts.force && tier !== "starter") {
        return { recorded: false, reason: "insufficient_credits" as const, balanceMicro: balance.balance };
      }

      await tx.creditLedger.create({
        data: {
          userId: opts.userId,
          // Link inside the tx — a canceled/unpaid subscription must
          // not collect rows (its balance math is user-scoped anyway).
          subscriptionId:
            opts.subscriptionId ??
            (access !== "none" ? (subscription?.id ?? null) : null),
          kind: opts.kind,
          microCredits: opts.microCredits,
          usageRecordId: opts.usageRecordId ?? null,
          note: opts.note ?? null,
        },
      });
      return { recorded: true, reason: null, balanceMicro: balance.balance - Math.max(0, opts.microCredits) };
    })
  );
}

// ---------- credit reservations (Stage 7.2 fix B) ----------
//
// Problem B (external review): the AI provider call ran BEFORE the credit
// check — spendCredits() could only refuse to RECORD an unaffordable call
// that had already executed. The reservation pattern enforces BEFORE:
//
//   1. reserveCredits()   — transactional balance check + a positive `hold`
//      row for the estimated cost, BEFORE the provider call.
//   2. Execute the AI call.
//   3. settleCreditHold() — ONE signed settlement row per hold:
//        ok     → `adjustment` (actual − estimate; a zero marker when equal)
//        failed → `hold_release` (− estimate — the reservation is refunded)
//      reconcilesId (UNIQUE) carries the hold's id, so the double-deduct
//      the review warned about is impossible at the DATABASE level.
//
// Semantics pinned here:
//   * The hold counts against the balance the moment it is written — a
//     caller with an open hold sees their remaining credits shrink, and a
//     second reservation cannot borrow against it.
//   * FAILED calls RELEASE (net 0). The old post-call path charged
//     failures ("the provider may have billed for the attempt") — with a
//     hold, the honest default is the user pays for what was delivered.
//   * Starter/free tier never reserves (documented overdraft design) —
//     those calls keep the post-call spendCredits accounting.
//   * Enforcement is FAIL-CLOSED: if the reservation cannot be verified
//     (transaction error after retries), the caller must NOT run the
//     provider call — budget.ts turns a reserveCredits throw into a
//     CreditBlockedError, never a free call.
//   * Known limitation: a hard process crash mid-call leaves an unsettled
//     hold that keeps counting (fail-closed). An operator sweep can release
//     stale holds (kind 'hold', no settlement row) — a follow-up, not a
//     correctness defect: the balance errs CONSERVATIVELY.

export type CreditHold =
  | { mode: "held"; holdId: string; estimatedMicro: number; balanceMicro: number }
  | { mode: "unmetered"; balanceMicro: number }
  | { mode: "blocked"; estimatedMicro: number; balanceMicro: number };

/** Typed rejection for a blocked pre-call reservation — jobs and routes
 *  surface message directly; instanceof lets them map to a 402. */
export class CreditBlockedError extends Error {
  constructor(
    public readonly capability: string,
    public readonly estimatedMicro: number,
    public readonly balanceMicro: number
  ) {
    super(
      `Insufficient credits: ${capability} needs ${microToCredits(estimatedMicro)} credits, ` +
        `but the balance is ${microToCredits(balanceMicro)}. Wait for the next billing period or upgrade the plan.`
    );
    this.name = "CreditBlockedError";
  }
}

/** Map a thrown CreditBlockedError to a JSON 402 response for interactive
 *  routes. Returns null for any other error so callers fall through to
 *  their normal error handling. Phase 0 audit C7: this module's doc-comment
 *  always promised that "instanceof lets them map to a 402" — this is the
 *  shared implementation, so no route hand-rolls the mapping. */
export function creditBlockResponse(err: unknown): Response | null {
  if (!(err instanceof CreditBlockedError)) return null;
  return new Response(
    JSON.stringify({
      error: err.message,
      code: "insufficient_credits",
      capability: err.capability,
      estimatedMicro: err.estimatedMicro,
      balanceMicro: err.balanceMicro,
    }),
    { status: 402, headers: { "content-type": "application/json" } }
  );
}

/** Which tiers enforce reservations. Starter = overdraft design (documented
 *  in hasCredits) — its calls stay on post-call accounting. Pure, unit-pinned. */
export function reservationEnforcement(tier: string): "unmetered" | "enforced" {
  return tier === "starter" ? "unmetered" : "enforced";
}

/** Reserve the estimated cost of an AI call BEFORE it runs. Transactional
 *  check-and-hold, serialized exactly like spendCredits. Returns held (go
 *  run the call, then settle), unmetered (starter/free — no hold needed,
 *  post-call accounting applies) or blocked (do NOT run the call). */
export async function reserveCredits(opts: {
  userId: string;
  estimatedMicro: number;
  capability?: string;
  note?: string | null;
}): Promise<CreditHold> {
  return queueSpend(() =>
    runBilledTx(async (tx) => {
      const subscription = await tx.subscription.findUnique({
        where: { userId: opts.userId },
        select: { id: true, status: true, planId: true, plan: { select: { tier: true } } },
      });
      const access = subscriptionAccess(subscription?.status);
      const tier = access === "none" ? "starter" : (subscription?.plan?.tier ?? "starter");
      const balance = await computePeriodBalance(tx, opts.userId, new Date());
      if (reservationEnforcement(tier) === "unmetered")
        return { mode: "unmetered" as const, balanceMicro: balance.balance };
      if (balance.balance < opts.estimatedMicro)
        return { mode: "blocked" as const, estimatedMicro: opts.estimatedMicro, balanceMicro: balance.balance };
      const row = await tx.creditLedger.create({
        data: {
          userId: opts.userId,
          subscriptionId: access !== "none" ? (subscription?.id ?? null) : null,
          kind: "hold",
          microCredits: opts.estimatedMicro,
          note: opts.note ?? (opts.capability ? `${opts.capability} hold` : "reservation hold"),
        },
      });
      return {
        mode: "held" as const,
        holdId: row.id,
        estimatedMicro: opts.estimatedMicro,
        balanceMicro: balance.balance - opts.estimatedMicro,
      };
    })
  );
}

export type SettleResult =
  | { settled: true; kind: "adjustment" | "hold_release"; deltaMicro: number; balanceMicro: number }
  | { settled: false; reason: "unknown_hold" | "already_settled" };

/** Settle (or release) a reservation — exactly once per hold, enforced by
 *  the UNIQUE reconcilesId: a duplicate settle returns already_settled and
 *  changes nothing. ok=true reconciles the hold toward the actual cost
 *  (default: the held estimate — today's per-call estimates are the ground
 *  truth until provider-level token metering lands); ok=false releases the
 *  hold in full (the call failed — nothing was delivered).
 *
 *  Best-effort enrichment: the settlement row AND the hold row carry the
 *  UsageRecord id, so a reconciliation join on usageRecordId sees
 *  hold(+estimate) + adjustment(±delta) = actual for every call. */
export async function settleCreditHold(opts: {
  holdId: string;
  ok: boolean;
  actualMicro?: number;
  usageRecordId?: string | null;
  note?: string | null;
}): Promise<SettleResult> {
  return queueSpend(() =>
    runBilledTx(async (tx) => {
      const hold = await tx.creditLedger.findUnique({ where: { id: opts.holdId } });
      if (!hold || hold.kind !== "hold")
        return { settled: false as const, reason: "unknown_hold" as const };
      const target = opts.ok ? Math.max(0, Math.round(opts.actualMicro ?? hold.microCredits)) : 0;
      const delta = target - hold.microCredits;
      try {
        // ALWAYS a settlement row — even when delta = 0 (a zero-amount
        // marker) — so the unique reconcilesId proves "settled" for every
        // hold and a duplicate settle can never adjust twice.
        await tx.creditLedger.create({
          data: {
            userId: hold.userId,
            subscriptionId: hold.subscriptionId,
            kind: opts.ok ? "adjustment" : "hold_release",
            microCredits: delta,
            usageRecordId: opts.usageRecordId ?? null,
            reconcilesId: hold.id,
            note:
              opts.note ??
              (opts.ok
                ? `hold settled — actual ${target} vs estimate ${hold.microCredits}`
                : `hold released — AI call failed`),
          },
        });
      } catch (err) {
        if ((err as { code?: string } | null)?.code === "P2002")
          return { settled: false as const, reason: "already_settled" as const };
        throw err;
      }
      // Enrich the hold with the usage link (metadata only — amounts and
      // kinds never change on an existing row).
      if (opts.usageRecordId) {
        await tx.creditLedger
          .update({ where: { id: hold.id }, data: { usageRecordId: opts.usageRecordId } })
          .catch(() => {});
      }
      const balance = await computePeriodBalance(tx, hold.userId, new Date());
      return {
        settled: true as const,
        kind: opts.ok ? ("adjustment" as const) : ("hold_release" as const),
        deltaMicro: delta,
        balanceMicro: balance.balance,
      };
    })
  );
}

// ---------- stale-hold sweep (Stage 7.2 documented follow-up) ----------

/** Age at which a hold is considered stale. The longest legitimate hold is
 *  an i2v generation polled inline (~10 min incl. retries); 2h is safely
 *  beyond anything a live call can produce. Overridable for tests. */
const STALE_HOLD_DEFAULT_MS = 2 * 60 * 60 * 1000;

function staleHoldMaxAgeMs(): number {
  const raw = Number(process.env.TUBEFORGE_STALE_HOLD_MS ?? 0);
  return raw > 0 ? raw : STALE_HOLD_DEFAULT_MS;
}

export interface StaleHoldSweepResult {
  scanned: number;
  released: number; // unsettled holds older than the cutoff — released in full
  alreadySettled: number; // settled between scan and sweep — no-op
}

/** Release holds whose owning process died between reserveCredits and
 *  settleCreditHold (hard crash) — the fail-closed limitation documented at
 *  the top of this module. Each release goes through settleCreditHold
 *  (ok=false), so it is transactional, single-shot (reconcilesId UNIQUE
 *  forbids a double release) and restores the full estimate to the
 *  balance. Only UNSETTLED holds older than the cutoff are targeted (the
 *  NOT EXISTS anti-join keeps the limit aimed at real work); fresh holds
 *  are never touched — the cutoff sits hours beyond any legitimate call.
 *  Note: a release of a hold taken in a PREVIOUS period lands in the
 *  current period's balance — user-favorable and bounded by the hold size
 *  (the alternative is the user losing the credits forever). */
export async function releaseStaleHolds(opts: {
  olderThanMs?: number;
  limit?: number;
  note?: string;
} = {}): Promise<StaleHoldSweepResult> {
  const olderThanMs = Math.max(60_000, opts.olderThanMs ?? staleHoldMaxAgeMs());
  const limit = Math.min(500, Math.max(1, opts.limit ?? 200));
  const cutoff = new Date(Date.now() - olderThanMs);
  const stale = await rawDb.$queryRaw<{ id: string }[]>`
    SELECT h.id FROM "CreditLedger" h
    WHERE h.kind = 'hold' AND h.createdAt < ${cutoff}
      AND NOT EXISTS (SELECT 1 FROM "CreditLedger" s WHERE s.reconcilesId = h.id)
    ORDER BY h.createdAt ASC
    LIMIT ${limit}`;
  let released = 0;
  let alreadySettled = 0;
  for (const hold of stale) {
    const result = await settleCreditHold({
      holdId: hold.id,
      ok: false,
      note: opts.note ?? "stale hold sweep — the owning process died before settlement",
    });
    if (result.settled) released += 1;
    else alreadySettled += 1;
  }
  return { scanned: stale.length, released, alreadySettled };
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Boot-time sweeper (web via instrumentation, worker via worker.mts).
 *  One sweep shortly after boot, then every
 *  TUBEFORGE_STALE_HOLD_SWEEP_MS (default 30 min; 0 disables). The timer
 *  is unref'd so it never holds a process open, and every failure is
 *  logged, never thrown — the sweeper must not endanger a boot. */
export function startStaleHoldSweeper(): void {
  if (sweepTimer) return;
  const intervalMs =
    Number(process.env.TUBEFORGE_STALE_HOLD_SWEEP_MS ?? 0) || 30 * 60 * 1000;
  if (intervalMs <= 0) return;
  const run = async (): Promise<void> => {
    try {
      const r = await releaseStaleHolds();
      if (r.released > 0)
        billingLog.info(
          "stale-hold sweep released holds",
          { released: r.released, alreadySettled: r.alreadySettled, scanned: r.scanned }
        );
    } catch (err) {
      billingLog.warn(
        "stale-hold sweep failed",
        { err: err instanceof Error ? err.message : err }
      );
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  timer.unref?.();
  sweepTimer = timer;
  const first = setTimeout(() => void run(), 30_000);
  first.unref?.();
}

// ---------- reconciliation ----------

/** Sum a user's NET metered AI spend over a window. Stage 7.2: the AI-call
 *  family spans hold (estimate) + adjustment (settlement delta) +
 *  hold_release (failed-call release, kind still included so a failed call
 *  nets to 0) + ai_call (the unmetered/starter post-call record). The
 *  reconciliation test joins this against UsageRecords to verify the
 *  credit accounting matches the metered AI costs (the ROADMAP's "exact
 *  credit accounting" gate). */
export const AI_SPEND_KINDS = ["ai_call", "hold", "adjustment", "hold_release"] as const;

export async function sumAICallSpends(
  userId: string,
  from: Date,
  to: Date
): Promise<{ microCredits: number; rowCount: number }> {
  const rows = await rawDb.creditLedger.findMany({
    where: {
      userId,
      kind: { in: [...AI_SPEND_KINDS] },
      createdAt: { gte: from, lte: to },
    },
    select: { microCredits: true },
  });
  return {
    microCredits: rows.reduce((acc, r) => acc + r.microCredits, 0),
    rowCount: rows.length,
  };
}

// ---------- plan gating ----------

/** True when the user's plan can render at the requested resolution. */
export function planSupportsResolution(plan: PlanInfo, resolution: string): boolean {
  const order = ["1080p", "1440p", "2160p"];
  const planIdx = order.indexOf(plan.maxResolution);
  const reqIdx = order.indexOf(resolution);
  if (planIdx === -1 || reqIdx === -1) {
    // Unknown resolution → fall back to "1080p allowed" (the safest default;
    // matches the production render pipeline's behavior).
    return true;
  }
  return reqIdx <= planIdx;
}

/** True when the user has at least `microCredits` remaining. Always true
 *  for the Starter plan (overdraft allowed — the user can pay-as-you-go
 *  after the free credits run out; we don't hard-block AI calls). The
 *  reconciliation test verifies the balance matches the ledger sum. */
export function hasCredits(resolved: ResolvedPlan, microCredits: number): boolean {
  if (resolved.plan.tier === "starter") return true; // free tier, no hard-block
  return resolved.creditBalance >= microCredits;
}

// ---------- cost estimation ----------
//
// The UsageRecord row is the GROUND TRUTH of what ran; its costMicroUsd
// stays 0 today (provider-level token reporting is a Stage 3+ follow-up).
// The credit ledger needs a number NOW, so every capability carries a
// PER-CALL ESTIMATE in micro-USD. These are PLACEHOLDERS — the MASTER_PLAN
// explicitly says "do not set final prices until we know the real cost per
// generated minute". When real provider costs land, update this table (or
// replace it with token-based math) — the ledger's shape does not change,
// so the reconciliation test keeps working either way.
//
// Units: 1 microCredit = 1 micro-USD (1e-6 USD). A "credit" in the UI is
// 1000 microCredits = $0.001 (see CREDITS_PER_USD).

export const CREDITS_PER_USD = 1000; // 1 credit = $0.001 — placeholder pricing unit

export const ESTIMATED_COST_MICRO: Record<string, number> = {
  // Per AI CALL (not per token) — the metered unit budget.ts records today.
  chat: 3000, // LLM script/director/verify passes
  tts: 2000, // voiceover synthesis
  image: 4000, // storyboard art / thumbnails
  video: 40000, // CogVideoX i2v — by far the most expensive call
  search: 1000, // web_search grounding (module A)
  asr: 1500, // caption alignment
};

/** Per-call cost estimate in micro-USD for a capability. Unknown
 *  capabilities fall back to the chat estimate (conservative middle). */
export function getEstimatedCostMicro(capability: string): number {
  return ESTIMATED_COST_MICRO[capability] ?? ESTIMATED_COST_MICRO.chat;
}

/** Flat estimate for one full render, in micro-USD. Used by the render
 *  route's plan gate (before enqueue) — the actual spend is recorded
 *  per-second by the render job on success. Placeholder: revisit with
 *  real per-minute render costs. */
export const RENDER_ESTIMATE_MICRO = 50000; // $0.05 per render attempt

/** Per-second render cost recorded on success (micro-USD per second of
 *  final video). Placeholder — the ledger row's note carries the measured
 *  duration so the reconciliation can re-derive it. */
export const RENDER_MICRO_PER_SEC = 500; // $0.0005/s ≈ $0.03/min

// ---------- webhook handler ----------

export interface StripeEvent {
  /** Stripe event id (evt_…) — recorded in ProcessedWebhookEvent for
   *  exactly-once handling when present. */
  id?: string;
  type: string;
  data?: { object?: Record<string, unknown> };
}

// ---------- processStripeEvent: event-level idempotency (Stage 7.1 #5) ----------

/** Handle a Stripe webhook event EXACTLY ONCE. The route calls this (not
 *  handleStripeEvent directly): the event id is recorded in
 *  ProcessedWebhookEvent BEFORE the handler runs — create-then-handle —
 *  so a retried delivery (Stripe retries until it gets a 2xx) hits the
 *  primary key and is acked as a duplicate without re-running any handler.
 *  If the handler THROWS, the event-id record is deleted again so the
 *  retry Stripe triggers runs the handler for real (only SUCCESSES are
 *  deduped — a failed event must be retryable).
 *
 *  Returns "processed" | "duplicate". Throws on a real handler failure
 *  (the route turns that into HTTP 500 so Stripe retries). */
export async function processStripeEvent(event: StripeEvent): Promise<"processed" | "duplicate"> {
  const eventId = typeof event.id === "string" && event.id ? event.id : null;
  if (!eventId) {
    // No event id (hand-rolled calls in tests) — nothing to dedupe on.
    await handleStripeEvent(event);
    return "processed";
  }
  try {
    await rawDb.processedWebhookEvent.create({ data: { id: eventId, type: event.type } });
  } catch (err) {
    if ((err as { code?: string } | null)?.code === "P2002") {
      webhookLog.warn("duplicate event — acking without re-processing", { eventId, type: event.type });
      return "duplicate";
    }
    throw err;
  }
  try {
    await handleStripeEvent(event);
    return "processed";
  } catch (err) {
    // Free the event id so Stripe's retry can run the handler again.
    await rawDb.processedWebhookEvent.deleteMany({ where: { id: eventId } }).catch(() => {});
    throw err;
  }
}

/** Handle a Stripe webhook event. Exported for tests and for the
 *  processStripeEvent wrapper — the route must go through processStripeEvent.
 *  Throws on a real handler failure.
 *
 *  Idempotency: event-level dedupe happens in processStripeEvent; the
 *  invoice.paid grant additionally upserts on CreditGrant.stripeInvoiceId
 *  (unique) so the SAME invoice delivered under different event ids (e.g.
 *  across API version retries) still grants exactly once. */
export async function handleStripeEvent(event: StripeEvent): Promise<void> {
  switch (event.type) {
    case "checkout.session.completed": {
      const obj = event.data?.object ?? {};
      const meta = (obj.metadata ?? {}) as Record<string, string>;
      const userId = String(obj.client_reference_id ?? meta.userId ?? "");
      const customerId = String(obj.customer ?? "");
      const subscriptionId = String(obj.subscription ?? "");
      const planTier = String(meta.planTier ?? "starter");
      const plan = PLAN_DEFAULTS[planTier] ?? PLAN_DEFAULTS.starter;
      if (!userId || !customerId || !subscriptionId) {
        webhookLog.warn("checkout.session.completed missing fields", { obj });
        break;
      }
      // The user must exist (the client_reference_id carries our userId).
      // An unknown user would fail the FK — ack with a warning instead so
      // Stripe does not retry a permanently-unprocessable event forever.
      const userExists = await rawDb.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!userExists) {
        webhookLog.warn("checkout.session.completed for unknown user — acking without a write", { userId });
        break;
      }
      // Upsert the Subscription. Use a Plan row from the DB if one exists
      // for this tier; else create a starter-plan row on the fly.
      let planRow = await rawDb.plan.findUnique({ where: { tier: planTier } });
      if (!planRow) {
        planRow = await rawDb.plan.create({
          data: {
            name: plan.name,
            tier: plan.tier,
            monthlyCredits: plan.monthlyCredits,
            maxResolution: plan.maxResolution,
            priorityRendering: plan.priorityRendering,
            teamMembers: plan.teamMembers,
          },
        });
      }
      await rawDb.subscription.upsert({
        where: { userId },
        create: {
          userId,
          planId: planRow.id,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          status: "active",
          currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        update: {
          planId: planRow.id,
          stripeCustomerId: customerId,
          stripeSubscriptionId: subscriptionId,
          status: "active",
        },
      });
      break;
    }
    case "customer.subscription.updated": {
      const obj = event.data?.object ?? {};
      const subscriptionId = String(obj.id ?? "");
      const status = String(obj.status ?? "active");
      const periodEnd = Number(obj.current_period_end ?? 0);
      if (!subscriptionId) break;
      await rawDb.subscription.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: {
          status,
          currentPeriodEnd: periodEnd > 0 ? new Date(periodEnd * 1000) : null,
        },
      });
      break;
    }
    case "customer.subscription.deleted": {
      const obj = event.data?.object ?? {};
      const subscriptionId = String(obj.id ?? "");
      if (!subscriptionId) break;
      await rawDb.subscription.updateMany({
        where: { stripeSubscriptionId: subscriptionId },
        data: { status: "canceled" },
      });
      break;
    }
    case "invoice.paid": {
      const obj = event.data?.object ?? {};
      const subscriptionId = String(obj.subscription ?? "");
      const invoiceId = String(obj.id ?? ""); // e.g. in_… — the grant's idempotency key
      const periodStart = Number(obj.period_start ?? 0);
      const periodEnd = Number(obj.period_end ?? 0);
      if (!subscriptionId) break;
      const sub = await rawDb.subscription.findFirst({
        where: { stripeSubscriptionId: subscriptionId },
      });
      if (!sub) {
        webhookLog.warn("invoice.paid for unknown subscription", { subscriptionId });
        break;
      }
      // Stage 7.1 B-6b (caught by the lifecycle integration test): a paid
      // invoice for a CANCELED subscription grants NOTHING. A late or
      // replayed invoice must not mint credits onto an account whose
      // subscription has ended — the user-scoped balance would otherwise
      // hand those orphaned credits to the user's NEXT subscription. The
      // re-activation below already skips canceled; the GRANT must skip
      // canceled too. Genuine recovery payments (past_due/unpaid) still
      // grant AND re-activate.
      if (sub.status === "canceled") {
        webhookLog.warn("invoice.paid for canceled subscription — no grant, no re-activation", { subscriptionId });
        break;
      }
      const plan = await rawDb.plan.findUnique({ where: { id: sub.planId } });
      if (!plan) break;
      // Stage 7.1 fix #5: upsert on the invoice id (unique index) — Stripe
      // retries deliveries, and the same invoice can arrive under more than
      // one event id; the unique constraint makes a double grant impossible
      // at the DATABASE level, not just by handler discipline.
      // Grants are written in the CANONICAL unit: the plan's UI-credit
      // allowance × MICROS_PER_CREDIT (fix #2 — never mix units in a sum).
      const start = periodStart > 0 ? new Date(periodStart * 1000) : new Date();
      const end =
        periodEnd > 0
          ? new Date(periodEnd * 1000)
          : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await rawDb.creditGrant.upsert({
        where: { stripeInvoiceId: invoiceId || "__no_invoice_id__" },
        create: {
          userId: sub.userId,
          subscriptionId: sub.id,
          grantedMicroCredits: creditsToMicro(plan.monthlyCredits),
          stripeInvoiceId: invoiceId || null,
          periodStart: start,
          periodEnd: end,
        },
        update: {}, // already granted — a repeated invoice is a no-op
      });
      // A paid invoice also (re)activates the subscription: renewals clear
      // past_due, and the period end tracks Stripe's billing period.
      await rawDb.subscription.updateMany({
        where: { stripeSubscriptionId: subscriptionId, status: { not: "canceled" } },
        data: {
          status: "active",
          ...(periodEnd > 0 ? { currentPeriodEnd: new Date(periodEnd * 1000) } : {}),
        },
      });
      break;
    }
    default:
      // Unhandled event type — Stripe sends many; we silently ack.
      break;
  }
}

/** Verify a Stripe webhook signature using Web Crypto. Returns true when the
 *  HMAC matches AND the timestamp is within `toleranceSeconds` (default
 *  300s — Stripe's recommended replay window; a replayed old payload is
 *  rejected even with a valid HMAC).
 *
 *  Stage 7.1 fix #1 (fail-closed): the COMPARISON is constant-time (XOR
 *  fold — never early-exit on the first differing byte) and the timestamp
 *  must parse. The signature header format is `t=<timestamp>,v1=<hex>`.
 *  See https://stripe.com/docs/webhooks/signatures */
export async function verifyStripeSignature(
  payload: string,
  sig: string,
  secret: string,
  toleranceSeconds = 300
): Promise<boolean> {
  const parts = sig.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const v1 = parts.find(([k]) => k === "v1")?.[1];
  if (!t || !v1) return false;
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  // Replay window: a captured (valid) payload older than the tolerance is
  // rejected — Stripe signs the timestamp for exactly this purpose.
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const signedPayload = `${t}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  // Constant-time compare (the loop always runs to the end; lengths are
  // checked first, which leaks only the length — same as Stripe's SDK).
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) {
    diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  }
  return diff === 0;
}
