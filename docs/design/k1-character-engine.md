# K1 — the 2D character engine (the file-by-file execution plan)

**Status:** SLICE 1 LANDED (this branch) — the pure substrate + the adapter live-shape proof. Slices 2–5 are specced below with their files, laws, pins and rollback. This document executes S120 §6's K1 stage spec (docs/design/s120-2d-animation-roadmap.md §6) — it does not replace it; it decomposes it into slices small enough to land green one at a time, the way the whiteboard's W3–W7 landed.

**Objective:** characters that actually move — poses, gestures, mouth beats on narration, walk cycles — deterministically and natively, inside the ONE shared renderer. The honesty law binds every slice: the rig animates REAL decomposed part art, and the narration-sync is scope-claimed as **beat-sync, not phoneme lip-sync**, in every doc and UI string (S120 §6 and the S93 honesty law).

**Laws every slice keeps (inherited, restated once):**

| Law | Meaning for K1 |
| --- | --- |
| No second renderer | Rig frames render through the same chromium-screenshot → ffmpeg-encode path as whiteboard/graphics; the rig is a segment builder, not a pipeline |
| One source of motion truth | `poseAt`/`mouthAt` are pure functions of (rig, timeline, tMs); editor preview AND final render call the same ones (the `APPLY_FRAME_FN` pattern) |
| Determinism (S64) | Frame N is a pure function of (project, library, N); pose/mouth pins are byte-identical on re-run; a NaN clock reads closed, never NaN |
| Compile-to-events | The pose timeline and mouth schedule project onto the frozen `AnimationEvent` grammar / S87 `tracks[]` — `characterTracks` follows `whiteboard/tracks.ts`; the grammar does not grow |
| Additive parse | A character with no `rigDoc` renders byte-identically through the S93 still-portrait path; `Character.rigDoc` is a nullable JSON column |
| One classifier, two consumers | Gesture beats reuse `beat-plan.ts`'s sentence classifier (slice 2 exports it — it is module-private today) instead of duplicating it |
| Native-first | K1-native is the primary lane; the i2v lane (pose sheet + rig-aware prompts) stays the escalation, consistency re-checked by the S83 VCE |
| Every unbounded dimension has a named wall | Rig parts ≤ 64, poses ≤ 64, syllables per word ≤ 4 (8 beats), timeline keys bounded by the frame budget accounting |

---

## Slice 1 — the pure substrate (LANDED in this branch)

No fs, no DB, no renderer — the P2 precedent: substrate first, consumers never before the contract is pinned.

