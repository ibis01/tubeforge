// S55 T-55.5 — the Islamic export acceptance probe (LOCAL ONLY, zero
// gateway spend). The owner's 7-step protocol, executed end-to-end on the
// REAL production code with a local stand-in gateway playing the AI
// providers (the probe-hygiene law: no metered gateway quota):
//
//   1  multi-scene Islamic-history video with restricted-figure references
//      → a real Video row (contentPolicy islamic-history), 3 scenes whose
//      visual fields NAME the Prophet ﷺ / Abu Bakr / Umar / the angel — the
//      adversarial input.
//   2  full MP4 → the REAL runRenderJob (M2 shot graph, 1080p), narration
//      WAVs synthesized (the §B stand-in lineage: sine at -26 dB).
//   3  dense inspection → the REAL runRestrictedVisualScan rides the
//      post-render battery: dense grid + face tripwire + batched VLM judge
//      (the stand-in serves the verdict; the tripwire/grid are real).
//   4  scene regeneration + i2v paths → runSceneJob re-roll AND instruction
//      AI-edit with ADVERSARIAL text; the i2v channel (needsI2V scene 3)
//      through ensureSceneClip — the S50 motion-prompt seam, live.
//   5  violation blocks export → the stand-in VLM reports a depiction: the
//      restricted-visual check FAILS and applyQcPolicy (the export route's
//      own gate core) holds the bundle.
//   6  unmeasured scan blocks export → the stand-in VLM returns garbage:
//      the scan reports UNMEASURED (fail-closed) and the gate still holds.
//   7  standard: zero prohibited faces in exported videos → the PASS render
//      exports open, with the tripwire's real hits recorded as anonymous
//      allowed content and the VLM verdict disclosed as stand-in.
//
// PHASES (foreground chunks — the sandbox reaps long background processes;
// state in /tmp/s55-acc-state.json):
//   S55_PHASE=seed    assets + DB seed + director pass (L2) + storyboard
//                     (L3) + narration WAVs
//   S55_PHASE=render1 render #1 (clean) + dense scan + gate OPEN + i2v
//   S55_PHASE=regen   scene re-roll + adversarial AI-edit (L3 wire proof)
//   S55_PHASE=render2 render #2 (violation) + gate BLOCKED
//   S55_PHASE=unmeasured  QC re-run (garbage) + gate BLOCKED
//   S55_PHASE=report  assemble docs/audits/s55-acceptance-data.json
//
// Usage: S55_PHASE=seed node --import tsx scripts/s55-acceptance-probe.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { execFile } from "child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "util";
import { PrismaClient } from "@prisma/client";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import { runDirectorPass, setDirectorState, parsePlan } from "../src/lib/tubeforge/director";
import {
  runStoryboardJob,
  runSceneJob,
  runRenderJob,
  runQcJob,
} from "../src/lib/tubeforge/video-jobs";
import { saveCapability } from "../src/lib/tubeforge/providers/settings";
import { parseQcReport, applyQcPolicy, qcEnforcementMode } from "../src/lib/tubeforge/qc-policy";
import {
  scanRestrictedSubjects,
  policyNegativeClause,
  planDenseGrid,
  extractDenseGrid,
  runFaceTripwire,
  FACE_TRIPWIRE_PY,
} from "../src/lib/tubeforge/restricted-subjects";
import { probeDuration } from "../src/lib/tubeforge/render";
import {
  startStandinGateway,
  type StandinGateway,
  type VlmMode,
} from "./s55-standin-gateway.mts";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();
const PHASE = process.env.S55_PHASE ?? "seed";
const STATE_PATH = process.env.S55_ACC_STATE ?? "/tmp/s55-acc-state.json";
const DATA_PATH = process.env.S55_ACC_DATA ?? "docs/audits/s55-acceptance-data.json";
const ASSETS_DIR = "/tmp/s55-acc-assets";
const SUFFIX = `s55acc-${Date.now().toString(36)}`;
const ZAI_CONFIG = path.join(process.cwd(), ".z-ai-config");
const NEG = policyNegativeClause("islamic-history");

interface AccState {
  suffix: string;
  userId?: string;
  orgId?: string;
  videoId?: string;
  checks: { phase: string; name: string; ok: boolean; detail?: unknown }[];
  meta: Record<string, unknown>;
}

const state: AccState = fs.existsSync(STATE_PATH)
  ? (JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as AccState)
  : { suffix: SUFFIX, checks: [], meta: {} };

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail).slice(0, 400)}`}`);
  state.checks.push({ phase: PHASE, name, ok, detail });
  if (!ok) failures++;
}
const saveState = () => fsp.writeFile(STATE_PATH, JSON.stringify(state, null, 2));
const sha8 = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex").slice(0, 8);
/** Scan a wire/persisted prompt for restricted references AFTER removing the
 * hard negative clause (the clause legitimately NAMES the forbidden subjects
 * as the instruction not to depict them). */
const restrictedOutsideClause = (text: string) =>
  scanRestrictedSubjects(text.split(NEG).join(""), "islamic-history");

// ---------- the adversarial content (restricted-figure references) ----------

