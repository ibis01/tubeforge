// Stage 5 — the AI Director ("AI suggests, human approves").
//
// Two passes, both jobbed off the request path (Stage 1/3 architecture):
//
//   runDirectorPass     LLM creative pass over the scene script → per-scene
//                       shot list (framing / camera / lens / composition /
//                       durations / transition-in / motion hint / visual
//                       mood) + per-scene cast appearance log. Persisted as
//                       Video.shotList with directorState "proposed" — the
//                       human then approves (state "approved" and the plan
//                       starts steering image prompts + motion + audio cues)
//                       or dismisses it. The plan NEVER applies itself.
//
//   runContinuityCheck  VLM pass comparing every painted scene image against
//                       the character's reference library + identity anchor.
//                       Scores each scene 0..100, flags drift, persists a
//                       ContinuityReport on Video.consistency. The UI offers
//                       one-click regeneration for flagged scenes (existing
//                       Scene Studio re-roll covers the "regenerate" half).
//
// Honest scope (ROADMAP §Stage 5): 2026 models make creative DECISIONS
// unreliably — this module makes creative SUGGESTIONS with structured,
// validated vocabularies, and the human is always the approval gate.

import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { aiCall } from "./budget";
import { llmChat, llmVision } from "./llm";
import { aiCallJson, parseJsonLoose } from "./ai";
import { parseScenes, sceneImageFile } from "./story";
import * as storage from "./storage";
import { errorText } from "./redact";
import { TRANSITIONS } from "./transitions";
import { parseReferenceAnalysis, referenceBlockForPrompt } from "./reference-video";
import type { Scene } from "./types";
import { readPortrait } from "./characters";
import {
  policySystemOverlay,
  resolveContentPolicy,
  sanitizePromptForPolicy,
} from "./restricted-subjects";
import {
  FRAMINGS,
  CAMERA_MOVES,
  COMPOSITIONS,
  PACINGS,
  AMBIENCE_KINDS,
  SFX_HINTS,
  parsePlan,
  serializePlan,
  planSceneDuration,
  directorImageAddendum,
  planTransitionIn,
  getApprovedAddendum,
  getApprovedAudioMap,
  getApprovedMotionMap,
  pacingSpeedFactor,
  type DirectorShot,
  type DirectorScene,
  type DirectorPlan,
  type DirectorState,
} from "./director-plan";
import {
  resolveProfile,
  type ProductionProfile,
  PRODUCTION_PROFILES,
  PROFILE_IDS_CATALOG,
  DEFAULT_PROFILE_ID,
} from "./production-profiles";

// Re-export the plan + profile layers so the rest of the app keeps ONE
// import surface (mirrors the existing director-plan re-export).
export {
  FRAMINGS,
  CAMERA_MOVES,
  COMPOSITIONS,
  PACINGS,
  AMBIENCE_KINDS,
  SFX_HINTS,
  parsePlan,
  serializePlan,
  planSceneDuration,
  directorImageAddendum,
  planTransitionIn,
  getApprovedAddendum,
  getApprovedAudioMap,
  getApprovedMotionMap,
  pacingSpeedFactor,
  resolveProfile,
  PRODUCTION_PROFILES,
  PROFILE_IDS_CATALOG,
  DEFAULT_PROFILE_ID,
  type DirectorShot,
  type DirectorScene,
  type DirectorPlan,
  type DirectorState,
  type ProductionProfile,
};

const TRANSITION_IDS = TRANSITIONS.map((t) => t.id);

export interface SceneConsistency {
  sceneIndex: number;
  score: number; // 0..100 — how well the painted image matches the identity
  verdict: "consistent" | "drift" | "off";
  issues: string[]; // human-readable flags ("jacket color changed", …)
}

export interface ContinuityReport {
  checkedAt: string;
  overall: number; // mean of scene scores (0 when nothing was checkable)
  scenes: SceneConsistency[];
}

// ---------------------------------------------------------------------------
// The director pass (LLM).
//
// Milestone 1 — the prompt is split into a format-neutral BASE (the Rules +
// JSON schema, applicable to any production profile) and a per-profile
// `systemOverlay` that supplies the format's voice (the opening paragraph).
// `narrative`'s overlay is exactly today's opening sentence, so a narrative
// plan assembled after M1 prompts the LLM byte-for-byte the same way as
// before M1 (the story-regression golden test pins this). Other profiles
// substitute their own opening — see production-profiles.ts.

