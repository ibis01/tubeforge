# W7 — the finishing layer

**Status:** LANDED (this commit). Stage spec: `docs/design/s120-2d-animation-roadmap.md` §3 W7 — hand poses, pen-up travel, occlusion/scale rules, left/right variants, and optional whiteboard SFX. Exit gate: no-teleport travel pinned; the mix inside the loudness contract; the editor round-trips the new fields.

## What landed

**The hand family (`assets.ts`).** The tool hands become a real family: `hand-marker` (existing art, now a named const), `hand-pencil`, `hand-chalk` (new art, house style), and per-asset LEFT mirrors (`hand-marker-l`, `hand-pencil-l`, `hand-chalk-l`) derived mechanically from the right art at module init — one art source, a mirrored clone can never drift, and the shared tip anchor (the box's horizontal center) survives the flip. Pose sub-assets: `hand-point` (index extended — arrows and emphasis), `hand-rest` (open hand — the scene tail). Every hand is AUTHORED to share ONE tip anchor — `HAND_TIP` (70, 150) — so the page's inner translate and the plan's follow math stay style/pose-agnostic; `HAND_TIPS` is the named tip registry (extending, never forking), and `handAssetIdFor(style, side)` is the one style+side → asset-id resolution (per-asset variants, never a transform hack). All eight register through the W3 validator (the hand tag's drawing-agent exemption applies).

