// check-render-lane.mts — S119 lane-contract proof against a RUNNING dev
// server on :3000. Reproduces the user's exact broken journey end-to-end and
// proves the fix at every hop:
//
//   1. create a KENBURNS story video (the broken starting state),
//   2. scaffold the whiteboard project      → the row PINS to whiteboard,
//   3. POST /render { mode: "kenburns" }    → honest story gate (400) + the
//                                              row FLIPS BACK to kenburns,
//   4. POST /render { mode: "whiteboard" }  → 202 + the row PINS to the
//                                              engine lane (the click that
//                                              used to degrade to kenburns),
//   5. poll to completion                    → final.mp4 is WHITEBOARD ink
//      (sampled frames are majority near-white — the exact inverse of the
//      broken kenburns-over-storyboard output at 0.3–1.8% near-white),
//   6. copy the render to download/ as the visible sample.
//
//   node --import tsx scripts/check-render-lane.mts
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";

const execFileP = promisify(execFile);
const BASE = "http://localhost:3000";
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const EMAIL = `s119-lane-${RUN}@tubeforge.test`;
const PASSWORD = "s119-lane-123";
const prisma = new PrismaClient();

let cookie = "";
async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("tf_session=")) cookie = setCookie.split(";")[0];
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

let failures = 0;
function check(cond: unknown, msg: string): asserts cond {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    failures++;
    console.log(`  ✗ ${msg}`);
  }
}

const rowOf = async (id: string) =>
  prisma.video.findUnique({ where: { id }, select: { renderMode: true, whiteboardProject: true, hasVideo: true, error: true } });

async function nearWhiteRatio(file: string, atSec: number): Promise<number | null> {
  // One grayscale frame at atSec, via a temp FILE (pipe:1 proved flaky under
  // execFile) → share of near-white pixels.
  const tmp = `/tmp/s119-frame-${RUN}.raw`;
  try {
    await execFileP("ffmpeg", [
      "-y", "-v", "error", "-ss", String(atSec), "-i", file,
      "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "gray", tmp,
    ]);
    const buf = await fs.promises.readFile(tmp);
    if (!buf.length) return null;
    let near = 0;
    for (const b of buf) if (b >= 230) near++;
    return near / buf.length;
  } catch {
    return null;
  }
}

