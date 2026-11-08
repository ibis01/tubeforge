# S58 reliability record — correctness hardening: the non-null-assertion class

**Date**: 2026-11-08 (UTC) · **Stage**: S58 (owner-directed "Next")
**Status**: **CLOSED (2026-11-08)** — landed with S57 as one fast-forward
(`9da54b4..34ec87a`); CI run 42480528396 on head `34ec87a` green, all
jobs. The local gates below ran in the pre-landing sandbox on trees
bit-identical to what was pushed; the landing story — a fourth reclaim,
survived by the bundle exactly as this record's last paragraph promised —
is in "The landing constraint".

## The landing constraint (read this first)

The reclaim ate `.env` with the GitHub PAT (due rotation anyway — standing
rule since S33; it transited chat twice). Every verification in this record
ran in the recovered sandbox. No commit after `9da54b4` (the S56 close, the
current remote `main`, confirmed by PAT-less `git ls-remote`) has a CI run.
The push, the CI evidence, and the S57+S58 closes all ride the owner's
rotated PAT; the delivery bundle carries `e2e7c1e..HEAD` so a fourth
reclaim loses nothing.

**The resolution (2026-11-08, the landing session).** The rotated PAT
arrived — and between the sessions a FOURTH reclaim hit, the deepest yet:
`/home/z/my-project` came back at its initial 2-Nov snapshot, taking
`work/` (the repo tree) and the `download/` bundle with it. The paragraph
above held to the letter: the platform's shutdown staging left the full
pre-reclaim project under `/tmp/my-project`, bundle included, and the
recovery was exactly the delivery doc's recipe — fresh public clone at
`9da54b4` → `git fetch` the bundle → fast-forward to `34ec87a` (clean
tree, objects cryptographically verified) → push with the rotated PAT
via a one-shot credential helper (the token touched no file, config, or
commit; it transited chat once and must be rotated again per the standing
rule). No local gate was re-run in the recovered sandbox — the trees are
bit-identical to the locally-gated ones and CI re-verified everything.

## The CI evidence (the close)

One push, one head run — the S56 convention for multi-commit pushes (the
run at the head covers every tree below it cumulatively):

| Commit | Run | Outcome |
| --- | --- | --- |
| `e2e7c1e` (docs: S57 opened) | — | tree covered by the head run |
| `75503b2` (feat: S57 logger) | — | tree covered by the head run |
| `14bfa20` (docs: S58 opened) | — | tree covered by the head run |
| `34ec87a` (feat: S58 — this stage's head) | 42480528396 | ✅ **all jobs green** — Typecheck · Lint · Unit, Secret scan (gitleaks), Production build, Money-path coverage, E2E (Playwright) |

https://github.com/ibis01/tubeforge/actions/runs/42480528396. S58 closes
on this evidence.

## The tranche — what actually changed

The S57 census's **159 `!` non-null assertions**, split **43 src/ (22
files)** + **116 scripts/ (15 files)**. Every site replaced by one of five
honest moves — no carve-outs, no rule exemptions:

1. **`providerMetaRequired`** (registry.ts) — the 12 provider-adapter
   lookups. A missing registry row is an adapter/registry sync bug; it now
   throws `provider registry has no <capability> provider "<id>"` instead
   of a TypeError at `.defaultBaseUrl`.
2. **`must()`** (`src/lib/tubeforge/must.ts`) — the named-invariant helper
   for the three provable map/find sites (analytics' keyset, motion's
   grouped-byInput, shorts' timeline). A broken invariant becomes a named
   error that says WHICH invariant broke.
3. **Restructures where total code is cleaner**: render's pip closure
   (narrowed ternary instead of `pip!` captured past the guard) and its
   shot-input loop (get-once, single pass, identical input order); assemble's
   permutation map (`flatMap` + `?? []` behind the validated permutation);
   export's stock credits (guard inside the loop the filter already proved);
   voice's extension sniff (match once, not test-then-match); zip's
   `ready.splice(0)` drain (the length-checked `shift()!` said the same
   thing the long way); m2-evidence's get-once (mirrors render.ts).
4. **Real guards on the money path**: checkout captures its price id (the
   503 the config gate above already promised), and **portal had a genuine
   latent bug** — `stripeGate().secret!` fed `undefined` into the Stripe
   Authorization header when the key was missing; it now returns the same
   operator-facing 503 checkout does.
5. **Narrowing the compiler can see**: the dialog's `currentVideo` const
   (closures below the `if (!video) return null` guard), the qc IIFE's
   captured `qc`, voice-view's `profile != null` aliased condition (not
   `Boolean()`), attention-panel's endpoint guard, settings-view's `?.`
   behind its existing guard, script-analysis's `?? []` merge and the
   verdict already narrowed by its early return.

