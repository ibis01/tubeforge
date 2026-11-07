// S55 T-55.4 — the dense-QC evidence probe (LOCAL ONLY, zero gateway spend).
//
// The audit's core safety point: the S49 L4 scan sampled 8 frames evenly —
// a 60s render carried a 7.5s mean gap, so a brief violation between frames
// read "pass". This probe measures the dense rewrite's three stages:
//
//   stage 1  dense grid    — planDenseGrid + extractDenseGrid on a fresh
//                            1080p 20s lavfi render (the §B stand-in
//                            lineage: testsrc2 + sine), extraction timed.
//   stage 2  face tripwire — runFaceTripwire over the extracted grid:
//                            availability, cv2 version, timing, hits.
//                            Expect 0 hits on testsrc2 (the false-positive
//                            control) and ≥1 hit on skimage's astronaut
//                            sample (a NASA portrait riding BSD-licensed
//                            sample data — the positive control, a real
//                            face with no network fetch and no repo fixture).
//   stage 3  coverage math — selectVlmFrames for 20/60/120/300/600s:
//                            judged frames, VLM batches, mean judged gap vs
//                            the S49 8-frame gap — the number that proves
//                            the audit's point is closed.
//
// The VLM stage is deliberately NOT run (no gateway spend in probes; the
// probe-hygiene law). Its machinery is unit-pinned (batch aggregation,
// selection, label mapping) and its end-to-end verdict lands in T-55.5's
// acceptance render.
//
// Evidence → docs/audits/s55-dense-qc-data.json (S55_PROBE_DATA override).
// Teardown: temp dirs removed; nothing touches the DB or the gateway.
//
// Usage: node --import tsx scripts/s55-dense-qc-probe.mts

import { execFile } from "child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "util";
import {
  planDenseGrid,
  selectVlmFrames,
  extractDenseGrid,
  runFaceTripwire,
  RESTRICTED_FACE_MIN_AREA_FRAC,
  RESTRICTED_VLM_BATCH,
  RESTRICTED_VLM_MAX_FRAMES,
  FACE_TRIPWIRE_PY,
} from "../src/lib/tubeforge/restricted-subjects";

const execFileAsync = promisify(execFile);
const DATA_PATH = process.env.S55_PROBE_DATA ?? "docs/audits/s55-dense-qc-data.json";
const RENDER_SEC = 20; // the §B anchor's duration class

async function wall<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const t0 = Date.now();
  const value = await fn();
  return { ms: Date.now() - t0, value, label };
}

