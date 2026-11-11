// composition-plan.ts — S87 slice 2: the compositor's plan from the v2
// tracks projection (the Universal Timeline contract's composition clock).
//
// The slice-2 law: when the saved timeline doc carries schema 2, the
// render's composition truth (per-scene windows, boundary transitions,
// per-scene visual KIND + asset source) is read from the TRACKS the doc
// carries — not from the scenes list — and PARITY PINS prove the two
// derivations agree exactly, so the switch is behavior-neutral for every
// doc today's engines write (homogeneous kinds). v1 docs keep the legacy
// scenes derivation verbatim; a schema-2 doc whose tracks are misaligned
// or junk falls back to scenes (the fail-open law — never a half-read
// plan).
//
// What the plan owns vs. what stays behind:
//   • OWNED (the composition clock): per-scene start/end/duration, the
//     boundary transition INTO each scene, the visual kind (video|image|
//     whiteboard) and the asset source (ai|stock|slides). These are exactly
//     the facts the visual track's clips carry (slice 1's deriveTracks; the
//     whiteboard engine's own derivation since slice 3).
//   • NOT OWNED: per-scene mix levels, captions, creative overrides (the
//     S2 doctrine — clips reference scenes by index; those settings ride
//     docSceneSettings from the doc's scenes list in both paths), and the
//     execution channel (kenburns/i2v/stock liveliness — a production
//     decision, not a composition fact; slice 3 settled it at the engine
//     level: whiteboard-kind clips execute through the Whiteboard lane,
//     never through the compositor's segment builders).
//
// Pure functions only — deterministic, ffmpeg-free, DB-free. The parity
// pins live in scripts/test-unit.mts (S87 slice 2 block).

import type { AssembledTimeline, TimelineTrack } from "./timeline";

/** The per-scene visual execution kind the track dispatch keys on.
 *  "image" = the designed PNG IS the frame (slides today); "video" = a
 *  moving or footage-derived clip; "whiteboard" = the engine DRAWS the
 *  frames (the Whiteboard lane owns execution — the compositor's segment
 *  builders refuse the kind as a routing wall). 3d/character/graphics land
 *  with the engines that own them. */
export type PlanVisualKind = "video" | "image" | "whiteboard";

export interface CompositionPlanScene {
  /** Play-order position (0-based) — the row's scenes align BY POSITION
   *  (the sceneOrder contract keeps row and doc in the same play order). */
  position: number;
  /** The row scene this plan scene projects (the clip's own linkage). */
  sceneIndex: number;
  kind: PlanVisualKind;
  /** The clip's asset source — "stock" routes the footage path (the fs
   *  guard at the executor stays belt-and-braces), "ai" the art path,
   *  "slides" the designed-deck path. */
  assetSource: "ai" | "stock" | "slides";
  /** Composition-clock window (seconds, the doc's 2-dp values). */
  startSec: number;
  endSec: number;
  durationSec: number;
  /** The boundary INTO this scene (null = none declared — the video-level
   *  seam wins). Mirrors the scene's transitionIn 1:1 (parity-pinned). */
  transitionIn: string | null;
}

export interface CompositionPlan {
  /** Which derivation produced this plan — the ledger truth: "tracks" =
   *  the v2 contract read (schema 2, aligned visual track); "scenes" =
   *  the legacy read (v1 doc, or a schema-2 doc whose tracks failed
   *  validation — fail-open, never a half-read plan). */
  origin: "tracks" | "scenes";
  scenes: CompositionPlanScene[];
  totalSec: number;
}

/** round to the doc's 2-dp clock */
function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** The v2 read: derive the plan from a VISUAL track's clips — a doc's
 *  derived projection (slice 1) or an ENGINE-authored track list (slice 3:
 *  the whiteboard planner emits the grammar directly; there is no doc, so
 *  the parameter is the structural tracks carrier an AssembledTimeline
 *  also satisfies). The clips are the ordered play list, aligned BY
 *  POSITION to the expected scene count — the same all-or-nothing law
 *  docSceneSettings applies. ANY misalignment (wrong clip count,
 *  non-finite window, non-positive duration, junk linkage) refuses the
 *  WHOLE read → the caller falls back (fail-open for docs; for the engine
 *  lanes a null here is an engine bug, refused loudly upstream). */
