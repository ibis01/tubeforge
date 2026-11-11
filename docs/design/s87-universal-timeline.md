# S87 — the Universal Timeline contract (design + slices 0–5, CLOSED)

**Status:** design recorded; slices 0–5 implemented — the contract is
CLOSED at the code level (the version stamp; the v2 dual-write + the
overwrite guard; the compositor reads tracks[] — the composition plan +
parity; Whiteboard emits tracks[] — the engine joins the contract; the
legacy branches collapse — the pre-soak bricks + the recorded soak gate;
the §4.C acceptance battery — the close, `docs/audits/
s87-acceptance-battery-record.md`, 18/18 real-render checks, wired into
CI). The one recorded tail: the slice-4 soak gate (§13). Design target:
the S76 adoption decision §4.C
(`docs/audits/s76-openmontage-adoption-decision.md`), the third shared
quality system after the Visual Consistency Engine (S77–S83) and the Video
Critic (S84–S86).

**The question it answers:** "Can every TubeForge engine — today's and
every future one — describe its cut ONE way, so the compositor, the
Studio, the QC battery and the critic all read the same composition
truth?" Today the answer is no, and the Whiteboard engine is the proof.

## 0. The law this contract serves

The S75/S76 sequencing law (§8 of the adoption decision): **no engine
without the shared contracts — no isolated production pipelines.** The
anti-goal, recorded: not a collection of disconnected video generators.
The timeline contract is the composition half of that law (the VCE and
the critic are the quality half).

Inherited laws that survive into v2 unchanged:

1. **The timeline is a PROJECTION, never the source of truth** (timeline.ts
   design note 1). The video row (scenes, shotList, music*, render prefs)
   is the truth; the timeline column caches the assembled form. v2 keeps
   this: tracks are DERIVED from the row, the row stays editable, and a
   re-assemble can always rebuild the doc from the row.
2. **Measured WAV lengths win over estimates** (note 2): a scene's real
   read length is the duration anchor; word-count estimates are the
   fallback for unvoiced scenes, and the user's explicit trims are the
   only cuts the render makes.
3. **Tolerant read, strict write** (the TIMELINE_SCENE_FIELDS doctrine):
   parsing tolerates junk keys and legacy shapes; the writer emits
   EXACTLY the declared fields, nothing else.
4. **Fail open, never invent** (the S77 family §0.3): an unreadable doc is
   null, and the render recomputes inline — never a half-invented
   composition.

## 1. Current state (the seams, verified 2026-11-11)

