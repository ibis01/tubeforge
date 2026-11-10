#!/usr/bin/env node
/**
 * S74 — S63's motion-vigor re-measure, PAIRED on regenerated art.
 *
 *   node --import tsx scripts/s74-paired-remeasure.mts --profile social
 *   node --import tsx scripts/s74-paired-remeasure.mts --all
 *   node --import tsx scripts/s74-paired-remeasure.mts --status
 *
 *   --pace-ms=<n>  sleep <n> ms before EVERY video submission (the gateway
 *                   throttles back-to-back i2v submissions — the 2026-11-10
 *                   lane receipt: a clip submitted ~0-1 min after the previous
 *                   one returned 429s through 80s/160s backoffs, while the
 *                   pilot's naturally-spaced pair (~4 min between submissions)
 *                   went through clean). Recommended: --pace-ms=150000.
 *
 * WHY PAIRED (the documented deviation, recorded in
 * docs/audits/s74-motion-vigor-remeasure-record.md): the sandbox rebuild
 * between sessions lost the gitignored validation/s62 binaries (art PNGs,
 * plan JSONs, clips, frames) — the original s63-motion-vigor.mts protocol
 * (reuse the S62 art verbatim) is unrunnable as written. What SURVIVED is
 * committed: the S62 manifest, which carries per profile the shot's
 * camera/moveSpeed/subjectAction (the ONLY plan fields i2vMotionPrompt
 * reads — pinned by the S74 unit tests), the exact sanitized artPrompt
 * string that was fed to the image provider, and the exact sanitized
 * motionPrompt string that drove the S62 i2v call.
 *
 * This stage restores the attribution the S63 protocol existed to protect
 * with a STRONGER design: per profile, the art is regenerated ONCE from the
 * committed artPrompt (same production image shape S62 used), then TWO
 * clips are rendered on that SAME art:
 *
 *   before — the S62 motionPrompt VERBATIM (the old laws, exact bytes)
 *   after  — the S63-law prompt, reconstructed from the committed shot
 *
 * Within each pair the ONLY variable is the motion prompt. The blind scorer
 * (s74-blind-score.mts) scores all 16 clips in one shuffled pool under the
 * S62 rubric verbatim; the S62 original scores stay as historical context.
 *
 * Everything lands in validation/s74/ (gitignored by size). Resumable — a
 * profile with a healthy manifest entry, art and both clips is skipped
 * unless --force.
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
import { imageGenerate } from "../src/lib/tubeforge/providers/image";
import { i2vMotionPrompt } from "../src/lib/tubeforge/liveliness";
import { runQcReport } from "../src/lib/tubeforge/qc";
import type { DirectorScene, DirectorShot } from "../src/lib/tubeforge/director-plan";
import { BRIEFS } from "./s-profile-briefs.mts";

const execFileP = promisify(execFile);
const S62_DIR = path.join(process.cwd(), "validation", "s62");
const S62_MANIFEST = path.join(S62_DIR, "manifest.json");
const OUT_DIR = path.join(process.cwd(), "validation", "s74");
const MANIFEST = path.join(OUT_DIR, "manifest.json");

/** The committed S62 manifest entry — the fields this lane consumes. */
interface S62Entry {
  profile: string;
  ok: boolean;
  policy: string;
  shot: {
    framing?: string;
    camera?: string;
    moveSpeed?: string;
    duration?: number;
    imagePrompt?: string;
    subjectAction?: string | null;
  } | null;
  artPrompt: string;
  motionPrompt: string;
}

interface ClipRecord {
  clipBytes: number;
  probe: Record<string, unknown> | null;
  qc: unknown;
  timingsMs: { i2v: number };
}

interface S74Entry {
  profile: string;
  ok: boolean;
  error?: string;
  policy: string;
  policyMatchesS62: boolean;
  shot: S62Entry["shot"];
  artPrompt: string;
  motionPromptBefore: string;
  motionPromptAfter: string;
  promptChanged: boolean;
  artBytes: number;
  before: ClipRecord | null;
  after: ClipRecord | null;
  timingsMs: { art: number; total: number };
  sources: {
    s62Manifest: string;
    briefs: string;
    note: string;
  };
}

