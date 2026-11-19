# TubeForge — B4 Creative Workspace Audit (2D · 3D · Timeline · Audio)

Status: COMPLETE (read-only audit, 2026-11) · Author: engineering session
Method: file-by-file engine read with `path:line` receipts; "not found" means verified
absent by grep/read, never assumed. Feeds `docs/design/B4_CREATIVE_WORKSPACE_SPEC.md`.

Commissioning context (the operator's directive): B1–B3 are verified done (CI 8/8 on
`49955af`). The next evolution is **B4 — Creative Workspace Enhancement**, four priorities:
(1) professional editing layout, (2) 2D motion graphics, (3) 3D production, (4) audio
production. "Do not restart the design. Do not rewrite B1–B3. Build on what is already
working." This audit identifies what is implemented, what is incomplete, and what needs
better UX — per engine.

---

## A. 2D motion graphics engine

### A1. Implemented

| Capability | Receipt | Notes |
|---|---|---|
| Closed doc schema v1 — 11 element kinds (headline, subhead, bullet, counter, bar, barChart, icon, callout, shape, group, sprite) | `src/lib/tubeforge/graphics/types.ts:224-228` | Kind set closed by law; motion-per-kind compatibility table `types.ts:235-252` |
| Per-kind payloads (text, counter, bar, icon paths, callout, shape rect/line/circle, group, sprite sheet/sequence) | `types.ts:267-353` | Sprite = S126 import lane (`types.ts:339-353`) |
| 8 fixed motion kinds × 3 slots (enter required, exit/emphasis optional) | `types.ts:83-86`, `types.ts:382-384` | fade, rise, slide, pop, wipe, count, grow, draw |
| **Keyframed tweens (S129/PAE-1)** — 6 channels dx/dy/scale/rotateDeg/opacity/progress, window-relative keys, per-key ease | `types.ts:126-156` (`TWEEN_CHANNELS` at 126), eval `graphics/frame.ts:310-327` | Rotation only via tweens (`frame.ts:41-42`); additive channels sum, multiplicative multiply |
| **Scene camera (S130/PAE-2)** — `GraphicsCameraKeyframe {tMs, zoom, tx, ty, ease}`, zoom pinned [1,4] | `types.ts:176-190`, eval `graphics/camera.ts:41-65` | Camera-less scenes compose byte-identically (additive seam) |
| **Scene events (S131/PAE-3)** — `sfx`/`hit`/`cue` cues on the scene clock | `types.ts:211-222`, projection `graphics/events.ts:49-73` | "Cues are not clips" (`events.ts:7-9`) |
| Hit-kick camera shake (S160) | `graphics/frame.ts:234-262` (`hitKickOffset`) | 7-frame decaying shake on `hit` events |
| Counter craft: tabular-nums, landing pulse, kinetic stagger 150 ms (S162) | `frame.ts:115-137`, `frame.ts:368-397` | Count-up only (`types.ts:279-281`) |
| **Easing: 15 named curves, all exact-op** | `src/lib/tubeforge/anim/easing.ts:42-57`, table `:294-310` | S162's nine measured curves (cubic-bezier + OpenToonz formulas, `:147-291`); no Math.pow/exp/log anywhere |
| Keyframe eval with clamp-hold + destination-key ease | `anim/keyframe.ts:46-59` (`evalAt`) | Shared by graphics, 3D, rig |
| Frame budget wall 25,920 frames (18 min @ 24 fps) + delivered-count law R-1 | `anim/clock.ts:20`, `graphics/preflight.ts:12-40` | |
| Pure frame truth `frameAt(doc, tMs, voMsBySceneId)` | `graphics/frame.ts:425-471` | Fixed precedence enter→tweens→exit→emphasis (`frame.ts:28-31`) |
| Scene clock: explicit duration > measured VO + 350 ms tail > 2.6-wps estimate | `frame.ts:193-218`, `graphics/vo-ms.ts:25-40` | One clock model reused by wall/tracks/QC |
| Native rule-table planner + metered LLM planner (normalization + drop report) | `graphics/planner.ts:57-423`, `graphics/llm-planner.ts:67-79,502-775` | Walls: 6 elements/scene, 5 chart rows, 250 ms min motion |
| Native transition engine (S163) — 6 types | `graphics/transitions.ts:61-78`, seam `types.ts:458-465` | 2-45 frames, seeded wipes |
| Timeline projection (S87 contract) | `graphics/tracks.ts:71-121` | Track kinds closed at `timeline.ts:101-109` |
| QC matrix (cuts, hold windows, readcheck, determinism sweep) | `graphics/qc.ts:74-273`, UI `graphics-studio.tsx:676-698` | |
| Draft viewport (0.5/0.75/1.0×, labelled non-reviewable) | `graphics/draft.ts:16-25`, UI `graphics-studio.tsx:805-817` | One-renderer rule |
| Static-frame dedup for holds (S165) | `graphics/static-dedup.ts:1-25` | |
| Chromium+ffmpeg render w/ resume + fingerprint | `graphics/render.ts:336,533`, `render-gates.ts` | |
| **Element editor (S124)** — hit-test, exact move, anchored scale (0.05–20), z-order with slots law | `graphics/editor.ts:44-175` | Pure laws unit-pinned |
| Studio UI: transport, scrub, doc save via validated PUT, scene editors | `graphics-studio.tsx:515-829` | Layout mode toggle `:540-546` |
| Canvas playback = exact render seam | `graphics-canvas.tsx:1-43`, pointer plumbing `:347-452` | "What you drag is what renders" |
| S170 animation compiler (offline plan, no AI in loop) | `src/lib/tubeforge/animation-compiler.ts:132-261` | Plan-only; render wiring explicitly not claimed |