| Seam | What it does today |
| --- | --- |
| `timeline.ts` | Scene-level projection: one `scenes[]` list, `source: ai \| stock \| slides`, per-scene timing/transition/audio/caption/shot/grade/chroma/pip, `renderPrefs` at the root. NO version stamp. |
| `assembleTimeline` | Builds the projection from the row (measured WAV durations when present, estimate fallback, Director-plan transitions, mood-resolved audio levels). |
| `parseTimeline` / `serializeTimeline` | Tolerant parse (null on unreadable, junk keys tolerated); strict write (`TIMELINE_SCENE_FIELDS` — the writer never stores what the type doesn't declare). |
| `render.ts` | Consumes the SAVED doc: per-scene settings by position (`docSceneSettings`), cut/blend windows (S36), per-scene mix levels (S2), caption style (S6), render prefs (S3). Branches per mode INTERNALLY: kenburns / animated / stock / slides (slides: the designed PNG IS the frame, always 9:16). |
| `clip-ops.ts` | Segment concat + per-boundary blend rounds (the transition engine). |
| `audiomix.ts` | Per-segment filter graphs from the doc's levels (voice/music/SFX/ambient + ducking). |
| Whiteboard | **A parallel pipeline.** Own job kind, own planner (`whiteboard-planner`), own render (`whiteboard/render.ts`), own Studio; `POST /render` REFUSES mode whiteboard ("the compositor does not render mode whiteboard"); ZERO references to the timeline doc. It lands `final.mp4` at the standard key so the player, QC battery and ship gate never learn it exists (S67's "peer MODE" law). |
| Timeline Studio | Edits the saved doc (trims, transitions, levels, captions) — gated to scene-format videos with scenes. |

The Whiteboard seam is the forcing case: the newest engine already
forked the composition truth. The next engine (character animation, 3D)
would fork it again — unless the contract lands first.

## 2. The target (S76 §4.C, distilled)

An **engine-neutral, multi-track, versioned composition contract**:

- **Tracks** of kind `video | image | whiteboard | 3d | character |
  audio | subtitle | graphics`, each an ordered clip list.
- **Clips** with an asset reference, timing (start/end on the
  composition clock), transform (geometry/motion) and effects.
- Integrated with `render.ts` (composition), `clip-ops.ts` (blending)
  and `audiomix.ts` (the mix graph) — one consumption path.
- **Versioned**: the doc carries a schema discriminator; a build that
  knows version N reads N and N−1, never guesses N+1.

The schema sketch in the audit is an ILLUSTRATIVE target — merging it
requires this migration design (this document).

## 3. The migration ladder (each slice independently shippable, CI 6/6)

**Slice 0 — the version stamp (S87, this stage).** Every assembled doc
emits `schema: 1`; `parseTimeline` treats an absent stamp as legacy v1
(the tolerant-read law) and an UNKNOWN stamp as unreadable (null → the
render recomputes inline — the documented fallback). The precondition
brick: no later slice can discriminate docs without it.

**Slice 1 — the v2 schema, dual-write.** `assembleTimeline` derives
`tracks[]` from the same row (visual track + audio track + subtitle
track) WHILE still emitting `scenes[]` (compat). `parseTimeline` reads
both. Round-trip pin: serialize → parse → serialize is identical. The
PUT overwrite guard lands here: a build must never blindly overwrite a
doc it could not read (the forward-compat hazard slice 0's null path
exposes — GET-null → Studio recompute → PUT would DESTROY a newer-doc;
the guard refuses the recompute-and-save when the stored doc carries an
unknown schema).

*Refinement (recorded 2026-11-11, from the slice-1 write-site survey):*
the timeline column has SIX write paths — assemble POST + PUT, the
scenes route's caption sync, and the studio clip/voice/pace routes —
all parse-modify-serialize cycles. A `tracks[]` field merely CARRIED
through those cycles goes STALE the moment a clip op edits scenes
(tracks were derived from the pre-edit scenes). Slice 1 therefore
derives tracks AT SERIALIZATION: `serializeTimeline` derives
`tracks = deriveTracks(scenes)` from the scenes it is handed, so no
write path can persist stale tracks (the projection law, enforced
structurally). The stamp becomes 2 at that point; slice 2's compositor
consumes the derived tracks, and later slices let ENGINES own their
tracks (whiteboard's planner, 3D) — at which point derivation-at-
serialize gives way to engine-authored tracks and a consistency check
(re-derive + compare) pins the handover. The overwrite guard needs a
shared seam (a `guardTimelineOverwrite` helper reading the RAW stored
stamp) called by every write path — six small call sites, one law.

**Slice 2 — the compositor reads tracks[].** `render.ts` dispatches on
track kind instead of the internal mode branch, behind the schema
discriminator (v1 docs keep the legacy path verbatim). Parity pins
first (same row → v1 path and v2 path produce identical cut points,
durations, blend boundaries — deterministic, ffmpeg-free), then a
real-render E2E on the parity fixtures.

**Slice 3 — Whiteboard emits tracks[].** The whiteboard planner maps
its frame plan onto whiteboard-kind clips; the compositor renders
whiteboard cuts through the shared path; the parallel job keeps its
planner but composes through the contract. S67's "peer MODE" law
EVOLVES by design: peer at the ENGINE level (own planner, own Studio),
unified at the CONTRACT level (one composition truth). The refusal in
`POST /render` is replaced by the shared path.

*Landed shape (recorded in §11):* the engine-authored tracks are a
DERIVE-AT-RENDER projection (never persisted in slice 3 — the frame plan
is the truth, the tracks are its contract form, exactly as the story
lane's writer re-derives tracks at serialization). Persisting
engine-authored tracks (a schema-3 doc where derivation-at-serialize
gives way to engine ownership + a re-derive/compare consistency check)
stays OPEN for the slice that needs a stored cross-engine doc — slice
5's acceptance battery decides whether it needs one.

**Slice 4 — the legacy branches collapse.** Slides/stock/ai sources map
onto track kinds; the `scenes[]` compat emission and the v1 render path
retire after a soak (the v1 docs in the wild age out with re-renders).

*Landed shape (recorded in §13):* the sources→kinds mapping itself
landed with slices 1–2 (deriveTracks + the plan's per-scene
kind/assetSource); slice 4 collapses the first render branch onto it
(the storyboard-art gate reads the per-scene KIND, mode as the no-plan
fallback) and pins the mixed-kind/geometry laws. The RETIREMENTS (the
scenes[] compat emission slimming to a settings-only schema 3; the v1
planFromScenes read + the mode fallbacks) are SOAK-GATED by the slice's
own text — the gate is recorded in §13 with its precondition.

**Slice 5 — the acceptance close.** The §4.C acceptance battery runs as
CI: cross-engine rendering (whiteboard + stock + generated clips
through the contract), sync (narration/music/SFX/subtitles), transition
timing preservation, and the round-trip identity (a saved timeline
reopens and renders identically).

*Landed (recorded in §15 + docs/audits/s87-acceptance-battery-record.md):*
`scripts/s87-acceptance-battery.mts` — real renders through BOTH engine
lanes on tiny $0 fixtures, 18/18 mechanical checks, wired into the CI
E2E job; the first run CAUGHT a real engine bug (the mixed-VO assembly
crash), fixed in the same slice.

## 4. Acceptance tests (S76 §4.C, the close condition)

1. Whiteboard scenes, stock footage and generated clips all render
   through the contract.
2. Narration, music, SFX and subtitles stay synchronized.
3. Transitions preserve exact timing.
4. A saved timeline reopens and renders identically.
5. Every future engine can produce compatible timeline assets.

Unit tests never claim visual quality: the battery pairs deterministic
pins with real output artifacts and human review (the S76 standard).

## 5. What slice 0 changed (code)

- `AssembledTimeline` gains `schema: 1`; `assembleTimeline` stamps it;
  `serializeTimeline` emits it first; the assemble route's PUT site
  stamps the doc it rebuilds.
- `parseTimeline`: absent stamp → parsed as v1 (legacy docs predate the
  field — the tolerant-read law); stamp `1` → parsed; any other stamp →
  null (this build does not know v2; the render recomputes inline, the
  Studio re-derives via POST — and the PUT overwrite guard that makes
  that safe is slice 1's first brick, recorded above).
- `AssembledTimelineDTO` (client) gains optional `schema?: 1` —
  additive, the client never discriminates on it.

## 6. Pinned-by-tests contract (slice 0)

`serializeTimeline` emits `schema: 1` and the declared fields only ·
`parseTimeline` round-trips a serialized doc with the stamp intact · a
legacy doc (no stamp) parses as v1, junk keys tolerated · an unknown
stamp (`2`, garbage) is null — never a guessed parse · `assembleTimeline`
stamps every doc it builds.

*(Evolved at slice 1: the writer's stamp is now 2, the unknown-stamp pin
uses 3, and the pins below extend the battery — the slice-0 pins kept
their shape.)*

## 7. What slice 1 changed (code)

- `timeline.ts` gains the v2 track vocabulary: `TimelineTrackKind`
  (video/image/whiteboard/3d/character/audio/subtitle/graphics),
  `TimelineClip` (deterministic id, scene linkage, composition-clock
  timing, boundary transitions, asset reference) and `TimelineTrack`.
- **Derive-at-serialization (the refinement, enforced structurally):**
  `serializeTimeline` emits `tracks = deriveTracks(scenes)` from the
  scenes it is handed — the in-memory `.tracks` field is never read by
  the writer, so NO write path can persist a stale projection (a carried
  copy would go stale the moment a clip op edited scenes). The stamp is
  2 at every write; the writer owns the contract version.
- `deriveTracks` (pure, deterministic): a VISUAL track — one clip per
  scene, kind `image` when the source is slides (the designed PNG IS the
  frame), `video` otherwise, timing/transitions/asset mirroring the
  scene; an AUDIO track — one clip per scene over the measured window
  plus ONE doc-spanning music-bed clip when the doc says the music is on
  (sceneIndex null: the bed is not scene-bound); a SUBTITLE track — clips
  only where the doc carries a caption block (the S43 seeding rule).
  Per-scene mix levels / creative overrides stay in the scenes list (the
  S2 doctrine — clips reference scenes by index; duplicating levels into
  clips would fork the truth slice 2 consumes). Empty scenes → the three
  tracks with empty clip lists (shape-stable for the compositor).
- `parseTimeline` reads stamps 1 and 2 (a build knows N and N−1) plus
  absent = legacy v1; any OTHER stamp stays null — never a guessed parse.
  The parsed object's tracks are ALWAYS re-derived from the parsed
  scenes: a stored (possibly junk) tracks copy never enters memory, and
  the round-trip holds by construction.
- **The overwrite guard:** `guardTimelineOverwrite(storedRaw)` reads the
  RAW stored JSON (never the parsed doc — the parse of an unknown stamp
  is null and loses the stamp) and refuses when the stored stamp is not
  absent/1/2. Corrupt JSON / non-object bodies are not newer docs — the
  fail-open law applies. `TIMELINE_OVERWRITE_ERROR` is the one 409 body
  every guarded route answers with; it names DELETE /assemble, the
  human's explicit escape hatch (the one UNguarded write — a deliberate
  decision, not a blind clobber).
- Six write sites, one law: assemble POST + PUT (409 before any work),
  the scenes route's caption sync (the doc write skipped — the row's
  caption flag already carries the edit), studio clip/voice/pace (409
  BEFORE perform* — a re-voice must never spend paid TTS into a refused
  write).
- `types.ts`: `AssembledTimelineDTO.schema?: 1 | 2` + the structural
  `TimelineTrackDTO` mirror (optional — the Studio still never
  discriminates on it; slice 2 consumes it).

## 8. Pinned-by-tests contract (slice 1)

`serializeTimeline` emits `schema: 2` first and the derived tracks ride
the doc · serialize(parse(serialize(x))) is byte-identical · THE
refinement pin: a doc with a deliberately-stale carried `.tracks`
serializes to a FRESH derivation — the stale marker never reaches disk ·
`deriveTracks` shape pins (empty scenes → three empty tracks; visual/
audio/subtitle kinds; `s{n}` / `a-s{n}` / `a-music` / `sub-s{n}` ids;
the bed spans the doc and is not scene-bound; caption timing wins,
absent caption timing falls back to the scene window; junk timings
become 0, never NaN) · slides scenes project onto the image kind ·
parse re-derives the projection (junk stored tracks dropped, tolerant
read) · `guardTimelineOverwrite` truth table (absent/empty/legacy/own-v2/
corrupt/non-object → writable; stamp 3 / garbage stamp → refused, the
refusal echoes the stored stamp) · the 409 names DELETE /assemble.

## 9. What slice 2 changed (code)

- New `src/lib/tubeforge/composition-plan.ts` — the compositor's plan from
  the contract, pure and deterministic: `CompositionPlanScene` (position,
  sceneIndex, visual kind, asset source, window, boundary transitionIn) and
  `CompositionPlan { origin: "tracks" | "scenes", scenes, totalSec }`.
  - `planFromTracks` — the v2 read: the VISUAL track's clips, aligned BY
    POSITION to the row's scene count (the sceneOrder contract), the same
    all-or-nothing law docSceneSettings applies. ANY misalignment (wrong
    clip count, non-finite or non-positive window) refuses the whole read
    → the caller falls back (fail-open — a junk tracks copy never blocks
    a render, it just demotes the read).
  - `planFromScenes` — the v1 read kept verbatim: durations from the
    scenes' own durationSec field, kinds mapped from source ("slides" →
    image), the pre-S87 feed shape.
  - `compositionPlan` — the dispatcher: schema 2 → tracks ?? scenes;
    schema 1 → scenes; null doc → null (the render's own WAV defaults).
- `video-jobs.ts`: the timeline consumption block derives the plan
  (`compositionPlan(parseTimeline(...), scenes.length)`) and feeds
  `sceneDurationsSec` from it (origin "tracks" for schema-2 docs) while
  `docSceneSettings` keeps owning levels/captions/creative in both paths;
  the plan rides `RenderJobOptions.timelinePlan` into the render.
- `render.ts` — the dispatch cutover, behind the discriminator:
  - `RenderOptions.timelinePlan` (null/absent = the legacy mode-keyed path
    verbatim — v1 docs, no-doc renders, "render without timeline", and the
    two script callers).
  - `buildSegment` dispatches on the per-scene contract facts:
    `visualKind === "image"` takes the slide-deck path (the designed PNG IS
    the frame, chroma/pip off), `assetSource === "stock"` the footage path
    (the on-disk guard stays belt-and-braces); the mode remains the
    fallback inside each branch.
  - `renderVideo` derives `sceneKindOf` / `assetSourceOf` / `allImage`
    from the plan (mode fallback built in) and reads them at the geometry
    seam (9:16 for all-image renders), the motion-plans overlay (image
    scenes take the slide plan; video scenes keep the movement planning —
    no paid camera pass is computed for all-image docs), the deck-design
    gate, the caption-style variant, and the boundary loop (the plan's
    transitionIn with the docScenes fallback, sanitized identically).
  - NOT moved (recorded): the liveliness channel selection (kenburns/i2v/
    stock are PRODUCTION channels, not composition kinds — slice 3
    revisits with a real engine at the table) and the `mode === "kenburns"`
    doc-camera-keys gate.
- Parity is the gate, exactly as the ladder demanded: same row → the v1
  path and the v2 path produce identical durations, cumulative starts,
  boundary styles, expected cut points, blend windows and black-dip
  windows — deterministic, ffmpeg-free. The honest-geometry divergence is
  pinned as the ONE intentional difference: a client-sent doc whose
  durationSec field disagrees with its own windows gets the WINDOW (the
  geometry), never the lying field.

## 10. Pinned-by-tests contract (slice 2)

planFromTracks ≡ planFromScenes on every doc the engines write (kenburns /
stock / slides, mixed assetSource included) — every plan scene field and
the clock total · the render-clock parity: identical cut points, blend
windows, black-dip windows from both reads' durations + renderVideo-style
boundary settings · the plan's transitionIn ≡ docSceneSettings' (either
boundary feed is the same after the catalog check) · the origin ledger:
schema-2 → "tracks", v1 → "scenes", junk tracks of every flavor (wrong
clip count, NaN window, zero window, missing visual track) → the scenes
fallback, never a crash; scene-count mismatch → null (all-or-nothing);
no doc → null · the honest-geometry pin: a lying durationSec field loses
to the window. (Fixture discipline recorded in the pin: parseTimeline
re-derives tracks, so junk-tracks fixtures are built on the in-memory doc
— the slice-3+ shape where engines own their tracks.)

## 11. What slice 3 changed (code)

- New `src/lib/tubeforge/whiteboard/tracks.ts` — the engine's frame plan
  in the contract's grammar, PURE and deterministic:
  - `framePlanClock(sceneMs, fps)` — THE one derivation of the shared
    frame-quantized clock: per scene `frames = frameCount(ms, fps)`, the
    delivered second is exactly `frames/fps` (the encode's own `-t`
    math), windows are the running exact cursor rounded to the 2-dp
    composition clock (contiguous by construction — each edge is one
    rounded value, so clip[i].endSec === clip[i+1].startSec), and the
    total is the exact cursor rounded once. Junk ms (non-finite/≤0)
    refuses loudly — the estimator clamps every scene, so junk input is
    an engine bug, never a user state.
  - `whiteboardTracks(project, sceneMs, { voSceneIds, musicOn })` — the
    VISUAL track (kind "whiteboard", one clip per scene over its window,
    `asset: null` — the frame is DRAWN, transitions null — board
    boundaries are the concat's hard cuts), the AUDIO track (VO slot
    clips ONLY where a WAV actually plays, over the same window — the
    apad law; plus the doc-spanning `a-music` bed clip when the bed is
    on), and an EMPTY subtitle track (whiteboard narration is drawn, not
    captioned — shape-stable). Clip ids are positional (`wb{i}` /
    `a-wb{i}`); the row linkage is honest: scaffold ids `scene-N` link
    back to the story row, hand-authored ids carry null (position still
    orders the clip).
- `composition-plan.ts`: `PlanVisualKind` gains `"whiteboard"` and
  `planFromTracks` passes it through; the parameter widens to the
  structural `{ tracks }` carrier — engine-authored tracks have NO doc
  (the whiteboard lane hands its tracks directly; an AssembledTimeline
  satisfies the same shape). One reader, every engine.
- `whiteboard/render.ts` — COMPOSE THROUGH THE CONTRACT: the render
  derives clock + tracks + plan right after the budget wall, the scene
  loop reads its frames/delivered seconds from the shared clock (the
  numbers identical to the old inline math BY CONSTRUCTION — both are
  frameCount), the assembly total reads the clock with a contract assert
  (a future edit that diverges the loop from the clock fails the render
  instead of shipping a desynced projection), and the result gains
  `{ tracks, plan }` (the contract artifacts slices 4–5 consume — the
  legacy collapse + the acceptance battery).
- `video-jobs.ts`: the S67 refusal in `runRenderJob` is RETIRED — a
  whiteboard video reaching the compositor entry (a stale durable replay
  or a bypassed caller) DELEGATES to `runWhiteboardJob`, which quietly
  no-ops when the mode flipped back (the symmetric mode-drift law).
- `POST /render` — the shared path: a whiteboard video routes to its
  engine lane BEFORE the story-lane gates (no storyboard-art gate — the
  scaffold doesn't need it; no hasVoiceover gate — silent drafts are
  legal; no credit gate — the engine renders natively at $0), mirroring
  the lane's own validation (the merged library, the validator's
  verbatim errors) and enqueuing the SAME `whiteboard` job kind the
  Whiteboard Studio's route enqueues (crash-recovery-native, the
  full-render idempotence wall applies). Scene previews stay on the
  Studio's own route. `GET /render` now sees both lanes (a whiteboard
  video reports the `whiteboard` job kind's running state, progress and
  error).