const BASE_SYSTEM_PROMPT = `Rules:
- Shot length: every shot runs 2.0-3.5 seconds. Subdivide each scene so shot durations sum to roughly the scene's estimated seconds (given per scene).
- Shot 0 of a scene establishes (usually wide or medium); later shots escalate detail (close-ups, inserts).
- Rhythm: alternate movement types between consecutive shots; never repeat the same camera move twice in a row.
- Transitions: pick from the provided transition id list only. Use "cut" for energy, "fade" for neutrality, "fadeblack" for chapter pivots, "fadewhite" for dream/memory pivots. Scene 1 gets "" (nothing precedes it).
- motion: one of "smart" | "zoom" | "pan" | "off" — the per-scene Ken Burns override hint.
- needsI2V: true ONLY for scenes where true motion is the point (action, weather, crowds, vehicles). Most scenes are false.
- useStock: true ONLY for documentary/real-world scenes (news, places, animals, machines). Opinionated/abstract/emotional scenes are false.
- pacing (audio): "slow" for emotional weight, reveals and payoffs; "fast" for action, urgency, lists; "normal" otherwise. Vary it — a monotone read is a wasted narration.
- ambience (audio): the scene's sonic environment — one of the provided kinds. "room" for interiors/talking-head context, "none" for pure montage, "city"/"nature"/"rain"/"wind"/"waves"/"crowd" when the narration places us there. Never more than subtle.
- sfx (audio): a scene-boundary accent — "whoosh" for momentum cuts, "boom" for reveals/chapter pivots, "riser" entering tension, "sting" for twists, "none" most of the time (a cue on every cut is a trailer, not a video).
- musicMood (audio, plan-level): one mood id from the provided list, chosen from the script's overall emotional progression.
- ducking (audio, plan-level): "subtle" when narration is sparse and reflective, "standard" normally, "strong" when dialogue is dense and the bed must get out of the way.
- If cast appearance is requested for a scene, describe outfit + accessory CONCRETELY and keep it consistent across scenes unless the narration demands a change.
- locations / props: when the library below provides recurring set pieces, tag each scene with the names it actually uses (arrays of EXACT library names, ≤3 each). Scenes that use none get empty arrays. Never invent names outside the library.
- imagePrompt (shots): one sentence saying WHAT THIS SHOT SHOWS. It stays inside the video's story world — when the topic carries a culture, era or domain (Arab history, finance), the imagePrompt names that world's authentic markers (its architecture, clothing, artifacts, domain objects), never a generic stand-in that could belong to another video.
- sceneActions: for scenes where something in the STORY WORLD changes, say why — one entry per change: {"role":"actor","purpose":"<WHY the change happens, concrete>","before":"<the state before, concrete>","after":"<the state after, concrete>","cueRef":"<optional shotIndex>"}. role is "actor" (a subject acts), "prop" (an object changes state) or "information" (a reveal the audience learns). A purpose that names nothing — "animation", "movement", "nice" — is refused; before/after must differ in the WORLD (camera movement is not acting); skip sceneActions entirely for scenes that genuinely hold still. Two or three entries max per scene.

Cinematic shot fields (S48 — every shot carries ALL of them):
- subject: the single dominant subject of THIS shot (who or what fills the frame) — a noun phrase, concrete.
- subjectAction: what the subject is doing in this shot — an active verb phrase ("raising the ink-blackened reed pen", "cresting the dune at dusk").
- cameraHeight: eye-level | low-angle | high-angle | overhead | ground-level.
- angle: front | three-quarter | profile | back.
- depthOfField: deep (everything sharp) | shallow (subject isolated) | rack (focus shifts inside the shot).
- lighting: a concrete lighting scheme ("golden hour rim light", "single oil lamp, deep shadows", "flat overcast diffusion").
- colorGrade: a color treatment ("teal-orange", "desaturated documentary", "warm sepia"). Keep it consistent within a scene; evolve it across the video's arc only when the story turns.
- focal: where the eye must stay — center | left | right | upper | lower | upper-left | upper-right | lower-left | lower-right.
- moveSpeed: slow (weight, grief, awe) | normal | fast (energy, urgency). Vary it with the narration's beats.
- transitionOut: cut | fade — how THIS shot hands to the next (the scene-level transitionIn governs scene boundaries).
- purpose: establish | contextualize | detail | reaction | reveal | payoff — the shot's narrative function.
- notes: one short line for the human reviewing your plan (why this choice). May be "".

- Respond with STRICT JSON only, no markdown fences, matching exactly:
{"concept":"<one paragraph directorial concept>","musicMood":"cinematic","ducking":"standard","scenes":[{"sceneIndex":1,"mood":"<palette + lighting + time-of-day>","transitionIn":"fade","motion":"smart","needsI2V":false,"useStock":false,"pacing":"normal","ambience":"none","sfx":"none","locations":[],"props":[],"outfit":"<when cast present>","accessory":"<when cast present>","sceneActions":[],"shots":[{"shotIndex":0,"framing":"wide","camera":"zoom-in","lens":"24mm wide","composition":"leading lines","duration":2.8,"imagePrompt":"<what THIS shot shows, one sentence>","subject":"<dominant subject>","subjectAction":"<active verb phrase>","cameraHeight":"eye-level","angle":"three-quarter","depthOfField":"deep","lighting":"<concrete scheme>","colorGrade":"<treatment>","focal":"center","moveSpeed":"normal","transitionOut":"cut","purpose":"establish","notes":""}]}]}`;

