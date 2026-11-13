# W3 — the stroke-authored asset validator

**Status:** LANDED (this commit). Stage spec: `docs/design/s120-2d-animation-roadmap.md` §3 W3. Ground truth: the single-subpath/no-teleport law was convention-only — the S67 receipt records the hand-split of the prototype library, but nothing gated the law; a multi-subpath path rendered a teleporting pen with no check firing.

## What landed

**`src/lib/tubeforge/whiteboard/asset-validate.ts`** — pure, deterministic, no fs/clock/randomness. Six checks over the extracted geometry, each returning `{ok, reason, pathId?}`, aggregated by `validateAsset(asset) → {assetId, ok, findings}`:

| Check | Law | Fires on |
| --- | --- | --- |
| `checkTeleport` | a path is ONE continuous stroke (mid-path `M`/`m` = the pen teleports; <2 drawable points = nothing to trace) | the exact defect the S67 hand-split fixed |
| `checkSelfIntersection` | proper interior crossings on the flattened polylines (uniform-grid cull under the 512-command wall); endpoint touches are NOT crossings — closed shapes legitimately close onto their start, strokes legitimately end on earlier strokes (a T); collinear retrace is invisible ink | figure-8 bowties |
| `checkCaps` | a pen declares a usable `stroke-width` (0 < w ≤ 64) and a legal `linecap` (`butt\|round\|square`); declared `penGroups` hold ONE pen (members match the group reference) | stroke-width="0", typo caps, ragged groups |
| `checkClosedDirection` | a closed shape must wind (net signed area ≠ 0 — a retrace has no inside to order a fill) | out-and-back "closed" lines |
| `checkFillAfterOutline` | a pure fill (no stroke) must follow a containing stroke outline in draw order; the hand asset is exempt (the drawing agent leads its document by design) | fill-before-boundary |
| `checkOrientation` | arrows point where their stem ends (head centroid within 35% of the viewBox diagonal of the stem tip); label anchors stay inside the viewBox | flipped/detached heads, off-box labels |

**Metadata (reconciliation §5.3, additive + tolerant-read):** `WhiteboardAsset` gains optional `role` (`outline|fill|label|arrow|emphasis`), `penGroups`, `drawOrder`, `durWeight`, `framing`, `alts`, `a11y`. Old parsers ignore every field; `drawOrder`/`durWeight`/`framing`/`alts`/`a11y` are declared now and consumed by W4/W5/W7. `extractAsset` enriches each path with `stroke`/`strokeWidth`/`linecap`/`fill` and each rejection with the exact numbers (`detail`).

**Three-tier deployment (the risk register's over-rejection answer):**
- **built-ins** — `loadLibrary` runs `validateAsset` on every built-in and THROWS on failure (a built-in failing its own validator is a programming error, never a data condition);
- **uploads** — `validateUploadedSvg` runs the validator LAST (after the seven existing gates) and rejects with the findings' readable reasons;
- **library loads** — failing uploads are warn-and-EXCLUDED: never registered, reasons returned in `loadLibrary(...).warnings` (passesthrough on `loadVideoLibrary().warnings`), no document is ever touched (this module never sees one).

**Extended starter pack (8 new assets, education/business/science/process):** `graduation-cap`, `open-book`, `target`, `pie-chart`, `flask`, `atom`, `gear` (with a declared `penGroups` — the group law has a passing home), `flow-steps`. Every path hand-authored to pass every check; the library is 26 assets (+18 over the S65 floor). `arrow-curve`/`arrow-return`/`arrow-growth` declare `role: "arrow"`.

**Golden frames:** `scripts/w3-asset-golden.mts` renders one minimal scene per built-in asset through the real engine and hashes each scene's draw-complete frame into `docs/baselines/w3-asset-golden-2026-11-13.json` (chunkable via `--assets`, upsert-merge, no timestamps — byte-stable per toolchain).

## Proof

- House suite **546 → 556** (the W3 battery: every check fires on a crafted-bad fixture; every built-in passes its own validator; double-run byte-identical reports; warn-and-exclude excludes without mutating; the upload gate's copy is readable; the S69 happy path survives the new gate; pen attributes ride extraction). `tsc --noEmit` clean; eslint clean on every touched file.
- Validator smoke over the live library: 26 built-ins, 0 failing; 6/6 crafted-bad fixtures fire the intended check.
- The one pin updated (intent preserved): S65's rejected-array assertion now carries the W3 `detail` numbers.

## Honest edges

- `checkSelfIntersection` tests PROPER crossings only; a mid-path collinear overlap (the pen retracing its own line) is invisible ink and deliberately out of scope; closed zero-area retraces are `checkClosedDirection`'s business.
- `checkOrientation`'s arrow law is geometric (head near tip), not semantic — a "correct" arrow with an absurdly long stem passes; the 35%-of-diagonal bound keeps the honest class (flipped/detached heads) gated.
- The golden receipt hashes each scene's draw-complete frame decoded as RAW-RGB from the persisted per-scene MP4 — the W1 harness's own codec-independent hash law, not the renderer's transient JPEGs (render.ts deletes frames after encoding). The W1 harness remains the pixel-law gate for the benchmark scenarios; this receipt extends the same law to every library asset.

## Rollback

The validator is an additive gate: revert the `loadLibrary`/`validateUploadedSvg` call sites and the engine renders exactly as before. Metadata fields are optional and ignored by old parsers (tolerant-read law). The starter-pack assets are library rows — delete to revert.