async function main() {
  const commit = process.env.S55_COMMIT ?? (await execFileAsync("git", ["rev-parse", "--short", "HEAD"])).stdout.toString().trim();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-s55-dense-"));
  const out: Record<string, unknown> = {
    probe: "s55-dense-qc",
    task: "T-55.4",
    commit,
    ranAt: new Date().toISOString(),
    gatewaySpend: "none (local stages only; the VLM stage is T-55.5's acceptance)",
  };

  try {
    // ---- stage 1: a fresh §B-conditions-class render + the dense grid ----
    const mp4 = path.join(tmp, "probe.mp4");
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", `testsrc2=size=1920x1080:rate=30:duration=${RENDER_SEC}`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${RENDER_SEC}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "96k", "-shortest",
      mp4,
    ]);
    const plan = planDenseGrid(RENDER_SEC);
    const framesDir = path.join(tmp, "frames");
    await fsp.mkdir(framesDir);
    const extract = await wall("extractDenseGrid", () => extractDenseGrid(mp4, framesDir, plan.fps, plan.count));
    const jpegs = (await fsp.readdir(framesDir)).filter((f) => f.endsWith(".jpg")).sort();
    const sizes = await Promise.all(jpegs.map((f) => fsp.stat(path.join(framesDir, f)).then((s) => s.size)));
    const meanSize = sizes.length ? Math.round(sizes.reduce((a, b) => a + b, 0) / sizes.length) : 0;
    out.stage1 = {
      render: `lavfi testsrc2 1920x1080 ${RENDER_SEC}s (the §B stand-in lineage)`,
      plan,
      extracted: extract.value,
      extractMs: extract.ms,
      jpegBytes: { min: Math.min(...sizes), mean: meanSize, max: Math.max(...sizes) },
      intervalSec: Number((1 / plan.fps).toFixed(4)),
    };

    // ---- stage 2a: the false-positive control (testsrc2 carries no faces) ----
    const scriptPath = path.join(tmp, "tripwire.py");
    await fsp.writeFile(scriptPath, FACE_TRIPWIRE_PY);
    const fp = await wall("runFaceTripwire(testsrc2 grid)", () =>
      runFaceTripwire(scriptPath, framesDir, RESTRICTED_FACE_MIN_AREA_FRAC));
    out.stage2_falsePositiveControl = {
      source: "the extracted testsrc2 grid — no faces anywhere in it",
      available: fp.value.available,
      cv2: fp.value.cv2,
      scanned: fp.value.scanned,
      hits: fp.value.hits,
      expect: "0 hits",
      pass: fp.value.available && fp.value.hits.length === 0,
      wallMs: fp.ms,
    };

    // ---- stage 2b: the positive control (a real face must trip it) ----
    // skimage's astronaut sample: a NASA portrait shipped as BSD-licensed
    // sample data — a genuine human face, no network, no repo fixture.
    const astroSrc = (
      await execFileAsync("python3", [
        "-c",
        "import os, skimage; print(os.path.join(os.path.dirname(skimage.__file__), 'data', 'astronaut.png'))",
      ])
    ).stdout.toString().trim();
    const faceDir = path.join(tmp, "face");
    await fsp.mkdir(faceDir);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-i", astroSrc,
      "-vf", "scale=1280:-2",
      "-q:v", "3",
      path.join(faceDir, "f0001.jpg"),
    ]);
    // A solid frame beside it: the control must hit EXACTLY the face frame.
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "color=c=0x3a5a40:size=1280x720", "-frames:v", "1",
      path.join(faceDir, "f0002.jpg"),
    ]);
    const pos = await wall("runFaceTripwire(face control)", () =>
      runFaceTripwire(scriptPath, faceDir, RESTRICTED_FACE_MIN_AREA_FRAC));
    out.stage2_positiveControl = {
      source: "skimage.data.astronaut (NASA portrait, BSD-licensed sample) + one solid frame",
      available: pos.value.available,
      cv2: pos.value.cv2,
      scanned: pos.value.scanned,
      hits: pos.value.hits,
      expect: "exactly 1 hit, index 0, areaFrac >= 0.015",
      pass: pos.value.available && pos.value.hits.length === 1 && pos.value.hits[0]?.index === 0 && pos.value.hits[0].areaFrac >= RESTRICTED_FACE_MIN_AREA_FRAC,
      wallMs: pos.ms,
    };

    // ---- stage 3: the coverage table (the number that closes the audit) ----
    const durations = [20, 60, 120, 300, 600];
    out.stage3_coverage = durations.map((dur) => {
      const p = planDenseGrid(dur);
      const judged = selectVlmFrames(p.count, []);
      const forcedSim = [Math.floor(p.count * 0.3), Math.floor(p.count * 0.5), Math.floor(p.count * 0.7)];
      const judgedForced = selectVlmFrames(p.count, forcedSim);
      return {
        durationSec: dur,
        s49_frames: 8,
        s49_meanGapSec: Number((dur / 8).toFixed(2)),
        grid: { count: p.count, intervalSec: Number((1 / p.fps).toFixed(3)) },
        s55: {
          vlmMax: RESTRICTED_VLM_MAX_FRAMES,
          judgedFrames: judged.length,
          batches: Math.ceil(judged.length / RESTRICTED_VLM_BATCH),
          meanJudgedGapSec: Number((dur / judged.length).toFixed(2)),
          withThreeSimulatedFaceAnchors: {
            judgedFrames: judgedForced.length,
            forcedSeatsKept: forcedSim.every((i) => judgedForced.includes(i)),
            batches: Math.ceil(judgedForced.length / RESTRICTED_VLM_BATCH),
          },
        },
      };
    });

    // ---- the verdict ----
    const controlsOk = out.stage2_falsePositiveControl.pass === true && out.stage2_positiveControl.pass === true;
    out.verdict = {
      controlsOk,
      summary:
        `dense grid ${extract.value} frames @${(1 / plan.fps).toFixed(2)}s on the ${RENDER_SEC}s §B-class render ` +
        `(S49 saw 8 frames @${(RENDER_SEC / 8).toFixed(2)}s); the 60s class judges ${RESTRICTED_VLM_MAX_FRAMES} frames ` +
        `@${(60 / RESTRICTED_VLM_MAX_FRAMES).toFixed(2)}s mean gap vs S49's 7.50s; ` +
        `face tripwire ${controlsOk ? "validated both directions" : "NOT validated — see controls"}.`,
    };

    await fsp.writeFile(DATA_PATH, JSON.stringify(out, null, 2) + "\n");
    console.info(JSON.stringify(out, null, 2));
    console.info(`evidence → ${DATA_PATH}`);
    if (!controlsOk) {
      console.error("CONTROL FAILURE — the tripwire did not validate both directions");
      process.exitCode = 1;
    }
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(1);
});