/** S48 — the Director's model hint. The S47 acceptance benchmark measured
 * the platform default (glm-4.5-flash) failing the narrative re-run 3/3
 * (prose instead of JSON, scene-less objects); glm-4.6 held through 12/12
 * plans across six genres. The hint rides llmChat ONLY when the operator
 * has not pinned their own chat model (resolveChatModel precedence). */
export const DIRECTOR_MODEL_HINT = "glm-4.6";

/** The system message for a given profile: its opening (the format's voice)
 *  followed by the format-neutral Rules + JSON schema. Pure. S49: under a
 *  restricted content policy, the policy overlay (the compose-around doctrine)
 *  is appended — the profile's own voice and the policy's rules stack, they
 *  do not replace each other. */
export function directorSystemPrompt(
  profile: ProductionProfile,
  contentPolicy?: string | null
): string {
  const overlay = policySystemOverlay(resolveContentPolicy(contentPolicy));
  return `${profile.systemOverlay}\n\n${BASE_SYSTEM_PROMPT}${overlay ? `\n\n${overlay}` : ""}`;
}

function sceneBrief(scene: Scene, estSeconds: number | null): string {
  const words = scene.narration.trim().split(/\s+/).filter(Boolean).length;
  const est = estSeconds ?? Math.round((words / 2.6) * 10) / 10; // ~155 wpm
  return [
    `Scene ${scene.index} "${scene.title}" (~${est}s):`,
    `  narration: ${scene.narration.slice(0, 300)}`,
    `  visual: ${scene.visual.slice(0, 200)}`,
    `  current mood keywords: ${scene.mood}`,
    scene.hostInScene ? "  cast: the recurring host IS in this scene" : "  cast: none",
    scene.rehook ? "  NOTE: attention pivot — open with a punch (fast shot, hard cut)" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Assemble the user-side prompt for the director pass. PURE — no fs / db /
 *  AI; unit-testable. The profile narrows the catalog lists (vocabularies)
 *  and surfaces its default-tone fallbacks as hints. The shape mirrors the
 *  pre-M1 prompt exactly when the profile is `narrative` (the compatibility
 *  profile) — its vocabularies are the FULL catalogs. */
export function buildDirectorUserPrompt(input: {
  video: { title: string | null; topic: string; niche: string; tone: string };
  scenes: Scene[];
  estTotal: number;
  castBlock: string;
  worldBlock: string;
  profile: ProductionProfile;
  /** S88 — the reference-video structure block ("" = no reference
   *  analyzed; the prompt stays byte-identical to the pre-S88 shape,
   *  which the regression golden test pins). */
  referenceBlock?: string;
}): string {
  const { video, scenes, estTotal, castBlock, worldBlock, profile, referenceBlock } = input;
  // Profile vocabularies narrow the catalogs. Absent → full catalog (the
  // narrative behavior — no narrowing).
  const fr = profile.vocabularies?.framings ?? FRAMINGS;
  const cm = profile.vocabularies?.cameras ?? CAMERA_MOVES;
  const tr = profile.vocabularies?.transitions ?? TRANSITION_IDS;
  // Default-tone hints: surfaced as an advisory block (the LLM is free to
  // deviate when a scene clearly demands it). Omitted entirely when the
  // profile sets no defaults — narrative carries them, so the hint line
  // appears identically in the regression golden test.
  const tone = profile.defaultTone;
  const toneHints = [
    tone.transitionBias ? `transition bias: ${tone.transitionBias}` : "",
    tone.pacingBias ? `pacing bias: ${tone.pacingBias}` : "",
    tone.shotDensity ? `shot density: ${tone.shotDensity}` : "",
  ].filter(Boolean).join("; ");
  return [
    `Video: "${video.title ?? video.topic}" — topic: ${video.topic} — niche: ${video.niche} — tone: ${video.tone}.`,
    `Target length: ~${estTotal}s across ${scenes.length} scenes.`,
    castBlock,
    `Transition ids: ${tr.join(", ")}.`,
    `Framings: ${fr.join(", ")}. Camera moves: ${cm.join(", ")}. Compositions: ${COMPOSITIONS.join(", ")}.`,
    `Pacing: ${PACINGS.join(" | ")}. Ambience kinds: ${AMBIENCE_KINDS.join(" | ")}. Sfx cues: ${SFX_HINTS.join(" | ")}.`,
    `Music mood ids: suspenseful, cinematic, emotional, uplifting, calm. Ducking: subtle | standard | strong.`,
    toneHints ? `Profile defaults (advisory — override when a scene clearly demands it): ${toneHints}.` : "",
    referenceBlock ?? "",
    worldBlock,
    "Scenes:",
    ...scenes.map((s) => sceneBrief(s, null)),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Run the director pass for one video. Job body — runs under tenant ctx.
 *
 *  M1 — the `format !== "story"` gate is GONE. The empty-scenes check stays
 *  (non-scene videos have nothing to direct — that error is unchanged).
 *  The optional `profile` selects a ProductionProfile (default narrative);
 *  the chosen profile's `systemOverlay` opens the system prompt, its
 *  vocabularies narrow the catalogs the LLM is asked to pick from, and its
 *  `validation(plan)` findings land in the activity feed for a human to
 *  see before approving (the approval-card detail is a later milestone). */
export async function runDirectorPass(
  videoId: string,
  opts?: { profile?: string }
): Promise<void> {
  const ctx = assertCtx("runDirectorPass");
  const profile = resolveProfile(opts?.profile);
  const video = await db.video.findUnique({
    where: { id: videoId },
    include: {
      character: {
        select: { id: true, name: true, appearance: true, identityAnchor: true },
      },
    },
  });
  if (!video) return;
  // M1 — the format gate is replaced by the empty-scenes check. A non-scene
  // video has no scenes (parseScenes returns []), so the empty-scenes error
  // fires identically — same message, same caller contract.
  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0)
    throw new Error("No scenes to direct — generate the scene script first");

  const totalWords = scenes.reduce(
    (acc, s) => acc + s.narration.trim().split(/\s+/).filter(Boolean).length,
    0
  );
  const estTotal = Math.round(totalWords / 2.6);

  const castBlock = video.character
    ? [
        `Recurring cast: "${video.character.name}".`,
        video.character.appearance ? `Look: ${video.character.appearance}` : "",
        video.character.identityAnchor ? `Identity anchor: ${video.character.identityAnchor}` : "",
        "For every scene where the host appears, include outfit + accessory (keep consistent across scenes unless narration demands a change).",
      ]
        .filter(Boolean)
        .join("\n")
    : "No recurring cast — omit outfit/accessory fields.";

  // Module C — the World library: recurring set pieces the director may
  // reference per scene. Under an approved plan their descriptions weave
  // into scene image prompts (set continuity), so the pass only ever sees
  // ACTIVE entries and only ever suggests exact library names.
  const [worldLocations, worldProps] = await Promise.all([
    db.location.findMany({
      where: { organizationId: video.organizationId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { name: true, description: true },
    }),
    db.prop.findMany({
      where: { organizationId: video.organizationId, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { name: true, description: true },
    }),
  ]);
  const worldBlock =
    worldLocations.length + worldProps.length > 0
      ? [
          worldLocations.length > 0
            ? `Location library (tag scenes with exact names):\n${worldLocations
                .map((l) => `- ${l.name}${l.description ? ` — ${l.description}` : ""}`)
                .join("\n")}`
            : "",
          worldProps.length > 0
            ? `Prop library (tag scenes with exact names):\n${worldProps
                .map((p) => `- ${p.name}${p.description ? ` — ${p.description}` : ""}`)
                .join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n\n")
      : "No location/prop library — use empty locations/props arrays.";

  // S88 — Reference-video intelligence: when the video carries a reference
  // analysis, the Director sees the ABSTRACT structure (pacing profile,
  // beat roles, treatment adjectives, narration density) — patterns to
  // mirror, never words or footage (referenceBlockForPrompt is pinned to
  // never emit the transcript). No analysis → empty block → the prompt
  // stays byte-identical to the pre-S88 shape.
  const reference = parseReferenceAnalysis(video.referenceAnalysis);
  const referenceBlock = reference ? referenceBlockForPrompt(reference) : "";

  const userPrompt = buildDirectorUserPrompt({
    video: { title: video.title, topic: video.topic, niche: video.niche, tone: video.tone },
    scenes,
    estTotal,
    castBlock,
    worldBlock,
    profile,
    referenceBlock,
  });

  // S45 — parse + normalize INSIDE the retried closure. The live re-run bug:
  // attempt 1 succeeded, attempt 2's response (prose around the JSON, a
  // stray brace after it) died at parseJsonLoose with no re-ask, failing
  // the whole job. Now a malformed or scene-less response costs one fresh
  // generation, and the hardened parser (ai.ts) recovers most variance
  // without spending the retry at all.
  // S48 — the model hint upgrades the gateway default to the director-grade
  // glm-4.6 (the S47 benchmark finding) without ever overriding an operator
  // pick (resolveChatModel precedence).
  const normalized = await aiCallJson<DirectorPlan>("llm", "director pass LLM",
    async () =>
      (await llmChat({
        messages: [
          { role: "system", content: directorSystemPrompt(profile, video.contentPolicy) },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.6,
      }, { modelHint: DIRECTOR_MODEL_HINT })).choices?.[0]?.message?.content ?? "",
    {
      validate: (parsed) => {
        const plan = parsePlan(
          typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed) : null
        );
        if (!plan || plan.scenes.length === 0)
          throw new Error("Director pass returned no usable scenes — try again");
        // S47 — the plan must cover EVERY seeded scene. The acceptance
        // benchmark caught the model closing the root early (scene 1, then
        // sibling objects as trailing junk); the parser recovers the leading
        // object honestly, but a 1-of-3 plan is a truncated suggestion that
        // silently stops steering scenes 2+ — it costs one fresh generation,
        // not a degraded plan the human then has to notice.
        if (plan.scenes.length !== scenes.length)
          throw new Error(
            `Director pass covered ${plan.scenes.length} of ${scenes.length} scenes — try again`
          );
        return plan;
      },
    }
  );

  const plan: DirectorPlan = {
    ...normalized,
    version: 2,
    profile: profile.id,
    // S49 — record the policy this plan was authored under (provenance for
    // the QC gate + audit; enforcement reads Video.contentPolicy).
    contentPolicy: resolveContentPolicy(video.contentPolicy),
    generatedAt: new Date().toISOString(),
  };

  // S49 (L2) — sanitize the plan itself: any shot imagePrompt/subject that
  // named a restricted figure is rewritten to a compliant composition BEFORE
  // the plan is persisted, and the substitution is ANNOUNCED in the activity
  // feed so the human sees exactly what the policy touched before approving.
  // The plan never applies itself — the human stays the approval gate.
  const contentPolicy = resolveContentPolicy(video.contentPolicy);
  let policySubstitutions = 0;
  const policyHits = new Set<string>();
  if (contentPolicy === "islamic-history") {
    for (const scene of plan.scenes) {
      for (const shot of scene.shots) {
        for (const field of ["imagePrompt", "subject"] as const) {
          const raw = shot[field] ?? "";
          if (!raw) continue;
          // subject is short metadata — substitute WITHOUT the full negative
          // clause (it rides the imagePrompt, which carries it below).
          const res = sanitizePromptForPolicy(raw, contentPolicy, {
            appendNegative: field === "imagePrompt",
          });
          if (res.substituted > 0) {
            shot[field] = res.prompt;
            policySubstitutions += res.substituted;
            for (const m of res.matches) policyHits.add(m.entry);
          }
        }
      }
    }
  }

  await db.video.update({
    where: { id: videoId },
    data: { shotList: serializePlan(plan), directorState: "proposed", error: null },
  });

  // S49 — visibility is UNCONDITIONAL under the policy: the human always sees
  // a policy outcome row on the director activity (warn when the sanitizer
  // rewrote something, info when the model arrived fully compliant — the
  // layered design worked and no rewrite was needed). Silent compliance is
  // still silence; the policy's touch must always be visible.
  if (contentPolicy === "islamic-history") {
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "director",
        level: policySubstitutions > 0 ? "warn" : "info",
        message:
          policySubstitutions > 0
            ? `Content policy (islamic-history) rewrote ${policySubstitutions} shot prompt field(s) that named restricted subject(s): ` +
              `${[...policyHits].slice(0, 5).join(", ")} — the compositions now steer around them. Review before approving.`.slice(0, 500)
            : "Content policy (islamic-history): the proposed plan is fully compliant — no restricted-subject depiction in any shot prompt.",
      },
    });
  }

  // Cast appearance log — upsert one row per (scene, character) for scenes
  // where the host is present and the plan described a look.
  if (video.characterId && video.character) {
    for (const s of plan.scenes) {
      const scene = scenes.find((x) => x.index === s.sceneIndex);
      if (!scene?.hostInScene) continue;
      const data = {
        outfit: s.outfit ?? null,
        accessory: s.accessory ?? null,
        mood: s.mood || null,
      };
      await db.characterAppearance.upsert({
        where: {
          videoId_sceneIndex_characterId: {
            videoId,
            sceneIndex: s.sceneIndex,
            characterId: video.characterId,
          },
        },
        create: {
          organizationId: video.organizationId,
          characterId: video.characterId,
          videoId,
          sceneIndex: s.sceneIndex,
          ...data,
        },
        update: data,
      });
    }
  }

  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: ctx.userId,
      videoId,
      stage: "director",
      message: `AI Director proposed a plan (${plan.scenes.length} scenes${profile.id !== "narrative" ? `, profile: ${profile.id}` : ""}): ${plan.concept.slice(0, 120)}`,
    },
  });

  // M1 — the profile's `validation(plan)` findings land in the activity
  // feed so a human sees the notes BEFORE approving. Advisory only — the
  // plan is already persisted with directorState "proposed"; the human is
  // the approval gate. (The approval-card detail surfaces these in a later
  // milestone; §3 guardrails: "no silent creative decisions".)
  const issues = profile.validation(plan);
  if (issues.length > 0) {
    await db.activity.create({
      data: {
        organizationId: video.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "director",
        message: `${profile.label} profile notes (${issues.length}): ${issues.join(" | ")}`.slice(0, 500),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Human approval gate.

export async function setDirectorState(
  videoId: string,
  state: DirectorState
): Promise<void> {
  const ctx = assertCtx("setDirectorState");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  await db.video.update({
    where: { id: videoId },
    data: { directorState: state },
  });
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: ctx.userId,
      videoId,
      stage: "director",
      message:
        state === "approved"
          ? "Director plan approved — it now steers image prompts, motion and transitions"
          : state === "dismissed"
            ? "Director plan dismissed — rendering without it"
            : "Director plan reset",
    },
  });
}

// ---------------------------------------------------------------------------
// VLM continuity check.

function scoreVerdict(score: number): SceneConsistency["verdict"] {
  if (score >= 80) return "consistent";
  if (score >= 55) return "drift";
  return "off";
}

const CONTINUITY_SYSTEM = `You are a continuity checker for a faceless YouTube video. You compare ONE generated scene image against the character's identity description (and reference images when provided). Judge ONLY identity continuity: face consistency, hair, apparent age, build, clothing vs the stated outfit. Ignore art style, framing and background — they vary by design.

Respond with STRICT JSON only: {"score":<0-100>,"issues":["<short human-readable issue>"]} — score 100 means the depicted character matches the identity; list concrete mismatches (empty array when none).`;

/** Run the VLM continuity check for one video. Job body — runs under ctx.
 *  S79: `opts.onlyScene` scopes the pass to ONE scene and runs it DRY —
 *  no column write, no Activity row (the targeted consistency re-check
 *  owns reporting; a full overwrite would erase the V2 report's other
 *  dimensions). */
export async function runContinuityCheck(
  videoId: string,
  opts: { onlyScene?: number } = {}
): Promise<ContinuityReport> {
  const ctx = assertCtx("runContinuityCheck");
  const video = await db.video.findUnique({
    where: { id: videoId },
    include: { character: { select: { id: true, name: true, identityAnchor: true, referenceImages: true } } },
  });
  if (!video) throw new Error("Video not found");
  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0) throw new Error("No scenes to check");

  const refKeys: string[] = (() => {
    try {
      const parsed = JSON.parse(video.character?.referenceImages ?? "[]");
      return Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
    } catch {
      return [];
    }
  })();
  const refBuffers: { name: string; base64: string }[] = [];
  if (video.character?.id) {
    for (const key of refKeys.slice(0, 3)) {
      const buf = await storage.get(key).catch(() => null);
      if (buf) refBuffers.push({ name: key, base64: buf.toString("base64") });
    }
    const portrait = await readPortrait(video.character.id).catch(() => null);
    if (portrait) refBuffers.push({ name: "portrait", base64: portrait.toString("base64") });
  }

  const identity = video.character?.identityAnchor || video.character?.name || null;
  const checked: SceneConsistency[] = [];
  for (const scene of scenes) {
    if (opts.onlyScene !== undefined && scene.index !== opts.onlyScene) continue;
    if (!scene.hostInScene || !identity) continue; // only cast scenes are checkable
    const buf = await storage.get(`${videoId}/${sceneImageFile(scene.index)}`).catch(() => null);
    if (!buf) continue; // unpainted scene — nothing to check yet

    const userParts: unknown[] = [
      { type: "text", text: `Character identity: ${identity}` },
      { type: "text", text: `Scene ${scene.index} ("${scene.title}") generated image follows.` },
      { type: "image_url", image_url: { url: `data:image/png;base64,${buf.toString("base64")}` } },
    ];
    for (const ref of refBuffers) {
      userParts.push({ type: "text", text: `Reference image (${ref.name}):` });
      userParts.push({ type: "image_url", image_url: { url: `data:image/png;base64,${ref.base64}` } });
    }

    try {
      const raw = await aiCall("llm", "continuity VLM", () =>
        llmVision({
          messages: [
            { role: "system", content: CONTINUITY_SYSTEM },
            { role: "user", content: userParts },
          ],
          temperature: 0.1,
        })
      );
      const text = raw.choices?.[0]?.message?.content ?? "";
      const parsed = parseJsonLoose(text) as { score?: unknown; issues?: unknown };
      const scoreNum = Number(parsed.score);
      const score = Math.round(
        Math.min(100, Math.max(0, Number.isFinite(scoreNum) ? scoreNum : 50))
      );
      const issues = Array.isArray(parsed.issues)
        ? parsed.issues.filter((i): i is string => typeof i === "string").slice(0, 6)
        : [];
      checked.push({ sceneIndex: scene.index, score, verdict: scoreVerdict(score), issues });
    } catch (err) {
      // One bad scene must not kill the whole report — record as unknown-low.
      checked.push({
        sceneIndex: scene.index,
        score: 0,
        verdict: "off",
        issues: [`check failed: ${errorText(err, "vision error").slice(0, 120)}`],
      });
    }
  }

  const report: ContinuityReport = {
    checkedAt: new Date().toISOString(),
    overall: checked.length
      ? Math.round(checked.reduce((a, c) => a + c.score, 0) / checked.length)
      : 0,
    scenes: checked.sort((a, b) => a.sceneIndex - b.sceneIndex),
  };
  // A scene-scoped (dry) run reports through its caller — the targeted
  // re-check merges it into the V2 envelope; a full overwrite here would
  // destroy the other dimensions' truth.
  if (opts.onlyScene !== undefined) return report;
  await db.video.update({
    where: { id: videoId },
    data: { consistency: JSON.stringify(report), error: null },
  });
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      userId: ctx.userId,
      videoId,
      stage: "continuity",
      message: `Continuity check: ${report.overall}% overall across ${checked.length} scene(s)`,
    },
  });
  return report;
}

export function parseConsistency(json: string | null | undefined): ContinuityReport | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as ContinuityReport;
    if (!raw || !Array.isArray(raw.scenes)) return null;
    return raw;
  } catch {
    return null;
  }
}
