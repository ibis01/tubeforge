# S75 — Universal Architecture Reconciliation and Whiteboard Production Readiness

Opened 2026-11-10 UTC. This stage executes the externally directed
assignment: the product has outrun its primary documents — README.md,
ARCHITECTURE.md, and ROADMAP.md were last reconciled at S46/S47
(2026-11-06), while the worklog and stage records are current through
S74 (2026-11-10). Three days of engineering (S48→S74: the Director's
nineteen words, the policy fence, eight voices, the Whiteboard Engine
E0–E9, Creator Intelligence CI-1..CI-4, the LLM planner, the paired
motion re-measure, the credential-safe push gates) are invisible in the
three documents a newcomer reads first. Worse, the approved product
decisions that govern the next era live only in stage records and chat
receipts, not as architecture constraints. This stage closes both gaps,
then turns to the Whiteboard production readiness items (E10, E12).

## 0. The three product decisions — recorded as architecture constraints

These are the approved direction, elevated from stage records and
review receipts to binding constraints. Every subsequent design
decision is checked against them.

1. **Universal platform.** One shared stack of contracts — project,
   asset, timeline, audio, rendering, quality — that every engine
   consumes. TubeForge is NOT a collection of disconnected video
   generators. The Whiteboard loop already proves the pattern: one
   JobKind, one budget choke point, one QC battery, one ship gate, one
   renderer seam (`RENDER_MODES`) — a whole engine added without a
   parallel pipeline. Each future engine must consume the same
   contracts, not fork them.
2. **Quality-first engineering.** The stage law that took S62 from
   "assumed" to "measured": no stage closes on implementation and tests
   alone — real measurements, blind scores where subjectivity is
   involved, CI evidence by SHA, honest degradation when a provider
   fails. Corollary (the S75 sequencing decision): the shared quality
   systems — Visual Consistency, Video Critic and Repair, the Universal
   Timeline contract — are built BEFORE the next engine is started.
   Quality infrastructure precedes engine expansion.
3. **Native-first intelligence.** Deterministic, native intelligence
   first; metered AI calls only where they earn their cost, always with
   a native fallback and honest degradation. The patterns are already
   in the tree and are now law: the S67 keyword rule-table storyboard
   planner, the S73 LLM planner that degrades per-scene to it through
   `aiCallJson` at the single budget choke point, Creator Intelligence
   adopted as typed native services (proposes-never-auto-edits, every
   score labeled a heuristic) rather than an external skill
   architecture, and native rendering as the first $0 creative mode
   (whiteboard: no generation API charges for the pixels).

## 1. Reconciliation inventory (what was stale, what was actually true)

Verified 2026-11-10, this stage's opening survey:

| Document | Claimed state | Actual state | Delta |
| --- | --- | --- | --- |
| README.md | "studio stage S46 (2026-11-06)" | Zero mention of the Whiteboard Engine, Creator Intelligence, or any stage past S46 | Reconciled at S75 |
| ARCHITECTURE.md | "reconciled against the live source at S47" | Counts stale (31 models → 32, 19 migrations → 21, 98 lib modules → 117, 103 routes → 116); no Whiteboard/Creator-Intelligence/retention subsystems | Reconciled at S75 |
| ROADMAP.md | "Stages 1–7 closed … S-series (S1→S46)" header | Header stale, but the Post-Stage-7 2.0 tracks section was kept current through S74 (updated 2026-11-10, the S70 session) | Header reconciled at S75; sequencing decision appended |

The honest finding, recorded because it changes the fix: this was not a
uniform three-day drift. The worklog and the audit records were
maintained continuously (the evidence discipline held); the drift is
confined to the three front documents, and inside ROADMAP.md it is
confined to the header — the tail was actively maintained. The
reconciliation below therefore updates in place, in the repo's own
delta style, rather than rewriting history.

## 2. Reconciliations executed this stage

### 2.1 README.md

- Status line: S46 (2026-11-06) → S74 era (2026-11-10): production loop
  feature-complete, S-series hardening through S74, Whiteboard Engine
  E0–E9 landed, Creator Intelligence CI-1..CI-4 landed, the credential-
  safe push gates landed, S74 measurement gateway-gated OPEN.
- "What's inside" gains the Whiteboard Engine (the native $0 creative
  mode) and Creator Intelligence (hook scoring, packaging lint,
  transcript-based Shorts selection, retention ingestion).
- The evidence-discipline line and the doc table updated to the S-series
  index as it stands (S1→S74 + the S47 integrity ledger).

### 2.2 ARCHITECTURE.md

- Header: reconciled at S75 (2026-11-10), superseding the S47
  reconciliation (which remains the baseline for §2–§8).
