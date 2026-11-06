// S47 unit benchmark — the Director's audition (T-47.7).
//
// The external audit's open item: "director acceptance benchmark — repeated
// generation + malformed-JSON recovery evidence, five-genre visual pass".
// Three layers, in the probe tradition (s27/s32/s34):
//
//   §A  MALFORMED-JSON RECOVERY (offline, deterministic) — a corpus of the
//       exact variance the live re-run taught us about (S45): fences, BOM +
//       zero-width noise, curly quotes, trailing commas, prose around the
//       payload, trailing junk — every one must come back through
//       parseJsonLoose + parsePlan as a usable plan; truncation must fail
//       HONESTLY (throw, never a fake plan).
//   §A2 THE S45 RETRY CLOSURE (offline) — aiCallJson with the REAL aiCall
//       retry loop: attempt 1 returns prose-with-braces, attempt 2 returns
//       the plan → the call must recover on the second attempt; an
//       all-garbage ask must exhaust its retries and throw.
//   §B  FIVE-GENRE LIVE PASS — the five production profiles plus the
//       narrative control, each seeded with a fixed genre script, two
//       director passes per genre (the second is the S45 re-run case: the
//       plan is overwritten in place), then the plan is APPROVED and scene 1
//       is painted through the real storyboard path (quality gate included)
//       and re-scored by an independent VLM pass. Every number lands in
//       docs/baselines/ as the RECORDED BASELINE — thresholds are set at
//       S54 with human review, not claimed here.
//
// Live §B uses the Z.ai platform gateway (ungated, metered-only) — no paid
// dispatch, no user credentials needed. Run:
//   node --import tsx scripts/s47-director-benchmark.mts

process.env.TUBEFORGE_AUTH_SECRET ??= "probe-secret-0123456789abcdef";

import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import fs from "node:fs";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import { aiCallJson, parseJsonLoose } from "../src/lib/tubeforge/ai";
import {
  runDirectorPass,
  setDirectorState,
  parsePlan,
  resolveProfile,
  type DirectorPlan,
} from "../src/lib/tubeforge/director";
import { generateSceneImage, parseScenes, sceneImageFile } from "../src/lib/tubeforge/story";
import { visionComplete } from "../src/lib/tubeforge/providers/vision";
import { getCapability, saveCapability } from "../src/lib/tubeforge/providers/settings";
import * as storage from "../src/lib/tubeforge/storage";