const SCENES = [
  {
    index: 1,
    title: "The Cave of Hira",
    narration:
      "High on the mountain, in the stillness of the Cave of Hira, a light descended, and the first revelation began.",
    visual:
      "the Prophet Muhammad seated in the Cave of Hira as a shaft of divine light fills the chamber",
    camera: "zoom-in",
    mood: "deep indigo night, one warm shaft of light, dust motes",
    caption: "the first light",
    hostInScene: false,
    rehook: true,
    sfx: "none",
  },
  {
    index: 2,
    title: "The Migration",
    narration:
      "Under cover of dawn, the migration to Medina began — carried by trust, companionship and quiet resolve.",
    visual:
      "Abu Bakr walking beside the Prophet Muhammad on the migration road to Medina at first light",
    camera: "pan-right",
    mood: "amber dawn, long shadows on a desert road",
    caption: "the road north",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  },
  {
    index: 3,
    title: "The Caravan",
    narration:
      "Across the dunes the anonymous caravan moved, carrying a message that would change the world.",
    visual:
      "an anonymous desert caravan crossing golden dunes at dusk, travelers small against the vast landscape",
    camera: "zoom-out",
    mood: "golden hour, vast warm landscape, gentle haze",
    caption: "the message moves",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  },
];

/** The canned plan the stand-in director "model" returns — shot prompts NAME
 * restricted figures (the adversarial L2 input; the pass must sanitize them
 * BEFORE the plan is persisted). Scene 3 carries needsI2V (the i2v leg). */
const PLAN_JSON = JSON.stringify({
  version: 2,
  concept:
    "The revelation era told through its places, its light and its road — the revered figures carried by the narration alone, never by the frame.",
  profile: "islamic-history",
  musicMood: "contemplative",
  ducking: "standard",
  scenes: [
    {
      sceneIndex: 1,
      mood: "deep indigo night, one warm shaft of light, dust motes",
      transitionIn: "",
      motion: "smart",
      needsI2V: false,
      useStock: false,
      pacing: "slow",
      ambience: "none",
      sfx: "none",
      shots: [
        { shotIndex: 0, framing: "wide", camera: "zoom-in", lens: "24mm wide", composition: "rule of thirds", duration: 2.0,
          imagePrompt: "the Cave of Hira at night, a single shaft of divine light descending upon the Prophet Muhammad in quiet contemplation",
          subject: "the Prophet Muhammad", subjectAction: "receiving the first revelation",
          cameraHeight: "low-angle", angle: "front", depthOfField: "deep", lighting: "single warm shaft in cold blue dark",
          colorGrade: "teal-orange", focal: "center", moveSpeed: "slow", transitionOut: "cut", purpose: "establish",
          notes: "compose around the light, never the figure" },
        { shotIndex: 1, framing: "close-up", camera: "punch-in", lens: "85mm f/1.8", composition: "negative space", duration: 1.2,
          imagePrompt: "the hands of the Prophet Muhammad resting on his knees as the light touches them",
          subject: "the hands of the Prophet", subjectAction: "resting in stillness",
          cameraHeight: "eye-level", angle: "three-quarter", depthOfField: "shallow", lighting: "rim light from the shaft",
          colorGrade: "teal-orange", focal: "lower", moveSpeed: "slow", transitionOut: "cut", purpose: "detail",
          notes: "hands and cloth only" },
        { shotIndex: 2, framing: "medium", camera: "pan-right", lens: "35mm", composition: "leading lines", duration: 0.8,
          imagePrompt: "the angel Jibril manifesting as radiant white light before the Prophet inside the cave",
          subject: "the angel Jibril", subjectAction: "manifesting as light",
          cameraHeight: "eye-level", angle: "front", depthOfField: "deep", lighting: "blinding white bloom",
          colorGrade: "high-key", focal: "center", moveSpeed: "normal", transitionOut: "cut", purpose: "reveal",
          notes: "light only, never a winged figure" },
      ],
    },
    {
      sceneIndex: 2,
      mood: "amber dawn, long shadows, cool horizon",
      transitionIn: "fade",
      motion: "smart",
      needsI2V: false,
      useStock: false,
      pacing: "normal",
      ambience: "wind",
      sfx: "none",
      shots: [
        { shotIndex: 0, framing: "wide", camera: "pan-left", lens: "24mm wide", composition: "rule of thirds", duration: 2.0,
          imagePrompt: "Abu Bakr walking beside the Prophet Muhammad on the migration road to Medina at first light, seen from a distance",
          subject: "the two travelers", subjectAction: "walking the dawn road",
          cameraHeight: "eye-level", angle: "back", depthOfField: "deep", lighting: "golden hour backlight",
          colorGrade: "amber", focal: "center", moveSpeed: "normal", transitionOut: "cut", purpose: "establish",
          notes: "footprints and road, figures absent" },
        { shotIndex: 1, framing: "medium", camera: "zoom-out", lens: "50mm", composition: "leading lines", duration: 1.2,
          imagePrompt: "Umar ibn al-Khattab waiting at the palm groves of Quba as the morning mist lifts",
          subject: "Umar", subjectAction: "waiting",
          cameraHeight: "eye-level", angle: "front", depthOfField: "deep", lighting: "soft morning light",
          colorGrade: "amber", focal: "right", moveSpeed: "normal", transitionOut: "cut", purpose: "contextualize",
          notes: "groves and mist only" },
        { shotIndex: 2, framing: "close-up", camera: "diag-tl", lens: "85mm", composition: "diagonal", duration: 0.8,
          imagePrompt: "footprints in the sand along the migration road, morning light raking across the ridges",
          subject: "footprints", subjectAction: "leading north",
          cameraHeight: "ground-level", angle: "front", depthOfField: "shallow", lighting: "raking dawn light",
          colorGrade: "amber", focal: "lower-left", moveSpeed: "slow", transitionOut: "cut", purpose: "detail",
          notes: "" },
      ],
    },
    {
      sceneIndex: 3,
      mood: "golden hour, vast dunes, warm haze",
      transitionIn: "fade",
      motion: "smart",
      needsI2V: true,
      useStock: false,
      pacing: "normal",
      ambience: "wind",
      sfx: "none",
      shots: [
        { shotIndex: 0, framing: "wide", camera: "diag-tl", lens: "24mm wide", composition: "rule of thirds", duration: 2.2,
          imagePrompt: "an anonymous desert caravan cresting a golden dune, camels in silhouette against the dusk sky",
          subject: "the caravan", subjectAction: "cresting the dune",
          cameraHeight: "high-angle", angle: "front", depthOfField: "deep", lighting: "golden hour",
          colorGrade: "warm", focal: "center", moveSpeed: "normal", transitionOut: "cut", purpose: "establish",
          notes: "anonymous travelers, faces indistinct" },
        { shotIndex: 1, framing: "medium", camera: "pan-right", lens: "50mm", composition: "leading lines", duration: 1.0,
          imagePrompt: "a camel's harness swaying as the caravan climbs, dust catching the low sun",
          subject: "the harness", subjectAction: "swaying",
          cameraHeight: "eye-level", angle: "three-quarter", depthOfField: "deep", lighting: "low sun",
          colorGrade: "warm", focal: "center", moveSpeed: "normal", transitionOut: "cut", purpose: "detail",
          notes: "" },
        { shotIndex: 2, framing: "wide", camera: "zoom-in", lens: "35mm", composition: "negative space", duration: 0.8,
          imagePrompt: "the caravan moving toward a distant oasis as the dusk sky deepens",
          subject: "the caravan", subjectAction: "moving toward the oasis",
          cameraHeight: "eye-level", angle: "front", depthOfField: "deep", lighting: "dusk",
          colorGrade: "warm", focal: "center", moveSpeed: "slow", transitionOut: "cut", purpose: "payoff",
          notes: "" },
      ],
    },
  ],
});

