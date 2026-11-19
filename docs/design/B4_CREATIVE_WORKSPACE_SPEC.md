# TubeForge — B4 Creative Workspace Enhancement Specification

Status: SPECIFIED + IMPLEMENTED (execution record in §9) · Author: design/engineering session
Scope: B4 — the four priorities from the operator's directive (professional editing layout,
2D motion graphics, 3D production, audio production), built ON TOP of B1–B3. "Do not restart
the design. Do not rewrite B1–B3."

Related: `docs/audits/b4-creative-workspace-audit.md` (the read-only engine audit this spec
commits against), `B1_DESIGN_SPECIFICATION.md`, `B3_PRODUCTION_WORKSPACE_SPEC.md`.

---

## 0. The audit's one-line verdict

The engines are AHEAD of the UI. Keyframed tweens (S129), the scene camera (S130), timed
events (S131), 15 exact-op easing curves (S162), the Scene3D schema (S94/S134/S160/S167) and
the keyframed ducking envelope (S167) all exist behind validated seams — the product surface
exposes almost none of them, and the five workspace areas are exclusive tabs, so nothing is
ever simultaneous. B4 closes exactly that gap: no engine rewrite, no second doc writer, no
new clock — UI and additive API over the existing schemas, through the existing validated
PUTs.

## 1. B4-1 — The professional editing layout (the headline)

**Exit condition: a creator sees the Canvas, the Inspector and the Timeline at the same
time, resizes each, and the preview/lanes never unmount while they work.**

The five areas stop being exclusive tabs for scene formats. New desktop (≥1024px) layout:

```
┌──────────────────────────────────────────────────────────────┐
│ header · badges · title · ProductionBoard (unchanged)        │
│ Area strip: Director · Storyboard · Canvas · Timeline ·      │
│             Inspector          (ARIA tablist, S86 ids)       │
├───────────────────────────────────────────┬──────────────────┤
│ CENTER — the focused work area            │ INSPECTOR RAIL   │ ← resizable
│ (director / storyboard / canvas / the     │ (always mounted; │
│  render & ship controls when Timeline     │  the full B3     │
│  is focused)                              │  Inspector)      │
├───────────────────────────────────────────┴──────────────────┤
│ TIMELINE STRIP — TimelineStudio, always mounted              │ ← resizable
│ (lanes + live preview + per-clip inspector)                  │
└──────────────────────────────────────────────────────────────┘
```

- Mechanism: `react-resizable-panels` (installed since the B1 inventory, wrapped in
  `src/components/ui/resizable.tsx`, never used until now) — one vertical group
  (center+inspector ↔ timeline strip) nesting one horizontal group (center ↔ inspector).
- The area strip keeps the Radix `Tabs` ARIA semantics (same triggers, same
  `activeTab`/`setActiveTab` law — the S86 controlled-tab jumps and the e2e selectors
  survive untouched), but `TabsContent` is retired: the center renders from a `switch`.
  Selecting **Inspector** focuses the Inspector full-width (the rail hides for that value —
  never two mounted Inspector instances); any other area brings the rail back.
- **One TimelineStudio instance.** The `videoTab` const is split: the studio becomes the
  always-mounted bottom strip (`timelineStrip`), the controls become the Timeline-area
  center content (`renderShipPanel`). The mobile (<1024px) stacked layout composes both via
  the existing `videoTab` — zero mobile regression (44px targets, sheet nav, no panels).
- Classic narration formats keep the B3 two-area layout exactly (Director · Inspector).
- Lane law kept: whiteboard/graphics own the Storyboard center; Canvas stays the pointer.
- Panel heights: the vertical group is a bounded editor viewport
  (`h-[calc(100vh-16rem)] min-h-[640px]`) with per-panel internal scroll; the page above
  (header + board) stays in normal flow. The sticky-footer law is untouched (the footer
  stays after the page content).

## 2. B4-2 — 2D motion & easing authoring (the engine is ready, the UI catches up)

**Exit condition: a creator can add an element to a graphics scene, choose its motions and
eases, keyframe its channels and the scene camera — and what they author is what renders.**

New **Motion** panel inside GraphicsStudio's Layout mode (the element strip's selection
footprint), everything through the SAME working-buffer → validated PUT path (no second doc
writer — the B3 law):

1. **Element insertion** — an "Add element" palette for the closed kind set (headline,
   subhead, bullet, counter, bar, shape) with legal per-kind payload defaults and staggered
   placement; ids follow the scene's `el-N` convention. The grammar is closed (`types.ts:224`);
   insertion composes within it.
2. **Motion editor** — per selected element: enter (required) / exit / emphasis slots with
   kind (the 8 kinds, filtered by the per-kind compatibility table), durationMs, delayMs and
   **ease — a dropdown over all 15 `EASE_CURVES` names** (the S162 table finally visible).
   Removing exit/emphasis is a button, not a hack.
