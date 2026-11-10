// S76 — the REAL-TTS Whiteboard smoke (the readiness report's honesty caveat).
//
// E10 proved the engine with SYNTHETIC narration-slot audio (the gateway was
// 429). This smoke closes that caveat: the SAME voFiles seam, fed by REAL
// ttsSynthesize() calls through the budget module's aiCall (house 429/backoff
// handling, spend reservation). 2 scenes, 16:9, no music bed — narration only.
//
// Receipts printed: active TTS provider/model, per-scene synthesis latency +
// bytes + probed ms, render time, output size/duration, audio-stream presence,
// mean volume (silence detector), the engine's scene-tail law deltas
// (rendered = voMs + 350 ± 1 frame), frame-sum integrity, QC pass/total.
//
// Exit codes: 0 PASS · 1 FAIL (receipts say why) · 2 plan invalid · 3 TTS
// pool blocked (429-class; defer to the next cycle — never hammer).
//
// Artifacts: validation/s76/tts-smoke/ (gitignored by size).

import { execFile } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";

import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { renderWhiteboard, probeDurationSec } from "../src/lib/tubeforge/whiteboard/render";
import { aiCall } from "../src/lib/tubeforge/budget";
import { ttsSynthesize } from "../src/lib/tubeforge/providers/tts";
import { getCapability } from "../src/lib/tubeforge/providers/settings";
import { runQcReport } from "../src/lib/tubeforge/qc";

const execFileP = promisify(execFile);
const OUT_DIR = "validation/s76/tts-smoke";

// Two scenes lifted from the E10 battery's 16:9 project (assets exist in the
// house library; cameras exercise the pan/zoom path). Narration is REAL
// speech this time — the only delta from E10's synthetic slots.
const PROJECT = {
  title: "How Your Heart Works — S76 real-TTS smoke",
  width: 1920,
  height: 1080,
  fps: 24,
  hand: { style: "marker", scale: 1 },
  scenes: [
    {
      id: "title",
      narration:
        "Your heart beats about a hundred thousand times every single day, pushing blood to every corner of your body. So how does this fist-sized muscle actually work? Let's draw it.",
      background: "#ffffff",
      placements: [
        { assetId: "title-hero", placement: { x: 560, y: 180, scale: 1.15, rotateDeg: 0 } },
        { assetId: "heart-main", placement: { x: 1080, y: 470, scale: 2.1, rotateDeg: 0 }, order: 2 },
      ],
      animations: [],
      camera: [
        { startMs: 0, durationMs: 0, cx: 960, cy: 540, scale: 1 },
        { startMs: 300, durationMs: 10200, cx: 1180, cy: 620, scale: 1.14 },
      ],
    },
    {
      id: "chambers",
      narration:
        "Picture the heart as a pump with four hollow chambers — two on the right, two on the left. A wall down the middle, the septum, keeps the two sides completely separate.",
      background: "#ffffff",
      placements: [
        { assetId: "heart-main", placement: { x: 700, y: 300, scale: 2.6, rotateDeg: 0 } },
        { assetId: "heart-labels", placement: { x: 700, y: 300, scale: 2.6, rotateDeg: 0 }, order: 2 },
      ],
      animations: [],
      camera: [
        { startMs: 0, durationMs: 0, cx: 960, cy: 540, scale: 1 },
        { startMs: 800, durationMs: 9200, cx: 940, cy: 560, scale: 1.22 },
      ],
    },
  ],
} as const;

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  sample_rate?: string;
  nb_frames?: string;
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string };
}

async function ffprobeJson(file: string): Promise<ProbeResult> {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_format", "-show_streams", file,
  ]);
  return JSON.parse(stdout);
}

