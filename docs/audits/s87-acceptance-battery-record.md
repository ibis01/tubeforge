# S87 — the §4.C acceptance battery record (the Universal Timeline close)

**Date:** 2026-11-11 · **Slices:** S87 slice 5 (the ladder's last brick)
**Battery:** `scripts/s87-acceptance-battery.mts` · **Receipt:** 18/18
checks green in 18.9 s (local run, 2026-11-11T08:24:26Z) — wired into CI
as a step of the E2E job (chromium + ffmpeg are its tools; the battery
spends $0 AI).

**The question it answers** (S76 §4.C, the adoption decision's close
condition for the timeline track): does every TubeForge engine describe
its cut ONE way — and do the delivered pixels honor that one
description? The battery is the artifacts half of the S76 standard
(deterministic pins live in `scripts/test-unit.mts`, slices 1–4: parity,
round-trip byte-identity, the two-clock pin, kind completeness); it
renders REAL videos through BOTH engine lanes on tiny fixtures and holds
the output to the contract mechanically. It never claims visual quality —
the artifacts stay for human review.

## The conditions, and how each is proven

| § | Condition | Battery evidence (real renders) |
| --- | --- | --- |
| 4.C-1 | Whiteboard, stock and generated clips all render through the contract | **A** the Whiteboard engine's real chromium render composes on the frame-quantized tracks (the returned plan IS the tracks read; re-derivation byte-identical; windows 0-4 / 4-8.33 / 8.33-12.33). **B** the compositor's real kenburns render reads the schema-2 doc through the TRACKS (origin ledger `tracks`), the plan feed driving durations and kinds; the row geometry holds. |
| 4.C-2 | Narration, music, SFX and subtitles stay synchronized | **A** the VO-carrying scene keeps its narration (apad to the window, 4.333 s ≡ 4.33 ±0.06); the final carries the mixed audio (VO slot + the ducked bed). **B** the final carries the narration segments riding the plan windows. |
| 4.C-3 | Transitions preserve exact timing | **A** every per-scene encode lands on its contract window (±0.06 s); the concat total ≡ the contract total (±0.25 s). **B** the hard cut sits EXACTLY on the contract boundary (`expectedCuts [4.2] ≡ the plan boundary 4.2`), and the delivered total ≡ the plan total (8.944 s vs 8.9 ±0.25 — cuts add no overlap). |
| 4.C-4 | A saved timeline reopens and renders identically | **B** the saved doc reopens and re-serializes byte-identically (1883 bytes); the render's own clock agrees with the delivered file. **A** the engine's tracks re-derive byte-identically from the same frame plan (the derive-at-render projection law). |
| 4.C-5 | Every future engine can produce compatible timeline assets | **A** the engine-authored tracks parse through the SAME `planFromTracks` reader with the scaffold's row linkages intact (`sceneIndex [1, 2, 3]`) — the structural `{ tracks }` carrier is the entire integration surface a new engine must speak. |

## The find: a real engine bug the battery caught on its first run

Part A's fixture deliberately mixes duration sources (explicit /
VO-measured / narration-estimated) AND voice coverage (scene 2 voiced,
scenes 1 and 3 silent) — the honest production shape of a user voicing
some scenes. **The first run crashed at final assembly**: the concat
demuxer is stream-homogeneous, and a silent scene file ahead of a voiced
one left `[0:a]` matching no streams at the amix seam (the S75 E10 fix
assumed every scene carries VO when any does — true of the full-VO
renders it was debugged on, false the moment coverage is partial).

**The fix** (`whiteboard/render.ts`, landed with this slice): when ANY
scene carries VO, every scene file now carries an audio stream — VO-less
scenes fill with `anullsrc` under the same `apad`/`-t` bounds; a FULLY
silent project keeps today's video-only shape (the silent-draft law
unchanged). The re-run: 18/18 green, the mixed-audio final verified.

## Receipts (human review)

- Part A artifacts: `/tmp/s87-battery/whiteboard/` — `final.mp4`
  (640×360@24, 12.37 s, audio present), per-scene encodes at the plan
  windows, the VO slot + bed fixtures, `concat.txt`.
- Part B artifacts: `uploads/s87-battery-compositor/` — `final.mp4`
  (16:9@24, 8.94 s, hard cut at 4.2 s, narration audio), the synthetic
  art/WAVs, the 1883-byte contract doc that round-trips byte-identically.
- The full check ledger: `battery-report.json` beside the artifacts.

## What this closes — and the one recorded tail

The ladder (S87 §3) is complete: stamp → dual-write + guard → compositor
reads tracks → Whiteboard emits tracks → the legacy collapse's pre-soak
bricks + soak gate → **this battery**. ROADMAP #6's Universal Timeline
contract is CLOSED at the code level. The one recorded tail is the
slice-4 SOAK GATE (design doc §13): the `scenes[]` slimming to a
settings-only schema 3 and the v1 fallback retirement wait on a ≥14-day
production soak with zero v1-doc renders — an operator-verified
precondition, not a code task.
