// S27 unit probe — "the $5 door": the external review's verdict was that
// TubeForge's credit ledger is app-credit bookkeeping, not a USD meter —
// UsageRecord rows wrote inputTokens/outputTokens/costMicroUsd as zeros
// (with a literal "cost arrives with provider-level token reporting" IOU
// in the comment), the completion interface dropped provider usage, and
// nothing anywhere enforced the $5.00 paid-OpenAI experiment budget.
// S27 closes all of it. Layers proved here:
//   1. THE PRICING REGISTRY — versioned, sourced (official OpenAI page,
//      Nov 2026 + the June 2026 survey rows for the legacy generation),
//      snapshot/vendor-prefix matching, conservative fallback.
//   2. THE ESTIMATE LAW — worst-case ≥ actual by construction: chars/3
//      inputs, per-message overhead, a 4000-token image floor, and
//      MAX_OUTPUT_TOKENS priced in full (the dispatches are clamped to it).
//   3. THE SHAPE LAW — one normalizer for openai / anthropic / gemini /
//      zai usage shapes; garbage yields undefined, never a fake number.
//   4. THE GATE — paid dispatches reserve before they run; zai gateway and
//      local servers are ungated (metered, never blocked); crossing the
//      stop line throws SpendBlockedError; success settles at reported
//      usage, no-usage success and uncertain failures settle at the
//      estimate (never release).
//   5. THE CLAMP LAW — a paid chat dispatch carries max_tokens=8192 on the
//      wire (the output half of the ≥-actual invariant), proved against a
//      fetch fake on the registry-driven chat layer.
//   6. THE ROW LAW — the real recordAiUsage write path (withCtx + real
//      user/org) stores REAL tokens and priced cost on four shapes:
//      result-duck usage, sink-emitted usage (the string-return providers
//      layer), failed-without-usage (zeros), failed-with-usage (billed
//      anyway). Zai models stay metered-but-unpriced ($0 cost).
//   7. THE KNOBS — TUBEFORGE_SPEND_GATE=0 lifts the gate; a tiny
//      TUBEFORGE_SPEND_STOP_USD blocks immediately (subprocess, env-parsed).
// llm.ts's own openaiFetch is NOT fetch-fakeable (safeFetch pins DNS through
// undici's fetch) — its gate/usage wiring shares every helper proved here
// and ships under tsc; the route e2e exercises the live wrapper end-to-end.
// Run: node --import tsx scripts/s27-unit-probe.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import { saveCapability } from "../src/lib/tubeforge/providers/settings";
import { chatComplete } from "../src/lib/tubeforge/providers/chat";
import { aiCall, usageOf } from "../src/lib/tubeforge/budget";
import {
  PRICING_VERSION,
  priceForModel,
  computeCostMicroUsd,
  estimateDispatchMicroUsd,
  normalizeUsage,
  usageFromBody,
  isPaidProvider,
  admitDispatch,
  SpendBlockedError,
  emitUsage,
  drainUsage,
  MAX_OUTPUT_TOKENS,
} from "../src/lib/tubeforge/spend";

const prisma = new PrismaClient();
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// The gate's global state — the probe resets it between sections.
const spendState = (globalThis as typeof globalThis & {
  __tfSpend?: { booted: boolean; bootPromise: Promise<void> | null; recordedMicro: number; holds: Map<string, number> };
}).__tfSpend!;
function resetGate(recordedMicro = 0) {
  spendState.booted = true;
  spendState.bootPromise ??= Promise.resolve();
  spendState.recordedMicro = recordedMicro;
  spendState.holds.clear();
}
const recorded = () => spendState.recordedMicro;

