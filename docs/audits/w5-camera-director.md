# W5 — the content-driven camera director

**Status:** LANDED (this commit). Stage spec: `docs/design/s120-2d-animation-roadmap.md` §3 W5 — the highest-risk stage, landed as ONE atomic slice: director + demotion + QC proof (the reconciliation §8.1 law: "shipping the director alone changes nothing; demoting drift alone fails QC" — both halves proven below, including the predicted failure mode, reproduced once and fixed in the same slice).

## What landed

**`src/lib/tubeforge/whiteboard/camera-director.ts`** — pure, deterministic:

- `directCamera(scene, width, height, durationMs, geometry, events, opts?)` — the W2 beat plan (ONE planner, two consumers) → per-beat focus rects (union of the beat's placements' transformed flattened-geometry bboxes, padded once at framing time) → `CameraEvent[]`:
  - keys[0] frames beat 0 from the scene's first frame (content-driven origin — never the blind center default);
  - each later beat's travel STARTS at/after the latest stroke onset before the beat's own and COMPLETES by the beat's first stroke onset (the camera rests when the pen lands — the stable writing window, by construction);
  - when the schedule gives no room (W2's interleaved windows: a tight beat's min-clamped strokes spill into the next beat's airtime), the beat MERGES into the resting framing — the camera frames the whole composition instead of panning blind;
  - the closing move: a directed scene's static tail (beyond the last stroke) gets a slow settle-out (~6% wider, spanning the whole tail) — the drift used to keep that tail alive for QC; the director now does, content-driven.
  - ≤1-beat scenes return `[]` — no content story to traverse, the drift fallback owns them.
- `cameraPolicies(keys, events, width, height)` — the pure policy set, each violation carrying `{policy, reason, keyIndex}`: `min-travel` (a moving key under 120ms is a jump-cut), `zoom-speed` (|Δscale|/s ≤ 0.4), `containment` (the viewport stays on the board with 24-unit safe margins), `onset-stability` (a TRAVELING key may not have a stroke onset in flight — held framings never violate).

**The demotion (timing.ts `cameraAt`)** — the drift is no longer unconditional:
- a CAMERALESS scene (`camera.length === 0`) keeps the fallback drift **byte-for-byte** — the W1 harness GATE GREEN re-run proves the frozen baseline untouched;
- a KEYED scene rides its keys PLUS `directedBreath(tMs)` — the DIRECTED lane's motion floor. The honest finding (twice reproduced in proof runs): a fully-static directed camera FAILS frozen-frames (thin-ink stroke deltas sit under freezedetect's 0.4% noise floor — the drift was load-bearing for the lenses themselves), and a weaker breath starves the floor at ~0.3px/frame. So the directed floor IS the calibrated Lissajous — but its meaning changed: it breathes AROUND whatever the director framed (keys lead, floor follows) instead of wandering blind from the scene center. The camera goes where the content says; the calibrated micro-motion can no longer wander away from it.

**The validator (storyboard.ts)** — authored camera keys are CHECKED, never clamped: `cameraPolicies` runs per scene (animations are in scope), violations become validation errors naming the policy. Cameraless docs stay EMPTY (the default-key insertion is GONE — an inserted key would silently demote the drift on every stored doc; the render-time fallback centers on the project's own dimensions anyway, the same numbers, one source). The S68 dimension-aware-center pin moved to render time accordingly; the studio's own key UI (800ms travels, centered) passes the policies by construction.

## Proof

- House suite **568 → 572** (the W5 battery: director determinism; ≤1-beat → []; crafted violations fire per policy with readable reasons; held framings never violate; validator REJECTS a zoom-speed-violating doc and accepts the same doc with a sane travel; the directed W1 benchmark keys pass every policy on all three aspects with zoom ∈ [1, 1.6] and centers on-board — the per-aspect framing receipts; the keyed/cameraless motion lanes pinned exactly).
- **The exit gate — QC GREEN on the W1 benchmark with the drift demoted** (`scripts/w5-camera-proof.mts`, receipts in `validation/w5/`, gitignored): every benchmark scene directed (where the beat plan has a story to frame — 1 scene per aspect; the rest honestly stay cameraless with their drift), rendered through the REAL engine, FULL house QC battery per aspect: **16:9 GREEN, 9:16 GREEN, 1:1 GREEN** (cut-alignment reports unmeasured — there is no shot plan on a doc-less whiteboard render; recorded, not failed, per the three-state contract).
- **The W1 baseline freeze**: the harness GATE GREEN against the committed baseline after the demotion — cameraless scenes render byte-identical frames. The committed baseline JSON stays the before-picture (the harness's dated local receipt removed).
- The predicted failure, reproduced and fixed in-slice: the first demoted render failed frozen-frames (static directed camera) — the exact "demoting drift alone fails QC" the reconciliation §8.1 named. The fix (the anchored motion floor + the closing move) is part of this slice, with both failed runs recorded in the worklog.

## Honest edges

- The benchmark's short copy yields mostly single-beat scenes — the director honestly returns [] there (nothing to traverse) and the drift fallback keeps them alive; the directed evidence is w1-process (the one multi-beat scene) × 3 aspects, plus the director pins on synthetic multi-beat fixtures.
- `directedBreath` delegates to the calibrated drift (same amplitudes/periods/swell) — the demotion is the ANCHORING (keys lead), not a weaker motion; two proof runs are the receipt for why (static and slower floors both starve the noise floor).
- The closing move widens the composition around its center by ~6% — a taste constant, policied for speed, easy to retune.

## Rollback

Revert `cameraAt`'s keyed branch to unconditional drift (one boolean-shaped change) → keyed scenes render as pre-W5; the validator's policy call site reverts to accepting all keys; the director is a leaf nothing else imports.
