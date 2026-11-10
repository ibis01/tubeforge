# S75 — the Whiteboard readiness report

**The stage's final deliverable** (the readiness rule, restated from the
external review and adopted in
`s75-architecture-reconciliation-record.md` §4.2): the Whiteboard Engine
is declared production-ready ONLY when E10's three-format benchmarks are
measured artifacts AND E12's ledger is closed — every row closed with
evidence or explicitly deferred with its dependency. This report is that
closure, receipt by receipt.

**Verdict: the Whiteboard Engine is PRODUCTION-READY ON THE MEASURED
EVIDENCE, with two explicitly-declared infrastructure dependencies and
one honesty caveat** — all three listed in §6. Nothing about the engine's
own code path is unmeasured; nothing is closed on unit tests alone.

---

## 1. E10 — the measured acceptance (2026-11-10, all green)

Three real renders of the same project, one per format, through the
production code path (`runWhiteboardJob` → `renderWhiteboard` → the
unchanged 14-lens QC battery):

| format | canvas | render wall | peak RSS | frames | frame integrity | A/V tail law | QC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16:9 | 1920×1080 | 172s | 444 MB | 1623 | pass | Δ=350ms exact | 13/14 |
| 9:16 | 1080×1920 | 168s | 442 MB | 1623 | pass | Δ=350ms exact | 13/14 |
| 1:1 | 1080×1080 | 97s | 285 MB | 1623 | pass | Δ=350ms exact | 13/14 |

- Duration identical across formats (67.67s — narration-driven timing is
  format-independent, as the contract requires).
- Each format's one non-pass QC row is `cut-alignment: unmeasured` — the
  documented modality exemption (the scene-detect lens cannot see
  hand-drawn seams on a shared white canvas; continuity is proven by the
  exact frame-sum integrity check instead).
- The benchmark found and fixed FOUR production defects, each unit-pinned
  (narration absent from the mix; `-shortest` eating the 350ms tail; the
  container chromium wall; assembly `-shortest` dropping the final
  frame). Full receipts: the reconciliation record §4.1.
- **The gateway-free proof:** the entire benchmark ran to completion
  during a hard account-level 429. The whiteboard production path
  provably touches zero generation-API calls — native-first, evidenced
  by outage.

## 2. E12 — the ledger, closed row by row

1. **Chromium deployment for production workers — CLOSED (docs + the
   Dockerfile edit), one declared infra dependency.** `DEPLOYMENT.md` §5
   now states the contract: the browser install line (5.1), the mandatory
   `--no-sandbox --disable-dev-shm-usage` args (5.2, measured why: the
   64 MB `/dev/shm` SIGKILL), per-scene context recycling as the memory
   contract with the 444/442/285 MB envelope (5.3), the tini/daemonize
   clarification (5.4), and the drill that verifies it (5.5). The
   Dockerfile lines have since **landed** (2026-11-10 18:37 UTC, commit
   f7bfe47; CI 6/6 on that SHA), statically
   verified against the §5.1 contract (placement, pinned playwright,
   per-distro apt closure, chown for the non-root worker) — see §5.1's
   status block. The **real `docker build` + render smoke on the built
   image remains the one open infra gate**: the dev sandbox has no
   Docker daemon, so it must run on a Docker-capable runner.
2. **Native rendering is $0 for every tier — EVIDENCED** (§1's
   gateway-free proof). No entitlement check exists on the render path,
   and none may be added.
3. **Tier entitlements for optional AI — DECIDED** (the list in §4).
   Rides the existing metered `aiCall` floor; zero new plumbing, as the
   ledger required.
4. **Export + QC integration — EVIDENCED.** The whiteboard's final.mp4
   passes the UNCHANGED battery (13/14 + the documented exemption) —
   indistinguishable from a compositor render to the ship gate.