**`handAt` extended (`timing.ts`).**
- **Pen-up travel** — the headline: between a stroke's end and the next stroke's start, the hand no longer vanish-reappears (the old pen-lift mask). It crosses the gap on an eased line between the two stroke endpoints with a sine pen-lift bump (`HAND_TRAVEL_LIFT` = 26 scene units up, `HAND_TRAVEL_SCALE_BUMP` = 0.05 scale) that is ZERO at both joints — the tip never teleports, the whole path sits inside the two endpoints' bounding box minus the lift (bounded by construction), and the pen angle takes the shortest-path lerp (tangents can wrap ±π). The travel holds the NEXT stroke's pose (the hand arrives holding the right tool). Deterministic: byte-identical double-run.
- **Poses** — `FrameHandState` gains `pose` (`write|draw|point|circle|rest`) and `scale` (the per-frame lift breathe; the applier multiplies it with the project's hand scale). Pose selection rides the W3 role metadata of the ACTIVE stroke: label → write, arrow → point, emphasis → circle, else draw; text targets write; the tail holds rest. Without a roles map the defaults apply (tolerant-read).
- The entry glide, the active follow, and the tail hold keep their S64 semantics (the existing pins held unchanged — the pen still enters easing-out and rests visible at the stroke end).

**The page (`wb-page.ts`).** The hand group becomes five pose groups (`data-pose="write|draw|point|circle|rest"`); the setup embeds the project's chosen tool hand in BOTH write and draw, `hand-point` in point/circle, `hand-rest` in rest. The applier toggles pose visibility per frame and multiplies the pose's lift scale — the one applier, both surfaces. The tips are shared, so the inner translate never moves.

**The renderer (`render.ts`).** The roles map (the W3 metadata per asset) builds once per render and feeds `frameAt` (and the editor does the same — one source). The tool hand resolves through `handAssetIdFor(project.hand.style, project.hand.side)` — `hand.style` finally RENDERS (marker/pencil/chalk were parsed but never consumed before W7).

**The whiteboard SFX (`sfx.ts` + `whiteboard/sfx-plan.ts` + `render.ts`).**
- Four recipes join the table, all low and dark (the taste bar): `pen-stroke` (a 180ms shaped-noise scratch), `pen-stop` (a darker 90ms lift tick), `page-turn` (a 500ms airy swish), `pop` (a 180→70 Hz thump — the REMOVED 880 Hz UI blip redesigned to the catalog's bar). `WB_SFX_KINDS` is the whiteboard kind set; the director lane's `SFX_KINDS` catalog is untouched (the engine consumes the recipes directly).
- **The cue plan is PURE** (`whiteboard/sfx-plan.ts`): pop opens the project; page-turn marks each scene start after scene 0 whose board is CLEAN (a continuous scene carries — no page event, the carry IS the continuity); every stroke/text cues a pen-stroke; a pen-stop fires only when the following gap ≥ `PEN_STOP_MIN_GAP_MS` (400ms — a 130ms flush-gap lift would flutter); the per-scene amix wall (`WB_SFX_CUES_MAX_PER_SCENE` = 48) drops overflow by priority (accents always survive), deterministic. The plan rides the SAME frame-quantized clock the tracks and the render loop read.
- **OFF by default** (decision §10.4): `project.sfxOn` (strict boolean parse, absent = off). When on, the layer assembles per scene (adelay + per-kind gain + amix normalize=0 + exact-duration pad, 48 kHz stereo PCM16), concats, and joins the final mix: the bed+VO+SFX three-way arm (and the no-bed/no-VO arms) under the UNCHANGED audiomix contract. Audio-only — frames never depend on it (the determinism law's audio corollary).

**The editor (`whiteboard-studio.tsx`).** New panels: the per-scene BOARD policy (mode select — scene 1's control disables itself; exit select; transitionMs), and HAND & SOUND (style, side, scale, the SFX toggle). The controls ride the existing immutable-buffer + dirty + save flow; every new field round-trips (the validator parses and re-emits `board`, `hand.side`, `sfxOn` — pinned).

## Proof

- House suite **590 → 597** (the W7 battery): the hand family registers (all eight, zero validator warnings; the left mirrors are the right art mirrored; the tip registry agrees; the style+side selector); **the pen-up travel** (visible in the gap — the old mask gone; joint-continuous at both ends; per-frame deltas bounded by the eased geometry; the lift reads above the straight line; the next tool held; determinism); the pose mapping (label→write, arrow→point, emphasis→circle, role-less→draw, text→write, tail→rest, tolerant defaults); `hand.side`/`sfxOn` round-trip; the four recipes synthesize REAL wavs through ffmpeg while the director catalog stays untouched; the cue plan (pop opens, page-turns mark only the wipes, pen-stops need the hearable gap, the cap keeps the accents, absolute clock times, refusal on disagreement); the compile-only seam pins (render wiring, page pose groups, editor embed, studio panels).
- **The W7 proof through the REAL engine** (`scripts/w7-finishing-proof.mts`, receipts in `validation/w7/`, gitignored): a two-scene pencil-hand project (scene 2 CONTINUOUS, carrying the heart with a fade exit; roles spanning draw/point/write) with synthetic VO slots on BOTH scenes + a music bed + `sfxOn: true`:
  - structural: the REAL schedule's gaps ride the travel (visible, per-frame jump ≤ 25.3px on the real 130ms gap); all four poses fire; the carry plan resolves; the cue plan plans pop + no page-turn + 16 pen-strokes for 16 strokes;
  - audio: the SFX layer spans the program exactly (13.00s ≈ clock.totalSec);
  - **the full QC battery GREEN on the three-way mixed final: loudness −16.4 LUFS, true-peak −11.9 dBTP, dead-air none, frozen-frames/static-shots/flicker/stutter pass** — the mix sits INSIDE the loudness contract with the SFX layer in it (the exit gate's judge).
- eslint . clean repo-wide; tsc clean.

## Honest edges

- **The W1 baseline frames move by design**: the pen no longer teleports between strokes, so every render's gap frames differ from the committed W1 baseline (the stage's PURPOSE — hand realism). The committed baseline JSON stays the honest BEFORE-picture; the W7 blind re-score kit (the rubric's protocol, ≥3 humans) is the after-picture. No gate run was staged to watch it go red — the change is the spec, the proof is the new behavior's receipts.
- Pen-stop cues accent only the hearable gaps — continuous rapid stroke chains stay silent between strokes by design (flutter would be worse than silence).
- The SFX v1 is event-ACCENTS, not continuous foley: a stroke longer than the 180ms scratch draws silently after its touchdown cue.
- Pose art is shared across left/right (the tool hands carry the side); a left-specific point/rest is art future work.
- The travel's lift (26 units) and scale breathe (0.05) are taste constants, easy to retune; the unit pins assert their EXISTENCE (bounded motion, lift above the line), not their aesthetics.

## Rollback

SFX: `sfxOn` defaults off and the layer is event-driven — flipping a stored doc's flag restores silence; the recipes are leaf table entries. Hand: the travel/pose code lives in ONE function (`handAt`) — reverting it restores the pre-W7 pen byte-for-byte; the hand variants are per-asset adds nothing else consumes.
