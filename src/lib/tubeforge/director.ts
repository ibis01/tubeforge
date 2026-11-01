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
import { parseJsonLoose } from "./ai";
import { parseScenes, sceneImageFile } from "./story";
import * as storage from "./storage";
import { errorText } from "./redact";
import { TRANSITIONS } from "./transitions";
import type { Scene } from "./types";
import { readPortrait } from "./characters";
import {
  FRAMINGS,
  CAMERA_MOVES,
  COMPOSITIONS,
  PACINGS,
  AMBIENCE_KINDS,
  SFX_HINTS,
  parsePlan,
  serializePlan,
  type DirectorPlan,
  type DirectorState,
} from "./director-plan";

// Re-export the plan layer so the rest of the app keeps ONE import surface.
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
  type DirectorShot,
  type DirectorScene,
  type DirectorPlan,
  type DirectorState,
} from "./director-plan";

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

const SYSTEM_PROMPT = `You are the AI Director of a faceless YouTube video studio. You turn a scene script into a deliberate shot plan: pacing, framing, camera movement, lens character, composition, scene transitions AND the audio direction (narration pacing, ambient beds, boundary cues, music mood, ducking).

Rules:
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
- Respond with STRICT JSON only, no markdown fences, matching exactly:
{"concept":"<one paragraph directorial concept>","musicMood":"cinematic","ducking":"standard","scenes":[{"sceneIndex":1,"mood":"<palette + lighting + time-of-day>","transitionIn":"fade","motion":"smart","needsI2V":false,"useStock":false,"pacing":"normal","ambience":"none","sfx":"none","outfit":"<when cast present>","accessory":"<when cast present>","shots":[{"shotIndex":0,"framing":"wide","camera":"push-in","lens":"24mm wide","composition":"leading lines","duration":2.8,"imagePrompt":"<what THIS shot shows, one sentence>"}]}]}`;

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

/** Run the director pass for one video. Job body — runs under tenant ctx. */
export async function runDirectorPass(videoId: string): Promise<void> {
  const ctx = assertCtx("runDirectorPass");
  const video = await db.video.findUnique({
    where: { id: videoId },
    include: {
      character: {
        select: { id: true, name: true, appearance: true, identityAnchor: true },
      },
    },
  });
  if (!video) return;
  if (video.format !== "story")
    throw new Error("The AI Director applies to scene-format videos — convert the script first");
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

  const userPrompt = [
    `Video: "${video.title ?? video.topic}" — topic: ${video.topic} — niche: ${video.niche} — tone: ${video.tone}.`,
    `Target length: ~${estTotal}s across ${scenes.length} scenes.`,
    castBlock,
    `Transition ids: ${TRANSITION_IDS.join(", ")}.`,
    `Framings: ${FRAMINGS.join(", ")}. Camera moves: ${CAMERA_MOVES.join(", ")}. Compositions: ${COMPOSITIONS.join(", ")}.`,
    `Pacing: ${PACINGS.join(" | ")}. Ambience kinds: ${AMBIENCE_KINDS.join(" | ")}. Sfx cues: ${SFX_HINTS.join(" | ")}.`,
    `Music mood ids: suspenseful, cinematic, emotional, uplifting, calm. Ducking: subtle | standard | strong.`,
    "Scenes:",
    ...scenes.map((s) => sceneBrief(s, null)),
  ]
    .filter(Boolean)
    .join("\n\n");

  const raw = await aiCall("llm", "director pass LLM", () =>
    llmChat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.6,
    })
  );
  const text = raw.choices?.[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(text) as unknown;
  const normalized = parsePlan(
    typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed) : null
  );
  if (!normalized || normalized.scenes.length === 0)
    throw new Error("Director pass returned no usable scenes — try again");

  const plan: DirectorPlan = {
    ...normalized,
    version: 1,
    generatedAt: new Date().toISOString(),
  };

  await db.video.update({
    where: { id: videoId },
    data: { shotList: serializePlan(plan), directorState: "proposed", error: null },
  });

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
      message: `AI Director proposed a plan (${plan.scenes.length} scenes): ${plan.concept.slice(0, 120)}`,
    },
  });
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

/** Run the VLM continuity check for one video. Job body — runs under ctx. */
export async function runContinuityCheck(videoId: string): Promise<ContinuityReport> {
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
