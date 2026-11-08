#!/usr/bin/env node
/**
 * S62 — REAL image-to-video validation across the production profiles.
 *
 *   node --import tsx scripts/s62-i2v-validation.mts --profile narrative
 *   node --import tsx scripts/s62-i2v-validation.mts --status
 *
 * Per profile, the ENTIRE production chain runs for real (no mocks, no
 * fixtures — the only fixed inputs are the two seeded script scenes):
 *
 *   1. DIRECTOR — the profile's own overlay + vocabularies author a real
 *      plan: directorSystemPrompt(profile, policy) + buildDirectorUserPrompt
 *      → llmChat (glm-4.6 hint, temperature 0.6) → parsePlan inside
 *      aiCallJson's retried validation, 2/2 scene coverage required.
 *   2. SCENE ART — shot 0's imagePrompt through the REAL image path
 *      (imageGenerate, size 1344x768, sanitized under the plan's content
 *      policy exactly like shots.ts L3 — appendNegative:true).
 *   3. I2V — the REAL plan-aware motion prompt (i2vMotionPrompt, sanitized
 *      like render.ts) drives the real CogVideoX call via
 *      zaiVideoViaClient with ensureSceneClip's exact options (duration 5,
 *      fps 30, size 1920x1080, poll 10s × 60) and its retry shape.
 *   4. QC — ffprobe geometry + runQcReport on the raw clip; frames at
 *      1.0 / 2.5 / 4.0 s land beside the clip for the blind scoring pass.
 *
 * Everything lands in validation/s62/ (gitignored evidence): the plan, the
 * art PNG, the clip MP4, three frames, and one manifest entry per profile
 * (prompts, timings, probe, QC). Resumable — a profile with a manifest
 * entry and a healthy clip is skipped unless --force.
 */

import { execFile } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";

import { parsePlan, type DirectorPlan } from "../src/lib/tubeforge/director-plan";
import {
  DIRECTOR_MODEL_HINT,
  buildDirectorUserPrompt,
  directorSystemPrompt,
} from "../src/lib/tubeforge/director";
import {
  planProfileNotes,
  resolveProfile,
} from "../src/lib/tubeforge/production-profiles";
import { aiCall } from "../src/lib/tubeforge/budget";
import { aiCallJson } from "../src/lib/tubeforge/ai";
import { llmChat } from "../src/lib/tubeforge/llm";
import {
  resolveContentPolicy,
  sanitizePromptForPolicy,
} from "../src/lib/tubeforge/restricted-subjects";
import { imageGenerate } from "../src/lib/tubeforge/providers/image";
import {
  VIDEO_DEFAULT_MODEL,
  getCapability,
} from "../src/lib/tubeforge/providers/settings";
import { zaiClientFor } from "../src/lib/tubeforge/zai-client";
import { zaiVideoViaClient } from "../src/lib/tubeforge/providers/zai-video-core";
import { i2vMotionPrompt } from "../src/lib/tubeforge/liveliness";
import { runQcReport } from "../src/lib/tubeforge/qc";
import type { Scene } from "../src/lib/tubeforge/types";

const execFileP = promisify(execFile);
const OUT_DIR = path.join(process.cwd(), "validation", "s62");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

// ---------------------------------------------------------------------------
// The briefs. Two seeded script scenes per profile, written to exercise the
// profile's signature discipline (advertisement's product-forward open,
// social's ≤2s hook, islamic-history's compose-around-not-on doctrine…).

interface ProfileBrief {
  id: string;
  title: string;
  topic: string;
  niche: string;
  tone: string;
  contentPolicy?: "islamic-history";
  scenes: Scene[];
}

function seedScene(index: number, title: string, narration: string, visual: string, mood: string): Scene {
  return {
    index,
    title,
    narration,
    visual,
    camera: "static",
    mood,
    caption: title.slice(0, 45),
    hostInScene: false,
    rehook: false,
    sfx: "none",
  };
}