// ---------- shared helpers ----------

async function synthesizeAssets(): Promise<{
  cave: Buffer; road: Buffer; traveler: Buffer; edited: Buffer; clip: Buffer;
}> {
  fs.mkdirSync(ASSETS_DIR, { recursive: true });
  const cave = path.join(ASSETS_DIR, "cave.png");
  const road = path.join(ASSETS_DIR, "road.png");
  const astro = path.join(ASSETS_DIR, "astro.png");
  const traveler = path.join(ASSETS_DIR, "traveler.png");
  const edited = path.join(ASSETS_DIR, "edited.png");
  const clip = path.join(ASSETS_DIR, "scene3-clip.mp4");
  if (!fs.existsSync(clip)) {
    // The paints: testsrc2 frames (the documented §B stand-in lineage —
    // rich high-frequency structure that behaves like real imagery under
    // the lenses) with per-paint hue shifts so the storyboard dedupe never
    // sees siblings. Smooth gradients were tried first and REJECTED: the
    // frozen-frames lens (freezedetect n=0.004) flagged 1s+ runs inside
    // slow Ken Burns shots — textureless stand-ins, not a renderer defect
    // (the T-55.3 verification render passed the same lens on real paints).
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=1344x768:d=1:r=1",
      "-vf", "hue=h=0",
      "-frames:v", "1", cave], { timeout: 60_000 });
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=1344x768:d=1:r=1",
      "-vf", "hue=h=120",
      "-frames:v", "1", road], { timeout: 60_000 });
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=1344x768:d=1:r=1",
      "-vf", "hue=h=240,drawbox=x=520:y=260:w=300:h=300:color=0x74c69d@1:t=fill",
      "-frames:v", "1", edited], { timeout: 60_000 });
    // The anonymous traveler: skimage's astronaut (a real human face, BSD
    // sample data — the T-55.4 positive-control lineage) composited centered
    // on a dusk gradient. Anonymous people are ALLOWED content (S49
    // doctrine); the VLM decides reverence, the tripwire only forces frames.
    await execFileAsync("python3", ["-c",
      "import cv2; from skimage import data; cv2.imwrite(" +
      JSON.stringify(astro) + ", cv2.cvtColor(data.astronaut(), cv2.COLOR_RGB2BGR))",
    ], { timeout: 60_000 });
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "testsrc2=s=1344x768:d=1:r=1",
      "-i", astro,
      "-filter_complex", "[0:v]hue=h=300[base];[1:v]scale=640:640[a];[base][a]overlay=(W-w)/2:(H-h)/2",
      "-frames:v", "1", traveler], { timeout: 60_000 });
    // The i2v clip: 5s 1920x1080 30fps over the traveler composite — strong
    // zoom + horizontal drift (a real CogVideoX clip carries subject motion;
    // the first cut's 0.08%/frame zoom was too gentle for the freeze lens on
    // smooth content) — plus the distinctive magenta top bar: the pixel-level
    // proof that the final render's scene-3 segment played THIS clip (not a
    // Ken Burns degrade over the same source image).
    await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
      "-loop", "1", "-framerate", "30", "-t", "5", "-i", traveler,
      "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080," +
        "zoompan=z='min(1+0.0022*on,1.33)':d=150:x='(iw-iw/zoom)*on/149':y='ih/2-(ih/zoom/2)':s=1920x1080:fps=30," +
        `noise=alls=6:allf=t+u,` +
        "drawbox=x=0:y=0:w=1920:h=10:color=magenta@1.0:t=fill",
      "-frames:v", "150", "-pix_fmt", "yuv420p", "-c:v", "libx264", clip], { timeout: 120_000 });
  }
  return {
    cave: fs.readFileSync(cave),
    road: fs.readFileSync(road),
    traveler: fs.readFileSync(traveler),
    edited: fs.readFileSync(edited),
    clip: fs.readFileSync(clip),
  };
}

