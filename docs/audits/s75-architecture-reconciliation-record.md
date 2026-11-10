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

### 4.1 E10 — per-format benchmarks (EXECUTED 2026-11-10, all green)

**Acceptance table** (the measured artifacts live in
`validation/s75/e10/<fmt>/` — project.json, final.mp4, stills, SRT,
manifest.json; merged comparison in `e10-manifest.json`):

| format | canvas | render wall | peak RSS (sampled) | frames | frame integrity | A/V (tail law) | QC |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 16:9 | 1920×1080 | 172s | 444 MB | 1623 | pass | pass (Δ=350ms exactly) | 13/14 |
| 9:16 | 1080×1920 | 168s | 442 MB | 1623 | pass | pass (Δ=350ms exactly) | 13/14 |
| 1:1 | 1080×1080 | 97s | 285 MB | 1623 | pass | pass (Δ=350ms exactly) | 13/14 |

acceptance: `frameIntegrityAllPass: true · aVAllPass: true ·
qcAllPass: true`. Duration identical across formats (67.67s — the
narration-driven timing is format-independent, as the contract
requires). Each QC report's one non-pass row is `cut-alignment:
unmeasured` — the documented modality exemption below.

**The gateway-free proof (the strongest native-first receipt yet):**
the ENTIRE benchmark — three renders, three QC batteries, the
summaries — ran to completion while the Z.ai account was under a hard
429 throttle (the S74 window, still open as of 14:31 UTC). The
whiteboard production path provably touches zero generation-API calls.

**Four real engine defects found and fixed by the benchmark** (each
pinned by a unit test; 352/352 green):

1. **The narration never reached `final.mp4`** — the assembly's mix
   filter mapped ONLY the ducked bed; a narrated render measured
   −32.0 LUFS. The S64 comment even stated the intent ("ducks to 0.16
   UNDER the voice"). Fixed: voice+bed `amix` (normalize=0,
   duration=first). Invisible in every prior run because the gateway
   outage meant no VO ever existed.
2. **`-shortest` ate the estimator's 350ms scene tail** — every scene
   encoded 9 frames short (1623 budgeted, 1578 delivered; the
   pre-flight frame budget lied by construction). Fixed: the VO pads
   (`apad`) to the scene duration; the tail survives as the last
   stroke's hold. A/V now measures Δ=350ms exactly, per scene.
3. **The container chromium wall** — on the 4GB worker's 64MB
   `/dev/shm`, a bare chromium launch dies mid-render. The slides
   engine already carried `--no-sandbox --disable-dev-shm-usage`; the
   whiteboard engine now inherits the contract
   (`WB_CHROMIUM_LAUNCH_ARGS`, both launch sites) and the scene loop
   RECYCLES its chromium context per scene (peak RSS dropped from
   ~625MB single-page to 444/442/285MB).
4. **Assembly `-shortest` dropped the final frame** (1623 planned,
   1622 delivered) even with every stream bounded; removed — every
   stream is bounded by `-t` / `amix duration=first` already.

**Harness honesty (recorded, not hidden):** the run's first "OOM" was
actually the sandbox's per-call process-tree reaper killing nohup'd
renders at the Bash-call boundary — the benchmark launches through
`scripts/daemonize.py` (the documented double-fork). The compositor's
scene-detect lens cannot see hand-drawn seams on a shared white canvas
(4 expected cuts supplied, 0 detections, 0 unexpected) —
cut-alignment is "unmeasured" FOR THE WHITEBOARD MODALITY by
documented exemption; continuity is verified by the exact frame-sum
integrity check instead. The QC aspect lens needed the render's own
geometry passed (`expectedAspect`) — the battery already knew all
three shapes.

### 4.2 E12 — production integration ledger (updated with the E10 evidence)

Each row: closed with evidence, or explicitly deferred with its
dependency:

- **Chromium deployment for production workers — EVIDENCE STRENGTHENED
  THIS STAGE.** The container reality is now measured, not assumed: on
  the 4GB worker shape, chromium needs the container-safe launch args
  (`--no-sandbox --disable-dev-shm-usage` — the slides contract, now
  inherited by the whiteboard engine's BOTH launch sites) and per-scene
  context recycling (peak RSS 444/442/285MB across formats, sampled).
  Remaining open row: the DEPLOYMENT doc (`DEPLOYMENT.md` / design §3.3)
  should state the chromium worker contract in the deploy checklist —
  docs-only, next session.
- **Native rendering is $0 for every tier — EVIDENCED.** The entire
  E10 benchmark (three renders + QC batteries) ran to completion during
  a hard account-level 429 — the render path provably touches zero
  generation-API calls. Receipt: this record §4.1.
- **Tier entitlements for optional AI (planner/TTS)** — rides the
  existing metered `aiCall` floor; the entitlement surface is a product
  decision to record, not new plumbing. Deferred to the readiness
  report's decision list.
- **Export + QC integration — EVIDENCED.** The benchmark's renders pass
  the UNCHANGED 14-lens QC battery (13/14 + the documented
  cut-alignment modality exemption) — the whiteboard's `final.mp4` is
  indistinguishable from a compositor render to the ship gate.
- **Worker recovery/cancellation** — rides the queue's resumable job
  contract; verify the whiteboard JobKind inherits it (the S62/S63
  receipt pattern). Deferred: needs a live queue drill, next session.

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

**OPEN — reconciliations LANDED; E10 EXECUTED, all green; E12 ledger
updated.** All local work is unpushed (the compromised PAT blocks the
push cycle): `409808f` (reconciliation docs) + `f9fd0fd` (the E10
benchmark + the four engine fixes + six unit pins, 352/352).

Remaining for the close:
1. The readiness report (the stage's final deliverable) — states the
   Whiteboard Engine's production distance in receipts: E10 measured,
   E12's two deferred rows (deployment-doc wording, the queue drill)
   and the entitlement decision list.
2. The push + CI evidence by SHA, gated on the PAT rotation.
3. S74's close remains watcher-automated and independent.
