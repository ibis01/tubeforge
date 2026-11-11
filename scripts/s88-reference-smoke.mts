// S88 smoke — the analysis pipeline on a REAL synthesized reference
// (3 hard-cut color scenes + a sine bed). The AI passes fail open when no
// gateway is reachable, which is itself part of what this proves: the
// deterministic layer (probe → scene detect → windows → pacing → beats)
// stands alone. Run: node --import tsx scripts/s88-reference-smoke.mts
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFileCb);

async function main() {
  const dir = fs.mkdtempSync("/tmp/s88-ref-");
  const src = path.join(dir, "ref.mp4");
  // 3 textured scenes × 4s, hard cuts — textured lavfi sources score like
  // real footage on the scene-change metric (a solid-color pair scores as
  // low as 0.15 — chroma-only changes are pathological for the detector,
  // recorded in the design doc; real references are textured).
  await execFileP("ffmpeg", [
    "-y", "-v", "error",
    "-f", "lavfi", "-i", "testsrc2=s=640x360:r=24:d=4",
    "-t", "4", "-f", "lavfi", "-i", "mandelbrot=s=640x360:r=24",
    "-t", "4", "-f", "lavfi", "-i", "smptebars=s=640x360:r=24:d=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=12",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]",
    "-map", "[v]", "-map", "3:a",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "28",
    "-c:a", "aac", "-b:a", "96k",
    src,
  ]);
  console.log("synthesized:", src, fs.statSync(src).size, "bytes");

  // The pipeline under test (storage calls run against the local driver).
  process.env.DATABASE_URL ||= "file:./db/custom.db";
  const { analyzeReferenceVideo, serializeReferenceAnalysis, parseReferenceAnalysis } =
    await import("../src/lib/tubeforge/reference-video.ts");
  const analysis = await analyzeReferenceVideo("s88-smoke-video", src, {
    fileName: "ref.mp4",
    onProgress: (l) => console.log("  …", l),
  });

  console.log("\n=== the analysis ===");
  console.log(JSON.stringify(analysis, null, 2).slice(0, 2200));

  // The mechanical assertions (the S76 standard's deterministic half).
  const failures: string[] = [];
  const expect = (label: string, ok: boolean) => {
    console.log(`  ${ok ? "✓" : "✗"} ${label}`);
    if (!ok) failures.push(label);
  };
  expect("duration ≈ 12s", Math.abs(analysis.source.durationSec - 12) < 0.5);
  expect("audio detected", analysis.source.hasAudio === true);
  expect("≥2 cuts detected (3 scenes)", analysis.pacing.cutCount >= 2);
  expect("windows ≈ 4s each", analysis.sceneMap.every((w) => Math.abs(w.endSec - w.startSec - 4) < 1.2));
  expect("pacing measured-or-slower (15/min band edge)", ["slow", "measured"].includes(analysis.pacing.profile));
  expect("keyframes stored", analysis.sceneMap.some((w) => w.keyframeKey !== null));
  expect("beats tile the span", analysis.structure.beats.length >= 2 && Math.abs(analysis.structure.beats[analysis.structure.beats.length - 1].endSec - 12) < 0.6);
  expect("structure source is honest", analysis.structure.source === "llm" || analysis.structure.source === "deterministic");
  expect("doc round-trips", serializeReferenceAnalysis(parseReferenceAnalysis(serializeReferenceAnalysis(analysis))) === serializeReferenceAnalysis(analysis));

  console.log(failures.length === 0 ? "\nSMOKE GREEN" : `\nSMOKE FAIL: ${failures.join("; ")}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
