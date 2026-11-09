# Creator Intelligence Engine — the evaluation and decision record

2026-11-10 · Trigger: an external comparison of TubeForge against
`Jakeschincariol/youtube-agent-skill` (MIT) recommended a strategic
direction. This record ground-truths that comparison against the actual
codebase, decides what TubeForge adopts, and stages it. **No code lands in
this record** — it is the design decision the future stages cite.

---

## 1. What was evaluated — verified facts, not the report's summary

`Jakeschincariol/youtube-agent-skill` — MIT ("Use it, change it, ship
it."), read directly on 2026-11-10. Eleven Claude skills (`/yt-script`,
`/yt-package`, `/yt-edit`, `/yt-comment`, `/yt-plan`, `/yt-viral`,
`/yt-retention`, `/yt-shorts`, `/yt-seo`, `/yt-chapters`, `/yt-audit`)
plus six standalone Python tools (`hookscore.py`, `title.py`,
`deadair.py`, `chapters.py`, `retention.py`, `swipe.py`). Its inputs are
SRT transcripts, retention CSV exports, collected JSON, and a voice
profile; its outputs are **advisory documents** — scored hook panels,
linted title+thumbnail pairings, edit decision lists, comment replies,
content plans, audits. It explicitly does not render video, does not
publish, does not scrape, and does not invent numbers it was not given.

That last discipline — its hook score is labeled a heuristic, never a
predictor — is the single best idea in the repository, and it is adopted
verbatim into the house doctrine below.

## 2. Ground truth — the external comparison's table, corrected

The comparison's capability table materially understates what already
ships. Corrections, each verified in the tree:

| Claimed gap | Actual state (file evidence) | The REAL gap |
|---|---|---|
| Shorts extraction: "Opportunity" | **SHIPS (Phase 5)** — `shorts.ts`: `pickBestScene` (deterministic: hook-regex caption/narration, density, host presence), 9:16 center-crop + punch-in, vertical-safe caption re-burn, ≤45s, `short.mp4` + `short-thumb.png` | Moment selection is keyword-scoring, not transcript-based self-containment; no opening-line rewrite for the clipped Short |
| Hook scoring: "Opportunity" | Partially exists — `story.ts` deterministic attention map (scene 1 = hook, every 3rd scene rehook + `sting` sfx; "it flagged half the scenes as rehooks when left to choose") | No scored hook ALTERNATIVES — the 21-formula generate-five-and-panel-score loop; no title-promise-delivery check |
| Title/thumbnail: "Needs stronger system" | `publish-suggest.ts` drafts title/description/tags by tone (4 tones, YouTube limits clamped); thumbnails generate (`thumbStyle`) | The two are linted separately, never as ONE pairing (truncation/duplication/vagueness against the actual thumbnail) |
| Retention: "Opportunity" | The performance loop exists — `analytics.ts`: upload → Data-API stat sync → `VideoStat` snapshots → Analytics view → deterministic Topic Radar keyword boost; `comments.ts` ships a per-video engagement kit | No retention-curve ingestion or drop-off analysis at all; OAuth `SCOPES` are `youtube.upload`+`youtube.readonly` only — retention needs the **YouTube Analytics API** (`yt-analytics.readonly`), a new scope and token refresh |
| SEO/chapters: "Needs expansion" | Tags/description suggestion ships (above); word-position captions ship (`captions.ts`) | No chapter generation; no "queries this video should win" targeting |
| Publishing: "Manual approval and upload" (theirs) vs connected (ours) | Confirmed ours: resumable upload, `runUploadJob`, publish flow with AI suggest + human approve | — |

The strategic conclusion stands after correction, sharpened: the
intersection is real but smaller than claimed, and TubeForge's unfair
advantage is that its intelligence can **act** — a Shorts pick becomes a
rendered `short.mp4`, not a suggestion in a document.

## 3. The decision — a Creator Intelligence Engine, as native services

