// Milestone 1 — production profiles (the universal Director).
//
// A profile is a PROMPT OVERLAY + VALIDATION LAYER + DEFAULT SET applied
// AROUND the existing director pass. The DirectorPlan is unchanged in
// shape — only one additive optional field (`profile?: string`) selects
// which profile authored the plan. The base SYSTEM_PROMPT in director.ts
// is format-neutral; the chosen profile's `systemOverlay` is appended to
// it, its `defaultTone` is surfaced as fallback hints in the user prompt,
// and its `vocabularies` (when present) narrow the shared catalogs the LLM
// is asked to pick from. The profile's `validation` runs against the
// parsed plan; its findings land in the activity feed so a human sees the
// notes before approving (the approval-card detail is a later milestone —
// spec §3 guardrails: "no silent creative decisions").
//
// `narrative` is the COMPATIBILITY profile — its overlay restores today's
// "faceless YouTube studio" line and its vocabularies are the full
// catalogs, so a narrative plan assembled after M1 is byte-for-byte the
// prompt that ran before M1 (the story-regression golden test pins this).

import {
  FRAMINGS,
  CAMERA_MOVES,
  PROFILE_IDS,
  type DirectorPlan,
} from "./director-plan";
import { TRANSITIONS } from "./transitions";

export interface ProductionProfile {
  /** The plan's `profile` field value. Stable across releases. */
  id: string;
  /** Human label for the UI picker (the approval card reads this in M2.x). */
  label: string;
  /** Appended verbatim to the base SYSTEM_PROMPT — the format's voice,
   *  structure rules, do/don't list. The base prompt stays format-neutral. */
  systemOverlay: string;
  /** Fallback defaults surfaced in the user prompt when the LLM has no
   *  stronger signal from the script. Always advisory — the LLM stays free
   *  to deviate when a scene clearly demands it. */
  defaultTone: Partial<{
    transitionBias: string; // e.g. explainer → "cut"
    pacingBias: string; // e.g. advertisement → "fast"
    shotDensity: "sparse" | "normal" | "dense";
  }>;
  /** Per-profile narrowing of the shared catalogs. When absent the LLM
   *  sees the FULL catalogs (the narrative behavior). */
  vocabularies?: {
    framings?: readonly string[];
    cameras?: readonly string[];
    transitions?: readonly string[];
  };
  /** Profile-specific checks against the parsed plan. Returns human-readable
   *  issue strings; an empty array means the plan passes this profile's
   *  rules. Issues are advisory (they land in the activity feed), never
   *  blocking — the human is the approval gate. */
  validation: (plan: DirectorPlan) => string[];
}

// ---------------------------------------------------------------------------
// The seven initial profiles.
//
// `narrative` is byte-identical to today's behavior: its overlay restores
// the "faceless YouTube studio" line that previously lived in the base
// SYSTEM_PROMPT, and it carries no vocabulary narrowing. Every other
// profile narrows the catalogs and overlays its own structure rules.

const TRANSITION_IDS = TRANSITIONS.map((t) => t.id);

const NARRATIVE_OVERLAY = `You are the AI Director of a faceless YouTube video studio. You turn a scene script into a deliberate shot plan: pacing, framing, camera movement, lens character, composition, scene transitions AND the audio direction (narration pacing, ambient beds, boundary cues, music mood, ducking).`;

