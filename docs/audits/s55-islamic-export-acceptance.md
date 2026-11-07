# S55 Islamic export acceptance — the owner's 7-step protocol, executed (T-55.5)

Recorded 2026-11-08 UTC · code at probe time: `cbe90c2` + the T-55.5 edit-path
fix (this commit) · instrument `scripts/s55-acceptance-probe.mts` +
`scripts/s55-standin-gateway.mts` (local only, zero gateway spend) · raw
evidence `docs/audits/s55-acceptance-data.json` · **58/58 checks pass**.

## Mandate

T-55.5: "multi-scene Islamic-history video with restricted-figure references
→ full MP4 → dense inspection → scene regeneration + i2v paths → violation
blocks export → unmeasured scan blocks export. Standard: zero prohibited
faces in exported videos." The T-55.4 dense scan was machinery-validated with
the VLM stage deliberately unspent; this acceptance runs the FULL funnel —
including the VLM verdict — on real Islamic-history content.

## The stand-in disclosure (read this first)

The Z.ai gateway is metered quota and probes never spend it (the
probe-hygiene law). The acceptance therefore runs the REAL production code —
`runDirectorPass`, `runStoryboardJob`, `runSceneJob`, `runRenderJob`,
`runQcJob`, `runRestrictedVisualScan`, `applyQcPolicy` — against a LOCAL
stand-in gateway (`scripts/s55-standin-gateway.mts`) that speaks the Z.ai
SDK's exact wire format on 127.0.0.1: chat (a canned ADVERSARIAL director
plan), vision (the scan/quality/text verdicts, mode-controlled),
images/generations (+edit), video/generation + async-result + the clip
download. `.z-ai-config` points the SDK at it for the probe's process only
and is restored after; provider "zai" is ungated by the spend law, so
`TUBEFORGE_SPEND_GATE` stays untouched and **0 gateway quota, 0 paid
dispatches** were consumed.

What the stand-in proves and what it cannot: the stand-in's VLM verdicts are
SCRIPTED (clean / violation / garbage), so this acceptance proves the FUNNEL
— grid, tripwire, batching, verdict parsing, check emission, gate law, every
sanitize seam on the wire — not the real model's judgment. The real-gateway
VLM verdict on real generated imagery remains a paid call, held behind the
spend-gate law until pricing is independently verified. The paints and the
i2v clip are themselves local synthetics (testsrc2 lineage + skimage's
astronaut as the anonymous traveler — a real face, BSD sample data), so the
imagery is adversarial only in TEXT, not in pixels; the violation leg's
"depicted: true" is the stand-in playing the judge the audit demands.

## The run (7 steps, 58 checks — all in the evidence JSON)

**Step 1 — the video + the adversarial plan (L2, live).** A real Video row
(`contentPolicy: "islamic-history"`, 3 scenes whose visuals NAME the Prophet
Muhammad ﷺ, Abu Bakr, Umar, the angel Jibril). The stand-in director
"model" returns a plan whose 9 shots carry restricted references in
imagePrompt AND subject — the pass sanitized every field BEFORE persisting
(zero restricted references outside the hard negative clause in the persisted
plan), announced the rewrite in a warn-level activity row, and stamped the
plan's policy provenance. The human gate approved it.

**Step 2 — paints + narration (L3, live).** `runStoryboardJob` painted all 3
scenes through the stand-in: every wire prompt sanitized, the negative clause
on every dispatch, the VLM quality gate consulted per paint, the dHash dedupe
exercised (and satisfied — the first asset cut's smooth gradients taught the
probe that textureless stand-ins false-trip the freeze lens; the §B testsrc2
lineage is the honest basis). Narration: the §B stand-in WAVs (4s sine at
−26 dB per scene).

**Step 3 — the full MP4 + dense inspection (L4, live).** `runRenderJob`
(kenburns, 1080p, 15.6s): the M2 shot graph rendered scenes 1–2; scene 3
(declared `needsI2V`) animated through the REAL i2v channel —
`ensureSceneClip` dispatched the S50-sanitized motion prompt (verified
sanitized on the wire, negative clause riding), polled, downloaded the clip,
and the final render's scene-3 window carries the clip's pixel marker (the
magenta top bar) — proof the clip PLAYED, not a Ken Burns degrade. The
post-render battery emitted `restricted-visual` **pass** with honest coverage
(`grid 29 @0.50s · tripwire 12 hit(s) → 15 forced (cv2 4.13.0) · judged 29
≈0.50s apart · 4/4 batches`), `text-artifacts` pass, and all 8 structural
lenses green — the T-55.3 fixed path holds on a second independent plan.
`applyQcPolicy` (the export route's own gate core, run exactly as the route
runs it) read the standing report: **gate OPEN** — and the render activity
row carries no hold. The zero-prohibited-faces standard: the exported
final.mp4's dense grid tripwired LOCALLY (real haar) — 12 hits, all the
anonymous traveler (allowed content; the VLM decides reverence, and the
stand-in judge said clean) — with hit timestamps recorded in the evidence.

