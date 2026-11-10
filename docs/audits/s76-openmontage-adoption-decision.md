# S76 — OpenMontage Capability Adoption Decision and Master Roadmap

Opened 2026-11-10 UTC. Provenance: an external engineering audit
("TubeForge × OpenMontage — Verified Engineering Adoption Roadmap")
was delivered in chat on 2026-11-10 and its decision text was approved
for recording. This record is that decision, re-verified against the
remote tree at `f7bfe47` (CI 6/6 on that exact SHA) before it was
written down. The audit's own framing governs everything below: this
is an **engineering verification, not a feature comparison** — every
capability claim is labeled implemented-and-evidenced, documented-but-
unverified, missing, or recommended. Nothing in this record claims a
module exists until the file was seen in the verified tree.

## 1. The decision

**Decision:** Adopt selected OpenMontage creative-production concepts
through independent TubeForge implementations.

**Architectural constraint:** Preserve TubeForge's native
orchestration, multi-tenant SaaS infrastructure, provider boundaries,
billing controls and durable job system.

**Execution sequence:**

1. Close S74 motion-vigor measurement, real TTS validation and Docker
   production-image smoke.
2. Complete Visual Consistency.
3. Complete Video Critic and Repair.
4. Establish the Universal Timeline contract.
5. Introduce reference-video intelligence.
6. Expand existing stock-footage retrieval and provider-selection
   intelligence.
7. Expand into character animation, 3D and other specialized
   production engines only after the shared contracts are stable.

**Reuse policy:** Study OpenMontage's architecture and independently
implement suitable capabilities. No source-code copying or adaptation
before the AGPL-3.0 implications and TubeForge's own licensing
position are reviewed (OpenMontage is AGPL-3.0; the TubeForge
repository currently has no LICENSE file — one must be chosen and
published before commercial distribution).

**Quality policy:** Every engine must produce compatible timeline
assets and pass the shared quality and technical ship gates.

**Anti-goal:** No disconnected engines, unverified provider
integrations, automatic quality claims or uncontrolled generation
spending.

**Acceptance:** Each phase requires code-level tests, real artifact
validation where applicable, cost controls and documented evidence
before closure.

## 2. Verified capability state at record time

The audit's live inspection produced three corrections to the earlier
comparison, all confirmed against the tree:

1. **Stock-footage retrieval already exists.** `stock.ts` integrates
   Pexels and Pixabay, derives scene-specific queries, ranks
   candidates and checks downloaded footage with a vision model. The
   work is retrieval intelligence and source coverage — not building
   retrieval from scratch.
2. **Timeline and quality infrastructure already exist.**
   `timeline.ts` builds an editable scene-level timeline;
   `quality.ts` and `render-qc.ts` provide visual and technical
   checks. The work is evolving these into universal production
   systems.
3. **Reference-video analysis is the clearest missing creative
   capability.** OpenMontage dedicates a workflow to it; no
   first-class equivalent was found in TubeForge.

| Capability | OpenMontage | TubeForge | Decision |
| --- | --- | --- | --- |
| Native orchestration | Agent-driven pipelines | Native Director + job orchestration | Keep TubeForge |
| Reference-video analysis | Dedicated workflow | No equivalent verified | Adopt |
| Stock footage | Broad source ecosystem | Pexels + Pixabay implemented | Expand |
| AI video generation | Broad provider ecosystem | Provider abstraction | Improve selection |
| Image generation | Broad provider ecosystem | Provider abstraction | Keep |
| Whiteboard | Ink Theater | Native Whiteboard | Keep |
| 3D production | Blender + Three.js | No equivalent verified | Defer |
| Character animation | SVG rigs + GSAP | Character library + continuity | Expand later |
| Audio | Broad TTS/music/SFX tools | Audio production pipeline | Improve intelligence |
| Timeline | Remotion, HyperFrames, FFmpeg | Editable scene-level timeline | Evolve |
| Reference/storyboard approval | Backlot approval workflow | Studio + storyboard surfaces | Strengthen |
| Visual QC | Frame and media review tools | VLM quality gate | Improve |
| Technical QC | FFprobe, frame and audio checks | Dedicated render-QC system | Keep and expand |
| SaaS tenancy | Not primary architecture | Multi-tenant foundation | Keep |
| Billing | Not primary architecture | Stripe + credit ledger | Keep |
| Durable jobs | File checkpoints | DB-backed queue + recovery | Keep |