// ---------- §1 the pricing registry ----------
console.log("\n§1 pricing registry");
{
  const sol = priceForModel("gpt-6.1-sol");
  check("exact row: gpt-6.1-sol $2/$10 per 1M", sol.in === 2_000_000 && sol.out === 10_000_000, sol);
  const legacy = priceForModel("gpt-4o");
  check("legacy row: gpt-4o $2.50/$10 per 1M", legacy.in === 2_500_000 && legacy.out === 10_000_000, legacy);
  const snap = priceForModel("gpt-6.1-sol-2026-10-15");
  check("dated snapshot resolves by longest prefix", snap.in === sol.in && snap.out === sol.out, snap);
  const vendor = priceForModel("openai/gpt-6.1-sol");
  check("vendor-qualified id resolves", vendor.in === sol.in && vendor.out === sol.out, vendor);
  const unknown = priceForModel("totally-unknown-model");
  check("unknown model → conservative fallback (gpt-6-astra)",
    unknown.in === 10_000_000 && unknown.out === 50_000_000, unknown);
  check("pricing version pinned", PRICING_VERSION === "2026-11", PRICING_VERSION);
  const cost = computeCostMicroUsd("gpt-6.1-sol", { inputTokens: 111, outputTokens: 222 });
  check("cost math: 111 in + 222 out on sol = 2442 µ$", cost === 2442, cost);
  const tiny = computeCostMicroUsd("gpt-4.1-nano", { inputTokens: 10, outputTokens: 10 });
  check("cost math: 10+10 on nano = 5 µ$ (per-side rounding)", tiny === 5, tiny);
}

// ---------- §2 the estimate law ----------
console.log("\n§2 estimate law");
{
  const est = estimateDispatchMicroUsd("gpt-6.1-sol", ["hello world"]);
  // output half: 8192 × $10/1M = 81_920 µ$; input half ~12 tokens ≈ 24 µ$
  check("estimate prices MAX_OUTPUT_TOKENS in full", est >= 81_000 && est <= 83_000, est);
  const floor = Math.round((MAX_OUTPUT_TOKENS * priceForModel("gpt-6.1-sol").out) / 1_000_000);
  check("estimate ≥ output floor for every model", est >= floor, { est, floor });
  const withB64 = estimateDispatchMicroUsd("gpt-6.1-sol", ["x".repeat(10) + "A".repeat(2000)]);
  // one image floor = 4000 tokens × $2/1M in-rate = 8000 µ$ on sol
  check("base64 runs count as one image, not chars",
    withB64 > est + 5_000 && withB64 < est + 20_000, { est, withB64 });
  const withImg = estimateDispatchMicroUsd("gpt-6.1-sol", ["hi"], 1);
  check("explicit image adds the 4000-token floor",
    withImg > est + 5_000 && withImg < est + 20_000, { est, withImg });
  const astra = estimateDispatchMicroUsd("gpt-6-astra", ["hi"]);
  check("astra estimate ≈ $0.41 (8192 × $50/1M)", astra >= 400_000 && astra <= 420_000, astra);
}

// ---------- §3 the shape law ----------
console.log("\n§3 usage shapes");
{
  const oai = usageFromBody({ usage: { prompt_tokens: 10, completion_tokens: 20 } });
  check("openai shape", oai?.inputTokens === 10 && oai?.outputTokens === 20, oai);
  const ant = usageFromBody({ usage: { input_tokens: 5, output_tokens: 6 } });
  check("anthropic shape", ant?.inputTokens === 5 && ant?.outputTokens === 6, ant);
  const gem = usageFromBody({ usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 } });
  check("gemini shape", gem?.inputTokens === 7 && gem?.outputTokens === 8, gem);
  check("garbage → undefined", usageFromBody({ usage: { prompt_tokens: "many" } }) === undefined);
  check("missing → undefined", usageFromBody({ choices: [] }) === undefined);
  check("normalized re-parse is stable", normalizeUsage({ inputTokens: 1, outputTokens: 2 })?.inputTokens === 1);
}