### A2. Incomplete / partial

- **No per-shape animation authoring UI.** Tweens (S129), scene camera (S130), events (S131)
  are schema + planner features; the studio exposes none of them (grep of
  `graphics-studio.tsx` for camera/tween/event authoring: no matches).
- **No motion paths** — tween channels are dx/dy/scale/rotate/opacity/progress only.
- **No text animators** (per-word/per-glyph kinetic type) in the graphics lane — kinetic
  stagger is per-element only; glyph/draw text lives in the whiteboard lane.
- **No preset library** as a user-facing system (closest: the native rule table, `CREATIVE_PRESETS` in `creator-experience.ts:113`, export presets in `production-workspace.tsx:2078`).
- Counter is count-up only; groups don't nest (depth 1, `types.ts:489-491`).
- S162 blind human gate still PENDING (`docs/audits/s162-visual-acceptance-record.md`).
- S170 compiler is a plan handoff only (`s170-animation-compiler.md` §3).

### A3. UX gaps (the UI does not expose)

Tween/keyframe authoring (no keyframe timeline, channel editor, or per-key ease picker);
scene-camera keys editor; event (`sfx`/`hit`/`cue`) authoring; per-element enter/exit/emphasis
timing + ease editing (planner-chosen today); new-element insertion (S124 edits existing
elements only); easing-curve visual picker despite 15 curves; rotation is display-only in
the element editor (`graphics-studio.tsx:652`).

---

## B. 3D production engine

### B1. Implemented