/** Start the stand-in gateway and point the Z.ai SDK at it via a TEMP
 * .z-ai-config (restored on close). */
async function withStandin<T>(
  vlmMode: VlmMode,
  fn: (gw: StandinGateway) => Promise<T>
): Promise<T> {
  const assets = await synthesizeAssets();
  const gw = await startStandinGateway({ ...assets, planJson: PLAN_JSON });
  gw.setVlmMode(vlmMode);
  const hadConfig = fs.existsSync(ZAI_CONFIG);
  const prior = hadConfig ? fs.readFileSync(ZAI_CONFIG, "utf8") : null;
  fs.writeFileSync(ZAI_CONFIG, `${JSON.stringify({ baseUrl: gw.baseUrl, apiKey: "s55-standin" }, null, 2)}\n`);
  try {
    return await fn(gw);
  } finally {
    if (prior !== null) fs.writeFileSync(ZAI_CONFIG, prior);
    else fs.rmSync(ZAI_CONFIG, { force: true });
    await gw.close().catch(() => undefined);
  }
}

function ctx() {
  if (!state.userId || !state.orgId)
    throw new Error("state missing — run S55_PHASE=seed first");
  return { userId: state.userId, organizationId: state.orgId, role: "owner" as const };
}

// ---------- phase: seed ----------