The scripts/ half: the discovery that shaped it — **the harness's own
`ok()` is `asserts cond`, so most of the 68 test-suite `!`s were vestigial**
(an `ok(x !== null)` above already narrows; the author still wrote `x!`).
Those simply dropped. The rest gained per-file `req()` helpers in the house
style: a null fixture now fails as `missing: loudness measurement` instead
of a TypeError at the deref. The probes' `spendState` globals, token/row
bindings, s21's triple-`!` URL chain (now `??`-total), and s55's
scene-lookup (imports `must`) all carry their invariants by name now.

## En-route catches (the honest list)

1. **The T-56.6 freeze was silently neutered** — the config object declared
   `prefer-const` and `no-useless-escape` twice ("error" early, "warn" in
   the later "General JavaScript rules" section); JS object literals keep
   the LAST key, so both rules were back to warn-only and a new violation
   would NOT have failed CI. Found while freezing this stage's rule;
   deduped, both stay error, the catch documented in the config comment.
   (The counts were already zero, so no behavior changed today — but the
   fence around the class was down and is back up.)
2. **The recon's rendering artifact, again**: the site list showed
   `CAMERA_TO_MOVEove]` and `const a, hc]` — the S57-documented tooling
   artifact eating backtick+`[m` / `[h`. Byte-verified by Read before
   editing, as the lesson demands; the source was normal.
3. **The asserts-cond discovery** (above) — verified empirically with a
   scratch tsc run before relying on it, including the closure-capture case
   (`usage.id` inside `.every()` narrows fine for a const).
4. **s34's partial edit**: the spendState rewrite initially left the
   `).__tfSpend!` tail — the diff review caught it before any gate ran.

## The gates, at close of session

| Gate | Result |
|---|---|
| tsc --noEmit | 0 |
| eslint . | **0 errors / 62 warnings** (session start: 0/221) |
| no-non-null-assertion | **159 → 0**, promoted to error (frozen, no carve-outs) |
| unit (test-unit.mts) | **247/247** (68 migrated sites inside) |
| billing (test-billing.mts) | 40/40 (19 migrated sites inside) |
| queue (test-queue.mts) | PASS |
| the 11 migrated probes | **all PASS, 304 checks** (s3 13 · s7 23 · s16 34 · s20 27 · s21 16 · s22 31 · s23 33 · s24 33 · s27 50 · s32 28 · s34 16) |
| coverage (test:coverage) | **56.33% lines** (baseline 56.30; floor 50 holds) |
| next build (Turbopack) | exit 0, 57/57 pages, the SAME four documented warnings (no new ones) |

Census: `docs/baselines/s58-lint-census-2026-11-08.txt`. Remaining warning
programme (order unchanged): set-state-in-effect 33, unused-expressions 11,
exhaustive-deps 9, any 7, two singles — the react-hooks correctness tranche
is the natural S59.

## The spend-gate law — untouched, observable

- No `TUBEFORGE_SPEND_GATE=0` anywhere in S58.
- No forced `TUBEFORGE_PRICING_VERIFIED`; the pricing block stays
  provisional; `SpendPricingUnverifiedError` behavior unchanged.
- Zero gateway quota, zero paid dispatches — S58 touched no provider path
  (the 12 registry swaps are dispatch-table lookups, and the probes that
  exercise the spend gate run in local-only mode as designed).

## What remains (and whose it is)

1. ~~**Owner: rotate the PAT** — push, watch, record, close.~~ **Done
   (2026-11-08)**: landed `9da54b4..34ec87a`, run 42480528396 green, both
   stages' records carry it, both closed. (The landing PAT transited chat
   once — rotate again before the next landing.)
2. **Owner-side, unchanged**: Dependabot PR triage (8 open, human merge
   decisions; the typescript-7 major is a known CI-red).
3. **Next in-repo tranche (S59 candidate)**: react-hooks correctness
   (set-state-in-effect 33 + exhaustive-deps 9), then unused-expressions
   (11), then the any 7.
4. **P0-7's other half stays owner-action**: Sentry/GlitchTip account
   (vendor undecided) + external uptime monitor.
5. Standing human items from S55 (unchanged): the 70-floor recheck + tier-2
   imagery scoring on the kit's first gateway round; the first real-gateway
   render re-runs the T-55.5 protocol verbatim; the QC re-run's doc-less
   cut-alignment limitation stands as recorded.
