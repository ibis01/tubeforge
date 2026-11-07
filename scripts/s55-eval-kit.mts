// S55 T-55.6 — the human cinematic evaluation kit's anchor-render harness
// (LOCAL ONLY, zero gateway spend; the stand-in gateway plays the AI
// providers, same disclosure as the T-55.5 acceptance).
//
// One anchor render per production profile (8), through the REAL production
// path (runDirectorPass → approve → runStoryboardJob → runRenderJob), with
// the plan built FROM THE LIVE PROFILE CATALOG: each profile's narrowed
// camera/framing vocabulary cycled over 2 neutral scenes × 3 shots, the
// profile's pacing bias, its transition bias — so what a human evaluates is
// the profile's actual cinematic machinery (the S48 verbatim law executing).
//
// The anchors exercise the ENGINE axes (motion realism, camera movement,
// shot rhythm, AV sync, transitions) on synthetic testsrc2-lineage paints;
// the imagery axes (lighting, composition-on-content, scene relevance) need
// real paints and stay tier-2 (the runbook's gateway protocol). Scoring
// stays HUMAN — this harness produces the anchors + the measured manifest,
// never a verdict.
//
// CHUNKED like the S54 benchmark (the sandbox reaps long runs):
//   S55_KIT_PROFILES=narrative,documentary,explainer node --import tsx …
//   S55_KIT_LEG=report …   (assemble the manifest + copy anchors)
// State: /tmp/s55-kit-state.json · Anchors: uploads/s55-evalkit/<profile>.mp4
// + copied for review to TUBEFORGE_KIT_OUT (default ../../download/s55-eval-kit).
//
// Usage: node --import tsx scripts/s55-eval-kit.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { execFile } from "child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "util";
import { PrismaClient } from "@prisma/client";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import { runDirectorPass, setDirectorState, parsePlan } from "../src/lib/tubeforge/director";
import { runStoryboardJob, runRenderJob } from "../src/lib/tubeforge/video-jobs";
import { parseQcReport } from "../src/lib/tubeforge/qc-policy";
import { PRODUCTION_PROFILES } from "../src/lib/tubeforge/production-profiles";
import { CAMERA_MOVES, FRAMINGS, PROFILE_IDS } from "../src/lib/tubeforge/director-plan";
import { startStandinGateway } from "./s55-standin-gateway.mts";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();
const LEG = process.env.S55_KIT_LEG ?? "profiles";
const ONLY = (process.env.S55_KIT_PROFILES ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const STATE_PATH = process.env.S55_KIT_STATE ?? "/tmp/s55-kit-state.json";
const MANIFEST_PATH = process.env.S55_KIT_MANIFEST ?? "docs/baselines/s55-eval-kit-manifest.json";
const ANCHOR_DIR = "uploads/s55-evalkit";
const OUT_DIR = process.env.TUBEFORGE_KIT_OUT ?? "/home/z/my-project/download/s55-eval-kit";
const ASSETS_DIR = "/tmp/s55-acc-assets"; // shared with the T-55.5 probe (same synthetics)
const ZAI_CONFIG = path.join(process.cwd(), ".z-ai-config");
const SUFFIX = `s55kit-${Date.now().toString(36)}`;

interface KitState {
  suffix: string;
  userId?: string;
  orgId?: string;
  profiles: Record<string, {
    videoId: string;
    durationSec: number;
    fileBytes: number;
    sha8: string;
    cameras: string[];
    pacing: string;
    transitionIn: string;
    lenses: Record<string, string>;
    renderMs: number;
  }>;
}

const state: KitState = fs.existsSync(STATE_PATH)
  ? (JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as KitState)
  : { suffix: SUFFIX, profiles: {} };

const sha8 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 8);
const saveState = () => fsp.writeFile(STATE_PATH, JSON.stringify(state, null, 2));

// ---------- the two neutral anchor scenes (same content for every profile —
// the controlled variable: only the profile's direction changes) ----------

const KIT_SCENES = [
  {
    index: 1,
    title: "The Ridge",
    narration:
      "At first light the ridge stood above the clouds, the wind pouring over the saddle like water.",
    visual: "a windswept mountain ridge at first light, low clouds pouring over the saddle",
    camera: "zoom-in",
    mood: "cold blue dawn, drifting mist, high contrast",
    caption: "above the clouds",
    hostInScene: false,
    rehook: true,
    sfx: "none",
  },
  {
    index: 2,
    title: "The Harbor",
    narration:
      "By dusk the harbor had gone quiet, the moored boats rocking gently under the lantern light.",
    visual: "a quiet harbor at dusk, moored boats rocking gently under lantern light",
    camera: "pan-right",
    mood: "deep amber dusk, calm water, warm highlights",
    caption: "the day ends",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  },
];