async function phaseSeed() {
  const assets = await synthesizeAssets();
  check("assets: paints + clip synthesized",
    [assets.cave, assets.road, assets.traveler, assets.edited].every((b) => b.length > 1000) &&
    assets.clip.length > 10_000,
    { cave: assets.cave.length, traveler: assets.traveler.length, clip: assets.clip.length });
  const clipDur = await probeDuration(path.join(ASSETS_DIR, "scene3-clip.mp4"));
  check("assets: i2v clip ≈5s @1080p", Math.abs(clipDur - 5) < 0.3, { clipDur });

  await withStandin("clean", async (gw) => {
    // The DB seed: user + org + the Islamic-history video with the
    // adversarial restricted-figure references.
    const passwordHash = await hashPassword("probe-password-123");
    const user = await prisma.user.create({
      data: { email: `s55-acc-${state.suffix}@e2e.local`, passwordHash, name: "s55 acceptance" },
    });
    const org = await prisma.organization.create({
      data: {
        name: "s55 acceptance org",
        slug: `s55-acc-${state.suffix}`,
        memberships: { create: { userId: user.id, role: "owner" } },
      },
    });
    state.userId = user.id;
    state.orgId = org.id;
    const video = await prisma.video.create({
      data: {
        organizationId: org.id,
        topic: "The revelation era: from Hira to Medina",
        niche: "history",
        tone: "reverent",
        title: "S55 T-55.5 Islamic export acceptance",
        format: "story",
        contentPolicy: "islamic-history",
        scenes: JSON.stringify(SCENES),
      },
    });
    state.videoId = video.id;
    await saveState();

    await withCtx(ctx(), async () => {
      // The chat + video capability rows: chat rides the platform stand-in
      // (zai default); video provider "zai" makes i2vReady true so the
      // needsI2V scene exercises ensureSceneClip through the real dispatch.
      await saveCapability("chat", { provider: "zai", model: "glm-4.6" });
      await saveCapability("video", { provider: "zai", model: "cogvideox-3" });

      // ---- step 1 + L2: the director pass over adversarial plan content ----
      await runDirectorPass(video.id, { profile: "islamic-history" });
      check("L2: stand-in director pass consumed (1 chat call)", gw.state.chatCalls === 1, {
        chatCalls: gw.state.chatCalls,
      });
      const after = await prisma.video.findUnique({ where: { id: video.id } });
      const plan = parsePlan(after?.shotList ?? null);
      check("L2: plan parsed + 3 scenes + 9 shots",
        plan !== null && plan.scenes.length === 3 && plan.scenes.every((s) => s.shots.length === 3),
        { scenes: plan?.scenes.length ?? 0 });
      check("L2: plan carries islamic-history provenance", plan?.contentPolicy === "islamic-history");
      const planFields = (plan?.scenes ?? []).flatMap((s) =>
        s.shots.flatMap((sh) => [sh.imagePrompt ?? "", sh.subject ?? ""])
      );
      const adversarialFields = planFields.filter((f) => scanRestrictedSubjects(f, "islamic-history").length > 0);
      const persistedHits = planFields.flatMap((f) => restrictedOutsideClause(f));
      check("L2: canned plan WAS adversarial (≥5 restricted fields pre-sanitize)",
        adversarialFields.length >= 5, { adversarialFields: adversarialFields.length });
      check("L2: PERSISTED plan sanitized — zero restricted refs outside the negative clause",
        persistedHits.length === 0, persistedHits.slice(0, 3));
      const warn = await prisma.activity.findFirst({
        where: { videoId: video.id, stage: "director", level: "warn" },
        orderBy: { createdAt: "desc" },
      });
      check("L2: substitution ANNOUNCED in the activity feed (warn row)",
        !!warn && /Content policy \(islamic-history\) rewrote/.test(warn.message ?? ""),
        { message: warn?.message?.slice(0, 120) });
      await setDirectorState(video.id, "approved");
      const approved = await prisma.video.findUnique({ where: { id: video.id } });
      check("L2: plan approved (the human gate)", approved?.directorState === "approved");

      // ---- step 1 (paints) + L3: the storyboard through the real job ----
      await runStoryboardJob(video.id);
      const dir = path.join("uploads", video.id);
      const paintStats = [1, 2, 3].map((i) => {
        const p = path.join(dir, `scene-${String(i).padStart(2, "0")}.png`);
        return { i, size: fs.existsSync(p) ? fs.statSync(p).size : 0 };
      });
      check("storyboard: 3 scene paints on storage", paintStats.every((s) => s.size > 1000), paintStats);
      check("storyboard: 3 first paints dispatched to the stand-in (dedupe re-rolls tolerated)",
        gw.state.imagePrompts.length >= 3 && gw.state.imagePrompts.length <= 5, {
          prompts: gw.state.imagePrompts.length,
        });
      const paintHits = gw.state.imagePrompts.flatMap((p) => restrictedOutsideClause(p));
      check("L3 (storyboard): every paint prompt sanitized on the wire", paintHits.length === 0, paintHits.slice(0, 3));
      check("L3 (storyboard): hard negative clause rides every paint",
        gw.state.imagePrompts.every((p) => p.includes(NEG)));
      check("storyboard: quality gate ran on every paint (3 vision calls)",
        gw.state.visionCalls.filter((v) => v.kind === "quality").length === 3);
      const paintHashes = [1, 2, 3].map((i) =>
        sha8(fs.readFileSync(path.join(dir, `scene-${String(i).padStart(2, "0")}.png`)))
      );
      check("storyboard: scene 3 paint is the anonymous traveler (real face for the tripwire)",
        paintHashes[2] === sha8(assets.traveler), { paintHashes });
      const videoRow = await prisma.video.findUnique({ where: { id: video.id } });
      check("storyboard: hasStoryboard set", videoRow?.hasStoryboard === true);

      // ---- step 2 (audio): narration stand-ins, the §B lineage ----
      for (let i = 1; i <= 3; i++) {
        await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
          "-f", "lavfi", "-i", "sine=frequency=196:duration=4",
          "-af", "volume=-26dB", "-ar", "44100", "-ac", "1",
          path.join(dir, `scene-${String(i).padStart(2, "0")}.wav`)], { timeout: 60_000 });
      }
      await prisma.video.update({
        where: { id: video.id },
        data: { hasVoiceover: true, audioDuration: 12.0 },
      });
      check("audio: 3 narration WAVs on disk (4s each)",
        [1, 2, 3].every((i) => fs.statSync(path.join(dir, `scene-${String(i).padStart(2, "0")}.wav`)).size > 1000));
    });
  });
  state.meta.seed = { assetsDir: ASSETS_DIR, vlm: "stand-in (clean)" };
  await saveState();
}

// ---------- phase: render1 ----------

