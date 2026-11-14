# W6 — the continuous canvas

**Status:** LANDED (this commit). Stage spec: `docs/design/s120-2d-animation-roadmap.md` §3 W6 — scenes can carry the board (keep/fade/erase/pan-away) instead of four hard board-wipes per video (the continuity row the W1 baseline scored 1/5). The exit gate: carried-state equality pinned; exit events deterministic; clean-mode scenes byte-identical to HEAD.

## What landed

**`storyboard.ts` — the additive board policy.** `WhiteboardScene.board?: { mode: "clean"|"continuous"; carryPlacements?: string[]; exit?: "keep"|"fade"|"erase"|"pan-away"; transitionMs?: number }`. The additive-parse law holds: a doc with no `board` field parses exactly as before (board absent = clean = today's hard wipe). Validation is strict about integrity, tolerant of order:

- a continuous scene requires a previous scene (scene 1 cannot carry);
- `carryPlacements` names must exist among the PREVIOUS scene's placements, may not duplicate, and a carried asset may not be re-placed (duplicate ink + namespaced-id collisions at the page seam) nor animated (the carry plan owns those elements for the whole scene);
- `exit` ∈ the four kinds; `transitionMs` ∈ (0, 5000]; a "keep" exit takes no transitionMs; a clean board takes no carry/exit fields. Defaults live in ONE place (timing.ts): exit "keep", transitionMs `BOARD_EXIT_DEFAULT_MS` = 600.

**`timing.ts` — the carried-ink plan (pure).** `resolveCarriedInk(prevScene, prevDurationMs, board)` resolves what scene K+1 inherits as **DATA** — never page residue (per-scene chromium recycling stays untouched; the S75 OOM receipt is the reason): each carried placement resolved to its END-OF-PREVIOUS-SCENE state (`placementAt` at the previous scene's own clock, so `move_object` runs to completion), plus the previous scene's `reveal_color` state at that clock (fills carry AS SEEN — partial reveals carry their partial progress). `carriedExitAt(plan, width, tMs)` computes the shared exit state per frame: fade unweights opacity 1→0, erase un-draws (dashoffset runs 0→each stroke's length — the ink retreats along the stroke), pan-away slides the layer off the left edge (2 board widths — clears any fully-on-board placement); all eased with the SAME easeInOut the camera and move_object ride, continuous at both joints, byte-identical double-run.

**The frame layer rides the SAME maps.** `FrameState.carried` is the layer (null = clean); the carried ink INJECTS into the existing `draws`/`texts`/`colors`/`placements` maps (every path fully drawn, every text fully written — the scheduler's fill law guarantees that is exactly the previous scene's end visual), so `wb-page.ts`'s ONE applier carries the ink with zero new machinery: the carried block applies group transform (placement + pan offset), fade opacity, and — applied last, after the draw loop set the strokes drawn — the erase dashoffset override. `framePayload` serializes `carried` (clean frames: null — additive wire format).

**`wb-page.ts` — `composeScene(scene, project, assets, carried?)`.** The carried groups render FIRST (document order = z-order: carried ink UNDER the scene's own ink), through the same namespacing and the same path/text registration the placements ride — extracted into one `renderPlacement` helper both loops share. Carried assets use their REAL ids (the validator's no-re-place rule keeps page ids unambiguous).

**`render.ts` — the carry wiring.** Per scene: `carryPlan` resolves from the previous scene at the estimator's clamped clock (the SAME `sceneMs[]` the frame budget and the tracks read — one clock everywhere); it feeds both `composeScene` and `frameAt`. The result carries `boardModes` per scene. The frame budget accounting is unchanged (carried ink adds paths to the page, never frames).

**`render-assembly.ts` — the S117 manifest +1 field, additive.** `AssemblyEntry.boardMode?` — stamped by `manifestOf(assembly, mode, boardModes?)`; the tolerant parse reads both shapes (old manifests and other lanes stay field-absent). It is deliberately NOT a staleness comparison key (board changes invalidate rendered artifacts through the doc-edit sweep, as any doc edit always has). **The whiteboard final render now records a manifest at all** — a latent gap closed: a whiteboard video with revision history could never prove its assembly (the S117 "unknown" state refused it at the ship gates); the whiteboard full render now writes the manifest with board modes stamped.

**`tracks.ts` — the no-grammar-change pin.** A continuous scene projects as ONE clip exactly like a clean one (the carried ink lives inside the scene's frames; the contract reads only the clock) — pinned by test.

**`wb-canvas.tsx` — the editor rides the same resolver.** The preview resolves the carry plan through the same `resolveCarriedInk` (previous scene's clock, VO-measured when the editor knows it) and feeds the same compose + the same applier — what the preview shows at t is what the MP4 contains at t.

## Proof

- House suite **581 → 590** (the W6 battery): the additive-parse law (board-less docs byte-equal), full field round-trip, crafted violations with readable reasons (modeless/unknown mode, clean+exit, first-scene-continuous, off-board carry names, duplicated names, transition past the wall, carried+re-placed, carried+animated); `resolveCarriedInk` (end-state placements incl. completed `move_object`, subset carry, partial color carry at the previous clock, defaults, determinism); `carriedExitAt` (keep constant, fade/erase/pan monotone + joint-continuous + byte-identical double-run); **the carried-state equality pin — frame 0 of scene K+1 contains exactly scene K's carried ink (byte-pinned layer)**; compose ordering (carried group renders first) + clean-compose byte-identity + payload shape; the tracks no-grammar-change pin; the compile-only seam pins (render wiring, additive manifest, editor one-source).
- **The W1 harness identity gate GREEN** (16:9, real chromium + ffmpeg): every benchmark scene is a clean scene — zero rendered pixels moved (the byte-identity exit gate).
- eslint . clean repo-wide; tsc clean.

## Honest edges

- Carry depth is ONE (the previous scene's own placements, per the spec's "resolved from the previous scene's placements"). A "keep" chain across three scenes does not propagate scene K−1's ink through scene K — recorded as future work if a scenario needs it (the data-only fold is available at the resolver).
- The carried ink arrives fully drawn at frame 0 — the DRAW history (the pen re-drawing the carried strokes) is deliberately not replayed; "carry" means the ink is already on the board.
- Erase un-draws all carried strokes of a placement simultaneously (each along its own length). A stroke-by-stroke reverse wipe would need the previous scene's draw ORDER in the plan — taste future work.
- pan-away's 2-width slide clears any placement whose content sits fully on the board (the studio's and the planner's invariant); an absurdly off-board placement would slide but not fully clear — deterministic either way.
- `directCamera`/`beatSceneEvents` are untouched: a continuous scene's own scheduling is identical to a clean one; only the inherited layer differs.

## Rollback

Delete the `board` fields from the doc → parse falls back to clean mode (tolerant-read); the renderer's carry branches resolve null and the page composes byte-identically to pre-W6. The manifest's boardMode is optional and ignored by every comparison.
