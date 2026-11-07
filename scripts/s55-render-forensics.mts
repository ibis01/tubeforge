// S55 T-55.1 + T-55.2 — render forensics on the S54 §B anchor case.
//
// The S54 baseline's real-render matrix measured two failures:
//   frozen-frames  — "3 frozen runs"  (freezedetect n=0.004 d=1.00)
//   cut-alignment  — "2 unexpected, 0 missing"  (scene>0.40 vs the clock)
//
// This script reproduces the §B anchor render VERBATIM (same Nova anchor,
// same scenes, same profile, same render params — the S51 audition lineage),
// then measures the produced final.mp4 at frame level to LOCALIZE both
// failure classes:
//   1. freezedetect at d=1.00 (the lens's calibration) AND d=0.50 —
//      timestamps, durations, and the per-frame pixel-difference profile
//      inside each freeze (is the motion genuinely absent, or sub-noise?).
//   2. scene-change detection at the lens threshold 0.40 plus a 0.20
//      near-miss view, aligned against BOTH the booked expectation
//      (expectedCutsForTimeline: scene seams only) and the computed
//      intra-scene shot-flip times (buildSceneShots on the blended clock).
//
// READ-ONLY vs src/: no product behavior changes here. Evidence lands in
// docs/audits/s55-render-forensics-data.json; the human-readable note is
// authored from the evidence afterwards. Teardown follows the S47/§B
// pattern (no DB or scratch residue).
//
// Usage: node --import tsx scripts/s55-render-forensics.mts

import { PrismaClient } from "@prisma/client";
import { execFile } from "child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";
import { withCtx, hashPassword } from "../src/lib/tubeforge/tenant";
import {
  runDirectorPass,
  setDirectorState,
  parsePlan,
} from "../src/lib/tubeforge/director";
import {
  generateSceneImage,
  parseScenes,
  sceneImageFile,
  sceneWavFile,
} from "../src/lib/tubeforge/story";
import { renderVideo } from "../src/lib/tubeforge/render";
import { runPortraitJob } from "../src/lib/tubeforge/character-jobs";
import { readPortrait } from "../src/lib/tubeforge/characters";
import { runQcReport } from "../src/lib/tubeforge/qc";
import { saveCapability } from "../src/lib/tubeforge/providers/settings";
import * as storage from "../src/lib/tubeforge/storage";
import {
  parseSceneCuts,
  parseYavgLog,
  detectSceneCuts,
  alignCuts,
  CUT_TOL_SEC,
} from "../src/lib/tubeforge/render-qc";
import { buildSceneShots } from "../src/lib/tubeforge/shots";
import { transitionOffsetsMulti } from "../src/lib/tubeforge/transitions";
import { R_LEAD_SEC, R_TAIL_SEC, R_MIN_SEG_SEC } from "../src/lib/tubeforge/preview-lanes";

const execFileAsync = promisify(execFile);
const prisma = new PrismaClient();
const SUFFIX = `${Date.now().toString(36)}-${process.pid.toString(36)}`;
const DATA_PATH = "docs/audits/s55-render-forensics-data.json";
const WAV_SEC = 4; // the §B sine stand-ins
const BLEND_SEC = 0.5; // the default seam (fade) the §B render ran with

// Byte-identical to the S47/S51/S54 audition anchors — comparability is the point.
const NOVA_ANCHOR =
  "nova: late-20s presenter, short silver hair, sharp green eyes, dark green flight jacket, small silver ear stud";
const NOVA_SCENES = [
  {
    index: 1, title: "Rooftop",
    narration: "Every forecast starts somewhere high, dry, and windy — tonight, that's Nova's rooftop station.",
    visual: "host presenting beside a small rooftop weather station at dusk, city skyline behind",
    camera: "push-in", mood: "dusk skyline, cool blues with warm rim light", caption: "the station",
    hostInScene: true, rehook: false, sfx: "none",
  },
  {
    index: 2, title: "Street",
    narration: "And when the radar says run, Nova runs — umbrella first, questions second.",
    visual: "host walking a rain-slick street under a dark umbrella, streetlights reflecting on asphalt",
    camera: "pan-right", mood: "night rain, glossy reflections", caption: "the run",
    hostInScene: true, rehook: true, sfx: "whoosh",
  },
  {
    index: 3, title: "Wrap",
    narration: "By sunset the front has passed, and the park gets the calm Nova promised at the top of the show.",
    visual: "host standing in a calm park at golden hour, relaxed, closing the segment",
    camera: "pull-out", mood: "golden hour warmth, soft haze", caption: "the calm",
    hostInScene: true, rehook: false, sfx: "none",
  },
];