3. **Tween editor** — per selected element: add a tween window (delayMs/durationMs) with
   per-channel tracks over the closed `TWEEN_CHANNELS` set, keys as `{tMs, value, ease}` rows.
   Time-sanity stays the validator's job (the wall, not the UI).
4. **Scene camera keys** — rows of `{tMs, zoom, tx, ty, ease}` with the `CAMERA_BOUNDS`
   pins surfaced in the UI (zoom 1–4), capped at the validator's `cameraKeysMax`.

NO renderer changes: everything evaluates through the existing `frameAt`/`cameraAt` the
moment the doc saves — "what you author is what renders" is the B3 canvas seam, unchanged.

## 3. B4-3 — The 3D scene panel (the lane becomes reachable)

**Exit condition: a creator can scaffold, inspect, edit and re-render a Scene3D clip from
the workspace — the API-only lane gets a surface.**

- **New `PUT /api/videos/[id]/scene3d`** (additive): body `{ doc }` validated through
  `parseScene3D` (the ONE parse law), saved to `video.scene3d`, optional
  `{ rerender: true }` re-enqueues the existing render job. POST (scaffold), GET (doc/clip)
  and DELETE stay untouched.
- **Scene3D card** in the Timeline area of the workspace: scaffold (existing POST), the doc
  editor (objects: kind/position/rotation/scale/material color·metalness·roughness·opacity;
  lights: ambient + directional intensity/color; camera: fov + keyframes; look: sky/fog/
  shadows; finishers: handheld shake + hold push-in), preview via the existing
  `GET ?clip=1` stream, re-render button (the PUT).
- Honest scope: point/spot lights, textures/env maps and light keyframes stay unshipped
  (schema-extension slices per the audit); the panel edits what the schema already holds.

## 4. B4-4 — Audio: the sfx event channel reaches the mix + a consolidated Audio card

**Exit condition: a graphics doc's `sfx` events are audible in the render, and the
workspace has one audio surface that plays the real mix.**

1. **The mixer consumption the S131 seam waited for** (`graphics/events.ts:1-16` named it):
   `graphicsAssemblyArgs` gains an OPTIONAL `sfxCues` parameter — absent ⇒ **byte-identical
   args** (the additive-seam law, same as the S130 camera). With cues (kind `sfx`, label a
   catalog kind), each cue's wav (`ensureSfx`) is adelayed to its projected global time and
   amixed under the bed. `renderGraphics` projects the cues via the existing
   `graphicsEventList`. No new clock — the projection IS the clock truth.
2. **Audio card in the Inspector rail**: the real-mix preview (`MixPreviewButton`) next to
   the voiceover player, plus a pointer to the Timeline area's music card (single-writer
   law — the card owns ducking/volume; the rail does not duplicate its writers).
   Ducking intensity/subtle-standard-strong stays owned by the music card (already
   shipped); the rail makes the MIX audible where the creator already is.

Honest gaps recorded (the audit's medium slices): music/SFX as draggable timeline clips,
the ducking-envelope editor, per-scene voice assignment, in-browser mic recording — all
need contract work beyond B4's UI pass and stay PENDING with named owners in the audit.

## 5. Component inventory (files touched by B4)

| File | Change |
|---|---|
| `src/components/tubeforge/production-workspace.tsx` | B4-1: panel layout (wide) + stacked tabs (narrow); `timelineStrip`/`renderShipPanel` split; Inspector rail; B4-3: Scene3D card mount; B4-4: Inspector audio card |
| `src/components/tubeforge/graphics/graphics-studio.tsx` | B4-2: Motion panel (insertion, motion/ease editor, tweens, camera keys) |
| `src/app/api/videos/[id]/scene3d/route.ts` | B4-3: PUT (validate + save + optional re-render) |
| `src/lib/tubeforge/graphics/render.ts` | B4-4: sfx cue projection into `renderGraphics` |
| `src/lib/tubeforge/graphics/assembly.ts` or `render.ts` (where `graphicsAssemblyArgs` lives) | B4-4: optional `sfxCues` in the args builder (absent ⇒ byte-identical) |
| `scripts/test-unit.mts` | B4 pins: args byte-identity, sfx mix graph, scene3d PUT validation law, B4-1 source pins |
| `e2e/premium-ux.spec.ts` | only if a selector needs the new layout (deliberate, recorded) |

Untouched by contract: the renderers' frame truth, the validators, the compose seam,
`TimelineStudio`'s interior, Prisma schema/migrations, the compat seams.

## 6. Responsive & accessibility

- ≥1024px: the panel layout; <1024px: the B3 stacked tabs byte-for-byte (the mobile-sweep
  spec keeps passing untouched).
- The area strip keeps `role=tablist`/`tab` semantics and keyboard operability (Radix);
  the resize handles are pointer+keyboard native (`react-resizable-panels` ships both).
- 44px touch targets unchanged on mobile; `prefers-reduced-motion` untouched.

## 7. Acceptance criteria & test plan

1. **Simultaneity**: at 1280px, opening a scene video shows the work area + Inspector rail
   + Timeline strip at once; dragging the handles resizes; switching areas never unmounts
   the strip (the preview stays alive).
2. **Laws**: S86 jumps (critic → Storyboard, storyboard → Canvas) land the center correctly;
   the lane law pointers hold; classic formats unchanged; mobile stacked = B3 behavior.
3. **Motion authoring**: inserted elements enter legally; an edited ease/duration is visible
   in the next canvas playback (the same `frameAt`); tween/camera edits survive save+reload
   (the validated PUT round-trip).
4. **3D**: PUT validates (junk → 400 with the parse error), saves, re-renders; the preview
   plays the standing clip.
5. **Audio**: a doc with `sfx` events mixes them at the projected times; a doc WITHOUT
   events produces byte-identical assembly args (battery pin); the Inspector audio card
   plays the real mix.
6. **Battery**: `npm test` green (new B4 pins); **Typecheck/Lint**: green.
7. **E2E**: the Playwright suite green (desktop flows ride the new layout; mobile flows
   unchanged).
8. **CI**: push → 8/8 checks green.

## 8. The three-project production test (the directive's gate)

After B4 lands: three representative projects driven through the REAL engines
(Islamic-history cinematic, 2D educational motion graphics, character-animated story),
measured on the directive's eight metrics (brief→preview time, manual corrections,
continuity, motion quality, audio sync, render reliability, cost, edit/export ease).
Record: `docs/audits/b4-three-project-production-test.md`. Provider-gated steps are
measured against the offline/native paths and recorded honestly where a provider key
would change the number.