const BRIEFS: ProfileBrief[] = [
  {
    id: "narrative",
    title: "The Lighthouse Keeper of Biarritz",
    topic: "A lone lighthouse keeper's quiet nightly ritual and the storm that tested it",
    niche: "history",
    tone: "reflective",
    scenes: [
      seedScene(1, "The ritual begins", "Every night at sundown, Elias climbed the one hundred and eight steps of the Biarritz light, checking the wick, winding the clockwork, and speaking to the sea as if it could answer.", "A weathered stone lighthouse interior at dusk, an old keeper climbing a spiral iron staircase with a lantern, warm amber light against deep blue shadows", "warm amber, nostalgic, soft dusk light"),
      seedScene(2, "The storm arrives", "That October, a storm came off the Bay of Biscay with a fury the coast had not seen in thirty years, and the lamp — his lamp — was the only thing between the fishing fleet and the rocks.", "Massive storm waves crashing against a lighthouse at night, spray exploding upward, the beam cutting through rain and chaos", "cold steel blue, violent, high contrast"),
    ],
  },
  {
    id: "documentary",
    title: "The Suez Shortcut",
    topic: "How the Suez Canal reshaped global trade routes and the economics of shipping",
    niche: "economics",
    tone: "neutral",
    scenes: [
      seedScene(1, "A canal between two seas", "In 1869, engineers joined the Mediterranean to the Red Sea, and the map of world trade was redrawn in a single century-defining decade.", "Aerial documentary shot of the Suez Canal cutting through desert, a massive container ship passing between sand banks, real daylight footage", "documentary natural color, clear daylight"),
      seedScene(2, "Eight percent of everything", "Today roughly twelve percent of global trade — containers, oil, and liquefied gas — squeezes through this one hundred and ninety kilometer corridor.", "Historical archive footage style: cargo ships and cranes at Port Said harbor, containers stacked in rows, workers on the dock", "archival, slightly desaturated, factual"),
    ],
  },
  {
    id: "explainer",
    title: "How a 4-Stroke Engine Works",
    topic: "The four strokes of an internal combustion engine, explained step by step",
    niche: "engineering",
    tone: "clear",
    scenes: [
      seedScene(1, "Suck, squeeze", "An engine breathes in four beats. First the piston falls, pulling a mix of air and fuel into the cylinder — the intake stroke.", "Cutaway diagram of a car engine cylinder, piston sliding down, intake valve open, blue air-fuel mixture flowing in, clean technical illustration", "clean, bright, technical"),
      seedScene(2, "Bang, blow", "Then the spark ignites the mixture, driving the piston down with real force — and on the way back up, the spent gases are pushed out the exhaust.", "Cutaway engine cylinder with spark plug firing, orange combustion explosion driving the piston down, exhaust valve opening, technical illustration", "high contrast orange flash, technical"),
    ],
  },
  {
    id: "advertisement",
    title: "Aurora Cold Brew",
    topic: "Launch ad for Aurora, a premium cold-brew coffee in a frosted glass bottle",
    niche: "beverage",
    tone: "energetic",
    scenes: [
      seedScene(1, "Meet Aurora", "Meet Aurora. Single-origin Colombian beans, steeped slow for eighteen hours, bottled cold — coffee the way it tastes at origin.", "Hero product shot of a frosted glass cold-brew coffee bottle on wet slate, condensation droplets, coffee beans scattered around, dramatic backlight", "rich brown and gold, premium, moody"),
      seedScene(2, "Your morning, upgraded", "Skip the line. Skip the wait. Tap the link, order your first twelve-pack, and taste what patience tastes like.", "A hand reaching for the cold brew bottle on a kitchen counter at sunrise, bottle label facing camera, warm morning light with space for a CTA overlay", "warm sunrise gold, inviting"),
    ],
  },
  {
    id: "animation",
    title: "The Paper Dragon",
    topic: "An animated short about a folded paper dragon who learns to fly in a rainstorm",
    niche: "animation",
    tone: "whimsical",
    scenes: [
      seedScene(1, "Folded small", "Ping was folded from a single sheet of arithmetic paper — small, creased, and certain he would never fly like the painted dragons on the temple wall.", "A tiny origami paper dragon standing on a wooden desk beside colored ink bottles, looking up longingly at a painted dragon poster on the wall, animated film style", "soft pastel, storybook, warm desk lamp"),
      seedScene(2, "The window opens", "Then a storm flung the window wide — and the same wind that terrifies lanterns lifted a paper wing for the very first time.", "The origami dragon leaping from a windowsill into a rainy night wind, paper wings catching the gust, rain streaks and glowing city lights below, dynamic animated action", "electric blue night, kinetic, glowing"),
    ],
  },
  {
    id: "podcast",
    title: "Deep Work, Real Talk",
    topic: "Why four focused hours beat twelve distracted ones — a talking-head podcast segment",
    niche: "productivity",
    tone: "conversational",
    scenes: [
      seedScene(1, "The four-hour truth", "Here's the uncomfortable math: the average knowledge worker gets four real hours a week. Not a day. A week. Everything else is coordination dressed up as work.", "A host in a warm home studio sitting close to a broadcast microphone, soft bokeh shelves behind, intimate medium shot, natural podcast lighting", "warm amber, intimate, shallow depth of field"),
      seedScene(2, "Protect the block", "So here's the move: one ninety-minute block tomorrow morning. Phone in a drawer. One tab. Watch what your brain does when nobody interrupts it for ninety minutes.", "Close-up of the podcast host leaning in with a slight smile, hand gesturing one finger up to emphasize a point, studio microphone in frame", "warm amber, close, engaged"),
    ],
  },
  {
    id: "social",
    title: "3 Sleep Wreckers",
    topic: "Three evening habits quietly wrecking your sleep — a scroll-stopping short",
    niche: "wellness",
    tone: "punchy",
    scenes: [
      seedScene(1, "The 2am scroll", "Stop scrolling — this is why you're tired. Habit one: that 'quick' phone check in bed costs you forty minutes of real sleep. Every night.", "Extreme close-up of a face lit harshly by phone glow in a dark bedroom at night, eyes wide awake, dramatic side lighting, vertical video energy", "dark blue with harsh phone glow, dramatic"),
      seedScene(2, "The nightcap lie", "Habit two: the nightcap. Alcohol knocks you out, then steals your REM two hours later. And habit three? Your 10pm 'protein shake' is an espresso in disguise.", "A glass of whiskey and a shaker bottle side by side on a nightstand, clock showing 10pm in the background, moody noir lighting", "moody noir, amber and shadow"),
    ],
  },
  {
    id: "islamic-history",
    title: "The House of Wisdom",
    topic: "Bayt al-Hikma in Abbasid Baghdad — the translation movement that preserved ancient knowledge",
    niche: "history",
    tone: "reverent",
    contentPolicy: "islamic-history",
    scenes: [
      seedScene(1, "A library for the world", "In ninth-century Baghdad, the House of Wisdom gathered scholars of many faiths around a single task: carry the knowledge of earlier ages safely into the future.", "Sunlit Abbasid library interior, towering wooden shelves of manuscripts, scholars in period dress reading at low desks, calligraphy scrolls, dust motes in light beams, no faces shown", "golden daylight, reverent, dusty light beams"),
      seedScene(2, "Ink and translation", "Page by page, the works of Aristotle and Ptolemy moved from Greek into Arabic — reed pens scratching through the nights, one careful copy at a time.", "Close pan across an open manuscript with elegant Arabic calligraphy, a reed pen and brass inkwell on a wooden rehal book stand, lamplight on parchment, no people", "lamplight gold on parchment, intimate, reverent"),
    ],
  },
];