const prisma = new PrismaClient();
const SUFFIX = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const UTC_DAY = new Date().toISOString().slice(0, 10);
const BASELINE_PATH = `docs/baselines/s47-director-benchmark-${UTC_DAY}.txt`;
let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.info(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// A minimal, schema-valid plan the corpus mutates. Mirrors the DirectorShot /
// DirectorScene v1 shape (director-plan.ts) — the fields parsePlan snaps.
const BASE_PLAN = {
  concept: "a lone signal in the noise",
  musicMood: "cinematic",
  ducking: "standard",
  scenes: [
    {
      sceneIndex: 1,
      mood: "cold blue night, rim light from signage",
      transitionIn: "fade",
      motion: "smart",
      needsI2V: false,
      useStock: false,
      pacing: "normal",
      ambience: "city",
      sfx: "none",
      locations: [],
      props: [],
      shots: [
        { shotIndex: 0, framing: "wide", camera: "push-in", lens: "24mm wide", composition: "leading lines", duration: 3.0, imagePrompt: "a rain-slick street under neon signage" },
      ],
    },
    {
      sceneIndex: 2,
      mood: "warm interior, single practical lamp",
      transitionIn: "cut",
      motion: "smart",
      needsI2V: false,
      useStock: false,
      pacing: "normal",
      ambience: "room",
      sfx: "none",
      locations: [],
      props: [],
      shots: [
        { shotIndex: 0, framing: "medium", camera: "static", lens: "50mm", composition: "centered", duration: 2.5, imagePrompt: "hands turning a brass dial" },
      ],
    },
  ],
};
const baseJson = JSON.stringify(BASE_PLAN);

interface CorpusCase {
  name: string;
  raw: string;
  mustRecover: boolean;
}
const CORPUS: CorpusCase[] = [
  { name: "markdown-fenced", raw: "```json\n" + baseJson + "\n```", mustRecover: true },
  { name: "bom-and-zero-width", raw: "\uFEFF\u200B" + baseJson + "\u2060", mustRecover: true },
  {
    name: "curly-quotes-in-values",
    raw: baseJson.replace("a lone signal in the noise", "a lone signal in “the noise” — it’s real"),
    mustRecover: true,
  },
  { name: "trailing-comma", raw: `${baseJson.slice(0, -1)},}`, mustRecover: true },
  { name: "prose-wrapped", raw: `Here is the plan you asked for:\n${baseJson}\nHope this helps — tell me if you want changes!`, mustRecover: true },
  { name: "trailing-junk-brace", raw: baseJson + " }", mustRecover: true },
  { name: "truncated-payload", raw: baseJson.slice(0, Math.floor(baseJson.length * 0.55)), mustRecover: false },
  { name: "empty-scenes-array", raw: JSON.stringify({ ...BASE_PLAN, scenes: [] }), mustRecover: false },
  // S47 structural-repair classes — the live gateway failures the benchmark
  // caught in the wild (glm-4.6 emitting `"lens":100mm`, over/under-closed
  // tails). The repair landed in parseJsonLoose alongside this corpus.
  {
    name: "unquoted-scalar-value",
    raw: baseJson.replace('"lens":"24mm wide"', '"lens":24mm wide'),
    mustRecover: true,
  },
  {
    name: "unquoted-numeric-suffix",
    raw: baseJson.replace('"lens":"50mm"', '"lens":100mm'),
    mustRecover: true,
  },
  { name: "missing-closers", raw: baseJson.slice(0, -2), mustRecover: true },
];

// ---------- §A malformed-JSON recovery ----------
console.info("\n§A malformed-JSON recovery corpus (offline)");
let aRecovered = 0;
let aHonest = 0;
{
  for (const c of CORPUS) {
    let plan: DirectorPlan | null = null;
    let parseThrew = false;
    try {
      const parsed = parseJsonLoose(c.raw);
      plan = parsePlan(JSON.stringify(parsed));
    } catch {
      parseThrew = true;
    }
    if (c.mustRecover) {
      const ok = !parseThrew && plan !== null && plan.scenes.length === 2;
      check(`recover: ${c.name}`, ok, { parseThrew, scenes: plan?.scenes.length ?? 0 });
      if (ok) aRecovered++;
    } else {
      // must fail honestly: throw OR a plan-shaped rejection — never a fake plan
      const ok = parseThrew || plan === null || plan.scenes.length === 0;
      check(`honest-fail: ${c.name}`, ok, { parseThrew, scenes: plan?.scenes.length ?? -1 });
      if (ok) aHonest++;
    }
  }
  check("§A totals", aRecovered === 9 && aHonest === 2, { aRecovered, aHonest });
}

// ---------- §A2 the S45 retry closure (real aiCall retries, offline ask) ----------
console.info("\n§A2 aiCallJson retry closure (offline)");
let a2RecoveredOn = 0;
let a2ExhaustedAsks = 0;
{
  let asks = 0;
  const plan = await aiCallJson<DirectorPlan>("llm", "benchmark retry-recovery", async () => {
    asks++;
    if (asks === 1) return "The plan concept needs more research before I can commit to specific shots — ask me again.";
    return baseJson;
  }, {
    validate: (parsed) => {
      const p = parsePlan(JSON.stringify(parsed));
      if (!p || p.scenes.length === 0) throw new Error("no usable scenes — try again");
      return p;
    },
    retry: { attempts: 3, baseDelayMs: 25 },
  });
  check("garbage-then-good recovers on attempt 2", asks === 2 && plan.scenes.length === 2, { asks, scenes: plan.scenes.length });
  a2RecoveredOn = asks;

  let asks2 = 0;
  let threwAll = false;
  try {
    await aiCallJson<DirectorPlan>("llm", "benchmark all-garbage", async () => {
      asks2++;
      return "I could not produce that plan because the concept needs more research first.";
    }, {
      validate: (parsed) => {
        const p = parsePlan(JSON.stringify(parsed));
        if (!p || p.scenes.length === 0) throw new Error("no usable scenes — try again");
        return p;
      },
      retry: { attempts: 2, baseDelayMs: 25 },
    });
  } catch {
    threwAll = true;
  }
  check("all-garbage exhausts retries and throws", threwAll && asks2 === 2, { threwAll, asks2 });
  a2ExhaustedAsks = asks2;
}

// ---------- §B five-genre live pass ----------
interface SeedScene {
  index: number;
  title: string;
  narration: string;
  visual: string;
  camera: string;
  mood: string;
  caption: string;
  hostInScene: boolean;
  rehook: boolean;
  sfx: string;
}
interface GenreSeed {
  profile: string;
  topic: string;
  niche: string;
  tone: string;
  scenes: SeedScene[];
}
const GENRES: GenreSeed[] = [
  {
    profile: "narrative", topic: "Why the city's lights are lying to you", niche: "technology", tone: "mysterious",
    scenes: [
      { index: 1, title: "Open", narration: "A host greets the audience from a neon city street at night, rain just ended.", visual: "host on a neon-lit city street, rain just ended, reflections on asphalt", camera: "zoom-in", mood: "neon night, wet reflections", caption: "hello", hostInScene: false, rehook: false, sfx: "none" },
      { index: 2, title: "Turn", narration: "But the lights are lying to you, and tonight we prove it with one measurement.", visual: "close-up on a glowing sign flickering out", camera: "push-in", mood: "colder neon, deeper shadow", caption: "the lie", hostInScene: false, rehook: true, sfx: "sting" },
      { index: 3, title: "Proof", narration: "One cheap sensor, one honest graph, and the whole street's story changes.", visual: "hand holding a small glowing sensor device toward a bright billboard", camera: "pan-right", mood: "determined, focused", caption: "measure it", hostInScene: false, rehook: false, sfx: "none" },
    ],
  },
  {
    profile: "documentary", topic: "Bukhara: jewel of the Silk Road", niche: "history", tone: "reverent",
    scenes: [
      { index: 1, title: "Arrival", narration: "At dawn, caravans crested the desert ridge and saw Bukhara's walls rising from the sand.", visual: "camel caravan crossing desert dunes toward ancient city walls at dawn", camera: "zoom-out", mood: "golden dawn, vast desert", caption: "the caravan", hostInScene: false, rehook: false, sfx: "none" },
      { index: 2, title: "The facade", narration: "Centuries of craft cover every inch of the madrasa's tiled face.", visual: "ornamented madrasa facade with intricate turquoise mosaic tilework", camera: "tilt-up", mood: "reverent daylight, deep blue and gold", caption: "every tile", hostInScene: false, rehook: false, sfx: "none" },
      { index: 3, title: "The bazaar", narration: "Under the domes, silk, spice and rumor moved with equal weight.", visual: "traders in a domed bazaar hall with silk bolts and spice sacks", camera: "pan-left", mood: "warm lamplight, busy texture", caption: "the trade", hostInScene: false, rehook: true, sfx: "none" },
    ],
  },
  {
    profile: "explainer", topic: "How a suspension bridge carries weight", niche: "engineering", tone: "clear",
    scenes: [
      { index: 1, title: "The span", narration: "Two towers, one ribbon of steel, and a road hanging in the air between them.", visual: "full suspension bridge span between two towers seen from the water", camera: "zoom-out", mood: "clear daylight, structural clarity", caption: "the span", hostInScene: false, rehook: false, sfx: "none" },
      { index: 2, title: "The saddle", narration: "Every gram of the road funnels into cable bundles riding the tower tops.", visual: "massive steel cable bundle passing over the saddle atop a bridge tower", camera: "push-in", mood: "overcast steel grey, precise", caption: "load path", hostInScene: false, rehook: false, sfx: "none" },
      { index: 3, title: "The hangers", narration: "Vertical ropes hand the deck's weight up to the main cables, evenly, endlessly.", visual: "vertical suspender ropes connecting main cable to stiffened bridge deck", camera: "tilt-down", mood: "clean engineering light", caption: "hangers", hostInScene: false, rehook: false, sfx: "none" },
    ],
  },
  {
    profile: "advertisement", topic: "AeroBrew: serious espresso, anywhere", niche: "product", tone: "energetic",
    scenes: [
      { index: 1, title: "Hero", narration: "Nine hundred grams of matte-black engineering. Ninety seconds to a perfect shot.", visual: "matte-black portable espresso machine on a stone countertop, steam rising", camera: "push-in", mood: "studio warm key, dark background", caption: "meet AeroBrew", hostInScene: false, rehook: false, sfx: "none" },
      { index: 2, title: "Demo", narration: "One lever, one cup, zero compromise.", visual: "hand pressing the brew lever of the espresso machine, crema streaming into a cup", camera: "zoom-in", mood: "shallow focus, rich warm tones", caption: "one lever", hostInScene: false, rehook: false, sfx: "none" },
      { index: 3, title: "Life", narration: "Because your kitchen is wherever you are.", visual: "espresso machine beside a campfire at mountain dawn", camera: "pull-out", mood: "cold blue dawn, warm fire", caption: "anywhere", hostInScene: false, rehook: false, sfx: "none" },
    ],
  },
  {
    profile: "animation", topic: "The little lighthouse keeper", niche: "animation", tone: "warm",
    scenes: [
      { index: 1, title: "The island", narration: "On the smallest island in the bay lived the smallest keeper of the biggest light.", visual: "tiny island with a striped lighthouse in soft morning light, stylized animation look", camera: "zoom-out", mood: "pastel morning, gentle", caption: "the island", hostInScene: false, rehook: false, sfx: "none" },
      { index: 2, title: "The lens", narration: "Every day she polished the great lens until the sea itself looked clearer.", visual: "small keeper character polishing the giant lamp lens inside the lighthouse", camera: "push-in", mood: "amber interior, dust in light beams", caption: "the lens", hostInScene: false, rehook: false, sfx: "none" },
      { index: 3, title: "The storm", narration: "And when the storm came, her light was the only one that never blinked.", visual: "storm waves crashing against the lighthouse at night, beam sweeping the sea", camera: "crane-up", mood: "dramatic night, deep blues", caption: "hold steady", hostInScene: false, rehook: true, sfx: "riser" },
    ],
  },
  {
    profile: "social", topic: "3 habits quietly wrecking your sleep", niche: "lifestyle", tone: "punchy",
    scenes: [
      { index: 1, title: "Hook", narration: "You're not tired because of stress. You're tired because of these three habits.", visual: "close-up of a tired face lit only by a phone screen in a dark bedroom", camera: "punch", mood: "harsh screen light, deep dark", caption: "it's not stress", hostInScene: false, rehook: true, sfx: "boom" },
      { index: 2, title: "Habit one", narration: "Habit one: the 3pm coffee that's still in your blood at midnight.", visual: "coffee cup on a desk beside a clock in late afternoon light", camera: "zoom-in", mood: "flat afternoon light", caption: "3pm coffee", hostInScene: false, rehook: false, sfx: "none" },
      { index: 3, title: "Habit two", narration: "Habit two: the phone in bed. Your brain reads it as daylight.", visual: "person scrolling a phone in bed, face washed in blue light", camera: "pan-left", mood: "cold blue darkness", caption: "blue light lie", hostInScene: false, rehook: false, sfx: "none" },
    ],
  },
];

const REPEATS = Number(process.env.S47_DIRECTOR_REPEATS ?? "2");

interface RunRow {
  profile: string;
  run: number;
  ms: number;
  scenes: number;
  shots: number;
  distinctShot0Framings: number;
  validationFindings: number;
  totalPlanSeconds: number;
}
interface PaintRow {
  profile: string;
  bytes: number;
  sha16: string;
  vlmScore: number | null;
  vlmSummary: string;
}
const runRows: RunRow[] = [];
const paintRows: PaintRow[] = [];
const videoIds: string[] = [];

const EMAIL = `s47-dir-${SUFFIX}@e2e.local`;
const passwordHash = await hashPassword("probe-password-123");
const user = await prisma.user.create({ data: { email: EMAIL, passwordHash, name: "s47 director benchmark" } });
const org = await prisma.organization.create({
  data: { name: "s47 director benchmark org", slug: `s47-dir-${SUFFIX}`, memberships: { create: { userId: user.id, role: "owner" } } },
});

try {
  await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, async () => {
    const defaultChat = await getCapability("chat");
    // Pin the DIRECTOR-GRADE model for genre coverage. The first benchmark
    // run measured the production default (glm-4.5-flash) and it failed the
    // narrative RE-RUN 3/3 (two non-JSON responses, one scene-less object) —
    // recorded below as a finding; model selection is an S48 Director
    // decision, so the benchmark pins glm-4.6 (s27 §6 precedent) and measures
    // that path.
    await saveCapability("chat", { provider: "zai", model: "glm-4.6" });
    const pinned = await getCapability("chat");
    console.info(`\n§B five-genre live pass — platform default: ${defaultChat.provider}/${defaultChat.model ?? "(default)"}; benchmark pinned: ${pinned.provider}/${pinned.model ?? "(default)"}; repeats: ${REPEATS}`);

    for (const genre of GENRES) {
      const video = await prisma.video.create({
        data: {
          organizationId: org.id,
          topic: genre.topic,
          niche: genre.niche,
          tone: genre.tone,
          title: `S47 benchmark — ${genre.profile}`,
          format: "story",
          scenes: JSON.stringify(genre.scenes),
        },
      });
      videoIds.push(video.id);

      for (let run = 1; run <= REPEATS; run++) {
        const t0 = Date.now();
        await runDirectorPass(video.id, { profile: genre.profile });
        const ms = Date.now() - t0;
        const fresh = await prisma.video.findUnique({ where: { id: video.id } });
        const plan = parsePlan(fresh?.shotList ?? null);
        const ok = plan !== null && plan.scenes.length === genre.scenes.length && plan.scenes.every((s) => s.shots.length >= 1);
        check(`[${genre.profile}] run ${run}: schema-valid plan`, ok, {
          scenes: plan?.scenes.length ?? 0,
          shotsPerScene: plan?.scenes.map((s) => s.shots.length).join(",") ?? "",
        });
        if (!plan) continue;
        const framings = new Set(plan.scenes.map((s) => s.shots[0]?.framing ?? ""));
        const findings = resolveProfile(genre.profile).validation(plan);
        const seconds = plan.scenes.reduce((a, s) => a + s.shots.reduce((b, sh) => b + sh.duration, 0), 0);
        runRows.push({
          profile: genre.profile,
          run,
          ms,
          scenes: plan.scenes.length,
          shots: plan.scenes.reduce((a, s) => a + s.shots.length, 0),
          distinctShot0Framings: framings.size,
          validationFindings: findings.length,
          totalPlanSeconds: Math.round(seconds * 10) / 10,
        });
      }

      // Approve the plan, then paint scene 1 through the real storyboard path
      // (the paint itself runs the production VLM quality gate internally).
      await setDirectorState(video.id, "approved");
      const seeded = parseScenes((await prisma.video.findUnique({ where: { id: video.id } }))?.scenes ?? "[]");
      const scene1 = seeded.find((s) => s.index === 1);
      if (!scene1) {
        check(`[${genre.profile}] seeded scene 1 present`, false);
        continue;
      }
      await generateSceneImage({ videoId: video.id, scene: scene1 });
      const buf = await storage.get(`${video.id}/${sceneImageFile(scene1.index)}`).catch(() => null);
      const sha16 = buf ? crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) : "";
      check(`[${genre.profile}] scene 1 painted`, !!buf && buf.length > 1000, { bytes: buf?.length ?? 0 });

      // Independent VLM re-score (the benchmark's own inspector, not the gate).
      let vlmScore: number | null = null;
      let vlmSummary = "";
      if (buf) {
        try {
          const raw = await visionComplete({
            system: "You are a strict quality inspector for AI-generated storyboard art. You always respond with STRICT JSON only.",
            user: `Context: opening scene of a ${genre.profile} video about "${genre.topic}" — the intended moment: ${scene1.visual}.

Rate this image 0-10 for upload readiness. Deduct heavily for garbled text baked into the art, deformed faces/hands/limbs, obvious AI artifacts, blank or near-blank frames, or STORY MISMATCH (the image must show the described moment).

Respond with STRICT JSON only: {"score": <integer 0-10>, "issues": [<short strings>], "summary": "<one sentence>"}`,
            imagePngBase64: buf.toString("base64"),
          });
          const parsed = parseJsonLoose(raw ?? "");
          const n = Number(parsed.score);
          if (Number.isFinite(n)) {
            vlmScore = Math.max(0, Math.min(10, Math.round(n)));
            vlmSummary = String(parsed.summary ?? "").slice(0, 160);
          }
        } catch (err) {
          vlmSummary = `re-score failed: ${String(err).slice(0, 80)}`;
        }
      }
      paintRows.push({ profile: genre.profile, bytes: buf?.length ?? 0, sha16, vlmScore, vlmSummary });
      check(`[${genre.profile}] independent VLM re-score parsed`, vlmScore !== null, { vlmScore, vlmSummary });
    }
  });
} finally {
  // ---------- teardown ----------
  // Fire-and-forget usage rows (void recordAiUsage) can still be in flight
  // when the body throws — let them land BEFORE deleting the scratch user,
  // or their FK insert fails noisily (observed on the first benchmark run).
  await new Promise((r) => setTimeout(r, 1500));
  for (const id of videoIds) {
    await prisma.activity.deleteMany({ where: { videoId: id } }).catch(() => {});
    await prisma.characterAppearance.deleteMany({ where: { videoId: id } }).catch(() => {});
    await prisma.video.delete({ where: { id } }).catch(() => {});
    fs.rmSync(`uploads/${id}`, { recursive: true, force: true });
  }
  await prisma.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
}