| Capability | Receipt | Notes |
|---|---|---|
| Scene3D schema v1 — objects (box/sphere/plane) with PBR-ish material (color, metalness, roughness, opacity) | `src/lib/tubeforge/scene3d.ts:44-74` | Only 3 object kinds; lights only ambient/directional (`:47-48`) |
| Object keyframes (S134) — normalized t, per-channel subsets, max 16 keys | `scene3d.ts:65-91`, eval `:626` | Per-key destination ease (S160) `:85` |
| Camera — fov (20..110), position/lookAt keyframes with per-key ease | `scene3d.ts:101-151`, eval `:532,570` | |
| Finishers (S167): fBM handheld shake + exponential hold push-in | `scene3d.ts:113-150`, math `anim/camera.ts:265,298` | |
| Look pass (S160): gradient sky dome, depth fog, real sun shadows, neutral tone mapping | `scene3d.ts:132-140`, `render3d.ts:21-31` | |
| Tolerant parse/serialize + deterministic scaffold | `scene3d.ts:242,371,442` | Topic-seeded arrangement |
| three.js r187 renderer (no network, blob-URL module injection, gate diagnostics) | `render3d.ts:63,211` | SwiftShader under headless chromium |
| Shared camera-move vocabulary (validate/eased sampling/pinhole projection) | `anim/camera.ts:36-165` | MIT "Stickman" reimplementation |
| **Character rig (S125/K1)** — 2D puppet grammar: 24 parts, 24-pose sheet, FK about pivots, standard slots (mouth 5+2, arm, brow) | `characters/rig2d.ts:87-130,540,901` | FK only — no IK/skinning (recorded non-goals) |
| Rig frame truth — poseAt FK chains, 320 ms pose tween, W4 word-anchor mouth schedule | `characters/rig-frame.ts:1-60` | Syllable beats + degradation ladder |
| Rig compose seam + timeline projection + preflight | `characters/rig-compose.ts`, `characters/tracks.ts`, `characters/preflight.ts` | Track kind "character" |
| Gesture director (compile-only beats) + chromium renderer + clip cache | `characters/rig-director.ts`, `characters/rig-render.ts` | Pose timelines compile-only, not persisted |
| BVH mocap sidecar (FreeMoCap clean-room adapter) | `characters/bvh.ts:1-40` | Data protocol only |
| Legacy breath rig (S93) for portrait cast scenes | `character-rig.ts:57`, amplitude cap `:25` | |
| 3D API surface — POST scaffold+render job, GET doc/clip, DELETE | `src/app/api/videos/[id]/scene3d/route.ts:24-33` | |
| 3D clip staged into a real assembly (smoke receipt) | `scripts/s167-3d-assembly-smoke.mts`, `docs/audits/s167-3d-assembly-smoke.json` | 2 s 48-frame clip + concat |
| Director 3D vocabulary — object-add, light-add, camera-keyframe, push-in, shake | `director-vocabulary.ts` (`DIRECTOR_3D_ACTIONS`) | |
| Rig UI: auto-rig, compiled preview, pose-id strip, warnings (read view) | `characters/rig-panel.tsx:65-165`, preview `:rig-preview.tsx` | Mounted in Cast view only (`views/cast-view.tsx:947`) |

### B2. Incomplete / partial + UX gaps

- **No 3D scene editor.** The only write path is `POST /api/videos/[id]/scene3d`
  (scaffold → render, replace-all). No UI to add/move objects, edit materials, place lights,
  or author camera keys (grep of `src/components` for scene3d: only the API route + an
  unrelated CSS swatch name).
- **No 3D preview in the workspace** — the rendered clip is a file (`GET ?clip=1`); no
  viewport, no orbit controls anywhere.
