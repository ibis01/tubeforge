# S64 — the Whiteboard Engine, Phase 0 + P0: a native drawing engine that earns its keep

Opened 2026-11-09 UTC (owner-directed: the complete Whiteboard Animation
development plan). This stage executes the plan's own Next Actions:
audit the repository, freeze the architecture, implement the native SVG
drawing prototype, benchmark the first 60-second video. The plan's §13
is explicit — do not build editors before proving the drawing engine.

Why this stage is possible RIGHT NOW while S63 sleeps: the P0 prototype
is native by the plan's own cost doctrine (§8: "Never call a
video-generation API to animate a simple SVG drawing"). Zero gateway
dependency — exactly the property the account-wide 429 outage demands.

## 1. Phase 0 — repository audit (read-only, 2026-11-09)

Verified on the working tree (HEAD `46f140d`, CI 6/6 green):

- **The Director stays untouched.** `director.ts` / `director-plan.ts` /
  `production-profiles.ts` / `shots.ts` / `motion.ts` / `liveliness.ts`
  are the cinematic engine; the whiteboard engine imports NOTHING from
  them and changes nothing under them. Shared infrastructure only:
  types.ts conventions, the log module, the house ffmpeg/execFile
  discipline, storage scratch dirs, the music system, the job model's
  shape (Phase 1+).
- **Render pipeline shape.** `render.ts` composes per-scene FFmpeg
  segment graphs with mode branches (slides/stock/animated/kenburns).
  The `slides` branch is the closest analog — a designed PNG enters
  once and zoompan emits the shot. The whiteboard renderer follows the
  same law: produce the scene's visual track, then the house assembly
  (audio graph, finishing, QC) applies around it.
