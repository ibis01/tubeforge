# S63 — Subject-motion vigor: repairing what the S62 blind scoring measured

Opened 2026-11-09 UTC (owner-directed "next" after S62 closed). This stage
executes the carry-forward S62 named in its findings and record: subject
motion under-reads on the profiles whose blind scores lagged — carried as
P2 because patching it inside S62 would have been teaching to the test.
S63 does the repair as its own measured stage.

## 1. The receipt-level diagnosis (why "the doctrine" was never the problem)

S62's finding said the lever was "the `I2V_SUBJECT_MOTION` clause for
detail/text kinds and slow-speed prompts". Re-reading the ACTUAL prompts
the lane sent (`validation/s62/manifest.json`) shows the mechanism was
sharper — the per-kind doctrine mostly never spoke at all:

1. **The pose-kill.** `i2vMotionPrompt` let the director's shot-0
   `subjectAction` REPLACE the per-kind motion clause outright
   (liveliness.ts: `shot0?.subjectAction?.trim() || I2V_SUBJECT_MOTION[kind]`).
   In the real S62 plans, 7 of 8 subjectActions were poses, positions or
   lighting notes — not motion asks: "stationary at top position"
   (explainer), "staring at phone screen" (social), "standing tall in the
   library" (islamic-history), "sitting prominently on wet slate"
   (advertisement), "sitting attentively at a microphone" (podcast),
   "bathed in warm amber light…" (narrative), "staring at phone screen".
   Only documentary's ("carrying ships across the desert") was genuinely a
   motion ask. So the ONE place the motion doctrine lived was silently
   deleted on 7/8 real profiles. Explainer's prompt literally read
   "locked-off camera — the motion lives in the subjects themselves.
   Stationary at top position." — near-freeze by construction, on a scene
   whose own visual asks for a piston sliding down and mixture flowing in.
2. **The tempo collision.** `I2V_CAMERA_PHRASES` baked tempo words into
   the phrases themselves ("slow cinematic zoom in"), and the S50
   moveSpeed prefix then colored on top of them:
   - social (zoom-in + fast): "**Quick, energetic slow** cinematic zoom
     in" — a direct contradiction; the model resolves toward the weaker
     reading and the hook lost its energy.
   - islamic-history (zoom-in + slow): "**Slow, deliberate slow**
     cinematic zoom in" — doubled tempo, and the stills-blind rubric
     under-reads what remains a barely-perceptible move.
