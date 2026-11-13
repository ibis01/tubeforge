// scene-deps.ts — S113 / Stage 2 of Scene-Level Editing & Repair: the
// declarative dependency map (docs/design/scene-level-editing-reconciliation.md
// §3, requirement B).
//
// Before this file, the dependency table the operator's proposal asks for
// ("narration → voice audio/captions/timing; music mix → scene audio mix;
// duration → audio timing/captions/transitions/neighbouring timing;
// transition → boundary preview/final assembly") existed only as scattered
// if-branches — RIGHT in their surgical paths (PATCH /scenes), WRONG in
// their blast radius (one scene's art change deleted EVERY scene's rendered
// clips). This file is the ONE declarative source: field → which of THIS
// scene's artifacts go stale, whether the video-level renders (the union of
// all scenes) go stale, and whether the scene BOUNDARY is implicated (the
// Stage 5 recheck's scope).
//
// THE TWO SCOPES (the reconciliation's §5.2 insight, made law):
//   * SCENE-scoped artifacts (scene-XX.png/wav/mp4, the whiteboard encodes)
//     belong to exactly one scene — only THAT scene's field changes stale
//     them. This is the over-invalidation fix: other scenes' clips survive
//     a one-scene edit, and the render already reuses cached clips
//     (ensureSceneClip), so the savings are real paid generations, not
//     just tidiness.
//   * VIDEO-level artifacts (final.mp4, preview.mp4, subtitles.srt, the
//     short) are the UNION — ANY scene change stales them. That is not
//     over-invalidation; that is what "assembled from every scene" means.
//
// BOUNDARY fields (narration length, trims, windows, transitions) implicate
// the SEAM with the neighbouring scenes — Stage 5's boundary recheck scope.
// They do NOT delete the neighbour's clip: the transition blend happens at
// final assembly (render.ts blends segment runs), not inside scene-XX.mp4,
// so the neighbour's clip is still current — only the assembled output and
// (Stage 5) the boundary verdict are stale.

import * as storage from "./storage";
import { db } from "./tenant-db";

// ---------- the declarative table (unit-pinned) ----------

/** The scene fields a mutator can change. Doc-side fields carry the
 *  "doc:" prefix — they live in the timeline doc's slice of the union. */
export type SceneField =
  | "narration"
  | "caption"
  | "visual"
  | "camera"
  | "mood"
  | "style"
  | "stock"
  | "sfx"
  | "focal"
  | "rehook"
  | "hostInScene"
  | "title"
  | "seedVariant"
  | "doc:transitionIn"
  | "doc:transitionOut"
  | "doc:audioMix"
  | "doc:trim"
  | "doc:window";

/** The proposal's artifact vocabulary (SceneArtifact.type). */
export type SceneArtifactType = "image" | "video" | "audio" | "preview";

export interface DependencyRule {
  /** Which of THE SCENE's own artifacts go stale when this field changes. */
  scene: SceneArtifactType[];
  /** Video-level renders (final/preview/subtitles/short) are the union of
   *  all scenes — true when this field is baked into them. */
  videoRenders: boolean;
  /** The merged voiceover.wav embeds this scene's read — true when the
   *  field changes what the merged file contains (narration, trims). */
  mergedVoice: boolean;
  /** The boundary with the neighbouring scenes is implicated (Stage 5's
   *  recheck scope; transitions/durations/windows). Never deletes the
   *  neighbour's own artifacts — the blend lives at final assembly. */
  boundary: boolean;
}

/** THE dependency table. Every rule is a claim about the render pipeline,
 *  pinned by unit tests; changing one is a behavioral change, not a
 *  refactor. */
export const SCENE_DEPENDS: Record<SceneField, DependencyRule> = {
  // The spoken audio no longer matches the text: this scene's WAV dies, its
  // clip (the WAV is its audio track) dies, the merged voiceover + every
  // render (they embed the old read) die. Art does NOT die — a narration
  // edit must not destroy approved visual assets (the proposal's law).
  narration: { scene: ["audio", "video"], videoRenders: true, mergedVoice: true, boundary: true },
  // Captions burn at final assembly (never inside a clip, never in a WAV):
  // only the video-level renders + the sidecar SRT die. Re-render is cheap
  // (no re-TTS, no re-art).
  caption: { scene: [], videoRenders: true, mergedVoice: false, boundary: false },
  // The art PROMPT changed: the on-disk art is no longer what the content
  // asks for — but the art regenerates only on explicit re-roll (the human
  // looks at the old take first). Nothing is deleted; Stage 3 labels the
  // artifact stale via revisionVersion. The clip embeds the art, so an
  // eventual re-roll stales it then.
  visual: { scene: [], videoRenders: false, mergedVoice: false, boundary: false },
  camera: { scene: ["video"], videoRenders: true, mergedVoice: false, boundary: false },
  mood: { scene: ["image", "video"], videoRenders: true, mergedVoice: false, boundary: false },
  style: { scene: ["image", "video"], videoRenders: true, mergedVoice: false, boundary: false },
  stock: { scene: ["video"], videoRenders: true, mergedVoice: false, boundary: false },
  sfx: { scene: ["video"], videoRenders: true, mergedVoice: false, boundary: false },
  focal: { scene: ["video"], videoRenders: true, mergedVoice: false, boundary: false },
  rehook: { scene: ["video"], videoRenders: true, mergedVoice: false, boundary: false },
  hostInScene: { scene: ["image", "video"], videoRenders: true, mergedVoice: false, boundary: false },
  title: { scene: ["image", "video"], videoRenders: true, mergedVoice: false, boundary: false },
  // A take-counter bump means a NEW image is being painted at this key.
  seedVariant: { scene: ["image"], videoRenders: true, mergedVoice: false, boundary: false },
  "doc:transitionIn": { scene: [], videoRenders: true, mergedVoice: false, boundary: true },
  "doc:transitionOut": { scene: [], videoRenders: true, mergedVoice: false, boundary: true },
  "doc:audioMix": { scene: ["video"], videoRenders: true, mergedVoice: false, boundary: false },
  "doc:trim": { scene: ["video", "audio"], videoRenders: true, mergedVoice: true, boundary: true },
  "doc:window": { scene: ["video"], videoRenders: true, mergedVoice: false, boundary: true },
};

