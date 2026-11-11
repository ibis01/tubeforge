# S87 — the Universal Timeline contract (design + slice 0)

**Status:** design recorded; slice 0 (the version stamp) implemented this
stage. Design target: the S76 adoption decision §4.C
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

**Slice 4 — the legacy branches collapse.** Slides/stock/ai sources map
onto track kinds; the `scenes[]` compat emission and the v1 render path
retire after a soak (the v1 docs in the wild age out with re-renders).

**Slice 5 — the acceptance close.** The §4.C acceptance battery runs as
CI: cross-engine rendering (whiteboard + stock + generated clips
through the contract), sync (narration/music/SFX/subtitles), transition
timing preservation, and the round-trip identity (a saved timeline
reopens and renders identically).

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