- §1 counts refreshed from the live source: 32 models (was 31 — the one
  post-S47 addition is `WhiteboardAssetUpload`, S69's upload-palette
  table; S72's retentionReport is a doc column and Creator
  Intelligence's modules are pure functions, by design), 21 migrations,
  117 `src/lib/tubeforge` modules, 116 API route files.
- New §1.9: the S48→S74 subsystem delta — the Whiteboard Engine
  (JobKind 21, `RENDER_MODES`, the whiteboard lib + component surface),
  Creator Intelligence, retention ingestion, the motion-vigor laws and
  their measurement lanes, and the CI hardening (the boot-time
  dpkg-lock wait + retry pattern).

### 2.3 ROADMAP.md

- Header status: the feature-sprint pause ended with Stage 7; the
  S-series and the 2.0 tracks are the active era.
- The Post-Stage-7 section gains the S75 sequencing decision as a
  numbered order of operations (E10/E12 → shared systems → engines),
  so the "what next" a reader sees first matches the approved
  direction.

## 3. S74 verification (the assignment's item 3, executed first)

Verified 2026-11-10 this session, before any reconciliation writing:

- Repo: local = origin/main = `250da9d` at session open; tree clean.
- S74 measurement: **0/8 pairs** (`s74-paired-remeasure.mts --status`
  returns an empty manifest); the lane is healthy in the rebuilt
  sandbox (committed S62 manifest readable, scripts run).
- Gateway: probe 429 at 14:24 and 14:31 UTC — the account-level window
  persists through the security-fix landing (CI 6/6 on run 42831139570
  at `e0b8fa6`).
- Resumption: automated — the 3×/day watcher (job 521163, fires 18:30 /
  01:30 / 11:30 UTC, phase-aligned to the pool's rolling-24h aging per
  the S54 forensics; every probe costs a pool slot for 24h, so the
  window is never raced) hands off to the probe-first resume lane on
  the first green reply. S74 stays OPEN until real clips + blind
  scores land; the close commit is measurement-gated.
- Push posture: the queued local commit(s) ride the next push AFTER the
  compromised PAT is rotated (`TF_TOKEN=<new> bash scripts/tf-push.sh`).

## 4. Whiteboard production readiness — E10 and E12 (the P1 work)

### 4.1 E10 — per-format benchmarks (gateway-free: native rendering)

The engine already takes width/height/fps from the doc, so the three
format benchmarks exercise the SAME engine at three canvases:

- **16:9** 1920×1080, **9:16** 1080×1920, **1:1** 1080×1080 — same
  storyboard, same native scaffold (zero AI spend), same fps.
- Metrics, measured per format from the rendered MP4s (ffprobe) and the
  render process: frame integrity (frame count == duration × fps, no
  dropped/garbled frames via the existing QC lenses), duration accuracy
  (measured vs planned ± tolerance), A/V sync (narration onset vs the
  synced scene start, from the mix), render wall time, peak memory, and
  per-format quality-lens pass rates.
- Narration: the E6 path (the video's existing `scene-XX.wav` mapping
  into `voFiles`) — the benchmark uses native/stock TTS or silent-room
  WAVs if no voice is configured; the renderer contract is the same.
- Everything lands in `validation/s75/` (gitignored by size) with a
  committed evidence record — the S74 discipline, adapted: a benchmark
  claim without a measured artifact does not close E10.
- Acceptance gate: all three formats pass every QC lens, duration
  within tolerance, A/V offset within the E6 tolerance, and the record
  carries the ffprobe + process receipts.

### 4.2 E12 — production integration ledger (what's verifiable now)

Recorded as a gap ledger, each row either closed with evidence this
stage or explicitly deferred with its dependency:

- Chromium deployment for production workers = the slides deployment
  contract (§3.3 of the design doc) — verify the contract text matches
  the actual worker deployment story; no code expected.
- Native rendering is $0 for every tier (no generation API in the
  whiteboard render path) — verify by tracing the render path's
  budget-touching calls: the scaffold planner (native) and the
  renderer (local Chromium + ffmpeg) must touch ZERO provider spend.
- Tier entitlements for optional AI (planner/TTS) — rides the existing
  metered `aiCall` floor; the entitlement surface is a product decision
  recorded, not new plumbing.
- Export + QC integration — already wired (the whiteboard renders to
  the standard `final.mp4` through the unchanged QC/ship gate; S67).
- Worker recovery/cancellation — rides the queue's resumable job
  contract; verify the whiteboard JobKind inherits it (the S62/S63
  receipt pattern).

**The readiness rule (restated from the external review, adopted):**
the Whiteboard Engine is NOT declared production-ready until E10's
three-format benchmarks are measured artifacts and E12's ledger is
closed or explicitly deferred with dependencies.

## 5. Sequencing (the approved order of operations)

1. **S75 (this stage)** — reconcile the front documents; record the
   three constraints; execute E10; close or ledger E12.
2. **S74** — close on real measurement when the gateway clears
   (watcher-automated; independent of S75's work).
3. **Shared quality systems** — Visual Consistency → Video Critic and
   Repair → the Universal Timeline contract (the Whiteboard loop's
   proven contracts are the starting seam).
4. **Engine expansion** — motion graphics, character animation,
   documentary/explainer, cinematic AI, presentation, 3D — each
   consuming the shared contracts, none a parallel pipeline.

No new engine starts before items 2–3 are closed. This is the recorded
anti-goal: not a collection of disconnected video generators.

## 6. Stage status

**OPEN — reconciliations landed locally (unpushed: the compromised PAT
blocks the push cycle).** E10 protocol defined; execution next. E12
ledger recorded. The stage closes when: the three front documents carry
the reconciled state, E10's benchmarks are measured artifacts with a
committed evidence record, E12's ledger is closed-or-deferred with
dependencies, and a readiness report states the Whiteboard Engine's
actual production distance in receipts.
