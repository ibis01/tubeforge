# S57 reliability record — observability: the structured logger's in-repo half

**Date**: 2026-11-08 (UTC) · **Stage**: S57 (owner-directed "Next")
**Status**: **CLOSED (2026-11-08)** — landed together with S58 as one
fast-forward (`9da54b4..34ec87a`); CI run 42480528396 on head `34ec87a`
green, all jobs (see "The CI evidence" below). The local-gate table further
down ran in the pre-landing sandbox on trees bit-identical to what was
pushed; the landing story — a fourth reclaim survived by the bundle — is in
"The landing constraint".

## The landing constraint (read this first)

The sandbox was reclaimed between sessions — the third time — and with it
the working `.env`, including the GitHub PAT. That PAT was due rotation
anyway (standing rule since S33; it transited chat twice). Consequence,
stated plainly: **every verification in this record ran in the recovered
sandbox, not on GitHub Actions.** No commit after `9da54b4` (the S56 close)
has a CI run. The push, the CI evidence, and the stage close all ride the
owner's rotated PAT. A git bundle ships with the delivery so a fourth
reclaim cannot lose the work.

What WAS verified about the remote state, before the stage opened: the repo
clones publicly at `9da54b4` clean; the live workflow badge reads
"CI — passing" on that commit (the REST API was IP-rate-limited to zero this
session — method disclosed; the badge reflects the default branch's latest
commit, which is exactly the closing commit).

