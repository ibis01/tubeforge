# W4 slice 3 — the captions lane's alignment becomes the spoken schedule

**Status:** SLICE 3 LANDED — the voice-anchor bridge, the render-caller wiring, and the fixture proof. The W4 exit gate ("anchor alignment tolerance pinned; fill law byte-identical when anchors absent; readability threshold passes per aspect") is now covered end-to-end: slice 1 pinned the schedule contract, slice 2 the glyph text, slice 3 the alignment source.

## What landed

**`whiteboard/voice-anchors.ts` — the bridge.** The captions lane already knows where speech happens (`detectSpeechRuns` — ffmpeg silencedetect −35 dB / 0.30 s) and where each narration chunk lands inside it (the greedy transcript cursor, or the word-count fallback — `buildSmartSrt`'s machinery). The bridge refines those chunk windows to **per-word spans** in the `WordAnchors` contract the beat plan consumes (slice 1):

- chunk window = `wavChunkWindows(ends, totalWords, runs)` — a NEW exported helper in `captions.ts` that is now the ONE chunk↔clock mapping; `buildSmartSrt` was refactored to ride it too (the SRT cues and the whiteboard strokes read the same windows — the one-source law, no forked second implementation);
- word k of chunk i = an even slice of that window across the chunk's beat-tokenized words (`beat-plan.ts`'s `words` — now exported, the one tokenizer; the anchor index space and the sentence windows share it);
- the degradation ladder is the captions lane's own, restated: ASR answers → chunk boundaries follow what was actually SPOKEN; the ASR pass fails or is disabled → silence-run-refined narration timing; no VO or no speech structure → `null` and the caller keeps the word-proportional estimator **byte-for-byte** (the slice-1 hard pin). The ladder never throws.

**The render caller (`whiteboard/render.ts`).** `RenderWhiteboardOptions.asrAnchors?: boolean` — when set, the pre-flight builds per-scene anchors from the VO slots (before chromium launches; a scene that degrades just stays on the estimator) and the loop feeds them to `beatSceneEvents`. The lane caller (`video-jobs.ts`) opts in on BOTH paths (preview + full render) — the editor preview and the final render share one spoken clock. With the flag off (and for anchorless scenes) the schedule is byte-identical to before — the W1 harness gate re-run GREEN after the wiring.

**Exports unlocked in `captions.ts`:** `chunkEndPositionsByTranscript`, `chunkEndPositionsByNarration`, `wordPosToTime`, `snapToPause`, `wavChunkWindows`, `tokenizeKeepAll` — the whiteboard consumes them; nothing was re-implemented.

## The proof (`scripts/w4-anchors-proof.mts`)

Fixture VO: three gated 440 Hz tone bursts at exact times (1.0–2.1 / 2.6–3.7 / 4.2–5.3 s, digital silence between) — speech structure KNOWN BY CONSTRUCTION. Narration: three sentences of five beat tokens each (equal words against equal bursts). Receipt: `validation/w4/w4-anchors-proof.json` (gitignored).

- **The roadmap's tolerance pin:** `|beatWindow − speechRun| ≤ 600 ms` — measured deltas `[0, +500] / [0, +500] / [0, 0] ms` (the +500s are the mapping's known shape: a chunk window leads its run by the preceding pause — the pen starts as the phrase begins). Every sentence window **contains** its run — the strokes never finish before the words do.
- **The ladder under adversarial input:** this machine's ASR gateway ANSWERED on a tone burst (empty transcript → retries → a nonsense transcript) — the ladder absorbed it, the anchored render stayed QC-green. Honest degradation is not just a try/catch shape; it survived a real garbage transcript.
- **The two schedules:** estimator first stroke at 400 ms (the lead-in), anchored first stroke at 1000 ms — ON the first burst. The visual waits for the voice.
- **The engine, both modes:** estimator and anchored renders through real chromium+ffmpeg, the full house QC battery GREEN on the 16:9 render (cut-alignment honestly unmeasured).

House suite **577 → 581** (the count contract incl. hyphens/decimals/apostrophes; exact spans vs hand-computed windows; the schedule integration — the anchored clock starts inside the spoken window and differs from the estimator; the compile-only source pins: the render seam, both caller sites, the shared mapping, no forked tokenizer). `eslint .` clean repo-wide; tsc clean.

## Honest edges

- **The tolerance is pinned on the narration-proportional arm.** The ASR arm's chunk boundaries are only as good as the transcript; a misheard word shifts its chunk (the greedy cursor tolerates small skips) — the envelope and count guards catch structural drift, and everything else degrades to the estimator. Real-TTS + real-ASR alignment quality rides the staging rehearsal.
- **The ASR cost is real:** one transcribe call per voiced scene per render (the smart-captions lane's own cost), plus the retry cadence on empty transcripts. Production enablement (`asrAnchors: true` at the caller) is wired; a latency/cost receipt belongs to the staging drill.
- **Per-word spans are even slices of their chunk window** — within-chunk prosody (a stressed word held longer) is not modeled. The beat plan consumes sentence-level windows, so this only matters for future per-word consumers (K1's mouth beats).