5. **Worker recovery/cancellation — DRILLED (the strongest receipt of
   the stage).** `scripts/s75-e12-queue-drill.mts`, executed live
   2026-11-10, PASS in 20s, 17 asserts:

   - **Act A — registry truth:** the live handler registry
     (`resumableKinds()`, 21 kinds) is the source of truth; the cancel
     route must derive from it.
   - **Act B — restart recovery → REAL render:** an orphaned whiteboard
     Job row ("running", claimed by a provably dead pid) is re-enqueued
     by a fresh worker's boot recovery, claimed
     (`claimedBy="worker:…"`), attempts counted 1→2, executed under the
     tenant context restored from the row — and the render actually
     LANDS: `video.hasVideo`, probed duration 5.4s, `final.mp4` on the
     storage driver, the "Whiteboard rendered" activity row. Never a
     silent no-op, never "No tenant context".
   - **Act C — cooperative cancel mid-render:** a long render enqueued
     through the route's exact `startJob` path passes its first
     frame-batch checkpoint, then `requestJobCancel(entityId,
     "whiteboard")` (the route's exact call) unwinds the engine; the Job
     row lands **"cancelled"** — never failed, never retried — the video
     row's error stays null, and the activity row records the design's
     promise verbatim: *"Whiteboard render cancelled — completed scenes
     kept, run it again to restart"*.

## 3. The two production defects the drill caught (fixed + pinned)

The drill was written because "the whiteboard kind inherits the queue
contract" was a claim, not a receipt. Running it caught:

1. **The per-job Stop button could not stop a whiteboard render.**
   `/api/jobs/cancel`'s hand-maintained `KINDS` literal was missing
   "whiteboard" and six other registered kinds (research, stock,
   director, continuity, slide, qc) — a Stop press 400'd with "Unknown
   job kind". An UNCANCELLABLE render. Fixed: the route derives `KINDS`
   from `resumableKinds()` — the exact lesson the registry's own history
   note records. Pinned by a unit test AND by drill Act A.
2. **Every locally-stored whiteboard render recorded duration 0.0s.**
   `runWhiteboardJob` probed `result.file` AFTER `putFromPath` — whose
   local-driver same-dir fast path RENAMES the source into the storage
   key (the S68 receipt's exact trap). The probe stats a moved-away
   file, ENOENT degrades through `?? 0`, and the row lies. (Production's
   S3 driver keeps the scratch copy, which is why it never surfaced
   there.) Fixed: the probe runs before the put. Pinned by a unit test
   AND by drill Act B's `videoDuration ≥ 3s` assert.

Unit suite after the fixes: **354 passed, 0 failed** (352 + 2 pins);
typecheck and lint clean.

## 4. The tier-entitlement decision list (recorded, zero new plumbing)

Ground: the three approved product constraints (universal platform,
quality-first, native-first); the metering reality — every upstream AI
call (GLM chat, TTS, CogView image, CogVideoX i2v) already flows through
`aiCall()` with fail-closed credit reservation; the plan catalog
(`billing.ts`): starter 1,000 / creator 10,000 / studio 50,000
UI-credits per month, one canonical microcredit unit
(1 credit = 1,000 microcredits = $0.001 placeholder).

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | **Native rendering (whiteboard / slides / compositor) is $0 and UNGATED on every tier — now and permanently.** | Evidenced $0 (§1); quality-first: rendering is the product, not a feature; gating it would gate the platform itself. |
| D2 | **The optional AI storyboard planner (S73) is available on every tier, metered per call through `aiCall`, OFF by default.** The native planner is the default on every tier. | Native-first: AI is an upgrade, never a dependency; the credit floor IS the entitlement gate — no per-feature plumbing (the ledger's law). A starter's 1,000 credits cap real usage without special-case code. |
| D3 | **TTS narration is available on every tier, metered through `aiCall`.** The self-hosted shared voice server (`TUBEFORGE_SHARED_VOICE_URL`) is a DEPLOYMENT choice ($0 marginal), not a tier feature. | Same single-surface law. Degradation is graceful by S73's law: an exhausted balance degrades to the documented fallback, labeled — never a hard block mid-pipeline. |
| D4 | **Whiteboard asset art generation (artPrompt → image provider) is available on every tier, metered through `aiCall`.** | The whiteboard's native path is the built-in SVG library; art generation is the optional richness layer — metered, credit-capped, degrade-to-library. |
| D5 | **The QC battery, frame-integrity law, resumable queue and cancellation are NEVER tier-gated.** | Quality-first: the ship gate is identical for every tier; gating QC would make the platform's promise tier-conditional. |

Tier differentiation remains exactly what `PlanInfo` already encodes:
credits (1k/10k/50k), max resolution (1080p/1440p/2160p), priority
rendering, team seats. **No new entitlement surface is created;** these
decisions record how the EXISTING surfaces bound the optional AI features.

## 5. What was NOT validated (the honesty caveat)

The E10 benchmark drove narration with **synthetic narration-slot
audio** (silence-shaped WAVs in the VO slot) because the Z.ai gateway —
the TTS provider — was under the hard 429 throughout. The mixing, timing
and tail-law evidence is therefore real; the VOICE itself (real TTS
output through the real provider) is not yet exercised end-to-end by the
whiteboard lane. This is a gateway-recovery item, the same window S74
waits on; it does not gate the engine's code-readiness (the VO slot is
provider-agnostic by contract) but it IS listed in §6.

## 6. Remaining before the ENGINE is called ship-grade

1. **The real-image render smoke** — the Dockerfile browser install has
   landed (§2 row 1, statically verified); what remains is a `docker
   build` of the image and an in-container whiteboard render smoke on a
   Docker-capable runner (dependency, not engineering work — this
   sandbox has no Docker daemon).
2. **Real TTS through the whiteboard VO slot** — one narrated render +
   QC battery once the gateway clears; rides the S74 window, watcher-
   automated, independent of all engine code.
3. **S74's own close** — 0/8 paired measurements; watcher-automated
   (next slot 18:30 UTC 2026-11-10); closes on real renders + 16 blind
   scores, never on code.

With those three, the Whiteboard Engine's production story is complete —
and the sequencing law holds: shared quality systems (Visual Consistency
→ Video Critic and Repair → the Universal Timeline contract) come next,
before any new engine.