const sha16 = (buf: Buffer | null) =>
  buf ? crypto.createHash("sha256").update(buf).digest("hex").slice(0, 16) : "";

// ---------- ffmpeg measurement helpers ----------

interface FreezeRun { start: number; duration: number; end: number; }

/** freezedetect at an arbitrary minimum duration d. CAUTION on the parse:
 * this ffmpeg build prints the three fields ONE PER LINE
 * (lavfi.freezedetect.freeze_start / _duration / _end), so the parser
 * accumulates a triple across lines — a same-line regex silently eats
 * every event (the bug the first forensic run shipped; found by diffing
 * against the battery's own parse on the preserved artifact). */
async function freezeDetect(file: string, d: number): Promise<FreezeRun[]> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file,
       "-vf", `freezedetect=n=0.004:d=${d.toFixed(2)}`,
       "-an", "-f", "null", "-"],
      { timeout: 8 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
    );
    const out: FreezeRun[] = [];
    let cur: Partial<FreezeRun> = {};
    const flush = (): void => {
      if (cur.start !== undefined && cur.duration !== undefined && cur.end !== undefined) {
        out.push({ start: cur.start, duration: cur.duration, end: cur.end });
      }
      cur = {};
    };
    for (const line of stderr.toString().split("\n")) {
      const s = /freeze_start:\s*([\d.]+)/.exec(line);
      const du = /freeze_duration:\s*([\d.]+)/.exec(line);
      const e = /freeze_end:\s*([\d.]+)/.exec(line);
      // freeze_start opens a new event; duration/end complete it.
      if (s) { flush(); cur.start = Number(s[1]); continue; }
      if (du && cur.start !== undefined) { cur.duration = Number(du[1]); continue; }
      if (e && cur.start !== undefined) { cur.end = Number(e[1]); flush(); }
    }
    flush();
    return out;
  } catch {
    return [];
  }
}

/** Scene-change detection at an arbitrary threshold (the lens's 0.40 plus a
 * near-miss view at 0.20). Same select/showinfo shape the lens itself runs. */
async function sceneCutsAt(file: string, th: number): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file,
       "-vf", `select=gt(scene\\,${th.toFixed(2)}),showinfo`,
       "-an", "-f", "null", "-"],
      { timeout: 8 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
    );
    return parseSceneCuts(stderr.toString());
  } catch {
    return [];
  }
}

/** Per-frame mean |frame − prev frame| (0..255 luma units) via
 * tblend=difference + signalstats — the motion profile of the whole file. */
async function motionProfile(file: string): Promise<number[]> {
  try {
    const { stderr } = await execFileAsync(
      "ffmpeg",
      ["-hide_banner", "-nostats", "-i", file,
       "-vf", "tblend=all_mode=difference,signalstats,metadata=print",
       "-an", "-f", "null", "-"],
      { timeout: 8 * 60 * 1000, maxBuffer: 64 * 1024 * 1024 }
    );
    return parseYavgLog(stderr.toString());
  } catch {
    return [];
  }
}

const fmt1 = (n: number) => n.toFixed(1);
const fmt2 = (n: number) => n.toFixed(2);

// ---------- main ----------

const EMAIL = `s55-forensics-${SUFFIX}@e2e.local`;
const passwordHash = await hashPassword("probe-password-123");
const user = await prisma.user.create({ data: { email: EMAIL, passwordHash, name: "s55 render forensics" } });
const org = await prisma.organization.create({
  data: { name: "s55 render forensics org", slug: `s55-forensics-${SUFFIX}`, memberships: { create: { userId: user.id, role: "owner" } } },
});
const videoIds: string[] = [];

