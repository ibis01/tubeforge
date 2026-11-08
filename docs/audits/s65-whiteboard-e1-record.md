# S65 — Whiteboard E1: the technical design + engine budget hardening

Opened + executed 2026-11-09 UTC (owner-directed "Go" on the standing
"continue till end" directive). The E0 audit (S64's close-out) named E1
as the next milestone: the technical design document that formalizes the
product-integration phase, plus the engine-side hardening the audit's §6
explicitly assigned to E1. This stage is that milestone.

## 1. The gateway probe at open (S63 remains parked)

Before anything else: one cheap llm probe through the app's OWN stack
(`scripts/gateway-quota-probe.mts` — budget → chat provider → zai-client
→ /etc/.z-ai-config → gateway, provider pinned to zai the same way the
validation lanes pin it) returned **429, "Too many requests, please try
again later"** — the SAME account-wide throttle shape S63's outage
window recorded (video AND llm). The S63 re-measure stays parked under
its record §5 resumption protocol; the probe script lands this stage as
the standing resumption instrument (one probe before any resumption
attempt — the record already established probing neither extends nor
clears the window, so the discipline is probe-once-then-decide).

One probe-side fix during bring-up, recorded honestly: the first version
passed an OpenAI-shaped `messages` array to `chatComplete`, whose zai
path reads `system`/`user` — the SDK died on `undefined.match` before
reaching the gateway. The corrected probe uses the house request shape.
The 429 verdict is from the FIXED probe, reached through three real
attempts (the budget layer's retry ladder).

## 2. The engine hardening (E0 audit §6 risks 2–4, closed in code)

The audit's §6 carried four known risks into E1. Two were
"cheap to add in E1" by its own words — the id charset and the resource
budgets. Both landed, with the render pre-flight as the third:

1. **The id-charset law.** The renderer namespaces DOM ids as
   `${assetId}--${pathId}` and frame-plan keys as `assetId::pathId`; an
   id carrying either separator corrupts the seam. `validWhiteboardId`
   (`[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}`, minus `--`/`::`) is now enforced
   at BOTH layers: `extractAsset` excludes violating path/text ids from
   the drawable index (surfaced in a new `rejected` list with reasons —
   never silent), and `validateWhiteboardProject` rejects explicit scene
   ids that violate it. Missing ids still default (`scene-N`), the P0
   tolerance is untouched for everything legal.
2. **The path-command budget.** `countPathCommands` (svg.ts) counts
   EXPANDED commands through the real grammar — implicit repeats count,
   because `parsePathData` groups a command letter with all its repeat
   numbers into one entry and the flattener pays per coordinate group.
   Bring-up caught the test's own first arithmetic: a fixture assuming
   letter-count semantics failed against the grouped-parser reality; the
   fix was the honest counter, not a loosened budget. Paths over 512
   expanded commands are excluded from the drawable index (a
   10,000-implicit-point polyline is a raster asset, not a drawing).
3. **The project budgets.** `WB_BUDGETS` (storyboard.ts): 24 scenes,
   64 placements/scene, 256 events/scene, 32 camera keys/scene, explicit
   scene duration ≤ 120 s, Σ explicit durations ≤ 900 s. Every wall fires
   as a named validation error before any scene parses twice.
4. **The render pre-flight.** `estimateProjectFrames` (timing.ts, PURE —
   CI-pinnable) computes every scene duration the render loop will use
   (explicit > VO-measured > narration estimate) and sums frames against
   `WB_RENDER_FRAME_BUDGET` (25,920 = 18 min at 24 fps).
   `renderWhiteboard` now probes VOs, runs the estimator, and REFUSES an
   over-budget project BEFORE chromium launches — then the render loop
   reuses the pre-computed durations, so the budget and the render can
   never disagree. The refactor removed the loop's own per-scene ffprobe
   (one less place for duration truth to fork); the encode step's VO mux
   path was re-wired to the scene id lookup.

The S64 benchmark re-ran end-to-end on the hardened tree as the
regression proof (see §4).

## 3. The E1 deliverable: WHITEBOARD_ENGINE_DESIGN.md

The design document, at the repo root beside its E0 sibling. Its
decisions, in one breath:

- **DB:** `Video.whiteboardProject` — one JSON doc column (the sixth of
  the house's doc-column family: scenes, shotList, verifyReport,
  commentsKit, qcReport), atomic editor saves, LWW + advisory `rev`,
  migration-free evolution through tolerant validation. `renderMode`
  gains `"whiteboard"` (a fifth compositor mode, requires story format).
- **JobKind:** `"whiteboard"`, the 21st kind — handler in the
  `runSlideJob` pattern, heavy-kind classification (per-org chromium+
  ffmpeg cap), default attempts (deterministic re-runs cost zero API),
  boot-recovery idempotence guard, scene-granularity cancellation,
  composite `#wb<sceneId>` entity ids for previews.
- **Worker topology:** the honest constraint — the container ships no
  browser and slides mode already owns the mount-a-chromium deployment
  contract; whiteboard shares it rather than inventing a second path.
- **API:** five routes under `/api/videos/[id]/whiteboard/` (GET/PUT the
  doc with validator errors verbatim, POST scaffold = the zero-AI native
  planner, POST render with full/preview modes, POST asset upload),
  progress riding the existing DTO — no new polling surface.
- **Editor:** a `whiteboard-studio.tsx` family in the video detail
  studio, playing back through `frameAt` + `APPLY_FRAME_FN` — the editor
  canvas and the MP4 share ONE motion implementation by construction.
  Phased A (view) / B (edit) / C (assets).
- **Upload hardening (E11 spec):** byte cap → sniff → sanitize → budget
  → rasterize-before-trust (same renderer, wall-clocked) → quota →
  provenance; fuzzed fixtures named.
- **CI lane:** whiteboard stays in the unit suite (49 contracts), NOT in
  MONEY_PATHS until E9's routes exist; `video-jobs.ts`'s existing include
  will carry the handler's coverage; real-render evidence remains the
  sandbox benchmark (the S62 split).
- **Entitlements preview (E12):** native render is $0 — the first $0
  creative mode, available to all tiers; AI planner/TTS metered as usual.

## 4. The benchmark regression proof

`s64-whiteboard-benchmark.mts` re-ran on the hardened tree — the same
project.json, the same 63.88s 5-scene 1080p24 benchmark, now through the
pre-flight path. Receipt (log preserved at the stage's working notes;
verdict verbatim):

```
render complete in 167 s
qc: playable:pass black-frames:pass frozen-frames:pass aspect:pass
    loudness:pass true-peak:pass loudness-range:pass dead-air:pass
    static-shots:pass flicker:pass stutter:pass
    cut-alignment:unmeasured tail-fade:pass
manifest written; total 63.88 s; 5 scenes
```

The manifest diff against the committed S64 evidence is EXACTLY what the
determinism law predicts: `renderedAt`/`checkedAt` timestamps and
`renderMs` (193.8s → 188.6s, wall-clock noise) — duration 63.88s, every
scene row, and every QC verdict byte-identical. The pre-flight refactor
(VO probes hoisted, durations computed once by the shared estimator,
loop reuses the estimator's array) changed zero rendered frames.
cut-alignment stays honestly `unmeasured` (no timeline doc — the S64
close recorded the same), so the manifest's aggregate `passed: false`
carries that one unmeasured lens, as it did on the original run. The
refreshed manifest (new timestamps, same content) is committed with this
stage.

## 5. Gates + landing

The standing law: full battery on the EXACT tree before any push, CI
polled by full SHA.

- tsc: 0 errors.
- eslint: 0 errors (warnings census unchanged — the diff added zero).
- unit: 302/302 (293 + 9 S65 contracts: charset ×4, budgets ×5).
- billing + queue: their standing suites green.
- build: exit 0.
- Commit shape: engine hardening + tests + probe script + design doc +
  TASKS.md + this record.

## 6. What E1 deliberately did NOT do

Product implementation — no DB migration, no JobKind registration, no
routes, no editor components. The plan's sequencing law ("do not begin
implementation until the audit and architecture have been reviewed")
binds this stage to the review artifact, and the §6 hardening is
engine-side validation tightening, not integration. The next engineering
action after owner review is E9 Phase A: the scaffold route + the editor
view loop + the `whiteboard` kind wired end to end.
