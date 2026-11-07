// S55 T-55.1/T-55.2 — post-processor for the render-forensics evidence.
//
// The second forensic run (2026-11-08) captured the anchor render fully, but
// its instrument carried two analysis bugs, both found by cross-checking the
// preserved artifact (/tmp/s55-evidence/final.mp4) against the QC battery's
// own numbers:
//   1. the freezedetect parser required all three fields on ONE line — this
//      ffmpeg build prints them one per line, so the run reported 0 freezes
//      while the battery (correct parse) reported 2;
//   2. the intra-scene flip times used RAW cumulative shot seconds — the
//      shot graph executes fitFrames' PROPORTIONAL allocation, so flips are
//      segSec × (cum/sum) into each segment.
//
// This script re-analyzes the preserved artifact with the corrected math and
// rewrites docs/audits/s55-render-forensics-data.json in place. No gateway,
// no render — pure local ffmpeg + JSON. The main instrument
// (scripts/s55-render-forensics.mts) carries the same fixes for future runs.
//
// Usage: node --import tsx scripts/s55-forensics-post.mts

import { execFile } from "child_process";
import fs from "node:fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const DATA_PATH = "docs/audits/s55-render-forensics-data.json";
const ARTIFACT = "/tmp/s55-evidence/final.mp4";

interface FreezeRun { start: number; duration: number; end: number; }

/** freezedetect with the corrected line-accumulating parse (see main script). */
async function freezeDetect(file: string, d: number): Promise<FreezeRun[]> {
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
    if (s) { flush(); cur.start = Number(s[1]); continue; }
    if (du && cur.start !== undefined) { cur.duration = Number(du[1]); continue; }
    if (e && cur.start !== undefined) { cur.end = Number(e[1]); flush(); }
  }
  flush();
  return out;
}

const fmt2 = (n: number) => n.toFixed(2);

// ---------- run ----------
const data = JSON.parse(fs.readFileSync(DATA_PATH, "utf8")) as Record<string, unknown>;
const timeline = data.timeline as { segSec: number; sceneStart: number[]; flipTimes: number[] };
const shotTables = data.shotTables as {
  sceneIndex: number;
  available: { shotIndex: number; moveKind: string; sec: number; source: string; transitionOut?: string }[];
}[];
const render = data.render as { expectedCuts: { cuts: number[]; windows: [number, number][] } | null };
const cuts40 = data.cuts40 as number[];

// 1) Fitted flip times (what the shot graph actually executes).
const fittedFlips: number[] = [];
shotTables.forEach((sp, k) => {
  const raw = sp.available.map((s) => s.sec);
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  let cum = 0;
  for (let i = 0; i + 1 < sp.available.length; i++) {
    cum += raw[i];
    fittedFlips.push(timeline.sceneStart[k] + timeline.segSec * (cum / sum));
  }
});

// 2) Corrected freezes from the preserved artifact.
const freezes100 = await freezeDetect(ARTIFACT, 1.00);
const freezes050 = await freezeDetect(ARTIFACT, 0.50);

// 3) Cut correlation vs fitted flips (same verdict logic as the main script).
const windows = render.expectedCuts?.windows ?? [];
const cutVerdicts = cuts40.map((t) => {
  const winD = windows.map(([lo, hi]) => ({ d: t < lo - 0.6 ? lo - t : t > hi + 0.6 ? t - hi : 0, lo, hi })).sort((a, b) => a.d - b.d)[0] ?? null;
  const flipD = fittedFlips.map((ft) => ({ ft, d: Math.abs(t - ft) })).sort((a, b) => a.d - b.d)[0] ?? null;
  const verdict = winD && winD.d === 0 ? "booked blend window"
    : flipD && flipD.d <= 0.6 ? `intra-scene shot flip (Δ${fmt2(flipD.d)}s)`
    : "unexplained";
  return { t, verdict, nearestFlip: flipD, nearestWindow: winD };
});

// 4) Freeze correlation: which scene/shot each freeze lives in (fitted math).
const freezeShots = freezes100.map((f) => {
  const k = timeline.sceneStart.reduce((acc, s, i) => (f.start >= s ? i : acc), 0);
  const sp = shotTables[k];
  const raw = sp.available.map((s) => s.sec);
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const local = (f.start - timeline.sceneStart[k]) / timeline.segSec * sum; // fitted-local seconds
  let c = 0; let shot = sp.available[0];
  for (const sh of sp.available) { if (local >= c) shot = sh; c += sh.sec; }
  return {
    ...f,
    sceneIndex: sp.sceneIndex,
    fittedLocalSec: Math.round(local * 100) / 100,
    shot: { shotIndex: shot.shotIndex, moveKind: shot.moveKind, sec: shot.sec, source: shot.source, transitionOut: shot.transitionOut ?? null },
  };
});

// 5) Rewrite the evidence.
const out = {
  ...data,
  freezes100,
  freezes050,
  timeline: { ...timeline, flipTimesRaw: timeline.flipTimes, flipTimes: fittedFlips.map((t) => Math.round(t * 100) / 100) },
  correlation: { cutVerdicts, freezeShots },
  postProcessed: {
    at: new Date().toISOString(),
    corrections: [
      "freezes re-parsed with the line-accumulating parser (one-field-per-line ffmpeg output) — the in-run parser's same-line regex ate every event",
      "flipTimes recomputed as the FITTED proportional allocation the shot graph executes (segSec × cum/sum per segment); the raw cumulative times are kept as flipTimesRaw",
      "freeze correlation mapped with fitted-local seconds",
    ],
  },
};
fs.writeFileSync(DATA_PATH, JSON.stringify(out, null, 1));

console.info(`freezes d=1.00: ${freezes100.map((f) => `${fmt2(f.start)}–${fmt2(f.end)} (${fmt2(f.duration)}s)`).join(" · ") || "none"}`);
console.info(`freezes d=0.50: ${freezes050.length} run(s)`);
console.info(`fitted flips: ${fittedFlips.map(fmt2).join(", ")}`);
console.info("cut verdicts:");
for (const v of cutVerdicts) console.info(`  @${fmt2(v.t)}s → ${v.verdict}`);
console.info("freeze verdicts:");
for (const f of freezeShots) {
  console.info(`  ${fmt2(f.start)}–${fmt2(f.end)} → scene ${f.sceneIndex} shot #${f.shot.shotIndex} (${f.shot.moveKind} ${f.shot.sec}s ${f.shot.source}) fitted-local ${fmt2(f.fittedLocalSec)}s`);
}
console.info(`evidence rewritten: ${DATA_PATH}`);
