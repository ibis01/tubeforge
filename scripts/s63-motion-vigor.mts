#!/usr/bin/env node
/**
 * S63 — subject-motion RE-MEASURE: real i2v with the repaired motion prompt,
 * everything else held verbatim from S62.
 *
 *   node --import tsx scripts/s63-motion-vigor.mts --profile social
 *   node --import tsx scripts/s63-motion-vigor.mts --all
 *   node --import tsx scripts/s63-motion-vigor.mts --status
 *
 * Attribution design (docs/audits/s63-motion-vigor-record.md §3): each
 * profile reuses the S62 plan (validation/s62/<id>.plan.json) and the S62
 * art (validation/s62/<id>.art.png) VERBATIM — no director pass, no new
 * image. The ONLY variable between the S62 clip and the S63 clip is the
 * motion prompt (S63's tempo law + doctrine-always-rides law), plus the
 * gateway's own sampling noise. The i2v call, QC lenses, and frame grabs
 * are the same production shapes the S62 lane used.
 *
 * Evidence lands in validation/s63/ (gitignored by size): the clip, three
 * frames, and a manifest entry per profile carrying BOTH the new prompt and
 * the S62 prompt it replaced.
 */

import { execFile } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";

import { aiCall } from "../src/lib/tubeforge/budget";
import {
  resolveContentPolicy,
  sanitizePromptForPolicy,
} from "../src/lib/tubeforge/restricted-subjects";
import {
  VIDEO_DEFAULT_MODEL,
  getCapability,
} from "../src/lib/tubeforge/providers/settings";
import { zaiClientFor } from "../src/lib/tubeforge/zai-client";
import { zaiVideoViaClient } from "../src/lib/tubeforge/providers/zai-video-core";
import { i2vMotionPrompt } from "../src/lib/tubeforge/liveliness";
import { runQcReport } from "../src/lib/tubeforge/qc";
import type { DirectorPlan } from "../src/lib/tubeforge/director-plan";
import { BRIEFS } from "./s-profile-briefs.mts";

const execFileP = promisify(execFile);
const S62_DIR = path.join(process.cwd(), "validation", "s62");
const OUT_DIR = path.join(process.cwd(), "validation", "s63");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

interface S63Entry {
  profile: string;
  ok: boolean;
  error?: string;
  policy: string;
  shot: Record<string, unknown> | null;
  motionPromptS62: string;
  motionPrompt: string;
  promptChanged: boolean;
  clipBytes: number;
  probe: Record<string, unknown> | null;
  qc: unknown;
  timingsMs: { i2v: number; total: number };
  sources: { plan: string; art: string };
}

function readManifest(): S63Entry[] {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as S63Entry[];
  } catch {
    return [];
  }
}

