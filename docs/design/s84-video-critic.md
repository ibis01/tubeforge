# S84 — the Video Critic (foundation)

**Status:** implemented (foundation slice + the S85 UI card). Design target: the S76
adoption decision §4.B (`docs/audits/s76-openmontage-adoption-decision.md`).
Implementation: `src/lib/tubeforge/video-critic.ts`; surface
`/api/videos/[id]/critic`; job kind `"critic"` (entity = video); the human
surface is `src/components/tubeforge/critic-card.tsx` (S85 — the video
detail dialog's Video tab, after the QC scorecard; Mission Control resumes
interrupted critic jobs).

**The question it answers:** "Is this RENDERED video worth shipping —
and if not, what exactly do I fix?" The VCE judges scene stills before
the render; the QC battery judges the file's technical health. Nobody
judged the final cut as a STORY — until now.

## 0. Binding constraints (the S77 family, inherited)

1. **AI never replaces deterministic checks** (S76's critical rule).
   technical / motion / audio rows come from the stored QC battery
   report; the consistency row comes from the stored VCE report; only
   narrative + visual are new AI — ONE fail-open VLM call over frames
   sampled evenly from `final.mp4`.
2. **Propose, never auto-edit.** Every hold maps to a repair proposal
   naming the EXISTING affordance (scene re-roll, Director card,
   re-render, voiceover re-run). The critic regenerates nothing.
3. **Fail open, never invent.** A missing QC report, a missing VCE
   report, unreadable frames or a failed VLM call are recorded
   `unmeasured` / `unavailable` with the reason — never a pass, never a
   fabricated score (a missing dimension score is null, never 50).
4. **The ship gate stays where it is.** qc-policy gates exports on the
   battery; the critic's verdict (`ship | hold | insufficient-evidence`)
   is a REPORT for the human, not a new automated gate.
5. **Shared contracts.** The one VLM call rides `aiCall`; frames sample
   through visual-qc's `sampleFramesEvenly`; the report persists via
   the storage seam (`${videoId}/critic-report.json`); execution runs
   under the job registry (resume/cancel/progress derive from it).

## 1. Dimensions and their sources

| Dimension | Source | Evidence |
| --- | --- | --- |
| technical | qc-battery | playable, aspect, duration, black-frames, captions, restricted-visual |
| motion | qc-battery | frozen-frames, static-shots, stutter, cut-alignment, flicker |
| audio | qc-battery | dead-air, loudness, loudness-range, true-peak, tail-fade |
| visual | critic-vlm ⊕ qc-battery | the VLM's visual score, worst-of the deterministic text-artifacts check |
| consistency | consistency-report | the stored VCE report — worst checked scene verdict decides |
| narrative | critic-vlm | the VLM's narrative score (frames vs the scene narrations) |

`subject-continuity` (a battery check) is deliberately NOT in the
table — the consistency row reads the richer VCE report instead. A new
battery check id MUST be classified into `DIMENSION_CHECKS` the moment
it lands (pinned).

## 2. Status vocabulary and math

- Row status: `pass | hold | unmeasured | unavailable`.
- Deterministic row: worst-of — any fail → hold; else any unmeasured →
  unmeasured; else pass; no checks → unmeasured (never a silent pass).
- Consistency row: the worst CHECKED scene verdict (off/drift → hold,
  naming the worst scenes); all-unavailable or no report → unmeasured.
- VLM dimensions: score ≥ 80 passes, ≥ 55 holds, below fails (the VCE
  `verdictFromScore` bands, inherited); a missing/non-numeric score is
  NULL for that dimension alone — never 50.
- Verdict: any hold → `hold`; nothing measured → `insufficient-evidence`
  (honest, never a pass); otherwise `ship` — unavailable AI layers ride
  `engine.unavailable`, they never block and never pass.

## 3. The VLM pass (one call, fail-open)

`sampleFramesEvenly(final.mp4, durationSec, VISUAL_SCAN_FRAMES)` →
frames in story order + the scene narrations (first 160 chars each,
cap 12) → `CRITIC_SYSTEM`: judge narrative (do the frames communicate
the script's beats?) and visual (professional, on-topic, no artifacts)
each on its own; audio, technical file properties and character
identity are explicitly disclaimed (judged elsewhere). STRICT JSON
`{"narrative":{score,issues},"visual":{score,issues}}`.

## 4. Surface

- `GET /api/videos/[id]/critic` — the stored report + job flags.
- `POST` — run (202, job kind `"critic"`), manual-only by design; the
  `consistencyCheck` setting's `off` refuses it (S80's law inherited).
- The report persists at `${videoId}/critic-report.json`
  (`parseCriticReport` serves the GET; corrupt/wrong-schema JSON →
  null; a corrupt verdict falls back to `insufficient-evidence`).
- An Activity row (`stage: "qc"`) records the verdict + per-dimension
  statuses.

## 5. Recorded tail (not built in the foundation)

- The **factual** dimension (claims vs research briefs) — needs the
  research-brief surface; recorded.
- Selective regeneration flows wired from proposals (today the
  proposals NAME the affordance; a one-click repair lane is future
  work).
- Auto-run after render (today manual-only; the S74-informed motion
  thresholds land first).
- ~~A critic card in the UI~~ — **landed in S85**
  (`src/components/tubeforge/critic-card.tsx`): the report card in the
  Video tab — verdict badge, one row per dimension (status icon,
  source, issues, evidence), the repair proposals (still names-only,
  §0.2), the engine's honesty notes, run/re-run with the rerunQc poll
  pattern, and a pre-existing running job picked up on mount; the
  attention panel resumes interrupted `critic` jobs.

## 6. Pinned-by-tests contract

`DIMENSION_CHECKS` (every battery check id classified exactly once;
subject-continuity excluded) · `dimensionFromChecks` (worst-of: fail →
hold, unmeasured → unmeasured, all-pass → pass, empty → unmeasured,
foreign checks never leak) · `consistencyDimensionFromReport` (no
report → unmeasured; worst checked verdict decides; all-unavailable →
unmeasured) · `parseCriticVerdict` (per-dimension null on missing
scores, never 50; clamping; 80/79 band edge) · `buildCriticVerdict`
(any hold → hold; nothing measured → insufficient-evidence; unavailable
never blocks) · `buildCriticProposals` (holds map to named affordances;
unmeasured asks for evidence; pass/unavailable propose nothing) ·
`criticReportKey` + `parseCriticReport` (roundtrip; corrupt → null;
corrupt verdict → insufficient-evidence) · `CRITIC_SYSTEM` law pins
(two dimensions named; audio/technical/identity disclaimed; STRICT
JSON).