// ---------- the plan (pure, unit-pinned) ----------

export interface InvalidationPlan {
  /** THIS scene's storage keys whose artifacts are stale. */
  sceneKeys: string[];
  /** The changed field set (for callers that also stale the registry rows). */
  fields: SceneField[];
  /** The scene's artifact TYPES that went stale (registry stale-marking). */
  sceneTypes: SceneArtifactType[];
  /** Video-level renders are stale (final/preview/subtitles/short — and the
   *  short thumbnail rides the renders). */
  videoRenders: boolean;
  /** The merged voiceover.wav embeds the old read. */
  mergedVoice: boolean;
  /** The boundary with the neighbours is implicated (Stage 5 recheck scope). */
  boundary: boolean;
}

/** The scene-scoped storage key vocabulary (both lanes: story + whiteboard).
 *  slide-NN.png is the slides lane's art; whiteboard/scene-N.mp4 is the
 *  whiteboard lane's per-scene encode. */
export function sceneArtifactKeys(videoId: string, sceneIndex: number, types: SceneArtifactType[]): string[] {
  const nn = String(sceneIndex).padStart(2, "0");
  const keys: string[] = [];
  for (const t of types) {
    if (t === "image") keys.push(`${videoId}/scene-${nn}.png`, `${videoId}/slide-${nn}.png`);
    else if (t === "audio") keys.push(`${videoId}/scene-${nn}.wav`);
    else if (t === "video")
      keys.push(`${videoId}/scene-${nn}.mp4`, `${videoId}/whiteboard/scene-${sceneIndex}.mp4`);
    else if (t === "preview") keys.push(`${videoId}/scene-preview-${nn}.mp4`);
  }
  return keys;
}

/** Fold the dependency rules for a set of changed fields into one plan. */
export function planSceneInvalidation(videoId: string, sceneIndex: number, fields: SceneField[]): InvalidationPlan {
  const sceneTypes = new Set<SceneArtifactType>();
  let videoRenders = false;
  let mergedVoice = false;
  let boundary = false;
  for (const f of fields) {
    const rule = SCENE_DEPENDS[f];
    if (!rule) continue;
    for (const t of rule.scene) sceneTypes.add(t);
    videoRenders = videoRenders || rule.videoRenders;
    mergedVoice = mergedVoice || rule.mergedVoice;
    boundary = boundary || rule.boundary;
  }
  return {
    sceneKeys: sceneArtifactKeys(videoId, sceneIndex, [...sceneTypes]),
    fields,
    sceneTypes: [...sceneTypes],
    videoRenders,
    mergedVoice,
    boundary,
  };
}

// ---------- the sweep (storage + registry, in lockstep) ----------

/** Video-level render keys. The short + its thumbnail ride the renders; the
 *  voice-source.* custom upload dies only when the merged read dies (it IS
 *  the merged read's source). */
const VIDEO_RENDER_STALE =
  /\/(final\.mp4|preview\.mp4|subtitles\.srt|short\.mp4|short-thumb\.png)$/;
const MERGED_VOICE_STALE = /\/(voiceover\.wav|voice-source\.\w+)$/;

/** Execute a plan: remove exactly the planned keys (presence-tolerant — a
 *  missing prefix or key is not an error), and stale-mark the matching
 *  registry rows so the DB's truth matches storage's truth. Returns what
 *  was removed (the measured cost pin reads this). */
export async function sweepInvalidArtifacts(
  videoId: string,
  plan: InvalidationPlan
): Promise<{ removed: string[] }> {
  let keys: string[] = [];
  try {
    keys = await storage.list(videoId);
  } catch {
    return { removed: [] }; // prefix absent — nothing to invalidate
  }
  const doomed = new Set(plan.sceneKeys);
  const stale = keys.filter((k) => {
    if (doomed.has(k)) return true;
    if (plan.videoRenders && VIDEO_RENDER_STALE.test(k)) return true;
    if (plan.mergedVoice && MERGED_VOICE_STALE.test(k)) return true;
    return false;
  });
  await Promise.all(stale.map((k) => storage.remove(k).catch(() => {})));

  // The registry mirrors the sweep: rows at swept keys go stale. Only
  // scene-scoped artifacts are registered (video-level manifests are Stage
  // 6), so exact keys suffice. Best-effort by design — a registry miss must
  // never block the file sweep that precedes it.
  try {
    await db.sceneArtifact.updateMany({
      where: { videoId, storageKey: { in: stale } },
      data: { status: "stale" },
    });
  } catch {
    // registry unavailable (e.g. platform path) — the files are already gone
  }
  return { removed: stale };
}
