# S91 — The living production board (design + v1)

**Status:** v1 implemented — the pure derivation module
(`production-board.ts`, 4 pins), the composed snapshot route
(`GET /api/videos/[id]/board`), the studio card (`production-board.tsx`,
mounted in the video detail dialog), unit 459/455→459 green 2026-11-11.
Spec source: the S76 adoption decision §5 P4 ("Expose production stages,
script and storyboard, asset-generation progress, provider decisions,
costs, approval checkpoints and production history through the project
studio, backed by the existing database and job system" — Backlot is the
UX reference, studied not copied).

**The question it answers:** "Where is this video, what needs me, and what
did it cost?" — in one glance, inside the project studio, with zero new
tables and zero new pipelines.

## 0. The laws

1. **Backed by the existing database and job system.** The board READS:
   the Video row's stage flags, parseScenes, storage stats (scene art,
   the critic report), the in-memory job snapshot, the Activity table,
   UsageRecords. It introduces no new pipeline, no new state, no second
   source of truth — if the board disagrees with a stage route, the board
   is wrong by construction.
2. **Running outranks done.** A job in flight is the live truth even over
   finished artifacts (a re-render in flight shows "running", not the
   stale "done" artifact).
3. **Partial is first-class.** Art 3/8 is `partial 3/8`, never rounded up;
   a preview-only render is its own state; a Short without a publish is
   partial work.
4. **Checkpoints claim exactly their evidence.** A QC report nobody
   reviewed is "pending", a proposed Director plan is "attention"
   (it needs the human), absent evidence is "n/a" — never alarming, never
   green. The five gates: Director plan (approved/proposed/dismissed/
   never), the QC ship gate (human override > report-ready > not run),
   narration verify, continuity, the Video Critic verdict
   (ship/hold/insufficient-evidence).
5. **Costs say their scope.** Usage metering is organization-scoped today
   (UsageRecord has no videoId); the board shows the org's 30-day context
   (total, calls, failures, top capability×provider lanes) and SAYS the
   attribution limit — the per-video attribution tail is recorded, not
   papered over.

## 1. The shape

`GET /api/videos/[id]/board` composes one snapshot:

| Section | Source | Notes |
| --- | --- | --- |
| `stages` | deriveBoardStages (pure, pinned) | script/storyboard/voice/render/publish; storyboard progress is lane-appropriate: scene-art storage stats for the image lanes, the whiteboard project doc for the whiteboard lane, hasStoryboard for classic |
| `jobs` | jobSnapshot + lastJobError per kind | what is generating NOW + the last readable failure |
| `checkpoints` | deriveCheckpoints (pure, pinned) | the five gates above |
| `costs` | UsageRecords, 30d, capped 2000 rows | org scope, top lanes, the attribution note |
| `history` | Activity, last 40, video-scoped | the production history the system already records |

## 2. The UI

`production-board.tsx` — one compact card between the dialog header and
the tabs: the stage strip (state-colored dots, running pulses), the
"needs you" attention badges (proposed plan, critic hold), the checkpoint
icons with the cost context line, and the collapsible history feed. It
polls every 4s while anything generates (the queue panel's rhythm) and
goes quiet when idle. The board is CONTEXT, never a blocker: a failed
fetch renders nothing, never an error.

## 3. The proof (4 pins)

The honest derivation table: the five states + running-outranks-done ·
partial-is-first-class (3/8, preview, short-without-publish) · the classic
format (words) + the empty video (missing, never faked) · the checkpoint
evidence table (proposed → attention, unreviewed report → pending, absent
→ n/a ×4, all-green path, hold → attention).

## 4. Recorded tails

1. **Per-video cost attribution** — needs videoId on UsageRecord (or a
   ctx extension carrying the acting video); the board's costs section
   already states the limit honestly.
2. **Board deep-links** — clicking a stage could open its tab; the strip
   is informative-only in v1.
3. **Checkpoint actions** — the attention badges could deep-link to the
   approval surface (Director card / critic card) — both cards already
   live in the dialog.
4. **Whiteboard per-scene progress** — the doc counts scenes as authored;
   per-scene render state would need the whiteboard job's payload.