**The resolution (2026-11-08, the landing session).** The rotated PAT
arrived — and between the sessions a FOURTH reclaim hit, the deepest yet:
`/home/z/my-project` came back at its initial 2-Nov snapshot, taking
`work/` (the repo tree) and the `download/` delivery with it. The
contingency held anyway: the platform's shutdown staging left the full
pre-reclaim project under `/tmp/my-project`, bundle included (byte-size
identical to the verified one). Recovery: fresh public clone at `9da54b4` →
`git fetch` the bundle → fast-forward to `34ec87a` (clean tree; the
bundle's objects cryptographically verified by the fetch) → push with the
rotated PAT through a one-shot credential helper. The PAT was never
written to any file, config, or commit and is not reproduced here; having
transited chat once it must be rotated again per the standing rule. No
local gate was re-run in the recovered sandbox (no node_modules) — nothing
needed it: the pushed trees are bit-identical (same SHAs) to the
locally-gated ones, and CI re-verified everything on GitHub.

## The CI evidence (the close)

The one push carried S57+S58 together (`9da54b4..34ec87a`), so the head
run is both stages' landing evidence — the S56 table's own convention for
multi-commit pushes (one run, at the head; every tree below is covered by
it cumulatively):

| Commit | Run | Outcome |
| --- | --- | --- |
| `e2e7c1e` (docs: S57 opened + stray T-56.7 row fixed) | — | tree covered by the head run |
| `75503b2` (feat: the structured logger's in-repo half) | — | tree covered by the head run |
| `14bfa20` (docs: S58 opened) | — | tree covered by the head run |
| `34ec87a` (feat: S58 — non-null class zeroed and frozen) | 42480528396 | ✅ **all jobs green** — Typecheck · Lint · Unit, Secret scan (gitleaks), Production build, Money-path coverage, E2E (Playwright) |

https://github.com/ibis01/tubeforge/actions/runs/42480528396 — queried by
full head SHA over the authenticated REST API (the API answered in the
landing session; the earlier IP-rate-limit was an anonymous-request
phenomenon). S57 closes on this evidence.

## The tranche (T-57.2) — what actually changed

The reconnaissance finding that set the scope: the S56 census's 381
no-console warnings were ~378 scripts/e2e CLI sites; the production debt was
INVISIBLE to the census — the rule's `allow: ["warn","error","info"]`
permitted **83 console.warn/error/info sites across 29 src/ files** to
bypass the structured logger entirely. The Stage-3 logger
(`src/lib/tubeforge/log.ts`, zero-dep pino-format JSON, redacting,
child-capable, with a `consoleBridge` nobody ever migrated onto) was the
destination; migration, not new machinery.

- **87 raw sites across 31 src/ files** migrated onto `log.child({ mod })`.
  The `[module]` string prefixes became bindings; interpolated values became
  structured fields. Largest: budget 10, story/jobs/billing 7 each, render 5,
  stock 4.
- **log.ts gained the portable sink** (`writeLine`): Node std streams when
  present; the SAME JSON line via the console in edge/browser bundles. One
  logging law everywhere — middleware keeps its no-node:* constraint.
- **Four owned exceptions** keep console with reasoned inline disables:
  log.ts (the fallback sink IS the logger), email.ts (console mode IS the
  delivery channel — the logger would redact the signed link the developer
  must copy), pwa.tsx (client bundle — the browser console is the client's
  sink; importing the logger would ship redact.ts to the browser), and
  instrumentation.ts's boot-failure line (last resort when even the logger
  module cannot import — see the en-route catch below).
- **scripts/ and e2e/ scoped out** (522 operator-facing console sites stay
  console by design — the CLI-harness carve-out, disclosed in the config
  comment). The structured-logger law governs the running app.

### En-route catches (the honest list)

1. **instrumentation's try-scoped logger**: the original
   `const { log } = await import(...)` lived INSIDE the try block; a naive
   migration of the outer catch's `console.error` would have crashed the
   exact path that reports boot failure. The catch now imports the logger
   defensively and falls back to the raw console with a reasoned disable.
2. **The empty-allow schema**: `no-console: ["error", { allow: [] }]` is
   rejected by the rule's schema (minItems 1). The strict form is a bare
   `"error"` — recorded in the config comment.
3. **Multi-line disable comments**: `eslint-disable-next-line` binds to the
   literal next line; prose wrapped onto following lines read as "unused
   directive" while the code still errored. The law: prose above, directive
   ALONE on the line before the code.
4. **The phantom typo**: reconnaissance "found" mangled `usic]`/`ttp]`
   prefixes in music.ts/http.ts — a tooling RENDERING artifact (the hexdump
   showed well-formed `[music]`/`[http]`; backtick+`[m` was eaten in the
   tool output). The migration script's count-check caught it before a
   "fix" for a defect that did not exist. Lesson re-confirmed: never edit
   against a pattern you have not byte-verified.
5. **The suite's own first failure**: the new requestLog test captured only
   stdout, but level-40 lines go to stderr — the warn lines were emitted
   and missed. Fixed by capturing both streams (the Stage-3 precedent).

## The request-id wiring (T-57.1)

middleware.ts stamps a **fresh** `x-request-id` (crypto.randomUUID — ours,
never the client's; inbound ids are untrusted input, always overwritten)
on every /api/* request, forwards it to the route handler, and echoes it on
**every** response through one `respond()` helper — 429/503/401/403
included. `requestLog(request, { mod })` binds it as `req`; children
inherit. Six route files adopted it. batch's `brainstormAngles` helper has
no request in scope and rides a plain module child (disclosed in the file).

**Live verification** (the recovered sandbox, real `next build` + the
standalone production server): `GET /api/auth/status` → 200 with
`x-request-id`; `GET /api/videos` unauthenticated → 401 with a DIFFERENT
fresh `x-request-id`; the boot log carries the structured JSON lines
(level-30 init on stdout; level-50 tick errors with serialized stacks on
stderr — the tick errors themselves are the known standalone
relative-DATABASE_URL artifact, the T-56.5 lesson, unrelated to this
change).

## The gates, at close of session

| Gate | Result |
|---|---|
| tsc --noEmit | 0 |
| eslint . | **0 errors / 221 warnings** (session start: 0/603) |
| no-console | **382 → 0**, promoted to bare error; census re-recorded |
| unit (test-unit.mts) | **247/247** (+2 S57) |
| billing (test-billing.mts) | 40/40 |
| queue (test-queue.mts) | PASS |
| next build (Turbopack) | exit 0, 57/57 pages, the SAME four documented warnings (no new ones) |
| standalone server, live | request-id flow proven (200 + 401, fresh per request) |

Census: `docs/baselines/s57-lint-census-2026-11-08.txt`. Remaining warning
programme (unchanged order): non-null-assertion 159, set-state-in-effect 33,
unused-expressions 11, exhaustive-deps 9, any 7, two singles.

## The spend-gate law — untouched, observable

- No `TUBEFORGE_SPEND_GATE=0` anywhere in S57.
- No forced `TUBEFORGE_PRICING_VERIFIED`; the pricing block stays
  provisional; `SpendPricingUnverifiedError` behavior unchanged.
- Zero gateway quota, zero paid dispatches — S57 touched no provider path
  (the one logger line inside spend.ts is the override-warning banner).

## What remains (and whose it is)

1. ~~**Owner: rotate the PAT** — then push, watch, record, close.~~ **Done
   (2026-11-08)**: rotated PAT provided, `9da54b4..34ec87a` landed, CI run
   42480528396 green, recorded above — S57 CLOSED. (The landing PAT
   transited chat once; rotate again before the next landing.)
2. **Owner-side, unchanged from S56**: Dependabot PR triage (8 open, human
   merge decisions; the typescript-7 major is a known CI-red).
3. **Next in-repo tranches**: non-null-assertion (159), react-hooks
   correctness (33+9), unused-expressions (11).
4. **P0-7's other half stays owner-action**: Sentry/GlitchTip account
   (vendor undecided) + external uptime monitor.
5. Standing human items from S55 (unchanged): the 70-floor recheck + tier-2
   imagery scoring on the kit's first gateway round; the first real-gateway
   render re-runs the T-55.5 protocol verbatim; the QC re-run's doc-less
   cut-alignment limitation stands as recorded.