const PROFILES: ProductionProfile[] = [
  {
    id: "narrative",
    label: "Narrative story",
    systemOverlay: NARRATIVE_OVERLAY,
    defaultTone: {
      transitionBias: "mixed",
      pacingBias: "normal",
      shotDensity: "normal",
    },
    validation: () => [],
  },
  {
    id: "documentary",
    label: "Documentary",
    systemOverlay: `You are the AI Director of a documentary. Voice: observational, evidence-led, restrained. Open scenes on the subject, not the narrator's opinion. Lean on real-world b-roll — set useStock=true for any scene that names a real place, machine, animal or event. Camera moves stay grounded (zoom-in for emphasis, pans and tilts to survey); avoid diag-tl/diag-br drift unless the scene is verité. Compositions favor leading lines and negative space. Outfit/accessory only when the cast is a real on-screen subject.`,
    defaultTone: {
      transitionBias: "fade",
      pacingBias: "slow",
      shotDensity: "sparse",
    },
    vocabularies: {
      framings: ["wide", "medium", "close-up", "aerial"],
      cameras: ["static", "zoom-in", "zoom-out", "pan-left", "pan-right", "tilt-up", "tilt-down", "diag-br"],
      transitions: TRANSITION_IDS.filter((id) => id === "fade" || id === "fadeblack" || id === "cut"),
    },
    validation: (plan) => {
      const issues: string[] = [];
      // Documentary scenes without a real-world setting are a missed stock cue.
      const missedStock = plan.scenes.filter(
        (s) => !s.useStock && /real|news|historical|place|city|country|machine|animal/i.test(s.mood + " " + (s.locations ?? []).join(" "))
      );
      if (missedStock.length > 0) {
        issues.push(
          `${missedStock.length} scene(s) read as real-world but useStock is false — documentary should favor stock b-roll there (scenes: ${missedStock.slice(0, 3).map((s) => s.sceneIndex).join(", ")}).`
        );
      }
      return issues;
    },
  },
  {
    id: "explainer",
    label: "Explainer",
    systemOverlay: `You are the AI Director of an explainer video. Voice: clear, structured, didactic. Each scene carries one idea; the shot list walks the viewer through it (wide establishing → medium process → close-up detail → summary). Transitions bias to "cut" — momentum and clarity, not mood. Pacing stays "normal" — let the viewer absorb each step. The first shot of a scene must literally show the subject the narration introduces; never lead with abstract b-roll.`,
    defaultTone: {
      transitionBias: "cut",
      pacingBias: "normal",
      shotDensity: "normal",
    },
    vocabularies: {
      framings: ["wide", "medium", "close-up", "extreme close-up", "over-the-shoulder", "pov"],
      cameras: ["static", "zoom-in", "zoom-out", "pan-left", "pan-right"],
      transitions: TRANSITION_IDS.filter((id) => id === "cut" || id === "fade"),
    },
    validation: (plan) => {
      const issues: string[] = [];
      for (const s of plan.scenes) {
        const first = s.shots[0];
        if (!first) continue;
        // The first shot must show what the narration talks about — an empty
        // imagePrompt on shot 0 is a tell the LLM phoned in b-roll.
        if (!first.imagePrompt || first.imagePrompt.trim().length < 5) {
          issues.push(
            `Scene ${s.sceneIndex} shot 0 has no imagePrompt — explainers need shot 0 to literally show what the narration introduces.`
          );
        }
      }
      return issues;
    },
  },
  {
    id: "advertisement",
    label: "Advertisement",
    systemOverlay: `You are the AI Director of an advertisement. Voice: persuasive, product-forward, urgent. Every scene must service the product. The FIRST shot of the video must show the product (the thing being sold) — never open on atmosphere, the problem, or the brand logo alone. Pacing biases "fast"; transitions bias "cut" for energy or "sting" for reveals. Camera moves favor zoom-in (escalating desire) and punch-in (hard emphasis); moveSpeed "fast" on hero beats. Shot density is "dense" — many short beats read as a campaign. The closing scene is a CTA shot (product hero + tagline framing).`,
    defaultTone: {
      transitionBias: "cut",
      pacingBias: "fast",
      shotDensity: "dense",
    },
    vocabularies: {
      framings: ["close-up", "extreme close-up", "medium", "wide", "pov"],
      cameras: ["zoom-in", "punch-in", "static", "pan-right", "pan-left", "diag-tl"],
      transitions: TRANSITION_IDS,
    },
    validation: (plan) => {
      const issues: string[] = [];
      // The whole point: shot 0 of scene 1 must be product-forward.
      const opening = plan.scenes[0]?.shots?.[0];
      if (opening) {
        const isProduct = /product|bottle|can|box|package|device|screen|hero|cta|tagline|logo/i.test(opening.imagePrompt);
        if (!isProduct) {
          issues.push(
            `Advertisement must open on the product — scene 1 shot 0 reads "${(opening.imagePrompt || "(empty)").slice(0, 80)}", which is not product-forward (mention the product, its container, or a CTA hero shot).`
          );
        }
      }
      // A CTA close: the last scene's last shot should land the action.
      const close = plan.scenes[plan.scenes.length - 1]?.shots?.slice(-1)?.[0];
      if (close) {
        const isCta = /cta|tagline|call to action|subscribe|buy|order|link|button|click|tap|scan|swipe|get|try|start/i.test(close.imagePrompt);
        if (!isCta) {
          issues.push(
            `Advertisement must close on a CTA — the last shot reads "${(close.imagePrompt || "(empty)").slice(0, 80)}", which is not an action cue.`
          );
        }
      }
      return issues;
    },
  },
  {
    id: "animation",
    label: "Animation",
    systemOverlay: `You are the AI Director of an animated short. Voice: imaginative, character-driven, kinetic. needsI2V is true for any scene with motion as the point (character action, weather, vehicles, magic, choreography). Camera moves may be bold (crane-up, drone, handheld) — animation can sustain them where live footage cannot. Pacing matches the beats: slow for emotional moments, fast for action. Compositions favor frame-within-frame and diagonal for graphic energy.`,
    defaultTone: {
      transitionBias: "mixed",
      pacingBias: "normal",
      shotDensity: "dense",
    },
    vocabularies: {
      framings: FRAMINGS, // animation can use the full framing range
      cameras: CAMERA_MOVES, // and the full camera range — animation is unconstrained
      transitions: TRANSITION_IDS,
    },
    validation: (plan) => {
      const issues: string[] = [];
      // Animation scenes with motion subjects that aren't flagged needsI2V
      // are missed motion cues — the badge is advisory (M2), but the LLM
      // should still tag the scenes that merit it.
      const motionWords = /action|chase|dance|fight|fly|run|storm|magic|transform|explosion|jump|spin|rush|crash/i;
      const missed = plan.scenes.filter(
        (s) => !s.needsI2V && s.shots.some((sh) => motionWords.test(sh.imagePrompt))
      );
      if (missed.length > 0) {
        issues.push(
          `${missed.length} animated scene(s) have motion language in shot prompts but needsI2V is false (scenes: ${missed.slice(0, 3).map((s) => s.sceneIndex).join(", ")}).`
        );
      }
      return issues;
    },
  },
  {
    id: "podcast",
    label: "Podcast / talking-head",
    systemOverlay: `You are the AI Director of a podcast video. Voice: intimate, conversational, talking-head-led. Most scenes are the host on mic — framing stays medium or close-up, camera stays static or a slow zoom-in, pacing stays "normal" or "slow". Punctuate key moments with a close-up or extreme close-up, but never a whip-cut. Ambience beds matter: "room" for the studio, "none" for purely voice-led scenes. The shot list supports the talk, it does not compete with it.`,
    defaultTone: {
      transitionBias: "fade",
      pacingBias: "slow",
      shotDensity: "sparse",
    },
    vocabularies: {
      framings: ["medium", "close-up", "extreme close-up", "over-the-shoulder"],
      cameras: ["static", "zoom-in", "zoom-out", "pan-left", "pan-right"],
      transitions: TRANSITION_IDS.filter((id) => id === "fade" || id === "fadeblack" || id === "fadewhite"),
    },
    validation: (plan) => {
      const issues: string[] = [];
      // Podcast scenes should bias toward static — a video that whip-pans
      // through a talking-head is fighting itself. (S48: the frenetic verbs
      // are now the engine's diag drifts + punch-in.)
      const frenetic = plan.scenes.filter(
        (s) => s.shots.filter((sh) => sh.camera === "diag-tl" || sh.camera === "diag-br" || sh.camera === "punch-in").length > 0
      );
      if (frenetic.length > 0) {
        issues.push(
          `${frenetic.length} podcast scene(s) use diag-drift/punch-in cameras — talking-head video favors static + slow zoom-in (scenes: ${frenetic.slice(0, 3).map((s) => s.sceneIndex).join(", ")}).`
        );
      }
      return issues;
    },
  },
  {
    id: "social",
    label: "Social short",
    systemOverlay: `You are the AI Director of a social short (TikTok / Reels / Shorts). Voice: hook in the first second, fast cuts, vertical-thinking even when the canvas is 16:9. Scene 1 shot 0 is the HOOK — visual + narration must stop the scroll. Pacing biases "fast"; shot density is "dense" (≤2s shots). Transitions bias "cut" — momentum beats mood. The last shot is the CTA (follow, like, subscribe, comment). Camera moves favor zoom-in and diag-tl drift with moveSpeed "fast"; static establishing shots waste the format. NEVER exceed 3 shots per scene — short-form attention does not reward cut-aways.`,
    defaultTone: {
      transitionBias: "cut",
      pacingBias: "fast",
      shotDensity: "dense",
    },
    vocabularies: {
      framings: ["close-up", "medium", "extreme close-up", "pov", "over-the-shoulder"],
      cameras: ["zoom-in", "diag-tl", "static", "pan-right", "tilt-up", "punch-in"],
      transitions: TRANSITION_IDS.filter((id) => id === "cut" || id === "fadewhite"),
    },
    validation: (plan) => {
      const issues: string[] = [];
      // The hook: scene 1 shot 0 needs an attention pivot, not a slow open.
      const hook = plan.scenes[0]?.shots?.[0];
      if (hook && hook.duration > 2.0) {
        issues.push(
          `Social short hook must be ≤ 2s — scene 1 shot 0 runs ${hook.duration}s (a slow open loses the scroll).`
        );
      }
      // Shot-count discipline: social attention doesn't reward cut-aways.
      const tooMany = plan.scenes.filter((s) => s.shots.length > 3);
      if (tooMany.length > 0) {
        issues.push(
          `${tooMany.length} social scene(s) have more than 3 shots — short-form favors tight beats (scenes: ${tooMany.slice(0, 3).map((s) => s.sceneIndex).join(", ")}).`
        );
      }
      return issues;
    },
  },
  {
    id: "islamic-history",
    label: "Islamic history",
    // S49 — the 8th profile. It is a DOCUMENTARY-style voice whose creative
    // doctrine composes around revered figures, AND the profile whose S52 UI
    // picker will default Video.contentPolicy to "islamic-history". The two
    // are deliberately decoupled at runtime: enforcement ALWAYS reads the
    // Video.contentPolicy column (set by the human), never the profile — a
    // narrative video about the seerah can carry the policy, and an
    // islamic-history-profiled video about Andalusian architecture can run
    // without it.
    systemOverlay: `You are the AI Director of an Islamic-history production. Voice: reverent, evidence-led, unhurried — the dignity of the subject sets the pace. Compose EVERY shot around, never on, the revered figures of Islamic history: the Prophet Muhammad, his family, the Companions, the prophets, the angels and God are NEVER depicted — no faces, figures, silhouettes or light-bodies. Direct the eye to what carries the story instead: calligraphy, the Kaaba and sacred architecture, the mushaf and its rehal, a reed pen, a mantle, lamplight on stone, desert horizons, anonymous distant crowds with indistinct faces. needsI2V for weather, caravans and light; useStock only for present-day documentary b-roll of real places. Camera stays grounded and patient — slow zoom-in for reverence, pans across calligraphy and architecture. Pacing biases slow; the weight of the history earns the time.`,
    defaultTone: {
      transitionBias: "fade",
      pacingBias: "slow",
      shotDensity: "sparse",
    },
    vocabularies: {
      framings: ["wide", "medium", "close-up", "extreme close-up", "aerial"],
      cameras: ["static", "zoom-in", "zoom-out", "pan-left", "pan-right", "tilt-up", "tilt-down", "diag-br"],
      transitions: TRANSITION_IDS.filter((id) => id === "fade" || id === "fadeblack" || id === "cut"),
    },
    validation: (plan) => {
      // This profile's own discipline check is advisory (the human approves);
      // the BLOCKING enforcement lives in the content policy layers
      // (restricted-subjects.ts), not here.
      const issues: string[] = [];
      const calm = plan.scenes.filter(
        (s) => s.shots.filter((sh) => sh.moveSpeed === "fast").length > s.shots.length / 2
      );
      if (calm.length > 0) {
        issues.push(
          `${calm.length} islamic-history scene(s) are majority fast moveSpeed — reverence reads better slow (scenes: ${calm.slice(0, 3).map((s) => s.sceneIndex).join(", ")}).`
        );
      }
      return issues;
    },
  },
];

