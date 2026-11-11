# S89 — Advanced stock retrieval (design + v1)

**Status:** v1 implemented — the source adapter contract, the candidate
index, the ranker, the multi-frame verifier, the extended ref + tolerant
round-trip, the pins (16, unit 444/444), and the real-artifact smoke
(`scripts/s89-stock-smoke.mts`, 17/17 green 2026-11-11). Spec source: the
S76 adoption decision §5 P2 + §6 acceptance row ("Source metadata,
license, relevance, duplicate checks — No unverified footage silently
accepted").

**The question it answers:** "Can the b-roll lane pick footage the way an
editor does — see the whole field, weigh what matters, and never trust a
thumbnail?" The pre-S89 lane searched per-query, scored on
resolution/duration alone, and verified ONE frame at t=1s, failing open
silently. S89 turns it into: one ranked pool per scene, evidence-based
acceptance, and a verification record on every accepted ref.

## 0. The laws this module serves

1. **THE LICENSE LAW**: a candidate without a license label never enters
   the index (`mergeIntoIndex`), and the ranker floors it again
   (defense in depth). An adapter that cannot state the license terms
   its results carry contributes nothing. Both current adapters stamp
   their platform's constant: "Pexels License", "Pixabay Content
   License".
2. **Never-silent verification** (the acceptance row): verdict "pass"
   on a ref is constructible ONLY through ≥2 passing sampled frames
   (`combineFrameVerdicts` — the never-silent pin enumerates every
   3-frame combination). A fail-open accept (VLM outage, extraction
   failure) is stamped verdict **"unverified"** with its evidence
   counts, surfaced in `GET /api/videos/[id]/stock`. No unverified
   footage is silently accepted — it is visibly, mechanically unverified.
3. **One source at a time** (S76 §5 P2): "evaluate Wikimedia Commons,
   NASA, Internet Archive and NOAA individually — do not integrate
   every source at once." v1 ships the CONTRACT with the two existing
   providers as its first adapters; the public-archives evaluation is
   §6. A third adapter is a deliberate, individually-reviewed addition.
4. **Determinism**: the walk order (score desc, then `source:id` asc)
   is input-order-independent — pinned. The same index always produces
   the same candidate walk.
5. **Duplicates: deprioritized, visible, never banned**: a clip already
   placed on another scene of the same video takes the fixed
   `DUPLICATE_PENALTY` (1000) — every fresh candidate outranks it, its
   factor breakdown shows the penalty, and it remains reachable as a
   last resort (banning it could starve scenes in a thin market).

## 1. The architecture (three new modules, one rewired orchestrator)

| Module | Role | Test surface |
| --- | --- | --- |
| `stock-index.ts` | the `StockSourceAdapter` contract; Pexels + Pixabay adapters (pure `pexelsParse`/`pixabayParse` normalizers); `buildSceneIndex` — every scene query × every configured source, fail-soft per (source, query), deduped by `source:id` with `matchedQueries` union | normalizers + merge + `configuredSources` pinned offline |
| `stock-ranker.ts` | PURE: floors (`candidateFloors`), factors + weights, `rankCandidates`, the verdict reducer (`combineFrameVerdicts`), `stockFrameTimes` | fully pinned (16 pins) |
| `stock-verify.ts` | the I/O lane: `probeDuration` (ffprobe), interior frame extraction, SEQUENTIAL relevance judging with early exit, `measureMotionDelta` (ffmpeg blend=difference + signalstats YAVG), `verifyClip` orchestration with an INJECTABLE relevance gate | the smoke runs the real ffmpeg path with injected verdicts |
| `stock.ts` (rewired) | keys, orchestration, download, ref construction | unchanged seams: `searchAll` compat (the Settings key tester), the pinned no-provider error, incremental persist, pacing sleep |

`searchAll(query, keys)` survives as a thin wrapper over the registry —
the Settings POST key-tester is untouched, and the no-provider error
stays byte-identical (the queue suite asserts it).

## 2. The ranker (factors, weights, floors)

Hard floors (dropped, named reasons — pinned): no license · no stable
id/url · below 1280×720 · portrait · under 2s.

| Factor | Weight | Notes |
| --- | --- | --- |
| duration fit | 40 | covers the scene = 1.0; else the ratio (loop-free is still dominant, as in the pre-S89 score) |
| resolution | 20 | 70% linear sharpness (capped 4K) + 30% the ≥1080p step |
| aspect | 10 | closeness to the 16:9 delivery target |
| semantic | 30 | tag∩terms overlap (Pixabay carries tags; Pexels video search does not — NEUTRAL for tag-less, never a penalty) |
| duplicate | −1000 | fixed, visible in `factors.duplicatePenalty` |

## 3. The verification lane (the S76 upgrade: multi-frame, not one)

`verifyClip` per downloaded candidate:

1. **ffprobe the real duration** (provider metadata is the fallback).
2. **Interior frames** (`stockFrameTimes`, default 3): evenly spaced
   k/(n+1) points — 1.5s/3s/4.5s on a 6s clip — dodging opening fades
   and end cards. Degenerate clips (<1.5s) get one mid-frame.
3. **Sequential judging, early exit** — the cost law: a clearly
   relevant clip stops at 2 gate calls, garbage stops at 2, a VLM
   outage stops after 2 unchecked frames. The multi-frame evidence
   WITHOUT 3× the VLM spend (the smoke proves each exit at exactly 2
   calls). Frames are extracted upfront (cheap); only the gate exits.
4. **Motion, measured not guessed**: mean luma difference between the
   first and last extracted frame (`blend=all_mode=difference,
   format=gray, signalstats` → YAVG). Below `MOTION_STATIC_MAX` (1.0)
   the clip is a STILL — rejected even when the gate loves it (a
   frozen frame in an mp4 is the Smart Motion art lane's job, and the
   art lane renders stills natively). Measurement failure (null) never
   rejects.
   *Calibration receipt (smoke, 2026-11-11): animated testsrc2 at
   640px → YAVG 3.82; a frozen solid frame → 0.000.*
5. **The reducer** (order matters): static → reject · ≥2 failing
   frames → reject (a single odd frame — a title card, a cutaway — no
   longer rejects, the one-frame gate's known over-rejection) · ≥2
   passing frames → accept · else unverified (fail-open, recorded).

## 4. The surface (additive, tolerant, s3-safe)

- **`StockRef` grows five optional fields**: `license`, `providerId`
  (the dedupe key), `width`, `height`, `verification`
  (`{framesSampled, framesPassed, motionDelta, verdict, summary}`).
  `parseStockRef` carries them with per-field tolerance: a legacy ref
  parses with them absent; a bad verification record drops the RECORD,
  never the ref. Round-trip pinned both ways.
- **`GET /api/videos/[id]/stock`** exposes per scene: `license`,
  `verified` (`"pass" | "unverified" | null`), and the verification
  counts — the acceptance state is in the API, ready for the studio
  badge (the tail).
- **Cross-scene duplicates**: `fetchStockForScenes` seeds the
  `usedClipKeys` set from every placed ref (legacy refs without
  `providerId` contribute nothing — recorded, not guessed) and joins
  each accepted ref as the run proceeds.
- **The s3 latent fix**: the verifier reads the clip through
  `storage.withLocalFile` and the has-clip probe through
  `storage.exists` — the pre-S89 code hit the local filesystem
  directly (correct under the local driver, broken under s3).
- **The probe change**: the has-clip check drops the local 200KB size
  heuristic in favor of the driver-safe existence probe;
  `downloadClip` still enforces the 200KB floor at write time.

## 5. The proof

- **Unit (16 new pins, suite total 444/444)**: adapter normalization
  (landscape/largest-file/license/id/tags), index dedupe + the license
  law, the pinned no-provider error, floors, each factor's decisive
  pin, duplicate visibility, deterministic tiebreak, the verdict table,
  static-motion precedence, frame times, the never-silent enumeration,
  the ref round-trip (new fields survive; legacy + bad-record shapes).
- **Smoke (17/17)**: two synthesized 6s clips (moving vs frozen)
  through the REAL probe/extract/motion/combine path with injected
  verdicts — duration read, motion 3.82 vs 0.000, every early exit at
  exactly 2 gate calls, the static catch, the outage fail-open, the
  ranker walk order on a mixed pool.

## 6. The public-archives evaluation (S76: individually, never batched)

Recorded 2026-11-11, for the day a third adapter is proposed:

- **NASA** (images.nasa.gov API): public domain, keyless — the recorded
  FIRST candidate. Blocker to verify before any adapter: many "video"
  items are YouTube embeds or image collections, not direct mp4s; the
  adapter needs a response-shape audit against live fixtures and a
  "direct file only" rule.
- **Wikimedia Commons**: per-file licensing (CC variants + attribution
  strings that must be parsed per item, not stamped per source) — the
  license law requires a per-item license statement; defer until that
  is modeled.
- **Internet Archive**: advancedsearch API; license varies per item
  (some rights-reserved) — same per-item licensing blocker.
- **NOAA**: no unified public video API — defer.

The bar for source #3: a source-level license statement OR per-item
license retrieval, direct downloadable files, keyless or
key-obtainable, response shape verified against live fixtures.

## 7. Recorded tails

1. **The studio verification badge** — the API carries the state; the
   Stock panel UI does not render it yet.
2. **Perceptual cross-provider duplicates** — two providers can carry
   near-identical footage under different ids; `providerId` dedupe
   cannot see it. The arthash dHash seam on sampled frames is the
   natural instrument (pre-download cost is the open question).
3. **The third adapter** (NASA) — §6.
4. **Reference-analysis query steering** (the S88 tail): the reference
   doc's pacing/beat shape could weight the ranker's duration-fit
   target per scene — the seam is `RankContext`, no schema change.