// ---------------------------------------------------------------------------

interface ManifestEntry {
  profile: string;
  ok: boolean;
  error?: string;
  topic: string;
  policy: string;
  planProfileNotes: string[];
  shot: Record<string, unknown> | null;
  artPrompt: string;
  motionPrompt: string;
  artBytes: number;
  clipBytes: number;
  probe: Record<string, unknown> | null;
  qc: unknown;
  timingsMs: { llm: number; art: number; i2v: number; total: number };
  planFile?: string;
}

function readManifest(): ManifestEntry[] {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as ManifestEntry[];
  } catch {
    return [];
  }
}

function writeManifest(m: ManifestEntry[]): void {
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
}

async function probeClip(mp4: string): Promise<Record<string, unknown> | null> {
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0",
       "-show_entries", "stream=codec_name,width,height,avg_frame_rate:format=duration,size",
       "-of", "json", mp4]
    );
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

async function grabFrames(mp4: string, base: string): Promise<void> {
  for (const t of [1.0, 2.5, 4.0]) {
    await execFileP("ffmpeg", ["-y", "-v", "error", "-ss", String(t), "-i", mp4,
      "-frames:v", "1", "-q:v", "3", `${base}.f${t}.jpg`]);
  }
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

async function validateProfile(brief: ProfileBrief, force: boolean): Promise<void> {
  const profile = resolveProfile(brief.id);
  if (profile.id !== brief.id) throw new Error(`unknown profile id: ${brief.id}`);

  const manifest = readManifest();
  const prior = manifest.find((m) => m.profile === brief.id);
  const clipPath = path.join(OUT_DIR, `${brief.id}.clip.mp4`);
  if (!force && prior?.ok && fs.existsSync(clipPath) && fs.statSync(clipPath).size > 50_000) {
    console.log(`[${brief.id}] already validated — skipping (use --force to rerun)`);
    return;
  }

  console.log(`\n===== [${brief.id}] ${brief.title} =====`);
  const t0 = Date.now();
  const policyRaw = brief.contentPolicy ?? null;
  const policy = resolveContentPolicy(policyRaw);

  // ---- 1. the director pass (real LLM, real profile overlay) ----
  const estTotal = Math.round(
    brief.scenes.reduce((a, s) => a + wordCount(s.narration), 0) / 2.6
  );
  const llmStart = Date.now();
  const userPrompt = buildDirectorUserPrompt({
    video: { title: brief.title, topic: brief.topic, niche: brief.niche, tone: brief.tone },
    scenes: brief.scenes,
    estTotal,
    castBlock: "No recurring cast — omit outfit/accessory fields.",
    worldBlock: "No location/prop library — use empty locations/props arrays.",
    profile,
  });
  const normalized = await aiCallJson<DirectorPlan>("llm", `s62 director [${brief.id}]`,
    async () =>
      (await llmChat(
        {
          messages: [
            { role: "system", content: directorSystemPrompt(profile, policyRaw) },
            { role: "user", content: userPrompt },
          ],
          temperature: 0.6,
        },
        { modelHint: DIRECTOR_MODEL_HINT }
      )).choices?.[0]?.message?.content ?? "",
    {
      validate: (parsed) => {
        const p = parsePlan(
          typeof parsed === "object" && parsed !== null ? JSON.stringify(parsed) : null
        );
        if (!p || p.scenes.length === 0)
          throw new Error("director returned no usable scenes");
        if (p.scenes.length !== brief.scenes.length)
          throw new Error(`director covered ${p.scenes.length}/${brief.scenes.length} scenes`);
        return p;
      },
    }
  );
  const plan: DirectorPlan = {
    ...normalized,
    version: 2,
    profile: profile.id,
    contentPolicy: policy,
    generatedAt: new Date().toISOString(),
  };
  const llmMs = Date.now() - llmStart;
  fs.writeFileSync(path.join(OUT_DIR, `${brief.id}.plan.json`), JSON.stringify(plan, null, 2));
  console.log(`[${brief.id}] plan: ${plan.scenes.length} scenes, ${
    plan.scenes.reduce((a, s) => a + s.shots.length, 0)
  } shots — ${llmMs} ms`);

  // ---- 2. scene art (real t2i, sanitized like shots.ts L3) ----
  const planScene = plan.scenes[0];
  const shot0 = planScene?.shots?.[0] ?? null;
  const scriptScene = brief.scenes[0];
  const rawArtPrompt = shot0?.imagePrompt?.trim() || scriptScene.visual;
  const artStart = Date.now();
  const artSan = sanitizePromptForPolicy(rawArtPrompt, policy, { appendNegative: true });
  const artBuf = await aiCall("image", `s62 art [${brief.id}]`,
    () => imageGenerate({ prompt: artSan.prompt, size: "1344x768" }),
    { attempts: 2, baseDelayMs: 4000 });
  if (!artBuf || artBuf.length < 10_000) throw new Error("scene art came back empty");
  const artPath = path.join(OUT_DIR, `${brief.id}.art.png`);
  fs.writeFileSync(artPath, artBuf);
  const artMs = Date.now() - artStart;
  console.log(`[${brief.id}] art: ${(artBuf.length / 1024).toFixed(0)} KB — ${artMs} ms${artSan.substituted ? ` (policy substitutions: ${artSan.substituted})` : ""}`);

  // ---- 3. i2v (real CogVideoX, ensureSceneClip's exact shape) ----
  const motionPrompt = sanitizePromptForPolicy(
    i2vMotionPrompt(scriptScene, planScene),
    policy
  ).prompt;
  // Production's ensureSceneClip hard-requires the zai/CogVideoX provider
  // for i2v (any other provider throws there), but a fresh sandbox DB ships
  // the video capability UNCONFIGURED (registry default → "fal"). Pin the
  // provider via the SAME override mechanism the Settings Test button uses —
  // the production i2v shape, stated explicitly. Empty model = provider
  // default (CogVideoX).
  const videoConfig = await getCapability("video", { provider: "zai", model: "" });
  const videoModel = videoConfig.model?.trim() || VIDEO_DEFAULT_MODEL;
  const i2vStart = Date.now();
  const zai = await zaiClientFor("video");
  const clip = await aiCall("video", `s62 i2v [${brief.id}]`,
    async () => {
      const buf = await zaiVideoViaClient(
        zai,
        { prompt: motionPrompt, imagePngBase64: artBuf.toString("base64") },
        {
          model: videoModel,
          duration: 5,
          fps: 30,
          size: "1920x1080",
          pollMs: 10_000,
          maxPolls: 60,
        }
      );
      if (!buf || buf.length < 50_000) throw new Error("i2v returned an empty/invalid buffer");
      return buf;
    },
    { attempts: 3, baseDelayMs: 20000 } // back-to-back submissions meet the gateway's 45s shared 429 cool-down — production calls are naturally spaced by render work, the lane is not
  );
  fs.writeFileSync(clipPath, clip);
  const i2vMs = Date.now() - i2vStart;
  console.log(`[${brief.id}] clip: ${(clip.length / 1024 / 1024).toFixed(1)} MB — ${i2vMs} ms (${(i2vMs / 1000 / 60).toFixed(1)} min)`);

  // ---- 4. QC + frames ----
  const probe = await probeClip(clipPath);
  const dur = Number(
    (probe as { format?: { duration?: string } } | null)?.format?.duration ?? 5
  );
  const qc = await runQcReport({
    mp4Path: clipPath,
    videoDuration: dur,
    narrationSec: null,
    srtPath: null,
  }).catch((e) => ({ error: String(e) }));
  await grabFrames(clipPath, path.join(OUT_DIR, brief.id)).catch(() => {});
  const qcChecks = qc as { checks?: { id?: string; status?: string }[] };
  const qcLine = Array.isArray(qcChecks?.checks)
    ? qcChecks.checks.map((c) => `${c.id ?? "?"}:${c.status ?? "?"}`).join(" ")
    : "(qc report shape unparsed)";
  console.log(`[${brief.id}] qc: ${qcLine}`);

  // ---- manifest ----
  const entry: ManifestEntry = {
    profile: brief.id,
    ok: true,
    topic: brief.topic,
    policy,
    planProfileNotes: planProfileNotes(plan),
    shot: shot0
      ? {
          framing: shot0.framing, camera: shot0.camera, moveSpeed: shot0.moveSpeed,
          duration: shot0.duration, imagePrompt: shot0.imagePrompt,
          subjectAction: shot0.subjectAction ?? null,
        }
      : null,
    artPrompt: artSan.prompt,
    motionPrompt,
    artBytes: artBuf.length,
    clipBytes: clip.length,
    probe,
    qc,
    timingsMs: { llm: llmMs, art: artMs, i2v: i2vMs, total: Date.now() - t0 },
    planFile: `${brief.id}.plan.json`,
  };
  const m = readManifest().filter((x) => x.profile !== brief.id);
  m.push(entry);
  writeManifest(m);
  console.log(`[${brief.id}] DONE — total ${(entry.timingsMs.total / 1000 / 60).toFixed(1)} min; notes: ${
    entry.planProfileNotes.length ? entry.planProfileNotes.join(" | ") : "(profile validation clean)"
  }`);
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  if (args.includes("--status")) {
    const m = readManifest();
    console.log(`${"profile".padEnd(17)} ${"ok".padEnd(3)} ${"clip MB".padEnd(8)} ${"i2v min".padEnd(8)} qc`);
    for (const e of m) {
      const qcC = e.qc as { checks?: { status?: string }[] } | null;
      const bad = Array.isArray(qcC?.checks) ? qcC.checks.filter((c) => c.status && c.status !== "clean" && c.status !== "pass").length : 0;
      console.log(
        `${e.profile.padEnd(17)} ${(e.ok ? "✓" : "✗").padEnd(3)} ${(e.clipBytes / 1048576).toFixed(1).padEnd(8)} ${(e.timingsMs.i2v / 60000).toFixed(1).padEnd(8)} ${bad} flagged`
      );
    }
    if (m.length === 0) console.log("(manifest empty)");
    return;
  }

  const idArg = args.find((a) => a.startsWith("--profile"));
  const id = idArg?.split("=")[1] ?? args[args.indexOf("--profile") + 1];
  const brief = BRIEFS.find((b) => b.id === id);
  if (!brief) {
    console.error(`unknown profile "${id}". Known: ${BRIEFS.map((b) => b.id).join(", ")}`);
    process.exit(1);
  }
  try {
    await validateProfile(brief, force);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[${brief.id}] FAILED — ${msg}`);
    const m = readManifest().filter((x) => x.profile !== brief.id);
    m.push({
      profile: brief.id, ok: false, error: msg, topic: brief.topic,
      policy: resolveContentPolicy(brief.contentPolicy ?? null),
      planProfileNotes: [], shot: null, artPrompt: "", motionPrompt: "",
      artBytes: 0, clipBytes: 0, probe: null, qc: null,
      timingsMs: { llm: 0, art: 0, i2v: 0, total: 0 },
    });
    writeManifest(m);
    process.exit(1);
  }
}

await main();