async function phaseRender1() {
  const videoId = state.videoId;
  if (!videoId) throw new Error("state missing videoId — run S55_PHASE=seed first");
  await withStandin("clean", async (gw) => {
    await withCtx(ctx(), async () => {
      const t0 = Date.now();
      await runRenderJob(videoId, {
        mode: "kenburns",
        music: false,
        subtitles: false,
        smartCaptions: false,
      });
      const renderMs = Date.now() - t0;
      state.meta.render1 = { renderMs };

      const video = await prisma.video.findUnique({ where: { id: videoId } });
      check("render1: hasVideo + duration + final.mp4 on storage",
        video?.hasVideo === true && (video.videoDuration ?? 0) > 10 &&
        fs.statSync(path.join("uploads", videoId, "final.mp4")).size > 100_000,
        { duration: video?.videoDuration, bytes: fs.statSync(path.join("uploads", videoId, "final.mp4")).size });

      // ---- step 3: the dense inspection rides the battery ----
      const report = parseQcReport(video?.qcReport ?? null);
      check("render1: QC report stands", report !== null && report.checks.length > 0, {
        checks: report?.checks.length ?? 0,
      });
      const restricted = report?.checks.find((c) => c.id === "restricted-visual");
      check("render1: restricted-visual check emitted", !!restricted);
      check("render1: restricted-visual PASS (stand-in clean verdict)",
        restricted?.status === "pass", restricted);
      const coverageText = `${restricted?.value ?? ""} · ${restricted?.detail ?? ""}`;
      check("render1: coverage discloses grid + tripwire + batches",
        /grid \d+ @/.test(coverageText) && /tripwire /.test(coverageText) && /batch\(es\)/.test(coverageText),
        { coverageText });
      const text = report?.checks.find((c) => c.id === "text-artifacts");
      check("render1: text-artifacts scan measured clean", text?.status === "pass", text);
      const structural = (report?.checks ?? []).filter((c) =>
        ["playable", "aspect", "black-frames", "frozen-frames", "flicker", "stutter", "cut-alignment", "duration"].includes(c.id));
      check("render1: the 8 structural lenses green (the T-55.3 fixed path)",
        structural.length === 8 && structural.every((c) => c.status === "pass"),
        structural.map((c) => `${c.id}:${c.status}`));

      // ---- step 7: the export standard — the gate core on the persisted report ----
      const gate = applyQcPolicy(report, { mode: qcEnforcementMode() });
      check("render1: EXPORT GATE OPEN (applyQcPolicy — the export route's own law)",
        gate.blocked === false, { blockers: gate.blockers.map((b) => b.id) });
      const renderAct = await prisma.activity.findFirst({
        where: { videoId: videoId, stage: "render" },
        orderBy: { createdAt: "desc" },
      });
      check("render1: render activity carries NO export hold",
        !/EXPORT ON HOLD/.test(renderAct?.message ?? ""), { message: renderAct?.message?.slice(0, 160) });

      // ---- step 4 (i2v): the motion prompt seam + the clip on the wire ----
      check("i2v: exactly one motion prompt dispatched (scene 3, needsI2V)",
        gw.state.videoPrompts.length === 1, { prompts: gw.state.videoPrompts.length });
      const motionHits = gw.state.videoPrompts.flatMap((p) => restrictedOutsideClause(p));
      check("i2v (S50 seam): motion prompt sanitized on the wire", motionHits.length === 0, motionHits.slice(0, 3));
      check("i2v: hard negative clause rides the motion prompt",
        gw.state.videoPrompts.every((p) => p.includes(NEG)));
      check("i2v: clip downloaded from the stand-in", gw.state.clipDownloads >= 1, {
        downloads: gw.state.clipDownloads,
      });
      const clipPath = path.join("uploads", videoId, "scene-03.mp4");
      check("i2v: clip cached on storage", fs.existsSync(clipPath) && fs.statSync(clipPath).size > 10_000);

      // ---- extra-shot paints (the render-time L3 site) ----
      const extraPaints = gw.state.imagePrompts.slice(3);
      check("i2v/KB: extra-shot paints dispatched during render (≤6)", extraPaints.length >= 1 && extraPaints.length <= 6, {
        extras: extraPaints.length,
      });
      const extraHits = extraPaints.flatMap((p) => restrictedOutsideClause(p));
      check("L3 (extra shots): every render-time paint sanitized", extraHits.length === 0, extraHits.slice(0, 3));

      // ---- the pixel-level proof the i2v clip PLAYED (magenta marker) ----
      // Scene timings: 3 × (4s WAV + 0.35 lead + 0.85 tail) = 15.6s; scene 3
      // owns ≈10.4–15.6s. Sample the top 10 rows (the clip's drawbox strip)
      // as RAW RGB and count magenta pixels — a Ken Burns degrade over
      // scene-03.png carries no marker, so magenta majority = the clip played.
      const finalPath = path.join("uploads", videoId, "final.mp4");
      const markerRaw = path.join(os.tmpdir(), `s55-marker-${Date.now()}.raw`);
      try {
        await execFileAsync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
          "-ss", "11.0", "-t", "4.0", "-i", finalPath,
          "-vf", "fps=2,crop=1920:10:0:0",
          "-pix_fmt", "rgb24", "-f", "rawvideo", markerRaw], { timeout: 60_000 });
        const raw = fs.readFileSync(markerRaw);
        const frames = raw.length / (1920 * 10 * 3);
        let magentaFrames = 0;
        const frameBytes = 1920 * 10 * 3;
        for (let f = 0; f < frames; f++) {
          const buf = raw.subarray(f * frameBytes, (f + 1) * frameBytes);
          let mag = 0;
          for (let p = 0; p + 2 < buf.length; p += 3) {
            if (buf[p] > 200 && buf[p + 1] < 80 && buf[p + 2] > 200) mag++;
          }
          if (mag > 1920 * 0.5) magentaFrames++;
        }
        check("i2v: final render's scene-3 window carries the clip's magenta marker (the clip PLAYED)",
          frames > 0 && magentaFrames >= Math.ceil(frames / 2),
          { frames, magentaFrames });
      } finally {
        fs.rmSync(markerRaw, { force: true });
      }

      // ---- the real tripwire over the EXPORTED artifact (zero-prohibited-faces standard) ----
      const dur = video?.videoDuration ?? 12;
      const gridTmp = fs.mkdtempSync(path.join(os.tmpdir(), "s55-grid-"));
      try {
        fs.mkdirSync(path.join(gridTmp, "frames"));
        fs.writeFileSync(path.join(gridTmp, "tripwire.py"), FACE_TRIPWIRE_PY);
        const { fps, count } = planDenseGrid(dur);
        const gridCount = await extractDenseGrid(finalPath, path.join(gridTmp, "frames"), fps, count);
        const trip = await runFaceTripwire(path.join(gridTmp, "tripwire.py"), path.join(gridTmp, "frames"), 0.015);
        const hitTimes = trip.hits.map((h) => Math.round((h.index / fps) * 100) / 100);
        check("standard: tripwire MEASURED on the exported final.mp4 (real haar)",
          trip.available && trip.scanned === gridCount && gridCount > 20,
          { cv2: trip.cv2, scanned: trip.scanned, grid: gridCount });
        check("standard: anonymous traveler's face detected in the export (tripwire forces frames to the judge)",
          trip.hits.length > 0, { hits: trip.hits.length, hitTimes });
        state.meta.render1 = {
          ...(state.meta.render1 as object),
          gridCount, tripwireHits: trip.hits.length, hitTimes,
          scanVerdict: "stand-in (clean)",
        };
      } finally {
        fs.rmSync(gridTmp, { recursive: true, force: true });
      }
    });
  });
  await saveState();
}

