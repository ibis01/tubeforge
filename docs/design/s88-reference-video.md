# S88 — Reference-video intelligence (design + v1)

**Status:** v1 implemented — the analysis engine, the doc, the job, the
route, the Director integration, the pins, and the real-artifact smoke
(`scripts/s88-reference-smoke.mts`, green 2026-11-11). Spec source: the
S76 adoption decision §5 P1 (`docs/audits/s76-openmontage-adoption-decision.md`).

**The question it answers:** "Can TubeForge learn from a video the user
already knows works — legally?" The reference pipeline extracts
STRUCTURE (scene map, pacing, transcript, treatment, beat shape) and the
Director mirrors the ABSTRACT characteristics in an original concept.

## 0. The laws this module serves

1. **Structure, never expression** (the adoption decision's copyright
   law): structural patterns, never copyrighted footage, scripts or
   distinctive expression. The transcript stays server-side as analysis
   input; `referenceBlockForPrompt` — the only path from the analysis to
   a generation prompt — is PINNED to never emit the transcript text
   (the marker-word pin). What the Director sees: pacing numbers, beat
   roles with windows, treatment adjectives, narration density.
2. **Ingestion rights (v1): upload only.** By uploading, the user
   attests they hold the rights to learn from the file. A URL fetcher is
   deliberately DEFERRED (recorded): platform terms (downloading a
   platform's copy is a ToS question this build does not answer) plus
   the SSRF surface a fetcher opens. The analysis runs only on files
   already in OUR storage.
3. **The house doc laws**: versioned (version 1; a build that meets an
   unknown version reads the doc as absent and never overwrites it),
   tolerant parse (null on unreadable, junk fields fall back honestly),
   strict write (exactly the declared fields, version first).
4. **Fail open, never invent**: the ASR, the VLM treatment and the LLM
   structure passes EACH fail open — the doc lands with nulls and the
   deterministic beats when they cannot. Only honestly-broken input
   (unreadable stream, over the 20-minute wall) fails the job with a
   readable error.

## 1. The analysis pipeline (one job, $-bounded)

`analyzeReferenceVideo(videoId, filePath)`:

| Pass | Tool | Fail mode |
| --- | --- | --- |
| Probe | ffprobe | throws (readable) on no video stream / >20 min |
| Scene boundaries | the QC battery's own detector (`select=gt(scene,0.30),showinfo` → `parseSceneCuts`), threshold 0.30 — the MORE sensitive side of the QC lens's 0.40 | deterministic |
| Scene map + keyframes | one mid-window JPEG per window (512 long edge, ≤8 windows sampled) → `videoId/reference/keyframe-N.jpg` | per-window best-effort (null key) |
| Transcript + density | the existing ASR seam (`transcribe`, chunked) over a 16k mono WAV | null (fail-open) |
| Visual treatment | ONE `llmVision` call over ≤6 keyframes — STRICT JSON `{camera, color, onScreenText, summary}` | null (fail-open) |
| Hook + narrative structure | ONE `llmChat` call over the ABSTRACT inputs (windows, pacing, per-window word counts, the transcript as analysis input) — STRICT JSON `{hookPattern, beats}` | the deterministic thirds (`source: "deterministic"`) |
| Pacing stats | `pacingStats(cuts, duration)` — pure | deterministic |

**The pacing profile law** (documented thresholds): <6 cuts/min slow ·
6–12 measured · 12–24 fast · ≥24 very fast. Cuts are de-duplicated
within 0.3 s (flash-frame double-fires) and clamped to the span.

**The detector calibration receipt** (recorded 2026-11-11): chroma-only
solid-color cuts score as low as 0.15 on the scene metric (the smoke's
red→blue pair) — pathological inputs real footage never produces; real
textured cuts score 0.3+. The threshold stays 0.30: soft dissolves in a
reference are transitions, not cuts, and the profile measures CUT
density. The smoke's fixture uses textured sources for exactly this
reason (receipt below).

## 2. The surface

- **`Video.referenceAnalysis`** (the ninth JSON doc column; migration
  `20261111000000_s88_reference_analysis`). Null = no reference analyzed.
- **`POST /api/videos/[id]/reference`** — multipart upload (mp4/mov/
  webm/mkv/m4v, ≤200 MB); stores `${videoId}/reference/source.<ext>`,
  clears the namespace + the standing analysis, enqueues the
  `reference` job. One reference per video — a re-upload replaces.
- **`GET`** — the standing analysis (404 until one lands) +
  `?keyframe=N` streaming window N's keyframe (auth-gated).
- **`DELETE`** — the escape hatch: the namespace + the column clear.
- **The `reference` job kind** — handler-registered (crash-resumable;
  the resumableKinds ledger test pins it), artifact-landed on
  `referenceAnalysis`.
- **The Director integration**: `runDirectorPass` reads the analysis and
  feeds `referenceBlockForPrompt`'s block into the user prompt (an
  advisory section between the profile hints and the world library). No
  analysis → empty block → the prompt is byte-identical to the pre-S88
  shape (the regression tests pin it). The block's own first line names
  the law: "mirror the PATTERNS, never the words or footage".

## 3. Pinned-by-tests contract (unit)

`pacingStats` (deterministic: counts, mean/median, the profile bands,
the junk laws — NaN/edge/double-fired cuts dropped) ·
`sceneWindowsFromCuts` (contiguous windows tiling the span; no cuts →
one window; no span → none; edge-clamped cuts) · `deterministicBeats`
(the hook/body/close thirds) · the doc round-trip (byte-stable,
junk-tolerant, unknown version refused, absent transcript/treatment
stay null) · **THE copyright wall**: `referenceBlockForPrompt` with a
marker-word transcript emits ZERO transcript text while carrying the
pacing profile, beat roles, density and treatment adjectives · the
resumable-kinds ledger includes `reference`.

## 4. The real-artifact smoke (the S76 standard's artifacts half)

`scripts/s88-reference-smoke.mts` (green 2026-11-11): synthesizes a
12 s textured reference (testsrc2 → mandelbrot → smptebars, hard cuts,
a sine bed) and runs the REAL pipeline — every AI pass live. Receipt:
probe 12 s/640×360/24fps/audio ✓; 2 cuts detected → 10/min →
"measured" ✓; windows ≈ 4 s ✓; keyframes stored ✓; the treatment VLM
read the fixture accurately ("color bars, fractal bloom, checkerboard
gradients; flat graphic abstraction") ✓; the structure pass labeled the
beats (source "llm") tiling the span ✓; the doc round-trips ✓.

## 5. Recorded tails

- URL ingestion (permitted-platform fetch) — deferred with the rights
  rationale (§0 law 2).
- Word-level speech timing (the spec's "speech timing" at word
  granularity) — v1 carries scene-window density + overall wps; word
  timestamps land with the smart-captions ASR alignment when a consumer
  needs them.
- The Studio surface (the reference card in the create flow) — the API
  ships first; the UI card is a Premium-UX follow-up.
- Per-scene stock-query steering from the reference treatment — the
  spec names `stock-query.ts`; v1 stops at the Director block.