// ---------- §4 the gate ----------
console.log("\n§4 the gate");
{
  resetGate();
  check("zai gateway is ungated",
    (await admitDispatch({ provider: "zai", model: "glm-4.6", estimatedMicro: 4_400_000 })) === null);
  check("local servers are ungated",
    (await admitDispatch({ provider: "ollama", model: "llama3", estimatedMicro: 4_400_000 })) === null);
  check("openai is a paid provider", isPaidProvider("openai") && isPaidProvider("anthropic") && isPaidProvider("gemini"));

  resetGate();
  const hold = await admitDispatch({ provider: "openai", model: "gpt-6.1-sol", estimatedMicro: 81_944 });
  check("within stop → hold returned", hold !== null);
  const before = recorded();
  await hold!.settleFromSink(); // no emitted usage → conservative estimate settle
  check("no-usage success settles at the estimate", recorded() - before === 81_944, recorded() - before);

  resetGate();
  // emitUsage keys the sink by the TenantCtx object — exercise the settle
  // path inside a (synthetic) ctx exactly as a request would run.
  await withCtx({ userId: "probe-sink-ctx", organizationId: "probe-sink-ctx", role: "owner" }, async () => {
    const hold2 = await admitDispatch({ provider: "openai", model: "gpt-6.1-sol", estimatedMicro: 81_944 });
    emitUsage({ inputTokens: 100, outputTokens: 200 }); // what the transport saw
    const before2 = recorded();
    await hold2!.settleFromSink();
    check("reported usage settles at actual cost (2200 µ$)", recorded() - before2 === 2200, recorded() - before2);
    drainUsage(); // leave the synthetic sink empty for later sections
  });

  resetGate();
  const hold3 = await admitDispatch({ provider: "openai", model: "gpt-6.1-sol", estimatedMicro: 81_944 });
  const before3 = recorded();
  await hold3!.settleUncertain(); // the provider may have billed an accepted request
  check("uncertain failure settles at the estimate (never released)", recorded() - before3 === 81_944, recorded() - before3);

  resetGate(4_500_000);
  let blocked: unknown = null;
  try {
    await admitDispatch({ provider: "openai", model: "gpt-6.1-sol", estimatedMicro: 1 });
  } catch (err) {
    blocked = err;
  }
  check("crossing the stop line throws SpendBlockedError", blocked instanceof SpendBlockedError, String(blocked));
  const e = blocked as SpendBlockedError | null;
  check("the error carries the arithmetic", !!e && e.recordedMicro === 4_500_000 && e.stopMicro === 4_500_000, e?.message);

  // outstanding holds count toward the projection
  resetGate(4_400_000);
  const h = await admitDispatch({ provider: "openai", model: "gpt-6.1-sol", estimatedMicro: 50_000 }); // in flight
  let blocked2: unknown = null;
  try {
    await admitDispatch({ provider: "openai", model: "gpt-6.1-sol", estimatedMicro: 60_000 });
  } catch (err) {
    blocked2 = err;
  }
  check("outstanding reservations count (4.40 + 0.05 + 0.06 > 4.50)", blocked2 instanceof SpendBlockedError, String(blocked2));
  await h!.settleUncertain();
}