// ---------- phase: regen ----------

async function phaseRegen() {
  const videoId = state.videoId;
  if (!videoId) throw new Error("state missing videoId — run S55_PHASE=seed first");
  await withStandin("clean", async (gw) => {
    await withCtx(ctx(), async () => {
      // ---- step 4a: re-roll scene 1 (its visual names the Prophet) ----
      await runSceneJob(videoId, { sceneIndex: 1 });
      const rerollPrompt = gw.state.imagePrompts[0] ?? "";
      check("regen: scene 1 re-rolled (paint dispatched; dedupe re-roll tolerated)",
        gw.state.imagePrompts.length >= 1 && gw.state.imagePrompts.length <= 2 && rerollPrompt.length > 0,
        { dispatches: gw.state.imagePrompts.length });
      const rerollHits = restrictedOutsideClause(rerollPrompt);
      check("regen (re-roll): L3 sanitized on the wire — zero restricted refs", rerollHits.length === 0, rerollHits);
      check("regen (re-roll): negative clause rides the re-roll prompt", rerollPrompt.includes(NEG));

      // ---- step 4b: ADVERSARIAL AI-edit instruction on scene 2 ----
      await runSceneJob(videoId, {
        sceneIndex: 2,
        instruction: "show the Prophet Muhammad and Abu Bakr walking together in the foreground, faces clearly visible",
      });
      const editPrompt = gw.state.editPrompts[0] ?? "";
      check("regen: scene 2 AI-edit dispatched to the stand-in", editPrompt.length > 0);
      const editHits = restrictedOutsideClause(editPrompt);
      check("regen (AI-edit, T-55.5 fix): instruction sanitized on the wire — zero restricted refs",
        editHits.length === 0, editHits);
      check("regen (AI-edit): negative clause rides the edit prompt", editPrompt.includes(NEG));
      check("regen (AI-edit): the surgical boilerplate survived",
        /Keep the overall composition/.test(editPrompt) && /no text/.test(editPrompt));

      const video = await prisma.video.findUnique({ where: { id: videoId } });
      check("regen: rendered artifacts invalidated (hasVideo false — new evidence required)",
        video?.hasVideo === false);
      check("regen: storyboard still complete",
        video?.hasStoryboard === true &&
        fs.statSync(path.join("uploads", videoId, "scene-02.png")).size > 1000);
      const editAct = await prisma.activity.findFirst({
        where: { videoId: videoId, stage: "storyboard" },
        orderBy: { createdAt: "desc" },
      });
      check("regen: activity row records the AI-edit",
        /AI-edited/.test(editAct?.message ?? ""), { message: editAct?.message?.slice(0, 120) });
    });
  });
  await saveState();
}

// ---------- phase: render2 (violation) ----------

async function phaseRender2() {
  const videoId = state.videoId;
  if (!videoId) throw new Error("state missing videoId — run S55_PHASE=seed first");
  await withStandin("violation", async (gw) => {
    await withCtx(ctx(), async () => {
      await runRenderJob(videoId, {
        mode: "kenburns",
        music: false,
        subtitles: false,
        smartCaptions: false,
      });
      const video = await prisma.video.findUnique({ where: { id: videoId } });
      const report = parseQcReport(video?.qcReport ?? null);
      const restricted = report?.checks.find((c) => c.id === "restricted-visual");
      check("render2: re-render stands (new final.mp4 + fresh report)",
        video?.hasVideo === true && !!report);
      check("render2 (step 5): restricted-visual FAILS on the violation verdict",
        restricted?.status === "fail", restricted);
      check("render2: failing frames named with timestamps",
        /frames:/.test(restricted?.detail ?? "") && /t=/.test(restricted?.detail ?? ""),
        { detail: restricted?.detail });
      const gate = applyQcPolicy(report, { mode: qcEnforcementMode() });
      check("render2 (step 5): EXPORT GATE BLOCKED (applyQcPolicy)",
        gate.blocked === true, { blockers: gate.blockers.map((b) => `${b.id}:${b.status}`) });
      check("render2 (step 5): restricted-visual IS the blocker (severity block)",
        gate.blockers.some((b) => b.id === "restricted-visual" && b.severity === "block"));
      const renderAct = await prisma.activity.findFirst({
        where: { videoId: videoId, stage: "render" },
        orderBy: { createdAt: "desc" },
      });
      check("render2: render activity announces EXPORT ON HOLD",
        /EXPORT ON HOLD/.test(renderAct?.message ?? ""), { message: renderAct?.message?.slice(0, 200) });
      const scanCalls = gw.state.visionCalls.filter((v) => v.kind === "scan");
      check("render2: scan short-circuited on the first failing batch",
        scanCalls.length >= 1 && scanCalls.every((v) => v.mode === "violation"),
        { scanCalls: scanCalls.length });
      state.meta.render2 = { scanVerdict: "stand-in (violation)", blocked: true };
    });
  });
  await saveState();
}