async function meanVolumeDb(file: string): Promise<number | null> {
  try {
    const { stderr } = await execFileP("ffmpeg", [
      "-hide_banner", "-i", file, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
    ]);
    const m = stderr.match(/mean_volume:\s*(-?[\d.]+)\s*dB/);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
}

async function main() {
  fs.mkdirSync(path.join(OUT_DIR, "vo"), { recursive: true });
  const lib = await loadLibrary();
  const { project: valid, errors } = validateWhiteboardProject(
    JSON.parse(JSON.stringify(PROJECT)),
    lib.libraryIndex,
  );
  if (errors.length) {
    console.log(`S76-TTS-SMOKE: FAIL — plan invalid: ${errors.join("; ")}`);
    process.exit(2);
  }

  // 1. REAL TTS through the budget module (reserve + withRetry + cool-down).
  const cap = await getCapability("tts");
  console.log(`[tts] active provider=${cap.provider} model=${cap.model || "(default)"} voice=jam speed=1.0`);
  const voFiles = new Map<string, { path: string; ms: number; bytes: number; latencyMs: number }>();
  for (const scene of valid.scenes) {
    const outPath = path.join(OUT_DIR, "vo", `scene-${scene.id}.wav`);
    let buf: Buffer;
    const t0 = Date.now();
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 44) {
      buf = fs.readFileSync(outPath); // idempotent re-runs: zero TTS calls
      console.log(`[tts] ${scene.id}: REUSED ${buf.length} bytes from the first pass`);
    } else {
      try {
        buf = await aiCall(
          "tts",
          `s76 real-tts [${scene.id}]`,
          () => ttsSynthesize({ input: scene.narration, voice: "jam", speed: 1 }),
          { attempts: 2 },
        );
      } catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 200);
        console.log(`S76-TTS-SMOKE: BLOCKED — TTS pool refused after house retries: ${msg}`);
        console.log("       defer to the next cycle; no hammering (S54 discipline).");
        process.exit(3);
      }
      fs.writeFileSync(outPath, buf);
    }
    const probed = await probeDurationSec(outPath);
    const ms = probed !== null ? Math.round(probed * 1000) : 0;
    voFiles.set(scene.id, { path: outPath, ms, bytes: buf.length, latencyMs: Date.now() - t0 });
    console.log(`[tts] ${scene.id}: ${buf.length} bytes, ${ms} ms audio, ${Date.now() - t0} ms wall`);
  }

  // 2. Render through the REAL engine with the REAL vo files.
  const voMap = new Map([...voFiles.entries()].map(([id, v]) => [id, v.path]));
  const t0 = Date.now();
  const r = await renderWhiteboard(valid, {
    outDir: OUT_DIR,
    voFiles: voMap,
    onProgress: (label, frac) => {
      if (Math.round(frac * 100) % 25 === 0) console.log(`  [render] ${Math.round(frac * 100)}% ${label}`);
    },
  });
  const renderMs = Date.now() - t0;
  console.log(`[render] done in ${(renderMs / 1000).toFixed(1)}s → ${r.file} (${fs.statSync(r.file).size} bytes)`);

  // 3. Technical receipts.
  const probe = await ffprobeJson(r.file);
  const audio = (probe.streams ?? []).find((s) => s.codec_type === "audio");
  const durSec = Number(probe.format?.duration ?? 0);
  const nbFrames = Number(probe.streams?.find((s) => s.codec_type === "video")?.nb_frames ?? 0);
  const vol = await meanVolumeDb(r.file);

  // 4. The engine's tail law: rendered scene ms = vo ms + 350 ± 1 frame.
  const frameMs = 1000 / valid.fps;
  const tailRows = valid.scenes.map((s, i) => {
    const renderedMs = Math.round((r.scenes[i].frames / valid.fps) * 1000);
    const voMs = voFiles.get(s.id)?.ms ?? 0;
    const delta = renderedMs - voMs - 350;
    return { id: s.id, renderedMs, voMs, delta, pass: Math.abs(delta) <= frameMs + 1 };
  });

  // 5. QC report with the rendered-window SRT (cut lens blind by modality —
  //    expectedCuts null, per the E10 16:9 receipt).
  let cursorFrames = 0;
  const srt = valid.scenes.map((s, i) => {
    const startMs = Math.round((cursorFrames / valid.fps) * 1000);
    cursorFrames += r.scenes[i].frames;
    const endMs = Math.round((cursorFrames / valid.fps) * 1000) - 1;
    const f = (ms: number) =>
      `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
    return `${i + 1}\n${f(startMs)} --> ${f(endMs)}\n${s.narration}\n`;
  });
  const srtPath = path.join(OUT_DIR, "scenes.srt");
  fs.writeFileSync(srtPath, srt.join("\n"));
  const qc = await runQcReport({
    mp4Path: r.file,
    videoDuration: durSec,
    narrationSec: null,
    srtPath,
    expectedAspect: "16:9",
    expectedCuts: null,
  }).catch((e) => ({ error: String(e) }));
  const qcChecks = qc as { checks?: { id?: string; status?: string }[] };
  const checks = Array.isArray(qcChecks?.checks) ? qcChecks.checks : [];
  const qcPass = checks.filter((c) => c.status === "pass").length;
  const qcFail = checks.filter((c) => c.status === "fail");
  const failedIds = qcFail.map((c) => c.id).join(",");

  // 6. Verdict.
  const audioOk = Boolean(audio);
  const volOk = vol !== null && vol > -60;
  const framesOk = nbFrames === r.scenes.reduce((a, s) => a + s.frames, 0);
  const tailOk = tailRows.every((t) => t.pass);
  const qcOk = checks.length > 0 && qcFail.length === 0;
  const pass = audioOk && volOk && framesOk && tailOk && qcOk;

  console.log("\n===== S76 REAL-TTS SMOKE RECEIPT =====");
  console.log(`provider:        ${cap.provider} (model ${cap.model || "default"})`);
  for (const [id, v] of voFiles) console.log(`tts ${id}:        ${v.bytes} B · ${v.ms} ms · ${v.latencyMs} ms wall`);
  console.log(`render:          ${(renderMs / 1000).toFixed(1)}s · ${fs.statSync(r.file).size} B · ${durSec.toFixed(2)}s · ${nbFrames} frames`);
  console.log(`audio stream:    ${audioOk ? `present (${audio?.codec_name}, ${audio?.sample_rate} Hz)` : "MISSING"}`);
  console.log(`mean volume:     ${vol === null ? "unmeasured" : `${vol} dB`} (${volOk ? "speech-range" : "SILENCE"})`);
  for (const t of tailRows)
    console.log(`tail ${t.id}:      rendered ${t.renderedMs} ms vs vo+350 ${t.voMs + 350} ms (Δ ${t.delta >= 0 ? "+" : ""}${t.delta} ms) ${t.pass ? "pass" : "FAIL"}`);
  console.log(`frame integrity: ${framesOk ? "pass (nb_frames = Σ scene frames)" : `FAIL (${nbFrames} ≠ Σ)`}`);
  console.log(`qc:              ${qcPass}/${checks.length} pass${failedIds ? ` — failed: ${failedIds}` : ""}`);
  console.log(`S76-TTS-SMOKE: ${pass ? "PASS" : "FAIL"} — real narration, real engine, one open caveat closed.`);
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.log(`S76-TTS-SMOKE: FAIL — ${String((e as Error)?.message ?? e).slice(0, 300)}`);
  process.exit(1);
});