function readManifest(): S74Entry[] {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST, "utf8")) as S74Entry[];
  } catch {
    return [];
  }
}

function writeManifest(m: S74Entry[]): void {
  fs.writeFileSync(MANIFEST, JSON.stringify(m, null, 2) + "\n");
}

function readS62Manifest(): S62Entry[] {
  const raw = JSON.parse(fs.readFileSync(S62_MANIFEST, "utf8")) as S62Entry[];
  const ok = raw.filter((e) => e.ok);
  if (ok.length !== 8) {
    throw new Error(`expected 8 ok entries in the committed S62 manifest, found ${ok.length}`);
  }
  return ok;
}

/**
 * Reconstruct the plan scene i2vMotionPrompt needs, from the committed S62
 * manifest shot. i2vMotionPrompt reads ONLY planScene.shots[0].{camera,
 * moveSpeed, subjectAction} (S74 unit pin), so this reconstruction yields
 * the byte-identical prompt the lost validation/s62/<id>.plan.json would
 * have produced.
 */
function reconstructPlanScene(shot: S62Entry["shot"]): DirectorScene {
  const reconShot: DirectorShot = {
    shotIndex: 0,
    framing: String(shot?.framing ?? ""),
    camera: String(shot?.camera ?? ""),
    lens: "",
    composition: "",
    duration: Number(shot?.duration ?? 5),
    imagePrompt: String(shot?.imagePrompt ?? ""),
    subjectAction: shot?.subjectAction ? String(shot.subjectAction) : undefined,
    moveSpeed: shot?.moveSpeed ? String(shot.moveSpeed) : undefined,
  };
  return { shots: [reconShot] } as unknown as DirectorScene;
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

/** One i2v render — ensureSceneClip's exact production shape (S62/S63),
 * with the 2026-11-10 lane receipt baked in: pace before every submission
 * and retry patiently (a 429 response itself seems to extend the throttle
 * window, so hammering with short backoffs digs the hole deeper). */
async function renderClip(
  briefId: string,
  variant: "before" | "after",
  prompt: string,
  artBuf: Buffer,
  videoModel: string,
  zai: Awaited<ReturnType<typeof zaiClientFor>>,
  paceMs: number
): Promise<{ buf: Buffer; ms: number }> {
  if (paceMs > 0) {
    console.log(`[${briefId}/${variant}] pacing ${Math.round(paceMs / 1000)}s before the i2v submission…`);
    await new Promise((r) => setTimeout(r, paceMs));
  }
  const t0 = Date.now();
  const buf = await aiCall("video", `s74 i2v [${briefId}/${variant}]`,
    async () => {
      const out = await zaiVideoViaClient(
        zai,
        { prompt, imagePngBase64: artBuf.toString("base64") },
        {
          model: videoModel,
          duration: 5,
          fps: 30,
          size: "1920x1080",
          pollMs: 10_000,
          maxPolls: 60,
        }
      );
      if (!out || out.length < 50_000) throw new Error("i2v returned an empty/invalid buffer");
      return out;
    },
    // 2026-11-10 receipt: 20s-base × 3 attempts (80s/160s backoffs) failed
    // against the post-success throttle window; 90s base × 3 (180s/360s)
    // spans ~9 patient minutes per submission instead.
    { attempts: 3, baseDelayMs: 90000 }
  );
  return { buf, ms: Date.now() - t0 };
}

async function qcAndFrames(
  clipPath: string,
  frameBase: string
): Promise<{ probe: Record<string, unknown> | null; qc: unknown }> {
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
  await grabFrames(clipPath, frameBase).catch(() => {});
  return { probe, qc };
}

function qcFlagged(qc: unknown): number {
  const checks = (qc as { checks?: { status?: string }[] } | null)?.checks;
  return Array.isArray(checks)
    ? checks.filter((c) => c.status && c.status !== "clean" && c.status !== "pass").length
    : 0;
}

async function remeasureProfile(briefId: string, force: boolean, args: string[]): Promise<void> {
  const brief = BRIEFS.find((b) => b.id === briefId);
  if (!brief) throw new Error(`unknown profile id: ${briefId}`);

  const manifest = readManifest();
  const prior = manifest.find((m) => m.profile === briefId);
  const artPath = path.join(OUT_DIR, `${briefId}.art.png`);
  const beforePath = path.join(OUT_DIR, `${briefId}.before.mp4`);
  const afterPath = path.join(OUT_DIR, `${briefId}.after.mp4`);
  const healthy =
    prior?.ok &&
    fs.existsSync(artPath) && fs.statSync(artPath).size > 10_000 &&
    fs.existsSync(beforePath) && fs.statSync(beforePath).size > 50_000 &&
    fs.existsSync(afterPath) && fs.statSync(afterPath).size > 50_000;
  if (!force && healthy) {
    console.log(`[${briefId}] already re-measured (paired) — skipping (use --force to rerun)`);
    return;
  }

  // ---- the committed S62 sources ----
  const s62 = readS62Manifest();
  const s62Entry = s62.find((m) => m.profile === briefId);
  if (!s62Entry) throw new Error(`S62 manifest has no ok entry for ${briefId}`);

  const policy = resolveContentPolicy(brief.contentPolicy ?? null);
  const scriptScene = brief.scenes[0];
  const planScene = reconstructPlanScene(s62Entry.shot);

  // ---- the two prompts: BEFORE verbatim, AFTER under the S63 laws ----
  const motionPromptBefore = s62Entry.motionPrompt;
  const motionPromptAfter = sanitizePromptForPolicy(
    i2vMotionPrompt(scriptScene, planScene),
    policy
  ).prompt;
  console.log(`\n===== [${briefId}] paired re-measure (same art, two prompts) =====`);
  console.log(`[${briefId}] BEFORE: ${motionPromptBefore.slice(0, 110)}…`);
  console.log(`[${briefId}] AFTER : ${motionPromptAfter.slice(0, 110)}…`);
  if (motionPromptAfter === motionPromptBefore) {
    throw new Error(
      `[${briefId}] the S63-law prompt is byte-identical to the S62 prompt — the pair would measure nothing`
    );
  }

  const paceArg = args.find((a) => a.startsWith("--pace-ms"));
  const paceMs = paceArg ? Math.max(0, Number(paceArg.split("=")[1] ?? 0) || 0) : 0;

  const t0 = Date.now();

  // ---- the art: regenerated ONCE from the committed (sanitized) artPrompt,
  //      through the same production image shape S62 used ----
  const artStart = Date.now();
  const artBuf = await aiCall("image", `s74 art [${briefId}]`,
    () => imageGenerate(
      { prompt: s62Entry.artPrompt, size: "1344x768" },
      { provider: "zai", model: "" }
    ),
    { attempts: 2, baseDelayMs: 4000 });
  if (!artBuf || artBuf.length < 10_000) throw new Error("scene art came back empty");
  fs.writeFileSync(artPath, artBuf);
  const artMs = Date.now() - artStart;
  console.log(`[${briefId}] art: ${(artBuf.length / 1024).toFixed(0)} KB — ${artMs} ms (shared by the pair)`);

  // ---- the pair: two clips, the SAME art, prompts the only variable ----
  const videoConfig = await getCapability("video", { provider: "zai", model: "" });
  const videoModel = videoConfig.model?.trim() || VIDEO_DEFAULT_MODEL;
  const zai = await zaiClientFor("video");

  const before = await renderClip(briefId, "before", motionPromptBefore, artBuf, videoModel, zai, paceMs);
  fs.writeFileSync(beforePath, before.buf);
  console.log(`[${briefId}] before clip: ${(before.buf.length / 1024 / 1024).toFixed(1)} MB — ${(before.ms / 1000 / 60).toFixed(1)} min`);

  const after = await renderClip(briefId, "after", motionPromptAfter, artBuf, videoModel, zai, paceMs);
  fs.writeFileSync(afterPath, after.buf);
  console.log(`[${briefId}] after  clip: ${(after.buf.length / 1024 / 1024).toFixed(1)} MB — ${(after.ms / 1000 / 60).toFixed(1)} min`);

  // ---- QC + frames on BOTH clips (same lenses as S62) ----
  const beforeQc = await qcAndFrames(beforePath, path.join(OUT_DIR, `${briefId}.before`));
  console.log(`[${briefId}] before qc: ${qcFlagged(beforeQc.qc)} flagged`);
  const afterQc = await qcAndFrames(afterPath, path.join(OUT_DIR, `${briefId}.after`));
  console.log(`[${briefId}] after  qc: ${qcFlagged(afterQc.qc)} flagged`);

  const entry: S74Entry = {
    profile: briefId,
    ok: true,
    policy,
    policyMatchesS62: policy === s62Entry.policy,
    shot: s62Entry.shot,
    artPrompt: s62Entry.artPrompt,
    motionPromptBefore,
    motionPromptAfter,
    promptChanged: true,
    artBytes: artBuf.length,
    before: {
      clipBytes: before.buf.length, probe: beforeQc.probe, qc: beforeQc.qc,
      timingsMs: { i2v: before.ms },
    },
    after: {
      clipBytes: after.buf.length, probe: afterQc.probe, qc: afterQc.qc,
      timingsMs: { i2v: after.ms },
    },
    timingsMs: { art: artMs, total: Date.now() - t0 },
    sources: {
      s62Manifest: "../s62/manifest.json",
      briefs: "../../scripts/s-profile-briefs.mts",
      note: "art regenerated from the committed S62 artPrompt (sandbox rebuild lost the S62 binaries); before/after share this one art",
    },
  };
  writeManifest(manifest.filter((x) => x.profile !== briefId).concat(entry));
  console.log(`[${briefId}] DONE — total ${(entry.timingsMs.total / 1000 / 60).toFixed(1)} min`);
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const args = process.argv.slice(2);
  const force = args.includes("--force");

  if (args.includes("--status")) {
    const m = readManifest();
    console.log(`${"profile".padEnd(17)} ${"ok".padEnd(3)} ${"Δprompt".padEnd(8)} ${"art KB".padEnd(7)} ${"before MB".padEnd(10)} ${"after MB".padEnd(9)} ${"b i2v".padEnd(6)} ${"a i2v".padEnd(6)} qc(b/a)`);
    for (const e of m) {
      console.log(
        `${e.profile.padEnd(17)} ${(e.ok ? "✓" : "✗").padEnd(3)} ${(e.promptChanged ? "yes" : "no").padEnd(8)} ` +
        `${(e.artBytes / 1024).toFixed(0).padEnd(7)} ` +
        `${((e.before?.clipBytes ?? 0) / 1048576).toFixed(1).padEnd(10)} ` +
        `${((e.after?.clipBytes ?? 0) / 1048576).toFixed(1).padEnd(9)} ` +
        `${((e.before?.timingsMs.i2v ?? 0) / 60000).toFixed(1).padEnd(6)} ` +
        `${((e.after?.timingsMs.i2v ?? 0) / 60000).toFixed(1).padEnd(6)} ` +
        `${e.before ? qcFlagged(e.before.qc) : "?"}/${e.after ? qcFlagged(e.after.qc) : "?"} flagged`
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
      await remeasureProfile(id, force, args);
    } catch (e) {
      failed++;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[${id}] FAILED — ${msg}`);
      writeManifest(readManifest().filter((x) => x.profile !== id).concat({
        profile: id, ok: false, error: msg, policy: "", policyMatchesS62: false,
        shot: null, artPrompt: "", motionPromptBefore: "", motionPromptAfter: "",
        promptChanged: false, artBytes: 0, before: null, after: null,
        timingsMs: { art: 0, total: 0 },
        sources: { s62Manifest: "../s62/manifest.json", briefs: "../../scripts/s-profile-briefs.mts", note: "" },
      }));
    }
  }
  if (failed > 0) process.exit(1);
}

await main();