/** Build the per-profile plan from the LIVE catalog: narrowed cameras and
 * framings cycled over the shots, the pacing and transition biases applied.
 * This is what the profile's vocabulary actually executes through the engine. */
function planJsonForProfile(profileId: string): string {
  const profile = PRODUCTION_PROFILES[profileId];
  const cameras = profile.vocabularies?.cameras ?? CAMERA_MOVES;
  const framings = profile.vocabularies?.framings ?? FRAMINGS;
  const pacing =
    profile.defaultTone.pacingBias === "fast" ? "fast"
    : profile.defaultTone.pacingBias === "slow" ? "slow"
    : "normal";
  const transitionIn = profile.vocabularies?.transitions?.[0] ?? "fade";
  // The density bias is ENGINE-level direction (sparse/normal/dense → the
  // shot count per scene) — flattening it made two anchor pairs identical;
  // honoring it keeps every profile's actual rhythm in its anchor.
  const density = profile.defaultTone.shotDensity ?? "normal";
  const shotSecs =
    density === "sparse" ? [2.6, 1.4]
    : density === "dense" ? [1.6, 1.0, 0.8, 0.6]
    : [2.0, 1.2, 0.8];
  const scenes = KIT_SCENES.map((scene, si) => ({
    sceneIndex: si + 1,
    mood: scene.mood,
    transitionIn: si === 0 ? "" : transitionIn,
    motion: "smart",
    needsI2V: false,
    useStock: false,
    pacing,
    ambience: "none",
    sfx: "none",
    shots: shotSecs.map((sec, sh) => {
      const k = si * 3 + sh;
      const camera = cameras[k % cameras.length];
      const framing = framings[k % framings.length];
      return {
        shotIndex: sh,
        framing,
        camera,
        lens: sh === 0 ? "24mm wide" : sh === 1 ? "50mm" : "85mm",
        composition: ["rule of thirds", "leading lines", "negative space"][k % 3],
        duration: sec,
        imagePrompt: `${scene.visual}, ${framing} framing`,
        subject: scene.title.toLowerCase(),
        subjectAction: si === 0 ? "standing in the wind" : "rocking at anchor",
        cameraHeight: ["eye-level", "low-angle", "high-angle"][k % 3],
        angle: "front",
        depthOfField: "deep",
        lighting: scene.mood,
        colorGrade: si === 0 ? "cool" : "warm",
        focal: "center",
        moveSpeed: pacing === "fast" ? "fast" : pacing === "slow" ? "slow" : "normal",
        transitionOut: "cut",
        purpose: sh === 0 ? "establish" : sh === 1 ? "detail" : "payoff",
        notes: "",
      };
    }),
  }));
  return JSON.stringify({
    version: 2,
    concept: `Anchor for the ${profile.label} profile — its narrowed vocabulary cycled over two neutral scenes (the human evaluation kit, T-55.6).`,
    profile: profileId,
    musicMood: "neutral",
    ducking: "standard",
    scenes,
  });
}

// ---------- the shared synthetics (testsrc2 lineage, T-55.5 basis) ----------

async function ensureAssets(): Promise<{
  cave: Buffer; road: Buffer; traveler: Buffer; edited: Buffer; clip: Buffer;
}> {
  const probeAssets = path.join(ASSETS_DIR, "scene3-clip.mp4");
  if (!fs.existsSync(probeAssets)) {
    // Reuse the acceptance probe's synthesis (it also produces the 3 paints).
    const { execFile } = await import("child_process");
    const run = promisify(execFile);
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    for (const [file, hue] of [["cave.png", 0], ["road.png", 120]] as const) {
      await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "testsrc2=s=1344x768:d=1:r=1",
        "-vf", `hue=h=${hue}`, "-frames:v", "1", path.join(ASSETS_DIR, file)], { timeout: 60_000 });
    }
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=1344x768:d=1:r=1",
      "-vf", "hue=h=240,drawbox=x=520:y=260:w=300:h=300:color=0x74c69d@1:t=fill",
      "-frames:v", "1", path.join(ASSETS_DIR, "edited.png")], { timeout: 60_000 });
    await run("python3", ["-c",
      `import cv2; from skimage import data; cv2.imwrite(${JSON.stringify(path.join(ASSETS_DIR, "astro.png"))}, cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR))`,
    ], { timeout: 60_000 });
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=1344x768:d=1:r=1", "-i", path.join(ASSETS_DIR, "astro.png"),
      "-filter_complex", "[0:v]hue=h=300[base];[1:v]scale=640:640[a];[base][a]overlay=(W-w)/2:(H-h)/2",
      "-frames:v", "1", path.join(ASSETS_DIR, "traveler.png")], { timeout: 60_000 });
    await run("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-loop", "1", "-framerate", "30", "-t", "5", "-i", path.join(ASSETS_DIR, "traveler.png"),
      "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080," +
        "zoompan=z='min(1+0.0022*on,1.33)':d=150:x='(iw-iw/zoom)*on/149':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30," +
        "drawbox=x=0:y=0:w=1920:h=10:color=magenta@1.0:t=fill",
      "-frames:v", "150", "-pix_fmt", "yuv420p", "-c:v", "libx264", probeAssets], { timeout: 120_000 });
  }
  return {
    cave: fs.readFileSync(path.join(ASSETS_DIR, "cave.png")),
    road: fs.readFileSync(path.join(ASSETS_DIR, "road.png")),
    traveler: fs.readFileSync(path.join(ASSETS_DIR, "traveler.png")),
    edited: fs.readFileSync(path.join(ASSETS_DIR, "edited.png")),
    clip: fs.readFileSync(probeAssets),
  };
}