3. **A run-on seam.** The composition joined the subject clause and the
   scene visual with a bare space ("…on wet slate Hero product shot of
   …"), leaving the video model's prompt parser without a sentence
   boundary between the motion ask and the scene description.

The conclusion that matters: **the per-kind clause WORDING is not the
defect** — detail's texture motion, text's legibility law and
islamic-history's reverence stay exactly as doctrine wrote them. The
defect is that the doctrine was (a) deletable by a pose note and (b)
contradicted by the camera phrase. S63 repairs the plumbing, not the
doctrine. That is the line between fixing motion vigor and teaching to
the test.

## 2. The two laws (T-63.1, T-63.2)

- **T-63.1 — the tempo law.** Every camera phrase in
  `I2V_CAMERA_PHRASES` becomes tempo-neutral; tempo belongs EXCLUSIVELY
  to the moveSpeed prefix. Neutralized: "slow" (zoom-in, zoom-out,
  pull-out, drone), "fast" (punch-in), "gentle" (diag-tl, diag-br).
  After the law: slow + zoom-in reads "Slow, deliberate cinematic zoom
  in", fast + zoom-in reads "Quick, energetic cinematic zoom in" — no
  composition can contradict itself. Trade-off, stated honestly: a
  speed-unspecified zoom (legacy scenes with no plan shot) now says bare
  "Cinematic zoom in" instead of pre-slowed — production plans always
  carry moveSpeed (S48 defaults it), so the bare path is the legacy
  fallback only.
- **T-63.2 — the doctrine-always-rides law.** The director's
  `subjectAction` LEADS (its specific ask is still senior — that
  contract survives) but the per-kind `I2V_SUBJECT_MOTION` clause ALWAYS
  follows it. A pose grounds the subject; the kind clause carries the
  motion doctrine; neither can delete the other. The subject→visual run-on
  gets a real sentence boundary. The S50-era pin that asserted the kind
  clause "stepped aside" is deliberately revised — it captured the
  pose-kill as a contract.

## 3. Re-measurement, honestly attributed (T-63.3)

`scripts/s63-motion-vigor.mts` re-runs REAL CogVideoX i2v for all eight
profiles with the S62 plans and S62 art REUSED VERBATIM — no director
pass, no new art. The ONLY variable between the S62 clips and the S63
clips is the motion prompt (plus the gateway's own sampling noise). Each
clip goes through the same QC lenses and frame grabs as S62. Then
`scripts/s63-blind-score.mts` blind-scores the eight new clips under the
S62 protocol verbatim (shuffled pool A–H, generic rubric, one real vision
call per letter, fresh seed) and unmasks into a per-profile before/after
against the S62 scores. Evidence lands in `validation/s63/`.

What would falsify the repair: motion realism NOT improving on the
pose-killed/contradicted profiles (explainer, social, islamic-history)
while coherence or composition degrade — that would mean the doctrine
clause is noise and the tempo law cosmetic, and the record would say so.

## 4. The contract re-pinned (T-63.4)

The S62 test blocks that pinned the old strings verbatim ("Quick,
energetic slow cinematic zoom in", subjectAction REPLACES the kind
clause) are revised to pin the new laws, plus a tempo-law sweep: no
camera phrase may contain a tempo word, so no future phrase edit can
reintroduce the collision.

## 5. Gateway outage — the re-measure's first window (2026-11-09)

The laws landed and were CI-verified on `0c659b8` (run 42510992378,
6/6 green: check · coverage · postgres · build · gitleaks · e2e). The
re-measure then hit a hard gateway wall: the FIRST i2v submission
(social, ~18:22 UTC) returned 429, and from that moment the ENTIRE
z.ai account throttled — not just the video bucket but llmChat too
(probed at 18:37, 18:44, 19:06, 19:17, 19:27, 19:36, 19:45+, 20:00,
20:10, 20:20, 20:30, 20:39, 20:49, 21:02 UTC — every probe 429,
including after multi-minute full-silence backoff blocks and across two
hour boundaries).

Reading, stated honestly: this is NOT the 45s shared cool-down S62
documented (that window passed long ago), and probing neither extends
nor clears it (silence blocks changed nothing). The shape is a
long-horizon account quota — most plausibly yesterday's S62 stage
(~44 min of gateway video, 8 image calls, 8 vision calls, 8 director
passes) exhausting a daily window — or a platform-side incident. The
error body is a rate-limit shape ("Too many requests, please try again
later"), not an auth failure; the GitHub PAT is unaffected (CI ran).

**The lane is resumable by design and the stage stays OPEN until the
measurement lands.** Resumption protocol, exactly:

    node --import tsx scripts/s63-motion-vigor.mts --all      # ~40-50 min
    node --import tsx scripts/s63-blind-score.mts             # ~8 vision calls

The re-measure reuses the S62 plans and art verbatim, so NOTHING from
the outage window contaminates the attribution: the only variable
between the S62 clips and the S63 clips remains the motion prompt. The
lane already survived one partial attempt (social failed on 429 with a
failure manifest entry — reruns replace it). Falsification criteria are
unchanged (§3). The close commit lands only on real clips + blind
scores, per the stage law that took S62 from "assumed" to "measured" —
a laws-only close would repeat the sin S62's audit named.

Stage discipline: full local gate battery before any push; CI evidence by
SHA for the close; doctrine wording untouched.