- Rig pose editor is a recorded follow-up (`rig-panel.tsx:10-12`: "v1 ships the honest read
  view"); pose timelines compile-only, no persistence.
- Light animation / point & spot lights / textures / env maps / HDRI: not found in the schema.
- No 3D character module (no glTF/USD import, no three.js character system) — "not found".
- RigPanel exists only in Cast, not in the production workspace.

---

## C. Timeline / editing surface (the workspace layout)

### C1. The exact layout today

Five areas are **exclusive Radix tabs** in `production-workspace.tsx`:

- `TabsList` triggers director/storyboard/canvas/timeline/inspector: `production-workspace.tsx:4288-4304`
- `TabsContent` bindings: `:4305-4347` (storyboard branch by renderMode `:4308-4337`; classic
  formats get two tabs `:4349-4366`)
- Area definitions: `videoTab` (Timeline) `:1992` (TimelineStudio `:1998-2007`, captions
  `:2040-2066`, export presets `:2068-2104`, music `:2107-2112`, motion/transitions
  `:2117-2137`, render buttons `:2153-2195`, S40 ship gate `:2219+`); `canvasArea` `:4103`
  (scene rail `:4105-4146`, `SceneStudioPanel` `:4181-4196`); `inspectorArea` `:4091` =
  `packageTab` + footer (voiceover player `:2758-2759`, voice panel `:2764-2891`);
  `scriptTab` `:3307`.
- **No `forceMount`** on any TabsContent (grep: none) → inactive areas unmount; nothing is
  simultaneous.
- `react-resizable-panels` is installed (`package.json:99`) and wrapped in
  `src/components/ui/resizable.tsx:9-56` but **unused** by any ibismuh component.

### C2. TimelineStudio implemented (5,273 lines)

| Capability | Receipt |
|---|---|
| Multi-lane timeline (video/voice/captions/music), ruler, playhead, zoom+fit | `timeline-studio.tsx:3426-3650` |
| Live canvas preview (approximate Ken Burns, transitions, captions, chroma, synced WAVs) | `:2023-2168`, honesty note `:3551-3557` |
| Clip ops: split (re-voices both halves), duplicate, delete via `POST /studio/clip` | `:3470-3514`, `clip-ops.ts` |
| Drag-reorder (dnd-kit) | `:100-117`, `:3608-3641` |
| Per-clip inspector: duration, transition, caption, audio levels, SFX/ambience with audition, grade, title, camera keys, speed, chroma, PiP, voice fades, artwork ops, revoice | `:4195+`, wiring `:3562-3591` |
| Narrator swap (S8) + pace change (S11) | `:73-88`, `:1247`, `:1501-1504` |
| Caption style catalog (S6) + music pick (S7) with audition | `:62-72`, `:2601-2675` |
| Undo/redo + debounced autosave (PUT /assemble) | `:472`, `:322` |
| Keyboard transport (space/arrows/home/end/S/D/⌫/⌘Z/⌘S) | `:2450` |

### C3. Incomplete / partial + UX gaps

- **Panels are not resizable anywhere**; the preview column is a hard-coded
  `lg:grid-cols-[1fr_300px]` (`timeline-studio.tsx:3426`).
- **No persistent preview** — the preview canvas exists only inside the Timeline tab and
  unmounts on tab switch; the whiteboard/graphics studios have separate canvases in the
  Storyboard tab; there is no shared/persistent preview across areas (not found).
- Timeline lanes are per-scene abstractions, not free clips: each scene is one clip on each
  lane; music is doc-level, not a draggable clip; SFX are per-scene kinds, not placed clips.
- Graphics/whiteboard lanes bypass TimelineStudio entirely (two parallel editing surfaces).
- The universal Timeline contract (S87) has graphics/3d/character track kinds
  (`timeline.ts:101-140`) that the TimelineStudio UI does not render.
- B1 §6's simultaneous wireframe (`B1_DESIGN_SPECIFICATION.md:257-270`) — Director brief |
  Canvas | Inspector columns + bottom timeline strip — is the unshipped remainder of B3's
  tab regrouping (`B3_PRODUCTION_WORKSPACE_SPEC.md:40-77`).

---

## D. Audio production

### D1. Implemented

| Capability | Receipt |
|---|---|
| TTS — 10+ providers incl. zai, heygen, openai, gemini, cartesia, deepgram, playht, elevenlabs (S159), voicestudio | `providers/tts.ts:1-13,486,549,579` |
| Cost-tier voice router (S176): zero/freetier/paid, free-mode refuses paid | `voice-router.ts:33-39,107` |
| Voice cloning (zhipu/selfhost/voicestudio) with consent basis + sample prep | `voice-clone.ts:71-85,356` |
| Bring-your-own voice — upload/URL (SSRF-guarded), ffprobe-validate, normalize, auto per-scene cut | `voice.ts:1-30,148` |
| Voice previews/auditions | `voice-preview.ts:24,64`, `api/voices/[id]/audition`, `voice-view.tsx:180-226` |
| Narration chunking + production plan + regeneration verdicts (S175) | `voice-manager.ts:108-213` |
| Quality profiles + pronunciation lexicon | `voice-manager.ts:34-41`, `pronounce.ts` |
| Music library — in-app synthesized originals, metadata-backed licenses, upload ingestion (60 MB), auto mood-match | `music.ts:54-69,285,627,701,795`; UI `music-controls.tsx`, `music-upload-dialog.tsx`, `settings-music.tsx` |
| Music mixing — volume slider, fades, sidechain ducking (4 intensities) + S167 transcript-driven keyframed duck envelope | `audiomix.ts:52-115,172-291` |
| Loudness contract — measure-then-normalize −16 LUFS / −1 dBTP | `audiomix.ts:36-48` |
| Mix preview — real final mix window | `audio-preview.ts:41-69`, route + `MixPreviewButton` `music-controls.tsx:451-489` |
| SFX — synthesized catalog (whoosh/boom/riser/sting) + whiteboard kinds | `sfx.ts:1-33,114,123` |
| Per-scene sound design (S5) — SFX cue + ambience bed with audition of the exact render wav | `studio-sound.ts:40-49,109`; UI `timeline-studio.tsx:3570,795` |
| Per-scene mix levels + voice fades | `timeline.ts:546`, `timeline-studio.tsx:761` |
| ASR (zai, whisper-1 word stamps, voicestudio whisperx ±10-30 ms) + speech-run aligner | `providers/asr.ts:32-39,100`, `captions.ts:50-335` |
| Audio truth in the universal tracks projection | `graphics/tracks.ts:85-114` |

### D2. Incomplete / partial + UX gaps

- **No per-scene voice** — one voice per video; the narrator swap re-reads every scene
  (`timeline-studio.tsx:73-80`).
- **No in-browser recording** (clone samples are uploads only).
- **No audio clip editing** — music is a doc-level bed with volume/fades; no waveform
  editing (waveform is display-only, `timeline-studio.tsx:4039`).
- **No ducking-envelope UI** — the S167 keyframed envelope is render-side only.
- **No audio effects rack / loudness meters in UI** (QC windows are server-side).
- Graphics `sfx` events (S131) are **not consumed by the mixer** yet
  (`graphics/render.ts` grep: no sfx matches; `events.ts:1-16` names the seam "the audio
  consumers read").
- SFX/ambience pickers live only inside the Timeline clip inspector; no browsable SFX
  library; ducking/fades are not visualized on the timeline; audio playback is scattered
  across four surfaces (Inspector voiceover player, Timeline mix preview, Voice Studio
  auditions, Timeline preview WAV sync).

---

## E. Cross-cutting facts

- `react-resizable-panels ^3.0.3` installed (`package.json:99`), wrapped in
  `src/components/ui/resizable.tsx` — **unused** so far. No framer-motion/GSAP/anime.js —
  all animation is custom/SVG/CSS-keyframe (house law).
- B1 §6's simultaneous wireframe is the unshipped remainder of B3's tab layout.
- The universal animation layer (S171/S172: 14 primitives, cross-mode matrix) and the S170
  compiler are closed but plan-side; render wiring was explicitly out of their scope.

## F. B4 recommendation sketch (what the spec commits)

- **P1 — Professional editing layout (small, high leverage).** The five areas already exist
  as composable JSX blocks. Replace the exclusive `Tabs` with `react-resizable-panels`:
  persistent Timeline preview strip always alive (it self-contains preview+lanes), a
  resizable right Inspector rail fed by selection, Canvas/Storyboard sharing the center.
  Keep the lane law (whiteboard/graphics own Storyboard) and the 2-area classic fallback.
- **P2 — 2D motion graphics (medium).** The engine is ahead of the UI: tween/keyframes
  editor over `ElementTween` + per-key ease dropdown over `EASE_CURVES`; scene-camera key
  editor over `GraphicsCameraKeyframe`; element-insertion palette; preset library as saved
  doc fragments + picker. No renderer changes — everything evaluates through `frameAt`.
- **P3 — 3D production (small→medium).** Scene3D editor panel over the existing schema
  (objects, materials, lights, camera keys, sky/fog/shadows, shake/pushIn) with preview via
  the existing GET clip route; surface the rig strip inside the workspace; light keyframes
  are the schema-extension slice.
- **P4 — Audio production (small→medium).** Unify the four audio surfaces into one Audio
  panel (mix preview + library + per-scene sound + ducking); wire graphics `sfx` events into
  the mix (projection exists, mixer consumption absent); music/SFX as timeline clips and a
  ducking-envelope editor are the medium slices; per-scene voice is the largest gap.