// ---------- leg: profiles ----------

async function legProfiles() {
  const assets = await ensureAssets();
  const profiles = ONLY.length > 0 ? ONLY : [...PROFILE_IDS];
  for (const bad of profiles) {
    if (!(PROFILE_IDS as readonly string[]).includes(bad)) throw new Error(`unknown profile "${bad}"`);
  }
  // One probe org/user for the whole kit.
  if (!state.userId || !state.orgId) {
    const passwordHash = await hashPassword("probe-password-123");
    const user = await prisma.user.create({
      data: { email: `s55-kit-${state.suffix}@e2e.local`, passwordHash, name: "s55 eval kit" },
    });
    const org = await prisma.organization.create({
      data: {
        name: "s55 eval kit org",
        slug: `s55-kit-${state.suffix}`,
        memberships: { create: { userId: user.id, role: "owner" } },
      },
    });
    state.userId = user.id;
    state.orgId = org.id;
    await saveState();
  }
  const ctx = { userId: state.userId, organizationId: state.orgId, role: "owner" as const };
  const hadConfig = fs.existsSync(ZAI_CONFIG);
  const prior = hadConfig ? fs.readFileSync(ZAI_CONFIG, "utf8") : null;
  const gw = await startStandinGateway({ ...assets, planJson: planJsonForProfile(profiles.find((pid) => !state.profiles[pid]) ?? profiles[0]) });
  fs.writeFileSync(ZAI_CONFIG, `${JSON.stringify({ baseUrl: gw.baseUrl, apiKey: "s55-standin" }, null, 2)}\n`);
  try {
    for (const profileId of profiles) {
      if (state.profiles[profileId]) {
        console.info(`[kit] ${profileId}: already rendered — skipping (delete its state entry to re-run)`);
        continue;
      }
      // Each profile's anchor plan differs — swap the gateway's canned plan
      // in place (the SDK's client is a per-process singleton bound to the
      // gateway's port; restarting the gateway would orphan it).
      gw?.setPlanJson(planJsonForProfile(profileId));
      const t0 = Date.now();
      await withCtx(ctx, async () => {
        const video = await prisma.video.create({
          data: {
            organizationId: state.orgId ?? "",
            topic: "Cinematic anchor — engine evaluation",
            niche: "nature",
            tone: "informative",
            title: `S55 T-55.6 anchor — ${profileId}`,
            format: "story",
            scenes: JSON.stringify(KIT_SCENES),
          },
        });
        await runDirectorPass(video.id, { profile: profileId });
        await setDirectorState(video.id, "approved");
        await runStoryboardJob(video.id);
        const dir = path.join("uploads", video.id);
        for (let i = 1; i <= KIT_SCENES.length; i++) {
          await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "sine=frequency=196:duration=4",
            "-af", "volume=-26dB", "-ar", "44100", "-ac", "1",
            path.join(dir, `scene-${String(i).padStart(2, "0")}.wav`)], { timeout: 60_000 });
        }
        await prisma.video.update({
          where: { id: video.id },
          data: { hasVoiceover: true, audioDuration: 8.0 },
        });
        await runRenderJob(video.id, { mode: "kenburns", music: false, subtitles: false, smartCaptions: false });
        const row = await prisma.video.findUnique({ where: { id: video.id } });
        const finalPath = path.join(dir, "final.mp4");
        const buf = fs.readFileSync(finalPath);
        const report = parseQcReport(row?.qcReport ?? null);
        const lenses: Record<string, string> = {};
        for (const c of report?.checks ?? []) lenses[c.id] = c.status;
        const plan = parsePlan(row?.shotList ?? null);
        const cameras = (plan?.scenes ?? []).flatMap((sc) => sc.shots.map((sh) => sh.camera));
        const pacing = plan?.scenes[0]?.pacing ?? "normal";
        const transitionIn = plan?.scenes[1]?.transitionIn ?? "fade";
        state.profiles[profileId] = {
          videoId: video.id,
          durationSec: row?.videoDuration ?? 0,
          fileBytes: buf.length,
          sha8: sha8(buf),
          cameras,
          pacing,
          transitionIn,
          lenses,
          renderMs: Date.now() - t0,
        };
        fs.mkdirSync(ANCHOR_DIR, { recursive: true });
        fs.writeFileSync(path.join(ANCHOR_DIR, `${profileId}.mp4`), buf);
        console.info(
          `[kit] ${profileId}: ${((Date.now() - t0) / 1000).toFixed(0)}s · ${row?.videoDuration}s · ` +
          `${(buf.length / 1e6).toFixed(1)}MB · cameras ${cameras.join("/")} · pacing ${pacing}`
        );
      });
      await saveState();
    }
  } finally {
    if (prior !== null) fs.writeFileSync(ZAI_CONFIG, prior);
    else fs.rmSync(ZAI_CONFIG, { force: true });
    await gw.close().catch(() => undefined);
  }
}