Implementation evidence held to the same standard: OpenMontage's
architecture documents real tool files (`tools/analysis/video_analyzer.py`,
`tools/video/clip_search.py`, `tools/graphics/blender_world.py`, …) and its
latest retrieved provider commit (Pika H3 Flex, `fecb9a1`) carries 72
faked-HTTP contract tests — substantial adapter engineering that still
does not prove live production quality for every provider. TubeForge's
side is evidenced by the verified module list: `stock.ts`/`stock-query.ts`,
`director.ts`/`director-plan.ts`, `timeline.ts`, `quality.ts`/
`render-qc.ts`, `providers/registry.ts` + the provider files,
`liveliness.ts`, `characters.ts`/`character-jobs.ts`, `whiteboard/`.

## 3. Phase gates (the working order)

**Phase 0 — production readiness (current, blocking).** No new
production engine starts before these close:

- S74: 8 paired motion measurements + 16 blind vision evaluations,
  real clips only. (Watcher-automated; 0/8 at the 18:30 UTC fire,
  first before-clip rendered, video-pool 429 in backoff — resuming.)
- Docker: `f7bfe47` landed the Chromium lines into the Dockerfile and
  CI reran all six jobs green on that SHA. The **image build +
  in-container render smoke** remains the one open infra gate — the
  dev sandbox has no Docker daemon, so it runs on a Docker-capable
  runner.