| File | What it carries | Pins |
| --- | --- | --- |
| `src/lib/tubeforge/characters/rig2d.ts` | The versioned `CharacterRigDoc` contract: `RigPart { id, svgRef, z, pivot, parent?, rest }`, `RigPose { id, name, joints }` (channels are OFFSETS FROM REST — rotateDeg/x/y additive, scale multiplicative), the slot vocabulary (`mouthPartId`/`armPartId`/`browPartId` — 5 mouth shapes, arm 3-way), `validateRigDoc` (referential integrity, pivot sanity, parent cycles, the 64/64 walls — every refusal names its reason) | unit suite: contract validates; 14 refusal shapes; slot round-trips; walls hold |
| `src/lib/tubeforge/characters/rig-frame.ts` | `poseAt(rig, timeline, tMs)` — clamped, eased (the shared `anim/easing` table, segment ease on the destination key), rest-filled (every part in every frame, never NaN), byte-identical determinism; `buildMouthBeats`/`mouthAt` — the beat-sync schedule: each measured word span sliced into 2 × syllables open/closed beats, the open shape always "open" (wide/oh/smile stay authored pose slots), gaps read closed; `countSyllables` (vowel groups, min 1, cap 4); `wordSpansFromAsr` (the measured rung's seconds → integer ms) | unit suite: holds, exact eased midpoint, rest-fill, NaN refusals, beats inside word spans (the W4 tolerance pin), syllable pins, the monotone-stream refusals, honesty law (no shape invented from text) |
| `scripts/test-voicestudio-adapter.mts` (+ `npm run test:voicestudio`) | The VoiceStudio adapter LIVE-SHAPE proof: the REAL `ttsSynthesize` + `asrTranscribeDetailed` through the real `providerFetch` wire path against a loopback VoiceStudio-shaped service — the audited speech contract (`model/input/voice/speed/response_format=wav`, voice verbatim), the audited transcription contract (`verbose_json` + `timestamp_granularities[]=word`, flat `words[]`), and the measured words flowing into the K1 mouth schedule with NO re-alignment | the script's own battery (RIFF header, contract fields, five spans, beats inside spans) |
| `docs/design/k1-character-engine.md` | This document — the slice map below is the file-by-file plan the remaining slices execute | — |

**Honest defer gates (not claimed here):** word-timing accuracy vs the whisperx reference and real synthesis quality need a running VoiceStudio GPU instance (the operator's lane — recorded in S121's acceptance table); identity-floor ≥ 80 via VCE needs real rendered frames (slice 3).

---

## Slice 2 — the planner: narration and art in, pose timeline out

| File | What it does | Laws it keeps | Pins |
| --- | --- | --- | --- |
| `src/lib/tubeforge/whiteboard/beat-plan.ts` (MODIFIED — one line) | Export `classifySentence` (module-private today) — the one classifier, two consumers (whiteboard beats + K1 gestures) | no behavior change; the export is additive | existing beat pins stay green byte-for-byte |
| `src/lib/tubeforge/characters/rig-director.ts` (NEW) | `planPoseTimeline(rig, beats, opts)` — narration beats + pose sheet → `PoseTimeline`: setup → welcoming pose, action verbs → gesture beats, emphasis → point/pose on the claim; mouth schedule from the measured word spans when present (the S121 measured rung), silence-ladder fallback when not | consumes `classifySentence`, never re-classifies; emits only validated pose ids; advisory until an approval checkpoint flips state (AI-suggests-human-approves) | determinism; every emitted pose id exists; keys ascend; the fallback path is byte-identical to the estimator rung |
| `src/lib/tubeforge/characters.ts` (MODIFIED) | The part-decomposition prompt for the portrait flow (generate layered parts against the slot vocabulary, not one flat PNG); pose-sheet generation targets rig slots (`arm-l/raise` … `mouth-oh`) | the slot vocabulary from rig2d is THE id space — the prompt names it, the validator enforces it | prompt-shape pin; generated part ids validate against `validateRigDoc` |
| `prisma/schema.prisma` (MODIFIED) | `Character.rigDoc Json?`, `Character.parts Json?` (additive, SQLite + PG; JSON columns only — no enum migration) | nullable, ignored when absent → S93 path byte-identical | additive-parse round-trip pin |
| API: `src/app/api/characters/[id]/rig/route.ts` (GET/PUT, 409-with-current on advisory rev), `.../rig/auto/route.ts` (the planner pass) | Thin routes over the pure laws; refusals serialize the validator's named reasons | use api not server actions; the PUT validates through `validateRigDoc` — one law | route battery: 400 bodies carry the named reason; 409 carries the current doc |

**Rollback:** the routes return 501 and the planner is unused; the JSON columns are nullable and ignored; `classifySentence` stays exported (harmless).

---

## Slice 3 — the renderer: rig frames through the ONE pipeline

| File | What it does | Laws it keeps | Pins |
| --- | --- | --- | --- |
| `src/lib/tubeforge/characters/rig-render.ts` (NEW) | The frame loop composing rig layers into the scene SVG: `svg.ts` sanitize/parse reuse, layer z-order, the parent-chain transform composition (the renderer's WORLD-transform law — local states from `poseAt` compose down the parent chain: rotation accumulates, the child's anchor rides the parent's transform, scale multiplies), the mouth slot's visibility law (exactly ONE `mouth-*` part draws — the selected shape; no selection → `mouth-closed`), the character canvas into the shared frame plan | `APPLY_FRAME_FN` discipline; frame budget accounting (the ANIM_FRAME_BUDGET wall); per-frame payload additive wire format | world-compose numeric pins (a rotated parent moves the child's anchor by the pinned numbers); mouth visibility; frame budget; determinism hashes |
| `src/lib/tubeforge/characters/tracks.ts` (NEW) | `characterTracks(...)` → S87 `tracks[]` projection (kind `"character"` — the seat `types.ts` already reserved), one clip per scene, frame-quantized contiguous edges (the `tracks.ts` pattern) | the projection is derived, never the truth; consistency check rides the S87 law | tracks parity pin (`plan.totalSec == Σ deliveredSec` pattern) |
| `src/lib/tubeforge/render-lane.ts` + `src/lib/tubeforge/types.ts` (MODIFIED) | The character lane joins `RENDER_MODES`/`resolveRenderLane` (peer-lane law) — the lockstep law: both ledgers move in the SAME slice (the S88 CI lesson) | lane refusal when absent; seniority ladder: explicit rig timeline > S93 breath > auto (the ladder pattern is preserved) | lane decision pins; the S93 fallback byte-identity on clean projects |
| `src/lib/tubeforge/liveliness.ts` + `src/lib/tubeforge/composition-plan.ts` (MODIFIED) | Channel precedence gains the native-rig channel for cast scenes (between `kenburns` and `i2v` — native-first); `PlanVisualKind` gains `"character"` for mixed videos (with Stage X) | precedence is total and pinned | precedence table pin |
| QC | Identity floor ≥ 80 via the S83 VCE on rendered rig frames; the existing 13-check battery rides unchanged | a check that cannot run reports "unmeasured", never clean (the QC law) | the identity gate on a real render |

**Rollback:** the lane is removed from `RENDER_MODES` → refusal; `rigDoc` absent → S93 path byte-identical.

---

## Slice 4 — the studio surface

| File | What it does | Pins |
| --- | --- | --- |
| Character surfaces (the existing portrait/poses flow) + the rig editor | Part list (ids, z, pivots from the decomposition), pose editor (offset channels + the slot vocabulary), pose-timeline strip (the whiteboard-studio timing-strip pattern), mouth-beat preview against the measured spans | editor round-trip of every new field; the UI copy says "beat-sync", never "lip-sync" (the honesty law, verbatim) |

**Rollback:** the editor hides when no `rigDoc` exists — no surface change for existing characters.

---

## Slice 5 — the proof: smoke + blind rubric

| File | What it does |
| --- | --- |
| `scripts/k1-rig-smoke.mts` | The S93 smoke pattern extended: a walk cycle renders (the `anim/gait` phase riding world distance), mouth beats land on the measured anchors, identity VCE ≥ 80 on rig frames, frame budget holds, determinism hashes identical |
| `docs/audits/k1-blind-rubric.md` | The W1 protocol verbatim (shuffled kits, ≥ 3 scorers, whole numbers) for the character lane's perceptual rows |

---

## Wire contracts (frozen by slice 1's pins)

```jsonc
// CharacterRigDoc (version 1) — channels are OFFSETS FROM REST
{
  "version": 1,
  "parts": [
    { "id": "torso", "svgRef": "torso.svg", "z": 0, "pivot": { "x": 100, "y": 120 }, "rest": { "x": 100, "y": 120 } },
    { "id": "arm-l", "svgRef": "arm-l.svg", "z": 1, "pivot": { "x": 80, "y": 110 }, "parent": "torso", "rest": { "x": 80, "y": 110, "rotateDeg": 10 } },
    { "id": "mouth-open", "svgRef": "mouth-open.svg", "z": 5, "pivot": { "x": 100, "y": 90 }, "rest": { "x": 100, "y": 90 } },
    { "id": "mouth-closed", "svgRef": "mouth-closed.svg", "z": 5, "pivot": { "x": 100, "y": 90 }, "rest": { "x": 100, "y": 90 } }
  ],
  "poses": [
    { "id": "wave", "name": "Wave", "joints": { "arm-l": { "rotateDeg": -80 } } }
  ]
}

// PoseTimeline — the segment's ease is named on the DESTINATION key
{ "keys": [ { "tMs": 0, "poseId": "rest" }, { "tMs": 2000, "poseId": "wave", "ease": "ease-in-out" } ] }

// MouthBeat[] — built from the MEASURED word spans (ms), open/closed only
{ "startMs": 0, "endMs": 80, "shape": "open" }
```

## The measured rung, end-to-end (who consumes what)

```
VoiceStudio /v1/audio/transcriptions (whisperx, verbose_json + word granularity)
        │  providers/asr.ts asrTranscribeDetailed   ← the live-shape proof (scripts/test-voicestudio-adapter.mts)
        ▼
AsrWord[] (seconds)
        │  captions.ts measuredAlignment            ← caption cues (S121 P1)
        │  whiteboard/voice-anchors.ts              ← the whiteboard's voice anchors (W4/S121)
        │  characters/rig-frame.ts wordSpansFromAsr ← the K1 mouth beats (slice 1)
        ▼
ONE measured stream, three consumers, no re-alignment — the one-alignment law holds.
```

## What K1 does NOT do (explicit non-goals)

- No phoneme lip-sync claim anywhere — the mouth set is five shapes and the schedule is beat-sync (the honesty law, S120 §6 + S93).
- No second renderer, no canvas/WebGL pipeline, no Lottie/Rive import in v1 (an adapter can compile INTO the grammar later, the G1 note).
- No skeletal 3D — `docs/design/s94-3d-engine.md` is a separate stage; `anim/ik.ts` serves the 2D two-bone poses.
- No voice licensing shortcuts: any VoiceStudio engine riding a K1 scene's narration passes the fail-closed license table (`providers/model-license-policy.ts`) — the NC default engine never reaches a paying render by silence.
