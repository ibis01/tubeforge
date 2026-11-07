// S35 — Universal Scene Liveliness: every scene plays its LIVELIEST channel.
//
// The loop this stage closes: the Director pass writes per-scene `needsI2V`
// ("true motion is the point — action, weather, crowds, vehicles"), the human
// approves the plan, and the QC pacing gate (planStaticRuns) already treats
// that flag as a motion channel — but the DEFAULT render mode (Ken Burns)
// never consumed it. An approved "this scene needs real motion" decision died
// in the data: the scene still rendered as a camera move over a still.
//
// The selector below derives ONE execution channel per scene, honoring the
// studio's precedence law (an explicit human edit is senior by definition):
//
//   1. mode "slides"  → the deck plays (deterministic, no scene motion).
//   2. mode "animated"→ i2v everywhere (the video-level pick IS the ask).
//   3. matched stock  → real footage beats generated motion (stock mode's
//      contract; also honored as a clip source in stock mode only).
//   4. stills contract→ video motion off / intensity 0 / the doc's studio
//      camera keys / the plan's own motion:"off" / the human's per-scene
//      motion-map "off" all pin the scene to Ken Burns (the KB engine
//      renders the honest hold under the stills contract).
//   5. plan needsI2V + a configured video provider → i2v (subject-real
//      motion, metered under the same $5 gate via aiCall("video")).
//   6. everything else → Ken Burns (the motion engine's camera plans).
//
// The module is PURE: no fs, no DB, no AI. The renderer reads the world
// (plan rows, provider config, stock files on disk) once and hands the
// facts in; tests pin every precedence branch without a database.
import type { Scene } from "./types";
import { classifyScene, type SceneKind } from "./motion";
import type { DirectorScene } from "./director-plan";

/** The one execution channel a scene's pixels come from. Matches the
 *  renderer's segment branches (slides / stock clip / i2v clip / KB graph). */
export type LivelinessChannel = "i2v" | "stock" | "kenburns" | "slides";

/** Per-scene decision — the channel plus WHY (progress notes, render result,
 *  and the worklog's observability story all read this). */
export interface LivelinessDecision {
  sceneIndex: number; // 1-based, matches Scene.index
  channel: LivelinessChannel;
  reason: string; // human-readable precedence branch
}

/** Everything the selector needs, gathered by the caller (render.ts). All
 *  per-scene arrays are index-aligned to the 0-based scene list. */
export interface LivelinessInput {
  mode: "kenburns" | "animated" | "stock" | "slides";
  /** Video-level motion settings AFTER sanitizeMotion — the stills contract
   *  is mode "off" or intensity < 1. */
  motionOff: boolean;
  /** Approved plan flags: the Director marked this scene "true motion is
   *  the point". Absent plan → false everywhere. */
  planNeedsI2V: boolean[];
  /** The plan itself stilled this scene (scene.motion === "off"). */
  planMotionOff: boolean[];
  /** The human's per-scene motion-map override is "off" (module D). */
  humanMotionOff: boolean[];
  /** The doc's studio camera keys exist for this scene (S2 wave 2). */
  docCameraKeys: boolean[];
  /** A matched stock clip exists on disk for this scene. */
  hasStock: boolean[];
  /** The video capability is configured for i2v (provider "zai"). */
  i2vReady: boolean;
}

/**
 * Derive one channel per scene. Pure — every branch is pinned by unit tests,
 * and the comment on each branch names the precedence rule above.
 */
