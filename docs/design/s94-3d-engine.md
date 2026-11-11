# S94 — Blender / 3D engine v1 (design)

**Status:** v1 implemented — the versioned Scene3D contract
(`scene3d.ts`, 3 pins), the three.js/SwiftShader renderer (`render3d.ts`),
the durable job kind, the route, both kind ledgers at 24, the real-
artifact smoke (`scripts/s94-3d-smoke.mts`, 14/14, 2026-11-11), unit
471/471. Spec source: the S76 adoption decision §3 Phase 3
("Blender/Three.js production") + the §6 acceptance row ("Real scene
rendered through the shared timeline — **No isolated rendering
pipeline**") + the governing rule §8. The §5 P5 deferral ("until the
Universal Timeline is stable") is MET (S87 closed + the battery).

**The question it answers:** "Can TubeForge render a REAL 3D scene — and
does it reach the delivered cut through the same contracts everything
else uses?" Yes on both: a real WebGL 2 raster (three.js r187 under the
headless chromium's SwiftShader — the S94 probe receipt), and the clip
rides the composition plan as an ORDINARY video asset to a delivered cut.

## 0. The laws

1. **No isolated rendering pipeline** (the acceptance row, proven by
   demonstration): the 3D clip is an ordinary video file the composition
   plan reads as a video-kind clip — the compositor plays it exactly like
   stock footage, and MUST NOT be able to tell the difference (the smoke
   rides it through assembleTimeline → compositionPlan → renderVideo → a
   delivered cut with exact windows and the narration mixed).
2. **The renderer's law**: REAL frames from a real rasterizer —
   three.js WebGL 2.0 (SwiftShader) under the SAME chromium pipeline the
   Whiteboard engine proves (the E10 launch args, the route-abort
   security line, per-frame screenshots, ffmpeg encode). The page has NO
   network; three injects from the dependency's own source as blob-URL
   module imports (r187's `three.module.js` imports `./three.core.js` —
   both sources inject, the specifier rewritten to the core's absolute
   blob URL; the `</script>`-injection hazard escaped the standard way).
   A blank first frame or a failed init throws a READABLE error — never
   a silent fake.
3. **The house doc laws** (S88's, verbatim): versioned (an unknown
   version reads as absent, never overwritten), tolerant parse (null on
   unreadable; invalid objects/lights drop individually; every field
   clamps honestly; strict optionality — parse never invents what
   serialize omits, so the round-trip is byte-stable), strict write,
   deterministic scaffold (same topic → same bytes).
4. **The never-silent render law**: a doc with no lights gets the
   ambient default (never a black render) — and the renderer refuses
   honestly when WebGL is unavailable in the deployment (the recorded
   deployment note: the sandbox probe confirmed WebGL 2.0/SwiftShader;
   a deployment without it fails the job with the readable error).
5. **Blender is the adapter, not the engine**: the Scene3D contract is
   what a future offline Blender headless exporter emits — the same doc,
   the same job, the same shared-timeline consumption. The deterministic
   scaffold (ground plane, topic-seeded centerpiece, two satellites,
   three-point lighting, a keyframed orbit) is the v1 author; the LLM
   scene planner is the recorded tail.

## 1. The shape

- **`scene3d.ts`**: the Scene3D doc (aspect/width/height/fps/duration/
  background; a camera path of keyframes t∈[0,1]; box/sphere/plane
  objects with clamped materials; ambient/directional lights), tolerant
  parse + strict serialize + `cameraAt` (pure, pinned interpolation) +
  `scaffoldScene3D` + the durable job (`runScene3DJob`, the S88 shape —
  crash-resumable; a resume re-renders whole, deterministic, same clip).
- **`render3d.ts`**: the chromium/three renderer — frame count =
  durationSec × fps (exact), `cameraAt` drives the camera per frame,
  screenshots → ffmpeg encode → `3d/scene-3d.mp4` (no audio — the clip
  joins the shared assembly like any footage, where narration/bed mix).
- **`Video.scene3d`** (the tenth JSON doc column + migration), the
  `scene3d` job kind (STAGE_LABEL, resumable list, the artifact-landed
  condition, the handler registration), `POST/GET(±?clip)/DELETE
  /api/videos/[id]/scene3d`.
- **BOTH kind ledgers went 23 → 24 IN THE SAME SLICE** (test-unit's
  resumable list and test-queue's Phase A ledger — the morning's
  CI lesson, applied where it bit).

## 2. The proof

- **Unit (3 pins)**: the doc laws (junk/version/empty refused; the
  byte-stable round-trip; deterministic scaffold), the geometry
  derivation + clamps (fov, junk objects drop individually) + the
  never-silent light law, cameraAt (exact interpolation, clamped ends,
  single-keyframe holds).
- **The smoke (14/14, real render)**: 96 frames at 24fps rendered in
  ~10s through SwiftShader WebGL; the clip lands (99 KB, 4.00s exact);
  the composition plan reads the doc, the clip rides as a video-kind
  clip, the plan window IS the doc window; the compositor delivers the
  ride-through cut (5.23s vs the 5.2s contract) with the narration
  mixed; the storage key is the documented path.

## 3. Recorded tails

1. **The LLM scene planner** — art-directed arrangements (the topic +
   narration → objects/camera), the whiteboard planner's pattern.
2. **The Blender adapter** — an offline Blender exporter emitting the
   same Scene3D contract (the job/route/plan consumption is already
   adapter-ready).
3. **The 3D studio surface** — the doc editor + the clip preview in the
   Video tab (the API is live; the UI is the tail).
4. ** richer materials** — textures/HDRI environments beyond the color
   vocabulary; the contract's material block has the room.
