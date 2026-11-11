# S92 — Narration pacing intelligence (design + v1)

**Status:** v1 implemented — the pure measurement module (`pacing.ts`, 5
pins), the report route (`GET /api/videos/[id]/pacing`), the measured
pacing strip in the Script tab (`pacing-strip.tsx`), unit 464/464 green
2026-11-11. Spec source: the S76 audit table row "Audio — Broad
TTS/music/SFX tools → Audio production pipeline → **Improve
intelligence**" + the critic's audio dimension.

**The question it answers:** "How fast did the narration ACTUALLY read?"
The pacing targets have always existed (SCENE_COUNTS retention tuning,
the approved Director plan's per-scene slow/normal/fast hints →
pacingSpeedFactor 0.88/1.0/1.12, the video-level ttsSpeed) — but nothing
ever measured the delivered pace. S92 measures it from the REAL
artifacts: per-scene WAV durations ÷ narration word counts = delivered
WPM, judged against documented bands, proposed back in the system's own
vocabulary.

## 0. The laws

1. **Measure, don't guess.** The estimate everywhere else ("≈ 2 min at
   1.0x" at 2.6 words/sec) is a TTS refiner; the pacing strip is the
   MEASUREMENT. A scene without a synthesized WAV yet is "unmeasured" —
   the report says so, never fakes a pace.
2. **Speak the system's own vocabulary.** The proposal is the plan's
   pacing hint (slow/normal/fast) with the PROJECTED WPM each hint
   would deliver (current × pacingSpeedFactor) — never an abstract score.
   "normal" when in-band: never churn a scene that measures fine (a brisk
   hook FITS its role — the pin holds it).
3. **Roles have different targets.** Hook scenes (scene 1 + every
   re-hook) target 185 wpm (brisk earns attention), body 155, close 150.
   A 190-wpm hook is in-band; the same number on the close is rushing.
4. **English-first, honestly scoped.** The bands (<130 dragging · 130–175
   measured · 175–205 brisk · >205 rushed) are English-narration
   calibrated — the product's TTS voices and retention tuning are
   English-first. CJK narration counts per CHARACTER (one hanzi ≈ one
   word-equivalent) so the ratio stays proportional; the API response
   states the scope rather than mis-banding silently.

## 1. The shape

`GET /api/videos/[id]/pacing` (story format): per scene `{wpm, band,
role, words, durationSec, hint, projectedWpm}` + the summary a creator
reads first (`medianWpm`, `inBand`, `toSpeedUp`, `toSlowDown`,
`unmeasured`) + the current hints the APPROVED plan already gives +
the video-level speed. Durations come from the real scene-XX.wav headers
(`wavDurationSec` through the storage seam — a scene without a WAV is
unmeasured). Story format only: the classic format reads as one piece
(recorded, not half-modeled).

**The UI** (`pacing-strip.tsx`): one line under the Script tab's
estimate — "measured pacing: 148 wpm median · 2 drag · 1 rush" —
expanding to the offenders with their proposed hints and projections.
ADVISORY ONLY: it never re-synthesizes anything.

## 2. The proof (5 pins)

countWords (English tokens; CJK per-character — the fixture itself got
corrected twice in review, the code was right) · sceneWpm (exact
arithmetic; too-little-speech and no-WAV and sub-0.2s blips are
unmeasured) · the bands + roles (hook by index AND rehook; close by
position; single-scene = hook) · pacingProposal (drag → fast with the
projected 112, rush → slow, in-band → normal, brisk-hook → normal, the
float noise rounded) · pacingReport (the exact summary: median 175,
inBand 2, one drag one rush; a missing WAV lands unmeasured and drops
from the stats honestly).

## 3. Recorded tails

1. **One-click apply** — the hint proposals route through existing lanes
   (the plan hint is direction — the approved-plan edit law governs it;
   the video-level ttsSpeed has its studio control + re-synthesis lane);
   v1 is advisory by the same law as S90.
2. **ASR-timed precision** — word-level timings from the verify lane
   (the S88 tail) would refine WPM into per-sentence drift.
3. **Music/bed balance intelligence** — ducking effectiveness on the
   final mix (bed level under speech vs in gaps) rides the same
   report shape when the mix stems become persistently available.
4. **Classic-format pacing** — one read, one measurement; the route
   refuses honestly today.