Adopted: a **Creator Intelligence Engine** joins the TubeForge 2.0 shared
systems (Director, Visual Consistency, Audio Intelligence, Video Critic).
The four modules that earn their place, in build order:

- **CI-1 Hook & Script Intelligence** (from `/yt-script` +
  `hookscore.py`). Generate N candidate openers, panel-score them
  (deterministic properties: specificity, tension, promise; LLM judge with
  strict-JSON output), mark retention beats on the chosen script, verify
  the opening delivers the title's promise. Feeds the existing script
  lane; the rehook map stays the structural spine.
- **CI-2 Packaging Intelligence** (from `/yt-package` + `title.py`).
  Lint title+thumbnail as ONE unit: truncation at render width,
  duplication (title says what the thumb shows), vagueness; deterministic
  checks + VLM lookability pass. Runs on `publish-suggest` output and
  user edits alike — the publish form gains a lint badge.
- **CI-3 Shorts Intelligence** (from `/yt-shorts`). Transcript-based
  self-containment scoring replaces keyword density in `pickBestScene`
  (the pure-function seam stays — same signature, smarter score), and the
  clip's first line gets rewritten for cold-start viewers. The renderer
  below it is already built and CI-proven — this is where TubeForge
  visibly out-executes an advisory tool.
- **CI-4 Retention Intelligence** (from `/yt-retention` +
  `retention.py`). New Analytics-API scope + token refresh; retention
  export ingestion; drop-off moments mapped to scenes, narration text,
  pacing and visual changes via the timeline; recommendations attach to
  the video row. **Proposes, never auto-edits** — the "AI suggests +
  human approves" doctrine already governing publish-suggest and the
  Director extends to performance data: a revision proposal must show its
  evidence and wait for approval.

Later (recorded, unscheduled): chapters + query targeting (CI-2 extension
into `/yt-seo`/`/yt-chapters` territory), channel audit (the
one-specific-fix discipline of `/yt-audit`), competitor benchmarking
(`swipe.py`'s own-channel-median multiple), and performance learning
feeding Topic Radar beyond the current keyword overlap.

## 4. What is NOT adopted

- **The Claude-skill architecture.** No plugin loader, no slash-command
  harness, no template directory. Every capability lands as a native
  service: typed inputs, structured outputs, unit-tested, provider-
  independent (`llm.ts` seam), budget-capped (`budget.ts`), and behind
  the product's routes and job kinds — the same laws the Whiteboard
  engine and Director obey.
- **Wholesale code copy.** The six tools are studied for their logic
  (the 21-formula taxonomy, the pairing-lint checklist, the retention
  cliff taxonomy); implementations are ours. MIT permits more; the house
  discipline requires less.
- **Score theater.** Adopted from their honesty note: every score the
  engine emits is labeled a heuristic in the UI and API response
  (`heuristic: true`, never "predicted CTR"), and missing data is asked
  for, never invented.

## 5. Sequencing — Whiteboard keeps the immediate milestone

The S68 close set S69 as the Whiteboard E9 Phase B remainder (palette and
asset management behind `WHITEBOARD_ENGINE_DESIGN.md` §7's seven gates)
plus the `video.error` lane-attribution question. That stood: S69 landed
(both items), and the Engine followed — **S70 = CI-1 + CI-2** (both
LLM+deterministic work with zero new infrastructure; CI-1 rides the
script lane, CI-2 the publish form), **S71 = CI-3** (the pickBestScene
seam upgrade + the cold-start opener), **S72 = CI-4** (the Analytics
scope, the retention doc column, the scene-mapped findings). All four
modules shipped 2026-11-10, live-verified against the green gateway (the
S69 opening probe) and CI-proven 6/6 per stage. The standing disciplines
held everywhere: proposes-never-auto-edits, every score labeled a
heuristic, missing data asked for and never invented.

## 6. License and attribution

`youtube-agent-skill` is MIT-licensed; its ideas are adapted under the
same terms with attribution recorded here. No verbatim code is expected
to enter the tree; if any does, the file header cites upstream.