// ---------- phase: unmeasured (QC re-run) ----------

async function phaseUnmeasured() {
  const videoId = state.videoId;
  if (!videoId) throw new Error("state missing videoId — run S55_PHASE=seed first");
  await withStandin("garbage", async (gw) => {
    await withCtx(ctx(), async () => {
      await runQcJob(videoId);
      const scanCalls = gw.state.visionCalls.filter((v) => v.kind === "scan");
      check("unmeasured: the garbage verdict reached the scan (short-circuit after batch 1)",
        scanCalls.length >= 1 && scanCalls.every((v) => v.mode === "garbage"),
        { scanCalls: scanCalls.length });
      const video = await prisma.video.findUnique({ where: { id: videoId } });
      const report = parseQcReport(video?.qcReport ?? null);
      const restricted = report?.checks.find((c) => c.id === "restricted-visual");
      check("unmeasured (step 6): QC re-run stands on the same final.mp4",
        video?.hasVideo === true && !!report);
      check("unmeasured (step 6): restricted-visual reads UNMEASURED (fail-closed, never silently clean)",
        restricted?.status === "unmeasured", restricted);
      const gate = applyQcPolicy(report, { mode: qcEnforcementMode() });
      check("unmeasured (step 6): EXPORT GATE STILL BLOCKED (an unmeasured lens cannot certify)",
        gate.blocked === true, { blockers: gate.blockers.map((b) => `${b.id}:${b.status}`) });
      check("unmeasured: the unmeasured verdict is attributed to the unreadable batch",
        /unreadable|could not/.test((restricted?.value ?? "") + (restricted?.detail ?? "")),
        { value: restricted?.value, detail: restricted?.detail });
      state.meta.unmeasured = { scanVerdict: "stand-in (garbage)", blocked: true };
    });
  });
  await saveState();
}

// ---------- phase: report ----------

async function phaseReport() {
  const byPhase = new Map<string, { pass: number; fail: number }>();
  for (const c of state.checks) {
    const agg = byPhase.get(c.phase) ?? { pass: 0, fail: 0 };
    if (c.ok) agg.pass++;
    else agg.fail++;
    byPhase.set(c.phase, agg);
  }
  const data = {
    recordedAt: new Date().toISOString(),
    probe: "scripts/s55-acceptance-probe.mts",
    commit: (await execFileAsync("git", ["rev-parse", "--short", "HEAD"])).stdout.toString().trim(),
    spend: {
      gatewayQuotaSpent: 0,
      paidDispatches: 0,
      standinOnly: true,
      spendGate: "untouched (no TUBEFORGE_SPEND_GATE override)",
    },
    ids: { userId: state.userId, orgId: state.orgId, videoId: state.videoId },
    meta: state.meta,
    phases: Object.fromEntries(byPhase),
    checks: state.checks,
  };
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
  console.info(`\n=== S55 T-55.5 acceptance summary ===`);
  for (const [phase, agg] of byPhase) {
    console.info(`  ${phase.padEnd(11)} ${agg.pass} pass · ${agg.fail} fail`);
  }
  console.info(`  evidence → ${DATA_PATH}`);
}

// ---------- teardown ----------

async function teardown() {
  if (!state.userId || !state.orgId) return;
  const ids = await prisma.video.findMany({
    where: { organizationId: state.orgId },
    select: { id: true },
  });
  for (const v of ids) {
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
  console.info("[teardown] probe rows + uploads removed");
}

// ---------- main ----------

try {
  if (PHASE === "seed") await phaseSeed();
  else if (PHASE === "render1") await phaseRender1();
  else if (PHASE === "regen") await phaseRegen();
  else if (PHASE === "render2") await phaseRender2();
  else if (PHASE === "unmeasured") await phaseUnmeasured();
  else if (PHASE === "report") await phaseReport();
  else if (PHASE === "teardown") await teardown();
  else throw new Error(`unknown S55_PHASE "${PHASE}"`);
} catch (err) {
  console.error(`[s55-acceptance:${PHASE}] FATAL:`, err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect().catch(() => undefined);
  await saveState().catch(() => undefined);
  if (failures > 0) process.exitCode = 1;
}