// ---------- §5 + §6 the live write path (real user/org, fetch fake) ----------
console.log("\n§5-§6 live rows through the real pipeline");
const SUFFIX = Date.now().toString(36);
const EMAIL = `s27-probe-${SUFFIX}@e2e.local`;
let userId = "";
let orgId = "";
try {
  const passwordHash = await hashPassword("probe-password-123");
  const user = await prisma.user.create({ data: { email: EMAIL, passwordHash, name: "s27 probe" } });
  userId = user.id;
  const org = await prisma.organization.create({
    data: { name: "s27 probe org", slug: `s27-probe-${SUFFIX}`, memberships: { create: { userId, role: "owner" } } },
  });
  orgId = org.id;

  await withCtx({ userId, organizationId: orgId, role: "owner" }, async () => {
    // Saved capability: openai / gpt-6.1-sol — the row writer resolves
    // provider+model from here, the gate prices it.
    await saveCapability("chat", {
      provider: "openai",
      model: "gpt-6.1-sol",
      baseUrl: "https://example.com/v1",
      apiKey: "sk-probe-not-real",
    });

    // §5 — the clamp law + gate + sink, against a fetch fake.
    resetGate();
    let captured = "";
    const realFetch = globalThis.fetch;
    (globalThis as { fetch: unknown }).fetch = async (_url: unknown, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "ok" } }],
          usage: { prompt_tokens: 100, completion_tokens: 200 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
    try {
      const content = await chatComplete({ system: "You are a connection tester.", user: "Reply with exactly: ok" });
      check("chatComplete returns provider content through the fake", content === "ok", content);
      const body = JSON.parse(captured);
      check("the wire carries max_tokens=8192 (the output clamp)", body.max_tokens === MAX_OUTPUT_TOKENS, body.max_tokens);
      check("the wire carries the model id", body.model === "gpt-6.1-sol", body.model);
      check("gate settled at reported usage (2200 µ$)", recorded() === 2200, recorded());
      const drained = drainUsage();
      check("sink still yields the usage for the UsageRecord row",
        drained?.inputTokens === 100 && drained?.outputTokens === 200, drained);
    } finally {
      (globalThis as { fetch: unknown }).fetch = realFetch;
    }

    // failure path: the fake dispatch throws → uncertain settle at estimate
    resetGate();
    (globalThis as { fetch: unknown }).fetch = async () => {
      throw new Error("connect ECONNREFUSED (fake)");
    };
    try {
      await chatComplete({ system: "s", user: "u" });
      check("UNREACHABLE — the fake must throw", false);
    } catch {
      // the dispatch's own texts: system "s", user "u"
      const est = estimateDispatchMicroUsd("gpt-6.1-sol", ["s", "u"]);
      check("failed dispatch settled at its estimate", recorded() === est, { recorded: recorded(), est });
    } finally {
      const realFetch2 = globalThis.fetch;
      void realFetch2;
    }

    // §6 — the row law: four shapes through the REAL recordAiUsage.
    await prisma.usageRecord.deleteMany({ where: { userId } });

    const r1 = await aiCall("llm", "probe result-duck", async () => ({
      choices: [{ message: { content: "ok" } }],
      usage: { inputTokens: 111, outputTokens: 222 },
    }), { attempts: 1 });
    check("result-duck call returns content", (r1 as { choices: unknown }).choices !== undefined);

    const r2 = await aiCall("llm", "probe sink-emit", async () => {
      emitUsage({ inputTokens: 50, outputTokens: 60 }); // the string-return layer's shape
      return "plain content string";
    }, { attempts: 1 });
    check("sink-emit call returns the string", r2 === "plain content string");

    let failed = false;
    try {
      await aiCall("llm", "probe fail-quiet", async () => {
        throw new Error("upstream died (fake)");
      }, { attempts: 1 });
    } catch {
      failed = true;
    }
    check("failed call without usage still throws through", failed);

    let failed2 = false;
    try {
      await aiCall("llm", "probe fail-billed", async () => {
        emitUsage({ inputTokens: 10, outputTokens: 0 }); // a 200-with-usage attempt, then doom
        throw new Error("parse exploded (fake)");
      }, { attempts: 1 });
    } catch {
      failed2 = true;
    }
    check("failed call with usage still throws through", failed2);

    // Unmetered callers record fire-and-forget (void recordAiUsage) — give
    // the async writes a beat before asserting the rows.
    await new Promise((r) => setTimeout(r, 400));

    const rows = await prisma.usageRecord.findMany({ where: { userId }, orderBy: { createdAt: "asc" } });
    check("four rows recorded", rows.length === 4, rows.length);
    // Defaults keep the row checks FAIL-ing (not crashing) if rows are missing.
    const [row1, row2, row3, row4] = [
      rows[0] ?? ({} as (typeof rows)[number]),
      rows[1] ?? ({} as (typeof rows)[number]),
      rows[2] ?? ({} as (typeof rows)[number]),
      rows[3] ?? ({} as (typeof rows)[number]),
    ];
    check("row1: REAL tokens + priced cost (111/222 → 2442 µ$)",
      row1.inputTokens === 111 && row1.outputTokens === 222 && row1.costMicroUsd === 2442,
      { i: row1.inputTokens, o: row1.outputTokens, c: row1.costMicroUsd });
    check("row1: attributed to openai/gpt-6.1-sol chat",
      row1.provider === "openai" && row1.model === "gpt-6.1-sol" && row1.capability === "chat" && row1.ok,
      { p: row1.provider, m: row1.model, ok: row1.ok });
    check("row2: sink-emitted usage lands (50/60 → 700 µ$)",
      row2.inputTokens === 50 && row2.outputTokens === 60 && row2.costMicroUsd === 700,
      { i: row2.inputTokens, o: row2.outputTokens, c: row2.costMicroUsd });
    check("row3: failed without usage → zeros, ok=false",
      row3.ok === false && row3.inputTokens === 0 && row3.outputTokens === 0 && row3.costMicroUsd === 0,
      { ok: row3.ok, c: row3.costMicroUsd });
    check("row4: failed WITH usage → billed anyway (10/0 → 20 µ$)",
      row4.ok === false && row4.inputTokens === 10 && row4.outputTokens === 0 && row4.costMicroUsd === 20,
      { ok: row4.ok, c: row4.costMicroUsd });

    // the zai law: metered but never priced
    await saveCapability("chat", { provider: "zai", model: "glm-4.6" });
    await aiCall("llm", "probe zai metered", async () => {
      emitUsage({ inputTokens: 500, outputTokens: 1000 });
      return "zai content";
    }, { attempts: 1 });
    // unmetered callers record fire-and-forget — let the async row land
    await new Promise((r) => setTimeout(r, 400));
    const zaiRow = await prisma.usageRecord.findFirst({ where: { userId, provider: "zai" } });
    check("zai row: real tokens, $0 cost (metered, not priced)",
      !!zaiRow && zaiRow.inputTokens === 500 && zaiRow.outputTokens === 1000 && zaiRow.costMicroUsd === 0,
      { p: zaiRow?.provider, c: zaiRow?.costMicroUsd });
  });
} finally {
  // ---------- §8 teardown (end-state law) ----------
  await prisma.usageRecord.deleteMany({ where: { userId: userId || undefined } });
  await prisma.creditLedger.deleteMany({ where: { userId: userId || undefined } });
  if (orgId) await prisma.organization.delete({ where: { id: orgId } }).catch(() => {});
  if (userId) await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  const leftoverUsers = await prisma.user.count();
  const leftoverOrgs = await prisma.organization.count({ where: { memberships: { none: {} } } });
  check("teardown: 0 users / 0 orphan orgs", leftoverUsers === 0 && leftoverOrgs === 0, { leftoverUsers, leftoverOrgs });
  await prisma.$disconnect();
}