try {
  await withCtx({ userId: user.id, organizationId: org.id, role: "owner" }, async () => {
    await saveCapability("chat", { provider: "zai", model: "glm-4.6" });

    // 1) The §B anchor, verbatim: character → portrait → plan → paints.
    const nova = await prisma.character.create({
      data: {
        organizationId: org.id,
        name: "Nova",
        role: "host",
        appearance: "late-20s presenter, short silver hair, dark green flight jacket",
        identityAnchor: NOVA_ANCHOR,
        voice: "jam",
        isActive: true,
      },
    });
    const video = await prisma.video.create({
      data: {
        organizationId: org.id,
        topic: "Nova's field guide to city weather",
        niche: "weather",
        tone: "warm",
        title: "S55 render forensics — anchor",
        format: "story",
        characterId: nova.id,
        scenes: JSON.stringify(NOVA_SCENES),
      },
    });
    videoIds.push(video.id);

    await runPortraitJob(nova.id);
    const novaPortrait = await readPortrait(nova.id);
    console.info(`portrait: ${novaPortrait?.length ?? 0} bytes`);

    await runDirectorPass(video.id, { profile: "narrative" });
    await setDirectorState(video.id, "approved");
    const videoRow = await prisma.video.findUnique({ where: { id: video.id } });
    const approvedPlan = parsePlan(videoRow?.shotList ?? null);
    if (!approvedPlan) throw new Error("no approved plan — cannot run the anchor render");
    console.info(`plan: ${approvedPlan.scenes.length} scenes, ${approvedPlan.scenes.reduce((a, s) => a + s.shots.length, 0)} shots total`);
    for (const sc of approvedPlan.scenes) {
      console.info(`  scene ${sc.sceneIndex}: shots=${sc.shots.length} [${sc.shots.map((sh) => `${sh.duration}s ${sh.camera ?? "?"}${sh.transitionOut ? ` →${sh.transitionOut}` : ""}`).join(" | ")}]`);
    }

    const novaForPaint = {
      id: nova.id, name: nova.name, identityAnchor: nova.identityAnchor, appearance: nova.appearance,
    };
    const sceneRows: { index: number; sha16: string }[] = [];
    for (const scene of parseScenes(JSON.stringify(NOVA_SCENES))) {
      await generateSceneImage({ videoId: video.id, scene, character: novaForPaint });
      const buf = await storage.get(`${video.id}/${sceneImageFile(scene.index)}`).catch(() => null);
      console.info(`paint scene ${scene.index}: ${buf?.length ?? 0} bytes (sha16 ${sha16(buf)})`);
      sceneRows.push({ index: scene.index, sha16: sha16(buf) });
    }

    // 2) Narration stand-ins — 4s tones, the §B shape.
    for (let i = 1; i <= NOVA_SCENES.length; i++) {
      const wav = path.join("uploads", video.id, sceneWavFile(i));
      fs.mkdirSync(path.dirname(wav), { recursive: true });
      await execFileAsync("ffmpeg", [
        "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", "sine=frequency=196:duration=4",
        "-af", "volume=-26dB", "-ar", "44100", "-ac", "1",
        wav,
      ], { timeout: 60_000 });
    }

    // 3) The render — §B params verbatim.
    const t0 = Date.now();
    const result = await renderVideo({
      videoId: video.id,
      scenes: parseScenes(JSON.stringify(NOVA_SCENES)),
      mode: "kenburns",
      burnSubtitles: false,
      smartCaptions: false,
      music: false,
      sfx: false,
      aspectRatio: "16:9",
      frameRate: 30,
      motionContext: { tone: "warm", niche: "weather" },
      onProgress: (cur, total, label) => console.info(`  render ${cur}/${total}: ${label}`),
    });
    console.info(`render: ${((Date.now() - t0) / 1000).toFixed(0)}s · ${result.durationSec}s · ${result.fileBytes} bytes`);
    console.info(`expectedCuts: ${JSON.stringify(result.expectedCuts)}`);
    console.info(`liveliness: ${result.liveliness.map((l) => l.channel).join(", ")}`);

    // 4) The QC battery, structural lenses only (no S53 scans here — the
    // gateway budget is for the render; the two failures under investigation
    // are structural). Subject/text read "unmeasured" by design.
    const finalPath = path.join("uploads", video.id, "final.mp4");
    const report = await runQcReport({
      mp4Path: finalPath,
      videoDuration: result.durationSec,
      narrationSec: 3 * WAV_SEC,
      srtPath: null,
      shotPlan: approvedPlan,
      expectedCuts: result.expectedCuts ?? null,
      expectedBlack: result.blackWindows,
      frameRate: 30,
    });
    console.info("\nQC battery (structural focus):");
    for (const c of report.checks) {
      console.info(`  ${c.id.padEnd(22)} ${c.status.padEnd(10)} ${c.value}`);
    }

    // 5) Timeline reconstruction — per-scene segments and the blended clock,
    //    exactly the render's own math (wav + lead + tail, 0.5s fades).
    const segSec = Math.max(R_MIN_SEG_SEC, WAV_SEC + R_LEAD_SEC + R_TAIL_SEC);
    const durations = NOVA_SCENES.map(() => segSec);
    const boundary = NOVA_SCENES.slice(0, -1).map(() => ({ style: "fade" as const, durationSec: BLEND_SEC }));
    const offsets = transitionOffsetsMulti(durations, boundary);
    // Scene k's local 0 on the blended clock: scene 0 at 0; scene k at the
    // accumulated xfade offset (output = offset + local, xfade semantics).
    const sceneStart = [0, ...offsets];
    console.info(`\ntimeline: segments ${durations.join("+")} · blended offsets ${offsets.map(fmt1).join(", ")} · total ${fmt1(durations.reduce((a, b) => a + b, 0) - boundary.length * BLEND_SEC)} (render says ${fmt1(result.durationSec)})`);

    // Per-scene shot executions (the same pure builder the render ran).
    const shotTables = approvedPlan.scenes.map((planScene) => {
      const scene = parseScenes(JSON.stringify(NOVA_SCENES)).find((s) => s.index === planScene.sceneIndex)!;
      const sp = buildSceneShots({ scene, planScene, measuredSec: segSec });
      return sp;
    });
    console.info("\nshot graph per scene (buildSceneShots, measuredSec=" + segSec + "):");
    const flipTimes: number[] = [];
    shotTables.forEach((sp, k) => {
      const parts: string[] = [];
      for (const sh of sp.available) {
        parts.push(`#${sh.shotIndex} ${sh.moveKind} ${fmt1(sh.sec)}s ${sh.source}${sh.crop ? " (crop)" : ""}${sh.transitionOut === "fade" ? " →fade" : ""}`);
      }
      // Intra-scene flip times on the blended clock, using the FITTED
      // allocation multiShotSceneGraph executes (fitFrames scales shot secs
      // proportionally to the segment): flip = sceneStart_k + segSec ×
      // (cumulativeRaw / sumRaw). Raw cumulative times are WRONG whenever
      // the planned total ≠ the segment length (extend-only plans, stretched
      // plans — both directions), by up to a second on the anchor.
      const raw = sp.available.map((s) => s.sec);
      const sum = raw.reduce((a, b) => a + b, 0) || 1;
      let cum = 0;
      for (let i = 0; i + 1 < sp.available.length; i++) {
        cum += raw[i];
        flipTimes.push(sceneStart[k] + segSec * (cum / sum));
      }
      console.info(`  scene ${sp.sceneIndex}: ${parts.join(" | ")}`);
    });
    console.info(`computed intra-scene flip times (blended clock): ${flipTimes.map(fmt2).join(", ")}`);

    // 6) The forensics passes on the real file.
    const freezes100 = await freezeDetect(finalPath, 1.00);
    const freezes050 = await freezeDetect(finalPath, 0.50);
    const sc40 = await detectSceneCuts(finalPath);
    const cuts40 = sc40.cuts; // {cuts, measured} — the ARRAY feeds alignCuts
    const cuts20 = await sceneCutsAt(finalPath, 0.20);
    const profile = await motionProfile(finalPath);
    const aligned = alignCuts(cuts40, result.expectedCuts ?? { cuts: [], windows: [] }, CUT_TOL_SEC);

    console.info(`\nfreezedetect d=1.00 (the lens): ${freezes100.length} run(s)`);
    for (const f of freezes100) {
      console.info(`  freeze ${fmt2(f.start)}s → ${fmt2(f.end)}s (${fmt2(f.duration)}s)`);
    }
    console.info(`freezedetect d=0.50 (calibration view): ${freezes050.length} run(s)`);
    for (const f of freezes050.slice(0, 12)) {
      console.info(`  freeze ${fmt2(f.start)}s → ${fmt2(f.end)}s (${fmt2(f.duration)}s)`);
    }
    console.info(`scene cuts @0.40 (the lens, measured=${sc40.measured}): ${cuts40.map(fmt2).join(", ") || "none"}`);
    console.info(`scene cuts @0.20 (near-miss view): ${cuts20.map(fmt2).join(", ") || "none"}`);
    console.info(`alignCuts vs the booked expectation: unexpected=${aligned.unexpected.map(fmt2).join(", ") || "none"} · missing=${aligned.missing.map(fmt2).join(", ") || "none"}`);

    if (profile.length > 0) {
      const sorted = [...profile].sort((a, b) => a - b);
      const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
      console.info(`\nmotion profile (mean |Δframe|, luma units): frames=${profile.length} · p10=${fmt2(p(0.1))} · p50=${fmt2(p(0.5))} · p90=${fmt2(p(0.9))} · max=${fmt2(sorted[sorted.length - 1])}`);
      for (const f of freezes100) {
        const i0 = Math.max(0, Math.floor(f.start * 30));
        const i1 = Math.min(profile.length - 1, Math.floor(f.end * 30));
        const inside = profile.slice(i0, i1 + 1);
        if (inside.length) {
          const mx = Math.max(...inside);
          console.info(`  inside freeze ${fmt2(f.start)}–${fmt2(f.end)}: mean=${fmt2(inside.reduce((a, b) => a + b, 0) / inside.length)} max=${fmt2(mx)} (freezedetect noise floor ≈ ${fmt2(0.004 * 255)} luma units)`);
        }
      }
    }

    // 7) Raw evidence → the repo-local data twin. Written IMMEDIATELY (a
    //    crash in the derived correlation below must not lose the raw
    //    measurements), then rewritten with the correlation appended.
    const evidence = {
      recorded: new Date().toISOString(),
      commit: process.env.S55_COMMIT ?? null,
      anchorScenes: NOVA_SCENES,
      planRaw: videoRow?.shotList ?? null,
      planParsed: approvedPlan,
      render: {
        durationSec: result.durationSec, fileBytes: result.fileBytes,
        expectedCuts: result.expectedCuts ?? null, blackWindows: result.blackWindows ?? null,
        liveliness: result.liveliness,
      },
      timeline: { segSec, durations, offsets, sceneStart, flipTimes },
      shotTables,
      qcChecks: report.checks.map((c) => ({ id: c.id, status: c.status, value: c.value, detail: c.detail })),
      freezes100, freezes050, cuts40, cuts20,
      aligned,
      motionProfileStats: profile.length
        ? {
            frames: profile.length,
            p10: [...profile].sort((a, b) => a - b)[Math.floor(0.1 * profile.length)],
            p50: [...profile].sort((a, b) => a - b)[Math.floor(0.5 * profile.length)],
            p90: [...profile].sort((a, b) => a - b)[Math.floor(0.9 * profile.length)],
          }
        : null,
      sceneRows,
    };
    const writeEvidence = (extra: Record<string, unknown>) => {
      fs.writeFileSync(DATA_PATH, JSON.stringify({ ...evidence, ...extra }, null, 1));
    };
    writeEvidence({});

    // Evidence copy OUTSIDE uploads/ — the teardown below deletes the video
    // dir; /tmp/s55-evidence keeps the artifacts for the fix sprint.
    fs.mkdirSync("/tmp/s55-evidence", { recursive: true });
    fs.copyFileSync(finalPath, "/tmp/s55-evidence/final.mp4");
    for (const r of sceneRows) {
      fs.copyFileSync(path.join("uploads", video.id, sceneImageFile(r.index)), `/tmp/s55-evidence/scene-${r.index}.png`);
    }
    console.info(`evidence artifacts copied: /tmp/s55-evidence/`);

    // 8) Correlation — each lens-detected cut vs windows and flips.
    console.info("\ncut correlation (lens threshold 0.40):");
    for (const t of cuts40) {
      const winD = (result.expectedCuts?.windows ?? []).map(([lo, hi]) => ({ d: t < lo - 0.6 ? lo - t : t > hi + 0.6 ? t - hi : 0, lo, hi })).sort((a, b) => a.d - b.d)[0];
      const flipD = flipTimes.map((ft) => ({ ft, d: Math.abs(t - ft) })).sort((a, b) => a.d - b.d)[0];
      const verdict = winD && winD.d === 0 ? "booked blend window"
        : flipD && flipD.d <= 0.6 ? `intra-scene shot flip (Δ${fmt2(flipD.d)}s)`
        : "unexplained";
      console.info(`  cut @${fmt2(t)}s → ${verdict}`);
    }
    console.info("\nfreeze correlation (which scene/shot):");
    for (const f of freezes100) {
      const k = sceneStart.reduce((acc, s, i) => (f.start >= s ? i : acc), 0);
      const sp = shotTables[k];
      let c = 0; let shot = sp?.available[0];
      for (const sh of sp?.available ?? []) { if (f.start - sceneStart[k] >= c) shot = sh; c += sh.sec; }
      console.info(`  freeze ${fmt2(f.start)}–${fmt2(f.end)} → scene ${sp?.sceneIndex ?? k + 1} shot #${shot?.shotIndex ?? "?"} (${shot?.moveKind ?? "?"} ${fmt1(shot?.sec ?? 0)}s ${shot?.source ?? "?"})`);
    }

    // 9) The derived correlation, persisted on top of the raw evidence.
    writeEvidence({
      correlation: {
        cutVerdicts: cuts40.map((t) => {
          const winD = (result.expectedCuts?.windows ?? []).map(([lo, hi]) => ({ d: t < lo - 0.6 ? lo - t : t > hi + 0.6 ? t - hi : 0, lo, hi })).sort((a, b) => a.d - b.d)[0];
          const flipD = flipTimes.map((ft) => ({ ft, d: Math.abs(t - ft) })).sort((a, b) => a.d - b.d)[0];
          const verdict = winD && winD.d === 0 ? "booked blend window"
            : flipD && flipD.d <= 0.6 ? `intra-scene shot flip (Δ${fmt2(flipD.d)}s)`
            : "unexplained";
          return { t, verdict, nearestFlip: flipD ?? null, nearestWindow: winD ?? null };
        }),
        freezeShots: freezes100.map((f) => {
          const k = sceneStart.reduce((acc, s, i) => (f.start >= s ? i : acc), 0);
          const sp = shotTables[k];
          let c = 0; let shot = sp?.available[0];
          for (const sh of sp?.available ?? []) { if (f.start - sceneStart[k] >= c) shot = sh; c += sh.sec; }
          return { ...f, sceneIndex: sp?.sceneIndex ?? k + 1, shot: shot ? { shotIndex: shot.shotIndex, moveKind: shot.moveKind, sec: shot.sec, source: shot.source, transitionOut: shot.transitionOut ?? null } : null };
        }),
      },
    });
    console.info(`\nevidence written: ${DATA_PATH}`);
  });
} finally {
  // ---------- teardown (§B pattern) ----------
  await new Promise((r) => setTimeout(r, 1500));
  for (const id of videoIds) {
    await prisma.activity.deleteMany({ where: { videoId: id } }).catch(() => {});
    await prisma.characterAppearance.deleteMany({ where: { videoId: id } }).catch(() => {});
    await prisma.video.delete({ where: { id } }).catch(() => {});
    fs.rmSync(`uploads/${id}`, { recursive: true, force: true });
  }
  await prisma.character.deleteMany({ where: { organizationId: org.id } }).catch(() => {});
  await prisma.usageRecord.deleteMany({ where: { userId: user.id } }).catch(() => {});
  await prisma.organization.delete({ where: { id: org.id } }).catch(() => {});
  await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
  await prisma.$disconnect();
}
console.info("\nS55 render forensics COMPLETE");