- `whiteboard/render/route.ts` — the VO interlock, safety parity: this
  lane reads the SAME per-scene WAVs, so a concurrent voiceover regen
  gets the same 409 the story lane answers (the mixed-narration hazard,
  seen live once).
- `render.ts` — the routing wall: a whiteboard-kind plan reaching the
  compositor's segment builders throws BEFORE any paid motion planning
  or geometry work (peer ENGINE, shared CONTRACT — the compositor never
  rasterizes boards).
- NOT moved (recorded): the QC battery's cut lens for whiteboard
  finals — today "unmeasured" (no story timeline doc on a whiteboard
  row); making it read the whiteboard windows is REAL, but whiteboard
  scene changes share the board's visual continuity, so a hard cut
  between two boards may not register on a lens calibrated on cinematic
  full-frame changes — slice 5's battery (deterministic pins + real
  artifacts + human review) is the honest place to decide. Persisting
  engine-authored tracks (schema 3) stays open for the same reason.

## 12. Pinned-by-tests contract (slice 3)

framePlanClock: windows ≡ delivered frames (96f/24fps = 4.000s from
4001ms — the estimator's ms is the plan, the frames are the delivery) ·
contiguity survives 2-dp rounding (133/24 = 5.5416… → edges 5.54/5.54,
total 9.54 — one rounded value per edge, the exact cursor rounded once) ·
junk ms (NaN/0/negative/Infinity) refuses loudly · whiteboardTracks: the
three kinds (whiteboard/audio/subtitle), positional ids (`wb0`, `a-wb1`,
`a-music`), asset null, transitions null, scaffold `scene-N` → row
linkage N, hand-authored id → null, VO slots only where a WAV plays and
over the SAME window as the visual clip, the bed spans [0, total] only
when on, silent drafts carry no audio clips, empty projects → three
empty tracks, ms/project count mismatch refuses loudly · planFromTracks
reads engine tracks through the SAME reader (kind passes through, origin
"tracks", count mismatch → null all-or-nothing, no-linkage → positional
fallback) · THE two-clock pin: estimateProjectFrames → tracks → plan —
every window within a centisecond of frameCount(ms)/fps, the plan total
within a centisecond of the assembly total, deterministic byte-identical
re-derivation.

## 13. What slice 4 changed (code) — the pre-soak bricks + the soak gate

- **The first legacy branch collapses**: renderVideo's storyboard-art
  gate reads the composition plan's per-scene KIND (`sceneKindOf(i) !==
  "image"` → art required) instead of the video-level mode proxy, with
  the mode as the no-plan fallback (v1 docs, "render without timeline",
  no-doc renders). Behavior-neutral for every doc the engines write (the
  slice-2 parity pins: slides → image everywhere, kenburns/animated/
  stock → video everywhere — and sliced preview renders stay position-
  aligned, the plan's prefix maps to the sliced list); a mixed doc (no
  engine writes one yet) gets the per-scene truth instead of the
  video-level guess. The ROUTE-level `!video.hasStoryboard` pre-check
  stays mode-keyed — it is a UX pre-flight without the doc; the job's
  gate is the enforcement and now carries the contract truth.
- **NOT collapsed (recorded, with reasons)**:
  - The liveliness channel selection + the `mode === "kenburns"`
    cameraKeys gate — PRODUCTION-channel questions (which scenes play
    the Ken Burns camera, which play footage or i2v), not composition
    facts. Slice 3 settled the engine-level boundary (kind decides WHO
    executes); the channel choice inside the compositor stays
    mode/selector-keyed by design. The open sub-question (stock-mode
    scenes falling back to Ken Burns do not honor the doc's cameraKeys
    today) is recorded for the soak window, not changed here.
  - The motion-plans base list's mode-keyed branches — the slice-2
    per-scene kind overlay already carries the contract truth for
    plan-carrying renders; the base list serves the no-plan fallback.
- **THE SOAK GATE (the slice's own retirement precondition, recorded)**:
  what retires once the soak passes —
  1. the `scenes[]` compat EMISSION slims to a settings-only schema 3
     (tracks own the composition facts; scenes keep levels/captions/
     creative per the S2 doctrine; the handover carries a re-derive +
     compare consistency check so a stale settings list cannot survive
     the migration), and
  2. the v1 render path's remaining mode fallbacks (planFromScenes stays
     forever — a build reads N and N−1; what retires is the FALLBACK
     only no-plan renders legitimately use, shrinking to exactly those).
  The precondition: slices 0–3 landed 2026-11-11; retirement is safe
  after one production soak window (≥14 days) with ZERO origin-"scenes"
  renders on v1 docs in the wild (operator-verified — the renders that
  still hit the fallback are the no-doc/ignore-timeline ones, which the
  retirement does not touch). The unknown-stamp refusal + the overwrite
  guard (slice 1) make the migration itself forward-safe: a newer build
  never destroys an older doc and vice versa.

## 14. Pinned-by-tests contract (slice 4)

KIND COMPLETENESS — every engine-written doc (kenburns/animated/stock/
slides, mixed assetSource included) carries kind + assetSource on EVERY
plan scene: the mode fallback is provably unreachable for aligned docs
(the retirement precondition) · the MIXED-kind law — a doc mixing
slides-source and ai scenes reads per-scene kinds [image, video] with
per-scene assetSources, and the collapsed art gate's predicate demands
art only where kind ≠ image (the mode proxy demanded it everywhere) ·
the geometry law — all-image → the deck geometry, ANY video in the mix →
the row's aspect (pinned before any engine writes a mixed doc) · the
channel boundary — clips never carry cameraKeys (creative settings stay
in the scenes list, the S2 doctrine; the channel gate reads them there,
mode-keyed on purpose).

## 15. What slice 5 changed (code) — the acceptance close

- New `scripts/s87-acceptance-battery.mts` — the §4.C battery, the S76
  standard's artifacts half (the deterministic pins live in the unit
  suite, slices 1–4): REAL renders through BOTH engine lanes on tiny
  $0 fixtures, mechanically held to the contract — the full condition
  mapping is `docs/audits/s87-acceptance-battery-record.md`.
  - Part A (the engine lane): the real planner scaffolds a 3-scene
    640×360@24 project mixing every duration precedence (explicit /
    VO-measured / narration-estimated) and PARTIAL voice coverage; a
    real chromium render + synthesized VO slot + bed; the checks hold
    the per-scene encodes and the concat total to the frame-quantized
    plan windows, the mixed audio presence, the byte-identical
    re-derivation, and the row linkages through the shared reader.
  - Part B (the compositor lane): a real kenburns render over a
    schema-2 doc (measured WAV windows + a studio-style "cut" boundary
    edit — the per-scene pick's seniority is itself checked); the plan
    feed drives durations + kinds; the checks hold the hard cut EXACTLY
    on the contract boundary, the delivered total to the plan total,
    the byte-identical save/reopen round-trip, and the narration audio.
  - Wired into CI as a step of the E2E job (chromium + ffmpeg live
    there; ~20 s on the fixtures; zero AI spend).
- **The find, fixed in the same slice** (`whiteboard/render.ts`): the
  battery's first run crashed at final assembly on the mixed-VO shape —
  the concat demuxer is stream-homogeneous, and a silent scene file
  ahead of a voiced one left `[0:a]` matching no streams at the amix
  seam. Fix: when ANY scene carries VO, every scene file carries an
  audio stream (VO-less scenes fill with `anullsrc` under the same
  apad/-t bounds; a fully silent project keeps the video-only shape).
  A real production shape — a user voicing some scenes — previously
  crashed the whiteboard render.

## 16. Pinned-by-the-battery contract (slice 5)

18/18 real-render checks (the receipt in the audit record): the engine's
returned plan IS the tracks read and the tracks re-derive byte-identically
· every per-scene encode within ±0.06 s of its contract window · the
concat total within ±0.25 s of the contract total · the mixed audio (VO
slot + bed) present in the final · the VO scene keeps its narration ·
the row linkages survive the shared reader · the saved doc re-serializes
byte-identically (1883 bytes) · the compositor reads origin "tracks" ·
the studio's boundary edit rides the tracks · the hard cut EXACTLY on
the boundary · the delivered total ≡ the plan total · the render's own
clock ≡ the file · the narration audio present · the row geometry held.