## 9. Execution record

Implemented 2026-11 (single pass). Receipts per §7:

1. **Simultaneity** — the browser walk (1440×900, `scripts/b4-walk.sh`, receipts
   `/tmp/b4walk/`, session artifacts) shows the three surfaces AT ONCE: the work-area
   center (Director/Storyboard/Canvas/Timeline-controls), the Inspector rail (voiceover
   player + the B4-4 Final mix preview card + engagement kit), and the bottom strip with
   the REAL TimelineStudio (transport, lanes, voice picker). Live DOM probe: 2 panel
   groups, 2 keyboard-focusable resize handles, the strip's own component tree mounted.
2. **Laws** — the S86 controlled-tab jumps land the center (critic → Storyboard, canvas
   jumps verified live); the lane law pointers hold (the studios own Storyboard for
   whiteboard/graphics); classic formats keep the B3 two-tab layout untouched; at 390px
   the B3 stacked tabs render with ZERO panel groups and `scrollWidth === 390`; the
   battery's B4-1 source pins keep the ARIA tablist + `setActiveTab` law and the
   rail-hides-on-Inspector rule pinned.
3. **Motion authoring** — the GraphicsStudio element strip hosts the B4-2 panel
   (insertion palette, enter/exit/emphasis editor with the 15-curve ease dropdown, tween
   channels/keys, camera keys with the zoom pins); every patch rides the SAME
   buffer → dirty → validated PUT path (battery pin: no second writer).
4. **3D** — `PUT /api/videos/[id]/scene3d` validates through `parseScene3D` (unparseable →
   400, never a silent overwrite), saves, re-renders through the SAME deterministic job
   POST uses (battery pins); the Scene3D card renders in the Timeline area (walk receipt:
   "3D scene clip" + Scaffold visible live).
5. **Audio** — `graphicsAssemblyArgs` with NO cues produces the pre-B4 strings
   byte-identically (battery pins, four arg shapes); WITH cues the mix is one amix over
   the projected times (`adelay` at the event's global ms, `duration=first` anchored by
   the VO or a generated silence — never by a short cue); the Inspector's Final mix
   preview plays the real 12s mix (walk receipt).
6. **Battery** — `npm test` → **1025/1025** (1013 + six review pins + six B4 pins: byte
   identity, the sfx mix graph, the scene3d PUT law, the layout pins, motion authoring,
   and the harness env-truth pin below). Typecheck clean; changed-file eslint clean.
7. **E2E** — full Playwright suite **37/37** (2.0m). The road there earned a fix of its
   own: the alternating-victim 429 flake (a different spec dying each full-suite run,
   every one passing solo) turned out to be a REAL post-rebrand escape —
   `playwright.config.ts` still raised the ceilings under the LEGACY `TUBEFORGE_RATE_*`
   names, which rebrand stage-B left reading at NEITHER limiter layer
   (`rate-limit.ts` + `shared-rate-limit.ts` read only `TUBEFORGE_RATE_*`). The
   harness speaks the current names now, and a battery config-truth pin keeps the
   harness env and the limiter env from drifting apart again.
8. **CI** — push pending (this session's commits ride together; the operator's push gate
   runs the 8/8 check suite).