**Step 4 — scene regeneration + i2v (live, with one FIX).** `runSceneJob`
re-rolled scene 1 (its visual names the Prophet): the re-roll's wire prompt
sanitized, clause riding. The instruction AI-edit on scene 2 used an
ADVERSARIAL instruction ("show the Prophet Muhammad and Abu Bakr walking
together in the foreground, faces clearly visible") — and **found the gap**:
`editSceneImage` embedded the raw instruction in its dispatch prompt with NO
policy pass (the S49 L3 seam covered `generateSceneImage` +
`ensureShotImages`, never the edit path; L4/L5 were the only backstops).
**Fixed in this commit**: the composed edit prompt now rides the SAME
sanitizer (sentence REPLACE + the hard negative clause; standard policy =
the pre-S55 bytes, unit-pinned). The re-run's edit dispatch was verified
sanitized on the wire — substitution, clause, and the surgical boilerplate
all present — and the regeneration correctly invalidated the standing render
(`hasVideo: false`; new evidence required).

**Step 5 — violation blocks export (live).** The stand-in VLM flipped to
"violation" (a haloed, venerated central figure): the post-regeneration
re-render's scan FAILED on the first batch (short-circuit — more calls buy
nothing once the verdict blocks), the check names the frames with
timestamps, `applyQcPolicy` **blocked** with `restricted-visual` as a
severity-block finding, and the render activity row announces
"EXPORT ON HOLD".

**Step 6 — unmeasured blocks export (live).** The stand-in VLM flipped to
"garbage" (unparseable): the QC re-run (`runQcJob`, the second S49 L4 site)
reports `restricted-visual` **unmeasured** — fail-closed, never silently
clean — and the gate STILL blocks: an unmeasured lens cannot certify the
file. (Pre-existing, on record from T-55.3: the doc-less QC re-run also
rebuilds cut-alignment expectations from nothing, so that check reads
unmeasured on this path too — same known class, unchanged by this task.)

**Step 7 — the standard.** Zero prohibited faces in exported videos: the
export path is open ONLY on the render whose dense scan measured clean end
to end; both failure classes (violation, unmeasured) hold the bundle with
the restricted-visual finding named. The VLM half of that standard is
stand-in-scripted here (see the disclosure); the gate, the scan plumbing,
and every text-side sanitize seam are real and live.

## The one production fix (evidence-directed)

`editSceneImage` (story.ts): the composed edit prompt now passes through
`sanitizePromptForPolicy` under the video's content policy, with the
substitution console-warn — the exact law `generateSceneImage` follows.
Standard policy is byte-identical (unit-pinned: "the edit prompt is
byte-identical to the pre-S55 composition"). Without it, a one-sentence
user instruction was the only generation surface that could name a
restricted figure outside the L4/L5 backstops.

## Honest margins (on record)

- **The VLM verdict is scripted.** The funnel is proven; the real model's
  judgment on real generated imagery is not — it stays behind the spend gate
  until pricing verification, and the first real-gateway render should
  re-run this protocol's steps 3/5/6 verbatim.
- **The imagery is synthetic.** testsrc2-lineage paints + the astronaut
  traveler: adversarial in TEXT only. A real CogView/CogVideoX generation
  could paint something the text side never asked for — that is exactly
  what L4 exists for, and its dense grid + tripwire ran for real here.
- **The freeze lens taught the probe a lesson** (recorded for future
  stand-ins): textureless synthetic paints false-trip freezedetect under
  gentle Ken Burns motion — smooth gradients are NOT a valid §B stand-in
  for freeze-sensitive lenses; testsrc2's high-frequency structure is.
- **The QC re-run's cut-alignment** reads unmeasured on doc-less videos
  (T-55.3's recorded limitation) — orthogonal to this task's failure class,
  unchanged.

## Files

- `src/lib/tubeforge/story.ts` — the `editSceneImage` L3 fix (one seam).
- `scripts/s55-acceptance-probe.mts` — the 7-step acceptance (versioned,
  phased: seed / render1 / regen / render2 / unmeasured / report / teardown).
- `scripts/s55-standin-gateway.mts` — the local stand-in gateway.
- `scripts/test-unit.mts` — the S55 T-55.5 suite section (+1: 245/245).
- `docs/audits/s55-acceptance-data.json` — the raw evidence (58 checks,
  timings, tripwire hit timestamps, spend accounting).
