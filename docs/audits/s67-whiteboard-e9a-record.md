# S67 — Whiteboard Reconciliation + E9 Phase A — the execution record

Stage: **S67** · 2026-11-09 · one stage, two mandates: (1) the E-series
reconciliation the S66 merge commit deferred — pick the engine that carries
E3+, port only proven advantages, retire the loser; (2) **E9 Phase A** —
the FIRST product integration of the Whiteboard Engine, per
`WHITEBOARD_ENGINE_DESIGN.md` (the reviewed E1 design, §5 "Phase A is the
first product-integration commit").

Landed on the S66 head `445a1c6` linear. CI evidence: this file's §6.

---

## 1. The reconciliation decision — the canonical engine survives

`src/lib/tubeforge/whiteboard/` (the S64 P0 + S65 E1 engine) carries E3+.
`contrib/whiteboard-e2/` (the sandbox E2 prototype, archived in S66) is
**deleted** in this commit — its history remains reachable at `8d974d1`.

The capability-by-capability comparison the audit demanded:

| Capability | Canonical (S64/S65) | Prototype (E2) | Verdict |
|---|---|---|---|
| Path-following drawing hand | **Yes** — `handAt` rides the true path point every frame, entry ease-out, pen-lift masking, text-baseline riding; benchmark-proven (S64 receipts) | Yes — `buildHand` with tangent angle + travel between draws | Canonical. The audit's named "proven advantage" was already the canonical engine's own S64 deliverable. The prototype's inter-stroke TRAVEL (≤400ms linear) contradicts the S64 QC decision (hidden pen during gaps), so it was not ported. |
| Asset library | 10 inline assets (benchmark set + generics), sanitized at construction | 10 file-based assets (8 concept + hand), categories/tags, directory scan | **Ported (the shapes)** — 8 concept assets into `assets.ts`. The 2 infrastructure ideas (file-scan loader, registry class) did NOT port: the house law is sanitize-at-construction inline data (no `import.meta.url` fs reads in the module), and E11's upload path will extend the library through storage, not a second loader. |
| Validation | Hand-rolled `parsePlan` discipline + S65 budgets + id-charset law (defense in depth) | zod schemas + schemaVersion + `ReferentialIntegrityError` | Canonical. House convention (tolerant parse, null-on-invalid) beats zod; the design §2.1 cites it as the doc-column pattern's foundation. zod would add a second error vocabulary the design §4 explicitly forbids. |
| Timing model | Sequential scenes, per-scene windows, fill-law scheduling (length-weighted, QC-receipted) | Global timeline (scene startMs), per-event easing, manual durations | Canonical — the product model (§2.1) is the canonical one; the fill law is the S64 QC receipt holder. |
| Determinism | Pure `frameAt`, pre-flight frame budget | Pure `evaluateFrame` | Tie; canonical's budget wall (25,920 frames) is the extra the 4GB worker needs. |
| Event vocabulary | draw_path / write_text / reveal_color / move_object | draw / fade / move / color_reveal | Canonical set. The prototype's `fade` (asset opacity) is the one genuinely missing capability — **deferred, not ported** (Phase A scope law: port only what the audit named; fade is recorded as the first Phase B+ engine candidate). |
| Renderer | chromium per-frame screenshot + ffmpeg concat, dot-grid paper, camera drift, music bed ducking | sharp/ffmpeg pipe variant | Canonical — the S64 benchmark's 13 QC lenses ran against THIS renderer. |
| Product wiring | none (E1 design only) | none (prototype) | **Built this stage** (§3 below). |

Ported with two recorded adaptations (`assets.ts` header comment):
1. **Ink recolored** to the house palette — the prototype's near-black
   `#111827` read as a different pen beside the benchmark set.
2. **Every path split to a single subpath** — the prototype packed multi-M
   paths (`growth-axis`, `chart-axis`, `coin-dollar`, `bulb-screw`), but the
   S64 dash-reveal + hand-follow geometry is proven on single-subpath paths
   (a mid-path M teleports the hand). Each subpath became its own drawable,
   which the scheduler times separately — a behavior upgrade, not a loss.

Unit contracts pin all three: library 18 assets / zero extraction
rejections / exactly one M per path / command walls (the S67 suite).

## 2. What E9 Phase A built (design §2–§5 → code map)

- **DB (§2.1/§2.4):** `Video.whiteboardProject String?` — the sixth JSON doc
  column; additive chain migration `20261110000000_s67_whiteboard_doc`; the
  SQLite mirror regenerated via `db:sync-sqlite`. Concurrency: LWW (the
  house rule) + an advisory `rev` integer INSIDE the doc (planner's
  `parseWhiteboardDoc`/`serializeWhiteboardDoc`, tolerant-parse discipline).
- **renderMode (§2.2):** `"whiteboard"` joins `RENDER_MODES` (types.ts) as
  the fifth mode. Story-format law enforced at every entry: create routes
  (400 on the contradiction), PATCH video (409 + the convert-first hint),
  the whiteboard render route (409), and a defensive refusal inside
  `runRenderJob` so the compositor can never silently kenburns a
  whiteboard row.
- **JobKind (§3):** `"whiteboard"` — the 21st kind. Handler registered in
  `queue-handlers.ts` (`runWhiteboardJob`); `HEAVY_KINDS` gains it
  (chromium+ffmpeg class, per-org cap counts it); default attempts (2 — a
  re-run is deterministic local work at $0); boot recovery marks a full
  render whose `final.mp4` already landed as done (the idempotence wall —
  re-rendering an 18-minute job to no effect is the waste the budgets
  exist to prevent); `jobSnapshot` surfaces `whiteboard`; the artifactLanded
  chain knows the kind. Entity ids: `<videoId>` = full render,
  `<videoId>#wb<sceneId>` = scene preview (`splitEntityId` gained `#wb`,
  suffix validated by the engine's own id-charset law).
- **The job (§3.1):** `runWhiteboardJob` (video-jobs.ts) — full render at
  the project's own size/fps with per-scene narration WAVs (the existing
  `scene-XX.wav` layout maps mechanically to the scaffold's `scene-<n>`
  ids) and the resolved house music bed; artifacts at the STANDARD
  `${videoId}/final.mp4` (player, QC battery, ship gate work unchanged)
  plus `${videoId}/whiteboard/scene-<n>.mp4` per-scene encodes (§2.3).
  Scene previews: 720p/24fps, no bed, `whiteboard/preview-<sceneId>.mp4`,
  sets `hasPreview`. Cancellation at scene granularity via the onProgress
  checkpoint. $0 spend recorded (design §1 law 5). The QC battery rides
  the standing `final.mp4` through `runQcJob` (crashed battery ≠ failed
  render — the S45 law).
- **Routes (§4):** GET + PUT under `/api/videos/[id]/whiteboard`
  (validated-before-return doc, the editor palette — ids/viewBoxes/tags/
  drawable summaries, never raw SVG — and the §6 budgets for client-side
  enforcement; PUT validates with the engine validator's verbatim errors,
  409 on rev mismatch WITH the current doc, invalidates stale renders
  exactly like slide edits). POST `/scaffold` (the native planner, 409 on
  existing without `force`). POST `/render` (full vs preview enqueue,
  pre-click validation). The `/asset` upload route stays E11 (design §9:
  the §7 hardening executes after Phase C — a half-hardened upload would
  violate the design's own sequencing law).
- **Invalidation (§2.3):** `invalidateRenderedArtifacts`'s stale pattern
  now also sweeps `whiteboard/scene-<n>.mp4` + `whiteboard/preview-<id>.mp4`
  (the preview-id charset IS the engine's id law, so the pattern cannot
  miss a legal id).
- **Editor Phase A (§5):** `src/components/tubeforge/whiteboard/`
  — `whiteboard-studio.tsx` (scaffold / regenerate / render / scene tabs /
  scrub) + `wb-canvas.tsx`. THE SEAM, enforced by construction: the pure
  page-side trio (`composeScene` / `framePayload` / `APPLY_FRAME_FN`)
  moved from render.ts into `wb-page.ts` (a leaf, node-free module) so the
  renderer AND the canvas consume the same code — what the editor shows at
  t=12.4s is what the MP4 contains at t=12.4s. The canvas plays back in a
  same-origin srcdoc iframe, re-running the renderer's exact setup passes
  (defs root, hand asset, geometry-measured dasharrays, the plan-key→id
  maps). Embedded in the video detail dialog's Storyboard tab when
  `renderMode === "whiteboard"`.

## 3. The native scaffold planner (E5 phase 1, zero AI)

`whiteboard-planner.ts` — deterministic keyword→library-tag rule table
(first hit wins: money → coin, growth → arrow-growth, data → bar-chart,
idea → lightbulb, world → globe, time → clock, launch → rocket,
check/verify → check-badge), a position-indexed fallback cycle for cue-free
scenes, opener title-card + closer stat-card treatments, `1920x1080@24`
defaults, EMPTY event lists (the fill law schedules at render — the
schedule is an engine contract, never a second implementation), and the
scene-count wall enforced as a readable throw (no silent truncation).
Pinned: determinism (byte-identical repeats), validator-clean output,
rule-table hits, rotation stability, the wall.

## 4. Evidence

- **Sandbox end-to-end proof** (`scripts/s67-e9a-proof.mts`, runs the exact
  product pipeline minus the DB row): story beats → scaffold → engine gate
  → chromium+ffmpeg render of 4 scenes / 384 frames / 16s video in 17.6s
  wall → receipts (duration, per-scene sizes, a non-blank mid-render
  frame). The ported assets were drawn by the canonical hand through the
  scaffold's placements — the reconciliation and the integration proven
  together.
- **Unit contracts:** suite 302 → 312 (+10 S67: the port laws ×3, the
  scaffold ×5, the doc/plumbing ×2; the resumable-kinds exhaustive literal
  gained the 21st kind). Local `npm run test`: 312 passed, 1 environmental
  (the billing probe needs a postgres DATABASE_URL; this sandbox holds a
  sqlite file URL — CI's PostgreSQL + money-path lanes arbitrate).
- **Gates:** `tsc --noEmit` 0 · `eslint` 0 errors (20 standing warnings) ·
  `next build` exit 0 (the same four documented warnings).

## 5. Deferred, on purpose (each with its lane)

- **Event editing (Phase B)** — timeline lanes, placement drag, camera
  keys: the design's own phasing; Phase A is read-only over the doc ON
  PURPOSE so it cannot drift from the validator's contract.
- **Palette + uploads (Phase C → E11)** — §7's seven-gate hardening first.
- **The prototype's `fade` event + per-event draw easing + left/right
  hands** — recorded engine candidates for a Phase B+ stage; not named by
  the audit, not ported under the scope law.
- **VO-measured editor timing** — the canvas rides the narration estimate
  (labeled as such); measured-WAV timing re-derives at render (the timing
  engine owns durations — design law 2).
- **9:16 / 1:1 whiteboard benchmarks** — E10; the engine already takes
  width/height/fps from the doc.

## 6. Exit gate

S67 closes on CI green over the E9 Phase A tree: the six-job battery
(typecheck·lint·unit · production build · secret scan · PostgreSQL
integration · money-path coverage · E2E) on the implementation commit —
the run URL lands in the close-out commit message per the house discipline.
