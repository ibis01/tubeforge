# S90 — Provider selection intelligence (design + v1)

**Status:** v1 implemented — the scoring engine (`provider-score.ts`, pure),
the pricing-law integration (`spend.ts` gains `modelPriced`), the API surface
(`GET/PUT /api/settings/ai/score`), the Settings comparison line, and 11
pins (unit 455/455, 2026-11-11). Spec source: the S76 adoption decision
§5 P3 + §6 acceptance row ("Cost, quality, reliability comparison — No
unpriced paid dispatch").

**The question it answers:** "Which provider should THIS task point at?"
Before S90 the answer was the registry's static notes; now it is a
configurable, production-calibrated weighted sum over five factors, fed by
the organization's OWN usage records, explained in one line where the
choice is made.

## 0. The laws this module serves

1. **ADVISORY ONLY.** The scorer explains provider choices; it never makes
   them. Dispatch keeps reading the user's capability config; the
   paid-dispatch safety rules in spend.ts (admitDispatch, the $5 stop line,
   SpendPricingUnverifiedError, credit holds) stand UNCHANGED — the module
   does not import them, cannot lift them, and adds no dispatch path.
2. **THE UNKNOWN-PRICING LAW** (the acceptance row's second half): a paid
   provider + unpriced model is priced at the conservative fallback
   (spend.ts's existing law), so its cost factor is LOW — unknown is never
   free. Outside chat there is no per-model pricing registry: a keyed
   external with no observed spend scores cost "unknown" at the cautious
   0.4 with the reason attached; "free" must be established BY DESIGN (the
   bundled Z.ai gateway, your own machine, documented no-key providers).
3. **Priors are starting beliefs, dominated by data.** Every prior number
   is a documented judgment derived from the registry's own provider notes
   (chat quality/latency/fit, cloning-fit for TTS, edit-fit for image), not
   a measurement. The org's UsageRecords (success rate, mean latency, mean
   cost — up to 90 days / 4000 rows) blend in with 5 calls of prior
   weight: five observed calls ≈ the prior's voice, a hundred drown it.
4. **The registry-sync law**: every provider in PROVIDERS_BY_CAPABILITY has
   a priors row — `priorsComplete()` pins it (the queue-ledger lesson: a
   second hard-coded ledger must be pinned in the same slice that grows
   the registry).
5. **Determinism**: score desc, then provider id asc — the same context
   always produces the same order (pinned input-order-independent).

## 1. The score

`scoreProviders(capability, { models, observations, weights })` → per
provider: `{score 0..100, factors, costBasis, estimatedCostMicroUsd,
evidence, reasons[]}`.

| Factor | Default weight | Source |
| --- | --- | --- |
| quality | 30 | the priors table (per capability × provider) |
| reliability | 25 | Bayesian blend: (ok + 5·0.90) / (calls + 5) |
| cost efficiency | 20 | chat: `priceForModel` on a NOMINAL call (3k in / 1.5k out — the advisory typical case, NOT the gate's conservative full-output estimate); non-chat: observed mean cost; free-by-design → 1.0; unknown → 0.4 |
| latency | 10 | observed mean (2s → 1.0, 30s → 0.0) blended with the prior |
| fit | 15 | the priors table — capability-specific extras (identity-locked edits, voice cloning, local control) |

The cost curve: `1 / (1 + microUsd/25000)` — $0 → 1.0, ~$0.025/call → 0.5,
the fallback price at nominal shape (~$0.105) → ~0.19.

## 2. The configuration

Defaults are production-calibrated (above). A user override persists as
the `ai.scoreWeights` UserSetting (JSON, per-user, no migration):
`PUT /api/settings/ai/score {weights}` → tolerant parse (numbers clamped
0..100; junk keys ignored; an all-zero table — a comparison killer — falls
back to the defaults; pinned). The weight sliders in the UI are the
recorded tail; the API + validation seam is live.

## 3. The surface

- **`GET /api/settings/ai/score`** — all four capabilities scored in one
  call: the org's UsageRecord aggregation (failures count toward
  reliability AND the cost average — a billed errored attempt is real
  spend), the user's current pick marked `configured`.
- **The Settings line** (settings-view): per capability, one line under
  the provider Select — the top pick vs your pick with score, quality,
  reliability and the cost reason. It never auto-switches anything.

## 4. The proof (11 pins)

The sync law (priorsComplete) · THE UNKNOWN-PRICING LAW (an unpriced paid
model prices ABOVE the cheapest known model; basis "priced"; reason states
"NEVER free") · free-by-design (zai / pollinations / selfhost) · non-chat
unknown-is-cautious (0.4, "never assumed free") · observed-beats-unknown
(the org's own spend becomes the cost truth) · reliabilityBlend (prior
when silent, data-dominated at 100 calls, prior floor at 5) · latencyBlend
(2s near-perfect, 30s near-floor, prior passthrough) · the exact weighted
sum (zai chat = 88 by hand) · weights flip the recommendation (cost-only →
the free tie, id-asc; quality-only → the quality leader) · parseScoreWeights
tolerance (null/junk/clamp/all-zero/partial) · determinism + configured.

## 5. Recorded tails

1. **Weight sliders in the UI** — the PUT seam is live; the panel is not.
2. **Credential-aware availability** — a provider the user holds a key for
   is "available", distinct from the active pick; needs a credential-list
   read per capability.
3. **Per-model priors** — quality currently prices the PROVIDER; per-model
   rows (a provider's flagship vs its mini) would sharpen both quality and
   cost for multi-model providers.
4. **Priors recalibration** — the table is versioned with the module;
   recalibration = editing the table + re-running the pins (the exact
   arithmetic pin documents the shape).