export function planFromTracks(
  doc: { tracks: TimelineTrack[] },
  sceneCount: number
): CompositionPlan | null {
  const visual = doc.tracks.find((t) => t.name === "visual") ?? null;
  if (!visual || !Array.isArray(visual.clips)) return null;
  if (visual.clips.length !== sceneCount || sceneCount === 0) return null;

  const scenes: CompositionPlanScene[] = [];
  let cursor = 0;
  for (let i = 0; i < visual.clips.length; i++) {
    const c = visual.clips[i];
    const startSec = Number(c?.startSec);
    const endSec = Number(c?.endSec);
    if (!Number.isFinite(startSec) || !Number.isFinite(endSec)) return null;
    if (startSec < 0 || endSec <= startSec) return null;
    const durationSec = r2(endSec - startSec);
    if (durationSec <= 0) return null;
    scenes.push({
      position: i,
      sceneIndex: typeof c.sceneIndex === "number" ? c.sceneIndex : i + 1,
      kind: c.kind === "image" ? "image" : c.kind === "whiteboard" ? "whiteboard" : "video",
      assetSource:
        c.asset?.source === "stock"
          ? "stock"
          : c.asset?.source === "slides"
            ? "slides"
            : "ai",
      startSec: r2(startSec),
      endSec: r2(endSec),
      durationSec,
      transitionIn: typeof c.transitionIn === "string" ? c.transitionIn : null,
    });
    cursor = endSec;
  }
  return { origin: "tracks", scenes, totalSec: r2(cursor) };
}

/** The v1 read (legacy, kept verbatim): derive the plan from the doc's
 *  scenes list. The kind maps from the scene source — "slides" projects
 *  onto the image kind (the designed PNG IS the frame), everything else
 *  onto video. The duration is the scene's OWN durationSec field (the
 *  field today's job-side feed reads — video-jobs' pre-S87 derivation),
 *  which the parity pin shows equals the track window for every doc the
 *  engines write (assembled docs: cursor is always on the 2-dp clock, so
 *  endSec − startSec === durationSec exactly). */
export function planFromScenes(
  doc: AssembledTimeline,
  sceneCount: number
): CompositionPlan | null {
  if (!Array.isArray(doc.scenes) || doc.scenes.length !== sceneCount || sceneCount === 0)
    return null;

  const scenes: CompositionPlanScene[] = [];
  let cursor = 0;
  for (let i = 0; i < doc.scenes.length; i++) {
    const s = doc.scenes[i];
    const durationSec = r2(Number(s?.durationSec));
    if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
    const startSec = r2(cursor);
    const endSec = r2(cursor + durationSec);
    scenes.push({
      position: i,
      sceneIndex: typeof s?.index === "number" ? s.index : i + 1,
      kind: s?.source === "slides" ? "image" : "video",
      assetSource: s?.source === "stock" ? "stock" : s?.source === "slides" ? "slides" : "ai",
      startSec,
      endSec,
      durationSec,
      transitionIn: typeof s?.transitionIn === "string" ? s.transitionIn : null,
    });
    cursor = endSec;
  }
  return { origin: "scenes", scenes, totalSec: r2(cursor) };
}

/** The dispatcher the render job calls: schema 2 → the tracks read with
 *  the scenes fallback (fail-open — a junk tracks copy NEVER blocks the
 *  render, it just demotes the read to the legacy derivation); schema 1
 *  → the scenes read verbatim. Null only when the doc itself is unusable
 *  (the render then runs on its own measured-WAV defaults, as it always
 *  has for absent docs). */
export function compositionPlan(
  doc: AssembledTimeline | null,
  sceneCount: number
): CompositionPlan | null {
  if (!doc) return null;
  if (doc.schema === 2) {
    return planFromTracks(doc, sceneCount) ?? planFromScenes(doc, sceneCount);
  }
  return planFromScenes(doc, sceneCount);
}