- Real TTS: a narrated Whiteboard video through the real TTS path
  that passes QC (E10 used synthetic narration-slot audio; the
  readiness report's honesty caveat).

Exit criteria: S74 closed on blind scores (not unit tests alone); the
Docker image builds and renders a real project; real-TTS output passes
QC; CI green on the exact release-candidate SHA.

**Phase 1 — shared quality systems (next engineering phase, highest
architectural value):** 1. Visual Consistency Engine → 2. Video Critic
and Repair → 3. Universal Timeline contract. These become shared
infrastructure for every future engine.

**Phase 2 — creative intelligence expansion:** reference-video
intelligence; advanced stock retrieval; provider selection; stronger
creative approval / production board.

**Phase 3 — new production engines (deferred):** advanced motion
graphics; rigged character animation; Blender/Three.js production;
presentation and interactive explainer engines; advanced cinematic
production.

**Phase 4 — universal creator platform:** engine marketplace;
production templates; localization and multilingual production;
collaboration and team workflows; creator intelligence and analytics.

## 4. Proposed module boundaries (design targets, not implemented code)

### A. Visual Consistency Engine — `visual-consistency.ts`

Foundation already present: `runContinuityCheck()` compares scene
imagery against character identity references. Identity is only one
dimension. The engine extends the evaluation to: character identity
and appearance; clothing and accessories; location continuity; prop
continuity; lighting and colour palette; historical period and visual
style; camera and composition consistency.

Acceptance tests: same character across five scenes stays consistent;
same location does not randomly change; clothing persists unless the
script requires a change; a deliberately inconsistent image is
detected; a failed check produces a repair proposal instead of
silently approving the scene.

### B. Video Critic and Repair — `video-critic.ts`, `repair-proposals.ts`

The critic inspects the rendered video, not just scene stills:
rendered video → frame sampling + audio analysis → visual consistency
evaluation → narrative/script alignment → technical QC → structured
quality report → repair proposals → user approval → selective
regeneration → final QC + ship gate.

Dimensions: narrative (does it communicate the story), visual
(relevant and professional), consistency (continuity across scenes),
motion (natural movement), audio (narration/music/effects balance),
technical (flicker, stutter, missing frames, broken audio), factual
(claims and historical visuals appropriately supported).

**Critical rule:** AI evaluation must not replace deterministic
technical checks. If a vision provider fails, the evaluation is
reported as unavailable — never invented as a passing score.

### C. Universal Timeline — extend `timeline.ts`

Today's model is a scene-level projection with AI/stock/slides source
types. The target is an engine-neutral, multi-track, versioned
composition contract (tracks of type video/image/whiteboard/3d/
character/audio/subtitle/graphics; clips with asset, timing,
transform, effects) integrated with `render.ts`, `clip-ops.ts` and
`audiomix.ts`. The schema sketch in the audit is an illustrative
target — merging it requires a migration design first.

Acceptance tests: Whiteboard scenes, stock footage and generated
clips all render through it; narration, music, SFX and subtitles stay
synchronized; transitions preserve exact timing; a saved timeline
reopens and renders identically; every future engine can produce
compatible timeline assets.

## 5. Adoption priorities

**P1 — reference-video intelligence (`reference-video.ts`).** Accept a
permitted video URL or upload; extract transcript and speech timing,
scene boundaries, representative frames, shot duration and pacing,
camera movement, visual treatment, hook and narrative structure; the
Director then produces an original concept from the abstract
characteristics. Structural patterns, never copyrighted footage,
scripts or distinctive expression. Ingestion must respect source
access rights, platform terms and TubeForge's SSRF protections.
Integration points: `director.ts`, `director-plan.ts`, `story.ts`,
`stock-query.ts`.

**P2 — stock-footage intelligence.** Keep Pexels and Pixabay; evaluate
Wikimedia Commons, NASA, Internet Archive and NOAA/other public
archives individually — do not integrate every source at once. Add a
source adapter contract, `stock-index.ts` (searchable metadata) and
`stock-ranker.ts` (semantic relevance, actual visual content,
resolution/aspect, duration, motion suitability, license and
attribution, duplicate footage). The existing VLM relevance check is
the starting point; the stronger implementation samples multiple
frames per clip instead of trusting one.

**P3 — provider selection intelligence.** Extend the existing
registry/provider files, `budget.ts` and `spend.ts` — do not build
another provider framework. Score providers with a configurable,
production-calibrated weighted sum of expected quality, reliability,
cost efficiency, latency and creative task fit. A provider with
unknown pricing is never treated as free; the paid-dispatch safety
rules stand unchanged.

**P4 — living production board.** Expose production stages, script
and storyboard, asset-generation progress, provider decisions, costs,
approval checkpoints and production history through the project
studio, backed by the existing database and job system (OpenMontage's
Backlot is the UX reference, studied not copied).

**P5 — 3D and character animation.** Deferred until the Universal
Timeline is stable (§3 Phase 3).

## 6. Acceptance-test matrix

| Feature | Required proof | Release condition |
| --- | --- | --- |
| Reference analysis | Transcript, scene map, keyframes, pacing report | Accurate, reproducible analysis |
| Stock retrieval | Source metadata, license, relevance, duplicate checks | No unverified footage silently accepted |
| Provider selection | Cost, quality, reliability comparison | No unpriced paid dispatch |
| Visual consistency | Cross-scene comparison | Detects seeded continuity defects |
| Video Critic | Structured report against rendered output | Reproducible evaluation |
| Repair system | Before/after QC comparison | No unapproved destructive changes |
| Universal Timeline | Cross-engine rendering + round-trip tests | Same contract supports all engines |
| 3D engine | Real scene rendered through the shared timeline | No isolated rendering pipeline |
| Character engine | Rig, motion, continuity, export tests | Reusable engine contract |

Unit tests alone never claim visual quality: real output artifacts,
deterministic checks, model-assisted evaluation and human review.

## 7. Final priority order (master roadmap)

1. S74 real motion measurement — Critical
2. Docker production image smoke — Critical
3. Real TTS Whiteboard smoke — Critical
4. Visual Consistency Engine — P0
5. Video Critic and Repair — P0
6. Universal Timeline contract — P0
7. Reference-video intelligence — P1
8. Advanced stock retrieval — P1
9. Provider selection intelligence — P1
10. Living production board — P2
11. Advanced audio intelligence — P2
12. Character animation engine — P3
13. Blender / 3D engine — P3

## 8. Governing rule

> Every new production engine must consume TubeForge's shared
> intelligence, asset, timeline, rendering and quality contracts. No
> new engine may introduce an isolated production pipeline.

## 9. Delta between the audit's snapshot and this record

State moved while the audit was being verified; the differences are
recorded so no future reader trusts a stale snapshot:

- The E12 closure **is** on origin (`845552c`, CI 6/6 first try) with
  its landing receipt (`da19486`) — the "queued for a later push"
  caveat in the audit's early snapshot is obsolete.
- The Dockerfile Chromium contract landed in `f7bfe47`, and **all six
  CI jobs reran green on that SHA** — the audit's "Vercel success
  alone" doubt is closed; the build+render smoke on a Docker-capable
  runner remains the open gate.
- A cron-loop commit (`d5e49e2`, 1520 files / ~326k insertions,
  including binary `work/yamama` video chunks and nested repo copies)
  was found **queued locally, unpushed**; it was quarantined to the
  branch `quarantine/cron-d5e49e2` and `main` reset to `f7bfe47`. It
  is not part of the product and never reached the remote.
- ARCHITECTURE.md inventory counts were reconciled to measured truth
  (22 migrations not 21/19; 116 route files not 103; 117 modules not
  97; 32 models not 31) and the two 2026-11-11 date slips were
  corrected to their true 2026-11-10 UTC values.
