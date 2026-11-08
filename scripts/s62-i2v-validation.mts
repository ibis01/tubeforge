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
import { BRIEFS, type ProfileBrief } from "./s-profile-briefs.mts";

const execFileP = promisify(execFile);
const OUT_DIR = path.join(process.cwd(), "validation", "s62");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

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