- **Job infrastructure.** The `Job` model is kind-based with claim
  cycles, crash-recovery payloads, cooperative cancel — a
  `whiteboard-render` kind joins in the product-integration phase (the
  plan's Phase 1+), not in P0. The P0 benchmark runs as a sandbox
  script with evidence artifacts, per the S62 discipline.
- **CI lanes.** check/coverage lanes install ffmpeg but NOT browsers;
  the e2e lane owns chromium. Consequence, adopted as law: the unit
  suite pins PURE contracts (path math, sanitization, storyboard,
  timing, hand/camera math) and the real-render evidence lands via the
  benchmark script in the sandbox — exactly how S62 split pure
  contracts from gateway evidence.
- **Rasterizer availability.** `rsvg-convert` / `inkscape` absent;
  Playwright 1.57 + chromium-1200 installed (the E2E toolchain).
  Decision: **chromium is the rasterizer** — full SVG 1.1 fidelity
  (stroke-dasharray, clip-path, text, filters), driven from TypeScript,
  deterministic settings (fixed fonts, no CSS animation — every frame's
  state is computed by OUR math, the browser only rasterizes).
- **Fonts.** No handwriting face in the sandbox (DejaVu + Noto only).
  P0 uses them for labels; the handwriting aesthetic arrives with a
  bundled OFL font in the asset phase (S65+), or hand-authored glyph
  paths for hero text.
- **Music.** The house music system is already FFmpeg-synthesized
  (`musicProfileForNiche` / `droneSource`) — the benchmark's music bed
  is the PRODUCTION music path, not a placeholder hack.

## 2. The frozen architecture (the plan's §3, adapted to house law)

Engine home: `src/lib/tubeforge/whiteboard/` — an independent engine
module sharing TubeForge infrastructure, importing nothing from
Director. P0 modules:

| Module | Responsibility | Purity |
|---|---|---|
| `svg.ts` | SVG sanitizer (security) + path-data parser (M/L/H/V/C/S/Q/T/A/Z, arcs flattened) + arc-length/point/tangent math | PURE, unit-pinned |
| `storyboard.ts` | `WhiteboardProject` / `WhiteboardScene` / `AnimationEvent` (draw_path · move_object · reveal_color · write_text) / `CameraEvent` — house-style types + hand-rolled validation (parsePlan precedent) | PURE, unit-pinned |
| `timing.ts` | narration-duration estimate (house 2.6 wps convention), draw scheduling (length-weighted, with pauses/holds), the frame plan (frame → element progress + hand state + camera state) | PURE, unit-pinned |
| `assets.ts` | the starter vector library with drawing-order metadata (the heart benchmark set + the drawing hand + generic shapes) | data, parse-pinned |
| `render.ts` | the chromium rasterizer (per-frame dash/opacity/clip + hand transform + camera transform → PNG/JPEG sequence) + FFmpeg assembly (encode, music bed, narration when present) | process, evidence via benchmark |

Camera is a first-class scene input (keyframed zoom/pan/focus with
eased interpolation) — the plan's §D "the video must not feel like
static slides". The drawing hand follows the TRUE path geometry: the
frame plan names the active path and the arc-length progress; the hand
anchor is the interpolated point, rotated to the local tangent.

Security (the plan's test category): the sanitizer strips `<script>`,
`<foreignObject>`, event-handler attributes (`on*`), `javascript:`/
`data:` URLs, and external references before any asset enters a page —
unit-pinned with attack fixtures.

## 3. P0 acceptance (the plan's §10 P0 + §13 prototype list)

Deliverable: a complete 60-second whiteboard video, 1920×1080, 24 fps,
from the benchmark script `scripts/s64-whiteboard-benchmark.mts`:

- a hand drawing complete illustrations (progressive stroke reveal),
- multiple illustrations in correct sequence (5 scenes: title, chambers,
  blood flow, the beat, close),
- smooth camera movement (per-scene keyframed zoom/pan),
- narration synchronized with the drawing (real VO when the gateway
  allows — the timing engine consumes actual WAV durations; estimated
  2.6 wps timing otherwise, stated in the manifest),
- background music (the house music system),
- a finished 1080p MP4 passing the existing QC lenses.

Evidence lands in `validation/s64/` (gitignored binaries; manifest +
report + sample frames committed), per the S62 evidence discipline.

What P0 deliberately does NOT include (later phases, per the plan):
product/DB integration, the timeline editor, asset search/tagging, the
AI-assisted + native storyboard planners, character libraries, export
formats beyond 16:9 1080p, entitlements. The engine proves the drawing
first; everything else builds around it.

## 4. Execution addendum (2026-11-09 UTC — the P0 landed)

The stage survived a sandbox recycle mid-flight: the working tree (all
five modules + the benchmark + this record + the TASKS rows) was lost
UNCOMMITTED when the sandbox recycled between messages. Everything was
restored from the session transcript and re-verified from zero (fresh
clone at `46f140d`, `npm ci`, full gate battery). The incident is a
receipt for the repo's own law: uncommitted stage work does not exist.

Execution found and fixed five defects the never-run P0 carried:

1. **The namespace seam** (render.ts): frame-plan keys are
   `assetId::pathId` but the page's element ids are
   `assetId--pathId` — the applier's bare `getElementById(key)`
   silently missed EVERY element (a blank-video bug). Fixed with
   page-registered id maps (`window.__wbDraw` / `window.__wbText`),
   pinned by unit contract and by the benchmark's pixel forensics.
2. **extractAsset's un-anchored `/d="…"/`** matched the tail of
   `id="…"` and extracted the id AS path data — caught by the new
   unit contracts; fixed with `\s`-anchored attribute regexes.
3. **The spark core was a `<circle>`** — never extracted, never
   scheduled: it would have popped in fully drawn. Rebuilt as a
   stroke-only arc path; the library now carries the
   every-drawable-is-an-id-carrying-`<path>`/`<text>` invariant,
   unit-pinned.
4. **The benchmark project placed `arrow-curve` twice** — the
   validator correctly refused (the renderer's group-id scheme is
   single-instance per asset per scene); a distinct `arrow-return`
   asset joins the library.
5. **The bed synth** wrapped the stereo graph in parens (breaking
   the `|` channel separator) and skipped the house
   lowpass+loudnorm finishing chain — now the house synthesizer's
   exact shape.

The QC journey — every failure measured, every fix receipted:

- **Render 1**: 16 frozen runs + one 6s static run + loudness
  −32.1 LUFS. Diagnosis: the capped draw schedule finished 3–6s
  early (static tails), and a ducked solo bed cannot carry program
  loudness.
- **Fix wave 1** — the fill law (durations scale so the draw span
  ends exactly at duration − the hold), the resting pen through
  lead-in/hold, the solo-bed full-gain law: 5 frozen runs (all at
  scene starts) and loudness PASS.
- **Fix wave 2** — the permanent Lissajous camera drift: still 5
  runs. Measurement: scene-start frames sit at mean |Δluma|
  0.3–0.6 against the ~1.0 freezedetect noise floor — a 99%-blank
  canvas cannot produce full-frame motion, ink or no ink.
- **Fix wave 3** — the paper-dots surface texture (canonical
  whiteboard craft that also gives the drift purchase on every
  pixel) + the ease-out pen entry + the settle-swelled drift (×3
  decaying over 4.5s): 1 run (the video open) → settle window
  stretched + darker dots → **0 runs. ALL LENSES PASS.**

Final evidence (`validation/s64/`; binaries gitignored, manifest +
project.json committed): **63.88s, 5 scenes, 1920×1080 24fps**,
render 171s on the sandbox, house music bed (curiosity-spark through
the production finishing chain). Narration timing is the honest
2.6-wps estimate — the gateway outage holds; the timing engine
consumes measured VO durations the moment real WAVs exist (S63's
re-measure sleeps on the same outage).