// ---------- report ----------
const okRuns = runRows.length;
const meanMs = okRuns ? Math.round(runRows.reduce((a, r) => a + r.ms, 0) / okRuns) : 0;
const validGenres = new Set(runRows.map((r) => r.profile)).size;
const lines: string[] = [];
lines.push(`S47 director acceptance benchmark — recorded ${new Date().toISOString()}`);
lines.push(`Repeats per genre: ${REPEATS}. Live path: Z.ai platform gateway (ungated, metered-only).`);
lines.push("Model note: the benchmark pins chat to zai/glm-4.6 (saveCapability, per s27 §6");
lines.push("precedent). The platform default glm-4.5-flash was measured on the first run and");
lines.push("failed the narrative RE-RUN 3/3 attempts (2 non-JSON, 1 scene-less object) — a");
lines.push("recorded finding for S48: director-grade model selection / prompt hardening.");
lines.push("");
lines.push(`§A malformed-JSON recovery: ${aRecovered}/9 corpus cases recovered through parseJsonLoose +`);
lines.push(`   parsePlan; ${aHonest}/2 must-fail cases (truncated payload, empty scenes) failed honestly.`);
lines.push(`§A2 retry closure: garbage-then-good recovered on attempt ${a2RecoveredOn} of 3; all-garbage`);
lines.push(`   exhausted ${a2ExhaustedAsks} retries and threw. (Deterministic — re-provable offline.)`);
lines.push("");
lines.push("§B director runs (schema-valid after aiCallJson validate+retry):");
lines.push("profile       run  ms    scenes shots shot0-framings findings planSec");
for (const r of runRows) {
  lines.push(`${r.profile.padEnd(13)} ${String(r.run).padStart(3)} ${String(r.ms).padStart(5)} ${String(r.scenes).padStart(6)} ${String(r.shots).padStart(5)} ${String(r.distinctShot0Framings).padStart(15)} ${String(r.validationFindings).padStart(8)} ${String(r.totalPlanSeconds).padStart(7)}`);
}
lines.push("");
lines.push("§B scene-1 paint + independent VLM re-score (0-10):");
lines.push("profile       bytes    sha256-16    score  summary");
for (const p of paintRows) {
  lines.push(`${p.profile.padEnd(13)} ${String(p.bytes).padStart(7)} ${p.sha16.padEnd(12)} ${String(p.vlmScore ?? "n/a").padStart(5)}  ${p.vlmSummary}`);
}
lines.push("");
lines.push(`Totals: ${okRuns}/${GENRES.length * REPEATS} director runs schema-valid · ${validGenres}/${GENRES.length} genres produced plans · mean director latency ${meanMs} ms.`);
lines.push("");
lines.push("BASELINE, not a threshold claim: genre/visual acceptance thresholds are set at S54");
lines.push("with human review on record. This file exists so S54 has a measured starting point.");
fs.writeFileSync(BASELINE_PATH, `${lines.join("\n")}\n`);
console.info(`\nbaseline written: ${BASELINE_PATH}`);
console.info(lines.join("\n"));

check("§B gate: every run + paint succeeded", okRuns === GENRES.length * REPEATS && paintRows.length === GENRES.length && paintRows.every((p) => p.bytes > 1000));
console.info(`\n${failures === 0 ? "ALL CHECKS PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