function writeManifest(m: S63Entry[]): void {
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

async function remeasureProfile(briefId: string, force: boolean): Promise<void> {
  const brief = BRIEFS.find((b) => b.id === briefId);
  if (!brief) throw new Error(`unknown profile id: ${briefId}`);

  const manifest = readManifest();
  const prior = manifest.find((m) => m.profile === briefId);
  const clipPath = path.join(OUT_DIR, `${briefId}.clip.mp4`);
  if (!force && prior?.ok && fs.existsSync(clipPath) && fs.statSync(clipPath).size > 50_000) {
    console.log(`[${briefId}] already re-measured — skipping (use --force to rerun)`);
    return;
  }

  // ---- the S62 sources, verbatim ----
  const planPath = path.join(S62_DIR, `${briefId}.plan.json`);
  const artPath = path.join(S62_DIR, `${briefId}.art.png`);
  if (!fs.existsSync(planPath)) throw new Error(`missing S62 plan ${planPath}`);
  if (!fs.existsSync(artPath)) throw new Error(`missing S62 art ${artPath}`);
  const s62Manifest = JSON.parse(fs.readFileSync(path.join(S62_DIR, "manifest.json"), "utf8")) as
    { profile: string; ok: boolean; motionPrompt: string }[];
  const s62Entry = s62Manifest.find((m) => m.profile === briefId);
  if (!s62Entry?.ok) throw new Error(`S62 manifest has no ok entry for ${briefId}`);
  const artBuf = fs.readFileSync(artPath);
  const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as DirectorPlan;
  const planScene = plan.scenes[0];
  const shot0 = planScene?.shots?.[0] ?? null;
  const scriptScene = brief.scenes[0];
  const policy = resolveContentPolicy(brief.contentPolicy ?? null);

  console.log(`\n===== [${briefId}] re-measure (S62 plan + art reused) =====`);
  const t0 = Date.now();

  // ---- the ONLY variable: the motion prompt under the S63 laws ----
  const motionPromptS62 = s62Entry.motionPrompt;
  const motionPrompt = sanitizePromptForPolicy(
    i2vMotionPrompt(scriptScene, planScene),
    policy
  ).prompt;
  console.log(`[${briefId}] OLD: ${motionPromptS62.slice(0, 100)}…`);
  console.log(`[${briefId}] NEW: ${motionPrompt.slice(0, 100)}…`);
  if (motionPrompt === motionPromptS62) {
    console.log(`[${briefId}] NOTE: prompt unchanged for this profile`);
  }

  // ---- i2v, ensureSceneClip's exact production shape ----
  const videoConfig = await getCapability("video", { provider: "zai", model: "" });
  const videoModel = videoConfig.model?.trim() || VIDEO_DEFAULT_MODEL;
  const i2vStart = Date.now();
  const zai = await zaiClientFor("video");
  const clip = await aiCall("video", `s63 i2v [${briefId}]`,
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
    { attempts: 3, baseDelayMs: 20000 } // the gateway's 45s shared 429 cool-down (S62 receipt)
  );
  fs.writeFileSync(clipPath, clip);
  const i2vMs = Date.now() - i2vStart;
  console.log(`[${briefId}] clip: ${(clip.length / 1024 / 1024).toFixed(1)} MB — ${(i2vMs / 1000 / 60).toFixed(1)} min`);

  // ---- QC + frames (same lenses as S62) ----
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
  await grabFrames(clipPath, path.join(OUT_DIR, briefId)).catch(() => {});
  const qcChecks = qc as { checks?: { id?: string; status?: string }[] };
  const qcLine = Array.isArray(qcChecks?.checks)
    ? qcChecks.checks.map((c) => `${c.id ?? "?"}:${c.status ?? "?"}`).join(" ")
    : "(qc report shape unparsed)";
  console.log(`[${briefId}] qc: ${qcLine}`);

  const entry: S63Entry = {
    profile: briefId,
    ok: true,
    policy,
    shot: shot0
      ? {
          framing: shot0.framing, camera: shot0.camera, moveSpeed: shot0.moveSpeed,
          duration: shot0.duration, imagePrompt: shot0.imagePrompt,
          subjectAction: shot0.subjectAction ?? null,
        }
      : null,
    motionPromptS62,
    motionPrompt,
    promptChanged: motionPrompt !== motionPromptS62,
    clipBytes: clip.length,
    probe,
    qc,
    timingsMs: { i2v: i2vMs, total: Date.now() - t0 },
    sources: { plan: `../s62/${briefId}.plan.json`, art: `../s62/${briefId}.art.png` },
  };
  writeManifest(readManifest().filter((x) => x.profile !== briefId).concat(entry));
  console.log(`[${briefId}] DONE — total ${(entry.timingsMs.total / 1000 / 60).toFixed(1)} min`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  if (args.includes("--status")) {
    const m = readManifest();
    console.log(`${"profile".padEnd(17)} ${"ok".padEnd(3)} ${"Δprompt".padEnd(8)} ${"clip MB".padEnd(8)} ${"i2v min".padEnd(8)} qc`);
    for (const e of m) {
      const qcC = e.qc as { checks?: { status?: string }[] } | null;
      const bad = Array.isArray(qcC?.checks) ? qcC.checks.filter((c) => c.status && c.status !== "clean" && c.status !== "pass").length : 0;
      console.log(
        `${e.profile.padEnd(17)} ${(e.ok ? "✓" : "✗").padEnd(3)} ${(e.promptChanged ? "yes" : "no").padEnd(8)} ${(e.clipBytes / 1048576).toFixed(1).padEnd(8)} ${(e.timingsMs.i2v / 60000).toFixed(1).padEnd(8)} ${bad} flagged`
      );
    }
    if (m.length === 0) console.log("(manifest empty)");
    return;
  }

  const ids = args.includes("--all")
    ? BRIEFS.map((b) => b.id)
    : (() => {
        const idArg = args.find((a) => a.startsWith("--profile"));
        const id = idArg?.split("=")[1] ?? args[args.indexOf("--profile") + 1];
        if (!id) throw new Error("pass --profile <id> or --all");
        return [id];
      })();

  let failed = 0;
  for (const id of ids) {
    try {
      await remeasureProfile(id, force);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${id}] FAILED — ${msg}`);
      writeManifest(readManifest().filter((x) => x.profile !== id).concat({
        profile: id, ok: false, error: msg, policy: "", shot: null,
        motionPromptS62: "", motionPrompt: "", promptChanged: false,
        clipBytes: 0, probe: null, qc: null,
        timingsMs: { i2v: 0, total: 0 },
        sources: { plan: `../s62/${id}.plan.json`, art: `../s62/${id}.art.png` },
      }));
    }
  }
  if (failed > 0) process.exit(1);
}

await main();