async function main() {
  console.log(`[s119] run=${RUN} — lane-contract proof against ${BASE}`);

  // ---- auth ----
  let r = await call("POST", "/api/auth/register", { name: "S119 Lane", email: EMAIL, password: PASSWORD });
  console.log(`register → ${r.status}`);
  const vUrl = (r.json as { verification?: { url?: string } })?.verification?.url;
  if (vUrl) await call("GET", vUrl.replace(/^https?:\/\/[^/]+/, ""));

  // ---- 1. the broken starting state: a KENBURNS story video ----
  r = await call("POST", "/api/videos", {
    topic: `S119 lane check ${RUN}`,
    niche: "History",
    format: "story",
    renderMode: "kenburns",
  });
  const videoId = (r.json as { video?: { id?: string } })?.video?.id;
  check(Boolean(videoId), `story video created (id=${videoId})`);
  if (!videoId) throw new Error("no videoId — aborting");
  check((await rowOf(videoId))?.renderMode === "kenburns", "the row starts on the story lane (kenburns)");

  // Seed scenes deterministically (no LLM): the shape parseScenes reads.
  // Three beats of the user's own topic, so the sample render doubles as a
  // recognizable explainer beat (and multi-scene transitions get exercised).
  await prisma.video.update({
    where: { id: videoId },
    data: {
      scenes: JSON.stringify([
        { index: 1, title: "The crossing", narration: "In the year 711, Berber armies cross the strait, and Al-Andalus is born.", visual: "a map of the strait with an arrow crossing" },
        { index: 2, title: "The long twilight", narration: "For centuries, cities, libraries and courts flourish under the new order.", visual: "a library with books and arches" },
        { index: 3, title: "The Reconquista", narration: "Eight hundred years later, the last banner falls, and the Reconquista is complete.", visual: "banners over a fortress wall" },
      ]),
    },
  });

  // ---- 2. scaffold pins the lane (S119 scaffold law) ----
  r = await call("POST", `/api/videos/${videoId}/whiteboard/scaffold`, {});
  check(r.status === 200, `scaffold accepted (${r.status})`);
  const afterScaffold = await rowOf(videoId);
  check(afterScaffold?.renderMode === "whiteboard", "SCAFFOLD PIN: the row flipped to whiteboard — the row, the doc and the Studio now agree");
  check(Boolean(afterScaffold?.whiteboardProject), "the whiteboard project doc exists on the row");

  // ---- 3. an explicit story click flips back + hits the honest story gate ----
  r = await call("POST", `/api/videos/${videoId}/render`, { mode: "kenburns" });
  check(r.status === 400 && String((r.json as { error?: string })?.error ?? "").includes("storyboard"),
    `explicit kenburns click on a whiteboard row → honest story gate (${r.status}: ${(r.json as { error?: string })?.error})`);
  check((await rowOf(videoId))?.renderMode === "kenburns", "FLIP-BACK: the row holds the user's latest explicit truth (kenburns)");

  // ---- 4. the user's exact broken click, now honored ----
  r = await call("POST", `/api/videos/${videoId}/render`, { mode: "whiteboard" });
  check(r.status === 202, `explicit whiteboard click → engine lane accepted (${r.status})`);
  check((r.json as { mode?: string })?.mode === "whiteboard", "the response names the lane it took (mode: whiteboard)");
  check((await rowOf(videoId))?.renderMode === "whiteboard", "THE PIN: the click pinned the row to the engine lane (the old code degraded this to kenburns)");

  // ---- 5. poll the render to completion ----
  console.log("  … polling the whiteboard render");
  const t0 = Date.now();
  let done = false;
  for (let i = 0; i < 240; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    const row = await rowOf(videoId);
    if (row?.error) {
      check(false, `render failed: ${row.error}`);
      break;
    }
    if (row?.hasVideo) {
      const wall = ((Date.now() - t0) / 1000).toFixed(0);
      check(true, `render completed (${wall}s wall)`);
      done = true;
      break;
    }
    if (i % 15 === 14) console.log(`    … ${(i * 2)}s elapsed`);
  }
  if (!done && !failures) check(false, "render did not complete within the 8-minute budget");

  // ---- 6. the output IS whiteboard ink (the inverse of the broken video) ----
  const finalPath = path.resolve("uploads", videoId, "final.mp4");
  check(fs.existsSync(finalPath), `final.mp4 exists (${finalPath})`);
  if (fs.existsSync(finalPath)) {
    const { stdout: durOut } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", finalPath,
    ]);
    const dur = Number(durOut.trim());
    const samples: number[] = [];
    for (const frac of [0.25, 0.4, 0.55, 0.7, 0.85]) {
      const ratio = await nearWhiteRatio(finalPath, Math.max(dur * frac, 0.5));
      if (ratio != null) samples.push(ratio);
    }
    const mean = samples.reduce((a, b) => a + b, 0) / (samples.length || 1);
    console.log(`    duration=${dur.toFixed(1)}s nearWhite per frame: ${samples.map((s) => (s * 100).toFixed(1) + "%").join(", ")}`);
    check(samples.length >= 4 && mean >= 0.4,
      `the render is WHITEBOARD ink — mean near-white ${(mean * 100).toFixed(1)}% (the broken kenburns output measured 0.3–1.8%)`);

    // ---- 7. the visible sample for the user ----
    const dest = path.resolve("download", "tubeforge-whiteboard-sample.mp4");
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(finalPath, dest);
    check(fs.existsSync(dest) && fs.statSync(dest).size > 0, `sample copied for the user → ${dest} (${(fs.statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
  }

  await prisma.$disconnect();
  console.log(failures === 0 ? "\nS119 LANE CONTRACT GREEN" : `\nS119 LANE CONTRACT FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error("driver crashed:", e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