// ---------- leg: report ----------

async function legReport() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const manifest = {
    recordedAt: new Date().toISOString(),
    kit: "scripts/s55-eval-kit.mts",
    commit: (await execFileAsync("git", ["rev-parse", "--short", "HEAD"])).stdout.toString().trim(),
    spend: { gatewayQuotaSpent: 0, paidDispatches: 0, standinOnly: true },
    anchorScenes: KIT_SCENES.map((s) => ({ title: s.title, visual: s.visual })),
    tier1: "engine axes on local stand-in anchors (motion realism, camera movement, shot rhythm, AV sync, transitions)",
    tier2: "imagery axes on gateway anchors (lighting, composition-on-content, scene relevance) — the runbook's protocol",
    profiles: state.profiles,
  };
  fs.mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  let copied = 0;
  for (const profileId of Object.keys(state.profiles)) {
    const src = path.join(ANCHOR_DIR, `${profileId}.mp4`);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(OUT_DIR, `${profileId}-anchor.mp4`));
      copied++;
    }
  }
  console.info(`[kit] manifest → ${MANIFEST_PATH}`);
  console.info(`[kit] ${copied} anchor(s) copied for review → ${OUT_DIR}`);
  for (const [pid, info] of Object.entries(state.profiles)) {
    const blocking = Object.entries(info.lenses).filter(([, st]) => st !== "pass");
    console.info(
      `  ${pid.padEnd(17)} ${info.durationSec}s · ${info.sha8} · pacing ${info.pacing} · ` +
      `non-pass lenses: ${blocking.length === 0 ? "none" : blocking.map(([k, v]) => `${k}:${v}`).join(" ")}`
    );
  }
}

// ---------- teardown ----------

async function teardown() {
  if (!state.userId || !state.orgId) return;
  const vids = await prisma.video.findMany({
    where: { organizationId: state.orgId },
    select: { id: true },
  });
  for (const v of vids) {
    await prisma.activity.deleteMany({ where: { videoId: v.id } }).catch(() => undefined);
    await prisma.characterAppearance.deleteMany({ where: { videoId: v.id } }).catch(() => undefined);
    await prisma.video.delete({ where: { id: v.id } }).catch(() => undefined);
    fs.rmSync(path.join("uploads", v.id), { recursive: true, force: true });
  }
  await prisma.usageRecord.deleteMany({ where: { userId: state.userId } }).catch(() => undefined);
  await prisma.userSetting.deleteMany({ where: { userId: state.userId } }).catch(() => undefined);
  await prisma.providerCredential.deleteMany({ where: { userId: state.userId } }).catch(() => undefined);
  await prisma.organization.delete({ where: { id: state.orgId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: state.userId } }).catch(() => undefined);
  console.info("[kit] teardown: probe rows + uploads removed (anchors kept in uploads/s55-evalkit + the review copy)");
}

// ---------- main ----------

try {
  if (LEG === "profiles") await legProfiles();
  else if (LEG === "report") await legReport();
  else if (LEG === "teardown") await teardown();
  else throw new Error(`unknown S55_KIT_LEG "${LEG}"`);
} catch (err) {
  console.error(`[s55-kit:${LEG}] FATAL:`, err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await saveState().catch(() => undefined);
}