export function selectChannels(input: LivelinessInput): LivelinessDecision[] {
  const n =
    input.planNeedsI2V.length ||
    input.hasStock.length ||
    input.docCameraKeys.length ||
    0;
  const at = <T>(arr: T[], i: number, fallback: T): T =>
    Array.isArray(arr) && i < arr.length ? arr[i] : fallback;

  const out: LivelinessDecision[] = [];
  for (let i = 0; i < n; i++) {
    const sceneIndex = i + 1;

    // 1) Slides: the deck is the picture; scene art is not rendered.
    if (input.mode === "slides") {
      out.push({ sceneIndex, channel: "slides", reason: "keynote slides — the deck plays" });
      continue;
    }
    // 2) Animated mode: the video-level pick asks for i2v on every scene —
    //    unchanged pre-S35 behavior.
    if (input.mode === "animated") {
      out.push({ sceneIndex, channel: "i2v", reason: "animated render — full i2v" });
      continue;
    }
    // 3) Matched stock footage (stock mode only): real footage wins.
    if (input.mode === "stock" && at(input.hasStock, i, false)) {
      out.push({ sceneIndex, channel: "stock", reason: "matched stock footage" });
      continue;
    }
    // 4) Stills / explicit-edit contracts that pin the scene to the KB path
    //    (the KB engine itself renders the hold under a stills contract):
    //    the video-level stills contract, the doc's studio camera keys (a
    //    user edit is senior by definition — S2's law), the plan's own
    //    motion:"off", or the human's per-scene motion-map "off".
    if (
      input.motionOff ||
      at(input.docCameraKeys, i, false) ||
      at(input.planMotionOff, i, false) ||
      at(input.humanMotionOff, i, false)
    ) {
      const reason = input.motionOff
        ? "stills contract — motion off"
        : at(input.docCameraKeys, i, false)
          ? "studio camera keys — the user's edit is senior"
          : at(input.planMotionOff, i, false)
            ? "the director stilled this scene (plan motion off)"
            : "human motion override: off";
      out.push({ sceneIndex, channel: "kenburns", reason });
      continue;
    }
    // 5) THE S35 LOOP-CLOSURE: the Director's approved true-motion pick
    //    finally steers the render — when a video provider is configured.
    //    Without one, the same scene degrades honestly to Ken Burns (the
    //    render never breaks on a missing provider; the reason says why).
    if (at(input.planNeedsI2V, i, false)) {
      if (input.i2vReady) {
        out.push({ sceneIndex, channel: "i2v", reason: "director true-motion pick (approved plan) — i2v" });
      } else {
        out.push({ sceneIndex, channel: "kenburns", reason: "director true-motion pick, but no video provider — Ken Burns fallback" });
      }
      continue;
    }
    // 6) Default: the Smart Motion camera engine over the scene art.
    out.push({ sceneIndex, channel: "kenburns", reason: "Ken Burns camera plan" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The i2v motion prompt — camera execution for generative motion.
//
// render.ts's old motionPrompt mapped FIVE legacy storyboard camera ids and
// fell back to "subtle cinematic camera drift" for everything else — so an
// approved Director camera like "crane-up" or "handheld" animated as generic
// drift. The tables below speak the FULL Director vocabulary (director-plan's
// CAMERA_MOVES) AND the legacy ids, and add the subject-motion clause per
// scene kind — because i2v's whole point is SUBJECT motion, the thing Ken
// Burns mathematically cannot produce.

/** Director/legacy camera id → generative-motion camera phrase. Ken Burns
 *  must approximate crane/drone/handheld with zooms and drifts (shots.ts's
 *  CAMERA_TO_MOVE); a generative model can actually DO them, so the phrases
 *  name the real move. S50: the table now covers the FULL v2 engine-verbatim
 *  vocabulary too — diag-tl/diag-br/punch-in used to degrade to generic
 *  drift (the same split-brain S48 killed for Ken Burns, still alive here). */
export const I2V_CAMERA_PHRASES: Readonly<Record<string, string>> = {
  // The v2 engine-verbatim vocabulary (S48 CAMERA_MOVES).
  static: "locked-off camera — the motion lives in the subjects themselves",
  "zoom-in": "slow cinematic zoom in",
  "zoom-out": "slow cinematic zoom out revealing the scene",
  "pan-left": "smooth lateral camera pan to the left with natural parallax",
  "pan-right": "smooth lateral camera pan to the right with natural parallax",
  "tilt-up": "smooth camera tilt upward",
  "tilt-down": "smooth camera tilt downward",
  "diag-tl": "gentle diagonal camera drift toward the upper left, natural parallax",
  "diag-br": "gentle diagonal camera drift toward the lower right, natural parallax",
  "punch-in": "fast punch-in that settles on the subject — hard emphasis, then stillness",
  // The legacy Director verbs (pre-S48 plans; a generative model CAN honor
  // them, so unlike Ken Burns they are NOT approximated here).
  "push-in": "steady dramatic push in toward the subject",
  "pull-out": "smooth slow pull-out revealing the wider scene",
  "dolly-in": "smooth dolly move in toward the subject with natural parallax",
  handheld: "organic handheld camera sway, subtle documentary shake",
  "crane-up": "smooth crane rise revealing the scene from above",
  drone: "slow aerial drone pull-back reveal",
};

/** S50 — moveSpeed modulation: the director's per-shot speed colors the
 *  camera phrase (slow = weight and reverence, fast = energy). */
const I2V_SPEED_PREFIX: Readonly<Record<string, string>> = {
  slow: "slow, deliberate ",
  fast: "quick, energetic ",
};

/** Scene kind → what should MOVE inside the frame. The per-kind split is the
 *  documentary-editor rule the motion engine already applies to camera moves
 *  (SHOT_SEC / AMP_SCALE), applied to subject motion: action bursts, faces
 *  live subtly, text scenes stay legible above all. */
export const I2V_SUBJECT_MOTION: Readonly<Record<SceneKind, string>> = {
  action: "The subjects move with real, visible energy — running, turning, dust and debris in motion.",
  emotional: "The subject shows subtle natural life — breathing, blinking, micro-expressions, hair and fabric moving gently.",
  establishing: "Natural ambient motion — drifting clouds, moving water, swaying foliage, distant birds.",
  detail: "Subtle physical texture motion — light shifting across the surface, faint dust motes, a gentle paper tremor.",
  suspense: "Slow, tense motion — shifting shadows, fog drifting, a figure moving at the edge of frame.",
  text: "Minimal motion — a faint light drift only; any text stays perfectly static and legible.",
  standard: "Natural ambient motion within the scene — people and objects moving believably.",
};

const I2V_DEFAULT_CAMERA = "subtle cinematic camera drift";
const I2V_TAIL = "Cinematic quality, natural physics, no text.";

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The motion prompt for one scene's i2v generation, seeded from the scene's
 * storyboard image. PURE — unit-pinned.
 *
 * Camera source: the approved plan's shot 0 (the scene image IS shot 0's
 * frame — the i2v seed), falling back to the scene's own legacy camera field,
 * then the generic drift. S50: shot 0's moveSpeed modulates the phrase, and
 * shot 0's subjectAction — the director's specific motion ask — REPLACES the
 * generic per-kind subject clause when present (the per-kind classifier
 * stays the fallback).
 */
export function i2vMotionPrompt(scene: Scene, planScene: DirectorScene | null): string {
  const kind = classifyScene(scene);
  const shot0 = planScene?.shots?.[0] ?? null;
  const camera = shot0?.camera ?? scene.camera ?? null;
  let camPhrase = (camera && I2V_CAMERA_PHRASES[camera]) || I2V_DEFAULT_CAMERA;
  const speedPrefix = shot0?.moveSpeed ? I2V_SPEED_PREFIX[shot0.moveSpeed] : undefined;
  if (speedPrefix) camPhrase = speedPrefix + camPhrase;
  const subject = shot0?.subjectAction?.trim() || I2V_SUBJECT_MOTION[kind];
  return `${cap(camPhrase)}. ${cap(subject)} ${scene.visual}. ${scene.mood}. ${I2V_TAIL}`;
}