// ---------------------------------------------------------------------------
// Catalog + resolver.

export const PRODUCTION_PROFILES: Record<string, ProductionProfile> = Object.fromEntries(
  PROFILES.map((p) => [p.id, p])
);

export const PROFILE_IDS_CATALOG = Object.keys(PRODUCTION_PROFILES);

export const DEFAULT_PROFILE_ID = "narrative";

/** Snap an unknown profile id to a real ProductionProfile; unknown / absent
 *  → narrative (the compatibility profile). Pure. */
export function resolveProfile(id?: string | null): ProductionProfile {
  const k = typeof id === "string" ? id.trim().toLowerCase() : "";
  return PRODUCTION_PROFILES[k] ?? PRODUCTION_PROFILES[DEFAULT_PROFILE_ID];
}

// Sanity: every id in the low-level PROFILE_IDS list (what `parsePlan` snaps
// against) MUST have a real profile here, and vice versa. The acceptance test
// pins this both ways — `parsePlan`'s snap set and the catalog must agree.
if (PROFILE_IDS_CATALOG.slice().sort().join(",") !== [...PROFILE_IDS].sort().join(",")) {
  throw new Error(
    `production-profiles.ts: PROFILE_IDS out of sync with PRODUCTION_PROFILES — ` +
    `catalog=[${PROFILE_IDS_CATALOG.join(",")}] vs parsePlan=[${[...PROFILE_IDS].join(",")}]`
  );
}
// `narrative` must exist (DEFAULT_PROFILE_ID fallback depends on it).
if (!PRODUCTION_PROFILES[DEFAULT_PROFILE_ID]) {
  throw new Error(`production-profiles.ts: missing the default profile "${DEFAULT_PROFILE_ID}"`);
}