// ---------- §7 the knobs (subprocess — env is parsed at module init) ----------
console.log("\n§7 the knobs");
{
  const script = `
    const { admitDispatch } = await import("${process.cwd()}/src/lib/tubeforge/spend.ts");
    try {
      const hold = await admitDispatch({ provider: "openai", model: "gpt-6.1-sol", estimatedMicro: 81_944 });
      console.log(hold === null ? "UNGATED" : "ADMITTED");
    } catch (err) {
      console.log(err.name === "SpendBlockedError" ? "BLOCKED" : "ERROR:" + err.message);
    }
  `;
  const tmp = `/tmp/s27-knob-${SUFFIX}.mts`;
  writeFileSync(tmp, script);
  const run = (env: NodeJS.ProcessEnv) =>
    execFileSync("node", ["--import", "tsx", tmp], { env: { ...process.env, ...env } }).toString().trim();
  check("default: gate on, dispatch admitted", run({}).endsWith("ADMITTED"), run({}));
  check("TUBEFORGE_SPEND_GATE=0 lifts the gate", run({ TUBEFORGE_SPEND_GATE: "0" }).endsWith("UNGATED"), run({ TUBEFORGE_SPEND_GATE: "0" }));
  check("tiny TUBEFORGE_SPEND_STOP_USD blocks instantly",
    run({ TUBEFORGE_SPEND_STOP_USD: "0.000001" }).endsWith("BLOCKED"), run({ TUBEFORGE_SPEND_STOP_USD: "0.000001" }));
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
