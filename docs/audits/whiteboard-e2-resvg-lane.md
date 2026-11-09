# The Whiteboard E2 resvg lane — an independent full-engine prototype, submitted as E12 renderer-decision evidence

Status: **sandbox contribution** — not a session stage. This record documents
a second, independent implementation of the plan's E2 milestone ("working
prototype: SVG → progressive drawing → hand → deterministic frames → MP4")
built in the agent sandbox against the stage-7.1 snapshot, now integrated as
a **comparison lane** at `src/lib/tubeforge/whiteboard/e2/`. The P0 engine
(`svg.ts` / `timing.ts` / `assets.ts` / `render.ts` / `storyboard.ts`) is
untouched. Nothing in this lane is wired into the product; per the E1 law,
product integration awaits owner review.

## What this is

The E1 design (S65 §"deployment") deliberately shares slides' chromium
mount for whiteboard rendering and defers the renderer mechanism question
to E12: "the exact mechanism is E12's call". This branch exists to put a
measured **chromium-free alternative** on the table for that decision:

| Dimension | P0 lane (S64) | e2 lane (this branch) |
| --- | --- | --- |
| Rasterizer | headless chromium screenshots | `@resvg/resvg-js` (napi, DOM-free) |
| Browser dependency | required (inherits slides' mount) | **none** — whiteboard renders on any worker with ffmpeg |
| Frame pipeline | screenshot per frame | SVG string → PNG buffer per frame, streamed to disk one at a time |
| MP4 reproducibility | deterministic frames (plan-level) | **byte-identical MP4s** — `+bitexact`, `-bf 0`, `-map_metadata -1`, verified by double-render sha256 |
| Peak memory | browser-managed | one frame buffer (streaming encode; 1080p×1800-frame render never accumulates) |
| Path grammar | full SVG grammar incl. `S T A` + relative | strict subset: absolute `M L H V C Q Z` only (the validator REJECTS what it cannot compute — fail-loud, not silent-skip) |
| Schema discipline | hand-rolled, null-on-invalid (house `parsePlan` style) | zod, throw-on-invalid at engine boundaries, canonical serializer for deterministic hashing |
| Contracts | 40 whiteboard unit contracts (suite 302 total) | 74-test suite (`npm run test:whiteboard-e2`): unit / contract / security / integration / determinism / boundary-regression |

## The laws, checked

1. **Leaf module** — `e2/` imports only its own files + `../../proc` (shared
   infra). The suite's boundary-regression test walks `e2/` and fails on any
   `../render` / `../director` import.
2. **One source of motion truth** — `animator.ts evaluateFrame(project, tMs)`
   is the single pure function both the composer and (later) the editor
   playback would consume. Same law, different function home.
3. **Determinism** — frame N is a pure function of `(project, tMs)`; resvg
   loads no fonts (`loadSystemFonts: false`) and no clock; the encoder's
   bitexact flags pin the container. Double-render sha256 equality is a
   standing test, not a claim.
4. **Security as a pipeline property** — `svg-validator.ts` is a strict
   allowlist parser (element + attribute + value-level): rejects `<script>`,
   `foreignObject`, `on*`, external `href`/`xlink:href`, `url()` fills,
   DOCTYPE/entities; path-count and byte-size walls enforced pre-parse.
   The suite pins a 10k-path bomb, an oversized source, and 12 malicious-SVG
   rejections.
5. **$0 native rendering** — drawing, hand, camera, composition, encode touch
   no APIs. The 60s 1080p sample renders at $0.
6. **CI-lane split** — `test:whiteboard-e2` is deliberately NOT in `check`.
   It runs real ffmpeg + real resvg (integration + determinism layers), so
   it belongs to the sandbox-benchmark lane. CI keeps pinning pure
   contracts; the sample render is the evidence artifact.

## Benchmark evidence (sandbox, single run)

- Sample: 5 scenes × 12s, 1920×1080 @ 30fps, drawing-hand + camera moves.
- Output: `download/whiteboard-sample.mp4` — 1,999,969 bytes, 1,799 frames,
  59.97s, h264/yuv420p, ffprobe-verified.
- Wall clock: ~7 min end-to-end (rasterize + encode, single-threaded loop).
- Determinism: two consecutive `renderProject` runs → identical sha256
  (`7a4b960e…43294`).
- Suite: 74/74 PASS (`npm run test:whiteboard-e2`).

## What adoption would mean (for the E12 decision)

If the resvg lane is adopted for whiteboard: the whiteboard worker needs
**no chromium mount** — it becomes deployable on the base image (ffmpeg +
the ~3 MB napi binary) rather than inheriting the slides browser contract.
Chromium remains for slides. The two lanes can also coexist per-render-mode
during a transition. Counter-considerations to weigh in review: resvg is a
third-party native dependency (prebuilt binaries, MIT); the P0 lane's
chromium already ships in the slides image; and P0's SVG grammar is a
superset (full `S T A` + relative commands) — the e2 lane's strict subset
would need the same grammar coverage before it could replace P0's
sanitizer/geometry wholesale.

## Files

- `src/lib/tubeforge/whiteboard/e2/` — the engine (schemas, svg-validator,
  geometry, path-extractor, asset-registry, animator, composer, rasterizer,
  encoder, rendering/renderer, sample-project, 9 starter SVGs incl. the hand)
- `scripts/test-whiteboard-e2.mts` — the 74-test suite
- `scripts/render-sample-whiteboard-e2.mts` — renders the 60s sample
- `package.json` — `@resvg/resvg-js` + the two scripts (not in `check`)
