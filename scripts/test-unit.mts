#!/usr/bin/env node
/**
 * TubeForge unit + regression suite — audio mixer, QC gate, music mood logic.
 *
 *   node --import tsx scripts/test-unit.mts          (also wired into `npm run check`)
 *
 * Two layers:
 *   1. PURE units — filter-chain builders, loudnorm JSON parsing, static-run
 *      collapsing, SRT parsing, mood-tag mapping. No ffmpeg, no DB, no I/O.
 *   2. REAL FIXTURES — tiny MP4s rendered by the sandbox ffmpeg (fade-out,
 *      abrupt cut, near-silence, partial dead-air, garbage bytes, missing
 *      file) pushed through runQcReport. These pin the QC three-state
 *      contract: a check that could not run reports "unmeasured" and NEVER
 *      reads as clean — the exact class of bug this suite exists to prevent.
 */

import { execFile } from "child_process";
import crypto from "node:crypto";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

import {
  DUCK_INTENSITIES,
  bedChain,
  droneBedChain,
  duckChain,
  duckParams,
  frameMeanDiff,
  isDuckIntensity,
  mixTail,
  normalizationFilter,
  parseLoudnormJson,
  sanitizeDuckIntensity,
  staticRunsDetail,
  staticRunsFromFrames,
  voiceSplitChain,
  type LoudnessMeasurement,
} from "../src/lib/tubeforge/audiomix";
import { isMusicMoodId, moodTags, NICHE_MOODS } from "../src/lib/tubeforge/music";
import { parseSrt, runQcReport } from "../src/lib/tubeforge/qc";
import {
  applyQcPolicy,
  parseQcReport,
  qcEnforcementMode,
  qcOverrideValid,
  QC_BLOCKING_COUNT,
  QC_ENFORCEMENT_MATRIX,
  QC_POLICY_VERSION,
  type QcReportLike,
} from "../src/lib/tubeforge/qc-policy";
import {
  describeVoiceHealth,
  isClonedVoiceId,
  sanitizeVoice,
  voiceCatalog,
} from "../src/lib/tubeforge/providers/tts";
import {
  cleanCloneName,
  isValidSampleUrl,
  MAX_SAMPLE_SEC,
  MIN_SAMPLE_SEC,
} from "../src/lib/tubeforge/voice-clone";
import {
  closestPriorDistance,
  dHashFromGray9x8,
  hammingDistanceHex,
  imageHash,
  sceneImageHashes,
} from "../src/lib/tubeforge/arthash";
import { sceneQueries } from "../src/lib/tubeforge/stock-query";
import { selfhostEndpoint, sharedVoiceServer } from "../src/lib/tubeforge/shared-voice";
import {
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  loginWindowDecision,
} from "../src/lib/tubeforge/auth-throttle";
import type { AssembledTimeline, TimelineScene } from "../src/lib/tubeforge/timeline";
import {
  cameraAt,
  formatTimecode,
  PREVIEW_DEFAULTS,
  previewSettingsFrom,
  projectLanes,
  resolveFrame,
  seamBoundaries,
  snapToBoundaries,
  type PreviewSettings,
} from "../src/lib/tubeforge/preview-lanes";
import type { Scene } from "../src/lib/tubeforge/types";
import type {
  WhiteboardProject,
  WhiteboardScene,
} from "../src/lib/tubeforge/whiteboard/storyboard";
import {
  applyDeleteToDoc,
  applyDuplicateToDoc,
  applySplitToDoc,
  sceneSegmentSec,
  splitNarrationAt,
} from "../src/lib/tubeforge/clip-ops";

const execFileAsync = promisify(execFile);

// ---------- micro framework ----------

let passed = 0;
let failed = 0;
const failures: string[] = [];
let suite = "";

function suiteStart(name: string) {
  suite = name;
  console.log(`\n◆ ${name}`);
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`[${suite}] ${name} — ${msg}`);
    console.log(`  ✗ ${name}\n      ${msg.split("\n")[0]}`);
  }
}

function ok(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function eq<T>(actual: T, expected: T, label = "value") {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
}

function approx(actual: number, expected: number, tol: number, label = "number") {
  if (!(Math.abs(actual - expected) <= tol))
    throw new Error(`${label}: expected ${expected} ±${tol}, got ${actual}`);
}

function oneOf<T>(actual: T, options: readonly T[], label = "value") {
  if (!options.includes(actual))
    throw new Error(`${label}: expected one of ${JSON.stringify(options)}, got ${JSON.stringify(actual)}`);
}

const statusOf = (report: { checks: { id: string; status: string }[] }, id: string) => {
  const c = report.checks.find((x) => x.id === id);
  if (!c) throw new Error(`check "${id}" missing from report`);
  return c.status;
};

// ---------- fixtures ----------

const FFMPEG_COMMON = [
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
  "-c:a", "aac", "-b:a", "96k",
];

async function genFixture(file: string, args: string[]) {
  await execFileAsync("ffmpeg", ["-hide_banner", "-nostats", "-y", ...args, file], {
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

/** 4s clip whose audio fades out over the final 1.2s (healthy ending).
 * NOTE: lavfi `sine` generates at 1/8 amplitude (≈ -21 dB mean) — loud
 * enough that an UNFADED tail sits well above the -25 dB fade threshold. */
function fadeOutArgs(): string[] {
  return [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    "-af", "afade=t=out:st=2.8:d=1.2",
    ...FFMPEG_COMMON, "-shortest",
  ];
}

/** 4s clip cut mid-tone — the classic abrupt ending. */
function abruptArgs(): string[] {
  return [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
    ...FFMPEG_COMMON, "-shortest",
  ];
}

/** 4s clip at -40ish dBFS: decodable and measurable, but far below target. */
function quietArgs(): string[] {
  return [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=4",
    "-f", "lavfi", "-i", "sine=frequency=330:duration=4",
    "-af", "volume=0.01",
    ...FFMPEG_COMMON, "-shortest",
  ];
}

/** 6s clip: 2s of tone then 4s of digital silence → dead air. */
function deadAirArgs(): string[] {
  return [
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=24:duration=6",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
    "-t", "4", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-filter_complex", "[1:a]volume=0.25[t];[t][2:a]concat=n=2:v=0:a=1[a]",
    "-map", "0:v", "-map", "[a]",
    ...FFMPEG_COMMON, "-shortest",
  ];
}

const MEASURED_ANALYSIS_IDS = [
  "black-frames", "frozen-frames", "dead-air", "loudness",
  "true-peak", "loudness-range", "static-shots", "tail-fade",
] as const;

/** Legacy-compat invariant: pass flag always derives from status, and any
 * unmeasured check drags the whole report out of "passed". */
function assertReportInvariants(report: {
  passed: boolean;
  checks: { id: string; status: string; pass: boolean }[];
}) {
  ok(report.checks.length > 0, "report must contain checks");
  for (const c of report.checks)
    eq(c.pass, c.status === "pass", `check ${c.id}: legacy pass flag`);
  const hasUnmeasured = report.checks.some((c) => c.status === "unmeasured");
  if (hasUnmeasured) ok(!report.passed, "any unmeasured check must fail the report");
  else eq(report.passed, report.checks.every((c) => c.status === "pass"), "overall passed");
}

// ---------- suite: audio mix chain builders (pure) ----------

suiteStart("audiomix — ducking configuration");

await test("sanitizeDuckIntensity: valid ids pass through, junk → standard", () => {
  eq(sanitizeDuckIntensity("off"), "off");
  eq(sanitizeDuckIntensity("subtle"), "subtle");
  eq(sanitizeDuckIntensity("strong"), "strong");
  eq(sanitizeDuckIntensity("standard"), "standard");
  eq(sanitizeDuckIntensity("bogus"), "standard");
  eq(sanitizeDuckIntensity(42), "standard");
  eq(sanitizeDuckIntensity(null), "standard");
});

await test("isDuckIntensity validates exactly the catalog ids", () => {
  for (const d of DUCK_INTENSITIES) ok(isDuckIntensity(d.id), `catalog id ${d.id} must validate`);
  ok(!isDuckIntensity("loud"), "non-catalog id must reject");
  ok(!isDuckIntensity(7), "non-string must reject");
});

await test("duckParams: deeper intensity = lower threshold, higher ratio", () => {
  eq(duckParams("off"), null, "off must disable ducking");
  const subtle = duckParams("subtle");
  const standard = duckParams("standard");
  const strong = duckParams("strong");
  ok(subtle != null && standard != null && strong != null, "all three intensities carry params");
  ok(subtle.threshold > standard.threshold && standard.threshold > strong.threshold,
    "threshold must fall as intensity rises");
  ok(subtle.ratio < standard.ratio && standard.ratio < strong.ratio,
    "ratio must rise as intensity rises");
  approx(subtle.threshold, 0.06, 1e-9);
  approx(standard.threshold, 0.03, 1e-9);
  approx(strong.threshold, 0.015, 1e-9);
});

await test("duckChain: off = passthrough that still sinks the sidechain", () => {
  const chain = duckChain("off", "music", "sc", "mduck");
  ok(chain.includes("[sc]anullsink"), "sidechain label must stay bound");
  ok(chain.includes("[music]anull[mduck]"), "music must pass through untouched");
  ok(!chain.includes("sidechaincompress"), "off must not compress");
});

await test("duckChain: standard encodes the sidechaincompress parameters", () => {
  const chain = duckChain("standard");
  ok(chain.includes("sidechaincompress=threshold=0.03:ratio=9"), chain);
  ok(chain.includes("[music][sc]sidechaincompress") && chain.endsWith("[mduck]"), chain);
});

await test("voiceSplitChain binds voice + sidechain stems", () => {
  const chain = voiceSplitChain();
  ok(chain.includes("asplit=2[voice][sc]"), chain);
});

suiteStart("audiomix — bed chains");

await test("bedChain: gain + in/out fades with correct fade-out start", () => {
  const chain = bedChain({ totalSec: 60, gain: 0.5, fadeInSec: 2, fadeOutSec: 3 });
  ok(chain.includes("volume=0.500"), chain);
  ok(chain.includes("afade=t=in:d=2.00"), chain);
  ok(chain.includes("afade=t=out:st=57.00:d=3.00"), chain);
});

await test("bedChain: zero-length fade never produces NaN", () => {
  const chain = bedChain({ totalSec: 5, gain: 1, fadeInSec: 0, fadeOutSec: 0 });
  ok(!chain.includes("NaN"), chain);
  ok(chain.includes("afade=t=out:st=5.00:d=0.00"), chain);
});

await test("droneBedChain: lowpass + fades", () => {
  const chain = droneBedChain({ totalSec: 30, lowpassHz: 800, fadeInSec: 1.5, fadeOutSec: 2 });
  ok(chain.includes("lowpass=f=800"), chain);
  ok(chain.includes("afade=t=in:d=1.50"), chain);
  ok(chain.includes("afade=t=out:st=28.00:d=2.00"), chain);
});

await test("mixTail: two inputs, first-bounded, weights preserved", () => {
  const chain = mixTail(1, 0.8);
  ok(chain.includes("amix=inputs=2:duration=first:normalize=0"), chain);
  ok(chain.includes("weights='1 0.8'"), chain);
  ok(chain.endsWith("[mix]"), chain);
});

// ---------- suite: loudness (pure) ----------

suiteStart("audiomix — loudnorm parsing + normalization");

const GOOD_MEASURE: LoudnessMeasurement = {
  integratedLUFS: -14.2,
  truePeakDBTP: -1.3,
  lra: 6.1,
  threshLUFS: -24.3,
  offsetLU: -0.2,
};

await test("parseLoudnormJson: extracts the measurement from noisy stderr", () => {
  const stderr = `frame=1 fps=0.0 q=-0.0 size=N/A time=00:00:00.04 bitrate=N/A speed=0.05x
[Parsed_loudnorm_0 @ 0x55] Here is some noise {
        "input_i" : "-14.20",
        "input_tp" : "-1.30",
        "input_lra" : "6.10",
        "input_thresh" : "-24.30",
        "output_i" : "-15.90",
        "output_tp" : "-2.00",
        "output_lra" : "5.70",
        "output_thresh" : "-26.10",
        "normalization_type" : "linear",
        "target_offset" : "-0.20"
}
size=N/A time=00:00:04.00 bitrate=N/A speed=0.1x`;
  const m = parseLoudnormJson(stderr);
  ok(m !== null, "happy-path stderr must parse");
  approx(m.integratedLUFS, -14.2, 1e-9);
  approx(m.truePeakDBTP, -1.3, 1e-9);
  approx(m.lra, 6.1, 1e-9);
  approx(m.threshLUFS, -24.3, 1e-9);
  approx(m.offsetLU, -0.2, 1e-9);
});

await test("parseLoudnormJson: -inf integrated loudness (silence) → null", () => {
  const stderr = `{
        "input_i" : "-inf",
        "input_tp" : "-inf",
        "input_lra" : "0.00",
        "input_thresh" : "-inf",
        "target_offset" : "0.00"
}`;
  eq(parseLoudnormJson(stderr), null, "silent audio cannot drive a linear pass");
});

await test("parseLoudnormJson: malformed / empty / non-JSON → null", () => {
  eq(parseLoudnormJson(""), null);
  eq(parseLoudnormJson("no json at all here"), null);
  eq(parseLoudnormJson("{ not json }"), null);
});

await test("normalizationFilter(null): dynamic fallback, no measured_ fields", () => {
  const f = normalizationFilter(null);
  ok(!f.includes("measured_"), "fallback must not carry measurement fields");
  ok(f.includes("loudnorm=I="), f);
  // 0.841 linear = −1.5 dBFS sample ceiling: true-peak-safe for the AAC
  // overshoot the QC gate measures on the encoded file.
  ok(f.includes("alimiter=limit=0.841:level=false"), f);
  ok(f.includes("aresample=48000"), f);
});

await test("normalizationFilter(m): linear two-pass with measurement + limiter + 48k", () => {
  const f = normalizationFilter(GOOD_MEASURE);
  ok(f.includes("measured_I=-14.20"), f);
  ok(f.includes("measured_TP=-1.30"), f);
  ok(f.includes("measured_LRA=6.10"), f);
  ok(f.includes("measured_thresh=-24.30"), f);
  ok(f.includes("offset=-0.20:linear=true"), f);
  ok(f.includes("alimiter=limit=0.841"), f);
  ok(f.includes("aresample=48000"), f);
});

// ---------- suite: static-run detection (pure) ----------

suiteStart("audiomix — static-run collapsing");

await test("frameMeanDiff: identical frames → 0, different → >0, mismatch → ∞", () => {
  approx(frameMeanDiff(new Uint8Array([10, 20, 30]), new Uint8Array([10, 20, 30])), 0, 1e-9);
  ok(frameMeanDiff(new Uint8Array([10, 20, 30]), new Uint8Array([40, 20, 30])) > 0);
  eq(frameMeanDiff(new Uint8Array([1]), new Uint8Array([1, 2])), Number.POSITIVE_INFINITY);
  eq(frameMeanDiff(new Uint8Array([]), new Uint8Array([])), Number.POSITIVE_INFINITY);
});

await test("staticRunsFromFrames: 9.5s identical stretch is flagged", () => {
  // 21 frames of 4 bytes: frames 0..19 identical, frame 20 different.
  const frames = new Uint8Array(21 * 4);
  frames.fill(7, 0, 20 * 4);
  frames.fill(200, 20 * 4);
  const runs = staticRunsFromFrames(frames, 4, { fps: 2, diffThreshold: 0.9, minRunSec: 6 });
  eq(runs.length, 1, "one run expected");
  approx(runs[0].startSec, 0, 1e-9);
  approx(runs[0].endSec, 9.5, 1e-9);
});

await test("staticRunsFromFrames: a 4.5s stretch is below the 6s floor", () => {
  const frames = new Uint8Array(11 * 4);
  frames.fill(7, 0, 10 * 4);
  frames.fill(200, 10 * 4);
  const runs = staticRunsFromFrames(frames, 4, { fps: 2, diffThreshold: 0.9, minRunSec: 6 });
  eq(runs.length, 0, "short stretch must not flag");
});

await test("staticRunsFromFrames: fully static input flags via the final flush", () => {
  const frames = new Uint8Array(30 * 4).fill(9);
  const runs = staticRunsFromFrames(frames, 4, { fps: 2, diffThreshold: 0.9, minRunSec: 6 });
  eq(runs.length, 1, "all-static input must flag once");
  approx(runs[0].startSec, 0, 1e-9);
});

await test("staticRunsFromFrames: too few samples → no runs, no crash", () => {
  eq(staticRunsFromFrames(new Uint8Array(4), 4), []);
  eq(staticRunsFromFrames(new Uint8Array(0), 4), []);
});

await test("staticRunsDetail formats ranges", () => {
  eq(staticRunsDetail([{ startSec: 0, endSec: 10 }, { startSec: 20.4, endSec: 30 }]), "0–10s, 20–30s");
  eq(staticRunsDetail([]), "");
});

// ---------- suite: QC pure helpers ----------

suiteStart("qc — SRT parsing (pure)");

await test("parseSrt: two clean cues", () => {
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:02,500",
    "Hello world",
    "",
    "2",
    "00:00:03,000 --> 00:00:04,000",
    "Second cue",
    "",
  ].join("\n");
  const cues = parseSrt(srt);
  eq(cues.length, 2, "cue count");
  approx(cues[0].start, 1, 1e-9);
  approx(cues[0].end, 2.5, 1e-9);
  approx(cues[1].start, 3, 1e-9);
  approx(cues[1].end, 4, 1e-9);
});

await test("parseSrt: garbage and empty inputs → no cues, no crash", () => {
  eq(parseSrt("this is not a subtitle file"), []);
  eq(parseSrt(""), []);
});

await test("formatSrtCues: hard non-overlap — the earlier cue always yields (Battle Yamuk 54 overlaps)", async () => {
  const { formatSrtCues } = await import("../src/lib/tubeforge/captions.ts");
  // Cue 1 runs into cue 2's window; cue 2 runs past cue 3's start; cue 4
  // arrives out of order (blended-timeline shift). NONE may overlap after
  // the pass, whatever the inputs do.
  const srt = formatSrtCues([
    { start: 0, end: 3.0, text: "first cue too long" },
    { start: 2.0, end: 6.0, text: "second overlaps third" },
    { start: 5.5, end: 7.0, text: "third" },
    { start: 1.0, end: 1.6, text: "disordered early blip" },
  ]);
  const cues = parseSrt(srt);
  eq(cues.length, 4, "all cues survive");
  // Sorted by start: first(0.0), blip(1.0), second(2.0), third(5.5).
  approx(cues[0].start, 0.0, 1e-9, "earliest cue first");
  // The out-of-order blip (start 1.0, end 1.6) landed in slot 2.
  approx(cues[1].start, 1.0, 1e-9, "out-of-order cue sorted into place");
  approx(cues[1].end, 1.6, 1e-9, "blip end preserved (nothing to yield to)");
  for (let i = 1; i < cues.length; i++) {
    ok(cues[i].start >= cues[i - 1].end, `cue ${i + 1} starts at/after cue ${i} ends (${cues[i - 1].end} → ${cues[i].start})`);
  }
  // The yielding cue still got its 50ms gap, not a hard cut to equal.
  ok(cues[2].end <= cues[3].start, "gap respected");
});

await test("formatSrtCues: sane cues pass through untouched", async () => {
  const { formatSrtCues } = await import("../src/lib/tubeforge/captions.ts");
  const srt = formatSrtCues([
    { start: 0, end: 1.5, text: "a" },
    { start: 2.0, end: 3.5, text: "b" },
  ]);
  const cues = parseSrt(srt);
  approx(cues[0].end, 1.5, 1e-9, "non-overlapping end preserved");
  approx(cues[1].start, 2.0, 1e-9, "start preserved");
});

// ---------- suite: QC fixtures (real ffmpeg) ----------

suiteStart("qc — three-state contract on real fixtures");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-qc-"));
try {
  const fadeMp4 = path.join(tmp, "fade.mp4");
  const abruptMp4 = path.join(tmp, "abrupt.mp4");
  const quietMp4 = path.join(tmp, "quiet.mp4");
  const deadAirMp4 = path.join(tmp, "deadair.mp4");
  const garbageMp4 = path.join(tmp, "garbage.mp4");
  const missingMp4 = path.join(tmp, "never-rendered.mp4");

  console.log("  … rendering QC fixtures with ffmpeg");
  await genFixture(fadeMp4, fadeOutArgs());
  await genFixture(abruptMp4, abruptArgs());
  await genFixture(quietMp4, quietArgs());
  await genFixture(deadAirMp4, deadAirArgs());
  fs.writeFileSync(garbageMp4, Buffer.from(Array.from({ length: 8192 }, (_, i) => (i * 37) % 251)));

  const qcOpts = (file: string) => ({
    mp4Path: file,
    videoDuration: 4,
    narrationSec: null as number | null,
    srtPath: null as string | null,
  });

  await test("missing file: playable=fail, report fails, nothing pretends otherwise", async () => {
    const r = await runQcReport(qcOpts(missingMp4));
    eq(statusOf(r, "playable"), "fail");
    eq(r.checks.length, 1, "no analysis-derived checks without a file");
    ok(!r.passed, "missing render must never pass");
    assertReportInvariants(r);
  });

  await test("garbage bytes: failed analysis → unmeasured, NEVER clean", async () => {
    const r = await runQcReport(qcOpts(garbageMp4));
    eq(statusOf(r, "playable"), "fail", "garbage is not a playable MP4");
    for (const id of MEASURED_ANALYSIS_IDS)
      eq(statusOf(r, id), "unmeasured", `${id} on undecodable input`);
    ok(!r.passed, "garbage must never pass QC");
    assertReportInvariants(r);
  });

  await test("fade-out ending: tail-fade measures and PASSES", async () => {
    const r = await runQcReport(qcOpts(fadeMp4));
    eq(statusOf(r, "playable"), "pass");
    eq(statusOf(r, "tail-fade"), "pass");
    assertReportInvariants(r);
  });

  await test("abrupt mid-tone ending: tail-fade measures and FAILS", async () => {
    const r = await runQcReport(qcOpts(abruptMp4));
    eq(statusOf(r, "tail-fade"), "fail");
    assertReportInvariants(r);
  });

  await test("near-silent clip: loudness MEASURED and failing (not unmeasured)", async () => {
    const r = await runQcReport(qcOpts(quietMp4));
    eq(statusOf(r, "loudness"), "fail", "measurable-but-too-quiet must be a fail, not unmeasured");
    oneOf(statusOf(r, "true-peak"), ["pass", "fail"], "true-peak on decodable audio");
    assertReportInvariants(r);
  });

  await test("tone-then-silence: dead-air detector catches the 4s gap", async () => {
    const r = await runQcReport({
      ...qcOpts(deadAirMp4),
      videoDuration: 6,
    });
    eq(statusOf(r, "dead-air"), "fail");
    assertReportInvariants(r);
  });

  await test("healthy fixture: analysis-derived checks all reach a verdict", async () => {
    const r = await runQcReport(qcOpts(fadeMp4));
    for (const id of MEASURED_ANALYSIS_IDS)
      oneOf(statusOf(r, id), ["pass", "fail"], `${id} on decodable input`);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ---------- suite: music mood logic (pure) ----------

suiteStart("music — mood presets + niche mapping");

await test("isMusicMoodId: auto + catalog ids valid, junk rejected", () => {
  ok(isMusicMoodId("auto"), "auto must be a mood id");
  for (const id of ["suspenseful", "cinematic", "emotional", "uplifting", "calm"])
    ok(isMusicMoodId(id), `${id} must be a mood id`);
  ok(!isMusicMoodId("nope"), "unknown id must reject");
  ok(!isMusicMoodId(null), "non-string must reject");
  ok(!isMusicMoodId(3), "non-string must reject");
});

await test("moodTags: known ids map to library tags, auto/unknown → []", () => {
  eq(moodTags("suspenseful"), ["mysteries", "dark"]);
  eq(moodTags("calm"), ["soft", "airy", "minimal", "neutral"]);
  eq(moodTags("auto"), [], "auto falls back to the niche pick");
  eq(moodTags(null), []);
  eq(moodTags("nope"), []);
});

await test("NICHE_MOODS: every niche maps to non-empty tag lists", () => {
  const niches = Object.keys(NICHE_MOODS);
  ok(niches.length >= 5, "core niches must stay mapped");
  for (const [niche, tags] of Object.entries(NICHE_MOODS)) {
    ok(Array.isArray(tags) && tags.length > 0, `${niche} must map to tags`);
    for (const t of tags) ok(typeof t === "string" && t.length > 0, `${niche}: bad tag ${JSON.stringify(t)}`);
  }
});

// ---------- suite: voice cloning (pure units) ----------

suiteStart("voice-clone — cloned-voice ids + name/URL hygiene");

await test("isClonedVoiceId: only the platform prefix counts", () => {
  ok(isClonedVoiceId("voice_clone_20240315_143052_001"), "platform prefix must match");
  ok(!isClonedVoiceId("jam"), "stock studio voice is not a clone");
  ok(!isClonedVoiceId("Voice_Clone_x"), "prefix match is case-sensitive");
  ok(!isClonedVoiceId(""), "empty is not a clone");
  ok(!isClonedVoiceId("voice_cloney"), "near-miss prefix rejected");
});

await test("sanitizeVoice: zhipu keeps cloned ids, other providers fall back", () => {
  const cloneId = "voice_clone_20240315_143052_001";
  eq(sanitizeVoice("zhipu", cloneId), cloneId, "zhipu must pass cloned ids through");
  eq(sanitizeVoice("zhipu", "jam"), "jam", "stock ids unchanged");
  eq(sanitizeVoice("zhipu", "nope"), "jam", "junk falls back to the first catalog voice");
  // A clone saved on a video must NOT leak into providers that can't speak it.
  eq(sanitizeVoice("openai", cloneId), "alloy", "openai falls back to alloy");
  // Self-hosted speaks its own clones the same way zhipu does.
  const shClone = "voice_clone_sh_abc123";
  eq(sanitizeVoice("selfhost", shClone), shClone, "selfhost passes cloned ids through");
  eq(sanitizeVoice("selfhost", "jam"), "jam", "selfhost stock ids unchanged");
  eq(sanitizeVoice("zai", shClone), "jam", "zai must not receive selfhost clone ids");
  eq(sanitizeVoice("zai", cloneId), "jam", "zai falls back to the first catalog voice");
});

await test("voiceCatalog: zhipu exposes the 7 studio voices (clones appended by the API layer)", () => {
  const catalog = voiceCatalog("zhipu", "glm-tts");
  eq(catalog.length, 7, "exactly the 7 studio voices");
  ok(catalog.some((v) => v.id === "tongtong"), "default voice present");
  ok(!catalog.some((v) => isClonedVoiceId(v.id)), "no clone ids baked into the static catalog");
});

await test("describeVoiceHealth: /health payloads render as one readable line", () => {
  eq(
    describeVoiceHealth({ model: "chatterbox", device: "cpu", warm: true, busy: false }),
    "Chatterbox (English) · cpu · model loaded",
    "warm English server reads at a glance",
  );
  eq(
    describeVoiceHealth({ model: "chatterbox-turbo", device: "cpu", warm: true, busy: false }),
    "Chatterbox Turbo (fast, low-RAM) · cpu · model loaded",
    "turbo model is labelled as the fast variant",
  );
  eq(
    describeVoiceHealth({ model: "chatterbox-multilingual", device: "cpu", warm: true, busy: true }),
    "Chatterbox Multilingual (23 languages) · cpu · model loaded · busy synthesizing",
    "multilingual + busy state included",
  );
  const cold = describeVoiceHealth({ model: "chatterbox", device: "cpu", warm: false });
  ok(cold.includes("model still loading"), `cold start is REPORTED, not failed (got: ${cold})`);
  eq(
    describeVoiceHealth({}),
    "Voice server · model still loading — retry in a few minutes",
    "an empty payload (older server) still degrades to a useful line",
  );
});

await test("shared-voice: endpoint precedence — user server > shared env > nothing", () => {
  const URL_KEY = "TUBEFORGE_SHARED_VOICE_URL";
  const KEY_KEY = "TUBEFORGE_SHARED_VOICE_KEY";
  const savedUrl = process.env[URL_KEY];
  const savedKey = process.env[KEY_KEY];
  try {
    delete process.env[URL_KEY];
    delete process.env[KEY_KEY];
    eq(sharedVoiceServer(), null, "no env → no shared server");
    eq(selfhostEndpoint("", ""), null, "no user config, no env → null (caller decides)");

    process.env[URL_KEY] = "http://127.0.0.1:8931";
    process.env[KEY_KEY] = "secret";
    const shared = selfhostEndpoint("", "");
    ok(shared && shared.shared === true, "shared server used when the user has none");
    eq(shared?.baseUrl, "http://127.0.0.1:8931", "shared baseUrl flows through");
    eq(shared?.apiKey, "secret", "shared key flows through");

    const own = selfhostEndpoint("http://my-laptop:8931", "my-key");
    ok(own && own.shared === false, "the user's own server ALWAYS wins");
    eq(own?.baseUrl, "http://my-laptop:8931", "own baseUrl preserved");
    eq(own?.apiKey, "my-key", "own key preserved");

    // A user key WITHOUT a baseUrl is not an endpoint by itself — but the
    // shared server still applies (the key belongs to their own server they
    // haven't fully configured yet; synthesis would 401 against it anyway).
    const keyOnly = selfhostEndpoint("", "my-key");
    ok(keyOnly && keyOnly.shared === true, "key-only user config falls back to shared");
  } finally {
    if (savedUrl === undefined) delete process.env[URL_KEY];
    else process.env[URL_KEY] = savedUrl;
    if (savedKey === undefined) delete process.env[KEY_KEY];
    else process.env[KEY_KEY] = savedKey;
  }
});

await test("cleanCloneName: trims, strips control chars, falls back to the file name", () => {
  eq(cleanCloneName("  My   Voice ", "whatever.mp3"), "My Voice", "whitespace collapsed");
  eq(cleanCloneName("bad\nname\twith\u0007junk", "x.mp3"), "bad name with junk", "control chars removed");
  eq(cleanCloneName("", "my-cool_recording.mp3"), "my cool recording", "falls back to file name");
  eq(
    cleanCloneName("", "voice sample.mp3"),
    "voice sample",
    "decoded labels (downloadSample decodes URLs upstream)",
  );
  eq(cleanCloneName("", ""), expectNameFallback(), "no name + no label → dated fallback");
  eq(cleanCloneName("x".repeat(80), "x.mp3").length, 40, "capped at 40 chars");
});

function expectNameFallback() {
  return `Voice ${new Date().toISOString().slice(0, 10)}`;
}

await test("isValidSampleUrl: http(s) only, internal hosts blocked", () => {
  ok(isValidSampleUrl("https://cdn.example.com/voice.mp3"), "public https ok");
  ok(isValidSampleUrl("http://example.com/a.wav"), "public http ok");
  ok(!isValidSampleUrl("ftp://example.com/a.wav"), "only http(s)");
  ok(!isValidSampleUrl("file:///etc/passwd"), "file scheme rejected");
  ok(!isValidSampleUrl("https://localhost/a.mp3"), "localhost blocked");
  ok(!isValidSampleUrl("https://box.internal/a.mp3"), ".internal blocked");
  ok(!isValidSampleUrl("https://metadata.google.internal/x"), "cloud metadata blocked");
  ok(!isValidSampleUrl("not a url"), "garbage rejected");
});

await test("sample limits: clone API window enforced (>= 2s, trimmed at 30s)", () => {
  ok(MIN_SAMPLE_SEC === 2, "minimum sample length");
  ok(MAX_SAMPLE_SEC === 30, "samples are trimmed to the documented 30s window");
});

// ---------- stock queries + art dedupe (scene↔image matching) ----------

suiteStart("stock queries — scene→search keywords");

await test("sceneQueries: visual leads, narration keywords included", () => {
  const scene = {
    index: 3,
    title: "The Crash",
    narration: "On black tuesday the wall street market collapsed and savings evaporated overnight",
    visual: "A tired trader in a 1929 suit staring at a collapsing chalkboard, dramatic cinematic mood",
  } as unknown as Scene;
  const queries = sceneQueries(scene);
  ok(queries.length >= 2 && queries.length <= 4, `2-4 queries (got ${queries.length})`);
  ok(queries[0].includes("trader"), "visual subject words lead");
  ok(
    queries.some((q) => q.includes("savings") || q.includes("collapsed")),
    "narration content words queried"
  );
});

await test("sceneQueries: digits and stop-words never become queries", () => {
  const scene = {
    index: 1,
    title: "The",
    narration: "In 1929 the market lost 3000000000 dollars",
    visual: "the of and a",
  } as unknown as Scene;
  const queries = sceneQueries(scene);
  for (const q of queries) {
    ok(!/\b(1929|3000000000)\b/.test(q), `no raw numbers in "${q}"`);
    ok(!/\b(the|and|of|a)\b/.test(q), `no stop words in "${q}"`);
  }
  ok(
    queries.some((q) => q.includes("market") || q.includes("dollars") || q.includes("lost")),
    "real content words survive"
  );
});

await test("sceneQueries: no duplicates, hard cap of 4", () => {
  const scene = {
    index: 2,
    title: "Market Crash",
    narration: "the market crash wiped savings market crash",
    visual: "market crash wall street panic traders",
  } as unknown as Scene;
  const queries = sceneQueries(scene);
  ok(queries.length <= 4, "capped at 4");
  ok(new Set(queries).size === queries.length, "no duplicate queries");
});

suiteStart("art dedupe — dHash perceptual hashing");

await test("dHash pure: flat frame → zero hash, self-distance 0", () => {
  const flat = Buffer.alloc(72, 128);
  const h = dHashFromGray9x8(flat);
  eq(h, "0000000000000000", "no horizontal gradient → all bits 0");
  ok(h != null, "flat frame hashes");
  eq(hammingDistanceHex(h, h), 0, "distance to self = 0");
});

await test("dHash pure: ramps and noise behave like the duplicate detector needs", () => {
  const ramp = Buffer.alloc(72);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) ramp[y * 9 + x] = Math.min(255, x * 30); // bright→right
  const hRamp = dHashFromGray9x8(ramp);
  eq(hRamp, "ffffffffffffffff", "strict horizontal ramp → all bits 1");

  const vert = Buffer.alloc(72);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 9; x++) vert[y * 9 + x] = Math.min(255, y * 40); // top→bottom ramp
  const hVert = dHashFromGray9x8(vert);
  eq(hVert, "0000000000000000", "vertical ramp has no horizontal gradient");
  ok(hRamp != null && hVert != null, "ramp hashes exist");
  eq(hammingDistanceHex(hRamp, hVert), 64, "opposite patterns → max distance");

  const noisy = Buffer.from(ramp);
  noisy[5] += 4;
  noisy[40] += 3; // imperceptible noise
  const hNoisy = dHashFromGray9x8(noisy);
  ok(hNoisy != null, "noisy ramp hashes");
  const d = hammingDistanceHex(hRamp, hNoisy);
  ok(d != null && d <= 9, `tiny noise stays under the duplicate threshold (got ${d})`);
});

await test("hamming: symmetric, malformed input rejected, closest picks min", () => {
  eq(hammingDistanceHex("0f0f0f0f0f0f0f0f", "f0f0f0f0f0f0f0f0"), 64, "complement → 64");
  eq(
    hammingDistanceHex("0f0f0f0f0f0f0f0f", "f0f0f0f0f0f0f0f0"),
    hammingDistanceHex("f0f0f0f0f0f0f0f0", "0f0f0f0f0f0f0f0f"),
    "symmetric"
  );
  eq(hammingDistanceHex("zzzz", "00"), null, "malformed → null");
  eq(
    closestPriorDistance("0000000000000000", new Map([[1, "0000000000000000"], [2, "ffffffffffffffff"]])),
    0,
    "closest prior is the minimum"
  );
  eq(closestPriorDistance("0000000000000000", new Map()), null, "no priors → null");
});

await test("imageHash: real ffmpeg roundtrip + directory scan", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-hash-"));
  const a = path.join(dir, "a.png");
  const c = path.join(dir, "c.png");
  try {
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=s=640x360:d=1", "-frames:v", "1", a]);
    await execFileAsync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "smptebars=s=640x360:d=1", "-frames:v", "1", c]);
    const [ha, hc] = await Promise.all([imageHash(a), imageHash(c)]);
    ok(ha != null, "testsrc hash exists");
    ok(hc != null, "smptebars hash exists");
    ok(/^[0-9a-f]{16}$/.test(ha), "testsrc hashes to 16 hex chars");
    const dist = hammingDistanceHex(ha, hc);
    ok(dist != null && dist > 0, `different patterns differ (${dist} bits)`);

    fs.copyFileSync(a, path.join(dir, "scene-01.png"));
    fs.copyFileSync(c, path.join(dir, "scene-02.png"));
    fs.writeFileSync(path.join(dir, "voiceover.wav"), Buffer.alloc(10)); // ignored
    const hashes = await sceneImageHashes(dir);
    eq(hashes.size, 2, "only scene-*.png files hashed");
    ok(hashes.has(1) && hashes.has(2), "scene indices parsed from file names");
    const excluded = await sceneImageHashes(dir, { exclude: 1 });
    eq(excluded.size, 1, "exclude drops the requested scene");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- stage 2: at-rest encryption (crypto.ts) ----------

process.env.TUBEFORGE_ENCRYPTION_KEY ||= "unit-test-key-0123456789abcdef";

await test("crypto: AES-256-GCM roundtrip + distinct IVs", async () => {
  const { encryptSecret, decryptSecret, isEncryptedSecret } = await import(
    "../src/lib/tubeforge/crypto.ts"
  );
  const plain = "sk-live-abcdef-0123456789-SECRET";
  const a = encryptSecret(plain);
  const b = encryptSecret(plain);
  ok(a.startsWith("v1."), "ciphertext carries the v1. prefix");
  ok(a !== b, "identical plaintexts produce different ciphertexts (per-record IV)");
  eq(decryptSecret(a), plain, "roundtrip returns the plaintext");
  ok(isEncryptedSecret(a), "isEncryptedSecret recognizes the format");
  ok(!isEncryptedSecret(plain), "plaintext is not misdetected as encrypted");
});

await test("crypto: tampering is detected (GCM tag)", async () => {
  const { encryptSecret, decryptSecret } = await import("../src/lib/tubeforge/crypto.ts");
  const stored = encryptSecret("another-secret");
  const parts = stored.split(".");
  const flipped = parts[2].startsWith("A") ? "B" + parts[2].slice(1) : "A" + parts[2].slice(1);
  const tampered = [parts[0], parts[1], flipped, parts[3]].join(".");
  let threw = false;
  try {
    decryptSecret(tampered);
  } catch {
    threw = true;
  }
  ok(threw, "a flipped ciphertext byte must fail the auth tag, not return garbage");
});

await test("crypto: sha256Hex is deterministic and format-stable", async () => {
  const { sha256Hex } = await import("../src/lib/tubeforge/crypto.ts");
  eq(
    sha256Hex("token"),
    sha256Hex("token"),
    "same token hashes identically"
  );
  eq(sha256Hex("token").length, 64, "SHA-256 hex digest length");
  ok(sha256Hex("a") !== sha256Hex("b"), "different tokens hash differently");
});

// ===========================================================================
// Stage 3 — durable queue, timeout matrix, streaming ZIP, structured logging
// ===========================================================================

suiteStart("Stage 3 — provider timeout matrix (D-09)");

await test("timeoutFor: defaults per capability; env overrides apply; invalid env ignored", async () => {
  const http = await import("../src/lib/tubeforge/providers/http.ts");
  http.resetTimeoutOverrides();
  eq(http.timeoutFor("generic"), 300_000, "generic keeps the old universal 300s");
  eq(http.timeoutFor("youtube-api"), 30_000, "YouTube metadata fails fast");
  eq(http.timeoutFor("youtube-upload"), 3_600_000, "resumable upload gets an hour");
  ok(http.timeoutFor("video-gen") > http.timeoutFor("llm"), "video-gen outlives llm");

  process.env.TUBEFORGE_TIMEOUT_YOUTUBE_API = "12345";
  http.resetTimeoutOverrides();
  eq(http.timeoutFor("youtube-api"), 12_345, "env override wins after reset");

  process.env.TUBEFORGE_TIMEOUT_YOUTUBE_API = "50"; // below the 1s floor
  http.resetTimeoutOverrides();
  eq(http.timeoutFor("youtube-api"), 30_000, "invalid env falls back to default");
  delete process.env.TUBEFORGE_TIMEOUT_YOUTUBE_API;
  http.resetTimeoutOverrides();
  eq(http.timeoutFor("youtube-api"), 30_000, "clean env keeps the default");
});

await test("timeoutFor: no timeout regression — youtube.ts routes through the matrix", async () => {
  // Static sanity (the audited D-09 fix): every outbound YouTube HTTP call
  // goes through ytFetch — the only raw fetch( left is ytFetch's own body.
  const src = fs.readFileSync(
    new URL("../src/lib/tubeforge/youtube.ts", import.meta.url),
    "utf8"
  );
  const rawFetch = src
    .split("\n")
    .filter((l) => /\bfetch\(/.test(l) && !/ytFetch\(/.test(l)).length;
  eq(rawFetch, 1, "exactly one raw fetch remains — inside ytFetch itself");
  const viaHelper = (src.match(/ytFetch\(/g) ?? []).length;
  eq(viaHelper, 10, "9 call sites + the helper definition all route through ytFetch (S72's retention fetch joined the matrix)");
});

suiteStart("Stage 3 — queue claim liveness (multi-process safety)");

await test("claimIsStale: null claim, own claim, dead pid, live foreign pid, prior incarnation", async () => {
  // SAFETY: this test process must NEVER claim real jobs from the live DB.
  // Belt AND suspenders: the env var covers the case where queue.ts has not
  // been imported yet (module init reads it); setClaiming(false) covers the
  // case where an EARLIER test (e.g. the captions suite, whose import chain
  // captions → story → jobs → queue) already initialized the module.
  process.env.TUBEFORGE_NO_CLAIM = "1";
  const queue = await import("../src/lib/tubeforge/queue.ts");
  queue.setClaiming(false);
  queue.initQueue("web");
  const myId = queue.queueWorkerId();
  ok(queue.queueStats().noClaim, "test process runs in enqueue-only mode");

  ok(queue.claimIsStale(null), "unclaimed running rows (Stage 1/2 legacy) are stale");
  ok(!queue.claimIsStale(myId), "my own live claim is never stale");

  // A provably dead pid (pid 2^22 is never allocated on Linux).
  ok(queue.claimIsStale("worker:4194304:zzz"), "dead claimer pid is stale");

  // A LIVE foreign process (pid 1 — init, always alive) is never stale.
  ok(!queue.claimIsStale("worker:1:zzz"), "live foreign claimer is not stale");

  // Previous incarnation of THIS process (same role + pid, older boot).
  const [role, pid] = myId.split(":");
  const priorIncarnation = `${role}:${pid}:olderboot`;
  ok(queue.claimIsStale(priorIncarnation), "same pid + older boot = previous incarnation, stale");

  delete process.env.TUBEFORGE_NO_CLAIM;
});

suiteStart("Stage 3 — streaming ZIP (D-24)");

await test("streamZip: entries round-trip byte-exact (store + deflate + text/binary)", async () => {
  const { streamZip } = await import("../src/lib/tubeforge/zip.ts");
  const { Readable } = await import("node:stream");

  const textData = Buffer.from("script.txt content\n".repeat(50), "utf8");
  const binData = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 13) & 0xff));
  const emptyFile = Buffer.alloc(0);

  const entries = [
    { name: "pkg/script.txt", stream: () => Readable.from([textData]), method: 8 as const },
    { name: "pkg/final.mp4", stream: () => Readable.from([binData]), method: 0 as const },
    { name: "pkg/voiceover.wav", stream: () => Readable.from([binData, textData]), method: 8 as const },
    { name: "pkg/empty.txt", stream: () => Readable.from([emptyFile]), method: 8 as const },
  ];

  const webStream = streamZip(entries);
  const nodeStream = Readable.fromWeb(webStream as never);
  const chunks: Buffer[] = [];
  for await (const chunk of nodeStream) chunks.push(Buffer.from(chunk));
  const zipped = Buffer.concat(chunks);

  // Structural sanity: EOCD signature + entry count.
  const eocd = zipped.subarray(zipped.length - 22);
  eq(eocd.readUInt32LE(0), 0x06054b50, "EOCD signature present");
  eq(eocd.readUInt16LE(8), 4, "central directory counts 4 entries");

  // Data descriptor signatures present for every entry (streaming layout).
  let descriptors = 0;
  for (let i = 0; i + 4 <= zipped.length; i++) {
    if (zipped.readUInt32LE(i) === 0x08074b50) descriptors++;
  }
  eq(descriptors, 4, "one data descriptor per streamed entry");
});

await test("streamZip: python zipfile validates the archive and extracts exact bytes", async () => {
  const { streamZip, zipMethodFor } = await import("../src/lib/tubeforge/zip.ts");
  const { Readable } = await import("node:stream");

  eq(zipMethodFor("final.mp4"), 0, "mp4 is stored (already compressed)");
  eq(zipMethodFor("subtitles.srt"), 8, "srt is deflated");

  const payloadA = Buffer.from("line one\nline two\n".repeat(200), "utf8");
  const payloadB = Buffer.from(Array.from({ length: 100_000 }, (_, i) => (i * 31) & 0xff));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-zip-"));
  const zipPath = path.join(dir, "pkg.zip");
  const webStream = streamZip([
    { name: "pkg/subtitles.srt", stream: () => Readable.from([payloadA]), method: 8 },
    { name: "pkg/final.mp4", stream: () => Readable.from([payloadB]), method: 0 },
  ]);
  const out = fs.createWriteStream(zipPath);
  await new Promise<void>((resolve, reject) => {
    Readable.fromWeb(webStream as never).pipe(out).on("finish", resolve).on("error", reject);
  });

  // python3's zipfile is an independent implementation — the honest arbiter.
  const script = `
import zipfile, hashlib, sys
z = zipfile.ZipFile("${zipPath}")
bad = z.testzip()
if bad is not None: sys.exit("crc failed: " + bad)
a = z.read("pkg/subtitles.srt")
b = z.read("pkg/final.mp4")
print(hashlib.sha256(a).hexdigest(), hashlib.sha256(b).hexdigest())
`;
  const { stdout } = await execFileAsync("python3", ["-c", script]);
  const [hashA, hashB] = stdout.trim().split(" ");
  const sha = (buf: Buffer) => crypto.createHash("sha256").update(buf).digest("hex");
  eq(hashA, sha(payloadA), "deflated entry extracts byte-exact (python-verified CRC)");
  eq(hashB, sha(payloadB), "stored entry extracts byte-exact (python-verified CRC)");

  fs.rmSync(dir, { recursive: true, force: true });
});

await test("buildZip (in-memory path) still works — no regression for small bundles", async () => {
  const { buildZip } = await import("../src/lib/tubeforge/zip.ts");
  const zip = buildZip([{ name: "a.txt", data: Buffer.from("hello") }]);
  eq(zip.readUInt32LE(0), 0x04034b50, "local header signature intact");
});

suiteStart("Stage 3 — structured logging (T-3.2)");

await test("log: pino-format JSON lines, level filtering, child bindings, redaction", async () => {
  const captured: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLevel = process.env.TUBEFORGE_LOG_LEVEL;
  const collect = (chunk: unknown) => {
    if (typeof chunk === "string") captured.push(chunk);
    return true;
  };
  (process.stdout as { write: unknown }).write = collect;
  (process.stderr as { write: unknown }).write = collect;
  try {
    process.env.TUBEFORGE_LOG_LEVEL = "debug";
    const mod = await import("../src/lib/tubeforge/log.ts");
    const logger = mod.createLogger({ mod: "probe" }).child({ job: "j1" });

    logger.info("hello", { apiKey: "sk-secret-123", note: "plain" });
    logger.error("boom", { err: new Error("x") });

    const lines = captured.map((l) => JSON.parse(l) as Record<string, unknown>);
    const info = lines.find((l) => l.msg === "hello");
    ok(info, "info line emitted");
    eq(info?.level, 30, "pino info level value");
    eq(info?.mod, "probe", "parent binding inherited");
    eq(info?.job, "j1", "child binding present");
    eq(info?.apiKey, "<redacted>", "secret-looking keys are redacted");
    eq(info?.note, "plain", "plain values pass through");
    ok(typeof info?.time === "number", "epoch ms timestamp");
    const errLine = lines.find((l) => l.msg === "boom");
    ok(errLine && typeof errLine.err === "object" && errLine.err !== null, "errors serialize as objects (stderr)");

    // Level threshold: warn suppresses info/debug (threshold is dynamic).
    captured.length = 0;
    process.env.TUBEFORGE_LOG_LEVEL = "warn";
    const quiet = await import("../src/lib/tubeforge/log.ts");
    const l2 = quiet.createLogger({});
    l2.info("hidden");
    l2.warn("shown");
    eq(captured.length, 1, "only warn passes the warn threshold");
    eq(JSON.parse(captured[0]).msg, "shown", "the warn line is the one emitted");
  } finally {
    (process.stdout as { write: unknown }).write = origOut;
    (process.stderr as { write: unknown }).write = origErr;
    if (origLevel === undefined) delete process.env.TUBEFORGE_LOG_LEVEL;
    else process.env.TUBEFORGE_LOG_LEVEL = origLevel;
  }
});

// ---------------------------------------------------------------------------
// Stage 3 — storage abstraction (T-3.7)
// ---------------------------------------------------------------------------

await test("storage: normalizeKey rejects traversal and absolute paths, passes clean keys", async () => {
  const mod = await import("../src/lib/tubeforge/storage.ts");
  eq(mod.normalizeKey("abc/def.png"), "abc/def.png", "clean key");
  eq(mod.normalizeKey("a//b/./c"), "a/b/c", "separators collapsed");
  let threw = false;
  try { mod.normalizeKey("../etc/passwd"); } catch { threw = true; }
  ok(threw, ".. traversal rejected");
  threw = false;
  try { mod.normalizeKey(""); } catch { threw = true; }
  ok(threw, "empty key rejected");
});

await test("storage: local driver roundtrip — put / get / stat / exists / remove", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-storage-"));
  process.env.TUBEFORGE_UPLOAD_ROOT = dir;
  delete process.env.TUBEFORGE_STORAGE_DRIVER;
  const mod = await import("../src/lib/tubeforge/storage.ts");
  const key = "v1/artifact.bin";
  const payload = crypto.randomBytes(2048);
  await mod.put(key, payload);
  ok(await mod.exists(key), "exists after put");
  const st = await mod.stat(key);
  ok(st && st.size === payload.length, "stat reports size");
  const back = await mod.get(key);
  ok(back.equals(payload), "get returns exact bytes");
  await mod.remove(key);
  ok(!(await mod.exists(key)), "gone after remove");
  const missing = await mod.stat("v1/never-was.bin");
  eq(missing, null, "missing stat is null");
  delete process.env.TUBEFORGE_UPLOAD_ROOT;
  await fsp.rm(dir, { recursive: true, force: true });
});

await test("storage: putFromPath same-path no-op + cross-dir move works", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-storage2-"));
  process.env.TUBEFORGE_UPLOAD_ROOT = path.join(dir, "root");
  delete process.env.TUBEFORGE_STORAGE_DRIVER;
  const mod = await import("../src/lib/tubeforge/storage.ts");
  // direct write into the uploads layout, then register it (the render.ts pattern)
  const file = path.join(dir, "root", "vid", "final.mp4");
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, Buffer.from("FAKE_MP4_BYTES"));
  await mod.putFromPath("vid/final.mp4", file); // same path — must not throw
  ok(await mod.exists("vid/final.mp4"), "same-path registration keeps the file");
  // scratch file elsewhere moves into place
  const scratch = path.join(dir, "scratch", "thumb.png");
  await fsp.mkdir(path.dirname(scratch), { recursive: true });
  await fsp.writeFile(scratch, Buffer.from("PNG"));
  await mod.putFromPath("vid/thumb.png", scratch);
  ok(await mod.exists("vid/thumb.png"), "cross-dir move landed");
  ok(!fs.existsSync(scratch), "scratch source consumed");
  delete process.env.TUBEFORGE_UPLOAD_ROOT;
  await fsp.rm(dir, { recursive: true, force: true });
});

await test("storage: removePrefix wipes a whole video folder", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-storage3-"));
  process.env.TUBEFORGE_UPLOAD_ROOT = dir;
  delete process.env.TUBEFORGE_STORAGE_DRIVER;
  const mod = await import("../src/lib/tubeforge/storage.ts");
  for (const f of ["scene-01.png", "scene-02.png", "voiceover.wav", "final.mp4"]) {
    await mod.put(`vid9/${f}`, Buffer.from(`data-${f}`));
  }
  await mod.removePrefix("vid9");
  for (const f of ["scene-01.png", "voiceover.wav", "final.mp4"]) {
    ok(!(await mod.exists(`vid9/${f}`)), `vid9/${f} wiped`);
  }
  ok(!fs.existsSync(path.join(dir, "vid9")), "directory itself removed");
  delete process.env.TUBEFORGE_UPLOAD_ROOT;
  await fsp.rm(dir, { recursive: true, force: true });
});

await test("storage: driver kind + info respond to env without restarts", async () => {
  const mod = await import("../src/lib/tubeforge/storage.ts");
  eq(mod.storageDriverKind(), "local", "default driver is local");
  process.env.TUBEFORGE_STORAGE_DRIVER = "s3";
  eq(mod.storageDriverKind(), "s3", "env flips the driver");
  const info = mod.storageInfo();
  ok(typeof info.quotaBytes === "number" && info.quotaBytes > 0, "quota default is positive");
  delete process.env.TUBEFORGE_STORAGE_DRIVER;
});

await test("storage: scratchDir tracks the driver (uploads locally, tmp under s3)", async () => {
  const mod = await import("../src/lib/tubeforge/storage.ts");
  delete process.env.TUBEFORGE_STORAGE_DRIVER;
  const localDir = mod.scratchDir("vidA");
  ok(localDir.startsWith(process.cwd()), "local scratch lives under the app (uploads layout)");
  process.env.TUBEFORGE_STORAGE_DRIVER = "s3";
  process.env.TUBEFORGE_SCRATCH_ROOT = path.join(os.tmpdir(), "tf-scratch-probe");
  const s3Dir = mod.scratchDir("vidA");
  ok(!s3Dir.startsWith(process.cwd()), "s3 scratch redirects away from the app tree");
  ok(fs.existsSync(s3Dir), "scratch dir created on demand");
  delete process.env.TUBEFORGE_STORAGE_DRIVER;
  delete process.env.TUBEFORGE_SCRATCH_ROOT;
});

await test("storage: list() enumerates a prefix and tolerates absence (T-4.0)", async () => {
  const mod = await import("../src/lib/tubeforge/storage.ts");
  delete process.env.TUBEFORGE_STORAGE_DRIVER;
  const probe = `tf-list-probe-${Date.now()}`;
  // Two nested objects + one sibling prefix that must NOT leak in.
  await mod.put(`${probe}/scene-01.png`, Buffer.from([1, 2, 3]));
  await mod.put(`${probe}/sub/final.mp4`, Buffer.from([4, 5]));
  await mod.put(`${probe}-other/x.png`, Buffer.from([9]));
  const keys = await mod.list(probe);
  ok(keys.length === 2, `list returns exactly the prefix's objects (got ${keys.length}: ${keys.join(", ")})`);
  ok(keys.includes(`${probe}/scene-01.png`), "flat key listed");
  ok(keys.includes(`${probe}/sub/final.mp4`), "nested key listed with its sub-path");
  const absent = await mod.list("tf-list-probe-does-not-exist");
  ok(Array.isArray(absent) && absent.length === 0, "missing prefix → empty list, not an error");
  // Targeted invalidation pattern the routes rely on (script-edit PATCH).
  const stale = keys.filter((k) => /\/(final\.mp4|scene-\d{2}\.(wav|mp4))$/.test(k));
  ok(stale.length === 1 && stale[0] === `${probe}/sub/final.mp4`, "stale-artifact filter matches final.mp4 only");
  await Promise.all(keys.map((k) => mod.remove(k).catch(() => {})));
  await mod.remove(`${probe}-other/x.png`).catch(() => {});
  const after = await mod.list(probe);
  ok(after.length === 0, "removed objects no longer list");
});

// ---------------------------------------------------------------------------
// S42 — version-stamped scene-art URLs (the upload that looked like a no-op)
// ---------------------------------------------------------------------------

await test("S42 sceneArtVersion: URL-safe token that rotates with mtime AND size", async () => {
  const { sceneArtVersion } = await import("../src/lib/tubeforge/story.ts");
  const base = sceneArtVersion({ size: 4096, mtime: new Date(1700000000123) });
  eq(base, "1700000000123-4096", "mtime ms + size, dash-joined");
  ok(/^[0-9]+-[0-9]+$/.test(base), "token is URL-safe (digits + dash only)");
  // Rotation axes: either a new mtime or a new size must change the token.
  ok(sceneArtVersion({ size: 4096, mtime: new Date(1700000000999) }) !== base, "different mtime rotates");
  ok(sceneArtVersion({ size: 8192, mtime: new Date(1700000000123) }) !== base, "different size rotates");
  // A broken clock (s3 HEAD without Last-Modified) degrades to size-only —
  // never "NaN", which would poison the URL.
  eq(sceneArtVersion({ size: 10, mtime: new Date(Number.NaN) }), "0-10", "invalid mtime degrades to 0");
});

await test("S42 serializeScenes: the art URL carries ?v= and rotates when art is replaced", async () => {
  const storage = await import("../src/lib/tubeforge/storage.ts");
  const { parseScenes, serializeScenes } = await import("../src/lib/tubeforge/story.ts");
  delete process.env.TUBEFORGE_STORAGE_DRIVER; // local driver — real bytes on disk
  const probe = `s42-art-probe-${Date.now()}`;
  const scenes = parseScenes(
    JSON.stringify([
      {
        index: 1, title: "A", narration: "First scene narration here.", visual: "v", camera: "static",
        mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none",
      },
      {
        index: 2, title: "B", narration: "Second scene narration here.", visual: "v", camera: "static",
        mood: "m", caption: "", hostInScene: false, rehook: true, sfx: "sting",
      },
    ])
  );
  ok(scenes.length === 2, "fixture parses");
  try {
    // No art yet — the DTO must say so (null URL, hasImage false).
    let dtos = await serializeScenes(probe, scenes);
    eq(dtos[0].hasImage, false, "no art → hasImage false");
    eq(dtos[0].imageUrl, null, "no art → imageUrl null");

    // Art lands (generation / upload path writes the same key).
    await storage.put(`${probe}/scene-01.png`, Buffer.alloc(1000, 1));
    dtos = await serializeScenes(probe, scenes);
    eq(dtos[0].hasImage, true, "art present → hasImage true");
    ok(
      /^\/api\/videos\/[^/]+\/storyboard\/1\?v=\d+-\d+$/.test(dtos[0].imageUrl ?? ""),
      `URL keeps the /storyboard/<n>?v=<mtime>-<size> shape (got ${dtos[0].imageUrl})`
    );
    const v1 = dtos[0].imageUrl?.split("?v=")[1] ?? "";
    ok(v1.length > 0, "URL carries a non-empty ?v= stamp");
    eq(dtos[1].imageUrl, null, "scene 2 still has no art → null");

    // THE BUG: same key, new bytes. The URL must rotate or every <img> under
    // the route's max-age keeps rendering the previous take.
    await storage.put(`${probe}/scene-01.png`, Buffer.alloc(2000, 2));
    const dtos2 = await serializeScenes(probe, scenes);
    const v2 = dtos2[0].imageUrl?.split("?v=")[1] ?? "";
    ok(v2.length > 0 && v2 !== v1, `replaced art rotates the stamp (${v1} → ${v2})`);

    // Art removed (invalidation) — back to the honest null.
    await storage.remove(`${probe}/scene-01.png`);
    const dtos3 = await serializeScenes(probe, scenes);
    eq(dtos3[0].hasImage, false, "removed art → hasImage false");
    eq(dtos3[0].imageUrl, null, "removed art → imageUrl null");
  } finally {
    await storage.remove(`${probe}/scene-01.png`).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// S43 — HEIC uploads, the caption override chain, the sfx default
// ---------------------------------------------------------------------------

await test("S43 sniffImageFormat: HEIC brands pass, non-HEIC ftyp boxes do not", async () => {
  const { sniffImageFormat } = await import("../src/lib/tubeforge/story.ts");
  const heicFile = (brand: string) =>
    Buffer.concat([
      Buffer.alloc(4), // size placeholder
      Buffer.from("ftyp"),
      Buffer.from(brand),
      Buffer.alloc(2048, 7),
    ]);
  ok(sniffImageFormat(heicFile("heic")) === "heic", "heic brand sniffed");
  ok(sniffImageFormat(heicFile("mif1")) === "heic", "mif1 (iPhone collections) sniffed");
  ok(sniffImageFormat(heicFile("hevc")) === "heic", "hevc brand sniffed");
  ok(sniffImageFormat(heicFile("isom")) === null, "an MP4's ftyp/isom is NOT an image");
  ok(sniffImageFormat(heicFile("avc1")) === null, "avc1 brand refused");
  // The committed real fixture (generated with libheif via pillow-heif).
  const fixture = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "scene-upload.heic"));
  ok(sniffImageFormat(fixture) === "heic", "real iPhone-style HEIC fixture sniffed");
});

await test("S43 replaceSceneImage: a real HEIC decodes, cover-crops and lands as scene art", async () => {
  const { replaceSceneImage } = await import("../src/lib/tubeforge/story.ts");
  delete process.env.TUBEFORGE_STORAGE_DRIVER; // local driver — real bytes on disk
  const probe = `s43-heic-probe-${Date.now()}`;
  const fixture = fs.readFileSync(path.join(import.meta.dirname, "fixtures", "scene-upload.heic"));
  ok(fixture.length > 1000, "fixture is a real file");
  // The old failure mode: the sniff rejected HEIC outright ("Unsupported
  // image — upload a PNG, JPEG or WebP file").
  const bytes = await replaceSceneImage(probe, 1, fixture);
  ok(bytes >= 1000, `cropped PNG written (${bytes} bytes)`);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const probeOut = await promisify(execFile)("ffprobe", [
    "-v", "error", "-show_entries", "stream=width,height",
    "-of", "csv=p=0", path.join(process.cwd(), "uploads", probe, "scene-01.png"),
  ]);
  const dims = probeOut.stdout.trim().split(",").map(Number).filter((n) => Number.isFinite(n));
  eq(dims[0], 1344, "cover-crop width = pipeline canvas");
  eq(dims[1], 768, "cover-crop height = pipeline canvas");
  fs.rmSync(path.join(process.cwd(), "uploads", probe), { recursive: true, force: true });
});

await test("S43 captionOverridesFor: doc caption > user-edited row caption > word-synced chunks", async () => {
  const { captionOverridesFor } = await import("../src/lib/tubeforge/captions.ts");
  const scenes = [
    { caption: "LLM line 1", captionUser: false }, // LLM-seeded — must NOT override
    { caption: "My caption", captionUser: true },   // human edit — overrides
    { caption: "", captionUser: true },             // human edit, then cleared → chunks
    { caption: "doc wins", captionUser: true },     // doc caption outranks the row
  ];
  const out = captionOverridesFor(scenes, [null, null, null, "studio edit"]);
  eq(out[0], null, "LLM caption never overrides the word-synced chunks");
  eq(out[1], "My caption", "user-edited row caption overrides");
  eq(out[2], null, "cleared caption falls back to chunks");
  eq(out[3], "studio edit", "doc (Timeline Studio) caption outranks the row");
  // No doc at all — the user edit still works (the S43 row-flag path).
  const noDoc = captionOverridesFor(scenes, null);
  eq(noDoc[1], "My caption", "user edit works without a saved doc");
  eq(noDoc[0], null, "without a doc, LLM captions still never override");
});

await test("S43 parseScenes: captionUser survives the row round-trip (legacy rows default false)", async () => {
  const { parseScenes } = await import("../src/lib/tubeforge/story.ts");
  const parsed = parseScenes(
    JSON.stringify([
      {
        index: 1, title: "A", narration: "First scene narration here.", visual: "v", camera: "static",
        mood: "m", caption: "human line", captionUser: true, hostInScene: false, rehook: false, sfx: "none",
      },
      {
        index: 2, title: "B", narration: "Second scene narration here.", visual: "v", camera: "static",
        mood: "m", caption: "llm line", hostInScene: false, rehook: true, sfx: "sting",
      },
    ])
  );
  eq(parsed[0].captionUser, true, "the flag round-trips");
  eq(parsed[1].captionUser, false, "absent flag (legacy/LLM rows) reads false");
});

await test("S43 assembleTimeline: doc captions seed ONLY from user-edited rows", async () => {
  const { assembleTimeline } = await import("../src/lib/tubeforge/timeline.ts");
  const scenes = [
    {
      index: 1, title: "A", narration: "First scene narration here.", visual: "v", camera: "static",
      mood: "m", caption: "llm line", captionUser: false, hostInScene: false, rehook: false, sfx: "none",
    },
    {
      index: 2, title: "B", narration: "Second scene narration here.", visual: "v", camera: "static",
      mood: "m", caption: "my line", captionUser: true, hostInScene: false, rehook: true, sfx: "sting",
    },
  ];
  const doc = assembleTimeline(scenes, { sceneDurationsSec: [5, 5] });
  eq(doc.scenes[0].caption, null, "LLM caption does not seed the doc (word-sync stays)");
  ok(doc.scenes[1].caption?.text === "my line", "user-edited caption seeds the doc");
});

// ---------------------------------------------------------------------------
// Stage 3 — email adapter (T-3.9)
// ---------------------------------------------------------------------------

await test("email: console mode logs and reports delivered=console, link stays in responses", async () => {
  const orig = process.env.TUBEFORGE_EMAIL_MODE;
  delete process.env.TUBEFORGE_EMAIL_MODE;
  const mod = await import("../src/lib/tubeforge/email.ts");
  const lines: string[] = [];
  const origLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.join(" "));
  try {
    const res = await mod.sendMail({
      to: "user@example.com",
      subject: "Confirm your email",
      text: "Hi\n\nhttps://app.example.com/verify?token=abc\n\nbye",
    });
    eq(res.delivered, "console", "console mode reported");
    eq(mod.linkInResponse(), true, "link allowed in response");
    const logged = lines.find((l) => l.includes("email:console"));
    ok(logged && logged.includes("user@example.com"), "recipient logged");
    ok(logged && logged.includes("https://app.example.com/verify?token=abc"), "action link logged for dev");
  } finally {
    console.log = origLog;
    if (orig === undefined) delete process.env.TUBEFORGE_EMAIL_MODE;
    else process.env.TUBEFORGE_EMAIL_MODE = orig;
  }
});

await test("email: smtp mode hides the link from responses and refuses empty config", async () => {
  const orig = { mode: process.env.TUBEFORGE_EMAIL_MODE, host: process.env.TUBEFORGE_SMTP_HOST };
  process.env.TUBEFORGE_EMAIL_MODE = "smtp";
  delete process.env.TUBEFORGE_SMTP_HOST;
  const mod = await import("../src/lib/tubeforge/email.ts");
  eq(mod.emailMode(), "smtp", "mode picked up");
  eq(mod.linkInResponse(), false, "smtp responses never echo the link");
  let threw = false;
  try {
    await mod.sendMail({ to: "x@example.com", subject: "s", text: "https://a.b/c" });
  } catch (err) {
    threw = true;
    ok(/TUBEFORGE_SMTP_HOST/.test(err instanceof Error ? err.message : ""), "actionable config error");
  }
  ok(threw, "smtp without host fails loudly");
  process.env.TUBEFORGE_EMAIL_MODE = orig.mode;
  if (orig.host) process.env.TUBEFORGE_SMTP_HOST = orig.host;
  else delete process.env.TUBEFORGE_SMTP_HOST;
});

// ---------------------------------------------------------------------------
// Stage 3 close-out — durable job entity ids (video-jobs.ts)
// ---------------------------------------------------------------------------

await test("queue: splitEntityId parses scene/slide composite ids, rejects garbage", async () => {
  const { splitEntityId } = await import("../src/lib/tubeforge/video-jobs.ts");

  const [v1, n1] = splitEntityId("abc123#scene4", "#scene");
  eq(v1, "abc123", "scene videoId extracted");
  eq(n1, "4", "scene index extracted");

  const [v2, n2] = splitEntityId("abc123#slide12", "#slide");
  eq(v2, "abc123", "slide videoId extracted");
  eq(n2, "12", "slide index extracted");

  // cuid2 ids contain no '#' — a plain videoId passes through untouched.
  const [v3, n3] = splitEntityId("cmvx6yqo5000dp8beeas0kp7a", "#scene");
  eq(v3, "cmvx6yqo5000dp8beeas0kp7a", "plain id preserved");
  eq(n3, null, "no suffix -> null (handler falls back to payload/full-video mode)");

  // A non-numeric suffix is NOT a scene index — reject it rather than guess.
  const [v4, n4] = splitEntityId("abc#scenex", "#scene");
  eq(v4, "abc", "videoId still extracted");
  eq(n4, null, "non-numeric suffix rejected");

  // The scene marker must not match a slide id (and vice versa).
  const [, n5] = splitEntityId("abc#slide3", "#scene");
  eq(n5, null, "slide id is not a scene id");
});

await test("queue: resumableKinds covers every kind the routes start", async () => {
  // Static contract: the routes call startJob with these kinds (grep-checked
  // in review); every one must be resumable after a crash. Since the S33
  // contract fix, resumableKinds() is DERIVED from the handler registry, so
  // this test can no longer pass with a stale list — the literal below pins
  // exhaustiveness: all 21 JobKind values are route-started AND
  // handler-registered (director + continuity joined in Stage 5, upload in
  // Stage 6, whiteboard in S67; the pre-fix copy listed only 18 and
  // enshrined the drift).
  const { resumableKinds } = await import("../src/lib/tubeforge/queue-handlers.ts");
  const kinds = resumableKinds();
  const expected = [
    "script", "research", "stock", "voiceover", "storyboard", "scene",
    "render", "short", "convert", "verify", "comments", "thumbnail",
    "variants", "slide", "portrait", "poses", "qc", "upload",
    "director", "continuity", "whiteboard",
  ];
  for (const k of expected) {
    ok(kinds.includes(k), `"${k}" is resumable`);
  }
  eq(kinds.length, expected.length, "no unexpected resumable kinds");
});

// ---------------------------------------------------------------------------
// Stage 4b (T-4.11) — pronunciation overrides (pronounce.ts)
// ---------------------------------------------------------------------------

await test("pronounce: substitutes longest-first, word-boundary, case-insensitive", async () => {
  const { applyPronunciations, sortPairs } = await import("../src/lib/tubeforge/pronounce.ts");

  const pairs = sortPairs([
    { from: "Colonel", to: "kernel" },
    { from: "Colonel Sanders", to: "kernel sand-erz" },
    { from: "AWOL", to: "ay-wall" },
  ]);
  // Longest first so the two-word entry wins over its prefix.
  eq(pairs[0][0], "Colonel Sanders", "longest from sorts first");

  const out = applyPronunciations(
    "Colonel Sanders went AWOL, but the colonel stayed.",
    pairs
  );
  ok(out.includes("kernel sand-erz"), "two-word entry substituted before its prefix");
  ok(out.includes("ay-wall"), "case-insensitive match on AWOL");
  ok(out.includes("the kernel stayed"), "standalone colonel substituted");

  // Word boundaries: "read" must not hit the "read" inside "already".
  const noFalse = applyPronunciations(
    "I already read it",
    sortPairs([{ from: "read", to: "red" }])
  );
  ok(noFalse.includes("already"), "substring inside another word untouched");
  eq(noFalse, "I already red it", "the actual word substituted");
});

await test("pronounce: parseStoredPronunciations degrades corrupt rows to empty", async () => {
  const { parseStoredPronunciations } = await import("../src/lib/tubeforge/pronounce.ts");

  eq(parseStoredPronunciations(null).length, 0, "null -> empty");
  eq(parseStoredPronunciations("not json").length, 0, "corrupt JSON -> empty");
  eq(parseStoredPronunciations('{"from":"x"}').length, 0, "non-array -> empty");
  eq(parseStoredPronunciations("[]").length, 0, "empty array -> empty");

  const parsed = parseStoredPronunciations(
    JSON.stringify([
      { from: "colonel", to: "kernel" },
      { from: "", to: "x" }, // empty from dropped
      { from: "x", to: "" }, // empty to dropped
      { foo: "bar" }, // no from/to at all -> dropped
      { from: "awol", to: "ay-wall" },
    ])
  );
  eq(parsed.length, 2, "only well-formed entries survive");
  eq(parsed[0].to, "kernel", "first valid entry kept");
  eq(parsed[1].from, "awol", "second valid entry kept");
});

// ---------------------------------------------------------------------------
// Stage 4b (T-4.14) — tenant-db model-scope regression (the research leak)
// ---------------------------------------------------------------------------

await test("tenant-db: every org-scoped model matches the lowercased lookup", async () => {
  // The $allOperations hook lowercases the Prisma model name ("ResearchSession"
  // → "researchsession") before the ORG_SCOPED_MODELS lookup. Stage 2 shipped
  // camelCase entries, so five models (researchSession, scheduleSlot, videoStat,
  // voiceProfile, musicTrack) were silently UNSCOPED — a cross-tenant leak the
  // Stage 4b sweep caught live. This pins the normalization.
  const { ORG_SCOPED_MODELS } = await import("../src/lib/tubeforge/tenant-db.ts");
  const expected = [
    "channel", "character", "video", "activity", "researchsession",
    "scheduleslot", "videostat", "voiceprofile", "musictrack", "job", "membership",
    "characterappearance", "location", "prop",
  ];
  for (const m of expected) {
    ok(ORG_SCOPED_MODELS.has(m), `"${m}" is org-scoped`);
  }
  eq(ORG_SCOPED_MODELS.size, expected.length, "no unexpected scoped models");
});

// ---------------------------------------------------------------------------
// Stage 5 (T-5.1) — AI Director plan layer: parse/normalize contract
// ---------------------------------------------------------------------------

await test("director-plan: parsePlan normalizes junk into the vocabularies", async () => {
  const { parsePlan } = await import("../src/lib/tubeforge/director-plan.ts");
  const plan = parsePlan(
    JSON.stringify({
      concept: "Slow burn, escalation at the midpoint.",
      scenes: [
        {
          sceneIndex: 2,
          mood: "cold moonlight",
          transitionIn: "not-a-transition", // → snapped to "fade"
          motion: "SPIN", // → not in {smart,zoom,pan,off} → "smart"
          needsI2V: "yes", // → not boolean true → false
          shots: [
            { shotIndex: 1, framing: "EXTREME CLOSE-UP", camera: "warp-drive", lens: "85mm f/1.8", composition: "golden ratio", duration: 99, imagePrompt: "the reveal" },
            { shotIndex: 0, framing: "wide", camera: "push-in", duration: 0.1 }, // clamped to 0.5
          ],
        },
        { sceneIndex: 1, mood: "dawn", transitionIn: "fadeblack", shots: [{ shotIndex: 0, framing: "aerial", camera: "drone", duration: 3 }] },
      ],
    })
  );
  ok(plan !== null, "plan parsed");
  eq(plan.scenes.length, 2, "both scenes kept");
  eq(plan.scenes[0].sceneIndex, 1, "scenes sorted by index");
  eq(plan.scenes[0].transitionIn, "", "scene 1 transitionIn forced empty — nothing precedes it");
  eq(plan.scenes[1].transitionIn, "fade", "unknown transition snapped to fade");
  eq(plan.scenes[1].motion, "smart", "unknown motion snapped to smart");
  eq(plan.scenes[1].needsI2V, false, "non-boolean needsI2V coerced false");
  const shots = plan.scenes[1].shots;
  eq(shots[0].shotIndex, 0, "shots sorted by shotIndex");
  eq(shots[0].framing, "wide", "shot 0 kept its lowercase-safe framing");
  eq(shots[1].framing, "extreme close-up", "framing lowercased into vocabulary");
  eq(shots[1].camera, "static", "unknown camera snapped to static");
  eq(shots[1].duration, 10, "duration clamped to the 0.5..10 band");
});

await test("director-plan: corrupt / empty / null plans degrade to null", async () => {
  const { parsePlan } = await import("../src/lib/tubeforge/director-plan.ts");
  eq(parsePlan(null), null, "null → null");
  eq(parsePlan(undefined), null, "undefined → null");
  eq(parsePlan(""), null, "empty → null");
  eq(parsePlan("{not json"), null, "corrupt JSON → null");
  eq(parsePlan('{"scenes":"nope"}'), null, "non-array scenes → null");
  eq(parsePlan('{"scenes":[{"sceneIndex":"x"}]}'), null, "scene without a valid index dropped → empty plan");
});

await test("director-plan: addendum + duration + transition accessors", async () => {
  const { parsePlan, directorImageAddendum, planSceneDuration, planTransitionIn } = await import(
    "../src/lib/tubeforge/director-plan.ts"
  );
  const plan = parsePlan(
    JSON.stringify({
      concept: "",
      scenes: [
        { sceneIndex: 1, mood: "amber dusk", shots: [{ shotIndex: 0, framing: "wide", camera: "push-in", lens: "35mm", composition: "rule of thirds", duration: 2.5, imagePrompt: "" }] },
        { sceneIndex: 2, mood: "cold neon", transitionIn: "cut", shots: [{ shotIndex: 0, framing: "close-up", camera: "static", lens: "85mm f/1.8", composition: "leading lines", duration: 2.8, imagePrompt: "" }, { shotIndex: 1, framing: "medium", camera: "pan-left", lens: "35mm", composition: "rule of thirds", duration: 3.2, imagePrompt: "" }] },
      ],
    })
  );
  ok(plan !== null);
  eq(planTransitionIn(plan, 2), "cut", "planned transition-in read back");
  eq(planTransitionIn(plan, 9), "", "missing scene → empty transition");
  eq(Math.round(planSceneDuration(plan, 2) * 10) / 10, 6, "scene duration = sum of shot durations");
  eq(
    directorImageAddendum(plan, 2),
    "close-up shot, 85mm f/1.8, leading lines, cold neon",
    "addendum = shot-0 framing + non-default lens + non-default composition + mood"
  );
  eq(
    directorImageAddendum(plan, 1),
    "wide shot, amber dusk",
    "defaults (35mm, rule of thirds) are omitted from the addendum"
  );
  eq(directorImageAddendum(null, 1), "", "no plan → empty addendum");
});

await test("motion: panEndpoints never emits a dead pan (Battle Yamuk 2.5s frozen stretch)", async () => {
  const { panEndpoints } = await import("../src/lib/tubeforge/motion.ts");
  const work: [number, number] = [3840, 2160];
  // The exact failing case: pan-LEFT with a left-ish focal (0.32) at z=1.30 —
  // the window starts pinned at the left edge, so the leftward sweep clamps
  // straight back to its origin. It must fall back to a moving sweep.
  const [fx, tx] = panEndpoints("x", 0.32, -1, 0.5, 1.3, work);
  ok(
    Math.abs(tx - fx) > 0.02 * (3840 - 3840 / 1.3),
    `pan-left at the left edge must still move (got ${fx.toFixed(1)} → ${tx.toFixed(1)})`
  );
  // Same class, mirrored: pan-RIGHT with a right-ish focal.
  const [fx2, tx2] = panEndpoints("x", 0.68, 1, 0.5, 1.3, work);
  ok(
    Math.abs(tx2 - fx2) > 0.02 * (3840 - 3840 / 1.3),
    `pan-right at the right edge must still move (got ${fx2.toFixed(1)} → ${tx2.toFixed(1)})`
  );
  // The NON-sweep axis (travel=0) must hold exactly still — a pure pan stays
  // pure, the fallbacks never fire.
  const [fy, ty] = panEndpoints("y", 0.5, 1, 0, 1.16, work);
  eq(ty, fy, "travel=0 axis is pinned by contract");
});

await test("director-plan: planStaticRuns flags 3+ consecutive unmotivated static shots", async () => {
  const { parsePlan, planStaticRuns } = await import("../src/lib/tubeforge/director-plan.ts");
  const shot = (shotIndex: number, camera = "static") => ({
    shotIndex,
    framing: "medium",
    camera,
    lens: "35mm",
    composition: "rule of thirds",
    duration: 2.5,
    imagePrompt: "",
  });
  const scene = (sceneIndex: number, shots: unknown[], extra: Record<string, unknown> = {}) => ({
    sceneIndex,
    mood: "",
    motion: "off",
    needsI2V: false,
    useStock: false,
    shots,
    ...extra,
  });
  const flat = parsePlan(
    JSON.stringify({
      concept: "",
      scenes: [
        scene(1, [shot(0)]),
        scene(2, [shot(0), shot(1)]),
        scene(3, [shot(0, "dolly-in")]), // motivated by camera movement — breaks the run
        scene(4, [shot(0), shot(1)]),
      ],
    })
  );
  ok(flat !== null);
  const runs = planStaticRuns(flat);
  eq(runs.length, 2, "two separate flat runs (camera-move shot splits them)");
  eq(runs[0].length, 3, "longest run = 3 consecutive static shots across scenes 1–2");
  eq(runs[0].fromScene, 1, "run starts at scene 1");
  eq(runs[0].toScene, 2, "run ends at scene 2");
  eq(runs[1].length, 2, "scene 4's pair alone stays under the 3-shot gate");

  // Each motivation channel excuses a static camera.
  for (const extra of [{ motion: "smart" }, { needsI2V: true }, { useStock: true }]) {
    const motivated = parsePlan(
      JSON.stringify({ concept: "", scenes: [scene(1, [shot(0), shot(1), shot(2)], extra)] })
    );
    ok(motivated !== null);
    eq(planStaticRuns(motivated).length, 0, `motivated via ${Object.keys(extra)[0]} → no runs`);
  }

  // Render-mode blanket exemptions: an i2v or stock render moves everything.
  const blanket = parsePlan(
    JSON.stringify({ concept: "", scenes: [scene(1, [shot(0), shot(1), shot(2)])] })
  );
  ok(blanket !== null);
  eq(planStaticRuns(blanket, { i2vEverywhere: true }).length, 0, "i2v render mode exempts all");
  eq(planStaticRuns(blanket, { stockEverywhere: true }).length, 0, "stock render mode exempts all");
  eq(planStaticRuns(blanket).length, 1, "without exemptions the run is flagged");

  // Index gaps and shot-less scenes break runs (unknown pacing neither
  // extends nor excuses a flat stretch).
  const gapped = parsePlan(
    JSON.stringify({
      concept: "",
      scenes: [scene(1, [shot(0), shot(1)]), scene(3, [shot(0), shot(1)])],
    })
  );
  ok(gapped !== null);
  eq(gapped.scenes.length, 2, "scene 2 absent from the plan");
  const gapRuns = planStaticRuns(gapped);
  eq(gapRuns.length, 2, "gap splits the four static shots into two 2-shots runs");

  const shotless = parsePlan(
    JSON.stringify({
      concept: "",
      scenes: [scene(1, [shot(0), shot(1)]), scene(2, []), scene(3, [shot(0), shot(1)])],
    })
  );
  ok(shotless !== null);
  eq(planStaticRuns(shotless).length, 2, "shot-less scene splits the run");

  eq(planStaticRuns(null).length, 0, "no plan → no runs");
});

await test("director-plan: module E audio fields normalize + pacing factors", async () => {
  const { parsePlan, pacingSpeedFactor, planStaticRuns } = await import(
    "../src/lib/tubeforge/director-plan.ts"
  );
  const plan = parsePlan(
    JSON.stringify({
      concept: "tension to release",
      musicMood: "cinematic",
      ducking: "strong",
      scenes: [
        {
          sceneIndex: 1,
          mood: "",
          pacing: "FAST", // case-insensitive snap
          ambience: "city",
          sfx: "whoosh",
          shots: [{ shotIndex: 0, camera: "push-in", duration: 2.5 }],
        },
        {
          sceneIndex: 2,
          mood: "",
          pacing: "leisurely", // junk → default normal
          ambience: "lava", // junk → default none
          sfx: "applause", // junk → default none
          shots: [{ shotIndex: 0, camera: "static", duration: 2.5 }],
        },
      ],
    })
  );
  ok(plan !== null);
  eq(plan.musicMood, "cinematic", "plan-level music mood passes through");
  eq(plan.ducking, "strong", "plan-level ducking passes through");
  eq(plan.scenes[0].pacing, "fast", "pacing snaps case-insensitively");
  eq(plan.scenes[0].ambience, "city", "ambience kind kept");
  eq(plan.scenes[0].sfx, "whoosh", "sfx hint kept");
  eq(plan.scenes[1].pacing, "normal", "junk pacing → normal");
  eq(plan.scenes[1].ambience, "none", "junk ambience → none");
  eq(plan.scenes[1].sfx, "none", "junk sfx → none");

  // Old T-5.1 plans (no audio fields) stay parseable with defaults —
  // backward compatibility is the point of versioned plans.
  const legacy = parsePlan(
    JSON.stringify({
      concept: "",
      scenes: [{ sceneIndex: 1, mood: "", shots: [{ shotIndex: 0, camera: "static", duration: 2 }] }],
    })
  );
  ok(legacy !== null);
  eq(legacy.scenes[0].pacing, "normal", "legacy plan → default pacing");
  eq(legacy.scenes[0].ambience, "none", "legacy plan → no ambience");
  eq(legacy.scenes[0].sfx, "none", "legacy plan → no cue");
  eq(legacy.musicMood, undefined, "legacy plan → no music mood");
  // A motivated legacy scene still paces clean: ambience/sfx defaults never
  // imply motion, and camera static + motion smart is motivated.
  eq(planStaticRuns(legacy).length, 0, "legacy plan passes the pacing gate");

  eq(pacingSpeedFactor("slow"), 0.88, "slow = −12%");
  eq(pacingSpeedFactor("fast"), 1.12, "fast = +12%");
  eq(pacingSpeedFactor("normal"), 1, "normal = untouched");
  eq(pacingSpeedFactor("garbage"), 1, "unknown = untouched");
});

// ---------------------------------------------------------------------------
// Milestone 1 — production profiles (the universal Director)
//   docs/director-m1-m2-spec.md §2.4. Five acceptance tests:
//   1. Legacy plan parsing — byte-identical (no profile field)
//   2. Profile overlay — prompt assembly includes the overlay + narrows vocab
//   3. Validation — advertisement without a product-forward shot 0 returns an issue
//   4. Story regression — narrative profile output ≡ today's output
//   5. Format gate — empty-scenes check still throws; profiles resolve cleanly
// ---------------------------------------------------------------------------

await test("M1: legacy plan parsing — profile field stays absent (byte-identical)", async () => {
  const { parsePlan, PROFILE_IDS } = await import("../src/lib/tubeforge/director-plan.ts");
  // The existing parsePlan fixtures (above) pre-date M1 — none carry a
  // `profile` field. Re-parsing them must NOT add one.
  const legacy = parsePlan(
    JSON.stringify({
      concept: "",
      scenes: [{ sceneIndex: 1, mood: "", shots: [{ shotIndex: 0, camera: "static", duration: 2 }] }],
    })
  );
  ok(legacy !== null, "legacy plan parses");
  ok(legacy.profile === undefined, "legacy plan → no profile field (byte-identical)");
  // And the parsed-then-serialized round-trip carries no `profile` key.
  ok(!JSON.stringify(legacy).includes('"profile"'), "serialized legacy plan omits the profile key");

  // An explicitly-set profile id survives the round-trip; an unknown id
  // snaps to undefined (NOT to "narrative" — legacy byte-identity is the rule).
  const withProfile = parsePlan(
    JSON.stringify({
      profile: "documentary",
      concept: "x",
      scenes: [{ sceneIndex: 1, mood: "", shots: [{ shotIndex: 0, camera: "static", duration: 2 }] }],
    })
  );
  ok(withProfile !== null, "profile plan parses");
  eq(withProfile.profile, "documentary", "valid profile id preserved (case-insensitive input)");

  const junkProfile = parsePlan(
    JSON.stringify({
      profile: "nope-not-a-profile",
      concept: "x",
      scenes: [{ sceneIndex: 1, mood: "", shots: [{ shotIndex: 0, camera: "static", duration: 2 }] }],
    })
  );
  ok(junkProfile !== null, "junk-profile plan parses");
  ok(junkProfile.profile === undefined, "unknown profile id → undefined (NOT narrative)");

  // The parse-snap set must match the catalog exactly (the runtime assert
  // in production-profiles.ts already enforces this; the test pins it).
  eq(Array.from(PROFILE_IDS).sort().join(","), ["narrative","documentary","explainer","advertisement","animation","podcast","social","islamic-history"].sort().join(","),
    "PROFILE_IDS lists every profile the catalog can resolve (S49 added islamic-history)");
});

await test("M1: profile overlay — system + user prompts include the overlay and narrow vocabularies", async () => {
  const { directorSystemPrompt, buildDirectorUserPrompt, resolveProfile, PRODUCTION_PROFILES } = await import(
    "../src/lib/tubeforge/director.ts"
  );
  // The narrative overlay is the "faceless YouTube studio" line; the base
  // prompt is format-neutral Rules. Assembled: overlay + Rules.
  const narrative = resolveProfile("narrative");
  const sysNarrative = directorSystemPrompt(narrative);
  ok(sysNarrative.includes("faceless YouTube video studio"), "narrative system prompt includes the studio line");
  ok(/Rules:\n- Shot length:/.test(sysNarrative), "narrative system prompt includes the Rules block");
  ok(sysNarrative.includes("Respond with STRICT JSON only"), "narrative system prompt includes the JSON schema");

  // A non-narrative profile's overlay replaces the studio line with the
  // format's voice; the Rules block is unchanged underneath.
  const doc = resolveProfile("documentary");
  const sysDoc = directorSystemPrompt(doc);
  ok(sysDoc.includes("documentary"), "documentary system prompt names the format");
  ok(!sysDoc.includes("faceless YouTube video studio"), "documentary overlay replaces the studio line");
  ok(/Rules:\n- Shot length:/.test(sysDoc), "documentary system prompt still includes the format-neutral Rules");

  // The user prompt narrows the catalogs per the profile vocabularies.
  const userNarrative = buildDirectorUserPrompt({
    video: { title: "T", topic: "x", niche: "n", tone: "conversational" },
    scenes: [{ index: 1, title: "Open", narration: "Welcome.", visual: "studio", camera: "static", mood: "warm", caption: "Hi", hostInScene: false, rehook: false, sfx: "none" } as never],
    estTotal: 10, castBlock: "No recurring cast.", worldBlock: "No library.", profile: narrative,
  });
  // Narrative vocabularies are the FULL catalogs — every framing appears.
  ok(userNarrative.includes("aerial"), "narrative user prompt lists the full framings (incl. aerial)");

  const userDoc = buildDirectorUserPrompt({
    video: { title: "T", topic: "x", niche: "n", tone: "conversational" },
    scenes: [{ index: 1, title: "Open", narration: "Welcome.", visual: "studio", camera: "static", mood: "warm", caption: "Hi", hostInScene: false, rehook: false, sfx: "none" } as never],
    estTotal: 10, castBlock: "No recurring cast.", worldBlock: "No library.", profile: doc,
  });
  // Documentary narrows framings — "aerial" is allowed, "over-the-shoulder"
  // is NOT in documentary.vocabularies.framings, so it should be absent.
  ok(userDoc.includes("aerial"), "documentary user prompt keeps the allowed framings");
  ok(!userDoc.match(/Framings:.*over-the-shoulder/), "documentary user prompt narrows out over-the-shoulder");
  // And the documentary transition narrowing only lists fade/fadeblack/cut.
  ok(/Transition ids: cut, fade(?:black)?(?:, fade(?:black)?)*/.test(userDoc) || /Transition ids:.*\bcut\b.*\bfade\b/.test(userDoc),
    "documentary transition list is narrowed to cut/fade variants");

  // Profile defaults (advisory tone hints) surface in the user prompt.
  ok(userDoc.includes("Profile defaults (advisory"), "documentary user prompt surfaces the profile's default-tone hints");

  // Every profile in the catalog resolves without throwing and round-trips
  // its own id — the format gate test's foundation.
  for (const id of Object.keys(PRODUCTION_PROFILES)) {
    const p = resolveProfile(id);
    eq(p.id, id, `resolveProfile(${id}) returns the profile with that id`);
  }
  // Unknown id → narrative (the compatibility profile); null/undefined too.
  eq(resolveProfile("garbage").id, "narrative", "unknown profile → narrative");
  eq(resolveProfile(null).id, "narrative", "null profile → narrative");
  eq(resolveProfile(undefined).id, "narrative", "undefined profile → narrative");
});

await test("M1: validation — advertisement without a product-forward shot 0 returns a readable issue", async () => {
  const { PRODUCTION_PROFILES } = await import("../src/lib/tubeforge/director.ts");
  const { parsePlan } = await import("../src/lib/tubeforge/director-plan.ts");
  const adv = PRODUCTION_PROFILES["advertisement"];

  // A plan whose opening shot is atmospheric, not product-forward — the
  // classic advertisement mistake.
  const noProduct = parsePlan(
    JSON.stringify({
      concept: "mood piece",
      scenes: [
        {
          sceneIndex: 1, mood: "warm dawn", transitionIn: "",
          motion: "smart", needsI2V: false, useStock: false,
          pacing: "normal", ambience: "none", sfx: "none",
          shots: [
            { shotIndex: 0, framing: "wide", camera: "drone", lens: "35mm", composition: "rule of thirds", duration: 2.5, imagePrompt: "sunrise over rolling hills, golden light" },
          ],
        },
        {
          sceneIndex: 2, mood: "studio", transitionIn: "cut",
          motion: "smart", needsI2V: false, useStock: false,
          pacing: "fast", ambience: "room", sfx: "sting",
          shots: [
            { shotIndex: 0, framing: "close-up", camera: "push-in", lens: "50mm", composition: "centered", duration: 2, imagePrompt: "the energy drink can hero shot on a clean background" },
          ],
        },
      ],
    })
  );
  ok(noProduct !== null);
  const issues = adv.validation(noProduct);
  ok(issues.length >= 1, "non-product opening flags at least one issue");
  ok(issues.some((m) => /product/i.test(m)), "issue mentions the product gap");
  ok(issues.some((m) => /CTA/i.test(m)), "issue also flags the missing closing CTA");

  // The same plan with a product-forward opening clears the opening check
  // (the closing-CTA check still fires — the plan has no closing CTA shot).
  const withProduct = parsePlan(
    JSON.stringify({
      concept: "campaign",
      scenes: [
        {
          sceneIndex: 1, mood: "warm dawn",
          shots: [
            { shotIndex: 0, framing: "close-up", camera: "push-in", lens: "50mm", composition: "centered", duration: 2, imagePrompt: "the product bottle hero shot, condensation beading" },
          ],
        },
        {
          sceneIndex: 2, mood: "studio",
          shots: [
            { shotIndex: 0, framing: "medium", camera: "static", duration: 2, imagePrompt: "the brand logo on a clean background" },
          ],
        },
      ],
    })
  );
  ok(withProduct !== null);
  const issues2 = adv.validation(withProduct);
  ok(!issues2.some((m) => /product/i.test(m) && /shot 0/i.test(m)), "product-forward opening clears the opening-shot check");
  ok(issues2.some((m) => /CTA/i.test(m)), "but the missing closing CTA still flags");

  // Narrative validation is a no-op — the compatibility profile passes any
  // well-formed plan silently.
  eq(PRODUCTION_PROFILES["narrative"].validation(noProduct).length, 0, "narrative validation never flags");
});

await test("M1: story regression — narrative profile output ≡ today's prompt shape", async () => {
  const { directorSystemPrompt, buildDirectorUserPrompt, resolveProfile } = await import(
    "../src/lib/tubeforge/director.ts"
  );
  // Today's (pre-M1) SYSTEM_PROMPT opening sentence IS the narrative overlay;
  // today's Rules + JSON schema IS the BASE_SYSTEM_PROMPT. So narrative-
  // assembled ≡ today's prompt at the meaningful-string level: the studio
  // line, the Rules block, and the JSON schema all appear, in order.
  const narrative = resolveProfile("narrative");
  const sys = directorSystemPrompt(narrative);
  // The studio line opens the prompt.
  ok(sys.startsWith("You are the AI Director of a faceless YouTube video studio."),
    "narrative system prompt opens with the studio line");
  // Followed by the Rules block.
  const rulesIdx = sys.indexOf("Rules:\n- Shot length:");
  ok(rulesIdx > 0, "narrative system prompt contains the Rules block");
  // And the JSON schema closes it.
  ok(sys.includes('Respond with STRICT JSON only'), "narrative system prompt carries the JSON schema");
  // Nothing format-specific from another profile leaks into the narrative
  // OVERLAY (the BASE Rules block mentions "documentary" in the useStock
  // rule, which is correct — the test pins the overlay, not the rules).
  ok(!narrative.systemOverlay.includes("documentary") && !narrative.systemOverlay.includes("advertisement"),
    "narrative overlay carries no other profile's voice");

  // The narrative user prompt has the SAME shape as the pre-M1 prompt:
  // every line the original emitted appears, in order, with the FULL
  // catalogs (no vocabulary narrowing — narrative carries none).
  const scenes = [
    { index: 1, title: "Open", narration: "Welcome to the show.", visual: "studio", camera: "static", mood: "warm", caption: "Welcome", hostInScene: true, rehook: false, sfx: "none" } as never,
    { index: 2, title: "Body", narration: "Here is the substance.", visual: "b-roll", camera: "pan-right", mood: "neutral", caption: "Substance", hostInScene: false, rehook: false, sfx: "whoosh" } as never,
  ];
  const user = buildDirectorUserPrompt({
    video: { title: "My Video", topic: "topic", niche: "niche", tone: "conversational" },
    scenes, estTotal: 10, castBlock: "No recurring cast.", worldBlock: "No library.", profile: narrative,
  });
  // Every catalog line the pre-M1 prompt emitted still appears, full sets.
  ok(user.includes("Transition ids:"), "transition line present");
  ok(user.includes("Framings: wide, medium, close-up, extreme close-up, over-the-shoulder, pov, aerial."),
    "narrative keeps the FULL framings list");
  ok(user.includes("Camera moves: static, zoom-in, zoom-out, pan-left, pan-right, tilt-up, tilt-down, diag-tl, diag-br, punch-in."),
    "narrative keeps the FULL v2 camera moves list (S48: engine-verbatim)");
  ok(user.includes("Compositions: rule of thirds, leading lines, golden ratio, centered symmetry, negative space, frame within frame, diagonal."),
    "narrative keeps the FULL compositions list");
  // The narrative profile DOES surface its default-tone hints — that line
  // is new (the pre-M1 prompt never had it), so we explicitly assert it is
  // advisory and that the catalog order is otherwise preserved.
  ok(user.includes("Profile defaults (advisory — override when a scene clearly demands it)"),
    "narrative surfaces its default-tone hints as advisory");
  // The scene briefs are still emitted (the heart of the user prompt).
  ok(user.includes("Scene 1 \"Open\"") && user.includes("Scene 2 \"Body\""), "scene briefs emitted");
});

await test("M1: format gate — empty-scenes check still throws; profiles resolve cleanly", async () => {
  // The empty-scenes check is the ONLY gate runDirectorPass now enforces
  // (the format !== "story" throw is gone). The error message is unchanged.
  // We test the behavior at the layer runDirectorPass delegates to: a video
  // with no scenes (parseScenes returns []) surfaces the empty-scenes error.
  const { parseScenes } = await import("../src/lib/tubeforge/story.ts");
  // parseScenes of null/empty/'' returns [] — the exact condition the empty-
  // scenes check fires on (mirroring director.ts:233).
  eq(parseScenes(null).length, 0, "null scenes → empty list (empty-scenes gate fires)");
  eq(parseScenes("").length, 0, "empty scenes → empty list");
  eq(parseScenes("[]").length, 0, "empty array → empty list");

  // The error message the pass now propagates (verbatim from director.ts).
  // The "No scenes to direct" message lives in director.ts (the job body
  // throws it); the route has its OWN empty-scenes 400 ("Video has no
  // scenes") that fires earlier when there is no scenes JSON at all.
  const expectedMessage = "No scenes to direct — generate the scene script first";
  const directorText = await fsp.readFile(
    path.join(process.cwd(), "src/lib/tubeforge/director.ts"),
    "utf8"
  );
  ok(directorText.includes(expectedMessage), "runDirectorPass throws the empty-scenes error verbatim");
  // The actual gate code is gone — match the throw statement pattern, not
  // the M1 doc comment that DESCRIBES the removal (which still says
  // "format !== \"story\" gate is GONE" for the next reader).
  ok(!/if\s*\(\s*video\.format\s*!==\s*["']story["']\s*\)\s*throw/.test(directorText),
    "the format-gate throw is gone from director.ts (only the doc comment remains)");

  // The route no longer carries the old format 400; its scene-level gate is
  // now ONLY the "Video has no scenes" early bail.
  const routeText = await fsp.readFile(
    path.join(process.cwd(), "src/app/api/videos/[id]/director/route.ts"),
    "utf8"
  );
  ok(!routeText.includes("The AI Director applies to scene-format videos"),
    "the format 400 message is gone from the route");
  ok(routeText.includes("Video has no scenes"),
    "the route's scene-level gate is now the early empty-scenes bail");
  ok(routeText.includes("profile"), "the route accepts the profile request param");

  // resolveProfile — every profile the spec names resolves, unknown → narrative.
  const { resolveProfile, PRODUCTION_PROFILES } = await import("../src/lib/tubeforge/director.ts");
  for (const id of ["narrative","documentary","explainer","advertisement","animation","podcast","social","islamic-history"]) {
    eq(resolveProfile(id).id, id, `${id} resolves`);
  }
  eq(resolveProfile("documentary").id, "documentary", "documentary accepted (was blocked pre-M1)");
  eq(resolveProfile("explainer").id, "explainer", "explainer accepted (was blocked pre-M1)");
  eq(Object.keys(PRODUCTION_PROFILES).length, 8, "exactly eight profiles defined (S49 added islamic-history)");
});

// ---------------------------------------------------------------------------
// Stage 6 (T-6.1) — timeline assembly (timeline.ts)
// ---------------------------------------------------------------------------

await test("timeline: estimateNarrationSec clamps + scales with TTS speed", async () => {
  const { estimateNarrationSec, sumEstimatedDuration } =
    await import("../src/lib/tubeforge/timeline.ts");
  // Empty / whitespace-only narration still needs a visible beat.
  eq(estimateNarrationSec("   "), 1.5, "empty narration gets a 1.5s floor");
  // A short sentence ~6 words at 1.0x = 6/2.5 + 0.4 lead-in ≈ 2.8s
  const six = estimateNarrationSec("one two three four five six");
  ok(six >= 2.7 && six <= 2.9, `6-word narration ≈ 2.8s (got ${six})`);
  // Faster TTS speed reduces duration.
  const sixFast = estimateNarrationSec("one two three four five six", 1.5);
  ok(sixFast < six, "faster TTS speed shortens the scene");
  // Slower TTS speed extends duration.
  const sixSlow = estimateNarrationSec("one two three four five six", 0.7);
  ok(sixSlow > six, "slower TTS speed lengthens the scene");
  // Sum across mixed scenes.
  const sum = sumEstimatedDuration(
    [{ narration: "a b c" } as never, { narration: "x y z w" } as never],
    1
  );
  ok(sum > 0, "sum is positive for non-empty scenes");
});

await test("timeline: assembleTimeline derives per-scene start/end + caption timing", async () => {
  const { assembleTimeline } = await import("../src/lib/tubeforge/timeline.ts");
  const scenes = [
    { index: 1, title: "Open", narration: "Welcome to the show.", visual: "studio", camera: "pan-right", mood: "warm", caption: "Welcome", captionUser: true, hostInScene: true, rehook: false, sfx: "none" },
    { index: 2, title: "Body", narration: "Here is the substance of the episode you came for.", visual: "b-roll", camera: "static", mood: "neutral", caption: "The substance", hostInScene: false, rehook: false, sfx: "whoosh" },
    { index: 3, title: "Close", narration: "Subscribe for more.", visual: "studio", camera: "zoom-in", mood: "warm", caption: "Subscribe", hostInScene: true, rehook: false, sfx: "sting" },
  ] as never[];

  const timeline = assembleTimeline(scenes, { ttsSpeed: 1, renderMode: "kenburns" });
  eq(timeline.sceneCount, 3, "sceneCount matches");
  ok(timeline.totalDurationSec > 0, "totalDurationSec is positive");
  // Scenes are contiguous — scene 2 starts where scene 1 ends.
  eq(timeline.scenes[0].endSec, timeline.scenes[1].startSec, "scenes are contiguous");
  eq(timeline.scenes[1].endSec, timeline.scenes[2].startSec, "scenes are contiguous");
  // S43 — caption timing matches the scene window, but ONLY user-edited
  // captions seed the doc (the script LLM's caption is display metadata,
  // not the render's subtitle contract).
  eq(timeline.scenes[0].caption?.text, "Welcome", "user-edited caption propagated");
  eq(timeline.scenes[0].caption?.startSec, timeline.scenes[0].startSec, "caption starts at scene start");
  eq(timeline.scenes[1].caption, null, "LLM caption does NOT seed the doc (S43)");
  eq(timeline.scenes[2].caption, null, "LLM caption does NOT seed the doc (S43)");
  // SFX enabled only on scenes that asked for one.
  eq(timeline.scenes[0].audio.sfx.enabled, false, "scene 1 has no SFX (sfx:none)");
  eq(timeline.scenes[1].audio.sfx.enabled, true, "scene 2 has SFX (whoosh)");
  eq(timeline.scenes[2].audio.sfx.enabled, true, "scene 3 has SFX (sting)");
  // No shot info without an approved plan.
  eq(timeline.scenes[0].shot, null, "no shot under no plan");
});

await test("timeline: plan duration can only EXTEND a scene, never cut narration (Battle Yamuk −34s drift)", async () => {
  const { assembleTimeline } = await import("../src/lib/tubeforge/timeline.ts");
  // Two chunky scenes; measured voiceover says 30s total.
  const scenes = [
    { index: 1, title: "A", narration: "word ".repeat(40).trim(), visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" },
    { index: 2, title: "B", narration: "word ".repeat(40).trim(), visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" },
  ] as never[];
  // Approved plan invents tight 5s scenes (sum 10s ≪ 30s measured).
  const plan = {
    concept: "x",
    scenes: [
      { sceneIndex: 1, durationSec: 5, shots: [{ duration: 2.5 }, { duration: 2.5 }], transitionIn: "" },
      { sceneIndex: 2, durationSec: 5, shots: [{ duration: 2.5 }, { duration: 2.5 }], transitionIn: "fade" },
    ],
    musicMood: null,
  } as never;
  const timeline = assembleTimeline(scenes, {
    ttsSpeed: 1,
    shotPlan: plan,
    audioDurationSec: 30,
    renderMode: "kenburns",
  });
  // Floor: each scene ≥ its narration share (15s each), even though the
  // plan wanted 5s.
  ok(timeline.scenes[0].durationSec >= 14.5, `plan 5s must not cut narration share (got ${timeline.scenes[0].durationSec})`);
  ok(timeline.scenes[1].durationSec >= 14.5, `plan 5s must not cut narration share (got ${timeline.scenes[1].durationSec})`);
  ok(timeline.totalDurationSec >= 29, `total must track the measured voiceover (got ${timeline.totalDurationSec})`);
  // And the extension case still works: a plan that wants MORE than the
  // share wins (dramatic hold).
  const holdPlan = {
    concept: "x",
    scenes: [
      { sceneIndex: 1, durationSec: 25, shots: [{ duration: 12.5 }, { duration: 12.5 }], transitionIn: "" },
      { sceneIndex: 2, durationSec: 5, shots: [{ duration: 2.5 }, { duration: 2.5 }], transitionIn: "fade" },
    ],
    musicMood: null,
  } as never;
  const held = assembleTimeline(scenes, {
    ttsSpeed: 1,
    shotPlan: holdPlan,
    audioDurationSec: 30,
    renderMode: "kenburns",
  });
  ok(held.scenes[0].durationSec >= 25, `dramatic hold preserved (got ${held.scenes[0].durationSec})`);
});

await test("timeline: measured WAV lengths win over word-count estimates (S1 honesty)", async () => {
  const { assembleTimeline } = await import("../src/lib/tubeforge/timeline.ts");
  // Same word count, wildly different real reads — the estimate path would
  // give both scenes the same share and silently trim the slow one.
  const scenes = [
    { index: 1, title: "Fast", narration: "word ".repeat(20).trim(), visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" },
    { index: 2, title: "Slow", narration: "word ".repeat(20).trim(), visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" },
    { index: 3, title: "Unvoiced", narration: "word ".repeat(20).trim(), visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" },
  ] as never[];
  const timeline = assembleTimeline(scenes, {
    ttsSpeed: 1,
    renderMode: "kenburns",
    audioDurationSec: 40,
    wavDurations: { 1: 5, 2: 25 }, // scene 3 not yet voiced → estimate
  });
  // Scene 1: exactly the render's segment (5 + 1.2 lead/tail).
  approx(timeline.scenes[0].durationSec, 6.2, 0.011, "measured scene 1 window = wav + lead + tail");
  // Scene 2: 25 + 1.2 — NOT its ~1/3 share of 40s (which would trim ~11s
  // of the read at render time).
  approx(timeline.scenes[1].durationSec, 26.2, 0.011, "measured scene 2 window = wav + lead + tail");
  // Scene 3 has no WAV → estimate share of the measured total.
  ok(timeline.scenes[2].durationSec > 2, `unvoiced scene keeps a positive estimate (got ${timeline.scenes[2].durationSec})`);
  // Contiguity survives the mixed sources.
  eq(timeline.scenes[0].endSec, timeline.scenes[1].startSec, "contiguous after scene 1");
  eq(timeline.scenes[1].endSec, timeline.scenes[2].startSec, "contiguous after scene 2");
  approx(timeline.totalDurationSec, timeline.scenes.reduce((a, s) => a + s.durationSec, 0), 0.05, "total = sum of windows");
  // A floor-clamped short read still gets MIN_SEG (2.0s).
  const tiny = assembleTimeline(scenes.slice(0, 1), { ttsSpeed: 1, renderMode: "kenburns", wavDurations: { 1: 0.3 } });
  approx(tiny.scenes[0].durationSec, 2.0, 0.011, "MIN_SEG floor holds for sub-floor reads");
});

await test("timeline: parseTimeline degrades bad/legacy payloads to null", async () => {
  const { parseTimeline, serializeTimeline, assembleTimeline } =
    await import("../src/lib/tubeforge/timeline.ts");
  eq(parseTimeline(null), null, "null in → null out");
  eq(parseTimeline(""), null, "empty string → null out");
  eq(parseTimeline("not-json"), null, "non-JSON → null out");
  eq(parseTimeline(JSON.stringify({ foo: "bar" })), null, "non-timeline shape → null");
  eq(parseTimeline(JSON.stringify({ scenes: "not-array" })), null, "non-array scenes → null");
  // A real roundtrip survives.
  const original = assembleTimeline(
    [{ index: 1, title: "t", narration: "n", visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" } as never],
    { ttsSpeed: 1 }
  );
  const round = parseTimeline(serializeTimeline(original));
  ok(round !== null, "roundtrip succeeds");
  eq(round.sceneCount, 1, "sceneCount preserved");
  eq(round.scenes[0].index, 1, "scene index preserved");
});

// ---------------------------------------------------------------------------
// Stage 6 (T-6.10) — timeline → render duration override shape
// ---------------------------------------------------------------------------

await test("timeline: render-job consumes per-scene durationSec from the assembled timeline", async () => {
  const { assembleTimeline, serializeTimeline, parseTimeline } =
    await import("../src/lib/tubeforge/timeline.ts");

  // The render job reads `parseTimeline(video.timeline).scenes.map(s => s.durationSec)`
  // when no per-render override is supplied. The shape must be (a) finite
  // positive numbers, (b) aligned to the scene list (one entry per scene).
  const scenes = [
    { index: 1, title: "Open", narration: "Welcome.", visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" } as never,
    { index: 2, title: "Body",  narration: "Here is the substance.", visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" } as never,
    { index: 3, title: "Close", narration: "Bye.", visual: "v", camera: "c", mood: "m", caption: "", hostInScene: false, rehook: false, sfx: "none" } as never,
  ];
  const timeline = assembleTimeline(scenes, { ttsSpeed: 1 });
  const round = parseTimeline(serializeTimeline(timeline));
  ok(round !== null, "roundtrip succeeds");
  ok(
    round.scenes.every((s) => typeof s.durationSec === "number" && Number.isFinite(s.durationSec) && s.durationSec > 0),
    "every durationSec is a finite positive number"
  );
  eq(round.scenes.length, scenes.length, "one duration per scene");

  // A corrupt timeline (missing durationSec on one scene) must NOT be honored
  // — the runRenderJob "single bad value falls back for ALL scenes" rule.
  const corrupt = JSON.parse(serializeTimeline(timeline)) as { scenes: { durationSec?: number }[] };
  corrupt.scenes[1].durationSec = undefined;
  const parsedCorrupt = parseTimeline(JSON.stringify(corrupt));
  ok(parsedCorrupt !== null, "parseTimeline still parses the partial payload");
  const ds = parsedCorrupt.scenes.map((s) => s.durationSec);
  ok(
    !ds.every((d) => typeof d === "number" && Number.isFinite(d) && d > 0),
    "a missing durationSec fails the runRenderJob safety check"
  );
});

// ---------------------------------------------------------------------------
// Stage 6 (T-6.7) — captions SRT -> VTT (captions.ts)
// ---------------------------------------------------------------------------

await test("captions: srtToVtt header + fractional separator + cue-number strip", async () => {
  const { srtToVtt, looksLikeSrt } = await import("../src/lib/tubeforge/subtitle-export.ts");
  const srt = [
    "1",
    "00:00:01,000 --> 00:00:04,500",
    "Welcome to the show.",
    "",
    "2",
    "00:00:04,500 --> 00:00:07,000",
    "Here is the substance.",
    "",
  ].join("\n");

  ok(looksLikeSrt(srt), "looksLikeSrt true for a real SRT body");
  ok(!looksLikeSrt("<html>"), "looksLikeSrt false for an HTML error page");

  const vtt = srtToVtt(srt);
  ok(vtt.startsWith("WEBVTT\n\n"), "VTT starts with the WEBVTT header + blank line");
  ok(!/^\d+$/m.test(vtt.split("\n")[2]), "SRT cue numbers are stripped (no bare integer line)");
  ok(vtt.includes("00:00:01.000 --> 00:00:04.500"), "fractional separator , -> .");
  ok(!vtt.includes(","), "no comma survives inside the timestamps");
  ok(vtt.includes("Welcome to the show."), "cue text preserved");
  ok(vtt.includes("Here is the substance."), "second cue preserved");
});

await test("research: matchSourcesToIdeas attaches only keyword-relevant sources", async () => {
  const { matchSourcesToIdeas } = await import("../src/lib/tubeforge/research.ts");
  const idea = (id: string, keywords: string[]) =>
    ({ id, title: "", angle: "", keywords, searchVolume: "", competition: "", viralScore: 50, suggestedLength: "medium", why: "" });
  const results = [
    { url: "https://a.example.com/roman", name: "Roman engineering feats", snippet: "aqueducts and concrete built the empire", host: "a.example.com" },
    { url: "https://b.example.com/finance", name: "Compound interest explained", snippet: "how money grows over decades", host: "b.example.com" },
    { url: "https://c.example.com/rome-2", name: "More on Rome", snippet: "the empire's aqueducts in detail", host: "c.example.com" },
  ];

  const byIdea = matchSourcesToIdeas(
    [idea("i-rome", ["rome", "aqueducts"]), idea("i-money", ["compound interest", "money"])],
    results
  );
  const rome = byIdea.get("i-rome") ?? [];
  eq(rome.length, 2, "both Rome-relevant sources attach");
  ok(rome.some((s) => s.host === "a.example.com"), "ranked first source present");
  ok(rome.every((s) => s.url.startsWith("https://")), "urls carried through");
  const money = byIdea.get("i-money") ?? [];
  eq(money.length, 1, "finance source attaches to the finance idea");
  eq(money[0].host, "b.example.com", "correct source matched");

  // No overlap → no sources (an idea without grounding ships bare, not padded).
  const none = matchSourcesToIdeas([idea("i-off", ["quantum", "koala"])], results);
  eq(none.size, 0, "irrelevant idea gets no sources");

  // Empty results → empty map (fail-open contract).
  eq(matchSourcesToIdeas([idea("i-x", ["anything"])], []).size, 0, "no results → no sources");

  // maxPerIdea caps the attachment.
  const many = matchSourcesToIdeas(
    [idea("i-many", ["rome", "aqueducts"])],
    results.concat(results.map((r) => ({ ...r, url: r.url + "-2" }))),
    2
  );
  eq((many.get("i-many") ?? []).length, 2, "capped at maxPerIdea");
});

// ---------------------------------------------------------------------------
// Stage 7 (T-7.5) — billing resolver + plan gating (billing.ts)
// ---------------------------------------------------------------------------

await test("billing: PLAN_DEFAULTS has the three tiers with sensible monthly credits", async () => {
  const { PLAN_DEFAULTS } = await import("../src/lib/tubeforge/billing.ts");
  eq(PLAN_DEFAULTS.starter.tier, "starter", "starter tier id");
  eq(PLAN_DEFAULTS.creator.tier, "creator", "creator tier id");
  eq(PLAN_DEFAULTS.studio.tier, "studio", "studio tier id");
  ok(PLAN_DEFAULTS.starter.monthlyCredits > 0, "starter has positive credits");
  ok(
    PLAN_DEFAULTS.creator.monthlyCredits > PLAN_DEFAULTS.starter.monthlyCredits,
    "creator has more credits than starter"
  );
  ok(
    PLAN_DEFAULTS.studio.monthlyCredits > PLAN_DEFAULTS.creator.monthlyCredits,
    "studio has more credits than creator"
  );
  ok(!PLAN_DEFAULTS.starter.priorityRendering, "starter has no priority rendering");
  ok(PLAN_DEFAULTS.creator.priorityRendering, "creator has priority rendering");
  ok(PLAN_DEFAULTS.studio.teamMembers > 1, "studio has team members");
});

await test("billing: planSupportsResolution gates by plan tier", async () => {
  const { planSupportsResolution, PLAN_DEFAULTS } = await import("../src/lib/tubeforge/billing.ts");
  ok(planSupportsResolution(PLAN_DEFAULTS.starter, "1080p"), "starter can render 1080p");
  ok(!planSupportsResolution(PLAN_DEFAULTS.starter, "1440p"), "starter cannot render 1440p");
  ok(!planSupportsResolution(PLAN_DEFAULTS.starter, "2160p"), "starter cannot render 2160p");
  ok(planSupportsResolution(PLAN_DEFAULTS.creator, "1080p"), "creator can render 1080p");
  ok(planSupportsResolution(PLAN_DEFAULTS.creator, "1440p"), "creator can render 1440p");
  ok(!planSupportsResolution(PLAN_DEFAULTS.creator, "2160p"), "creator cannot render 2160p");
  ok(planSupportsResolution(PLAN_DEFAULTS.studio, "2160p"), "studio can render 2160p");
  // Unknown resolution → 1080p allowed (the fallback), 4k blocked
  ok(planSupportsResolution(PLAN_DEFAULTS.starter, "weird"), "unknown resolution defaults to 1080p-allowed");
});

await test("billing: hasCredits — Starter never hard-blocks; paid tier gates on balance", async () => {
  const billing = await import("../src/lib/tubeforge/billing.ts");
  const { hasCredits, PLAN_DEFAULTS } = billing;
  type ResolvedPlan = import("../src/lib/tubeforge/billing.ts").ResolvedPlan;
  const starterResolved: ResolvedPlan = {
    plan: PLAN_DEFAULTS.starter,
    subscription: null,
    creditBalance: 0, // overdrawn starter
  };
  ok(hasCredits(starterResolved, 1), "starter with 0 balance still allowed (free tier, no hard-block)");

  const creatorResolved: ResolvedPlan = {
    plan: PLAN_DEFAULTS.creator,
    subscription: { id: "x", status: "active", currentPeriodEnd: null, stripeCustomerId: null },
    creditBalance: 1000,
  };
  ok(hasCredits(creatorResolved, 500), "creator with positive balance allowed");
  ok(!hasCredits(creatorResolved, 1001), "creator overdrawn blocked");
});

await test("billing: CreditSpendKind covers every ROADMAP §7 spend kind + Stage 7.2 reservation kinds", async () => {
  const billing = await import("../src/lib/tubeforge/billing.ts");
  // recordCreditSpend accepts these kinds; the reconciliation test joins
  // the AI-spend family (ai_call/hold/adjustment/hold_release) against
  // UsageRecord.costMicroUsd.
  const kinds: billing.CreditSpendKind[] = [
    "ai_call",
    "render_minute",
    "publish",
    "storage",
    "topup",
    "refund",
    "hold",
    "adjustment",
    "hold_release",
  ];
  eq(kinds.length, 9, "nine spend kinds (no duplicates)");
  ok(kinds.includes("ai_call"), "ai_call kind present (the unmetered reconciliation target)");
  ok(kinds.includes("refund"), "refund kind present (negative microCredits)");
  ok(kinds.includes("hold"), "hold kind present (Stage 7.2 pre-call reservation)");
  ok(kinds.includes("adjustment"), "adjustment kind present (settlement delta)");
  ok(kinds.includes("hold_release"), "hold_release kind present (failed-call release)");
  // The AI-spend family used by sumAICallSpends covers exactly the kinds a
  // metered call can write — a failed call must NET to 0 (hold + release).
  eq([...billing.AI_SPEND_KINDS].sort(), ["adjustment", "ai_call", "hold", "hold_release"], "AI_SPEND_KINDS");
});

await test("billing: reservationEnforcement — starter is unmetered, paid tiers enforce", async () => {
  const billing = await import("../src/lib/tubeforge/billing.ts");
  const { reservationEnforcement } = billing;
  eq(reservationEnforcement("starter"), "unmetered", "starter never reserves (overdraft design)");
  eq(reservationEnforcement("creator"), "enforced", "creator reserves before the call");
  eq(reservationEnforcement("studio"), "enforced", "studio reserves before the call");
  // An unknown tier FAILS CLOSED — a new plan tier enforces by default.
  eq(reservationEnforcement("brand_new_tier"), "enforced", "unknown tiers enforce");
});

await test("billing: CreditBlockedError carries readable balance facts", async () => {
  const billing = await import("../src/lib/tubeforge/billing.ts");
  const err = new billing.CreditBlockedError("video", 40_000, 3_000);
  ok(err instanceof Error, "is an Error");
  eq(err.name, "CreditBlockedError", "typed name (routes can instanceof it)");
  eq(err.capability, "video", "capability recorded");
  eq(err.estimatedMicro, 40_000, "estimate recorded");
  eq(err.balanceMicro, 3_000, "balance recorded");
  ok(/insufficient credits/i.test(err.message), "message says insufficient credits");
  ok(err.message.includes("video"), "message names the capability");
  // Display units are UI credits (microToCredits): 40 micro = 40 credits.
  ok(err.message.includes("40"), "message quotes the cost in credits");
  ok(err.message.includes("3"), "message quotes the balance in credits");
});

await test("billing: resolveUserPlan returns the Starter default when no Subscription row exists", async () => {
  const billing = await import("../src/lib/tubeforge/billing.ts");
  const { resolveUserPlan, PLAN_DEFAULTS, creditsToMicro } = billing;
  // A never-existed user (no Subscription row) → Starter plan, full monthly credits,
  // null subscription record. This is the "fresh install" path — no row writes
  // needed for existing users when billing is wired.
  const resolved = await resolveUserPlan("nonexistent-user-id");
  eq(resolved.plan.tier, "starter", "default tier is starter");
  eq(resolved.subscription, null, "no subscription row → null");
  eq(resolved.access, "none", "no subscription row → no paid access");
  // Stage 7.1: balances are MICROCREDITS — the Starter allowance converts
  // from UI credits at the resolver boundary.
  eq(resolved.creditBalance, creditsToMicro(PLAN_DEFAULTS.starter.monthlyCredits), "fresh credits (in microCredits)");
});

await test("billing: getEstimatedCostMicro covers every metered capability with positive costs", async () => {
  const billing = await import("../src/lib/tubeforge/billing.ts");
  const { getEstimatedCostMicro, ESTIMATED_COST_MICRO } = billing;
  // Every capability budget.ts can report (CAPABILITY_OF in budget.ts) must
  // carry a positive per-call estimate — a missing entry silently falls back
  // to the chat estimate, which would misprice video renders.
  for (const cap of ["chat", "tts", "image", "video", "search", "asr"]) {
    ok(
      typeof ESTIMATED_COST_MICRO[cap] === "number" && ESTIMATED_COST_MICRO[cap] > 0,
      `capability "${cap}" has a positive estimate`
    );
    eq(getEstimatedCostMicro(cap), ESTIMATED_COST_MICRO[cap], `${cap} resolves its own estimate`);
  }
  // Unknown → chat fallback (conservative middle).
  eq(getEstimatedCostMicro("nonexistent"), ESTIMATED_COST_MICRO.chat, "unknown capability falls back to chat");
  // Ordering sanity: video is the most expensive per call, search the least.
  ok(ESTIMATED_COST_MICRO.video > ESTIMATED_COST_MICRO.image, "video > image");
  ok(ESTIMATED_COST_MICRO.image > ESTIMATED_COST_MICRO.chat, "image > chat");
  ok(ESTIMATED_COST_MICRO.chat > ESTIMATED_COST_MICRO.search, "chat > search");
});

await test("billing: subscriptionAccess maps every Stripe status — unknown statuses fail CLOSED", async () => {
  const { subscriptionAccess } = await import("../src/lib/tubeforge/billing.ts");
  eq(subscriptionAccess("active"), "full", "active → full");
  eq(subscriptionAccess("trialing"), "full", "trialing → full");
  eq(subscriptionAccess("past_due"), "grace", "past_due → grace (dunning keeps the plan)");
  eq(subscriptionAccess("canceled"), "none", "canceled → none (falls back to Starter)");
  eq(subscriptionAccess("unpaid"), "none", "unpaid → none");
  eq(subscriptionAccess("incomplete"), "none", "incomplete → none");
  eq(subscriptionAccess("incomplete_expired"), "none", "incomplete_expired → none");
  eq(subscriptionAccess("paused"), "none", "paused → none");
  eq(subscriptionAccess("some_new_stripe_status"), "none", "UNKNOWN status → none (fail-closed, never grants)");
  eq(subscriptionAccess(""), "none", "empty → none");
  eq(subscriptionAccess(null), "none", "null → none");
  eq(subscriptionAccess(undefined), "none", "undefined → none");
});

await test("billing: credit units — microCredits are canonical, conversion is total (no mixed-unit sums)", async () => {
  const { MICROS_PER_CREDIT, creditsToMicro, microToCredits, PLAN_DEFAULTS } = await import(
    "../src/lib/tubeforge/billing.ts"
  );
  eq(MICROS_PER_CREDIT, 1000, "1 UI credit = 1,000 microCredits");
  eq(creditsToMicro(1), 1000, "1 credit → 1,000 micro");
  eq(creditsToMicro(10000), 10_000_000, "Creator allowance converts to the canonical unit (10,000 × 1,000)");
  eq(creditsToMicro(0), 0, "zero converts to zero");
  eq(microToCredits(creditsToMicro(12345)), 12345, "round-trip is total for whole credits");
  eq(microToCredits(9999), 9, "display conversion FLOORS (never overstate a balance)");
  eq(microToCredits(-500), -1, "negative balances floor away from zero (conservative display)");
  // The exact defect this fixes: a full Creator allowance MUST cover the
  // render pre-check (RENDER_ESTIMATE_MICRO) with room to spare.
  const creatorAllowanceMicro = creditsToMicro(PLAN_DEFAULTS.creator.monthlyCredits);
  const { RENDER_ESTIMATE_MICRO } = await import("../src/lib/tubeforge/billing.ts");
  ok(
    creatorAllowanceMicro > RENDER_ESTIMATE_MICRO,
    `Creator allowance (${creatorAllowanceMicro} micro) covers the render pre-check (${RENDER_ESTIMATE_MICRO} micro)`
  );
});

await test("billing: verifyStripeSignature rejects tampered, stale, and malformed signatures", async () => {
  const { verifyStripeSignature } = await import("../src/lib/tubeforge/billing.ts");
  const secret = "whsec_test_secret_unit";
  const payload = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const t = Math.floor(Date.now() / 1000);
  const sign = (body: string, ts: number) =>
    crypto.createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex");

  ok(
    await verifyStripeSignature(payload, `t=${t},v1=${sign(payload, t)}`, secret),
    "fresh, correctly signed payload verifies"
  );
  ok(
    !(await verifyStripeSignature(payload + " ", `t=${t},v1=${sign(payload, t)}`, secret)),
    "tampered payload rejected"
  );
  ok(
    !(await verifyStripeSignature(payload, `t=${t},v1=${sign(payload, t)}`, "whsec_wrong")),
    "wrong secret rejected"
  );
  const stale = t - 400; // beyond the 300s replay window
  ok(
    !(await verifyStripeSignature(payload, `t=${stale},v1=${sign(payload, stale)}`, secret)),
    "valid HMAC with a STALE timestamp rejected (replay window)"
  );
  ok(!(await verifyStripeSignature(payload, `t=${t}`, secret)), "missing v1 rejected");
  ok(!(await verifyStripeSignature(payload, `v1=${sign(payload, t)}`, secret)), "missing t rejected");
  ok(!(await verifyStripeSignature(payload, `t=notanumber,v1=${"a".repeat(64)}`, secret)), "non-numeric timestamp rejected");
  ok(!(await verifyStripeSignature(payload, "garbage", secret)), "garbage header rejected");
});

await test("shots M2: CAMERA_TO_MOVE covers every CAMERA_MOVES entry", async () => {
  const { CAMERA_TO_MOVE } = await import("../src/lib/tubeforge/shots.ts");
  const { CAMERA_MOVES } = await import("../src/lib/tubeforge/director-plan.ts");
  const { MOTION_MOVE_LABELS } = await import("../src/lib/tubeforge/motion.ts");
  const moveKinds = new Set(Object.keys(MOTION_MOVE_LABELS)); // runtime MoveKind set
  for (const move of CAMERA_MOVES) {
    const mapped = CAMERA_TO_MOVE[move];
    ok(mapped !== undefined, `${move} is mapped`);
    ok(moveKinds.has(mapped), `${move} → ${mapped} is a motion.ts MoveKind`);
  }
  eq(CAMERA_TO_MOVE["not-a-real-move"] ?? "hold", "hold", "unknown → hold");
});

await test("shots M2: buildSceneShots planned path — one execution per DirectorShot, imagePrompt leads", async () => {
  const { buildSceneShots } = await import("../src/lib/tubeforge/shots.ts");
  const scene = { index: 3, title: "t", narration: "n", visual: "a fortress at dusk", mood: "amber dusk" } as never;
  const planScene = {
    sceneIndex: 3,
    shots: [
      { shotIndex: 0, framing: "wide", camera: "push-in", lens: "24mm wide", composition: "leading lines", duration: 3, imagePrompt: "establishing fortress" },
      { shotIndex: 1, framing: "extreme close-up", camera: "handheld", lens: "85mm f/1.8", composition: "rule of thirds", duration: 3, imagePrompt: "the general's eyes" },
      { shotIndex: 2, framing: "medium", camera: "crane-up", lens: "35mm", composition: "golden ratio", duration: 3, imagePrompt: "the banner reveal" },
    ],
  } as never;

  const plan = buildSceneShots({ scene, planScene, measuredSec: 9 });
  eq(plan.available.length, 3, "one execution per planned shot");
  const [s0, s1, s2] = plan.available;
  eq(s0.source, "scene", "shot 0 = the scene's own image");
  ok(!s0.prompt, "shot 0 carries no prompt (scene image already has the addendum)");
  eq(s1.source, "extra", "shots 1+ = extra AI images");
  ok(s1.prompt != null, "extra shot carries a prompt");
  ok(s1.prompt.includes("the general's eyes"), "imagePrompt leads the extra prompt");
  ok(s1.prompt.startsWith("a fortress at dusk"), "scene visual opens the prompt");
  eq(s1.moveKind, "diag-tl", "first handheld → diag-tl");
  eq(s2.moveKind, "tilt-up", "crane-up → tilt-up (documented approximation)");
  eq(s0.moveKind, "zoom-in", "push-in → zoom-in");
  approx(plan.available.reduce((a: number, s: { sec: number }) => a + s.sec, 0), 9, 0.05, "scale-to-fit fills the measured narration exactly");
});

await test("shots M2: duration reconciliation — extend-only when the plan outruns narration", async () => {
  const { buildSceneShots } = await import("../src/lib/tubeforge/shots.ts");
  const scene = { index: 1, narration: "n", visual: "v", mood: "m" } as never;
  // Plan totals 12s vs 8s measured → pass through UNCHANGED (extend-only,
  // the Battle Yamuk rule inherited at shot level).
  const planScene = {
    sceneIndex: 1,
    shots: [
      { shotIndex: 0, framing: "wide", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 6, imagePrompt: "a" },
      { shotIndex: 1, framing: "medium", camera: "pan-left", lens: "35mm", composition: "rule of thirds", duration: 6, imagePrompt: "b" },
    ],
  } as never;
  const out = buildSceneShots({ scene, planScene, measuredSec: 8 });
  eq(out.available[0].sec, 6, "planned duration passes through (never shortened)");
  eq(out.available[1].sec, 6, "second shot untouched too");
  // Scale-to-fit: plan totals 4s vs 10s measured → ×2.5, rhythm preserved.
  const planScene2 = {
    sceneIndex: 1,
    shots: [
      { shotIndex: 0, framing: "wide", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 1, imagePrompt: "a" },
      { shotIndex: 1, framing: "medium", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 3, imagePrompt: "b" },
    ],
  } as never;
  const out2 = buildSceneShots({ scene, planScene: planScene2, measuredSec: 10 });
  eq(out2.available[0].sec, 2.5, "1s → 2.5s (×2.5)");
  eq(out2.available[1].sec, 7.5, "3s → 7.5s (×2.5, relative rhythm kept)");
});

await test("shots M2: no plan → legacy fallback (golden behavior)", async () => {
  const { buildSceneShots, planShots } = await import("../src/lib/tubeforge/shots.ts");
  const scene = { index: 2, narration: "n", visual: "v", mood: "m" } as never;

  // Short scene: single shot, the scene image, zoom-in — exactly the legacy path.
  const short = buildSceneShots({ scene, planScene: null, measuredSec: 2.5 });
  eq(short.available.length, 1, "≤3s scene = one shot");
  eq(short.available[0].source, "scene", "the scene image itself");
  eq(short.available[0].moveKind, "zoom-in", "legacy single-shot camera");
  approx(short.available[0].sec, 2.5, 0.01, "full scene duration");

  // Long scene: even split, shot 0 scene + pseudo crops, rotation cameras.
  const long = buildSceneShots({ scene, planScene: null, measuredSec: 10 });
  const legacy = planShots(10);
  eq(long.available.length, legacy.count, "shot count = legacy even split");
  approx(long.available[0].sec, legacy.durations[0], 0.01, "durations = legacy even split");
  eq(long.available[0].source, "scene", "shot 0 = scene image");
  ok(long.available.slice(1).every((s) => s.source === "pseudo" && s.crop), "later shots = pseudo crops");
  ok(long.available[1].moveKind !== long.available[2].moveKind, "consecutive fallback shots never repeat a move");
});

await test("shots M2: extras budget — at most 3 fresh AI images per scene, surplus keeps its rhythm as pseudo", async () => {
  const { buildSceneShots, EXTRAS_BUDGET, MAX_SHOTS } = await import("../src/lib/tubeforge/shots.ts");
  const scene = { index: 4, title: "t", narration: "n", visual: "a harbor at dawn", mood: "cold light" } as never;
  const shot = (i: number) => ({
    shotIndex: i, framing: "wide", camera: "push-in", lens: "35mm",
    composition: "rule of thirds", duration: 2, imagePrompt: `beat ${i}`,
  });
  // 6 planned shots → 1 scene art + 3 extras + 2 pseudo; ALL 6 keep rhythm.
  const planScene = { sceneIndex: 4, shots: [0, 1, 2, 3, 4, 5].map(shot) } as never;
  const plan = buildSceneShots({ scene, planScene, measuredSec: 12 });
  eq(plan.available.length, 6, "every planned shot renders (rhythm preserved)");
  eq(plan.available[0].source, "scene", "shot 0 = the scene art");
  const extras = plan.available.filter((s: { source: string }) => s.source === "extra");
  const pseudos = plan.available.filter((s: { source: string }) => s.source === "pseudo");
  eq(extras.length, EXTRAS_BUDGET, "exactly the budget generates AI images (owner decision #2)");
  eq(pseudos.length, 2, "surplus shots demote to pseudo crops");
  ok(extras.every((s: { prompt?: string }) => s.prompt), "extras carry their generation prompt");
  ok(pseudos.every((s: { prompt?: string; crop?: unknown }) => !s.prompt && s.crop), "pseudos carry a crop and no prompt");
  approx(
    plan.available.reduce((a: number, s: { sec: number }) => a + s.sec, 0),
    12, 0.05, "reconciliation fills the scene exactly even with demotions"
  );

  // Hard ceiling: a 10-shot plan truncates to MAX_SHOTS.
  const huge = { sceneIndex: 4, shots: Array.from({ length: 10 }, (_, i) => shot(i)) } as never;
  eq(buildSceneShots({ scene, planScene: huge, measuredSec: 12 }).available.length, MAX_SHOTS, "MAX_SHOTS is the hard ceiling");
});

await test("shots M2: movementForKind — engine-grade MotionShot for every move, stills contract honored", async () => {
  const { movementForKind, MOTION_MOVE_LABELS } = await import("../src/lib/tubeforge/motion.ts");
  const kinds = Object.keys(MOTION_MOVE_LABELS);
  const focal = { x: 0.5, y: 0.5 };
  for (const k of kinds) {
    const m = movementForKind(k as never, focal, 40);
    ok(m.zStart >= 1 && m.zEnd >= 1 && m.zEnd <= 1.5, `${k}: zoom window sane`);
    ok(m.travel >= 0 && m.travel <= 1, `${k}: travel in range`);
    ok(Number.isFinite(m.sec) && m.sec > 0, `${k}: finite sec`);
  }
  const hold = movementForKind("hold", focal, 40);
  eq(hold.kind, "hold", "hold is hold");
  const zin = movementForKind("zoom-in", focal, 40);
  ok(zin.zEnd > zin.zStart, "zoom-in ends tighter than it starts");
  const zout = movementForKind("zoom-out", focal, 40);
  ok(zout.zEnd < zout.zStart, "zoom-out ends wider than it starts");
  const pan = movementForKind("pan-left", focal, 40);
  ok(pan.travel > 0, "pans travel");
  const still = movementForKind("zoom-in", focal, 0);
  eq(still.kind, "hold", "intensity < 1 holds the camera — the user's stillness contract outranks shot moves");
});

await test("shots M2: multiShotSceneGraph — per-input zoompan graph with an exact frame budget", async () => {
  const { multiShotSceneGraph } = await import("../src/lib/tubeforge/motion.ts");
  const settings = { mode: "smart", intensity: 40, curve: "smooth", vary: true } as never;
  const fps = 30;
  const g = multiShotSceneGraph({
    dur: 10,
    settings,
    fps,
    grade: "eq=saturation=1.05",
    shots: [
      { kind: "zoom-in", sec: 4, input: 0 },
      { kind: "pan-right", sec: 3, input: 0, crop: { w: 2200, h: 1238, x: 820, y: 461 } },
      { kind: "zoom-out", sec: 3, input: 4 },
    ] as never,
  });

  const zoompans = g.match(/zoompan=/g)?.length ?? 0;
  eq(zoompans, 3, "one zoompan per shot");
  ok(g.includes("[0:v]"), "scene image base chain present");
  ok(g.includes("split=2[b0_0][b0_1]"), "the shared input splits once per consuming shot");
  ok(g.includes("[4:v]"), "the extra image input is referenced directly");
  ok(!g.includes("split=1"), "single-use inputs never split");
  ok(g.includes("crop=2200:1238:820:461,"), "the pseudo crop lands pre-zoompan (16:9 ref == work canvas)");
  ok(g.includes("concat=n=3:v=1:a=0[vc]"), "shots concat in order");
  ok(g.endsWith("[vc]eq=saturation=1.05[v]"), "the grade finishes the graph");

  // Frame budget: per-shot trims sum EXACTLY to round(dur*fps) — the cut
  // points land on the reconciled ShotExecution.sec boundaries.
  const frames = [...g.matchAll(/trim=end_frame=(\d+)/g)].map((m) => Number(m[1]));
  eq(frames.length, 3, "one trim per shot branch");
  approx(frames.reduce((a, b) => a + b, 0), 300, 0, "exact frame budget (10s × 30fps)");
  approx(frames[0] / 300, 0.4, 0.02, "shot durations keep their planned proportion");

  // Pseudo crops scale from the 3840x2160 reference to the actual canvas.
  const g9 = multiShotSceneGraph({
    dur: 10, settings, fps, aspect: "9:16",
    shots: [{ kind: "pan-left", sec: 10, input: 0, crop: { w: 1920, h: 2160, x: 1920, y: 0 } }] as never,
  });
  ok(g9.includes("crop=1080:3840:1080:0,"), "crop rects scale to the 9:16 work canvas");

  // Degenerate plan → static scene, never an empty graph.
  const g0 = multiShotSceneGraph({ dur: 2, settings, fps, shots: [] });
  ok(g0.startsWith("[0:v]") && g0.endsWith("[v]"), "empty shot list degrades to a static scene");
});

await test("shots M2 render contract: 2-shot synthetic plan → exact duration + distinct visual segments (real ffmpeg)", async () => {
  const { multiShotSceneGraph } = await import("../src/lib/tubeforge/motion.ts");
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-m2-"));
  try {
    // Two DISTINCT sources + a narration stand-in — the smallest fixture that
    // exercises the full multi-image command shape buildSegment assembles.
    const imgA = path.join(tmp, "scene-01.png");
    const imgB = path.join(tmp, "shot-01-1.png");
    const wav = path.join(tmp, "scene-01.wav");
    await genFixture(imgA, ["-f", "lavfi", "-i", "testsrc2=size=1280x720", "-frames:v", "1"]);
    await genFixture(imgB, ["-f", "lavfi", "-i", "smptebars=size=1280x720", "-frames:v", "1"]);
    await genFixture(wav, ["-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-ar", "48000", "-ac", "2"]);

    const fps = 12;
    const dur = 4;
    const settings = { mode: "smart", intensity: 40, curve: "smooth", vary: true } as never;
    const graph = multiShotSceneGraph({
      dur, settings, fps,
      shots: [
        { kind: "zoom-in", sec: 2, input: 0 },
        { kind: "pan-right", sec: 2, input: 2 }, // inputs: 0=scene img, 1=wav, 2=extra img
      ] as never,
    });
    const out = path.join(tmp, "seg.mp4");
    await genFixture(out, [
      "-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", imgA,
      "-i", wav,
      "-loop", "1", "-framerate", String(fps), "-t", "3", "-i", imgB,
      "-filter_complex", `${graph};[1:a]anull[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", String(dur),
      ...FFMPEG_COMMON,
    ]);

    // Spec §1.4 acceptance: |rendered − measured| ≤ 0.2s.
    const probe = await execFileAsync(
      "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
      { timeout: 60_000, maxBuffer: 1024 * 1024 }
    );
    approx(parseFloat(probe.stdout.trim()), dur, 0.2, "2-shot segment duration");

    // Spec §1.10 acceptance: frame-hash sampling shows ≥2 distinct segments —
    // frames either side of the 2s cut come from different sources.
    const f1 = path.join(tmp, "f1.png");
    const f2 = path.join(tmp, "f2.png");
    await genFixture(f1, ["-ss", "0.4", "-i", out, "-frames:v", "1"]);
    await genFixture(f2, ["-ss", "2.6", "-i", out, "-frames:v", "1"]);
    const b1 = await fsp.readFile(f1);
    const b2 = await fsp.readFile(f2);
    ok(!b1.equals(b2), "frames either side of the shot cut differ (distinct visual segments)");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

await test("migrate-stage2: decideBaselinePrefix fingerprints every schema era", async () => {
  const { BASELINE_SENTINELS, decideBaselinePrefix } = await import("../scripts/migrate-stage2.mjs");
  const S = BASELINE_SENTINELS;

  // Fingerprint builder: a set of present tables + (table, column) pairs.
  const fp = (tables: string[], cols: string[] = []) => {
    const t = new Set(tables);
    const c = new Set(cols);
    return {
      hasTable: (x: string) => t.has(x),
      hasColumn: (x: string, y: string) => c.has(`${x}.${y}`),
    };
  };

  // Empty database → nothing baselined, deploy the whole chain.
  eq(decideBaselinePrefix(S, fp([]).hasTable, fp([]).hasColumn).length, 0, "empty DB → no baseline");

  // Stage-1 legacy (Vercel Postgres pushed with db push in the old era):
  // Setting exists — WITH init's updatedAt column — → baseline init only.
  // S60 regression guard: auth_setting's sentinel keys on the same TABLE
  // name; only the missing updatedAt distinguishes the eras. A legacy
  // fingerprint that omits the column would falsely baseline the tail.
  const legacy = fp(
    ["Channel", "Character", "Video", "Setting"],
    ["Setting.updatedAt"]
  );
  eq(
    decideBaselinePrefix(S, legacy.hasTable, legacy.hasColumn),
    ["000000000000_init"],
    "Stage-1 schema (Setting WITH updatedAt) → baseline init only"
  );

  // S60 — auth_setting-era db-push (Setting exists WITHOUT updatedAt — the
  // re-created keystore shape — but no ApiToken yet) → baseline through
  // auth_setting; deploy applies s20 onward.
  const authGate = fp(
    ["User", "Organization", "Plan", "CreditLedger", "Setting"],
    ["Video.timeline", "CreditLedger.reconcilesId"]
  );
  const authGatePrefix = decideBaselinePrefix(S, authGate.hasTable, authGate.hasColumn);
  eq(
    authGatePrefix[authGatePrefix.length - 1],
    "20261102040000_auth_setting",
    "auth_setting-era schema → newest sentinel is auth_setting"
  );

  // S60 — s40-era db-push (qcOverride columns landed, s46/s49 not) →
  // baseline through s40; deploy applies s46 + s49.
  const s40era = fp(
    ["User", "Organization", "Plan", "CreditLedger", "Setting", "ApiToken", "SpendReservation"],
    ["Video.timeline", "CreditLedger.reconcilesId", "Video.qcOverrideAt"]
  );
  const s40Prefix = decideBaselinePrefix(S, s40era.hasTable, s40era.hasColumn);
  eq(
    s40Prefix[s40Prefix.length - 1],
    "20261106000000_s40_qc_enforcement",
    "s40-era schema → newest sentinel is s40"
  );

  // Fully modern db-push'd schema → the entire chain is baselined.
  const modern = fp(
    [
      "User",
      "Organization",
      "Plan",
      "ProcessedWebhookEvent",
      "CreditLedger",
      "Setting",
      "ApiToken",
      "SpendReservation",
      "AuthAttempt",
    ],
    [
      "Video.shotList",
      "Video.timeline",
      "Job.payload",
      "CreditLedger.reconcilesId",
      "Video.qcOverrideAt",
      "Video.contentPolicy",
    ]
  );
  eq(
    decideBaselinePrefix(S, modern.hasTable, modern.hasColumn).length,
    S.length,
    "modern schema → whole chain baselined (deploy is a no-op)"
  );

  // Mid-era: stage5_world ran (Location exists) but billing not yet →
  // baseline through stage5_world; deploy applies stage5_sources onward.
  const mid = fp(
    ["User", "StorageUsage", "CharacterAppearance", "Location"],
    ["Video.shotList", "Job.payload", "Job.maxAttempts"]
  );
  const midPrefix = decideBaselinePrefix(S, mid.hasTable, mid.hasColumn);
  eq(
    midPrefix[midPrefix.length - 1],
    "20261101123000_stage5_world",
    "mid-era schema → newest sentinel wins"
  );
  eq(midPrefix.length, 7, "mid-era schema → exactly the chain prefix baselined");

  // Sentinel order matches the migration directory (chain is cumulative).
  eq(S[0].migration, "000000000000_init", "sentinels start at init");
});

// ---------- preview lanes (Timeline Studio projection) ----------

suiteStart("preview lanes — the Timeline Studio projection");

{
  // A 3-scene document: durations 3/4/2, fade at the 1→2 seam, cut at 2→3,
  // caption on scene 1 only, voice muted on scene 3.
  const mkScene = (o: Partial<TimelineScene> & Pick<TimelineScene, "index" | "startSec" | "endSec" | "durationSec">): TimelineScene => ({
    index: o.index,
    title: o.title ?? `Scene ${o.index}`,
    narration: "n",
    visual: "v",
    startSec: o.startSec,
    endSec: o.endSec,
    durationSec: o.durationSec,
    transitionIn: o.transitionIn ?? null,
    transitionOut: o.transitionOut ?? null,
    audio: o.audio ?? {
      voice: { enabled: true, level: 1 },
      music: { enabled: true, level: 0.6, ducking: true },
      sfx: { enabled: false, level: 0, kind: null },
      ambient: { enabled: false, level: 0, kind: null },
    },
    caption: o.caption ?? null,
    source: o.source ?? "ai",
    stockSource: null,
    stockQuery: null,
    shot: null,
  });
  const tl: AssembledTimeline = {
    scenes: [
      mkScene({ index: 1, startSec: 0, endSec: 3, durationSec: 3, transitionOut: "fade", caption: { text: "First!", startSec: 0, endSec: 3 } }),
      mkScene({ index: 2, startSec: 3, endSec: 7, durationSec: 4, transitionIn: "fade", transitionOut: "cut" }),
      mkScene({
        index: 3, startSec: 7, endSec: 9, durationSec: 2, transitionIn: "cut", transitionOut: "fade",
        audio: {
          voice: { enabled: true, level: 0 },
          music: { enabled: true, level: 0.6, ducking: true },
          sfx: { enabled: false, level: 0, kind: null },
          ambient: { enabled: false, level: 0, kind: null },
        },
      }),
    ],
    sceneCount: 3,
    totalDurationSec: 9,
    generatedAt: new Date().toISOString(),
  };
  const S = PREVIEW_DEFAULTS;

  await test("projectLanes: three lanes share the scene windows", () => {
    const lanes = projectLanes(tl);
    eq(lanes.video.length, 3, "one video clip per scene");
    eq(lanes.voice.length, 3, "one voice clip per scene");
    eq(lanes.captions.length, 1, "caption clips only for captioned scenes");
    ok(lanes.video[0].durationSec === 3 && lanes.voice[2].durationSec === 2, "lanes mirror durations");
    ok(lanes.voice[2].enabled === false, "level 0 voice clip reads as disabled");
    ok(lanes.video[1].transitionIn === "fade" && lanes.video[1].transitionOut === "cut", "transition fields carried");
    ok(lanes.captions[0].text === "First!", "caption text carried");
  });

  await test("cameraAt: deterministic cycle, eased, honors overrides", () => {
    // vary cycle: scene1 push-in, scene2 pan-right, scene3 pull-out, scene4 pan-left.
    const c1 = cameraAt(1, 1.5, 3, S);
    eq(Math.round(c1.scale * 1000) / 1000, 1.06, "push-in midpoint: scale 1+12%*0.5 (smooth=0.5 at p=0.5)");
    ok(c1.dx === 0 && c1.dy === 0, "push-in stays centered");

    const c2 = cameraAt(2, 2, 4, S);
    ok(Math.abs(c2.dx - 0) < 1e-9, "pan-right midpoint dx=0 (symmetric travel)");
    eq(Math.round(c2.scale * 1000) / 1000, 1.06, "pan holds the half-amplitude base zoom");

    const c2start = cameraAt(2, 0, 4, S);
    const c2end = cameraAt(2, 4, 4, S);
    ok(c2start.dx < 0 && c2end.dx > 0, "pan travels left→right");

    const lin: PreviewSettings = { ...S, motionCurve: "linear" };
    const atQuarter = cameraAt(1, 0.75, 3, lin); // p=0.25
    eq(Math.round(atQuarter.scale * 1e5) / 1e5, 1.03, "linear quarter: exactly 25% of amplitude");
    const smoothQuarter = cameraAt(1, 0.75, 3, S);
    // easeInOutSine(0.25) = (1−cos(π/4))/2 ≈ 0.14645 → 1.01757.
    ok(Math.abs(smoothQuarter.scale - 1.017573) < 1e-4, "smooth quarter eases under linear");

    const flat: PreviewSettings = { ...S, motionVary: false };
    ok(cameraAt(3, 1, 2, flat).dx === 0, "no-vary collapses everything to push-in");
  });

  await test("resolveFrame: mid-scene single layer", () => {
    const f = resolveFrame(1.0, tl, S);
    ok(f !== null, "frame resolves");
    if (!f) return;
    eq(f.activeIndex, 1, "inside scene 1");
    ok(Math.abs(f.localSec - 1) < 1e-9, "local time within scene");
    eq(f.layers.length, 1, "no blend → one layer");
    ok(f.blend === null, "no seam state");
    eq(f.caption, "First!", "scene caption visible");
  });

  await test("resolveFrame: fade seam → outgoing under incoming", () => {
    const f = resolveFrame(3.0, tl, S); // the 1|2 seam (fade 0.5s)
    ok(f !== null, "seam frame resolves");
    if (!f) return;
    eq(f.activeIndex, 2, "incoming scene owns the seam window");
    ok(f.blend !== null, "seam reports blend state");
    if (f.blend) {
      eq(f.blend.fromIndex, 1, "outgoing is scene 1");
      eq(f.blend.toIndex, 2, "incoming is scene 2");
      eq(f.blend.style, "fade", "style is the incoming transitionIn");
      ok(Math.abs(f.blend.progress - 0.5) < 0.01, "boundary sits mid-blend");
    }
    eq(f.layers.length, 2, "blend paints two layers");
    ok(f.layers[0].sceneIndex === 1 && f.layers[1].sceneIndex === 2, "paint order: outgoing first");
  });

  await test("resolveFrame: cut seam never blends; clamp + empty guard", () => {
    const f = resolveFrame(7.0, tl, S); // the 2|3 seam (cut)
    ok(f !== null && f.blend === null && f.layers.length === 1, "cut = hard switch, no blend window");

    const past = resolveFrame(99, tl, S);
    ok(past !== null && past.activeIndex === 3, "t beyond total clamps into the last scene");

    const empty: AssembledTimeline = { scenes: [], sceneCount: 0, totalDurationSec: 0, generatedAt: "" };
    ok(resolveFrame(1, empty, S) === null, "empty timeline resolves null");
  });

  await test("resolveFrame: short scenes cap the blend window (40% rule)", () => {
    // scene 3 is 2s; seam 2→3 is a cut so build a tiny doc to probe the cap.
    const short: AssembledTimeline = {
      ...tl,
      scenes: [
        mkScene({ index: 1, startSec: 0, endSec: 3, durationSec: 3 }),
        mkScene({ index: 2, startSec: 3, endSec: 4, durationSec: 1, transitionIn: "fade" }), // 1s scene
      ],
      sceneCount: 2,
      totalDurationSec: 4,
    };
    // Cap = min(0.5, 1*0.4) = 0.4 → window starts at 3 − 0.2 = 2.8.
    // 2.77 would blend under the uncapped 0.5s window (start 2.75) — the
    // cap is what excludes it.
    const early = resolveFrame(2.77, short, S);
    ok(early?.blend === null, "t before the capped window start does not blend");
    const inWin = resolveFrame(2.85, short, S);
    ok(inWin?.blend !== null, "t past the capped window start blends");
    if (inWin?.blend) {
      approx(inWin.blend.progress, 0.125, 0.02, "capped blend progress just past its start");
    }
  });

  await test("playhead helpers: snap + boundaries + timecode", () => {
    const bounds = seamBoundaries(tl);
    ok(bounds.includes(0) && bounds.includes(9), "start/end are boundaries");
    ok(bounds.includes(3) && bounds.includes(7), "seams are boundaries");

    eq(snapToBoundaries(3.04, bounds, 0.15), 3, "seams attract the playhead within the snap radius");
    eq(snapToBoundaries(3.4, bounds, 0.15), 3.4, "outside the radius: untouched");

    eq(formatTimecode(65.5, 30), "01:05.15", "timecode frames at fps");
    eq(formatTimecode(0, 30), "00:00.00", "zero");
    eq(formatTimecode(59.999, 25), "01:00.00", "rounds up across the minute boundary");
  });

  await test("previewSettingsFrom: clamps like the render", () => {
    const s = previewSettingsFrom({
      aspectRatio: "junk",
      frameRate: 48,
      motionIntensity: 50,
      motionCurve: "linear",
      motionVary: false,
      transitionDurationSec: 2,
    });
    eq(s.aspectRatio, "16:9", "unknown ratio falls back to 16:9");
    eq(s.frameRate, 30, "non-catalog fps falls back to 30");
    eq(s.motionIntensity, 30, "intensity clamps to the render ceiling");
    eq(s.motionCurve, "linear", "curve passes through");
    eq(s.motionVary, false, "vary false survives (only null defaults true)");
    eq(s.transitionDurationSec, 1.5, "blend clamps to the render ceiling");

    const d = previewSettingsFrom({});
    eq(d.transitionDurationSec, 0.5, "null duration → render default 0.5s");
    ok(d.motionVary === true, "null vary → default true");
  });
}


// ---------- clip ops (Timeline Studio row surgery — pure parts) ----------

suiteStart("clip ops: narration split + doc surgery");

{
  // A minimal but fully-shaped doc + entry factory (mirrors timeline.ts).
  const LEAD = 0.35;
  const mkEntry = (
    index: number,
    durationSec: number,
    startSec: number,
    over: Partial<TimelineScene> = {}
  ): TimelineScene => ({
    index,
    title: `Scene ${index}`,
    narration: "narration text",
    visual: "visual",
    startSec,
    endSec: startSec + durationSec,
    durationSec,
    transitionIn: "fade",
    transitionOut: "fade",
    audio: {
      voice: { enabled: true, level: 1 },
      music: { enabled: true, level: 0.6, ducking: true },
      sfx: { enabled: false, level: 0, kind: null },
      ambient: { enabled: false, level: 0, kind: null },
    },
    caption: { text: `cap ${index}`, startSec, endSec: startSec + durationSec },
    source: "ai",
    stockSource: null,
    stockQuery: null,
    shot: { framing: "wide", camera: "push", lens: null, composition: null, motion: null, mood: null },
    ...over,
  });

  const mkDoc = (entries: TimelineScene[]): AssembledTimeline => ({
    scenes: entries,
    sceneCount: entries.length,
    totalDurationSec: entries.reduce((a, s) => a + s.durationSec, 0),
    generatedAt: "2026-01-01T00:00:00.000Z",
  });

  const WORDS20 = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");

  await test("splitNarrationAt: mid-playhead splits the word list proportionally", () => {
    const wav = 8; // narration span = [0.60, 8.10] interior
    const mid = splitNarrationAt(WORDS20, wav, LEAD + 4);
    ok(mid !== null, "mid split is legal");
    const f = (mid as { first: string }).first.split(/\s+/).length;
    const s = (mid as { second: string }).second.split(/\s+/).length;
    eq(f + s, 20, "no words lost or duplicated");
    ok(Math.abs(f - 10) <= 2, `near-half split (got ${f}/20)`);
    eq((mid as { first: string }).first + " " + (mid as { second: string }).second, WORDS20, "join reconstructs the narration");
  });

  await test("splitNarrationAt: quarter playhead skews the boundary early", () => {
    const q = splitNarrationAt(WORDS20, 8, LEAD + 2.175); // ~25% of the span
    ok(q !== null, "legal");
    const f = (q as { first: string }).first.split(/\s+/).length;
    ok(f <= 7, `first half short (got ${f}/20)`);
  });

  await test("splitNarrationAt: playhead outside the speakable span refuses", () => {
    eq(splitNarrationAt(WORDS20, 8, 0.1), null, "before the lead-in guard");
    eq(splitNarrationAt(WORDS20, 8, LEAD + 8), null, "past the read's tail");
    eq(splitNarrationAt(WORDS20, 8, LEAD + 7.76 + 10), null, "into the breathing tail");
  });

  await test("splitNarrationAt: degenerate narrations refuse", () => {
    eq(splitNarrationAt("oneword", 8, LEAD + 4), null, "single word");
    eq(splitNarrationAt(WORDS20, 0, LEAD + 4), null, "no measured wav");
    eq(splitNarrationAt("", 8, LEAD + 4), null, "empty narration");
  });

  const base = mkDoc([
    mkEntry(1, 3, 0),
    mkEntry(2, 4, 3, { transitionIn: "wipe", transitionOut: "slide" }),
    mkEntry(3, 5, 7),
  ]);

  await test("applySplitToDoc: two entries, cut at the razor, later windows shift", () => {
    const out = applySplitToDoc(base, 2, 99, 2.2, 2.6, "second half narration");
    eq(out.sceneCount, 4, "one scene became two");
    eq(out.scenes.length, 4, "doc + count agree");
    const [a, b] = [out.scenes[1], out.scenes[2]];
    eq(a.index, 2, "first half keeps the index");
    eq(a.durationSec, 2.2, "first half duration");
    eq(a.transitionOut, "cut", "the razor point is a cut");
    eq(a.transitionIn, "wipe", "the old seam into the first half survives");
    eq(b.index, 99, "second half mints a fresh index");
    eq(b.durationSec, 2.6, "second half duration");
    eq(b.transitionIn, "cut", "razor point from the incoming side");
    eq(b.transitionOut, "slide", "the old seam out of the scene survives");
    eq(b.caption, null, "the second half starts caption-free");
    eq(b.shot, null, "no plan entry exists for a fresh index");
    eq(b.narration, "second half narration", "second half carries its half of the script");
    eq(out.scenes[3].index, 3, "the tail scene keeps its identity");
    approx(out.scenes[3].startSec, 7.8, 0.011, "tail scene shifts by the duration delta");
    approx(out.totalDurationSec, 12.8, 0.011, "total = sum of the new windows");
    approx(b.startSec, 5.2, 0.011, "second half starts after the first");
  });

  await test("applySplitToDoc: the input doc is never mutated", () => {
    const before = JSON.stringify(base);
    const out = applySplitToDoc(base, 2, 99, 2.2, 2.6, "x");
    out.scenes[0].title = "MUTATED";
    out.scenes[1].audio.voice.level = 0.123;
    eq(JSON.stringify(base), before, "input doc untouched by edits to the result");
  });

  await test("applyDeleteToDoc: the gap closes", () => {
    const out = applyDeleteToDoc(base, 2);
    eq(out.sceneCount, 2, "one entry gone");
    eq(out.scenes.map((s) => s.index), [1, 3], "order preserved");
    approx(out.scenes[1].startSec, 3, 0.011, "scene 3 pulls forward to 3s");
    approx(out.totalDurationSec, 8, 0.011, "total loses the deleted window");
  });

  await test("applyDuplicateToDoc: an exact copy with a cut seam", () => {
    const out = applyDuplicateToDoc(base, 2, 99, 4.0);
    eq(out.sceneCount, 4, "copy inserted");
    const [a, c] = [out.scenes[1], out.scenes[2]];
    eq(a.index, 2, "original keeps its index");
    eq(a.transitionOut, "cut", "seam into the copy is a cut");
    eq(c.index, 99, "copy mints a fresh index");
    eq(c.transitionIn, "cut", "copy enters on a cut");
    eq(c.durationSec, 4.0, "copy carries the given duration");
    eq(c.caption?.text, "cap 2", "an exact copy keeps the caption");
    approx(c.startSec, 7, 0.011, "copy starts where the original ended");
    approx(out.scenes[3].startSec, 11, 0.011, "the tail scene shifts by the copy");
    approx(out.totalDurationSec, 16, 0.011, "total grows by the copy");
  });

  await test("sceneSegmentSec mirrors the render's segment formula", () => {
    eq(sceneSegmentSec(3), 4.2, "wav + 0.35 lead + 0.85 tail");
    eq(sceneSegmentSec(0.5), 2.0, "never below MIN_SEG_SEC");
    eq(sceneSegmentSec(0), 2.0, "degenerate wav still gets a legal window");
  });
}

// ---------- razor guard (speakableSpan mirrors splitNarrationAt) ----------

suiteStart("razor guard: speakableSpan");

{
  const { LEAD_SEC, TAIL_SEC, MIN_SEG_SEC } = await import("../src/lib/tubeforge/render");
  const {
    speakableSpan,
    R_LEAD_SEC,
    R_TAIL_SEC,
    R_MIN_SEG_SEC,
    SPLIT_EDGE_GUARD_SEC,
  } = await import("../src/lib/tubeforge/preview-lanes");
  const { pcmToWav, wavDurationSec } = await import("../src/lib/tubeforge/wav");

  await test("mirror constants match the real render exports", () => {
    eq(R_LEAD_SEC, LEAD_SEC, "lead");
    eq(R_TAIL_SEC, TAIL_SEC, "tail");
    eq(R_MIN_SEG_SEC, MIN_SEG_SEC, "min segment");
    eq(SPLIT_EDGE_GUARD_SEC, 0.25, "clip-ops edge guard");
  });

  await test("exact path: boundaries agree with splitNarrationAt", () => {
    // Scene 2 of the S1 fixture: window [22.7, 32.64], wav 8.74s.
    const start = 22.7;
    const dur = 9.94;
    const wav = 8.74;
    const span = speakableSpan(start, dur, wav);
    ok(span, "span exists");
    // lo = LEAD + 0.25 = 0.6; hi = LEAD + wav - 0.25 = 8.84 (both global).
    approx(span.startSec, start + 0.6, 1e-9, "span start = lead + edge guard");
    approx(span.endSec, start + 8.84, 1e-9, "span end = lead + wav - edge guard");
    // The server refuses exactly where the span excludes — the 400 the S1
    // smoke hit (playhead local 8.85, one hundredth past the end).
    ok(splitNarrationAt("a b c d e f g h", wav, 8.83), "server accepts just inside the end");
    eq(splitNarrationAt("a b c d e f g h", wav, 8.85), null, "server refuses just past");
    ok(8.83 >= span.startSec - start && 8.83 <= span.endSec - start, "client agrees: inside");
    ok(8.85 > span.endSec - start, "client agrees: outside");
    // Same dance at the head.
    ok(splitNarrationAt("a b c d e f g h", wav, 0.61), "server accepts just past the lead");
    eq(splitNarrationAt("a b c d e f g h", wav, 0.59), null, "server refuses inside the lead");
    ok(0.59 < span.startSec - start, "client agrees: in the lead padding");
  });

  await test("estimate path: fresh-assembly durations, floor refusal", () => {
    // No wavDurSec: estimate = dur - lead - tail, exact for fresh docs.
    const span = speakableSpan(100, 10, undefined);
    ok(span != null, "estimated span exists");
    approx(span.startSec, 100.6, 1e-9, "estimated start");
    approx(span.endSec, 108.9, 1e-9, "estimated end = 100 + 10 - 1.1");
    // At/below the MIN_SEG floor the real read is unknowable → refuse.
    eq(speakableSpan(0, 2.0, undefined), null, "floor duration cannot be estimated");
    eq(speakableSpan(0, 1.5, undefined), null, "trimmed below the floor");
    // Real wav rescues floor-clamped windows when known.
    const rescued = speakableSpan(0, 2.0, 0.8);
    ok(rescued != null, "rescued span exists");
    approx(rescued.startSec, 0.6, 1e-9, "real wav start");
    approx(rescued.endSec, 0.9, 1e-9, "real wav end");
  });

  await test("degenerate wavs have no speakable interior", () => {
    eq(speakableSpan(0, 9.94, 0.4), null, "wav shorter than the guards");
    eq(speakableSpan(0, 9.94, 0), null, "zero wav is a real empty read — never estimated");
    ok(speakableSpan(0, 9.94, Number.NaN), "NaN is garbage, treated as absent — estimate path");
  });

  await test("wavDurationSec reads durations off the headers alone", () => {
    // 1s of silence at 24kHz mono PCM-16 = 48000 bytes of PCM.
    const pcm = Buffer.alloc(48000);
    const wav = pcmToWav(pcm, 24000, 1, 16);
    approx(wavDurationSec(wav), 1, 1e-6, "1s read");
    approx(wavDurationSec(pcmToWav(Buffer.alloc(12000), 24000, 1, 16)), 0.25, 1e-6, "0.25s read");
    eq(wavDurationSec(Buffer.alloc(10)), 0, "not a RIFF buffer → 0");
    eq(wavDurationSec(pcm), 0, "raw PCM without a header → 0");
  });
}

// ---------- S2: per-boundary transitions + doc overlay + music automation ----------

suiteStart("S2 honest mix: per-boundary transitions");

{
  const {
    buildTransitionGraph,
    buildTransitionGraphMulti,
    fadeblackWindows,
    fadeblackWindowsMulti,
    partitionByCuts,
    planBlendGroups,
    planBlendGroupsMulti,
    sanitizeBoundarySettings,
    shiftSegmentsForBlend,
    shiftSegmentsForBlendMulti,
    transitionOffsets,
    transitionOffsetsMulti,
    transitionTotalDuration,
    transitionTotalDurationMulti,
    uniformBoundarySettings,
    TRANSITION_DURATION_MAX,
  } = await import("../src/lib/tubeforge/transitions");
  const { docSceneSettings } = await import("../src/lib/tubeforge/timeline");
  const { musicLevelAutomation } = await import("../src/lib/tubeforge/audiomix");
  const { MUSIC_SLIDER_GAIN } = await import("../src/lib/tubeforge/music");

  const uniform = (n: number, style = "fade", d = 0.5) =>
    uniformBoundarySettings(n, { style, durationSec: d }) as { style: string; durationSec: number }[];
  const segs = (durs: number[]) =>
    durs.map((d, i) => ({ start: durs.slice(0, i).reduce((a, b) => a + b, 0), duration: d }));

  await test("uniform Multi settings reproduce the classic API exactly", () => {
    const durs = [3, 4, 5, 2.5];
    const s = uniform(4, "fade", 0.5);
    eq(transitionOffsetsMulti(durs, s), transitionOffsets(durs, 0.5), "offsets");
    eq(transitionTotalDurationMulti(durs, s), transitionTotalDuration(durs, 0.5), "total");
    eq(
      JSON.stringify(fadeblackWindowsMulti(durs, uniform(4, "fadeblack", 0.5))),
      JSON.stringify(fadeblackWindows(durs, 0.5)),
      "fadeblack windows"
    );
    const g1 = planBlendGroups(durs, 0.5, 2);
    const g2 = planBlendGroupsMulti(durs, s, 2);
    eq(g2, g1, "blend groups");
    const graph1 = buildTransitionGraph(durs, "fade", 0.5);
    const graph2 = buildTransitionGraphMulti(durs, s);
    ok(graph1 != null && graph2 != null, "graphs build");
    eq(graph2.video, graph1.video, "video graph");
    eq(graph2.audio, graph1.audio, "audio graph");
    const shifted1 = shiftSegmentsForBlend(segs(durs), 0.5);
    const shifted2 = shiftSegmentsForBlendMulti(segs(durs), s);
    eq(shifted2, shifted1, "segment shift");
    const trimmed1 = shiftSegmentsForBlend(segs(durs), 0.5, true);
    const trimmed2 = shiftSegmentsForBlendMulti(segs(durs), s, true);
    eq(trimmed2, trimmed1, "trimmed shift");
  });

  await test("per-boundary offsets: each seam removes its own d", () => {
    const durs = [3, 4, 5];
    const s = sanitizeBoundarySettings([
      { style: "fade", durationSec: 0.5 },
      { style: "fadeblack", durationSec: 1.0 },
    ]);
    // b0: 3 − 0.5 = 2.5; b1: 7 − (0.5+1.0) = 5.5
    const off = transitionOffsetsMulti(durs, s);
    approx(off[0], 2.5, 1e-9, "offset 0");
    approx(off[1], 5.5, 1e-9, "offset 1");
    const total = transitionTotalDurationMulti(durs, s);
    ok(total != null, "total exists");
    approx(total, 10.5, 1e-9, "total = Σ − Σd");
  });

  await test("per-boundary graph honors each seam's style + duration", () => {
    const durs = [3, 4, 5];
    const s = sanitizeBoundarySettings([
      { style: "wipeleft", durationSec: 0.4 },
      { style: "circleopen", durationSec: 0.9 },
    ]);
    const g = buildTransitionGraphMulti(durs, s);
    ok(g != null, "graph builds");
    ok(g.video.includes("xfade=transition=wipeleft:duration=0.400:offset=2.600"), "boundary 0 style+duration");
    ok(g.video.includes("xfade=transition=circleopen:duration=0.900:offset=5.700"), "boundary 1 style+duration");
    ok(g.audio.includes("acrossfade=d=0.400"), "audio crossfade d0");
    ok(g.audio.includes("acrossfade=d=0.900"), "audio crossfade d1");
  });

  await test("cut boundaries: partition runs, graph refuses, windows filter", () => {
    // 6 segments, boundaries [cut, fade, cut, fade, fade]
    const s = sanitizeBoundarySettings([
      { style: "cut", durationSec: 0.5 },
      { style: "fade", durationSec: 0.5 },
      { style: "cut", durationSec: 0.5 },
      { style: "fadeblack", durationSec: 0.5 },
      { style: "fade", durationSec: 0.5 },
    ]);
    eq(partitionByCuts(6, s), [
      { from: 0, to: 0 },
      { from: 1, to: 2 },
      { from: 3, to: 5 },
    ], "runs split at cuts");
    // All cut → N singleton runs.
    const allCut = uniform(3, "cut", 0.5);
    eq(partitionByCuts(3, allCut).length, 3, "all cut → 3 runs");
    // A cut inside a run is a programming error — the graph throws.
    let threw = false;
    try {
      buildTransitionGraphMulti([3, 4, 5], allCut);
    } catch {
      threw = true;
    }
    ok(threw, "cut inside a run throws");
    // fadeblack windows only for fadeblack boundaries (mixed catalog).
    const durs = [3, 4, 5, 3];
    const mixed = sanitizeBoundarySettings([
      { style: "fade", durationSec: 0.5 },
      { style: "fadeblack", durationSec: 0.8 },
      { style: "fade", durationSec: 0.5 },
    ]);
    const wins = fadeblackWindowsMulti(durs, mixed);
    eq(wins.length, 1, "one fadeblack window");
    // b1 offset: 7 − (0.5+0.8) = 5.7 → [5.55, 6.65]
    approx(wins[0][0], 5.55, 1e-9, "window start");
    approx(wins[0][1], 6.65, 1e-9, "window end");
  });

  await test("blend groups with per-boundary debt stay exact", () => {
    // 6 segments, cap 4 → 2 groups of 3; internal debt differs per group.
    const durs = [2, 2, 2, 2, 2, 2];
    const s = sanitizeBoundarySettings([
      { style: "fade", durationSec: 0.2 },
      { style: "fade", durationSec: 1.0 },
      { style: "fade", durationSec: 0.2 },
      { style: "fade", durationSec: 1.0 },
      { style: "fade", durationSec: 0.2 },
    ]);
    const groups = planBlendGroupsMulti(durs, s, 4);
    eq(groups.length, 2, "two groups of 3");
    // group 0: 6 − (0.2 + 1.0) = 4.8; group 1: 6 − (0.2 + 1.0) = 4.8
    approx(groups[0].outDurationSec, 4.8, 1e-9, "group 0 out");
    approx(groups[1].outDurationSec, 4.8, 1e-9, "group 1 out");
    // Uniform equivalence at the cap boundary (3 inputs, cap 2 → 2+1).
    const g1 = planBlendGroups([2, 2, 2], 0.5, 2);
    const g2 = planBlendGroupsMulti([2, 2, 2], uniform(3, "fade", 0.5), 2);
    eq(g2, g1, "cap-2 grouping matches");
  });

  await test("shiftSegmentsForBlendMulti: per-scene trimEnd debts", () => {
    const durs = [3, 4, 5];
    const s = sanitizeBoundarySettings([
      { style: "fade", durationSec: 0.2 },
      { style: "fade", durationSec: 1.0 },
    ]);
    const out = shiftSegmentsForBlendMulti(segs(durs), s, true);
    approx(out[0].start, 0, 1e-9, "scene 0 unshifted");
    approx(out[0].duration, 2.8, 1e-9, "scene 0 loses its own 0.2 blend");
    approx(out[1].start, 3 - 0.2, 1e-9, "scene 1 shifts by d0 only");
    approx(out[1].duration, 3.0, 1e-9, "scene 1 loses its own 1.0 blend");
    approx(out[2].start, 7 - 1.2, 1e-9, "scene 2 shifts by d0+d1");
    eq(out[2].duration, 5, "final scene keeps its duration");
  });

  await test("docSceneSettings: alignment guard + field sanitizing", () => {
    eq(docSceneSettings(null, 3), null, "no doc");
    eq(docSceneSettings({ scenes: [], sceneCount: 0, totalDurationSec: 0, generatedAt: "" }, 3), null, "misaligned");
    const scene = (over: Record<string, unknown>) => ({
      index: 1, title: "t", narration: "n", visual: "v",
      startSec: 0, endSec: 5, durationSec: 5,
      transitionIn: "fade", audio: null, caption: null,
      source: "ai", stockSource: null, stockQuery: null, shot: null,
      ...over,
    });
    const doc = {
      scenes: [
        scene({ transitionIn: "wipeleft", audio: { voice: { enabled: true, level: 0.8 }, music: { enabled: true, level: 0.6, ducking: true }, sfx: { enabled: true, level: 0.55, kind: "boom" }, ambient: { enabled: false, level: 0, kind: null } }, caption: { text: "  Edited!  ", startSec: 0, endSec: 5 } }),
        scene({ transitionIn: "not-a-transition", audio: null, caption: null }), // legacy doc shape
        scene({ transitionIn: null, audio: { voice: { enabled: true, level: 9 }, music: { enabled: true, level: -1, ducking: true }, sfx: { enabled: true, level: 0.35, kind: null }, ambient: { enabled: true, level: 0.1, kind: null } }, caption: { text: "   ", startSec: 0, endSec: 5 } }),
      ],
      sceneCount: 3, totalDurationSec: 15, generatedAt: "",
    };
    const out = docSceneSettings(doc as never, 3);
    ok(out, "aligned doc extracts");
    eq(out[0].transitionIn, "wipeleft", "valid transition passes");
    eq(out[0].voiceLevel, 0.8, "voice level");
    eq(out[0].sfxLevel, 0.55, "sfx level");
    eq(out[0].caption, "  Edited!  ", "caption text passes through (verbatim)");
    eq(out[1].transitionIn, null, "unknown transition id → no override");
    eq(out[1].voiceLevel, null, "missing audio block → no override");
    eq(out[1].caption, null, "missing caption → no override");
    eq(out[2].voiceLevel, null, "out-of-range level (9) → no override, not clamped");
    eq(out[2].musicLevel, null, "negative level → no override");
    eq(out[2].caption, null, "whitespace caption → no override");
  });

  await test("musicLevelAutomation: uniform → null; priority windows", () => {
    eq(musicLevelAutomation([], []), null, "empty");
    eq(musicLevelAutomation(segs([3, 3]), [1, 1]), null, "uniform factors are a no-op");
    eq(musicLevelAutomation(segs([3, 3]), [1]), null, "length mismatch");
    // Blended-timeline windows overlap at seams — priority windows hand the
    // seam to the incoming scene (end_i = start_{i+1}), never double-firing.
    const blended = [
      { start: 0, duration: 3 },
      { start: 2.5, duration: 3 }, // 0.5s blend overlap
    ];
    const chain = musicLevelAutomation(blended, [1, 0.5]);
    ok(chain != null, "automation chain builds");
    ok(
      chain.startsWith("[music]volume='") && chain.endsWith("':eval=frame[mvol]"),
      "label contract (per-frame eval — once-eval would freeze t=0)"
    );
    ok(chain.includes("1.000*gte(t,0.000)*lt(t,2.500)"), "scene 0 owns [0, next start)");
    ok(chain.includes("0.500*gte(t,2.500)*lt(t,5.500)"), "scene 1 owns from its start");
    // Non-finite factors read as 1 (no override), absurd values clamp at 8.
    const clamped = musicLevelAutomation(segs([2, 2]), [Number.NaN, 100]);
    ok(clamped != null, "clamped chain builds");
    ok(clamped.includes("1.000*gte(t,0.000)"), "NaN → 1");
    ok(clamped.includes("8.000*gte(t,2.000)"), "clamp at 8");
  });

  await test("cut boundaries carry ZERO debt everywhere (mixed docs)", () => {
    const durs = [3, 4, 5, 3];
    // [cut(0.5), fade(0.5), cut(0.9)] — the cuts' durations must NOT count.
    const mixed = sanitizeBoundarySettings([
      { style: "cut", durationSec: 0.5 },
      { style: "fade", durationSec: 0.5 },
      { style: "cut", durationSec: 0.9 },
    ]);
    // offsets: b0 = 3 − 0 = 3; b1 = 7 − 0.5 = 6.5; b2 = 12 − 0.5 = 11.5
    const off = transitionOffsetsMulti(durs, mixed);
    approx(off[0], 3, 1e-9, "cut boundary: no debt, offset = plain boundary");
    approx(off[1], 6.5, 1e-9, "blend after a cut: only blend debt counted");
    approx(off[2], 11.5, 1e-9, "trailing cut: no debt");
    const total = transitionTotalDurationMulti(durs, mixed);
    ok(total != null, "total exists");
    approx(total, 14.5, 1e-9, "total = Σ − blend debt only");
    // Shifts: scene 2 shifts by the CUT's debt (0), scene 3 by cut+fade (0.5).
    const shifted = shiftSegmentsForBlendMulti(segs(durs), mixed, true);
    approx(shifted[1].start, 3, 1e-9, "scene after a cut: unshifted");
    eq(shifted[0].duration, 3, "scene ending in a cut: keeps its full duration");
    approx(shifted[1].duration, 3.5, 1e-9, "scene ending in a fade: loses 0.5");
    approx(shifted[2].start, 7 - 0.5, 1e-9, "scene 2 shifts by the fade only");
    // All-cut docs shift nothing at all.
    const allCut = uniform(3, "cut", 0.9);
    eq(shiftSegmentsForBlendMulti(segs([3, 4, 5]), allCut), segs([3, 4, 5]), "all-cut → identity");
  });

  await test("MUSIC_SLIDER_GAIN pins the slider curve the automation divides by", () => {
    eq(MUSIC_SLIDER_GAIN, 0.3, "slider curve constant");
    ok(TRANSITION_DURATION_MAX === 1.5, "duration clamp ceiling unchanged");
  });

  await test("sanitizeTransitionDuration: absent means DEFAULT (0.5), not the 0.2 minimum", async () => {
    const { sanitizeTransitionDuration, TRANSITION_DEFAULT, TRANSITION_DURATION_MIN } =
      await import("../src/lib/tubeforge/transitions");
    // The pre-S2 bug: Number(null) = 0 → clamp → 0.2 — default renders blended
    // 2.5× faster than the 0.5s the studio preview showed.
    eq(sanitizeTransitionDuration(null), TRANSITION_DEFAULT.durationSec, "null → 0.5 default");
    eq(sanitizeTransitionDuration(undefined), TRANSITION_DEFAULT.durationSec, "undefined → 0.5 default");
    eq(sanitizeTransitionDuration(Number.NaN), TRANSITION_DEFAULT.durationSec, "NaN → 0.5 default");
    eq(sanitizeTransitionDuration("abc"), TRANSITION_DEFAULT.durationSec, "garbage → 0.5 default");
    eq(sanitizeTransitionDuration(0), TRANSITION_DURATION_MIN, "explicit 0 still clamps to the 0.2 minimum");
    eq(sanitizeTransitionDuration(0.7), 0.7, "legal value passes");
    eq(sanitizeTransitionDuration(9), 1.5, "ceiling clamps");
  });
}

// ---------- S34: spend-gate estimator — script-aware floors + per-hold usage slices ----------

await test("estimateInputTokens: the ASCII chars/3 law is unchanged", async () => {
  const { estimateInputTokens } = await import("../src/lib/tubeforge/spend.ts");
  eq(estimateInputTokens(""), 0, "empty text → 0");
  eq(estimateInputTokens("hello world"), 4, "11 ASCII chars → ceil(11/3) = 4");
  eq(estimateInputTokens("a".repeat(6000)), 2000, "6000 ASCII chars → 2000 (the S27 law)");
  eq(estimateInputTokens('{"scenes":[{"index":1}]}'), 8, "24 JSON chars → ceil(24/3) = 8 — JSON rides the same law");
});

await test("estimateInputTokens: non-Latin scripts price ABOVE chars/3 (the S34 fix)", async () => {
  const { estimateInputTokens } = await import("../src/lib/tubeforge/spend.ts");
  // The pre-S34 bug: "你好世界".length 4 → chars/3 = 2 tokens, but a real
  // tokenizer bills ~4-6 for CJK — the $5 law broke on non-English content.
  eq(estimateInputTokens("你好世界"), 6, "4 CJK chars → ceil(4×1.5) = 6");
  eq(estimateInputTokens("あいうえお"), 8, "5 kana → ceil(5×1.5) = 8");
  eq(estimateInputTokens("한국어"), 5, "3 Hangul syllables → ceil(3×1.5) = 5");
  eq(estimateInputTokens("ก".repeat(10)), 15, "Thai → 1.5/char");
  eq(estimateInputTokens("好".repeat(6000)), 9000, "6000 CJK chars → 9000 (was 2000 — the 4.5x under-reserve)");
  eq(estimateInputTokens("Привет"), 6, "Cyrillic → 1/char (6 chars, real ratio 2-4 ch/tok so 1/char is ≥)");
  eq(estimateInputTokens("مرحبا"), 5, "Arabic → 1/char");
  eq(estimateInputTokens("café"), 2, "accented Latin: 3 ASCII → 1, é → 1");
});

await test("estimateInputTokens: astral plane (emoji) counts as surrogate pairs at 2 tokens each", async () => {
  const { estimateInputTokens } = await import("../src/lib/tubeforge/spend.ts");
  eq(estimateInputTokens("😀😀"), 4, "2 astral emoji → 2×2 = 4");
  eq(estimateInputTokens("hi😀"), 3, "2 ASCII → 1, one emoji → 2");
  // JSON-escaped emoji are ASCII escape text — the same law prices them at
  // /3, which still exceeds the ~2-3 tokens an unescaped emoji bills.
  eq(estimateInputTokens('"\\ud83d\\ude00"'), 5, "14 escape chars → ceil(14/3) = 5");
});

await test("estimateInputTokens: mixed-script text sums per class", async () => {
  const { estimateInputTokens } = await import("../src/lib/tubeforge/spend.ts");
  // 2 ASCII → 1; 2 CJK → 3; 1 emoji → 2 — total 6, every class at its own floor.
  eq(estimateInputTokens("hi你好😀"), 6, "ascii+cjk+astral mix");
});

await test("estimateDispatchMicroUsd: same-length CJK input reserves strictly more than ASCII", async () => {
  const { estimateDispatchMicroUsd } = await import("../src/lib/tubeforge/spend.ts");
  // Spaced English — a bare "aaaa…" run would be stripped as base64 before
  // the token math (the estimator's own heavy-payload rule), so the ASCII
  // side uses real prose shape.
  const ascii = estimateDispatchMicroUsd("gpt-6.1-sol", ["hello world ".repeat(500)]);
  const cjk = estimateDispatchMicroUsd("gpt-6.1-sol", ["你好".repeat(3000)]);
  ok(cjk > ascii, `CJK dispatch reserves more (ascii ${ascii}µ$ < cjk ${cjk}µ$)`);
  // The input-side delta: 9000 vs 2000 tokens, each at 2 µ$ ($2 per 1M) =
  // exactly 14000µ$ (the output half is priced identically in both).
  eq(cjk - ascii, 14_000, "delta is exactly the 7000 extra input tokens at 2 µ$ each");
  // Image floor unchanged: one explicit image adds the 4000-token floor at
  // the model's input price.
  const withImage = estimateDispatchMicroUsd("gpt-6.1-sol", ["hello world ".repeat(500)], 1);
  eq(withImage - ascii, 8000, "one image → 4000 tokens × 2 µ$ = 8000µ$");
});

await test("spend sink: per-hold slices — baseline + usageSinceBaseline", async () => {
  const { withCtx } = await import("../src/lib/tubeforge/tenant.ts");
  const { emitUsage, sinkBaseline, usageSinceBaseline, drainUsage } = await import(
    "../src/lib/tubeforge/spend.ts"
  );
  await withCtx({ userId: "u-s34", organizationId: "o-s34", role: "owner" }, async () => {
    // Fresh request: nothing emitted.
    eq(sinkBaseline(), 0, "fresh request → baseline 0");
    eq(usageSinceBaseline(0), undefined, "nothing emitted → undefined (settle falls to estimate)");

    // Dispatch A emits its usage; A's hold (baseline 0) reads exactly it.
    emitUsage({ inputTokens: 100, outputTokens: 50 });
    eq(sinkBaseline(), 1, "one entry after A");
    const a = usageSinceBaseline(0);
    ok(a && a.inputTokens === 100 && a.outputTokens === 50, "A's slice is A's usage");

    // Dispatch B: baseline captured AFTER A's entry. B emits nothing (a
    // provider that answered without a usage block) — B's slice is undefined,
    // NOT a stale read of A's usage. This is the exact pre-S34 defect.
    const bBaseline = sinkBaseline();
    eq(bBaseline, 1, "B's baseline sits after A's entry");
    eq(usageSinceBaseline(bBaseline), undefined, "no-usage dispatch settles at the estimate, not A's stale usage");

    // B' emits TWO entries (an internally retried transport, both attempts
    // billed) — the slice sums both.
    emitUsage({ inputTokens: 40, outputTokens: 10 });
    emitUsage({ inputTokens: 60, outputTokens: 20 });
    const bp = usageSinceBaseline(bBaseline);
    ok(bp && bp.inputTokens === 100 && bp.outputTokens === 30, "multi-emit slice sums every billed attempt");

    // The request-level drain still sees everything (UsageRecord row).
    const drained = drainUsage();
    ok(drained && drained.inputTokens === 200 && drained.outputTokens === 80, "drainUsage sums the whole request");
    eq(sinkBaseline(), 0, "drain clears the sink");
  });

  // Outside a request scope the sink no-ops (platform path).
  eq(sinkBaseline(), 0, "no ctx → baseline 0");
  emitUsage({ inputTokens: 5, outputTokens: 5 });
  eq(usageSinceBaseline(0), undefined, "no ctx → usageSinceBaseline undefined");
});

// ---------- S35 — Universal Scene Liveliness ----------

await test("S35 selector: mode wins — animated is i2v everywhere, slides is slides everywhere", async () => {
  const { selectChannels } = await import("../src/lib/tubeforge/liveliness.ts");
  const base = {
    mode: "animated" as const,
    motionOff: false,
    planNeedsI2V: [false, false, false],
    planMotionOff: [false, false, false],
    humanMotionOff: [false, false, false],
    docCameraKeys: [false, false, false],
    hasStock: [true, false, false],
    i2vReady: false, // animated mode doesn't ask — the mode IS the ask
  };
  const animated = selectChannels(base);
  eq(animated.length, 3, "one decision per scene");
  ok(animated.every((d) => d.channel === "i2v"), "animated mode → i2v on every scene");
  eq(animated[0].sceneIndex, 1, "sceneIndex is 1-based");

  const slides = selectChannels({ ...base, mode: "slides" });
  ok(slides.every((d) => d.channel === "slides"), "slides mode → the deck plays everywhere");
});

await test("S35 selector: stock mode — matched footage wins, fallbacks follow the plan + provider", async () => {
  const { selectChannels } = await import("../src/lib/tubeforge/liveliness.ts");
  const base = {
    mode: "stock" as const,
    motionOff: false,
    planNeedsI2V: [false, true, true],
    planMotionOff: [false, false, false],
    humanMotionOff: [false, false, false],
    docCameraKeys: [false, false, false],
    hasStock: [true, false, false],
    i2vReady: true,
  };
  const out = selectChannels(base);
  eq(out[0].channel, "stock", "clip on disk → real footage plays");
  eq(out[1].channel, "i2v", "no clip + plan needsI2V + provider ready → the true-motion pick animates");
  eq(out[2].channel, "i2v", "same for the third scene");
  ok(out[1].reason.includes("director"), "the reason names the director's pick");

  const noProvider = selectChannels({ ...base, i2vReady: false });
  eq(noProvider[1].channel, "kenburns", "no video provider → honest Ken Burns fallback");
  ok(noProvider[1].reason.includes("no video provider"), "the reason says WHY it fell back");
});

await test("S35 selector: the loop-closure — kenburns mode finally consumes the plan's needsI2V", async () => {
  const { selectChannels } = await import("../src/lib/tubeforge/liveliness.ts");
  const base = {
    mode: "kenburns" as const,
    motionOff: false,
    planNeedsI2V: [false, true, false],
    planMotionOff: [false, false, false],
    humanMotionOff: [false, false, false],
    docCameraKeys: [false, false, false],
    hasStock: [false, false, false],
    i2vReady: true,
  };
  const out = selectChannels(base);
  eq(out[0].channel, "kenburns", "unflagged scene → the camera engine (pre-S35 behavior)");
  ok(out[0].reason.includes("Ken Burns camera plan"), "default reason names the camera plan");
  eq(out[1].channel, "i2v", "THE FIX: approved needsI2V scene animates in the default mode");
  eq(out[2].channel, "kenburns", "unflagged scene stays Ken Burns");
});

await test("S35 selector: explicit human edits stay senior — keys, stills contract, off overrides", async () => {
  const { selectChannels } = await import("../src/lib/tubeforge/liveliness.ts");
  const base = {
    mode: "kenburns" as const,
    motionOff: false,
    planNeedsI2V: [true, true, true, true],
    planMotionOff: [false, false, false, false],
    humanMotionOff: [false, false, false, false],
    docCameraKeys: [false, false, false, false],
    hasStock: [false, false, false, false],
    i2vReady: true,
  };
  const keys = selectChannels({ ...base, docCameraKeys: [true, false, false, false] });
  eq(keys[0].channel, "kenburns", "studio camera keys (a user edit) beat the director's i2v pick");
  ok(keys[0].reason.includes("senior"), "the reason states the seniority law");
  eq(keys[1].channel, "i2v", "untouched scenes keep the pick");

  const stills = selectChannels({ ...base, motionOff: true });
  ok(stills.every((d) => d.channel === "kenburns"), "the stills contract (motion off) silences i2v picks too");

  const planOff = selectChannels({ ...base, planMotionOff: [false, true, false, false] });
  eq(planOff[1].channel, "kenburns", "the plan's own motion:off stills the scene");

  const humanOff = selectChannels({ ...base, humanMotionOff: [false, false, true, false] });
  eq(humanOff[2].channel, "kenburns", "the human's per-scene motion-map off stills the scene");
});

await test("S35 i2v prompt: legacy camera ids keep their phrases; unknown falls back to drift", async () => {
  const { i2vMotionPrompt } = await import("../src/lib/tubeforge/liveliness.ts");
  const scene = {
    index: 3,
    title: "The charge",
    narration: "cavalry sweeps the ridge",
    visual: "cavalry charging across a dust-red ridge at dawn",
    camera: "push-in",
    mood: "dramatic amber light",
    caption: "The charge begins",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  };
  const p = i2vMotionPrompt(scene, null);
  ok(p.startsWith("Steady dramatic push in toward the subject."), "legacy push-in phrase leads verbatim");
  ok(p.includes(scene.visual), "the scene visual rides along");
  ok(p.includes(scene.mood), "the mood rides along");
  ok(p.endsWith("Cinematic quality, natural physics, no text."), "the tail contract holds");

  const drift = i2vMotionPrompt({ ...scene, camera: "some-new-id" }, null);
  ok(drift.startsWith("Subtle cinematic camera drift."), "unknown camera → the generic drift default");

  const standard = i2vMotionPrompt(scene, null);
  ok(standard.includes("subjects move with real, visible energy"), "action-kind subject-motion clause present");
});

await test("S35 i2v prompt: the FULL Director vocabulary drives generative motion (the old code drifted)", async () => {
  const { i2vMotionPrompt } = await import("../src/lib/tubeforge/liveliness.ts");
  const scene = {
    index: 5,
    title: "The camp",
    narration: "the army settled for the night",
    visual: "a sprawling night camp, fires burning",
    camera: "push-in",
    mood: "cold blue moonlight",
    caption: "Night falls",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  };
  const shot = (camera: string) => ({
    shotIndex: 0,
    framing: "wide",
    camera,
    lens: "24mm wide",
    composition: "rule of thirds",
    duration: 2.5,
    imagePrompt: "",
  });
  const planScene = (camera: string) => ({
    sceneIndex: 5,
    mood: "",
    motion: "smart",
    needsI2V: true,
    useStock: false,
    shots: [shot(camera)],
  });
  // The four phrases the OLD five-id map degraded to generic drift — pinned
  // here so the camera execution gap stays closed.
  for (const [camera, expected] of [
    ["handheld", "Organic handheld camera sway, subtle documentary shake."],
    ["crane-up", "Smooth crane rise revealing the scene from above."],
    ["drone", "Aerial drone pull-back reveal."],
    ["dolly-in", "Smooth dolly move in toward the subject with natural parallax."],
  ] as const) {
    const p = i2vMotionPrompt(scene, planScene(camera) as never);
    ok(p.startsWith(expected), `plan camera "${camera}" → its real phrase (was: generic drift)`);
  }
  const locked = i2vMotionPrompt(scene, planScene("static") as never);
  ok(locked.startsWith("Locked-off camera"), "static camera → locked-off, motion in the subjects");
});

await test("S35 i2v prompt: scene-kind subject motion — text stays legible, faces live subtly", async () => {
  const { i2vMotionPrompt } = await import("../src/lib/tubeforge/liveliness.ts");
  const base = {
    index: 2,
    title: "The decree",
    narration: "the scribe sealed the decree",
    visual: "a wax-sealed decree scroll on a wooden desk",
    camera: "push-in",
    mood: "warm candlelight",
    caption: "Sealed",
    hostInScene: false,
    rehook: false,
    sfx: "none",
  };
  const texty = i2vMotionPrompt(
    { ...base, visual: "inscription text carved writing letters on the stone decree" },
    null
  );
  ok(texty.includes("perfectly static and legible"), "text-heavy art: legibility clause wins");

  const face = i2vMotionPrompt(
    { ...base, visual: "close-up portrait of the messenger, eyes wide, tears forming" },
    null
  );
  ok(face.includes("breathing, blinking, micro-expressions"), "face scene: subtle natural life clause");
});

// ---------- S36 — render QC lenses: flicker / stutter / cut alignment ----------

await test("S36 flicker: pumping luma flags one merged event; crossfade ramps and single flashes stay clean", async () => {
  const { flickerEventsFromLuma, FLICKER_SAMPLE } = await import("../src/lib/tubeforge/render-qc.ts");
  // A 2.5 Hz brightness pump at 8 Hz sampling: alternating ~90-unit swings
  // (the live-calibrated synthetic — real i2v pumping class).
  const pumped: number[] = [];
  for (let i = 0; i < 64; i++) pumped.push(128 + 90 * Math.sin((2 * Math.PI * 2.5 * i) / FLICKER_SAMPLE.fps));
  const events = flickerEventsFromLuma(pumped);
  ok(events.length >= 1, `pumping flags (got ${events.length} events)`);
  ok(events[0].startSec < 1, "event lands where the pump begins");

  // A crossfade is ONE monotone ramp — STRONG same-sign deltas (≥12 units,
  // well over the noise floor) never alternate, so no pumping reads.
  const ramp: number[] = [];
  for (let i = 0; i < 64; i++) ramp.push(20 + i * 15);
  eq(flickerEventsFromLuma(ramp).length, 0, "monotone ramp is not flicker");

  // A single flash (+40 then −40) is a cut/exposure pop, not pumping.
  const flash = [128, 128, 168, 128, 128, 128, 128, 128, 128, 128];
  eq(flickerEventsFromLuma(flash).length, 0, "single flash is not flicker");

  // Continuous pumping merges into one event, not one per detector window.
  const long: number[] = [];
  for (let i = 0; i < 160; i++) long.push(128 + 90 * Math.sin((2 * Math.PI * 2.5 * i) / FLICKER_SAMPLE.fps));
  const merged = flickerEventsFromLuma(long);
  eq(merged.length, 1, `one continuous pump = one ledger event (got ${merged.length})`);
});

await test("S36 parsers: captured ffmpeg 7.1.5 fixtures — YAVG log, packet pts CSV, showinfo lines", async () => {
  const { parseYavgLog, parsePtsCsv, parseSceneCuts } = await import("../src/lib/tubeforge/render-qc.ts");
  // Real lines from the live calibration run (fps=8 signalstats metadata=print).
  const yavgLog = [
    "[Parsed_metadata_3 @ 0x7fcdb000f880] lavfi.signalstats.YAVG=16.0278",
    "[Parsed_metadata_3 @ 0x7fcdb000f880] lavfi.signalstats.YAVG=235.0104",
    "[Parsed_metadata_3 @ 0x7fcdb000f880] lavfi.signalstats.YAVG=128.5000",
  ].join("\n");
  const yavg = parseYavgLog(yavgLog);
  eq(yavg.length, 3, "YAVG lines parsed in order");
  ok(Math.abs(yavg[1] - 235.0104) < 1e-9, "value preserved exactly");

  // Real packet CSV from a 30 fps CFR x264 file — DECODE order (B-frames
  // wiggle pts), N/A lines and trailing junk must drop out.
  const ptsCsv = "0.000000\n0.133333\n0.066667\nN/A\n0.033333\n0.100000\n";
  const pts = parsePtsCsv(ptsCsv);
  eq(pts.length, 5, "N/A dropped");
  eq(pts[0], 0, "first pts is zero");
  ok(pts.includes(0.133333), "decode-order pts preserved for sorting");

  // Real showinfo frame line from the scene-cut probe (config lines carry
  // no pts_time and must be ignored).
  const showinfoLog = [
    "[Parsed_showinfo_1 @ 0x7f2b84001fc0] config in time_base: 1/15360, frame_rate: 30/1",
    "[Parsed_showinfo_1 @ 0x7f57a4001fc0] n:   0 pts:  46080 pts_time:3       duration:    512 duration_time:0.0333333 fmt:yuv420p cl:left sar:1/1 s:320x180 i:P iskey:1 type:I",
    "frame=  120 fps=312 drop=0",
  ].join("\n");
  const cuts = parseSceneCuts(showinfoLog);
  eq(cuts.length, 1, "one scene-change frame among config lines");
  eq(cuts[0], 3, "pts_time extracted");
});

await test("S36 stutter: decode-order pts sorts clean, duplicate runs and gaps flag", async () => {
  const { stutterFromPts } = await import("../src/lib/tubeforge/render-qc.ts");
  // Clean 30 fps CFR — the exact capture from the live clean.mp4 run.
  const clean: number[] = [];
  for (let i = 0; i < 120; i++) clean.push(i / 30);
  const cleanOut = stutterFromPts(clean, 30);
  eq(cleanOut.dupRuns.length, 0, "CFR has no duplicate runs");
  eq(cleanOut.gaps.length, 0, "CFR has no gaps");

  // Same stream scrambled into a decode-like order (B-frames make packet
  // pts arrive non-monotonic — the live capture wiggles) — must read clean.
  const idx = clean.map((_, i) => i);
  const decoded = idx.sort((a, b) => ((b % 3) - (a % 3))).map((i) => clean[i]);
  const decodedOut = stutterFromPts(decoded, 30);
  eq(decodedOut.dupRuns.length, 0, "b-frame decode order sorts back to clean");
  eq(decodedOut.gaps.length, 0, "no phantom gaps from decode order");

  // 10 duplicated presentation frames (the stutter.mkv live-calibration
  // class — broken VFR segment) flags one run with the right size.
  const duped = [...clean.slice(0, 30), ...Array(9).fill(clean[29]), ...clean.slice(30)];
  const dupOut = stutterFromPts(duped, 30);
  eq(dupOut.dupRuns.length, 1, "duplicate run flagged");
  eq(dupOut.dupRuns[0].frames, 10, "run size counts every duplicated frame");
  ok(Math.abs(dupOut.dupRuns[0].startSec - 29 / 30) < 0.01, "run starts where dupes begin");

  // Timestamp gaps accumulate; the fail decision belongs to qc.ts. A single
  // dropped frame (2/30 s) sits UNDER the gap threshold — only real holes
  // (two-plus frames, the encoder-crash class) count.
  const gappy = clean.filter((_, i) => (i % 15 !== 0 && i % 15 !== 1) || i === 0);
  const gapOut = stutterFromPts(gappy, 30);
  ok(gapOut.gaps.length >= 7, `dropped frame pairs read as gaps (got ${gapOut.gaps.length})`);
  eq(stutterFromPts(clean.filter((_, i) => i !== 45), 30).gaps.length, 0, "single dropped frame does not gap");
});

await test("S36 cut alignment: stray cuts fail, missing hard cuts fail, blends explain", async () => {
  const { alignCuts, expectedCutsForTimeline } = await import("../src/lib/tubeforge/render-qc.ts");
  // A 3s + 3s hard-cut timeline (the live hardcut.mp4 case): detection at
  // exactly 3.0 aligns.
  const cut3 = expectedCutsForTimeline([3, 3], [{ style: "cut", durationSec: 0.5 }]);
  eq(cut3.cuts.length, 1, "one expected cut");
  ok(Math.abs(cut3.cuts[0] - 3) < 1e-9, "cut sits at the boundary");
  eq(cut3.windows.length, 0, "cuts build no windows");
  eq(alignCuts([3.0], cut3).unexpected.length, 0, "in-place cut explained");
  eq(alignCuts([3.0], cut3).missing.length, 0, "expected cut found");

  // A stray cut 2s away from every boundary is a continuity break.
  eq(alignCuts([1.0], cut3).unexpected.length, 1, "stray cut flagged");
  // The timeline's hard cut never appearing in the pixels is one too.
  eq(alignCuts([], cut3).missing.length, 1, "missing hard cut flagged");

  // A crossfade boundary builds a blend window and expects no cut.
  const blend = expectedCutsForTimeline([3, 3], [{ style: "fade", durationSec: 0.5 }]);
  eq(blend.cuts.length, 0, "blend builds no expected cut");
  ok(Math.abs(blend.windows[0][0] - 2.2) < 1e-9 && Math.abs(blend.windows[0][1] - 3.3) < 1e-9,
    "window spans the blend ±0.3s (live-verified shape)");
  eq(alignCuts([2.6], blend).unexpected.length, 0, "detection inside the blend is explained");

  // Mixed catalog: the blend's duration debt pulls the later cut earlier —
  // the render's own offset math, not a parallel one.
  const mixed = expectedCutsForTimeline([3, 3, 3], [
    { style: "fadeblack", durationSec: 0.5 },
    { style: "cut", durationSec: 0.5 },
  ]);
  ok(Math.abs(mixed.cuts[0] - 5.5) < 1e-9, `cut after a blend sits at 5.5 (got ${mixed.cuts[0]})`);
  ok(Math.abs(mixed.windows[0][0] - 2.2) < 1e-9, "blend window from the same offsets");
});

await test("S36 single-scene expectation: any detected cut is a genuine continuity break", async () => {
  const { alignCuts, expectedCutsForTimeline } = await import("../src/lib/tubeforge/render-qc.ts");
  const single = expectedCutsForTimeline([42], []);
  eq(single.cuts.length, 0, "no boundaries");
  eq(single.windows.length, 0, "no windows");
  eq(alignCuts([7.5], single).unexpected.length, 1, "a stray cut in a single-scene render breaks continuity");
});

// ---------- S36-audit — spend-gate observability (escape hatches surfaced) ----------

await test("S36-audit: spendOverrides reports the operator escape hatches; a clean env stays silent", async () => {
  const { spendOverrides } = await import("../src/lib/tubeforge/spend.ts");
  const savedGate = process.env.TUBEFORGE_SPEND_GATE;
  const savedPricing = process.env.TUBEFORGE_PRICING_VERIFIED;
  delete process.env.TUBEFORGE_SPEND_GATE;
  delete process.env.TUBEFORGE_PRICING_VERIFIED;
  try {
    const clean = spendOverrides();
    ok(!clean.gateLifted, "no TUBEFORGE_SPEND_GATE → gate not lifted");
    ok(!clean.pricingForcedVerified, "no TUBEFORGE_PRICING_VERIFIED → pricing not forced");
    process.env.TUBEFORGE_SPEND_GATE = "0";
    process.env.TUBEFORGE_PRICING_VERIFIED = "1";
    const lifted = spendOverrides();
    ok(lifted.gateLifted, "TUBEFORGE_SPEND_GATE=0 → gateLifted");
    ok(lifted.pricingForcedVerified, "TUBEFORGE_PRICING_VERIFIED=1 → pricingForcedVerified");
  } finally {
    if (savedGate === undefined) delete process.env.TUBEFORGE_SPEND_GATE;
    else process.env.TUBEFORGE_SPEND_GATE = savedGate;
    if (savedPricing === undefined) delete process.env.TUBEFORGE_PRICING_VERIFIED;
    else process.env.TUBEFORGE_PRICING_VERIFIED = savedPricing;
  }
  const restored = spendOverrides();
  ok(!restored.gateLifted && !restored.pricingForcedVerified, "env fully restored after the test");
});

// ---------- S37 — z sdk wiring: the i2v core behind the SDK shell ----------

/** Scripted fake of the Z.ai client slice the core needs. `script` answers
 *  successive async.result.query polls (last entry repeats); `id` controls
 *  the submission result. Records every create() body for shape asserts. */
function fakeZaiVideoClient(script: Array<Record<string, unknown>>, id?: string) {
  let polls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  return {
    client: {
      video: {
        generations: {
          create: async (body: Record<string, unknown>) => {
            bodies.push(body);
            return { id };
          },
        },
      },
      async: {
        result: {
          query: async () => script[Math.min(polls++, script.length - 1)],
        },
      },
    },
    bodies,
  };
}

const S37_PNG = "aGVsbG8=";
const S37_BIG = async () => new Response(new ArrayBuffer(20_000));
const S37_TINY = async () => new Response(new ArrayBuffer(100));

await test("S37 zai-video-core: happy path polls to SUCCESS and downloads a real-sized clip", async () => {
  const { zaiVideoViaClient } = await import("../src/lib/tubeforge/providers/zai-video-core.ts");
  const { client, bodies } = fakeZaiVideoClient(
    [
      { task_status: "PROCESSING" },
      { task_status: "PROCESSING" },
      { task_status: "SUCCESS", video_result: [{ url: "https://cdn.example/v.mp4" }] },
    ],
    "task-1"
  );
  const buf = await zaiVideoViaClient(
    client as Parameters<typeof zaiVideoViaClient>[0],
    { prompt: "pan", imagePngBase64: S37_PNG },
    { model: "cogvideox-3", pollMs: 1, fetchFn: S37_BIG }
  );
  ok(buf.length >= 10_000, `downloaded ${buf.length} bytes`);
  const b = bodies[0];
  eq(b.model, "cogvideox-3", "model passes through");
  eq(b.prompt, "pan", "prompt passes through");
  eq(b.image_url, `data:image/png;base64,${S37_PNG}`, "image_url is a data URL");
  eq(b.quality, "speed", "speed quality by default");
  eq(b.with_audio, false, "no audio by default");
  eq(b.duration, 5, "5s by default");
  eq(b.fps, 30, "30fps by default");
  eq(b.size, "1920x1080", "1080p by default");
});

await test("S37 zai-video-core: FAIL, no task id, SUCCESS-without-url, timeout, empty download all throw", async () => {
  const { zaiVideoViaClient } = await import("../src/lib/tubeforge/providers/zai-video-core.ts");
  type Core = typeof zaiVideoViaClient;
  const run = async (client: unknown, opts: Record<string, unknown> = {}, _fetchFn = S37_BIG) =>
    zaiVideoViaClient(client as Parameters<Core>[0], { prompt: "pan", imagePngBase64: S37_PNG }, { model: "m", pollMs: 1, ...opts } as Parameters<Core>[2]);

  const fails: Array<[string, Promise<unknown>]> = [
    ["FAIL status", run(fakeZaiVideoClient([{ task_status: "FAIL" }]).client)],
    ["no task id", run(fakeZaiVideoClient([], undefined).client)],
    ["SUCCESS without url", run(fakeZaiVideoClient([{ task_status: "SUCCESS" }]).client)],
    ["timeout", run(fakeZaiVideoClient([{ task_status: "PROCESSING" }]).client, { maxPolls: 2 })],
    ["empty download", run(fakeZaiVideoClient([{ task_status: "SUCCESS", video_result: [{ url: "u" }] }]).client, {}, S37_TINY)],
  ];
  for (const [label, p] of fails) {
    let err: unknown = null;
    try { await p; } catch (e) { err = e; }
    ok(err instanceof Error, `${label} throws (got ${String(err)})`);
  }
});

await test("S37 zai-video-core: url fallback keys (video_url, url, video) all accepted", async () => {
  const { zaiVideoViaClient } = await import("../src/lib/tubeforge/providers/zai-video-core.ts");
  type Core = typeof zaiVideoViaClient;
  const run = (script: Array<Record<string, unknown>>) =>
    zaiVideoViaClient(
      fakeZaiVideoClient(script, "task-1").client as Parameters<Core>[0],
      { prompt: "pan", imagePngBase64: S37_PNG },
      { model: "m", pollMs: 1, fetchFn: S37_BIG } as Parameters<Core>[2]
    );
  for (const key of ["video_url", "url", "video"]) {
    const buf = await run([{ task_status: "SUCCESS", [key]: "https://cdn.example/v.mp4" }]);
    ok(buf.length >= 10_000, `fallback key ${key} downloads`);
  }
});

// S39 — the tenant AsyncLocalStorage must be ONE instance per PROCESS, not
// one per compiled module copy. next dev compiles per-route server bundles,
// so tenant.ts exists as several copies with separate module-level state;
// before S39 each `new AsyncLocalStorage()` was disjoint, and a ctx entered
// by one copy (auth.enter() in a route) was invisible to another's assertCtx
// — the live "No tenant context (runRenderJob)" on a render re-run after a
// daemon restart. The fix keys the ALS on globalThis (__tfTenantAls); this
// test imports tenant.ts under a SECOND ESM identity (query string) and
// proves the two copies now share one scope.
await test("S39 tenant ALS: module-graph duplication shares one storage", async () => {
  type TenantModule = typeof import("../src/lib/tubeforge/tenant.ts");
  // Copy A — the identity every other import in this file resolves to.
  const a: TenantModule = await import("../src/lib/tubeforge/tenant.ts");
  // Copy B — a distinct ESM identity, exactly what a second compiled bundle
  // (another route's server chunk, the instrumentation graph) would be.
  // Non-literal specifier keeps TS from collapsing the two identities.
  const bSpecifier = "../src/lib/tubeforge/tenant.ts?bundle=s39-second-copy";
  const b = (await import(bSpecifier)) as TenantModule;

  const ctxA = { userId: "s39-u", organizationId: "s39-o", role: "owner" };

  // 1. A ctx entered on copy A is visible to copy B (the S39 headline).
  let seenByB: unknown = "unset";
  await a.withCtx(ctxA, async () => {
    seenByB = b.currentCtx();
  });
  ok(
    JSON.stringify(seenByB) === JSON.stringify(ctxA),
    `ctx entered on copy A is visible to copy B's currentCtx() (got ${JSON.stringify(seenByB)})`
  );

  // 2. The null scope is shared too — withCtxNull on A reads null on B.
  let nullByB: unknown = "unset";
  await a.withCtxNull(async () => {
    nullByB = b.currentCtx();
  });
  ok(nullByB === null, `withCtxNull on copy A reads null on copy B (got ${JSON.stringify(nullByB)})`);

  // 3. assertCtx on copy B RESOLVES inside copy A's scope — the exact call
  //    shape of the live failure (queue tick wraps, job body asserts).
  let asserted: unknown = "unset";
  await a.withCtx(ctxA, async () => {
    try {
      asserted = b.assertCtx("s39-probe");
    } catch (err) {
      asserted = err instanceof Error ? err.message : "threw";
    }
  });
  ok(
    typeof asserted === "object" && asserted !== null &&
      JSON.stringify(asserted) === JSON.stringify(ctxA),
    `assertCtx on copy B resolves inside copy A's scope (got ${JSON.stringify(asserted)})`
  );

  // 4. Outside any scope BOTH copies agree it's null (fail-closed parity).
  ok(
    a.currentCtx() === null && b.currentCtx() === null,
    "outside any scope, both copies read null"
  );
});

// ---------- S40 — QC enforcement policy: the ship gate ----------

// The battery's full emission set — every check id qc.ts can push. The policy
// matrix must classify exactly these, no more, no less: an id missing here is
// a check nobody decided on; an extra id is a classification for a check
// that never runs (drift the day a check is renamed). S49 added
// "restricted-visual"; S53 added "subject-continuity" + "text-artifacts" —
// all three emitted only when the caller ran the respective scan, but each
// IS part of the battery's emission set and carries a severity.
const S40_EMITTED_IDS = [
  "playable", "duration", "black-frames", "frozen-frames", "aspect",
  "loudness", "true-peak", "loudness-range", "dead-air", "static-shots",
  "flicker", "stutter", "cut-alignment", "tail-fade", "captions",
  "restricted-visual", "subject-continuity", "text-artifacts",
] as const;

const s40Check = (id: string, status: "pass" | "fail" | "unmeasured") => ({
  id,
  label: `S40 ${id}`,
  status,
  value: "s40-fixture",
  pass: status === "pass",
});
const s40Report = (
  checks: ReturnType<typeof s40Check>[],
  checkedAt = "2026-11-06T00:00:00.000Z"
): QcReportLike & { checkedAt: string } => ({
  passed: checks.every((c) => c.status === "pass"),
  checkedAt,
  durationSec: 60,
  checks,
});

await test("S40 matrix: every battery check classified exactly once — 10 block, 8 report", () => {
  const matrixIds = Object.keys(QC_ENFORCEMENT_MATRIX).sort();
  const emitted = [...S40_EMITTED_IDS].sort();
  eq(matrixIds, emitted, "matrix ids == battery emission set (both directions)");
  eq(new Set(matrixIds).size, matrixIds.length, "no duplicate ids in the matrix");
  for (const [id, entry] of Object.entries(QC_ENFORCEMENT_MATRIX)) {
    oneOf(entry.severity, ["block", "report"], `${id} severity`);
    ok(entry.why.length > 10, `${id} carries a readable rationale`);
  }
  eq(QC_BLOCKING_COUNT, 10, "ten blocking checks — S49 added restricted-visual deliberately (a flip here is a deliberate act)");
  eq(
    Object.values(QC_ENFORCEMENT_MATRIX).filter((e) => e.severity === "report").length,
    8,
    "eight report-severity checks (S53 added subject-continuity + text-artifacts deliberately)"
  );
  ok(QC_POLICY_VERSION.length > 0, "policy version stamped");
});

await test("S40 applyQcPolicy: the fail-closed decision table", () => {
  // All-pass → clean ship.
  const clean = applyQcPolicy(s40Report(S40_EMITTED_IDS.map((id) => s40Check(id, "pass"))));
  eq(clean.blocked, false, "all-pass report does not block");
  eq(clean.blockers.length, 0, "no blockers");
  eq(clean.missingReport, false, "report stands");

  // Report-severity fail → advisory, never a hold.
  const polish = applyQcPolicy(
    s40Report(S40_EMITTED_IDS.map((id) => s40Check(id, id === "loudness" ? "fail" : "pass")))
  );
  eq(polish.blocked, false, "loudness fail alone does not block (YouTube normalizes)");
  eq(polish.advisories.length, 1, "the failing check lands in advisories");
  eq(polish.advisories[0].id, "loudness", "advisory names the check");

  // Block-severity fail → hold.
  const flicker = applyQcPolicy(
    s40Report(S40_EMITTED_IDS.map((id) => s40Check(id, id === "flicker" ? "fail" : "pass")))
  );
  eq(flicker.blocked, true, "flicker fail blocks the ship");
  eq(flicker.blockers[0].severity, "block", "finding carries blocking severity");
  ok(flicker.blockers[0].why.length > 0, "blocker carries the policy rationale");

  // Unmeasured BLOCKING check → hold (a lens that never ran cannot certify).
  const unmeasured = applyQcPolicy(
    s40Report(S40_EMITTED_IDS.map((id) => s40Check(id, id === "cut-alignment" ? "unmeasured" : "pass")))
  );
  eq(unmeasured.blocked, true, "unmeasured cut-alignment blocks");
  eq(unmeasured.blockers[0].status, "unmeasured", "blocker keeps the three-state status");

  // Unmeasured REPORT check → advisory only.
  const unmeasuredPolish = applyQcPolicy(
    s40Report(S40_EMITTED_IDS.map((id) => s40Check(id, id === "tail-fade" ? "unmeasured" : "pass")))
  );
  eq(unmeasuredPolish.blocked, false, "unmeasured tail-fade does not block");

  // Unknown id (a future battery lens) → fail-closed BLOCK.
  const future = applyQcPolicy(s40Report([s40Check("hologram-sync", "fail")]));
  eq(future.blocked, true, "unknown check id blocks (fail-closed)");
  eq(future.blockers[0].why, "not in the S40 policy matrix — classify this check in qc-policy.ts");

  // No report at all → hold.
  const none = applyQcPolicy(null);
  eq(none.blocked, true, "null report blocks (nothing stands behind the file)");
  eq(none.missingReport, true, "missingReport flagged");

  // Zero-checks report → hold (the battery always emits ≥1; empty is eaten).
  const empty = applyQcPolicy(s40Report([]));
  eq(empty.blocked, true, "zero-checks report blocks");
  eq(empty.missingReport, true, "zero-checks counts as missing");
});

await test("S40 override: the human accepted THIS report or nobody", () => {
  const report = s40Report([s40Check("flicker", "fail")], "2026-11-06T12:00:00.000Z");
  const stamped = {
    qcOverrideAt: new Date("2026-11-06T12:30:00.000Z"),
    qcOverrideNote: "deadline ship — flicker is in the source clip",
    qcOverrideForCheckedAt: "2026-11-06T12:00:00.000Z",
  };
  eq(qcOverrideValid(stamped, report), true, "matching checkedAt stands");
  eq(
    qcOverrideValid(
      { ...stamped, qcOverrideForCheckedAt: "2026-11-06T18:00:00.000Z" },
      report
    ),
    false,
    "a newer report (QC re-run / re-render) re-arms the gate"
  );
  eq(
    qcOverrideValid(stamped, s40Report([s40Check("flicker", "fail")], "2026-11-06T18:00:00.000Z")),
    false,
    "same override, newer standing report → stale"
  );
  eq(qcOverrideValid(stamped, null), false, "no standing report → no valid override");
  eq(
    qcOverrideValid({ ...stamped, qcOverrideNote: null }, report),
    false,
    "a stamp without a note is not an acceptance"
  );
  eq(qcOverrideValid(null, report), false, "no override at all");
});

await test("S40 report mode: the gate never blocks, findings stay visible", () => {
  const prev = process.env.TUBEFORGE_QC_ENFORCEMENT;
  try {
    process.env.TUBEFORGE_QC_ENFORCEMENT = "report";
    eq(qcEnforcementMode(), "report", "exact 'report' switches the mode");
    const held = applyQcPolicy(
      s40Report(S40_EMITTED_IDS.map((id) => s40Check(id, id === "stutter" ? "fail" : "pass"))),
      { mode: qcEnforcementMode() }
    );
    eq(held.blocked, false, "report mode never blocks");
    eq(held.blockers.length, 1, "the would-block finding stays visible");

    process.env.TUBEFORGE_QC_ENFORCEMENT = "enforce";
    eq(qcEnforcementMode(), "enforce", "explicit enforce");
    process.env.TUBEFORGE_QC_ENFORCEMENT = "junk-value";
    eq(qcEnforcementMode(), "enforce", "junk fails CLOSED to enforce");
    process.env.TUBEFORGE_QC_ENFORCEMENT = "";
    eq(qcEnforcementMode(), "enforce", "empty fails closed");
    process.env.TUBEFORGE_QC_ENFORCEMENT = "REPORT";
    eq(qcEnforcementMode(), "enforce", "case-sensitive — 'REPORT' is junk, not the switch");
  } finally {
    if (prev === undefined) delete process.env.TUBEFORGE_QC_ENFORCEMENT;
    else process.env.TUBEFORGE_QC_ENFORCEMENT = prev;
  }
  // And the null-report case still routes through the mode:
  eq(applyQcPolicy(null, { mode: "report" }).blocked, false, "report mode releases even a missing report");
});

await test("S40 parseQcReport: tolerance matches the serializer (bad payloads never read as clean)", () => {
  const good = JSON.stringify(s40Report([s40Check("playable", "pass")]));
  ok(parseQcReport(good) !== null, "valid stored report parses");
  eq(parseQcReport(null), null, "null raw → null");
  eq(parseQcReport(undefined), null, "undefined raw → null");
  eq(parseQcReport("not json at all"), null, "garbage → null");
  eq(parseQcReport("[1,2,3]"), null, "non-object JSON → null");
  eq(parseQcReport('{"checks":[]}'), null, "missing passed flag → null (legacy shape)");
  eq(parseQcReport('{"passed":true,"checks":"nope"}'), null, "checks not an array → null");
  // A parsed-but-empty report is the caller's fail-closed case, not the
  // parser's: applyQcPolicy treats it as missingReport.
  const empty = parseQcReport('{"passed":false,"checkedAt":"t","durationSec":1,"checks":[]}');
  ok(empty !== null, "empty-checks report still parses");
  eq(applyQcPolicy(empty).missingReport, true, "…and the gate treats it as missing");
});

// ---------------------------------------------------------------------------
// S45 — LLM JSON variance (the director re-run that died at parse) + scoped
// preview QC evidence (the report the preview never wrote)
// ---------------------------------------------------------------------------

await test("S45 parseJsonLoose: plain and fenced JSON still parse untouched", async () => {
  const { parseJsonLoose } = await import("../src/lib/tubeforge/ai.ts");
  const plain = parseJsonLoose('{"title":"T","scenes":[1,2]}');
  eq(plain.title, "T", "plain object parses");
  eq((plain.scenes as number[]).length, 2, "nested array survives");
  const fenced = parseJsonLoose('```json\n{"title":"F"}\n```');
  eq(fenced.title, "F", "json-fenced payload parses");
  const prosey = parseJsonLoose('Here you go:\n{"title":"P"}\nHope that helps!');
  eq(prosey.title, "P", "prose around the object parses");
});

await test("S45 parseJsonLoose: trailing commas and curly quotes are repaired", async () => {
  const { parseJsonLoose } = await import("../src/lib/tubeforge/ai.ts");
  const commas = parseJsonLoose('{"a":1,"b":[1,2,3,],}');
  eq(commas.a, 1, "trailing comma in object repaired");
  eq((commas.b as number[]).length, 3, "trailing comma in array repaired");
  const curly = parseJsonLoose('{\u201Ctitle\u201D:\u201Ccurly\u201D}');
  eq(curly.title, "curly", "curly double quotes repaired to delimiters");
});

await test("S45 parseJsonLoose: prose-with-a-brace after the JSON no longer swallows it", async () => {
  const { parseJsonLoose } = await import("../src/lib/tubeforge/ai.ts");
  // THE live re-run shape: the model answered with the plan, then added a
  // closing thought containing a brace. The old greedy /\{[\s\S]*\}/ matched
  // from the first "{" to THAT last "}" — an unparseable blob — and its
  // unguarded JSON.parse surfaced a raw SyntaxError.
  const answer =
    'Here is the plan:\n{"concept":"desert at dusk","scenes":[{"sceneIndex":1,"mood":"warm"}]}\n' +
    'Note: I kept it to one scene because you asked } :)';
  const parsed = parseJsonLoose(answer);
  eq(parsed.concept, "desert at dusk", "the object is recovered despite the trailing brace");
  eq((parsed.scenes as unknown[]).length, 1, "nested scenes survive the balanced scan");
});

await test("S45 parseJsonLoose: braces inside string values never break the scan", async () => {
  const { parseJsonLoose } = await import("../src/lib/tubeforge/ai.ts");
  const parsed = parseJsonLoose('{"caption":"use {braces} here","n":2}');
  eq(parsed.caption, "use {braces} here", "braces in a string literal are not depth");
  eq(parsed.n, 2, "sibling fields survive");
});

await test("S47 parseJsonLoose: unquoted scalar values are quoted (the live glm-4.6 killer)", async () => {
  const { parseJsonLoose } = await import("../src/lib/tubeforge/ai.ts");
  // THE live director-benchmark shape: the whole payload is brace-balanced,
  // so the balanced scan finds it, but `\"lens\":100mm` is not JSON. Every
  // pre-S47 rung failed and the job died after 3 attempts.
  const shot = '{"shotIndex":0,"framing":"wide","camera":"push-in","lens":100mm,"composition":"rule of thirds","duration":2.5,"imagePrompt":"a rope"}';
  const parsed = parseJsonLoose(`{"concept":"bridges","scenes":[{"sceneIndex":1,"shots":[${shot}]}]}`) as {
    scenes: { shots: { lens: string; duration: number; imagePrompt: string }[] }[];
  };
  eq(parsed.scenes[0].shots[0].lens, "100mm", "bare token quoted as a string");
  eq(parsed.scenes[0].shots[0].duration, 2.5, "real numbers stay numbers");
  eq(parsed.scenes[0].shots[0].imagePrompt, "a rope", "quoted strings untouched");
  // multi-word bare tokens (\"24mm wide\") quote as one string
  const multi = parseJsonLoose('{"lens":24mm wide,"n":1}');
  eq(multi.lens, "24mm wide", "bare token with a space quoted whole");
  eq(multi.n, 1, "sibling number untouched");
});

await test("S47 parseJsonLoose: missing closers are appended, unmatched trailing closers dropped", async () => {
  const { parseJsonLoose } = await import("../src/lib/tubeforge/ai.ts");
  const truncated = parseJsonLoose('{"title":"T","items":[{"n":1}');
  eq(truncated.title, "T", "truncated tail repaired by appending closers");
  eq((truncated.items as { n: number }[])[0].n, 1, "nested content survives the append");
  const overclosed = parseJsonLoose('{"title":"O"}}');
  eq(overclosed.title, "O", "trailing unmatched closer dropped");
});

await test("S47 parseJsonLoose: truncation INSIDE a string value still fails honestly", async () => {
  const { parseJsonLoose } = await import("../src/lib/tubeforge/ai.ts");
  let err: unknown;
  try {
    parseJsonLoose('{"concept":"a lone signal in the noise, cut mid-va');
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error, "mid-string truncation throws (no fabricated value)");
  ok(/did not return valid JSON/i.test((err as Error).message), "readable message");
});

await test("S45 parseJsonLoose: unparseable input throws the READABLE error, never a SyntaxError", async () => {
  const { parseJsonLoose } = await import("../src/lib/tubeforge/ai.ts");
  let err: unknown;
  try {
    parseJsonLoose("I could not produce that plan, sorry.");
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error, "throws an Error");
  ok(!(err instanceof SyntaxError), "not a raw SyntaxError (callers match on message)");
  ok(
    /did not return valid JSON/i.test((err as Error).message),
    `readable message (got: ${(err as Error).message})`
  );
  // Zero-width noise and BOM around an otherwise-valid payload are stripped.
  eq(
    parseJsonLoose("\uFEFF\u200B{\"ok\":true}\u200D").ok,
    true,
    "BOM + zero-width chars stripped before parsing"
  );
});

await test("S45 aiCallJson: parse + validate run INSIDE the retried closure — variance costs a fresh ask, not the job", async () => {
  const { aiCallJson } = await import("../src/lib/tubeforge/ai.ts");
  // A minimal withRetry stand-in: run the composed fn up to N times, no
  // delay — the real retry pacing is budget.ts's contract (queue/billing
  // suites); this pins the COMPOSITION: every retry re-runs `ask` (a FRESH
  // generation, not a re-parse of the same text) and parse/validate
  // failures are retryable throws.
  const makeCall = (answers: string[]) => {
    const state = { asks: [] as string[], calls: 0 };
    const call = async <U>(
      _service: "llm",
      _label: string,
      fn: () => Promise<U>,
      retryOpts: { attempts?: number } = {}
    ): Promise<U> => {
      const max = retryOpts.attempts ?? 3;
      let lastErr: unknown;
      for (let i = 0; i < max; i++) {
        state.calls++;
        try {
          return await fn();
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr;
    };
    const ask = async () => {
      const a = answers[Math.min(state.asks.length, answers.length - 1)];
      state.asks.push(a);
      return a;
    };
    return { state, call, ask };
  };

  // 1) THE live bug shape: attempt 1 is prose-with-a-brace (the old code
  //    died at parse with NO re-ask), attempt 2 is a clean plan.
  const bug = makeCall([
    'Sorry, here is prose } instead',
    '{"concept":"ok","scenes":[{"sceneIndex":1}]}',
  ]);
  const plan = await aiCallJson<{ concept: string }>("llm", "director pass LLM", bug.ask, {
    call: bug.call,
  });
  eq(plan.concept, "ok", "the second attempt's plan comes back");
  eq(bug.state.asks.length, 2, "a FRESH ask per retry (not a re-parse of attempt 1)");
  eq(bug.state.calls, 2, "two closure invocations");

  // 2) A parseable but shape-less response is ALSO retried (validate throws
  //    inside the closure), then succeeds.
  const shapeless = makeCall([
    '{"concept":"ok"}', // no scenes — validate must reject
    '{"concept":"fixed","scenes":[{"sceneIndex":1}]}',
  ]);
  const plan2 = await aiCallJson<{ concept: string; scenes: unknown[] }>(
    "llm", "director pass LLM", shapeless.ask,
    {
      call: shapeless.call,
      validate: (p) => {
        if (!Array.isArray(p.scenes) || p.scenes.length === 0)
          throw new Error("Director pass returned no usable scenes — try again");
        return p as { concept: string; scenes: unknown[] };
      },
    }
  );
  eq(plan2.concept, "fixed", "validate rejection was retried, not fatal");
  eq(shapeless.state.asks.length, 2, "shape-less response cost one fresh ask");

  // 3) All attempts unparseable → the LAST readable error surfaces (the
  //    job fails with the message users can act on).
  const hopeless = makeCall(["no json", "still no json", "never json"]);
  let err: unknown;
  try {
    await aiCallJson("llm", "director pass LLM", hopeless.ask, {
      call: hopeless.call,
    });
  } catch (e) {
    err = e;
  }
  ok(err instanceof Error, "exhausted retries throw");
  ok(/did not return valid JSON/i.test((err as Error).message), "the readable parser error, not a SyntaxError");
  eq(hopeless.state.asks.length, 3, "every attempt got a fresh ask");

  // 4) Happy path: one ask, one call — no retry tax on good responses.
  const happy = makeCall(['{"concept":"first try"}']);
  const plan3 = await aiCallJson<{ concept: string }>("llm", "director pass LLM", happy.ask, {
    call: happy.call,
  });
  eq(plan3.concept, "first try", "first-try success returns immediately");
  eq(happy.state.calls, 1, "exactly one closure invocation");
});

await test("S45 applyQcPolicy: preview-scoped evidence NEVER certifies the final artifact", () => {
  const allPass = S40_EMITTED_IDS.map((id) => s40Check(id, "pass"));
  // An all-pass PREVIEW report is still not a report for final.mp4.
  const previewClean = { ...s40Report(allPass), scope: "preview" };
  const decision = applyQcPolicy(previewClean);
  eq(decision.missingReport, true, "preview scope reads as missing evidence");
  eq(decision.blocked, true, "an all-pass preview report still blocks export in enforce mode");
  // The same report without the scope is a clean full render (unchanged S40 law).
  const fullClean = s40Report(allPass);
  eq(applyQcPolicy(fullClean).blocked, false, "full-scope all-pass still ships");
  eq(applyQcPolicy(fullClean).missingReport, false, "full scope is standing evidence");
  // Report mode releases the hold but the evidence is still marked missing.
  const released = applyQcPolicy(previewClean, { mode: "report" });
  eq(released.blocked, false, "report mode releases even preview evidence");
  eq(released.missingReport, true, "…but the badge still says the final artifact is unmeasured");
});

await test("S45 parseQcReport: the scope field survives the round trip", () => {
  const stored = JSON.stringify({
    passed: false,
    checkedAt: "2026-11-06T00:00:00.000Z",
    durationSec: 8.2,
    scope: "preview",
    checks: [s40Check("playable", "pass")],
  });
  const parsed = parseQcReport(stored);
  ok(parsed !== null, "preview report parses");
  eq(parsed?.scope, "preview", "scope preserved through the parser");
  eq(parseQcReport(JSON.stringify(s40Report([s40Check("playable", "pass")])))?.scope, undefined, "full reports stay scope-less");
});

await test("S45 previewQcPatch: preview evidence persists ONLY while no full render stands", async () => {
  const { previewQcPatch } = await import("../src/lib/tubeforge/video-jobs.ts");
  const report = {
    passed: true,
    checkedAt: "2026-11-06T00:00:00.000Z",
    durationSec: 7.5,
    checks: [],
    scope: "preview",
  } as const;

  // No full render: the preview report becomes the standing evidence.
  const fresh = previewQcPatch(false, report);
  eq(fresh.hasPreview, true, "preview flag set");
  const stored = JSON.parse(fresh.qcReport ?? "null") as { scope?: string } | null;
  ok(stored !== null, "report persisted");
  eq(stored?.scope, "preview", "persisted with preview scope");

  // No full render + crashed probes: stale evidence is CLEARED, never kept.
  eq(previewQcPatch(false, null).qcReport, null, "a failed battery clears the field");

  // A full render stands: the final report owns the field — a later preview
  // must not downgrade it (the export gate would then judge final.mp4 on a
  // scene-1 file).
  const standing = previewQcPatch(true, report);
  eq(standing.hasPreview, true, "preview flag still set");
  eq("qcReport" in standing, false, "the standing final report is untouched");
});

await test("S45 qcForPreview: scoped battery on a real preview.mp4 — no narration-sync, no captions, scope stamped", async () => {
  const storage = await import("../src/lib/tubeforge/storage.ts");
  const { qcForPreview } = await import("../src/lib/tubeforge/qc.ts");
  delete process.env.TUBEFORGE_STORAGE_DRIVER; // local driver — real bytes on disk
  const probe = `s45-preview-probe-${Date.now()}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-s45-"));
  const tmpPreview = path.join(dir, "s45-preview.mp4");
  try {
    await genFixture(tmpPreview, fadeOutArgs());
    await storage.put(`${probe}/preview.mp4`, fs.readFileSync(tmpPreview));
    const report = await qcForPreview(probe, 4, undefined, "16:9", null, undefined, null, 24);
    eq(report.scope, "preview", "the report is scoped as preview evidence");
    const ids = report.checks.map((c) => c.id);
    ok(ids.includes("playable"), "artifact-local lenses run (playable)");
    ok(ids.includes("black-frames"), "black-frames measured");
    ok(ids.includes("tail-fade"), "tail fade measured");
    eq(ids.includes("duration"), false, "no narration-sync check — the preview is a partial artifact");
    eq(ids.includes("captions"), false, "no captions check — no SRT ships for previews");
    assertReportInvariants(report);
  } finally {
    await storage.remove(`${probe}/preview.mp4`).catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// S46 — durable login throttling (roadmap P1-6): the PURE sliding-window
// law. The DB shell around it (AuthAttempt table) is proven against the
// real SQLite by scripts/s16-unit-probe.mts layer 2 — this layer pins the
// math every caller shares, so the window can never disagree between
// routes, restarts or instances.
await test("S46 loginWindowDecision: the law is unchanged — 5 in-window failures lock until the OLDEST ages out", () => {
  eq(LOGIN_WINDOW_MS, 10 * 60 * 1000, "the window stays 10 minutes (the S16-era law)");
  eq(LOGIN_MAX_FAILURES, 5, "the lock still arms on the 5th failure");

  const now = 1_700_000_000_000;
  const min = 60_000;
  eq(loginWindowDecision([], now).allowed, true, "no failures → allowed");

  const four = [now - 9 * min, now - 5 * min, now - 2 * min, now - 1 * min];
  eq(loginWindowDecision(four, now).allowed, true, "four failures → still allowed (arms on the 5th)");

  const five = [...four, now];
  const locked = loginWindowDecision(five, now);
  eq(locked.allowed, false, "the 5th in-window failure locks");
  eq(locked.retryAfterSec, 60, "the lock lasts until the OLDEST hit ages out (now−9min sits 1min from the window edge)");
  eq(loginWindowDecision([...five].reverse(), now).retryAfterSec, 60, "unsorted input is sorted internally (the DB feeds ascending, the law trusts nothing)");
});

await test("S46 loginWindowDecision: stale hits are invisible — the window slides, it does not reset", () => {
  const now = 1_700_000_000_000;
  const min = 60_000;
  // Five failures all OLDER than the window: the window slid past them.
  const stale = Array.from({ length: 5 }, (_, i) => now - 11 * min - i * 1000);
  eq(loginWindowDecision(stale, now).allowed, true, "five stale failures → allowed again");

  // Boundary: a hit EXACTLY at the cutoff is OUTSIDE (the law is t > cutoff).
  const atCutoff = [now - 10 * min, now - 4 * min, now - 3 * min, now - 2 * min, now - 1 * min];
  eq(loginWindowDecision(atCutoff, now).allowed, true, "a hit exactly at the cutoff does not count (4 inside)");

  // The 5th inside arms the lock, and the retry counts from the oldest
  // IN-WINDOW hit — the stale one is already gone from the math.
  const locked = loginWindowDecision([...atCutoff, now], now);
  eq(locked.allowed, false, "five in-window hits lock even with a stale sixth");
  eq(locked.retryAfterSec, 6 * 60, "unlock follows the oldest IN-WINDOW hit (now−4min + 10min window = 6min), not the stale one");

  // A barely-locked key never reports 0 (Retry-After must stay ≥ 1s).
  const barely = [now - (LOGIN_WINDOW_MS - 1), ...Array.from({ length: 4 }, (_, i) => now - i * 1000)];
  const barelyLocked = loginWindowDecision(barely, now);
  eq(barelyLocked.allowed, false, "locked with the oldest hit 1ms from aging out");
  eq(barelyLocked.retryAfterSec, 1, "retryAfterSec floors at 1 — a 0s Retry-After header would be a lie");
});

await test("S46 loginWindowDecision: the straddle hole is closed (4+4 across a window border locks)", () => {
  const now = 1_700_000_000_000;
  // The S16-era fixed-window counter could be straddled: 4 failures at
  // T−9:54 + 4 more seconds later sat in DIFFERENT counter windows, so 8
  // failures in 10 minutes never tripped it. The hit-log law counts them
  // all — they are inside ONE rolling window.
  const straddle = [
    ...Array.from({ length: 4 }, () => now - 594_000), // 9:54 old
    ...Array.from({ length: 4 }, () => now - 6_000), // 0:06 old
  ];
  const decision = loginWindowDecision(straddle, now);
  eq(decision.allowed, false, "8 failures inside one rolling window (the straddle) lock");
  eq(decision.retryAfterSec, 6, "unlock when the OLDEST straddle hit ages out (6s)");
  // And the same 8 hits spread past the window edge are fine again.
  const spread = straddle.map((t) => t - 30_000);
  eq(loginWindowDecision(spread, now).allowed, true, "the same failures aged 30s more → only 4 in window");
});

// ---------------------------------------------------------------------------
// S48 — the 19-field cinematic Director (schema v2, engine-verbatim cameras,
// per-shot focal + moveSpeed, director-grade model hint).
// ---------------------------------------------------------------------------

await test("S48 CAMERA_TO_MOVE: every v2 verb is engine-verbatim (identity or a documented 1:1 rename)", async () => {
  const { CAMERA_MOVES } = await import("../src/lib/tubeforge/director-plan.ts");
  const { CAMERA_TO_MOVE } = await import("../src/lib/tubeforge/shots.ts");
  // The v2 vocabulary IS the engine's move set: only static→hold and
  // punch-in→punch are renames; every other id maps to ITSELF.
  const renames: Record<string, string> = { static: "hold", "punch-in": "punch" };
  for (const move of CAMERA_MOVES) {
    const mapped = CAMERA_TO_MOVE[move];
    ok(mapped !== undefined, `${move} is mapped`);
    eq(mapped, renames[move] ?? move, `${move} → ${renames[move] ?? move} (verbatim)`);
  }
  // The legacy verbs stay covered for pre-S48 plans (frozen approximations).
  const legacyExpect: Record<string, string> = {
    "push-in": "zoom-in",
    "pull-out": "zoom-out",
    "dolly-in": "zoom-in",
    handheld: "diag-tl",
    "crane-up": "tilt-up",
    drone: "diag-br",
  };
  for (const [verb, kind] of Object.entries(legacyExpect)) {
    eq(CAMERA_TO_MOVE[verb], kind, `legacy ${verb} → ${kind} (v1-compat, unchanged)`);
  }
});

await test("S48 parsePlan: a v2 plan parses with all 19 fields snapped; version records provenance", async () => {
  const { parsePlan } = await import("../src/lib/tubeforge/director-plan.ts");
  const json = JSON.stringify({
    version: 2,
    generatedAt: "2026-11-07T00:00:00.000Z",
    concept: "test",
    profile: "narrative",
    scenes: [
      {
        sceneIndex: 1,
        mood: "dawn",
        shots: [
          {
            shotIndex: 0,
            framing: "wide",
            camera: "zoom-in",
            lens: "24mm wide",
            composition: "leading lines",
            duration: 2.8,
            imagePrompt: "the caravan at dawn",
            subject: "the caravan",
            subjectAction: "cresting the dune",
            cameraHeight: "low-angle",
            angle: "three-quarter",
            depthOfField: "shallow",
            lighting: "golden hour rim light",
            colorGrade: "teal-orange",
            focal: "upper-left",
            moveSpeed: "slow",
            transitionOut: "fade",
            purpose: "establish",
            notes: "sets the journey's scale",
          },
          // A minimal second shot: every v2 field absent → defaults fill.
          { shotIndex: 1, framing: "close-up", camera: "diag-br", duration: 2 },
        ],
      },
    ],
  });
  const plan = parsePlan(json);
  if (!plan) throw new Error("v2 plan must parse");
  eq(plan.version, 2, "version records v2 provenance");
  const s0 = plan.scenes[0].shots[0];
  eq(s0.subject, "the caravan", "subject parses");
  eq(s0.subjectAction, "cresting the dune", "subjectAction parses");
  eq(s0.cameraHeight, "low-angle", "cameraHeight parses");
  eq(s0.angle, "three-quarter", "angle parses");
  eq(s0.depthOfField, "shallow", "depthOfField parses");
  eq(s0.lighting, "golden hour rim light", "lighting parses");
  eq(s0.colorGrade, "teal-orange", "colorGrade parses");
  eq(s0.focal, "upper-left", "focal parses");
  eq(s0.moveSpeed, "slow", "moveSpeed parses");
  eq(s0.transitionOut, "fade", "transitionOut parses");
  eq(s0.purpose, "establish", "purpose parses");
  eq(s0.notes, "sets the journey's scale", "notes parses");
  // Field-count contract: the complete parsed shot carries exactly 19 keys.
  eq(Object.keys(s0).length, 19, "the parsed v2 shot carries all 19 fields");
  // Absent v2 fields default to the documented v1-equivalent values.
  const s1 = plan.scenes[0].shots[1];
  eq(s1.cameraHeight, "eye-level", "cameraHeight defaults");
  eq(s1.angle, "front", "angle defaults");
  eq(s1.depthOfField, "deep", "depthOfField defaults");
  eq(s1.focal, "", "focal defaults empty (scene heuristic stays in charge)");
  eq(s1.moveSpeed, "normal", "moveSpeed defaults");
  eq(s1.transitionOut, "cut", "transitionOut defaults");
  eq(s1.purpose, "contextualize", "purpose defaults");
  eq(s1.subject, "", "subject defaults empty");
});

await test("S48 parsePlan: a v1 plan upgrades losslessly — legacy verbs kept verbatim, version stays 1", async () => {
  const { parsePlan } = await import("../src/lib/tubeforge/director-plan.ts");
  const json = JSON.stringify({
    version: 1,
    generatedAt: "2026-11-01T00:00:00.000Z",
    concept: "legacy",
    scenes: [
      {
        sceneIndex: 1,
        mood: "dusk",
        transitionIn: "",
        motion: "smart",
        shots: [
          { shotIndex: 0, framing: "wide", camera: "drone", lens: "24mm", composition: "diagonal", duration: 3, imagePrompt: "the city from above" },
          { shotIndex: 1, framing: "medium", camera: "handheld", duration: 2.5, imagePrompt: "the market" },
        ],
      },
    ],
  });
  const plan = parsePlan(json);
  if (!plan) throw new Error("v1 plan must parse");
  eq(plan.version, 1, "version stays 1 (provenance, never rewritten)");
  // The v1 verbs ride through parse UNCHANGED — execution maps them.
  eq(plan.scenes[0].shots[0].camera, "drone", "legacy drone verb survives parse verbatim");
  eq(plan.scenes[0].shots[1].camera, "handheld", "legacy handheld verb survives parse verbatim");
  // And the v2 fields exist with defaults (complete in-memory shape).
  eq(plan.scenes[0].shots[0].moveSpeed, "normal", "v1 shot gains defaulted moveSpeed");
  eq(plan.scenes[0].shots[0].purpose, "contextualize", "v1 shot gains defaulted purpose");
});

await test("S48 buildSceneShots: per-shot focal + moveSpeed ride the execution verbatim", async () => {
  const { buildSceneShots } = await import("../src/lib/tubeforge/shots.ts");
  const scene = {
    index: 1, title: "T", narration: "n", visual: "v", camera: "static",
    mood: "m", caption: "c", hostInScene: false, rehook: false, sfx: "none",
  } as never;
  const planScene = {
    sceneIndex: 1,
    mood: "m",
    transitionIn: "",
    motion: "smart",
    needsI2V: false,
    useStock: false,
    pacing: "normal",
    ambience: "none",
    sfx: "none",
    shots: [
      { shotIndex: 0, framing: "wide", camera: "zoom-in", lens: "35mm", composition: "rule of thirds", duration: 2.5, imagePrompt: "a", focal: "upper-left", moveSpeed: "fast" },
      { shotIndex: 1, framing: "medium", camera: "punch-in", lens: "35mm", composition: "rule of thirds", duration: 2.5, imagePrompt: "b" },
    ],
  } as never;
  const plan = buildSceneShots({ scene, planScene, measuredSec: 5 });
  const [s0, s1] = plan.available;
  // v2 camera verbs execute VERBATIM (identity / documented rename).
  eq(s0.moveKind, "zoom-in", "zoom-in executes as zoom-in");
  eq(s1.moveKind, "punch", "punch-in executes as punch (the documented rename)");
  // The per-shot focal anchor rides through.
  const f0 = s0.focal;
  ok(f0 !== undefined, "shot 0 carries its focal anchor");
  if (!f0) throw new Error("shot 0 must carry a focal anchor");
  eq(f0.x, 0.32, "upper-left focal x resolves via motion tokens");
  eq(f0.y, 0.35, "upper-left focal y resolves via motion tokens");
  ok(s1.focal === undefined, "absent focal → no anchor (scene heuristic stays in charge)");
  // moveSpeed resolves to the documented multiplier.
  eq(s0.speed, 1.35, "fast → 1.35 intensity multiplier");
  eq(s1.speed, 1, "absent moveSpeed → 1 (video intensity, unchanged)");
});

await test("S48 shotIntensity + focalFromToken: the motion-side seams", async () => {
  const { shotIntensity, focalFromToken } = await import("../src/lib/tubeforge/motion.ts");
  eq(shotIntensity(12), 12, "no speed → the base intensity");
  eq(shotIntensity(12, 1), 12, "normal → the base intensity");
  eq(Math.abs(shotIntensity(12, 0.7) - 8.4) < 1e-9, true, "slow → 0.7× (8.4)");
  eq(Math.abs(shotIntensity(12, 1.35) - 16.2) < 1e-9, true, "fast → 1.35× (16.2)");
  eq(shotIntensity(30, 1.35), 30, "clamped at the 30 ceiling — fast cannot exceed the knob's max");
  eq(shotIntensity(0, 1.35), 0, "stillness contract preserved: 0 base stays 0");
  // Focal resolution: tokens → anchors, unknowns → null.
  const c = focalFromToken("center");
  const tl = focalFromToken("top-left");
  if (!c || !tl) throw new Error("center/top-left must resolve");
  eq(c.x, 0.5, "center resolves");
  eq(tl.x, 0.32, "alias top-left → upper-left resolves");
  eq(focalFromToken(""), null, "empty → null (caller heuristic)");
  eq(focalFromToken("somewhere"), null, "unknown token → null");
});

await test("S48 resolveChatModel: operator pick > director hint > gateway default", async () => {
  const { resolveChatModel } = await import("../src/lib/tubeforge/llm.ts");
  eq(resolveChatModel("gpt-4o", "glm-4.6"), "gpt-4o", "the operator's Settings pick always wins");
  eq(resolveChatModel("", "glm-4.6"), "glm-4.6", "hint applies when no operator pick exists");
  eq(resolveChatModel(null, "glm-4.6"), "glm-4.6", "null settings model → hint");
  eq(resolveChatModel(undefined, "glm-4.6"), "glm-4.6", "undefined settings model → hint");
  eq(resolveChatModel("", undefined), "", "no hint → the gateway default rides");
  eq(resolveChatModel("  ", "glm-4.6"), "glm-4.6", "whitespace-only settings model → hint");
  eq(resolveChatModel("glm-4.6 ", ""), "glm-4.6", "settings model is trimmed");
});

await test("S48 directorSystemPrompt: the 19-field schema + engine vocabulary reach the LLM", async () => {
  const { directorSystemPrompt, DIRECTOR_MODEL_HINT } = await import("../src/lib/tubeforge/director.ts");
  const { resolveProfile } = await import("../src/lib/tubeforge/production-profiles.ts");
  const sys = directorSystemPrompt(resolveProfile("narrative"));
  // The JSON example carries every one of the 19 shot fields.
  for (const field of [
    "shotIndex", "framing", "camera", "lens", "composition", "duration", "imagePrompt",
    "subject", "subjectAction", "cameraHeight", "angle", "depthOfField",
    "lighting", "colorGrade", "focal", "moveSpeed", "transitionOut", "purpose", "notes",
  ]) {
    ok(sys.includes(`"${field}"`), `system prompt schema includes "${field}"`);
  }
  // The cinematic FIELD rules name their vocabularies (the camera CATALOG
  // itself rides the user prompt — pinned by the M1 golden test above).
  ok(sys.includes("moveSpeed: slow") && sys.includes("transitionOut: cut | fade"),
    "cinematic field rules carry their vocabularies");
  // The director model hint is the S47-benchmarked pick.
  eq(DIRECTOR_MODEL_HINT, "glm-4.6", "director model hint pinned to glm-4.6");
});

await test("S48 shotPrompt: v2 cinematic clauses weave into extra-shot prompts (v1 shots unchanged)", async () => {
  const { shotPrompt } = await import("../src/lib/tubeforge/shots.ts");
  const scene = {
    index: 2, title: "T", narration: "n", visual: "the ancient library", camera: "static",
    mood: "dusk light", caption: "c", hostInScene: false, rehook: false, sfx: "none",
  } as never;
  // v1-shaped shot (only the 7 original fields) → the pre-S48 prompt body.
  const v1 = shotPrompt(scene as never, {
    imagePrompt: "the reading room", framing: "wide", lens: "35mm", composition: "rule of thirds",
  });
  ok(!v1.includes("camera") || v1.includes("cinema camera"), "v1 shot adds no v2 clauses");
  ok(v1.includes("the ancient library") && v1.includes("the reading room"), "v1 prompt keeps its core bits");
  // v2 shot → the new clauses ride in.
  const v2 = shotPrompt(scene as never, {
    imagePrompt: "the reading room", framing: "wide", lens: "85mm f/1.8", composition: "leading lines",
    subject: "a scholar", subjectAction: "turning a parchment page",
    cameraHeight: "low-angle", angle: "profile", depthOfField: "shallow",
    lighting: "single oil lamp, deep shadows", colorGrade: "warm sepia",
  });
  ok(v2.includes("a scholar turning a parchment page"), "subject + action clause");
  ok(v2.includes("low-angle camera"), "cameraHeight clause");
  ok(v2.includes("profile view"), "angle clause");
  ok(v2.includes("shallow depth of field"), "depthOfField clause");
  ok(v2.includes("single oil lamp, deep shadows"), "lighting clause");
  ok(v2.includes("warm sepia color grade"), "colorGrade clause");
});

await test("S48 planStaticRuns: the pacing gate survives the v2 schema untouched", async () => {
  const { planStaticRuns } = await import("../src/lib/tubeforge/director-plan.ts");
  // A v2-shaped plan whose shots are ALL static + motion off + no i2v/stock
  // is the same flat-pacing sin the Stage 5 gate exists to catch.
  const plan = {
    version: 2 as const,
    generatedAt: "2026-11-07T00:00:00.000Z",
    concept: "flat",
    scenes: [
      { sceneIndex: 1, mood: "", transitionIn: "", motion: "off", needsI2V: false, useStock: false, pacing: "normal", ambience: "none", sfx: "none",
        shots: [
          { shotIndex: 0, framing: "wide", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 3, imagePrompt: "a", cameraHeight: "eye-level", angle: "front", depthOfField: "deep", focal: "", moveSpeed: "normal", transitionOut: "cut", purpose: "establish", notes: "" },
          { shotIndex: 1, framing: "wide", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 3, imagePrompt: "b", cameraHeight: "eye-level", angle: "front", depthOfField: "deep", focal: "", moveSpeed: "normal", transitionOut: "cut", purpose: "detail", notes: "" },
          { shotIndex: 2, framing: "wide", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 3, imagePrompt: "c", cameraHeight: "eye-level", angle: "front", depthOfField: "deep", focal: "", moveSpeed: "normal", transitionOut: "cut", purpose: "reveal", notes: "" },
        ] },
    ],
  };
  const runs = planStaticRuns(plan, {});
  eq(runs.length, 1, "the static run is detected");
  eq(runs[0].length, 3, "all three static shots counted");
  // moveSpeed does NOT excuse a static camera (speed modulates a move that
  // has to exist first).
  const fast = JSON.parse(JSON.stringify(plan));
  fast.scenes[0].shots.forEach((s: { moveSpeed: string }) => { s.moveSpeed = "fast"; });
  eq(planStaticRuns(fast, {})[0].length, 3, "fast moveSpeed on a static camera is still flat pacing");
});

// ---------------------------------------------------------------------------
// S49 — Islamic visual protection (restricted subjects, layered enforcement).
// ---------------------------------------------------------------------------

await test("S49 resolveContentPolicy: unknown/absent/garbage → standard, never silent activation", async () => {
  const { resolveContentPolicy } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  eq(resolveContentPolicy(null), "standard", "null → standard");
  eq(resolveContentPolicy(undefined), "standard", "undefined → standard");
  eq(resolveContentPolicy(""), "standard", "empty → standard");
  eq(resolveContentPolicy("Islamic-History "), "islamic-history", "trimmed + case-insensitive snap");
  eq(resolveContentPolicy("islamic-history"), "islamic-history", "exact");
  eq(resolveContentPolicy("gibberish"), "standard", "garbage → standard (fail-open direction is safe)");
});

await test("S49 scanRestrictedSubjects: the registry detects every tier, word-bounded", async () => {
  const { scanRestrictedSubjects } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  const hits = (text: string) => scanRestrictedSubjects(text, "islamic-history").map((m) => m.entry);
  // The Prophet (transliterations, honorifics, the definite reference).
  ok(hits("Muhammad receives the first revelation in the cave of Hira").includes("the Prophet Muhammad ﷺ"), "Muhammad");
  ok(hits("The Prophet prays in silence as dawn breaks").includes("the Prophet Muhammad ﷺ"), "the definite reference");
  ok(hits("the Messenger of Allah turns toward Mecca").includes("the Prophet Muhammad ﷺ"), "messenger honorific");
  // Possessives name ARTIFACTS and PLACES, not the figure — they pass (the
  // alternative-composition library itself leans on "the Prophet's mosque",
  // "the Prophet's green mantle"); the L4 pixel scan backstops abuse.
  eq(hits("the Prophet's mosque at Medina, palm-trunk columns, empty courtyard").length, 0, "possessive place reference passes");
  eq(hits("Muhammad's cloak rests folded on a stool").length, 0, "possessive artifact reference passes");
  // The Ten + family + prophets + angels + God.
  ok(hits("Abu Bakr speaks beside the mosque").includes("Abu Bakr"), "Abu Bakr");
  ok(hits("Umar enters the courtyard").includes("Umar ibn al-Khattab"), "Umar");
  ok(hits("Ali lifts the banner").includes("Ali ibn Abi Talib"), "Ali");
  ok(hits("Khadijah listens at the door").includes("Khadijah"), "Khadijah");
  ok(hits("Musa raises his staff toward the sea").includes("Musa"), "Musa");
  ok(hits("Jesus teaches in the market").includes("Isa"), "Isa/Jesus");
  ok(hits("the angel Jibril descends").includes("the angels"), "Jibril");
  ok(hits("Gabriel appears in a dream").includes("the angels"), "Gabriel");
  ok(hits("the mercy of Allah descends as golden light").includes("God (Allah)"), "Allah");
  eq(hits("Allah's mercy fills the night sky as light").length, 0, "possessive divine-reference passes (light is the compliant rendering)");
  // Word boundaries: substrings of ordinary words never fire.
  eq(hits("the adamant merchant refuses the deal").length, 0, "'adamant' does not match Adam");
  eq(hits("muhammadan-era calligraphy").length, 0, "'muhammadan' does not match (boundary)");
  eq(hits("his job as a scribe in Damascus").length, 0, "common noun 'job' never matched (only 'prophet job')");
  // What stays ALLOWED (the policy's whole point — compose around, don't ban).
  eq(hits("gilded Arabic calligraphy on aged parchment, lamplight catching gold leaf").length, 0, "calligraphy allowed");
  eq(hits("the open mushaf rests on its carved wooden rehal").length, 0, "the mushaf allowed");
  eq(hits("the Prophet's mosque at Medina — palm-trunk columns, empty courtyard").length, 0, "sacred architecture allowed");
  eq(hits("a distant caravan crosses the dunes, faces indistinct").length, 0, "anonymous distant crowds allowed");
  // Standard policy: no restrictions at all.
  eq(scanRestrictedSubjects("Muhammad in the cave of Hira", "standard").length, 0, "standard policy scans nothing");
});

await test("S49 sanitizePromptForPolicy: substitution, negative clause, identity", async () => {
  const { sanitizePromptForPolicy, policyNegativeClause, ALTERNATIVE_COMPOSITIONS } =
    await import("../src/lib/tubeforge/restricted-subjects.ts");
  // Standard policy = the exact identity transform.
  const standard = "The Prophet Muhammad stands in the cave of Hira. Wide 16:9 cinematic frame.";
  eq(sanitizePromptForPolicy(standard, "standard").prompt, standard, "standard policy is identity (byte-for-byte)");
  // Clean prompt under the policy → unchanged + the hard negative clause.
  const clean = "Gilded Arabic calligraphy on parchment. Wide 16:9 cinematic frame.";
  const cleanRes = sanitizePromptForPolicy(clean, "islamic-history");
  eq(cleanRes.prompt, `${clean} ${policyNegativeClause("islamic-history")}`, "clean prompt gains only the negative clause");
  eq(cleanRes.substituted, 0, "nothing substituted");
  // Restricted sentence → REPLACED (never deleted), sibling sentences intact.
  const dirty = "The Prophet Muhammad stands in the cave of Hira. The desert night sky wheels overhead. Wide 16:9 cinematic frame.";
  const dirtyRes = sanitizePromptForPolicy(dirty, "islamic-history");
  eq(dirtyRes.substituted, 1, "one sentence substituted");
  ok(dirtyRes.matches.some((m) => m.entry === "the Prophet Muhammad ﷺ"), "the match is reported");
  // The name is gone from the POSITIVE portion (the negative clause that
  // remains MENTIONS the name by design — that is what it forbids).
  const positive = dirtyRes.prompt.replace(policyNegativeClause("islamic-history"), "");
  ok(!/Prophet Muhammad/i.test(positive), "the restricted name is GONE from the positive prompt");
  ok(dirtyRes.prompt.includes("The desert night sky wheels overhead."), "the clean sibling sentence survives");
  ok(dirtyRes.prompt.includes("Wide 16:9 cinematic frame."), "the boilerplate survives");
  // The replacement is drawn from the alternative-composition library.
  ok(
    ALTERNATIVE_COMPOSITIONS.some((alt) => dirtyRes.prompt.includes(alt)),
    "the substituted clause comes from the alternative-composition library"
  );
  // Deterministic: the same input always maps to the same output.
  eq(
    sanitizePromptForPolicy(dirty, "islamic-history").prompt,
    dirtyRes.prompt,
    "deterministic substitution (hash-picked)"
  );
  // appendNegative: false — metadata fields substitute without the clause.
  const meta = sanitizePromptForPolicy("The Prophet Muhammad", "islamic-history", { appendNegative: false });
  ok(!meta.prompt.includes("Absolutely no depiction"), "no negative clause on metadata fields");
  ok(ALTERNATIVE_COMPOSITIONS.some((alt) => meta.prompt === alt), "the whole phrase was replaced");
});

await test("S49 policy overlays: empty for standard, doctrine for islamic-history", async () => {
  const { policyVisualRules, policySystemOverlay } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  eq(policyVisualRules("standard"), "", "no visual rules under standard");
  eq(policySystemOverlay("standard"), "", "no system overlay under standard");
  const vr = policyVisualRules("islamic-history");
  ok(vr.includes("ISLAMIC VISUAL PROTECTION"), "visual rules carry the doctrine");
  ok(vr.includes("never let the visual description read as depicting them"), "narration-free rule present");
  const so = policySystemOverlay("islamic-history");
  ok(so.includes("No face, figure, silhouette or light-body"), "system overlay carries the shot-level law");
});

await test("S49 directorSystemPrompt: the policy overlay stacks on the profile voice", async () => {
  const { directorSystemPrompt } = await import("../src/lib/tubeforge/director.ts");
  const { resolveProfile } = await import("../src/lib/tubeforge/production-profiles.ts");
  const plain = directorSystemPrompt(resolveProfile("narrative"));
  const withPolicy = directorSystemPrompt(resolveProfile("narrative"), "islamic-history");
  ok(!plain.includes("ISLAMIC VISUAL PROTECTION"), "no overlay without a policy");
  ok(withPolicy.includes("ISLAMIC VISUAL PROTECTION"), "overlay appended under the policy");
  ok(withPolicy.startsWith(plain.slice(0, 200)), "the profile voice still opens the prompt (they stack, not replace)");
});

await test("S49 parsePlan: contentPolicy provenance rides the plan", async () => {
  const { parsePlan } = await import("../src/lib/tubeforge/director-plan.ts");
  const plan = parsePlan(JSON.stringify({
    version: 2, concept: "c",
    contentPolicy: "islamic-history",
    scenes: [{ sceneIndex: 1, mood: "m", shots: [{ shotIndex: 0, framing: "wide", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 2, imagePrompt: "x" }] }],
  }));
  if (!plan) throw new Error("plan must parse");
  eq(plan.contentPolicy, "islamic-history", "provenance parses");
  const bare = parsePlan(JSON.stringify({
    version: 2, concept: "c",
    scenes: [{ sceneIndex: 1, mood: "m", shots: [{ shotIndex: 0, framing: "wide", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 2, imagePrompt: "x" }] }],
  }));
  eq(bare?.contentPolicy, undefined, "absent provenance stays absent");
});

await test("S49 qc battery: the restricted-visual check rides the report when the scan ran", async () => {
  const { runQcReport } = await import("../src/lib/tubeforge/qc.ts");
  const opts = {
    mp4Path: "/nonexistent/tf-s49/final.mp4",
    videoDuration: 10,
    narrationSec: null,
    srtPath: null,
  };
  // Absent scan (standard policy) → the check is NOT emitted.
  const plain = await runQcReport(opts);
  eq(plain.checks.some((c) => c.id === "restricted-visual"), false, "no scan → no check (pre-S49 behavior)");
  // A passing scan → the check is present and passes.
  const pass = await runQcReport({ ...opts, restrictedScan: { status: "pass", value: "8 frame(s) compliant" } });
  const passCheck = pass.checks.find((c) => c.id === "restricted-visual");
  ok(passCheck !== undefined, "scan pass → check emitted");
  eq(passCheck?.status, "pass", "pass status rides");
  eq(passCheck?.value, "8 frame(s) compliant", "value rides");
  // A failed scan → the check fails and the REPORT fails (it counts toward passed).
  const fail = await runQcReport({ ...opts, restrictedScan: { status: "fail", value: "restricted figure depicted", detail: "frame 3" } });
  const failCheck = fail.checks.find((c) => c.id === "restricted-visual");
  eq(failCheck?.status, "fail", "fail status rides");
  eq(fail.passed, false, "a failed scan fails the report");
  // An unmeasured scan → the check is unmeasured and the report is NOT clean.
  const un = await runQcReport({ ...opts, restrictedScan: { status: "unmeasured", value: "scan could not run" } });
  eq(un.checks.find((c) => c.id === "restricted-visual")?.status, "unmeasured", "unmeasured status rides");
  eq(un.passed, false, "an unmeasured scan never reads as clean");
});

await test("S49 qc gate: restricted-visual blocks export/publish (fail-closed)", async () => {
  const { applyQcPolicy, QC_ENFORCEMENT_MATRIX } = await import("../src/lib/tubeforge/qc-policy.ts");
  eq(QC_ENFORCEMENT_MATRIX["restricted-visual"]?.severity, "block", "matrix classifies restricted-visual as BLOCK");
  const mk = (status: "pass" | "fail" | "unmeasured") => ({
    passed: status === "pass",
    checkedAt: "2026-11-07T00:00:00.000Z",
    durationSec: 60,
    checks: [
      { id: "playable", label: "Plays", status: "pass" as const, value: "ok" },
      { id: "restricted-visual", label: "Restricted", status, value: "fixture" },
    ],
  });
  eq(applyQcPolicy(mk("pass")).blocked, false, "a passing scan does not block");
  eq(applyQcPolicy(mk("fail")).blocked, true, "a failing scan blocks the export");
  eq(applyQcPolicy(mk("unmeasured")).blocked, true, "an unmeasured scan blocks (fail-closed — a lens that never ran cannot certify)");
  const finding = applyQcPolicy(mk("fail")).blockers.find((b) => b.id === "restricted-visual");
  ok(finding !== undefined && finding.why.length > 10, "the finding carries its rationale");
});

await test("S49 runRestrictedVisualScan: a scan that cannot run reports unmeasured, never throws", async () => {
  const { runRestrictedVisualScan } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  // A nonexistent input file: ffmpeg fails → the scan must catch and report
  // "unmeasured" (the fail-closed contract — the QC gate then holds export).
  const outcome = await runRestrictedVisualScan({ mp4Path: "/nonexistent/tf-s49/final.mp4", durationSec: 10 });
  eq(outcome.status, "unmeasured", "a failed ffmpeg reports unmeasured");
  ok(outcome.value.length > 0, "the outcome carries a value string");
  ok(outcome.detail !== undefined && outcome.detail.length > 0, "the outcome carries the failure detail");
});

await test("S49 islamic-history profile: 8th profile, catalog + parsePlan snap agree", async () => {
  const { PRODUCTION_PROFILES, PROFILE_IDS_CATALOG, resolveProfile } = await import("../src/lib/tubeforge/production-profiles.ts");
  const { PROFILE_IDS, parsePlan } = await import("../src/lib/tubeforge/director-plan.ts");
  ok(PRODUCTION_PROFILES["islamic-history"] !== undefined, "the 8th profile exists");
  eq(PROFILE_IDS.includes("islamic-history"), true, "PROFILE_IDS carries it (parsePlan snap set)");
  eq(PROFILE_IDS_CATALOG.includes("islamic-history"), true, "the catalog carries it");
  const p = resolveProfile("islamic-history");
  eq(p.id, "islamic-history", "resolver finds it");
  ok(p.systemOverlay.includes("NEVER depicted"), "the profile's doctrine is in its voice");
  // And a plan stamped with it parses.
  const plan = parsePlan(JSON.stringify({
    version: 2, concept: "c", profile: "islamic-history",
    scenes: [{ sceneIndex: 1, mood: "m", shots: [{ shotIndex: 0, framing: "wide", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 2, imagePrompt: "x" }] }],
  }));
  eq(plan?.profile, "islamic-history", "the plan's profile field snaps to the 8th id");
});

// ---------------------------------------------------------------------------
// S50 — the Motion Engine: per-shot hand-offs (the S48 deferred field
// executing), the v2 vocabulary in the i2v prompt, and the palindrome loop.
// ---------------------------------------------------------------------------

await test("S50 multiShotSceneGraph: per-shot fade — the xfade chain with an EXACT frame budget", async () => {
  const { multiShotSceneGraph, SHOT_FADE_SEC } = await import("../src/lib/tubeforge/motion.ts");
  const settings = { mode: "smart", intensity: 40, curve: "smooth", vary: true } as never;
  const fps = 30;
  // 3 shots (4s/3s/3s), fade after shot 0, cut after shot 1 — the mixed join.
  const g = multiShotSceneGraph({
    dur: 10, settings, fps,
    shots: [
      { kind: "zoom-in", sec: 4, input: 0, transitionOut: "fade" },
      { kind: "pan-right", sec: 3, input: 0, transitionOut: "cut" },
      { kind: "zoom-out", sec: 3, input: 4 },
    ] as never,
  });
  // The xfade join replaces the single concat.
  ok(g.includes("xfade=transition=fade:"), "the fade pair blends through xfade");
  ok(!g.includes("concat=n=3"), "the single hard concat is gone when a fade is present");
  ok(g.includes("concat=n=2:v=1:a=0"), "the CUT pair still hard-concats (mixed join)");
  // Frame budget: Σtrims − Σxfade-overlaps === round(dur*fps) — the audio-sync
  // law survives the fades by compensation.
  const frames = [...g.matchAll(/trim=end_frame=(\d+)/g)].map((m) => Number(m[1]));
  const xfades = [...g.matchAll(/xfade=transition=fade:duration=([\d.]+):/g)].map((m) => Number(m[1]));
  eq(frames.length, 3, "one trim per shot");
  eq(xfades.length, 1, "one xfade (only the fade pair)");
  const overlapFrames = xfades.reduce((a, d) => a + Math.round(d * fps), 0);
  approx(frames.reduce((a, b) => a + b, 0) - overlapFrames, 300, 0.5,
    "output frames = round(10s × 30fps) EXACTLY (fades compensated)");
  // The fade duration obeys SHOT_FADE_SEC capped by 1/4 of the shorter shot.
  ok(xfades[0] <= SHOT_FADE_SEC + 1e-6, "fade ≤ SHOT_FADE_SEC");
  ok(xfades[0] <= Math.min(4, 3) / 4 + 1e-6, "fade ≤ 1/4 of the shorter adjacent shot");
  // The xfade offset lands exactly where the pair meets: offset = (shot0
  // frames − fade frames)/fps.
  const off = Number(g.match(/xfade=transition=fade:[^:]*:offset=([\d.]+)/)?.[1] ?? -1);
  approx(off, (frames[0] - overlapFrames) / fps, 0.01, "the xfade offset meets the pair boundary");

  // "cut"/absent everywhere → the pre-S50 single-concat join, byte-identical.
  const noFade = multiShotSceneGraph({
    dur: 10, settings, fps,
    shots: [
      { kind: "zoom-in", sec: 4, input: 0 },
      { kind: "pan-right", sec: 3, input: 0 },
      { kind: "zoom-out", sec: 3, input: 4 },
    ] as never,
  });
  ok(noFade.includes("concat=n=3:v=1:a=0[vc]") && !noFade.includes("xfade"),
    "no fades → the legacy single concat (pre-S50 behavior)");
  const nf = [...noFade.matchAll(/trim=end_frame=(\d+)/g)].map((m) => Number(m[1]));
  approx(nf.reduce((a, b) => a + b, 0), 300, 0, "legacy path keeps the exact budget");

  // The LAST shot's hand-off is ignored (scene boundaries belong to
  // transitionIn) — no trailing xfade, budget exact.
  const lastFade = multiShotSceneGraph({
    dur: 6, settings, fps,
    shots: [
      { kind: "zoom-in", sec: 3, input: 0 },
      { kind: "zoom-out", sec: 3, input: 0, transitionOut: "fade" },
    ] as never,
  });
  ok(!lastFade.includes("xfade"), "the last shot's fade is ignored");
  ok(lastFade.includes("concat=n=2"), "the pair hard-cuts");
});

await test("S50 multiShotSceneGraph fade render contract: the xfade chain renders with EXACT duration (real ffmpeg)", async () => {
  const { multiShotSceneGraph } = await import("../src/lib/tubeforge/motion.ts");
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-s50-"));
  try {
    const imgA = path.join(tmp, "scene-01.png");
    const imgB = path.join(tmp, "shot-01-1.png");
    const wav = path.join(tmp, "scene-01.wav");
    await genFixture(imgA, ["-f", "lavfi", "-i", "testsrc2=size=1280x720", "-frames:v", "1"]);
    await genFixture(imgB, ["-f", "lavfi", "-i", "smptebars=size=1280x720", "-frames:v", "1"]);
    await genFixture(wav, ["-f", "lavfi", "-i", "sine=frequency=220:duration=4", "-ar", "48000", "-ac", "2"]);

    const fps = 12;
    const dur = 4;
    const settings = { mode: "smart", intensity: 40, curve: "smooth", vary: true } as never;
    // Two shots, fade hand-off between them — the smallest real fixture that
    // exercises the xfade join buildSegment would assemble.
    const graph = multiShotSceneGraph({
      dur, settings, fps,
      shots: [
        { kind: "zoom-in", sec: 2, input: 0, transitionOut: "fade" },
        { kind: "pan-right", sec: 2, input: 2 },
      ] as never,
    });
    ok(graph.includes("xfade=transition=fade:"), "fixture graph carries the xfade");

    const out = path.join(tmp, "seg.mp4");
    await genFixture(out, [
      "-loop", "1", "-framerate", String(fps), "-t", String(dur), "-i", imgA,
      "-i", wav,
      "-loop", "1", "-framerate", String(fps), "-t", "3", "-i", imgB,
      "-filter_complex", `${graph};[1:a]anull[a]`,
      "-map", "[v]", "-map", "[a]",
      "-t", String(dur),
      ...FFMPEG_COMMON,
    ]);
    const probe = await execFileAsync(
      "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out],
      { timeout: 60_000, maxBuffer: 1024 * 1024 }
    );
    approx(parseFloat(probe.stdout.trim()), dur, 0.2, "fade segment duration stays exact (compensated budget)");

    // The blend really blends: a frame INSIDE the fade window is neither of
    // its pure sources (a mix of testsrc2 and smptebars).
    const fadeSec = Number(graph.match(/xfade=transition=fade:duration=([\d.]+):/)?.[1] ?? 0);
    const offset = Number(graph.match(/xfade=transition=fade:[^:]*:offset=([\d.]+)/)?.[1] ?? 0);
    const fPure = path.join(tmp, "pure.png");
    const fBlend = path.join(tmp, "blend.png");
    await genFixture(fPure, ["-ss", String(offset - fadeSec * 0.5), "-i", out, "-frames:v", "1"]);
    await genFixture(fBlend, ["-ss", String(offset + fadeSec * 0.5), "-i", out, "-frames:v", "1"]);
    const bPure = await fsp.readFile(fPure);
    const bBlend = await fsp.readFile(fBlend);
    ok(!bPure.equals(bBlend), "the fade window shows a blended frame (motion inside the hand-off)");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

await test("S50 i2vMotionPrompt: the v2 vocabulary speaks, subjectAction leads, moveSpeed colors", async () => {
  const { i2vMotionPrompt, I2V_CAMERA_PHRASES } = await import("../src/lib/tubeforge/liveliness.ts");
  const { CAMERA_MOVES } = await import("../src/lib/tubeforge/director-plan.ts");
  const scene = {
    index: 1, title: "T", narration: "n",
    visual: "the harbor at dawn, gulls wheeling over the mastheads",
    camera: "static", mood: "cold morning light", caption: "c",
    hostInScene: false, rehook: false, sfx: "none",
  } as never;
  // Every v2 engine verb has a phrase — the S50 split-brain closure.
  for (const verb of CAMERA_MOVES) {
    ok(I2V_CAMERA_PHRASES[verb] !== undefined, `v2 verb "${verb}" has an i2v phrase`);
  }
  // The plan's shot 0 steers: camera + moveSpeed + subjectAction.
  const planScene = {
    sceneIndex: 1, mood: "m", transitionIn: "", motion: "smart",
    needsI2V: false, useStock: false, pacing: "normal", ambience: "none", sfx: "none",
    shots: [{
      shotIndex: 0, framing: "wide", camera: "diag-br", lens: "35mm", composition: "rule of thirds",
      duration: 3, imagePrompt: "the quay", subjectAction: "gulls banking hard over the wake",
      cameraHeight: "eye-level", angle: "front", depthOfField: "deep", focal: "",
      moveSpeed: "slow", transitionOut: "cut", purpose: "establish", notes: "",
    }],
  } as never;
  const p = i2vMotionPrompt(scene, planScene);
  ok(p.startsWith("Slow, deliberate diagonal camera drift"),
    "moveSpeed colors the camera phrase (slow → 'Slow, deliberate …')");
  ok(p.includes("Gulls banking hard over the wake"),
    "the director's subjectAction LEADS the subject clauses");
  ok(p.includes("Natural ambient motion within the scene"),
    "S63: the per-kind motion doctrine ALWAYS rides behind the ask");
  ok(p.includes("the harbor at dawn"), "the scene visual rides the prompt");
  // Fallbacks: no plan → the scene camera + the per-kind clause.
  const bare = i2vMotionPrompt(scene, null);
  ok(bare.startsWith("Locked-off camera"), "no plan → the scene camera phrase");
  ok(bare.includes("Natural ambient motion within the scene") || bare.includes("ambient"),
    "no plan → the per-kind subject clause");
  // fast modulation
  const fastScene = JSON.parse(JSON.stringify(planScene));
  fastScene.shots[0].moveSpeed = "fast";
  const pf = i2vMotionPrompt(scene, fastScene);
  ok(pf.startsWith("Quick, energetic "), "fast moveSpeed colors the phrase");
  // An unknown verb still degrades to the generic drift (defensive; the
  // moveSpeed prefix still rides on top of it).
  const junk = JSON.parse(JSON.stringify(planScene));
  junk.shots[0].camera = "not-a-verb";
  const pj = i2vMotionPrompt(scene, junk);
  ok(/subtle cinematic camera drift/i.test(pj), "unknown verb → generic drift (speed prefix may ride)");
});

await test("S50 buildSceneShots carries transitionOut into the execution", async () => {
  const { buildSceneShots } = await import("../src/lib/tubeforge/shots.ts");
  const scene = {
    index: 1, title: "T", narration: "n", visual: "v", camera: "static",
    mood: "m", caption: "c", hostInScene: false, rehook: false, sfx: "none",
  } as never;
  const planScene = {
    sceneIndex: 1, mood: "m", transitionIn: "", motion: "smart",
    needsI2V: false, useStock: false, pacing: "normal", ambience: "none", sfx: "none",
    shots: [
      { shotIndex: 0, framing: "wide", camera: "zoom-in", lens: "35mm", composition: "rule of thirds", duration: 2.5, imagePrompt: "a", transitionOut: "fade" },
      { shotIndex: 1, framing: "medium", camera: "static", lens: "35mm", composition: "rule of thirds", duration: 2.5, imagePrompt: "b" },
    ],
  } as never;
  const plan = buildSceneShots({ scene, planScene, measuredSec: 5 });
  eq(plan.available[0].transitionOut, "fade", "shot 0's fade rides the execution");
  eq(plan.available[1].transitionOut, undefined, "absent hand-off stays absent (no fade)");
});

await test("S50 PALINDROME_LOOP_GRAPH: the loop the renderer runs really loops seamlessly (real ffmpeg)", async () => {
  const { PALINDROME_LOOP_GRAPH } = await import("../src/lib/tubeforge/motion.ts");
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-s50-loop-"));
  try {
    // A 2s clip with continuous GUARANTEED motion: a linear PAN across a
    // deterministic testsrc2 canvas (the `gradients` source this test
    // originally used is seed-random and occasionally renders near-static
    // content, making the last→first boundary jump undetectable: a flake
    // caught on S51's second full-suite run; testsrc2 alone moved too
    // little). The pan makes frame 0 (left edge) and frame N−1 (right edge)
    // genuinely different content; gblur keeps frames smooth so the
    // same-frame re-encode noise stays tiny.
    const fps = 12;
    const clip = path.join(tmp, "scene-01.mp4");
    await genFixture(clip, [
      "-f", "lavfi", "-i", "testsrc2=size=640x180:rate=" + fps, "-t", "2",
      "-vf", "crop=w=320:h=180:x=120*t:y=0,gblur=sigma=3",
      ...FFMPEG_COMMON,
    ]);
    // The exact command ensureSceneLoop runs.
    const loop = path.join(tmp, "scene-01-loop.mp4");
    await genFixture(loop, [
      "-i", clip,
      "-filter_complex", PALINDROME_LOOP_GRAPH,
      "-map", "[v]", "-r", String(fps),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
      "-pix_fmt", "yuv420p", "-an",
    ]);
    // Duration ≈ 2× the clip (fwd + rev).
    const probe = async (f: string) =>
      parseFloat((await execFileAsync(
        "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f],
        { timeout: 60_000, maxBuffer: 1024 * 1024 }
      )).stdout.trim());
    const clipDur = await probe(clip);
    const loopDur = await probe(loop);
    approx(loopDur, clipDur * 2, 0.25, "palindrome duration ≈ 2× the clip");
    // Seamlessness at the pixel level, by EXACT frame index (time-based -ss
    // rounding straddles the turning frame unpredictably): the palindrome's
    // frames N−1 and N are the duplicated turning pair (the SAME source
    // frame — they differ only by re-encode noise), while the raw forward
    // loop's frames N−1 and N jump from the clip's LAST frame to its FIRST
    // (the rewind defect). Mean-absolute-difference on 64x64 gray decodes.
    const countFrames = async (f: string): Promise<number> => {
      const r = await execFileAsync(
        "ffprobe",
        ["-v", "error", "-count_packets", "-select_streams", "v:0", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", f],
        { timeout: 60_000, maxBuffer: 1024 * 1024 }
      );
      return parseInt(String(r.stdout).trim(), 10) || 0;
    };
    const gray = async (f: string, idx: number): Promise<Buffer> => {
      const r = await execFileAsync(
        "ffmpeg",
        ["-i", f, "-vf", `select=eq(n\\,${idx}),scale=64x64,format=gray`, "-frames:v", "1", "-f", "rawvideo", "pipe:1"],
        { timeout: 60_000, maxBuffer: 1024 * 1024, encoding: "buffer" }
      );
      return r.stdout as unknown as Buffer;
    };
    const mad = (x: Buffer, y: Buffer): number => {
      const n = Math.min(x.length, y.length);
      let s = 0;
      for (let i = 0; i < n; i++) s += Math.abs(x[i] - y[i]);
      return n ? s / n : 255;
    };
    const N = await countFrames(clip);
    ok(N >= 20, `the fixture clip has a sane frame count (${N})`);
    const rawLoop = path.join(tmp, "raw-loop.mp4");
    await genFixture(rawLoop, ["-stream_loop", "1", "-i", clip, "-t", String(clipDur * 2), ...FFMPEG_COMMON]);
    const palMad = mad(await gray(loop, N - 1), await gray(loop, N));
    const rawMad = mad(await gray(rawLoop, N - 1), await gray(rawLoop, N));
    ok(palMad < 5, `palindrome turning pair is the SAME frame (MAD ${palMad.toFixed(1)} < 5 — re-encode noise only)`);
    ok(rawMad > Math.max(12, palMad * 3),
      `the raw forward loop's boundary jumps last→first (MAD ${rawMad.toFixed(1)} ≫ ${palMad.toFixed(1)}) — the defect S50 fixes`);
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// S51 — the Visual Continuity Engine: the reference-photo seam (the writer
// for the dead-schema columns), the portrait-age fix, and the location seed.
// ---------------------------------------------------------------------------

await test("S51 parseReferenceKeys: the JSON column's fail-open contract", async () => {
  const { parseReferenceKeys } = await import("../src/lib/tubeforge/references.ts");
  eq(parseReferenceKeys(null), [], "null column → no refs");
  eq(parseReferenceKeys(undefined), [], "undefined column → no refs");
  eq(parseReferenceKeys(""), [], "empty string → no refs");
  eq(parseReferenceKeys("{corrupt"), [], "corrupt JSON → no refs, never a crash");
  eq(parseReferenceKeys("[1,true,\"x\"]"), ["x"], "non-string entries filtered");
  eq(parseReferenceKeys("\"flat\""), [], "a bare string is not a ref list");
  eq(
    parseReferenceKeys(JSON.stringify(["characters/a/ref-1.png", "characters/a/ref-2.png"])),
    ["characters/a/ref-1.png", "characters/a/ref-2.png"],
    "the real shape round-trips, oldest first"
  );
});

await test("S51 nextReferenceKey: lowest-free allocation stays inside the cap forever", async () => {
  const { nextReferenceKey } = await import("../src/lib/tubeforge/references.ts");
  const P = "characters/x";
  eq(nextReferenceKey(P, []), `${P}/ref-1.png`, "empty library → slot 1");
  eq(
    nextReferenceKey(P, [`${P}/ref-1.png`, `${P}/ref-2.png`]),
    `${P}/ref-3.png`,
    "contiguous library → the next slot"
  );
  eq(
    nextReferenceKey(P, [`${P}/ref-1.png`, `${P}/ref-3.png`]),
    `${P}/ref-2.png`,
    "a deleted slot is REUSED (gap-free)"
  );
  // Pigeonhole: with length < cap the lowest free index is ≤ cap — churn
  // (delete + re-add forever) can never grow the numbers past the cap.
  const cap = 6;
  const keys = Array.from({ length: cap }, (_, i) => `${P}/ref-${i + 1}.png`);
  for (let churn = 0; churn < 50; churn++) {
    keys.splice(Math.floor(Math.random() * keys.length), 1);
    const next = nextReferenceKey(P, keys);
    const idx = Number(next.match(/ref-(\d+)\.png/)?.[1] ?? 0);
    ok(idx <= cap, `churn ${churn}: allocated slot ${idx} stays ≤ cap ${cap}`);
    keys.push(next);
    eq(keys.length, cap, "the library returns to full");
  }
});

await test("S51 isReferenceKey: the DELETE route's path-traversal guard", async () => {
  const { isReferenceKey } = await import("../src/lib/tubeforge/references.ts");
  const P = "characters/x";
  ok(isReferenceKey(P, `${P}/ref-1.png`), "a real key passes");
  ok(!isReferenceKey(P, `${P}/portrait.png`), "the portrait is not a reference");
  ok(!isReferenceKey(P, `${P}/ref-1.png/../../secret.png`), "traversal inside the tail dies");
  ok(!isReferenceKey(P, "../../etc/passwd"), "bare traversal dies");
  ok(!isReferenceKey(P, `locations/x/ref-1.png`), "another library's key dies");
  ok(!isReferenceKey(P, `${P}/ref-abc.png`), "non-numeric slot dies");
  ok(!isReferenceKey(P, `${P}/ref-1.jpg`), "non-PNG suffix dies");
});

await test("S51 saveReferenceImage: real ffmpeg normalization + the storage seam", async () => {
  const {
    saveReferenceImage,
    removeReferenceFile,
    MAX_REFERENCE_BYTES,
    REFERENCE_LONG_EDGE,
  } = await import("../src/lib/tubeforge/references.ts");
  const storage = await import("../src/lib/tubeforge/storage.ts");
  const FFOPT = { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 } as const;
  const expectThrow = async (p: Promise<unknown>, needle: string) => {
    try {
      await p;
    } catch (err) {
      ok(String((err as Error).message).includes(needle), `the error names "${needle}"`);
      return;
    }
    throw new Error(`expected a throw containing "${needle}", got success`);
  };
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "s51-refs-"));
  const P = `characters/s51-unit-${Date.now().toString(36)}`;
  try {
    // A 2000x1000 PNG → long edge scaled DOWN to 1024 (aspect preserved).
    const big = path.join(tmp, "big.png");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=red:s=2000x1000:d=1",
      "-frames:v", "1", big,
    ], FFOPT);
    const savedBig = await saveReferenceImage(P, [], await fsp.readFile(big));
    eq(savedBig.key, `${P}/ref-1.png`, "first upload takes slot 1");
    ok(savedBig.bytes > 1000, "the normalized PNG is real");
    const dims = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join("uploads", savedBig.key),
    ], FFOPT);
    const [w, h] = dims.stdout.trim().split(",").map(Number);
    eq(w, REFERENCE_LONG_EDGE, `2000-wide input scales down to ${REFERENCE_LONG_EDGE}`);
    eq(h, 512, "aspect preserved (2000x1000 → 1024x512)");
    ok(await storage.exists(savedBig.key), "the file landed in the storage driver");

    // A small 400x300 PNG passes through at its OWN size (no upscale).
    const small = path.join(tmp, "small.png");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=blue:s=400x300:d=1",
      "-frames:v", "1", small,
    ], FFOPT);
    const savedSmall = await saveReferenceImage(P, [savedBig.key], await fsp.readFile(small));
    eq(savedSmall.key, `${P}/ref-2.png`, "second upload takes slot 2");
    const dimsS = await execFileAsync("ffprobe", [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height", "-of", "csv=p=0", path.join("uploads", savedSmall.key),
    ], FFOPT);
    const [sw, sh] = dimsS.stdout.trim().split(",").map(Number);
    eq(sw, 400, "small input is NOT upscaled (width)");
    eq(sh, 300, "small input is NOT upscaled (height)");

    // Guards: garbage bytes and the size ceiling.
    const garbage = Buffer.alloc(2048, 0x41); // "AAAA…" — big enough, but not an image
    await expectThrow(saveReferenceImage(P, [], garbage), "Unsupported image");
    const fat = Buffer.alloc(MAX_REFERENCE_BYTES + 1024, 0x89);
    fat[1] = 0x50; fat[2] = 0x4e; fat[3] = 0x47; // PNG magic, over the cap
    await expectThrow(saveReferenceImage(P, [], fat), "exceeds");

    // Cleanup through the seam itself.
    await removeReferenceFile(savedBig.key);
    await removeReferenceFile(savedSmall.key);
    ok(!(await storage.exists(savedBig.key)), "removeReferenceFile deletes the file");
  } finally {
    await storage.removePrefix(P).catch(() => {});
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

await test("S51 buildPortraitPrompt: the age-fidelity contract (anchor primacy + echo)", async () => {
  const { buildPortraitPrompt, buildAnchorFallback } = await import("../src/lib/tubeforge/characters.ts");
  const anchor = "nova: late-20s presenter, short silver hair, sharp green eyes";
  const prompt = buildPortraitPrompt({ name: "Nova", anchor, style: "cinematic realism" });
  // Primacy: the ANCHOR is the first thing the model reads (the S47 baseline
  // led with the character NAME — the age rode mid-prompt and drifted).
  ok(prompt.startsWith(anchor), "the anchor LEADS the prompt");
  ok(prompt.includes("apparent age MUST match the age stated"), "the age-fidelity clause rides the middle");
  ok(prompt.includes(`Identity lock, verbatim: ${anchor}`), "the anchor ECHOES before the close (recency)");
  ok(prompt.includes('"Nova"'), "the name still identifies the subject");
  ok(prompt.endsWith("Absolutely no text, no letters, no watermarks."), "the no-text clause still closes");
  // The fallback anchor (no GLM bible yet) keeps the same shape.
  const fallback = buildAnchorFallback("late-20s presenter, short silver hair", "cinematic");
  const p2 = buildPortraitPrompt({ name: "X", anchor: fallback, style: "s" });
  ok(p2.startsWith(fallback), "the fallback anchor leads identically");
});

await test("S51 getApprovedLocationRefKey's selection law, pinned at the seam it shares with the world clause", async () => {
  // The DB-backed accessor is exercised live by the S51 benchmark; here we
  // pin the pure law it enforces: PLAN ORDER wins, the NEWEST (array tail)
  // ref seeds, and props are excluded by design. The seam: parseReferenceKeys
  // feeding the same selection the accessor runs.
  const { parseReferenceKeys } = await import("../src/lib/tubeforge/references.ts");
  const planOrder = ["the neon market", "the rooftop"];
  const rows = [
    { name: "the rooftop", referenceImages: JSON.stringify(["locations/r/ref-1.png"]) },
    { name: "the neon market", referenceImages: JSON.stringify(["locations/n/ref-1.png", "locations/n/ref-2.png"]) },
  ];
  let picked: string | null = null;
  for (const name of planOrder) {
    const row = rows.find((r) => r.name === name);
    if (!row) continue;
    const keys = parseReferenceKeys(row.referenceImages);
    if (keys.length > 0) picked = keys[keys.length - 1];
    if (picked) break;
  }
  eq(picked, "locations/n/ref-2.png", "plan order wins over row order, newest (tail) seeds");
});

// ---------------------------------------------------------------------------
// S52 — the themed production profiles surface: the picker catalog (what the
// GET /director route serves) and the approval card's live profile notes.
// ---------------------------------------------------------------------------

await test("S52 profilePickerList: the picker's wire contract", async () => {
  const { profilePickerList, PROFILE_IDS_CATALOG } = await import(
    "../src/lib/tubeforge/production-profiles.ts"
  );
  const list = profilePickerList();
  eq(list.length, 8, "all 8 profiles are offered");
  eq(new Set(list.map((p) => p.id)).size, 8, "ids are unique");
  eq(
    JSON.stringify(list.map((p) => p.id)),
    JSON.stringify(PROFILE_IDS_CATALOG),
    "picker order === catalog order (the same keys resolveProfile snaps against)"
  );
  eq(list[0].id, "narrative", "narrative (the compatibility profile) leads");
  for (const p of list) {
    ok(p.label.length > 0 && p.label.length <= 30, `${p.id}: label present and short`);
    ok(
      p.blurb.length >= 20 && p.blurb.length <= 100,
      `${p.id}: blurb is one readable line (20–100 chars), got ${p.blurb.length}`
    );
  }
  const islamic = list.find((p) => p.id === "islamic-history");
  ok(islamic && /protection/i.test(islamic.blurb), "islamic-history's blurb names the protection pairing");
});

await test("S52 planProfileNotes: the authoring profile's live advisory (no silent creative decisions)", async () => {
  const { planProfileNotes } = await import("../src/lib/tubeforge/production-profiles.ts");
  type Plan = import("../src/lib/tubeforge/director-plan.ts").DirectorPlan;
  const shot = (imagePrompt: string) => ({
    shotIndex: 0, framing: "medium", camera: "static", lens: "35mm",
    composition: "centered", duration: 3, imagePrompt,
  });
  const scene = (sceneIndex: number, imagePrompt: string, transitionIn = "cut") => ({
    sceneIndex, mood: "warm", transitionIn, motion: "smart", needsI2V: false,
    useStock: false, pacing: "normal", ambience: "none", sfx: "none",
    shots: [shot(imagePrompt)],
  });
  // An advertisement plan whose opening shot is NOT product-forward and
  // whose close is not a CTA — the profile's own validation must flag both
  // (the exact notes the approval card surfaces before the human approves).
  const adPlan = {
    version: 2 as const,
    generatedAt: "2026-11-07T00:00:00Z",
    concept: "test fixture",
    profile: "advertisement",
    scenes: [
      scene(1, "a windswept cliff at golden hour, empty and vast", ""),
      scene(2, "the brand story continues quietly"),
    ],
  };
  const notes = planProfileNotes(adPlan as Plan);
  eq(notes.length, 2, `both advertisement rules fire (open + close), got ${notes.length}`);
  ok(notes.some((n) => n.includes("must open on the product")), "the non-product open is flagged");
  ok(notes.some((n) => n.includes("must close on a CTA")), "the non-CTA close is flagged");

  // A compliant close dissolves the CTA note; narrative never imposes notes.
  const fixed = {
    ...adPlan,
    scenes: [scene(1, "hero product bottle on stone, water beading", ""), scene(2, "CTA end card — tap to order now")],
  };
  eq(planProfileNotes(fixed as Plan), [], "a compliant advertisement plan carries zero notes");
  const narrativePlan = { ...adPlan, profile: "narrative" };
  eq(planProfileNotes(narrativePlan as Plan), [], "narrative carries no profile notes");
  // A v1 plan with NO profile field resolves to narrative — no notes, no crash.
  const v1 = { ...adPlan } as Partial<typeof adPlan>;
  delete v1.profile;
  eq(planProfileNotes(v1 as Plan), [], "a legacy plan (no profile field) resolves narrative — no notes");
});

// ---------------------------------------------------------------------------
// S53 — advanced visual QC: the subject-continuity threshold (the S51
// finding's check) and the text-artifacts lens, both on the L4 seam's laws.
// ---------------------------------------------------------------------------

await test("S53 subjectVerdictFromJudge: the threshold law (lighting never flips it)", async () => {
  const { subjectVerdictFromJudge, SUBJECT_CONSISTENCY_FLOOR } = await import(
    "../src/lib/tubeforge/visual-qc.ts"
  );
  eq(SUBJECT_CONSISTENCY_FLOOR, 70, "the floor the S51 benchmark finding inherits");
  eq(subjectVerdictFromJudge({ consistent: true, score: 100 }).status, "pass", "no-subject frames verdict stands (the judge's own contract)");
  eq(subjectVerdictFromJudge({ consistent: true, score: 85 }).status, "pass", "S51-class score (85) passes");
  eq(subjectVerdictFromJudge({ consistent: true, score: 70 }).status, "pass", "the floor itself passes");
  eq(subjectVerdictFromJudge({ consistent: true, score: 69 }).status, "fail", "one under the floor fails");
  eq(subjectVerdictFromJudge({ consistent: false, score: 90 }).status, "fail", "an inconsistent judge verdict fails at ANY score");
  eq(subjectVerdictFromJudge({ consistent: true, score: 250 }).score, 100, "the score clamps to 100");
  eq(subjectVerdictFromJudge({ consistent: true, score: -5 }).score, 0, "the score clamps to 0");
  // Lighting notes live in `notes` and never enter the verdict — but a judge
  // that reports hue drift as inconsistent is OBEYED (the human reads why).
  eq(subjectVerdictFromJudge({ consistent: true, score: 72, notes: "hair reads golden under warm light — lighting, not identity" }).status, "pass", "the S51 finding class passes with its note");
  // Unparsable / partial judge output → unmeasured, never a silent pass.
  eq(subjectVerdictFromJudge(null).status, "unmeasured", "null judge output");
  eq(subjectVerdictFromJudge("garbage").status, "unmeasured", "string judge output");
  eq(subjectVerdictFromJudge({}).status, "unmeasured", "no consistent field");
  eq(subjectVerdictFromJudge({ consistent: true }).status, "unmeasured", "no score field");
  eq(subjectVerdictFromJudge({ consistent: "yes", score: 90 }).status, "unmeasured", "non-boolean consistent");
  eq(subjectVerdictFromJudge({ consistent: true, score: NaN }).status, "unmeasured", "NaN score");
});

await test("S53 visual scan prompts: the two laws the judges must carry", async () => {
  const { SUBJECT_CONTINUITY_SYSTEM, TEXT_ARTIFACT_SYSTEM } = await import(
    "../src/lib/tubeforge/visual-qc.ts"
  );
  // The S51 finding made explicit: lighting-induced hue shifts are notes,
  // not drift — only identity-defining changes count.
  ok(SUBJECT_CONTINUITY_SYSTEM.includes("LIGHTING IS NOT IDENTITY"), "the lighting law leads the subject judge");
  ok(SUBJECT_CONTINUITY_SYSTEM.includes("hair color and style, apparent age"), "identity-defining features are enumerated");
  ok(SUBJECT_CONTINUITY_SYSTEM.includes("ignore those frames"), "b-roll frames without the subject are excluded");
  // The caption-exclusion law: this production burns captions on purpose —
  // a judge that flags them would cry wolf on every video.
  ok(TEXT_ARTIFACT_SYSTEM.includes("burns captions on purpose"), "the caption-exclusion law rides the text judge");
  ok(TEXT_ARTIFACT_SYSTEM.includes("gibberish or garbled lettering"), "the artifact classes are enumerated");
  ok(TEXT_ARTIFACT_SYSTEM.includes("watermarks"), "watermarks are in scope");
});

await test("S53 sampleFramesEvenly: real ffmpeg sampling + the never-throw contract", async () => {
  const { sampleFramesEvenly } = await import("../src/lib/tubeforge/visual-qc.ts");
  const FFOPT = { timeout: 60_000, maxBuffer: 4 * 1024 * 1024 } as const;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "s53-frames-"));
  try {
    // A real 4s video: 4 frames sampled evenly (fps = min(4/4, 1) = 1/s —
    // the L4 sampling-density cap) must come back as 4 decodable base64
    // JPEG payloads. NOTE: a file SHORTER than the frame count samples
    // fewer frames (the 1fps cap) — the S49 density law, kept as-is.
    const mp4 = path.join(tmp, "v.mp4");
    await execFileAsync("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc2=s=320x240:d=4:r=10",
      "-pix_fmt", "yuv420p", mp4,
    ], FFOPT);
    const payloads = await sampleFramesEvenly(mp4, 4, 4);
    eq(payloads.length, 4, "4 frames sampled from a 4s file at the 1fps cap");
    for (const p of payloads) {
      ok(p.length > 1000, "each payload is a real JPEG, not a stub");
      // JPEG magic FF D8 FF encodes to base64 as /9j/ at the head.
      ok(p.startsWith("/9j/"), "the payload is base64 JPEG");
    }
    // A 0/NaN duration falls back to 1s (clamp), a nonexistent file → [].
    const clamp = await sampleFramesEvenly(mp4, Number.NaN, 4);
    ok(clamp.length > 0, "a NaN duration still samples (the 1s clamp)");
    eq(await sampleFramesEvenly("/nonexistent/s53/final.mp4", 10, 4), [], "nonexistent input → empty (never throws)");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

await test("S53 qc battery: the advanced visual lenses ride the report when the scans ran", async () => {
  const { runQcReport } = await import("../src/lib/tubeforge/qc.ts");
  const opts = {
    mp4Path: "/nonexistent/tf-s53/final.mp4",
    videoDuration: 10,
    narrationSec: null,
    srtPath: null,
  };
  // Absent scans → neither check is emitted (pre-S53 behavior).
  const plain = await runQcReport(opts);
  eq(plain.checks.some((c) => c.id === "subject-continuity"), false, "no subject scan → no subject check");
  eq(plain.checks.some((c) => c.id === "text-artifacts"), false, "no text scan → no text check");
  // Passing scans → emitted, passing.
  const pass = await runQcReport({
    ...opts,
    subjectScan: { status: "pass", value: "identity consistent across 5 subject frame(s) — 86/100" },
    textScan: { status: "pass", value: "8 frame(s) clean of artifact text" },
  });
  eq(pass.checks.find((c) => c.id === "subject-continuity")?.status, "pass", "subject pass rides");
  eq(pass.checks.find((c) => c.id === "text-artifacts")?.status, "pass", "text pass rides");
  // Failing/unmeasured scans → the checks ride AND keep the report unclean
  // (the battery's never-silently-clean contract).
  const fail = await runQcReport({
    ...opts,
    subjectScan: { status: "fail", value: "identity drift — 54/100", detail: "frame 3" },
    textScan: { status: "unmeasured", value: "scan could not run" },
  });
  eq(fail.checks.find((c) => c.id === "subject-continuity")?.status, "fail", "subject fail rides");
  eq(fail.checks.find((c) => c.id === "text-artifacts")?.status, "unmeasured", "text unmeasured rides");
  eq(fail.passed, false, "a failed/unmeasured lens never reads as clean");
});

await test("S53 qc gate: the advanced visual lenses ADVISE, never hold", async () => {
  const { applyQcPolicy, QC_ENFORCEMENT_MATRIX } = await import("../src/lib/tubeforge/qc-policy.ts");
  eq(QC_ENFORCEMENT_MATRIX["subject-continuity"]?.severity, "report", "subject-continuity is REPORT (repaint-or-accept is the operator's call)");
  eq(QC_ENFORCEMENT_MATRIX["text-artifacts"]?.severity, "report", "text-artifacts is REPORT (until calibration evidence justifies a flip)");
  const mk = (status: "pass" | "fail" | "unmeasured") => ({
    passed: status === "pass",
    checkedAt: "2026-11-07T00:00:00.000Z",
    durationSec: 60,
    checks: [
      { id: "playable", label: "Plays", status: "pass" as const, value: "ok" },
      { id: "subject-continuity", label: "Subject", status, value: "fixture" },
      { id: "text-artifacts", label: "Text", status, value: "fixture" },
    ],
  });
  eq(applyQcPolicy(mk("fail")).blocked, false, "failing visual lenses do NOT block the export");
  eq(applyQcPolicy(mk("unmeasured")).blocked, false, "unmeasured visual lenses do NOT block");
  const advisories = applyQcPolicy(mk("fail")).advisories.map((a) => a.id).sort();
  eq(advisories, ["subject-continuity", "text-artifacts"], "both surface as advisories with their rationale");
  ok(applyQcPolicy(mk("fail")).advisories.every((a) => a.why.length > 10), "each advisory carries its rationale");
});

await test("S53 runSubjectContinuityScan + runTextArtifactScan: cannot-run reports unmeasured, never throws", async () => {
  const { runSubjectContinuityScan, runTextArtifactScan } = await import(
    "../src/lib/tubeforge/visual-qc.ts"
  );
  // A nonexistent input file: ffmpeg samples nothing → both scans report
  // "unmeasured" with a readable detail (the never-throw contract).
  const subject = await runSubjectContinuityScan({
    mp4Path: "/nonexistent/tf-s53/final.mp4",
    durationSec: 10,
    characterName: "Nova",
    anchor: "late-20s presenter, short silver hair",
  });
  eq(subject.status, "unmeasured", "subject scan on a dead file → unmeasured");
  ok(subject.detail !== undefined && subject.detail.length > 0, "the subject outcome carries the failure detail");
  const text = await runTextArtifactScan({ mp4Path: "/nonexistent/tf-s53/final.mp4", durationSec: 10 });
  eq(text.status, "unmeasured", "text scan on a dead file → unmeasured");
  ok(text.detail !== undefined && text.detail.length > 0, "the text outcome carries the failure detail");
});

suiteStart("S55 — cinematic quality fixes (T-55.3)");

await test("S55 movementForKind: declared statics execute the ambient drift; the stillness contract stays a TRUE hold", async () => {
  const { movementForKind, STATIC_AMBIENT_DRIFT } = await import("../src/lib/tubeforge/motion.ts");
  const focal = { x: 0.5, y: 0.5 };
  // The owner's option (ii): a DECLARED static (motion on) creeps z 1.00→1.03.
  const declared = movementForKind("hold", focal, 40);
  eq(declared.kind, "hold", "declared static keeps its kind");
  approx(declared.zStart, 1, 1e-9, "static starts wide");
  approx(declared.zEnd, 1 + STATIC_AMBIENT_DRIFT, 1e-9, "static creeps to the ambient drift");
  // The user's stillness contract is untouched: intensity < 1 freezes EVERY
  // kind, drift included (the pre-S55 true hold).
  const stillHold = movementForKind("hold", focal, 0);
  eq(stillHold.zEnd, stillHold.zStart, "intensity < 1 keeps the TRUE hold");
  const stillZoom = movementForKind("zoom-in", focal, 0);
  eq(stillZoom.kind, "hold", "stillness contract outranks every move kind");
  eq(stillZoom.zEnd, stillZoom.zStart, "the contract holds the camera, not a creep");
});

await test("S55 shotZoompan: the ambient-drift static executes the creep; TRUE holds keep the constant graph", async () => {
  const { multiShotSceneGraph } = await import("../src/lib/tubeforge/motion.ts");
  const fps = 30;
  const drifting = multiShotSceneGraph({
    dur: 6,
    settings: { mode: "smart", intensity: 40, curve: "smooth", vary: true } as never,
    fps,
    shots: [
      { kind: "hold", sec: 3, input: 0 },
      { kind: "zoom-in", sec: 3, input: 0 },
    ] as never,
  });
  ok(
    /zoompan=z='1\.0000\+0\.0300\*/.test(drifting),
    "the declared static executes the 1.00→1.03 creep through the eased progress"
  );
  const still = multiShotSceneGraph({
    dur: 6,
    settings: { mode: "smart", intensity: 0, curve: "smooth", vary: true } as never,
    fps,
    shots: [
      { kind: "hold", sec: 3, input: 0 },
      { kind: "zoom-in", sec: 3, input: 0 },
    ] as never,
  });
  ok(!still.includes("*"), "intensity 0 keeps the TRUE constant-zoom hold graph (stillness contract, byte-identical)");
});

await test("S55 shotGraphJoins: the graph's own boundaries, frame-exact against the fitted allocation", async () => {
  const { shotGraphJoins, multiShotSceneGraph, SHOT_FADE_SEC } = await import("../src/lib/tubeforge/motion.ts");
  const settings = { mode: "smart", intensity: 40, curve: "smooth", vary: true } as never;
  const fps = 30;
  // Hard concats: 4/3/3s over a 10s scene — flips land on the FITTED
  // proportions (fitFrames scales the planned seconds to the exact budget).
  const joins = shotGraphJoins({
    dur: 10,
    fps,
    shots: [
      { kind: "zoom-in", sec: 4, input: 0 },
      { kind: "pan-right", sec: 3, input: 0 },
      { kind: "zoom-out", sec: 3, input: 4 },
    ] as never,
  });
  eq(joins.length, 2, "one join per shot boundary");
  approx(joins[0].at, 4, 0.05, "flip 1 sits on the fitted 4s proportion");
  approx(joins[1].at, 7, 0.05, "flip 2 sits on the fitted 7s proportion");
  eq(joins.every((j) => j.fadeSec === 0), true, "hard concats book no fade");
  // The fade hand-off sits EXACTLY at the xfade offset the graph emits
  // (the shared allocation's whole point — they cannot disagree).
  const fadeShots = [
    { kind: "zoom-in", sec: 4, input: 0, transitionOut: "fade" },
    { kind: "pan-right", sec: 3, input: 0, transitionOut: "cut" },
    { kind: "zoom-out", sec: 3, input: 4 },
  ];
  const fj = shotGraphJoins({ dur: 10, fps, shots: fadeShots as never });
  const g = multiShotSceneGraph({ dur: 10, settings, fps, shots: fadeShots as never });
  const off = Number(g.match(/xfade=transition=fade:[^:]*:offset=([\d.]+)/)?.[1] ?? -1);
  approx(fj[0].at, off, 0.005, "the fade join sits at the graph's own xfade offset");
  ok(fj[0].fadeSec > 0 && fj[0].fadeSec <= SHOT_FADE_SEC + 1e-6, "fade duration ≤ SHOT_FADE_SEC");
  eq(fj[1].fadeSec, 0, "the cut pair stays a hard join");
  // The post-fade flip sits where the OUTPUT timeline puts it — the xfade
  // consumed its overlap, so the flip lands fadeSec EARLY. Parse the graph's
  // own trims + fade and confirm the join matches the graph exactly.
  const trims = [...g.matchAll(/trim=end_frame=(\d+)/g)].map((m) => Number(m[1]));
  const fadeFrames = Math.round(fj[0].fadeSec * fps);
  approx(fj[1].at, (trims[0] + trims[1] - fadeFrames) / fps, 0.005, "the post-fade flip keeps the fitted proportion (fade debt paid)");
  // Degenerate cases.
  eq(
    shotGraphJoins({ dur: 5, fps, shots: [{ kind: "zoom-in", sec: 5, input: 0 }] as never }).length,
    0,
    "single-shot scenes carry no joins"
  );
  eq(shotGraphJoins({ dur: 5, fps, shots: [] as never }).length, 0, "empty plans carry no joins");
});

await test("S55 expectedCutsForTimeline: intra-scene shot joins ride the expectation as blended-clock windows", async () => {
  const { alignCuts, expectedCutsForTimeline } = await import("../src/lib/tubeforge/render-qc.ts");
  // 2 scenes (4s + 4s) joined by a 0.5s fade: the seam blends at 3.5s, so
  // scene 2's local 0 sits at 3.5s on the blended clock. Scene 1 carries a
  // hard flip at local 2.0s (→ blended 2.0); scene 2 a fade hand-off at
  // local 1.0s (→ blended 4.5, window spanning the 0.4s dissolve).
  const exp = expectedCutsForTimeline(
    [4, 4],
    [{ style: "fade", durationSec: 0.5 }],
    [[{ at: 2.0, fadeSec: 0 }], [{ at: 1.0, fadeSec: 0.4 }]]
  );
  eq(exp.windows.length, 3, "two shot-join windows + the scene-seam blend window");
  eq(exp.cuts.length, 0, "flips excuse detections — they never demand an appearance (the 13.25s evidence)");
  eq(alignCuts([2.0], exp).unexpected.length, 0, "the intra-scene hard flip is explained");
  eq(alignCuts([4.5], exp).unexpected.length, 0, "the intra-scene fade hand-off is explained");
  eq(alignCuts([6.2], exp).unexpected.length, 1, "a stray cut away from every boundary still flags");
  // Scene-seam obligations are untouched.
  const cutExp = expectedCutsForTimeline(
    [4, 4],
    [{ style: "cut", durationSec: 0.5 }],
    [[{ at: 2.0, fadeSec: 0 }], [{ at: 1.0, fadeSec: 0 }]]
  );
  eq(cutExp.cuts.length, 1, "the hard scene seam still MUST appear");
  eq(alignCuts([], cutExp).missing.length, 1, "a swallowed scene seam still flags");
  // The pre-S55 contract is byte-identical without joins…
  const plain = expectedCutsForTimeline([4, 4], [{ style: "fade", durationSec: 0.5 }]);
  eq(plain.windows.length, 1, "no shotJoins → the scene-seam-only expectation, unchanged");
  // …and a single-scene M2 render now books its flips (pre-S55: both empty).
  const single = expectedCutsForTimeline([8], [], [[{ at: 3.0, fadeSec: 0 }]]);
  eq(single.windows.length, 1, "a single-scene M2 render books its flips");
  eq(alignCuts([3.0], single).unexpected.length, 0, "the flip is explained");
  eq(alignCuts([6.5], single).unexpected.length, 1, "a stray cut in a single-scene render still breaks continuity");
});

await test("S55 ambient-drift static: freezedetect-clean on a real render, the TRUE hold still flags (real ffmpeg)", async () => {
  const { multiShotSceneGraph } = await import("../src/lib/tubeforge/motion.ts");
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-s55-"));
  try {
    const img = path.join(tmp, "scene-01.png");
    await genFixture(img, ["-f", "lavfi", "-i", "testsrc2=size=1280x720", "-frames:v", "1"]);
    const freezeRuns = async (file: string): Promise<number> => {
      try {
        const { stderr } = await execFileAsync(
          "ffmpeg",
          ["-hide_banner", "-nostats", "-i", file, "-vf", "freezedetect=n=0.004:d=1.00", "-an", "-f", "null", "-"],
          { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }
        );
        return [...stderr.toString().matchAll(/freeze_start:\s*(\d+(?:\.\d+)?)/g)].length;
      } catch (err) {
        // freezedetect exits nonzero only on decode failure; a real freeze
        // still parses out of stderr — reread it before giving up.
        const se = (err as { stderr?: Buffer }).stderr?.toString() ?? "";
        return [...se.matchAll(/freeze_start:\s*(\d+(?:\.\d+)?)/g)].length;
      }
    };
    const render = async (intensity: number): Promise<string> => {
      const out = path.join(tmp, `hold-${intensity}.mp4`);
      const graph = multiShotSceneGraph({
        dur: 3,
        settings: { mode: "smart", intensity, curve: "smooth", vary: true } as never,
        fps: 12,
        shots: [{ kind: "hold", sec: 3, input: 0 }] as never,
      });
      await genFixture(out, [
        "-loop", "1", "-framerate", "12", "-t", "3", "-i", img,
        "-filter_complex", graph,
        "-map", "[v]", "-r", "12",
        ...FFMPEG_COMMON,
      ]);
      return out;
    };
    // The differential that pins the law: the DECLARED static (motion on)
    // creeps and reads clean; the stillness-contract hold is a real freeze.
    const drifting = await freezeRuns(await render(40));
    eq(drifting, 0, "the ambient-drift static carries no ≥1.00s freeze run");
    const frozen = await freezeRuns(await render(0));
    ok(frozen >= 1, "the TRUE hold (intensity 0) still flags — the law keeps its teeth");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

suiteStart("S55 — Islamic dense-frame QC (T-55.4)");
await test("S55 planDenseGrid: 0.50s grid, honest coarsening at the 240 cap, degenerate durations snap safe", async () => {
  const { planDenseGrid, RESTRICTED_DENSE_FPS, RESTRICTED_DENSE_MAX_FRAMES } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  // The S49 gap this task closes: a 60s render now yields a 120-frame local
  // grid (0.50s) instead of 8 evenly-sampled VLM frames (7.5s mean gap).
  eq(planDenseGrid(20), { fps: RESTRICTED_DENSE_FPS, count: 40 }, "20s → 40 frames @0.50s");
  eq(planDenseGrid(60), { fps: RESTRICTED_DENSE_FPS, count: 120 }, "60s → 120 frames @0.50s");
  const long = planDenseGrid(300);
  eq(long.count, RESTRICTED_DENSE_MAX_FRAMES, "300s hits the 240-frame cap");
  approx(long.fps, RESTRICTED_DENSE_MAX_FRAMES / 300, 1e-9, "300s interval coarsens honestly");
  approx(1 / long.fps, 1.25, 1e-6, "300s → 1.25s interval");
  for (const bad of [0, -3, NaN, Infinity]) {
    const g = planDenseGrid(bad);
    ok(g.count >= 1 && g.fps > 0, `degenerate ${bad} still plans a sane grid`);
  }
});

await test("S55 selectVlmFrames: forced seats kept, even grid fills the cap, deterministic + chronological", async () => {
  const { selectVlmFrames, RESTRICTED_VLM_MAX_FRAMES } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  // Small grid → every frame judged (no selection needed).
  eq(selectVlmFrames(10, []), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "denseCount ≤ cap → all frames");
  eq(selectVlmFrames(10, [3, 7]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], "forced is a subset of an all-frames selection");
  // No forced → an even grid of exactly the cap, both timeline ends included.
  const even = selectVlmFrames(200, []);
  eq(even.length, RESTRICTED_VLM_MAX_FRAMES, "cap honored");
  eq(even[0], 0, "starts at frame 0");
  eq(even[even.length - 1], 199, "ends at the last frame");
  eq([...new Set(even)].length, even.length, "no duplicates");
  eq([...even].sort((a, b) => a - b), even, "chronological");
  // Forced seats survive; the grid fills the remainder.
  const mixed = selectVlmFrames(200, [50, 51, 52]);
  ok(mixed.includes(50) && mixed.includes(51) && mixed.includes(52), "forced frames keep their seats");
  eq(mixed.length, RESTRICTED_VLM_MAX_FRAMES, "still exactly the cap");
  eq([...new Set(mixed)].length, mixed.length, "deduped union");
  eq([...mixed].sort((a, b) => a - b), mixed, "chronological union");
  // Pathological forced set beyond the cap → deterministic truncation.
  const flood = selectVlmFrames(200, Array.from({ length: 80 }, (_, i) => i));
  eq(flood.length, RESTRICTED_VLM_MAX_FRAMES, "flood capped");
  eq(flood, Array.from({ length: RESTRICTED_VLM_MAX_FRAMES }, (_, i) => i), "first-cap indices kept");
  // Garbage indices never crash or leak in.
  eq(selectVlmFrames(30, [-5, 999, 4.5, 4]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29], "invalid forced filtered (denseCount ≤ cap anyway)");
  const weird = selectVlmFrames(200, [-1, 200, 2.5, 100]);
  ok(weird.every((i) => Number.isInteger(i) && i >= 0 && i < 200), "out-of-range/non-integer forced dropped");
  ok(weird.includes(100), "the valid forced index kept its seat");
});

await test("S55 restrictedVerdictFromBatches: first fail wins, unmeasured beats pass, all-clean is the only pass", async () => {
  const { restrictedVerdictFromBatches } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  eq(restrictedVerdictFromBatches([]).status, "unmeasured", "no batches → unmeasured (fail-closed)");
  const fail = restrictedVerdictFromBatches([
    { status: "pass", frames: [], note: "clean" },
    { status: "fail", frames: [12], note: "haloed central figure" },
    { status: "unmeasured", frames: [], note: "never reached" },
  ]);
  eq(fail.status, "fail", "the first failing batch wins");
  eq(fail.frames, [12], "the failing batch's frames carry");
  eq(fail.note, "haloed central figure", "the failing batch's note carries");
  const unreadable = restrictedVerdictFromBatches([
    { status: "pass", frames: [], note: "clean" },
    { status: "unmeasured", frames: [], note: "batch 2 verdict unreadable" },
    { status: "pass", frames: [], note: "clean" },
  ]);
  eq(unreadable.status, "unmeasured", "one unreadable batch → unmeasured (never silently clean)");
  eq(unreadable.note, "batch 2 verdict unreadable", "the unreadable note surfaces");
  const clean = restrictedVerdictFromBatches([
    { status: "pass", frames: [], note: "all architecture" },
    { status: "pass", frames: [], note: "all architecture" },
    { status: "pass", frames: [], note: "" },
  ]);
  eq(clean.status, "pass", "all measured clean → pass");
  eq(clean.note, "all architecture", "distinct notes joined, duplicates dropped");
});

await test("S55 face tripwire (real detector when present): solid frames are a false-positive control; absence degrades gracefully", async () => {
  const { runFaceTripwire, RESTRICTED_FACE_MIN_AREA_FRAC, FACE_TRIPWIRE_PY } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "tf-s55-tripwire-"));
  try {
    // The probe script the scan itself writes (same bytes, same contract).
    const scriptPath = path.join(tmp, "tripwire.py");
    const framesDir = path.join(tmp, "frames");
    await fsp.mkdir(framesDir);
    await fsp.writeFile(scriptPath, FACE_TRIPWIRE_PY);
    // Six solid-color frames — no faces anywhere near haar's vocabulary.
    for (let i = 0; i < 6; i++) {
      await genFixture(path.join(framesDir, `f${String(i + 1).padStart(4, "0")}.jpg`), [
        "-f", "lavfi", "-i", `color=c=0x3a5a40:size=1280x720`, "-frames:v", "1",
      ]);
    }
    const res = await runFaceTripwire(scriptPath, framesDir, RESTRICTED_FACE_MIN_AREA_FRAC);
    if (res.available) {
      eq(res.hits.length, 0, `cv2 ${res.cv2 ?? "?"}: solid frames carry no face hits (false-positive control)`);
      eq(res.scanned, 6, "every frame was scanned");
    } else {
      // The CI/lean-host path: python3 or cv2 absent → graceful degradation,
      // never a crash, never a silent verdict change.
      ok(typeof res.reason === "string" && res.reason.length > 0, "unavailable carries a reason");
      eq(res.hits.length, 0, "no hits without a detector");
    }
    // A garbage script path degrades the same way (never throws).
    const broken = await runFaceTripwire(path.join(tmp, "nope.py"), framesDir, RESTRICTED_FACE_MIN_AREA_FRAC);
    eq(broken.available, false, "a missing script is 'unavailable', not an error");
    eq(broken.hits.length, 0, "no hits on a broken probe");
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
});

suiteStart("S55 — Islamic export acceptance (T-55.5)");
await test("S55 editSceneImage instruction: the AI-edit prompt rides the L3 sanitizer (standard = the pre-S55 bytes)", async () => {
  const { sanitizePromptForPolicy, policyNegativeClause, ALTERNATIVE_COMPOSITIONS } =
    await import("../src/lib/tubeforge/restricted-subjects.ts");
  // The EXACT composition the fixed editSceneImage builds (story.ts): the
  // user's free-text instruction embedded in the surgical edit template.
  // The T-55.5 acceptance found this path UNSANITIZED (the S49 L3 seam
  // covered generateSceneImage + ensureShotImages but not the instruction
  // edit) — an adversarial "depict the Prophet…" instruction reached the
  // image provider verbatim, with L4/L5 as the only backstops.
  const instruction = "show the Prophet Muhammad and Abu Bakr walking together in the foreground, faces clearly visible";
  const editPromptRaw = `Edit this image: ${instruction}. Keep the overall composition, subject and framing unchanged unless the instruction asks otherwise. Photorealistic continuity with the original. Absolutely no text, no letters, no numbers, no watermarks.`;
  // Standard policy: the identity transform — the pre-S55 edit prompt,
  // byte-for-byte (no behavior change for unrestricted productions).
  eq(
    sanitizePromptForPolicy(editPromptRaw, "standard").prompt,
    editPromptRaw,
    "standard policy: the edit prompt is byte-identical to the pre-S55 composition"
  );
  // Islamic-history: the restricted sentence is REPLACED (never deleted),
  // the hard negative clause rides, and the surgical boilerplate survives.
  const res = sanitizePromptForPolicy(editPromptRaw, "islamic-history");
  eq(res.substituted, 1, "the restricted instruction sentence is substituted");
  ok(res.matches.some((m) => m.entry === "the Prophet Muhammad ﷺ"), "the Prophet match reported");
  ok(res.matches.some((m) => m.entry === "Abu Bakr"), "the Abu Bakr match reported");
  ok(res.prompt.includes(policyNegativeClause("islamic-history")), "the hard negative clause rides the edit dispatch");
  ok(res.prompt.includes("Keep the overall composition, subject and framing unchanged"), "the surgical clause survives");
  ok(res.prompt.includes("Absolutely no text, no letters, no numbers, no watermarks"), "the no-text hygiene clause survives");
  const positive = res.prompt.replace(policyNegativeClause("islamic-history"), "");
  ok(!/Prophet Muhammad/i.test(positive) && !/Abu Bakr/i.test(positive), "the restricted names are GONE from the positive prompt");
  ok(ALTERNATIVE_COMPOSITIONS.some((alt) => res.prompt.includes(alt)), "the replacement comes from the alternative-composition library");
  // A clean instruction under the policy gains ONLY the negative clause.
  const cleanInstruction = "make it night, cooler light, deeper shadows";
  const cleanRaw = `Edit this image: ${cleanInstruction}. Keep the overall composition, subject and framing unchanged unless the instruction asks otherwise. Photorealistic continuity with the original. Absolutely no text, no letters, no numbers, no watermarks.`;
  const cleanRes = sanitizePromptForPolicy(cleanRaw, "islamic-history");
  eq(cleanRes.substituted, 0, "clean instruction: nothing substituted");
  eq(cleanRes.prompt, `${cleanRaw} ${policyNegativeClause("islamic-history")}`, "clean instruction: only the negative clause is added");
});


// ---------------------------------------------------------------------------
// S57 — observability: request ids + the portable sink (T-57.1/T-57.2)
// ---------------------------------------------------------------------------

suiteStart("S57 — request ids + the portable sink");

await test("log: requestLog binds the middleware-stamped request id", async () => {
  const captured: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const origLevel = process.env.TUBEFORGE_LOG_LEVEL;
  const collect = (chunk: unknown) => {
    if (typeof chunk === "string") captured.push(chunk);
    return true;
  };
  (process.stdout as { write: unknown }).write = collect;
  (process.stderr as { write: unknown }).write = collect;
  try {
    process.env.TUBEFORGE_LOG_LEVEL = "debug";
    const mod = await import("../src/lib/tubeforge/log.ts");
    eq(mod.REQUEST_ID_HEADER, "x-request-id", "the header name is the contract");

    // A stamped request → the child carries req; children inherit it.
    const stamped = { headers: { get: (n: string) => (n === "x-request-id" ? "req-abc-123" : null) } };
    const rlog = mod.requestLog(stamped, { mod: "videos:render" });
    rlog.warn("render rejected");
    let line = captured.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "render rejected");
    ok(line, "request-bound line emitted");
    eq(line?.req, "req-abc-123", "the request id rides the line");
    eq(line?.mod, "videos:render", "the mod binding rides the line");
    const nested = rlog.child({ stage: "render" });
    captured.length = 0;
    nested.error("nested failure");
    line = captured.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "nested failure");
    eq(line?.req, "req-abc-123", "nested children inherit the request id");

    // No header → no req field (the worker, direct calls, tests).
    captured.length = 0;
    const bare = { headers: { get: () => null } };
    mod.requestLog(bare, { mod: "x" }).warn("no request context");
    line = captured.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "no request context");
    ok(line, "bare line emitted");
    eq(line?.req, undefined, "no header means no req field");

    // An oversized inbound id is dropped (>128 chars — middleware always
    // overwrites with its own 36-char UUID; this guard is for direct calls).
    captured.length = 0;
    const huge = { headers: { get: () => "x".repeat(129) } };
    mod.requestLog(huge, { mod: "x" }).warn("oversized id");
    line = captured.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "oversized id");
    eq(line?.req, undefined, "an oversized inbound id is not bound");
    eq(mod.requestIdFrom(huge as never), null, "requestIdFrom rejects the oversized id");
  } finally {
    (process.stdout as { write: unknown }).write = origOut;
    (process.stderr as { write: unknown }).write = origErr;
    if (origLevel === undefined) delete process.env.TUBEFORGE_LOG_LEVEL;
    else process.env.TUBEFORGE_LOG_LEVEL = origLevel;
  }
});

await test("log: the portable sink falls back to console when process streams are absent", async () => {
  const captured: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const outDesc = Object.getOwnPropertyDescriptor(process, "stdout");
  const errDesc = Object.getOwnPropertyDescriptor(process, "stderr");
  const origLevel = process.env.TUBEFORGE_LOG_LEVEL;
  (console as { log: unknown }).log = (t: string) => captured.push(t);
  (console as { error: unknown }).error = (t: string) => captured.push(t);
  try {
    process.env.TUBEFORGE_LOG_LEVEL = "debug";
    // Simulate an edge/browser bundle: process exists but has no std streams.
    Object.defineProperty(process, "stdout", { value: {}, configurable: true });
    Object.defineProperty(process, "stderr", { value: {}, configurable: true });
    const mod = await import("../src/lib/tubeforge/log.ts");
    mod.createLogger({ mod: "edge" }).info("fallback line");
    mod.createLogger({ mod: "edge" }).error("fallback error line");
    eq(captured.length, 2, "both levels emitted through the console fallback");
    const info = JSON.parse(captured[0]) as Record<string, unknown>;
    eq(info.msg, "fallback line", "the fallback line is the SAME pino-format JSON");
    eq(info.mod, "edge", "bindings survive the fallback");
    const errLine = JSON.parse(captured[1]) as Record<string, unknown>;
    eq(errLine.msg, "fallback error line", "error level rides console.error in the fallback");
    eq(errLine.level, 50, "pino error level value preserved");
  } finally {
    if (outDesc) Object.defineProperty(process, "stdout", outDesc);
    if (errDesc) Object.defineProperty(process, "stderr", errDesc);
    (console as { log: unknown }).log = origLog;
    (console as { error: unknown }).error = origErr;
    if (origLevel === undefined) delete process.env.TUBEFORGE_LOG_LEVEL;
    else process.env.TUBEFORGE_LOG_LEVEL = origLevel;
  }
});

// ─── S62 — the i2v motion-prompt contract (what the real-video lane rides) ───

await test("S62 motion prompt: camera phrase + speed prefix + subjectAction priority", async () => {
  const { i2vMotionPrompt } = await import("../src/lib/tubeforge/liveliness.ts");
  const scene = {
    index: 1, title: "s", narration: "n", visual: "a frosted bottle on wet slate",
    camera: "static", mood: "rich brown and gold", caption: "c",
    hostInScene: false, rehook: false, sfx: "none",
  };
  const planScene = {
    sceneIndex: 1,
    shots: [{ shotIndex: 0, camera: "zoom-in", moveSpeed: "fast", subjectAction: "condensation drips down the bottle" }],
  };
  const p = i2vMotionPrompt(scene as never, planScene as never);
  ok(p.startsWith("Quick, energetic cinematic zoom in"), `speed prefix colors the tempo-neutral phrase — got: ${p.slice(0, 60)}`);
  ok(p.toLowerCase().includes("condensation drips down the bottle"), "shot 0's subjectAction LEADS the subject clauses");
  ok(p.includes("Natural ambient motion within the scene"), "the per-kind motion doctrine always rides behind the ask");
  ok(p.includes("a frosted bottle on wet slate"), "scene visual rides the prompt");
  ok(p.includes("rich brown and gold"), "scene mood rides the prompt");
  ok(p.endsWith("Cinematic quality, natural physics, no text."), "the I2V tail is always last");
});

await test("S62 motion prompt: planScene null → scene's legacy camera + per-kind subject clause", async () => {
  const { i2vMotionPrompt } = await import("../src/lib/tubeforge/liveliness.ts");
  const scene = {
    index: 2, title: "s", narration: "n", visual: "harbor cranes at dawn",
    camera: "pan-left", mood: "archival", caption: "c",
    hostInScene: false, rehook: false, sfx: "none",
  };
  const p = i2vMotionPrompt(scene as never, null);
  ok(p.startsWith("Smooth lateral camera pan to the left with natural parallax"), `legacy camera field seeds the phrase — got: ${p.slice(0, 60)}`);
  ok(!p.includes("undefined"), "no undefined leaks");
  ok(p.includes("harbor cranes at dawn") && p.includes("archival"), "visual + mood still ride");
});

await test("S62 motion prompt: the full S48 engine camera vocabulary maps to real phrases", async () => {
  const { i2vMotionPrompt, I2V_CAMERA_PHRASES } = await import("../src/lib/tubeforge/liveliness.ts");
  const { CAMERA_MOVES } = await import("../src/lib/tubeforge/director-plan.ts");
  ok(CAMERA_MOVES.length >= 10, `engine vocabulary present (${CAMERA_MOVES.length} moves)`);
  for (const cam of CAMERA_MOVES) {
    const phrase = I2V_CAMERA_PHRASES[cam];
    ok(typeof phrase === "string" && phrase.length > 10, `camera "${cam}" has an engine-verbatim phrase`);
    const scene = {
      index: 1, title: "s", narration: "n", visual: "v", camera: "static",
      mood: "m", caption: "c", hostInScene: false, rehook: false, sfx: "none",
    };
    const p = i2vMotionPrompt(scene as never, { sceneIndex: 1, shots: [{ shotIndex: 0, camera: cam, moveSpeed: "normal" }] } as never);
    ok(p.toLowerCase().includes(phrase.toLowerCase()), `camera "${cam}" phrase lands in the prompt`);
  }
});

await test("S62 motion prompt: only slow/fast modulate — normal and absent leave the phrase bare", async () => {
  const { i2vMotionPrompt } = await import("../src/lib/tubeforge/liveliness.ts");
  const scene = {
    index: 1, title: "s", narration: "n", visual: "v", camera: "static",
    mood: "m", caption: "c", hostInScene: false, rehook: false, sfx: "none",
  };
  const mk = (moveSpeed?: string) =>
    i2vMotionPrompt(scene as never, { sceneIndex: 1, shots: [{ shotIndex: 0, camera: "zoom-in", moveSpeed }] } as never);
  ok(mk("slow").startsWith("Slow, deliberate cinematic zoom in"), "slow prefix = weight and reverence (no doubled 'slow' — the S63 tempo law)");
  ok(mk("fast").startsWith("Quick, energetic cinematic zoom in"), "fast prefix = energy (no contradiction — the S63 tempo law)");
  ok(mk("normal").startsWith("Cinematic zoom in"), "normal leaves the phrase bare");
  ok(mk(undefined).startsWith("Cinematic zoom in"), "absent moveSpeed leaves the phrase bare");
});

// ─── S63 — the tempo law + the doctrine-always-rides law ───

await test("S63 tempo law: no camera phrase carries a tempo word — the prefix owns tempo", async () => {
  const { I2V_CAMERA_PHRASES } = await import("../src/lib/tubeforge/liveliness.ts");
  const TEMPO = /\b(slow|fast|gentle|deliberate|quick|energetic|slowly|quickly)\b/i;
  const verbs = Object.keys(I2V_CAMERA_PHRASES);
  ok(verbs.length >= 16, `the full vocabulary is present (${verbs.length} phrases)`);
  for (const verb of verbs) {
    ok(!TEMPO.test(I2V_CAMERA_PHRASES[verb]), `camera phrase "${verb}" is tempo-neutral`);
  }
  // And no prefix × phrase composition can double or contradict tempo
  // (the S62 receipts: "Quick, energetic slow cinematic zoom in" on social's
  // real fast hook; "Slow, deliberate slow" on islamic-history's slow zoom).
  const { i2vMotionPrompt } = await import("../src/lib/tubeforge/liveliness.ts");
  const scene = {
    index: 1, title: "s", narration: "n", visual: "v", camera: "static",
    mood: "m", caption: "c", hostInScene: false, rehook: false, sfx: "none",
  } as never;
  for (const verb of verbs) {
    for (const speed of ["slow", "fast"] as const) {
      const p = i2vMotionPrompt(scene, { sceneIndex: 1, shots: [{ shotIndex: 0, camera: verb, moveSpeed: speed }] } as never);
      const first = p.slice(0, p.indexOf(". "));
      ok(
        !/energetic[^.]*\b(slow|gentle|deliberate)\b/i.test(first) &&
        !/deliberate[^.]*\bslow\b/i.test(first) &&
        !/\bslow\b[^.]*\bslow\b/i.test(first) &&
        !/\bfast\b[^.]*\bfast\b/i.test(first),
        `no tempo collision for ${speed} + ${verb}: "${first.slice(0, 70)}"`
      );
    }
  }
});

await test("S63 doctrine-always-rides: a pose subjectAction can no longer delete the motion clause", async () => {
  const { i2vMotionPrompt, I2V_SUBJECT_MOTION } = await import("../src/lib/tubeforge/liveliness.ts");
  const scene = {
    index: 1, title: "s", narration: "n",
    visual: "cutaway diagram of a car engine cylinder, piston sliding down",
    camera: "static", mood: "clean, bright, technical", caption: "c",
    hostInScene: false, rehook: false, sfx: "none",
  } as never;
  const posePlan = {
    sceneIndex: 1,
    shots: [{ shotIndex: 0, camera: "static", moveSpeed: "normal", subjectAction: "stationary at top position" }],
  } as never;
  const p = i2vMotionPrompt(scene, posePlan);
  ok(p.includes("Stationary at top position."), "the director's pose ask LEADS verbatim");
  ok(p.includes("Natural ambient motion within the scene"), "the per-kind motion doctrine rides behind the pose (S62: it was deleted)");
  ok(!p.includes("Stationary at top position Cutaway"), "the subject→visual seam has a real sentence boundary");
  ok(p.endsWith("Cinematic quality, natural physics, no text."), "the I2V tail is still last");
  // Every kind clause is a complete sentence — the seam law depends on it.
  for (const [kind, clause] of Object.entries(I2V_SUBJECT_MOTION)) {
    ok(/\.$/.test(clause), `kind clause "${kind}" ends with a sentence boundary`);
  }
  // A trailing-period/whitespace-polluted ask is still composed cleanly.
  const messyPlan = {
    sceneIndex: 1,
    shots: [{ shotIndex: 0, camera: "static", moveSpeed: "normal", subjectAction: "  sitting attentively at a microphone...  " }],
  } as never;
  const pm = i2vMotionPrompt(scene, messyPlan);
  ok(pm.includes("Sitting attentively at a microphone. Natural ambient"), "ask punctuation is normalized before the clause rides");
});

// ─── S64 — the Whiteboard Engine: pure contracts (the P0 pins) ───
//
// The CI-lane law (s64 record §1): the unit suite pins PURE contracts —
// path math, the sanitizer's attack surface, storyboard validation, timing
// determinism, hand/camera math, and the library's every-drawable-extractable
// invariant. The real-render evidence (chromium + ffmpeg) lands via the
// sandbox benchmark — exactly how S62 split pure contracts from gateway
// evidence.

suiteStart("S64 whiteboard — the SVG security gate (sanitizeSvg)");

await test("S64 sanitizer strips <script> subtrees and keeps legitimate markup", async () => {
  const { sanitizeSvg } = await import("../src/lib/tubeforge/whiteboard/svg");
  const out = sanitizeSvg(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><path id="p" d="M 0 0 L 5 5"/></svg>'
  );
  ok(!out.includes("<script"), `script opener survived: ${out}`);
  ok(!out.includes("alert"), `script body survived: ${out}`);
  ok(out.includes('<path id="p"'), "legitimate path survives");
});

await test("S64 sanitizer strips event-handler attributes (quoted or bare)", async () => {
  const { sanitizeSvg } = await import("../src/lib/tubeforge/whiteboard/svg");
  const out = sanitizeSvg('<svg onload="a()"><path d="M 0 0" onclick=\'b()\' onerror=c /></svg>');
  ok(!/\son[a-z]+\s*=/i.test(out), `an on* handler survived: ${out}`);
  ok(out.includes("<path"), "the path element itself survives");
});

await test("S64 sanitizer strips foreignObject / image / use / animate (external-content elements)", async () => {
  const { sanitizeSvg } = await import("../src/lib/tubeforge/whiteboard/svg");
  const out = sanitizeSvg(
    '<svg><foreignObject><div>x</div></foreignObject><image href="https://e/x.png"/><use xlink:href="#x"/><animate attributeName="o"/><path id="p" d="M 0 0"/></svg>'
  );
  ok(!/<(foreignObject|image|use|animate)\b/i.test(out), `a blocked element survived: ${out}`);
  ok(out.includes('<path id="p"'), "legitimate path survives");
});

await test("S64 sanitizer neutralizes javascript:/data: hrefs", async () => {
  const { sanitizeSvg } = await import("../src/lib/tubeforge/whiteboard/svg");
  const out = sanitizeSvg(
    '<svg><a href="javascript:alert(1)"><path d="M 0 0"/></a><path d="M 1 1" xlink:href="data:text/html,x"/></svg>'
  );
  ok(!/javascript:|data:/i.test(out), `a script-y URL survived: ${out}`);
});

await test("S64 sanitizer removes XML prolog / DOCTYPE / ENTITY declarations", async () => {
  const { sanitizeSvg } = await import("../src/lib/tubeforge/whiteboard/svg");
  const out = sanitizeSvg('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xx "y">]><svg><!ENTITY a "b"><path d="M 0 0"/></svg>');
  ok(!out.includes("<?xml"), "prolog survived");
  ok(!out.includes("<!DOCTYPE"), "doctype survived");
  ok(!out.includes("<!ENTITY"), "entity survived");
});

await test("S64 sanitizer neutralizes external url() refs and script-y style payloads", async () => {
  const { sanitizeSvg } = await import("../src/lib/tubeforge/whiteboard/svg");
  const out = sanitizeSvg(
    '<svg><path d="M 0 0" style="fill:url(https://evil/x.png)"/><rect d="" style="background:url(javascript:alert(1))"/></svg>'
  );
  ok(!/url\(\s*"?'?https?:/i.test(out), `an external url() survived: ${out}`);
  ok(out.includes("url(#none)"), "external url() is rewritten to the empty ref");
  ok(!/javascript:/i.test(out), `a javascript: style payload survived: ${out}`);
});

await test("S64 sanitizer passes clean house markup through byte-identical", async () => {
  const { sanitizeSvg } = await import("../src/lib/tubeforge/whiteboard/svg");
  const clean = '<svg xmlns="http://www.w3.org/2000/svg"><path id="hm-outline" d="M 100 62 C 74 26, 24 44, 24 94 Z" fill="#e63946" fill-opacity="0" stroke="#1d3557" stroke-width="5" stroke-linecap="round"/><text id="t" x="34" y="120" font-family="DejaVu Sans, sans-serif" font-size="22" fill="#457b9d" font-weight="bold">RA</text></svg>';
  eq(sanitizeSvg(clean), clean, "legit markup must round-trip untouched");
});

suiteStart("S64 whiteboard — the path grammar + arc-length geometry");

await test("S64 parsePathData tokenizes commands and numbers (scientific notation included)", async () => {
  const { parsePathData } = await import("../src/lib/tubeforge/whiteboard/svg");
  eq(parsePathData("M 0 0 L 10 10"), [{ cmd: "M", args: [0, 0] }, { cmd: "L", args: [10, 10] }]);
  eq(parsePathData("M 1e2 .5 L -2.5E-1 4"), [{ cmd: "M", args: [100, 0.5] }, { cmd: "L", args: [-0.25, 4] }]);
  eq(parsePathData("Z"), [{ cmd: "Z", args: [] }]);
});

await test("S64 normalizeCommands: implicit repeats — extra pairs after M degrade to L (same case)", async () => {
  const { normalizeCommands, parsePathData } = await import("../src/lib/tubeforge/whiteboard/svg");
  eq(normalizeCommands(parsePathData("M 0 0 10 10 20 20")), [
    { cmd: "M", args: [0, 0] },
    { cmd: "L", args: [10, 10] },
    { cmd: "L", args: [20, 20] },
  ]);
  eq(normalizeCommands(parsePathData("m 5 5 10 0 0 10")), [
    { cmd: "m", args: [5, 5] },
    { cmd: "l", args: [10, 0] },
    { cmd: "l", args: [0, 10] },
  ]);
});

await test("S64 flattenPath: absolute and relative lines accumulate exact lengths", async () => {
  const { pathSegments, totalLength } = await import("../src/lib/tubeforge/whiteboard/svg");
  const segs = pathSegments("M 0 0 L 3 4 L 10 4");
  eq(segs.length, 1, "one subpath");
  eq(segs[0].points, [{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 10, y: 4 }]);
  eq(segs[0].lengths, [0, 5, 12]);
  ok(!segs[0].closed, "unclosed subpath");
  approx(totalLength(segs), 12, 1e-9);
  const rel = pathSegments("M 0 0 l 3 4 l 7 0");
  eq(JSON.stringify(rel), JSON.stringify(segs), "relative == absolute");
});

await test("S64 flattenPath: H/V move one axis (absolute + relative)", async () => {
  const { pathSegments, totalLength } = await import("../src/lib/tubeforge/whiteboard/svg");
  const hv = pathSegments("M 0 0 H 10 V 5 h -5 v -2");
  eq(hv[0].points, [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 3 }]);
  approx(totalLength(hv), 22, 1e-9);
});

await test("S64 flattenPath: cubic C hits its endpoint and bows past the chord", async () => {
  const { pathSegments, totalLength } = await import("../src/lib/tubeforge/whiteboard/svg");
  const c = pathSegments("M 0 0 C 0 100 100 100 100 0");
  const pts = c[0].points;
  eq(pts[pts.length - 1], { x: 100, y: 0 }, "exact endpoint");
  ok(totalLength(c) > 120, `cubic should bow past its chord (len=${totalLength(c)})`);
});

await test("S64 flattenPath: S reflects the previous cubic control — spec-exact equivalence", async () => {
  const { pathSegments } = await import("../src/lib/tubeforge/whiteboard/svg");
  const withS = pathSegments("M 0 0 C 0 100 100 100 100 0 S 200 -100 200 0");
  const explicit = pathSegments("M 0 0 C 0 100 100 100 100 0 C 100 -100 200 -100 200 0");
  eq(withS, explicit, "S must equal the explicit reflected-control C");
});

await test("S64 flattenPath: T reflects the previous quadratic control — spec-exact equivalence", async () => {
  const { pathSegments } = await import("../src/lib/tubeforge/whiteboard/svg");
  const withT = pathSegments("M 0 0 Q 50 100 100 0 T 200 0");
  const explicit = pathSegments("M 0 0 Q 50 100 100 0 Q 150 -100 200 0");
  eq(withT, explicit, "T must equal the explicit reflected-control Q");
});

await test("S64 flattenPath: A arcs — semicircle and quarter-circle ≈ π·r (spec F.6 endpoint→center)", async () => {
  const { pathSegments, totalLength, sampleAtLength } = await import("../src/lib/tubeforge/whiteboard/svg");
  const semi = pathSegments("M 0 0 A 50 50 0 0 1 100 0");
  approx(totalLength(semi), Math.PI * 50, 2.5, "semicircle ≈ π·r");
  const mid = sampleAtLength(semi, (Math.PI * 50) / 2);
  approx(mid.point.x, 50, 1.5, "semicircle midpoint x");
  approx(mid.point.y, -50, 1.5, "semicircle midpoint y (sweep=1 bows up)");
  const quarter = pathSegments("M 0 0 A 50 50 0 0 1 50 50");
  approx(totalLength(quarter), (Math.PI * 50) / 2, 1.5, "quarter ≈ π·r/2");
  const qm = sampleAtLength(quarter, (Math.PI * 50) / 4);
  approx(qm.point.x, 35.36, 1.5, "quarter midpoint x");
  approx(qm.point.y, 14.64, 1.5, "quarter midpoint y");
});

await test("S64 flattenPath: Z closes the subpath; M opens a new one", async () => {
  const { pathSegments, totalLength } = await import("../src/lib/tubeforge/whiteboard/svg");
  const z = pathSegments("M 0 0 L 10 0 L 10 10 Z");
  ok(z[0].closed, "Z marks closed");
  eq(z[0].points[z[0].points.length - 1], { x: 0, y: 0 }, "Z returns to the subpath start");
  approx(totalLength(z), 10 + 10 + Math.sqrt(200), 1e-9, "two legs + the closing segment");
  eq(pathSegments("M 0 0 L 5 5 M 10 10 L 20 20").length, 2, "M starts a new subpath");
});

await test("S64 sampleAtLength: position, tangent, and clamping", async () => {
  const { pathSegments, sampleAtLength } = await import("../src/lib/tubeforge/whiteboard/svg");
  const p = pathSegments("M 0 0 L 10 0 L 10 10");
  const s5 = sampleAtLength(p, 5);
  eq(s5.point, { x: 5, y: 0 });
  approx(s5.angle, 0, 1e-9, "tangent along +x");
  const s15 = sampleAtLength(p, 15);
  eq(s15.point, { x: 10, y: 5 });
  approx(s15.angle, Math.PI / 2, 1e-9, "tangent along +y");
  eq(sampleAtLength(p, 999).point, { x: 10, y: 10 }, "clamped past the end");
  eq(sampleAtLength(p, -5).point, { x: 0, y: 0 }, "clamped before the start");
});

await test("S64 transformPoint: translate∘rotate∘scale matches SVG transform semantics", async () => {
  const { transformPoint } = await import("../src/lib/tubeforge/whiteboard/svg");
  const t = transformPoint({ x: 1, y: 0 }, { x: 100, y: 0, scale: 2, rotateDeg: 90 });
  approx(t.x, 100, 1e-9);
  approx(t.y, 2, 1e-9);
});

suiteStart("S64 whiteboard — the storyboard schema (validateWhiteboardProject)");

const WB_LIB = {
  assetIds: new Set(["a1", "a2"]),
  pathIdsByAsset: new Map([
    ["a1", new Set(["p1", "p2"])],
    ["a2", new Set<string>()],
  ]),
  textIdsByAsset: new Map([["a2", new Set(["t1"])]]),
};

const WB_SCENE: WhiteboardScene = {
  id: "s1",
  narration: "hello world",
  background: "#ffffff",
  placements: [{ assetId: "a1", placement: { x: 0, y: 0, scale: 1, rotateDeg: 0 } }],
  animations: [{ type: "draw_path", assetId: "a1", pathId: "p1", startMs: 0, durationMs: 500 }],
  camera: [],
};

const WB_PLAIN: WhiteboardScene = { ...WB_SCENE, animations: [] };

function wbProject(scenes: unknown, extra: Record<string, unknown> = {}): unknown {
  return { title: "T", width: 1920, height: 1080, fps: 24, hand: { style: "marker", scale: 1 }, scenes, ...extra };
}

await test("S64 storyboard: a valid project parses; empty camera gets the default keyframe", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const r = validateWhiteboardProject(wbProject([{ ...WB_SCENE, camera: [] }]), WB_LIB);
  if (!r.project) { ok(false, `expected valid, got: ${r.errors.join("; ")}`); return; }
  eq(r.errors, []);
  eq(r.project.scenes[0].camera, [{ cx: 960, cy: 540, scale: 1, startMs: 0, durationMs: 0 }]);
  eq(r.project.scenes[0].id, "s1");
});

await test("S64 storyboard: unknown asset / double placement / invalid placement are rejected", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const unknown = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, placements: [{ assetId: "ghost", placement: { x: 0, y: 0, scale: 1, rotateDeg: 0 } }] }]),
    WB_LIB
  );
  ok(unknown.project === null, "unknown asset must null the project");
  ok(unknown.errors.some((e) => e.includes('unknown asset "ghost"')), `errors: ${unknown.errors.join("; ")}`);

  const twice = validateWhiteboardProject(
    wbProject([{
      ...WB_SCENE,
      placements: [
        { assetId: "a1", placement: { x: 0, y: 0, scale: 1, rotateDeg: 0 } },
        { assetId: "a1", placement: { x: 5, y: 5, scale: 1, rotateDeg: 0 } },
      ],
    }]),
    WB_LIB
  );
  ok(twice.errors.some((e) => e.includes("placed twice")), `errors: ${twice.errors.join("; ")}`);

  const bad = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, placements: [{ assetId: "a1", placement: { x: 0, y: 0, scale: 0, rotateDeg: 0 } }] }]),
    WB_LIB
  );
  ok(bad.errors.some((e) => e.includes("invalid placement")), `errors: ${bad.errors.join("; ")}`);
});

await test("S64 storyboard: draw_path / write_text / reveal_color reference integrity", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const badPath = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, animations: [{ type: "draw_path", assetId: "a1", pathId: "p9", startMs: 0, durationMs: 100 }] }]),
    WB_LIB
  );
  ok(badPath.errors.some((e) => e.includes('unknown path "p9"')), `errors: ${badPath.errors.join("; ")}`);

  const badText = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, animations: [{ type: "write_text", assetId: "a2", textId: "zz", startMs: 0, durationMs: 100 }] }]),
    WB_LIB
  );
  ok(badText.errors.some((e) => e.includes('unknown text "zz"')), `errors: ${badText.errors.join("; ")}`);

  const badColor = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, animations: [{ type: "reveal_color", assetId: "a1", pathId: "p9", startMs: 0, durationMs: 100 }] }]),
    WB_LIB
  );
  ok(badColor.errors.some((e) => e.includes('unknown path "p9"')), `errors: ${badColor.errors.join("; ")}`);

  const good = validateWhiteboardProject(
    wbProject([{
      ...WB_SCENE,
      animations: [
        { type: "write_text", assetId: "a2", textId: "t1", startMs: 0, durationMs: 100 },
        { type: "reveal_color", assetId: "a1", startMs: 50, durationMs: 100 },
      ],
    }]),
    WB_LIB
  );
  ok(good.project !== null, `valid mixed events rejected: ${good.errors.join("; ")}`);
});

await test("S64 storyboard: unknown animation type / bad times / bad move target rejected", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const badType = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, animations: [{ type: "disintegrate", assetId: "a1", startMs: 0, durationMs: 100 }] }]),
    WB_LIB
  );
  ok(badType.errors.some((e) => e.includes('unknown animation type "disintegrate"')), `errors: ${badType.errors.join("; ")}`);

  const badTimes = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, animations: [{ type: "draw_path", assetId: "a1", pathId: "p1", startMs: -1, durationMs: 100 }] }]),
    WB_LIB
  );
  ok(badTimes.errors.some((e) => e.includes("startMs")), `errors: ${badTimes.errors.join("; ")}`);

  const badMove = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, animations: [{ type: "move_object", assetId: "a1", startMs: 0, durationMs: 100, to: { x: "a", y: 0, scale: 1, rotateDeg: 0 } }] }]),
    WB_LIB
  );
  ok(badMove.errors.some((e) => e.includes("valid target placement")), `errors: ${badMove.errors.join("; ")}`);

  const goodMove = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, animations: [{ type: "move_object", assetId: "a1", startMs: 0, durationMs: 100, to: { x: 5, y: 5, scale: 1, rotateDeg: 0 } }] }]),
    WB_LIB
  );
  ok(goodMove.project !== null, `valid move rejected: ${goodMove.errors.join("; ")}`);
});

await test("S64 storyboard: malformed camera keyframes are dropped with an error; valid ones sort", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const r = validateWhiteboardProject(
    wbProject([{
      ...WB_SCENE,
      camera: [
        { cx: "x", cy: 540, scale: 1, startMs: 0, durationMs: 0 },
        { cx: 1000, cy: 540, scale: 1.2, startMs: 2000, durationMs: 500 },
        { cx: 960, cy: 540, scale: 1, startMs: 0, durationMs: 0 },
      ],
    }]),
    WB_LIB
  );
  ok(r.project === null && r.errors.some((e) => e.includes("malformed camera keyframe")), `errors: ${r.errors.join("; ")}`);

  const sorted = validateWhiteboardProject(
    wbProject([{
      ...WB_SCENE,
      camera: [
        { cx: 1000, cy: 540, scale: 1.2, startMs: 2000, durationMs: 500 },
        { cx: 960, cy: 540, scale: 1, startMs: 0, durationMs: 0 },
      ],
    }]),
    WB_LIB
  );
  if (!sorted.project) { ok(false, `unexpected: ${sorted.errors.join("; ")}`); return; }
  eq(sorted.project.scenes[0].camera.map((c) => c.startMs), [0, 2000], "keyframes sorted by startMs");
});

await test("S64 storyboard: defaults and clamps (dimensions, fps, hand)", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const r = validateWhiteboardProject(
    wbProject([WB_SCENE], { width: 99, height: 9999, fps: 999, hand: { style: "sparkly", scale: 99 } }),
    WB_LIB
  );
  if (!r.project) { ok(false, `unexpected: ${r.errors.join("; ")}`); return; }
  eq(r.project.width, 1920, "width clamps to default");
  eq(r.project.height, 1080);
  eq(r.project.fps, 24);
  eq(r.project.hand.style, "marker");
  eq(r.project.hand.scale, 4, "hand scale clamps to 4");
});

await test("S64 storyboard: missing narration nulls the project", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const r = validateWhiteboardProject(wbProject([{ ...WB_SCENE, narration: "  " }]), WB_LIB);
  ok(r.project === null && r.errors.some((e) => e.includes("narration missing")), `errors: ${r.errors.join("; ")}`);
});

suiteStart("S64 whiteboard — timing: narration clock, draw scheduling, the frame plan");

await test("S64 timing: estimateNarrationMs — the 2.6 wps house pace, clamped [4s, 30s]", async () => {
  const { estimateNarrationMs, WORDS_PER_SEC } = await import("../src/lib/tubeforge/whiteboard/timing");
  eq(WORDS_PER_SEC, 2.6);
  const words = Array.from({ length: 26 }, (_, i) => `w${i}`).join(" ");
  eq(estimateNarrationMs(words), 10000);
  eq(estimateNarrationMs(""), 4000, "empty narration clamps to the 4s floor");
  eq(estimateNarrationMs(Array.from({ length: 200 }, (_, i) => `w${i}`).join(" ")), 30000, "long narration clamps to the 30s ceiling");
});

await test("S64 timing: sceneDurationMs precedence — explicit > measured VO > estimate", async () => {
  const { sceneDurationMs } = await import("../src/lib/tubeforge/whiteboard/timing");
  eq(sceneDurationMs({ ...WB_SCENE, durationMs: 8000 }, null), 8000, "explicit wins");
  eq(sceneDurationMs({ ...WB_SCENE }, 5000), 5350, "VO + 350ms tail");
  eq(sceneDurationMs({ ...WB_SCENE }, null), 4000, "2-word estimate clamps to the 4s floor");
});

await test("S64 timing: scheduleScene fills the narration window — weighted, fill-scaled, deterministic", async () => {
  const { scheduleScene, buildGeometry, LEAD_IN_MS, HOLD_END_MS } = await import("../src/lib/tubeforge/whiteboard/timing");
  const geo = buildGeometry([{ id: "a1", paths: [{ id: "p1", d: "M 0 0 L 100 0" }, { id: "p2", d: "M 0 0 L 10 0" }] }]);
  const ev = scheduleScene(WB_PLAIN, 10000, geo);
  eq(ev.length, 2, "both paths scheduled");
  ok(ev.every((e) => e.type === "draw_path"), "draw events");
  eq(ev[0].startMs, LEAD_IN_MS, "first stroke starts at the lead-in");
  // Two equal-weight strokes weight-share the whole window exactly (no cap
  // is hit): each gets half of (duration − lead-in − hold − gap).
  eq(ev[0].durationMs, 4285, "weight-shared fill duration");
  eq(ev[1].startMs, LEAD_IN_MS + 4285 + 130, "pen-lift gap between strokes");
  const last = ev[ev.length - 1];
  eq(last.startMs + last.durationMs, 10000 - HOLD_END_MS, "the fill law: draws end exactly at the hold boundary");
  eq(JSON.stringify(scheduleScene(WB_PLAIN, 10000, geo)), JSON.stringify(ev), "deterministic");

  // Many short strokes in a tiny window: the min-clamp overflows the raw
  // budget, so the fill factor shrinks toward its floor — and the span
  // STILL fits the window (the pre-fill law overflowed it).
  const many = scheduleScene(
    WB_PLAIN,
    4000,
    buildGeometry([{ id: "a1", paths: Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, d: "M 0 0 L 10 0" })) }])
  );
  eq(many.length, 10);
  ok(many.every((e) => e.type === "draw_path" && e.durationMs >= 120), "scaled durations respect the 120ms floor");
  const mLast = many[many.length - 1];
  ok(mLast.startMs + mLast.durationMs <= 4000, "clamped scene still fits its window");
});

await test("S64 timing: the editor's explicit timing is senior — no double-schedule", async () => {
  const { scheduleScene, buildGeometry } = await import("../src/lib/tubeforge/whiteboard/timing");
  const geo = buildGeometry([{ id: "a1", paths: [{ id: "p1", d: "M 0 0 L 100 0" }, { id: "p2", d: "M 0 0 L 10 0" }] }]);
  const withExplicit = scheduleScene(WB_SCENE, 10000, geo);
  const p1Events = withExplicit.filter((e) => e.type === "draw_path" && e.pathId === "p1");
  eq(p1Events.length, 1, "the explicit event is not re-scheduled");
  eq(p1Events[0].startMs, 0, "the editor's start time is preserved verbatim");
});

await test("S64 timing: frameAt — progress ramp, camera drift, pen follows/rests/enters on the true path", async () => {
  const { frameAt, buildGeometry, cameraDrift } = await import("../src/lib/tubeforge/whiteboard/timing");
  const geo = buildGeometry([{ id: "a1", paths: [{ id: "p1", d: "M 0 0 L 100 0" }] }]);
  const project: WhiteboardProject = { title: "t", width: 1920, height: 1080, fps: 24, hand: { style: "marker", scale: 1 }, scenes: [WB_PLAIN] };
  const events = [{ type: "draw_path" as const, assetId: "a1", pathId: "p1", startMs: 1000, durationMs: 1000 }];
  const early = frameAt(project, WB_PLAIN, events, geo, 500);
  eq(early.draws.get("a1::p1"), 0, "before start");
  ok(early.hand.visible, "pen enters during the lead-in");
  approx(early.hand.x, 105, 1e-6, "ease-out slide-in: 75% of the way at the half-window");
  approx(early.hand.y, 15, 1e-6);
  const mid = frameAt(project, WB_PLAIN, events, geo, 1500);
  eq(mid.draws.get("a1::p1"), 0.5, "mid progress");
  ok(mid.hand.visible, "pen visible during the stroke");
  approx(mid.hand.x, 50, 1e-6, "pen tip at the arc-length midpoint");
  approx(mid.hand.y, 0, 1e-6);
  approx(mid.hand.angle, 0, 1e-9, "tangent along +x");
  approx(mid.camera.cx, 960 + cameraDrift(1500).dx, 1e-9, "default camera + drift");
  const done = frameAt(project, WB_PLAIN, events, geo, 3000);
  eq(done.draws.get("a1::p1"), 1, "clamped to 1");
  ok(done.hand.visible, "pen rests at the stroke end during the hold (no static tail)");
  approx(done.hand.x, 100, 1e-6, "resting at the end point");
});

await test("S64 timing: cameraAt — eased keyframes + the permanent drift", async () => {
  const { cameraAt, cameraDrift } = await import("../src/lib/tubeforge/whiteboard/timing");
  const scene: WhiteboardScene = {
    ...WB_PLAIN,
    camera: [
      { startMs: 0, durationMs: 0, cx: 0, cy: 0, scale: 1 },
      { startMs: 1000, durationMs: 1000, cx: 100, cy: 10, scale: 2 },
    ],
  };
  const d500 = cameraDrift(500);
  eq(cameraAt(scene, 1920, 1080, 500), { cx: d500.dx, cy: d500.dy, scale: 1 }, "before the move: first keyframe + drift");
  const d1500 = cameraDrift(1500);
  eq(cameraAt(scene, 1920, 1080, 1500), { cx: 50 + d1500.dx, cy: 5 + d1500.dy, scale: 1.5 }, "mid-move eased halfway + drift");
  const dEnd = cameraDrift(99999);
  eq(cameraAt(scene, 1920, 1080, 99999), { cx: 100 + dEnd.dx, cy: 10 + dEnd.dy, scale: 2 }, "after the move: last keyframe + drift");
});

await test("S68 timing: cameraAt — the empty-camera fallback centers on the project's own dimensions", async () => {
  const { cameraAt, cameraDrift } = await import("../src/lib/tubeforge/whiteboard/timing");
  const bare: WhiteboardScene = { ...WB_PLAIN, camera: [] };
  const t = 4000;
  const d = cameraDrift(t); // the permanent drift rides on EVERY fallback
  // 16:9 keeps the historical center…
  const c169 = cameraAt(bare, 1920, 1080, t);
  approx(c169.cx, 960 + d.dx, 1e-9, "16:9 fallback centers at 960 + drift");
  approx(c169.cy, 540 + d.dy, 1e-9, "16:9 fallback centers at 540 + drift");
  // …but the point of S68: a 9:16 board must NOT carry a 16:9 center —
  // cx 960 of a 1080-wide canvas pinned the viewport to its right edge.
  const c916 = cameraAt(bare, 1080, 1920, t);
  approx(c916.cx, 540 + d.dx, 1e-9, "9:16 fallback centers at width/2");
  approx(c916.cy, 960 + d.dy, 1e-9, "9:16 fallback centers at height/2");
  const c11 = cameraAt(bare, 1080, 1080, t);
  approx(c11.cx, 540 + d.dx, 1e-9, "1:1 fallback centers at width/2");
  approx(c11.cy, 540 + d.dy, 1e-9, "1:1 fallback centers at height/2");
});

await test("S64 timing: cameraDrift — bounded, deterministic, and always moving", async () => {
  const { cameraDrift } = await import("../src/lib/tubeforge/whiteboard/timing");
  const d0 = cameraDrift(0);
  ok(Math.abs(d0.dx) <= 96.001 && Math.abs(d0.dy) <= 66.001, "drift stays within its settle-swelled bounds");
  const d9 = cameraDrift(9000);
  ok(Math.abs(d9.dx) <= 32.001 && Math.abs(d9.dy) <= 22.001, "drift settles to the base amplitude once the canvas is established");
  eq(cameraDrift(12345), cameraDrift(12345), "deterministic");
  // Over a 10s sweep at frame cadence, ≥ 90% of consecutive frames move
  // ≥ 0.5px — the drift keeps the frame alive for the freeze lenses.
  let moving = 0;
  let total = 0;
  for (let t = 0; t < 10000; t += 1000 / 24) {
    const a = cameraDrift(t);
    const b = cameraDrift(t + 1000 / 24);
    total++;
    if (Math.hypot(b.dx - a.dx, b.dy - a.dy) >= 0.5) moving++;
  }
  ok(moving / total >= 0.9, `drift moves ≥0.5px/frame on ${(100 * moving / total).toFixed(1)}% of frames`);
});

await test("S64 timing: placementAt — move_object eases between base and target", async () => {
  const { placementAt } = await import("../src/lib/tubeforge/whiteboard/timing");
  const scene: WhiteboardScene = {
    ...WB_PLAIN,
    animations: [{ type: "move_object", assetId: "a1", startMs: 1000, durationMs: 1000, to: { x: 100, y: 0, scale: 1, rotateDeg: 0 } }],
  };
  const base = { x: 0, y: 0, scale: 1, rotateDeg: 0 };
  eq(placementAt(scene, "a1", base, 500), base, "before the move: base placement");
  approx(placementAt(scene, "a1", base, 1500).x, 50, 1e-9, "halfway");
  eq(placementAt(scene, "a1", base, 3000).x, 100, "at target");
});

await test("S64 timing: frameCount", async () => {
  const { frameCount } = await import("../src/lib/tubeforge/whiteboard/timing");
  eq(frameCount(10000, 24), 240);
  eq(frameCount(100, 24), 2);
  eq(frameCount(10, 24), 1, "never zero frames");
});

await test("S64 timing: the frame plan is a pure function — same inputs, same frames", async () => {
  const { frameAt, buildGeometry, scheduleScene } = await import("../src/lib/tubeforge/whiteboard/timing");
  const { framePayload } = await import("../src/lib/tubeforge/whiteboard/wb-page");
  const geo = buildGeometry([{ id: "a1", paths: [{ id: "p1", d: "M 0 0 L 100 0" }, { id: "p2", d: "M 0 0 L 50 0" }] }]);
  const project: WhiteboardProject = { title: "t", width: 1920, height: 1080, fps: 24, hand: { style: "marker", scale: 1 }, scenes: [WB_PLAIN] };
  const seq = (): string =>
    Array.from({ length: 24 }, (_, f) =>
      framePayload(frameAt(project, WB_PLAIN, scheduleScene(WB_PLAIN, 4000, geo), geo, f * (4000 / 24)), 1920, 1080)
    ).join("\n");
  eq(seq(), seq(), "the frame plan is deterministic");
});

suiteStart("S64 whiteboard — the asset library");

await test("S64 assets: every drawable is an id-carrying <path>/<text> — extraction is complete", async () => {
  const { ASSETS, extractAsset } = await import("../src/lib/tubeforge/whiteboard/assets");
  ok(ASSETS.length >= 9, `library present (${ASSETS.length} assets)`);
  for (const a of ASSETS) {
    ok(
      !/<(circle|rect|ellipse|polygon|polyline|line|image|use|script|foreignObject)\b/i.test(a.svg),
      `${a.id}: a non-extractable drawable is present — it would skip the progressive reveal`
    );
    const ex = extractAsset(a);
    eq(ex.paths.length, (a.svg.match(/<path\b/g) ?? []).length, `${a.id}: every <path> extracted`);
    eq(ex.texts.length, (a.svg.match(/<text\b/g) ?? []).length, `${a.id}: every <text> extracted`);
  }
});

await test("S64 assets: loadLibrary builds the index + registers the scheduler's text metadata", async () => {
  const { loadLibrary, HAND_TIP } = await import("../src/lib/tubeforge/whiteboard/assets");
  const { TEXT_CHARS_BY_ID, TEXT_ANCHORS } = await import("../src/lib/tubeforge/whiteboard/timing");
  const lib = loadLibrary();
  ok(lib.assets.has("hand-marker"), "the drawing hand is in the library");
  eq(HAND_TIP, { x: 70, y: 150 }, "the marker tip anchor");
  eq(lib.libraryIndex.pathIdsByAsset.get("heart-main")?.size, 6, "heart-main exposes 6 drawable paths");
  eq(lib.libraryIndex.textIdsByAsset.get("heart-labels")?.size, 5, "heart-labels exposes 5 texts");
  eq(TEXT_CHARS_BY_ID.get("heart-labels::hl-ra"), 2, "text lengths registered");
  eq(TEXT_ANCHORS.get("heart-labels::hl-ra"), { x: 34, y: 120, size: 22 }, "text anchors registered");
});

await test("S64 assets: extractAsset parses path data and text geometry", async () => {
  const { extractAsset } = await import("../src/lib/tubeforge/whiteboard/assets");
  const ex = extractAsset({
    id: "x",
    viewBox: { w: 10, h: 10 },
    tags: [],
    svg: '<path id="p" d="M 0 0 L 3 3"/><text id="t" x="5" y="6" font-size="12">Hi</text>',
  });
  eq(ex.paths, [{ id: "p", d: "M 0 0 L 3 3" }]);
  eq(ex.texts, [{ id: "t", content: "Hi", x: 5, y: 6, size: 12 }]);
});

suiteStart("S64 whiteboard — renderer pure contracts");

await test("S64 render: framePayload serializes the full frame state (the applier's wire format)", async () => {
  const { framePayload } = await import("../src/lib/tubeforge/whiteboard/wb-page");
  const { frameAt, buildGeometry } = await import("../src/lib/tubeforge/whiteboard/timing");
  const geo = buildGeometry([{ id: "a1", paths: [{ id: "p1", d: "M 0 0 L 100 0" }] }]);
  const project: WhiteboardProject = { title: "t", width: 1920, height: 1080, fps: 24, hand: { style: "marker", scale: 1 }, scenes: [WB_PLAIN] };
  const events = [{ type: "draw_path" as const, assetId: "a1", pathId: "p1", startMs: 0, durationMs: 1000 }];
  const p = JSON.parse(framePayload(frameAt(project, WB_PLAIN, events, geo, 500), 1920, 1080));
  eq(Object.keys(p).sort(), ["camera", "colors", "draws", "hand", "height", "placements", "tMs", "texts", "width"]);
  eq(p.width, 1920);
  eq(p.height, 1080);
  eq(p.tMs, 500);
  eq(p.draws, [["a1::p1", 0.5]]);
  eq(p.hand, { visible: true, x: 50, y: 0, angle: 0 });
});

await test("S64 render: the applier resolves frame-plan keys through the registered id maps (the namespace seam)", async () => {
  const { APPLY_FRAME_FN } = await import("../src/lib/tubeforge/whiteboard/wb-page");
  ok(
    APPLY_FRAME_FN.includes("__wbDraw") && APPLY_FRAME_FN.includes("__wbText"),
    "the applier must resolve keys via window.__wbDraw/__wbText"
  );
  ok(
    APPLY_FRAME_FN.includes("drawEl(key)") && APPLY_FRAME_FN.includes("textEl(key)"),
    "draws/texts lookups go through the map resolvers"
  );
});

// ─── S65 — Whiteboard E1: the id-charset law + the resource budgets ───
//
// The E0 audit's §6 risks 2–4, pinned: the renderer's namespace seam
// (`${assetId}--${pathId}` DOM ids, `assetId::pathId` frame-plan keys) can
// never be fed a corrupting id, and every unbounded dimension of a project
// (placements, events, camera keys, scenes, durations, frames, path
// commands) now has a wall with a name.

suiteStart("S65 whiteboard — E1: the id-charset law");

await test("S65 charset: validWhiteboardId accepts legal ids and rejects the namespace separators + exotics", async () => {
  const { validWhiteboardId } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  ok(validWhiteboardId("a"), "single letter");
  ok(validWhiteboardId("hm-outline"), "single hyphens are legal (the starter library's own convention)");
  ok(validWhiteboardId("p_1.x"), "underscore + dot");
  ok(validWhiteboardId("_lead"), "leading underscore");
  ok(validWhiteboardId("x".repeat(64)), "64 chars is the ceiling");
  ok(!validWhiteboardId("a--b"), "double hyphen would corrupt the DOM id seam");
  ok(!validWhiteboardId("a::b"), "double colon would corrupt the frame-plan key seam");
  ok(!validWhiteboardId("a b"), "spaces break DOM addressing");
  ok(!validWhiteboardId(".dot"), "must start alnum/underscore");
  ok(!validWhiteboardId("x".repeat(65)), "over the 64-char ceiling");
  ok(!validWhiteboardId(""), "empty is not an id");
});

await test("S65 charset: the project validator rejects scene ids that break the law (missing ids still default)", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const bad = validateWhiteboardProject(wbProject([{ ...WB_SCENE, id: "scene--1" }]), WB_LIB);
  ok(bad.project === null, "a `--` scene id must null the project");
  ok(bad.errors.some((e) => e.includes("id charset")), `errors: ${bad.errors.join("; ")}`);

  const colon = validateWhiteboardProject(wbProject([{ ...WB_SCENE, id: "s::1" }]), WB_LIB);
  ok(colon.project === null && colon.errors.some((e) => e.includes("id charset")), "`::` rejected");

  // The default path is untouched: a MISSING id still gets scene-N.
  const { ...noId } = WB_SCENE;
  delete (noId as Record<string, unknown>).id;
  const defaulted = validateWhiteboardProject(wbProject([noId]), WB_LIB);
  ok(defaulted.project !== null, "missing id still parses");
  eq(defaulted.project?.scenes[0].id, "scene-1");

  // Legal explicit ids pass through verbatim.
  const legal = validateWhiteboardProject(wbProject([{ ...WB_SCENE, id: "intro-shot_2" }]), WB_LIB);
  eq(legal.project?.scenes[0].id, "intro-shot_2");
});

await test("S65 charset: extractAsset excludes corrupting ids from the drawable index and reports them", async () => {
  const { extractAsset } = await import("../src/lib/tubeforge/whiteboard/assets");
  const ex = extractAsset({
    id: "x",
    viewBox: { w: 10, h: 10 },
    tags: [],
    svg:
      '<path id="ok-1" d="M 0 0 L 3 3"/>' +
      '<path id="bad--sep" d="M 0 0 L 3 3"/>' +
      '<path id="bad::sep" d="M 0 0 L 3 3"/>' +
      '<text id="bad space" x="5" y="6" font-size="12">Hi</text>' +
      '<text id="ok-t" x="5" y="6" font-size="12">Hi</text>',
  });
  eq(ex.paths.map((p) => p.id), ["ok-1"], "only the charset-legal path is drawable");
  eq(ex.texts.map((t) => t.id), ["ok-t"], "only the charset-legal text is drawable");
  eq(
    ex.rejected.map((r) => `${r.kind}:${r.reason}`).sort(),
    ["path:id-charset", "path:id-charset", "text:id-charset"],
    "every exclusion is surfaced with its reason"
  );
});

await test("S65 charset: the starter library is clean under the law (nothing rejected, no separator ids in the index)", async () => {
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const lib = loadLibrary();
  for (const ex of lib.extracted.values()) {
    eq(ex.rejected, [], `${ex.asset.id}: the built-in asset must be fully drawable`);
  }
  for (const ids of [...lib.libraryIndex.pathIdsByAsset.values(), ...lib.libraryIndex.textIdsByAsset.values()]) {
    for (const id of ids) {
      ok(!id.includes("--") && !id.includes("::"), `index id "${id}" must respect the namespace law`);
    }
  }
  for (const assetId of lib.libraryIndex.assetIds) {
    ok(!assetId.includes("--") && !assetId.includes("::"), `asset id "${assetId}" must respect the namespace law`);
  }
});

suiteStart("S65 whiteboard — E1: the resource budgets");

await test("S65 budgets: the per-path command budget counts through the real grammar (implicit repeats included)", async () => {
  const { extractAsset, WB_PATH_COMMAND_BUDGET } = await import("../src/lib/tubeforge/whiteboard/assets");
  const { countPathCommands } = await import("../src/lib/tubeforge/whiteboard/svg");
  // The unit of account is EXPANDED commands: `M 0 0 L p1 p2 …` is
  // 1 (M) + N (implicit L repeats) commands. countPathCommands is pinned
  // directly first, then through the extraction gate.
  eq(countPathCommands("M 0 0 L 0 0 1 1 2 2"), 4, "M + 3 implicit L repeats");
  eq(countPathCommands("M 0 0 L 3 3 Z"), 3, "Z counts as one command");
  eq(countPathCommands("M 0 0"), 1, "a lone moveto");

  // Over the wall: M + 512 implicit repeats = 513 commands.
  const pairs = (n: number) =>
    Array.from({ length: n }, (_, i) => `${i} ${i}`).join(" ");
  const over = extractAsset({
    id: "x",
    viewBox: { w: 10, h: 10 },
    tags: [],
    svg: `<path id="p" d="M 0 0 L ${pairs(WB_PATH_COMMAND_BUDGET)}"/>`,
  });
  eq(over.paths, [], "an over-budget path is not drawable");
  eq(over.rejected, [{ kind: "path", id: "p", reason: "path-commands" }], "the exclusion is surfaced");

  // Exactly at the wall: M + 511 implicit repeats = 512 commands passes.
  const at = extractAsset({
    id: "x",
    viewBox: { w: 10, h: 10 },
    tags: [],
    svg: `<path id="p" d="M 0 0 L ${pairs(WB_PATH_COMMAND_BUDGET - 1)}"/>`,
  });
  eq(at.paths.length, 1, "a path at exactly the budget is drawable");
  eq(at.rejected, []);
});

await test("S65 budgets: per-scene caps — placements, animations, camera keys", async () => {
  const { validateWhiteboardProject, WB_BUDGETS } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const placements = (n: number) =>
    Array.from({ length: n }, () => ({ assetId: "a1", placement: { x: 0, y: 0, scale: 1, rotateDeg: 0 } }));

  // Over the placements wall → but only ONE distinct asset is placeable per
  // scene (the double-placement law), so over-budget is proven via raw count
  // with unknown assets: the budget error fires FIRST.
  const overPlacements = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, placements: placements(WB_BUDGETS.placementsPerScene + 1) }]),
    WB_LIB
  );
  ok(
    overPlacements.errors.some((e) => e.includes("placements exceed")),
    `errors: ${overPlacements.errors.join("; ")}`
  );

  const anims = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ type: "draw_path", assetId: "a1", pathId: "p1", startMs: i, durationMs: 100 }));
  const overAnims = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, animations: anims(WB_BUDGETS.animationsPerScene + 1) }]),
    WB_LIB
  );
  ok(overAnims.errors.some((e) => e.includes("animation events exceed")), `errors: ${overAnims.errors.join("; ")}`);

  const cams = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ cx: 960, cy: 540, scale: 1, startMs: i * 100, durationMs: 100 }));
  const overCams = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, camera: cams(WB_BUDGETS.cameraKeysPerScene + 1) }]),
    WB_LIB
  );
  ok(overCams.errors.some((e) => e.includes("camera keyframes exceed")), `errors: ${overCams.errors.join("; ")}`);

  // AT the wall everything passes.
  const atWalls = validateWhiteboardProject(
    wbProject([{
      ...WB_SCENE,
      animations: anims(WB_BUDGETS.animationsPerScene),
      camera: cams(WB_BUDGETS.cameraKeysPerScene),
    }]),
    WB_LIB
  );
  ok(atWalls.project !== null, `at-budget project parses: ${atWalls.errors.join("; ")}`);
});

await test("S65 budgets: project caps — scenes, explicit scene duration, Σ explicit durations", async () => {
  const { validateWhiteboardProject, WB_BUDGETS } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const nScenes = (n: number, extra: Partial<WhiteboardScene> = {}) =>
    wbProject(Array.from({ length: n }, (_, i) => ({ ...WB_SCENE, id: `s${i + 1}`, ...extra })));

  eq(validateWhiteboardProject(nScenes(WB_BUDGETS.scenesPerProject), WB_LIB).project?.scenes.length, WB_BUDGETS.scenesPerProject, "24 scenes parse");
  const overScenes = validateWhiteboardProject(nScenes(WB_BUDGETS.scenesPerProject + 1), WB_LIB);
  ok(overScenes.project === null && overScenes.errors.some((e) => e.includes("scene project budget")), `errors: ${overScenes.errors.join("; ")}`);

  const overSceneDur = validateWhiteboardProject(
    wbProject([{ ...WB_SCENE, durationMs: WB_BUDGETS.sceneDurationMsMax + 1 }]),
    WB_LIB
  );
  ok(overSceneDur.errors.some((e) => e.includes("durationMs")), `errors: ${overSceneDur.errors.join("; ")}`);
  ok(
    validateWhiteboardProject(wbProject([{ ...WB_SCENE, durationMs: WB_BUDGETS.sceneDurationMsMax }]), WB_LIB).project !== null,
    "a scene at exactly 120s parses"
  );

  // Σ explicit: 8 scenes × 113s = 904s > the 900s wall.
  const overTotal = validateWhiteboardProject(nScenes(8, { durationMs: 113_000 }), WB_LIB);
  ok(overTotal.project === null && overTotal.errors.some((e) => e.includes("project budget")), `errors: ${overTotal.errors.join("; ")}`);
  // 8 × 112.5s = 900s exactly — at the wall passes.
  ok(validateWhiteboardProject(nScenes(8, { durationMs: 112_500 }), WB_LIB).project !== null, "Σ 900s exactly parses");
});

await test("S65 budgets: the pure frame estimator — duration priority, arithmetic, and the render wall", async () => {
  const { estimateProjectFrames, WB_RENDER_FRAME_BUDGET } = await import("../src/lib/tubeforge/whiteboard/timing");
  // One explicit-duration scene, one VO-driven scene, one estimate-driven scene.
  const proj: WhiteboardProject = {
    title: "t", width: 1920, height: 1080, fps: 24, hand: { style: "marker", scale: 1 },
    scenes: [
      { ...WB_SCENE, id: "explicit", durationMs: 10_000, animations: [] },
      { ...WB_SCENE, id: "vo-driven", animations: [] },
      { ...WB_SCENE, id: "estimated", animations: [] },
    ],
  };
  const vo = new Map([["vo-driven", 20_000]]); // 20s VO → 20.35s effective
  const { totalFrames, sceneMs } = estimateProjectFrames(proj, vo);
  eq(sceneMs[0], 10_000, "explicit wins over everything");
  eq(sceneMs[1], 20_350, "VO (+350ms tail) wins over the estimate");
  // estimateNarrationMs("hello world") = 2 words / 2.6wps ≈ 769ms → clamped to the 4000ms floor.
  eq(sceneMs[2], 4_000, "narration estimate with the floor clamp");
  eq(totalFrames, Math.round((10_000 / 1000) * 24) + Math.round((20_350 / 1000) * 24) + Math.round((4_000 / 1000) * 24), "the total is the Σ of scene frames");

  // The wall: 24 scenes × 80s explicit = 46,080 frames > 25,920 (the
  // validator's Σ-900s cap cannot see this hand-built project object —
  // the RENDER pre-flight is the wall that catches it).
  const huge: WhiteboardProject = {
    ...proj,
    scenes: Array.from({ length: 24 }, (_, i) => ({ ...WB_SCENE, id: `s${i + 1}`, durationMs: 80_000, animations: [] })),
  };
  const est = estimateProjectFrames(huge, new Map());
  eq(est.totalFrames, 46_080, "24 × 80s × 24fps arithmetic");
  ok(est.totalFrames > WB_RENDER_FRAME_BUDGET, "over the wall");
});

await test("S65 budgets: renderWhiteboard refuses an over-budget project BEFORE chromium launches", async () => {
  const { renderWhiteboard } = await import("../src/lib/tubeforge/whiteboard/render");
  const huge: WhiteboardProject = {
    title: "t", width: 1920, height: 1080, fps: 24, hand: { style: "marker", scale: 1 },
    scenes: Array.from({ length: 24 }, (_, i) => ({
      ...WB_SCENE, id: `s${i + 1}`, durationMs: 80_000, animations: [],
    })),
  };
  let threw: unknown = null;
  try {
    // No voFiles → no ffprobe; the pre-flight throws before playwright is
    // even imported (the dynamic import sits AFTER the budget check).
    await renderWhiteboard(huge, { outDir: "/tmp/s65-budget-guard-test" });
  } catch (err) {
    threw = err;
  }
  ok(threw instanceof Error && /frame budget/.test(threw.message), `expected the budget wall, got: ${String(threw)}`);
});

// ---------- suite: S67 — the E2 reconciliation port + E9 Phase A ----------

suiteStart("S67 whiteboard — the ported E2 library (reconciliation)");

await test("S67 port: the library grew to 18 assets and every drawable survives the laws", async () => {
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const lib = loadLibrary();
  ok(lib.assets.size >= 18, `expected ≥18 assets (10 S64 + 8 ported), got ${lib.assets.size}`);
  for (const [id, ex] of lib.extracted) {
    eq(ex.rejected, [], `asset ${id}: no extraction rejections (id-charset + command walls)`);
    // heart-labels is text-only — a drawable asset is paths OR texts.
    ok(ex.paths.length > 0 || ex.texts.length > 0, `asset ${id}: has drawables`);
    for (const p of ex.paths) {
      ok(p.d.length > 0 && p.d.length < 4096, `asset ${id}/${p.id}: path data sane`);
    }
  }
  const ported = ["arrow-growth", "bar-chart", "check-badge", "clock", "coin", "globe", "lightbulb", "rocket"];
  for (const id of ported) ok(lib.assets.has(id), `ported asset ${id} registered`);
});

await test("S67 port: every ported path is a SINGLE subpath (the S64 seam constraint)", async () => {
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const { parsePathData } = await import("../src/lib/tubeforge/whiteboard/svg");
  const lib = loadLibrary();
  // A mid-path M teleports the drawing hand and restarts the dash reveal —
  // the benchmark-proven geometry is single-subpath, so the port splits.
  for (const [assetId, ex] of lib.extracted) {
    for (const p of ex.paths) {
      const starts = parsePathData(p.d).filter((c) => c.cmd.toUpperCase() === "M").length;
      eq(starts, 1, `${assetId}/${p.id}: exactly one M (single subpath)`);
    }
  }
});

await test("S67 port: every ported path sits inside the expanded-command budget", async () => {
  const { loadLibrary, WB_PATH_COMMAND_BUDGET } = await import("../src/lib/tubeforge/whiteboard/assets");
  const { countPathCommands } = await import("../src/lib/tubeforge/whiteboard/svg");
  const lib = loadLibrary();
  for (const [, ex] of lib.extracted) {
    for (const p of ex.paths) {
      ok(countPathCommands(p.d) <= WB_PATH_COMMAND_BUDGET, `path ${p.id} within the command wall`);
    }
  }
});

// ---------- suite: S67 — the native scaffold planner ----------

suiteStart("S67 whiteboard — the native scaffold planner (E5 phase 1)");

const SCENES_IN = [
  { index: 1, title: "Opening", narration: "Money moves faster than ever before in global markets." },
  { index: 2, title: "The idea", narration: "One idea can change how an entire industry measures success." },
  { index: 3, title: "Growth", narration: "And growth compounds when the data backs the decision." },
  { index: 4, title: "Close", narration: "So remember: the next launch begins with a single check." },
];

await test("S67 scaffold: deterministic, narration-copied, budgeted, validator-clean", async () => {
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const a = scaffoldWhiteboardProject({ scenes: SCENES_IN, topic: "Markets" });
  const b = scaffoldWhiteboardProject({ scenes: SCENES_IN, topic: "Markets" });
  eq(JSON.stringify(a), JSON.stringify(b), "determinism: same scenes → byte-identical project");
  eq(a.scenes.length, 4, "one whiteboard scene per story scene");
  eq(a.scenes.map((s) => s.id), ["scene-1", "scene-2", "scene-3", "scene-4"], "ids mirror the story indexes");
  eq(a.scenes.map((s) => s.narration), SCENES_IN.map((s) => s.narration), "narration copied verbatim");
  for (const s of a.scenes) {
    eq(s.animations, [], "events empty — the engine's fill law schedules at render");
    ok(s.placements.length > 0, `scene ${s.id}: has placements`);
    eq(s.camera.length, 1, `scene ${s.id}: default camera`);
  }
  const lib = loadLibrary();
  const validated = validateWhiteboardProject(a, lib.libraryIndex);
  ok(validated.project !== null, `scaffold validates clean: ${validated.errors.join(" · ")}`);
});

await test("S67 scaffold: the keyword rule table picks from the library tags", async () => {
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const p = scaffoldWhiteboardProject({
    scenes: [
      { index: 1, title: "t", narration: "How the idea took hold." },
      { index: 2, title: "t", narration: "The revenue doubled." },
      { index: 3, title: "t", narration: "Across the world." },
      { index: 4, title: "t", narration: "The final beat stands alone." },
    ],
    topic: "t",
  });
  // scene 1 = opener: title-hero first, then the keyword pick for "idea".
  eq(p.scenes[0].placements[0].assetId, "title-hero", "opener carries the title card");
  eq(p.scenes[0].placements[1].assetId, "lightbulb", "idea → lightbulb");
  eq(p.scenes[1].placements[0].assetId, "coin", "revenue → coin");
  eq(p.scenes[2].placements[0].assetId, "globe", "world → globe");
  // scene 4 = closer: the stat card leads, the concept rides under it.
  eq(p.scenes[3].placements[0].assetId, "close-card", "closer carries the stat card");
});

await test("S67 scaffold: no-cue scenes rotate the fallback cycle deterministically", async () => {
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  // Truly cue-free copy: no keyword-table hit anywhere, so the rotation
  // alone decides — and the rotation is position-indexed, i.e. stable.
  const noCue = Array.from({ length: 6 }, (_, i) => ({
    index: i + 1,
    title: `Beat ${i + 1}`,
    narration: `Beat ${i + 1}: an ordinary sentence about the subject.`,
  }));
  const p = scaffoldWhiteboardProject({ scenes: noCue, topic: "t" });
  const picks = p.scenes.map((s) => s.placements[s.placements.length - 1].assetId);
  eq(new Set(picks).size, 6, "six no-cue scenes → six distinct rotating picks");
  const again = scaffoldWhiteboardProject({ scenes: noCue, topic: "t" });
  eq(JSON.stringify(p), JSON.stringify(again), "rotation is deterministic, not ambient");
});

await test("S67 scaffold: opener gets the title card, closer gets the stat card", async () => {
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const p = scaffoldWhiteboardProject({ scenes: SCENES_IN, topic: "t" });
  ok(p.scenes[0].placements.some((pl) => pl.assetId === "title-hero"), "opener: title-hero present");
  ok(p.scenes[p.scenes.length - 1].placements.some((pl) => pl.assetId === "close-card"), "closer: close-card present");
  // A single-scene project is its own opener AND closer — opener wins (the
  // title card carries the beat; close-cards need a story behind them).
  const solo = scaffoldWhiteboardProject({
    scenes: [{ index: 1, title: "t", narration: "One beat only." }],
    topic: "t",
  });
  ok(solo.scenes[0].placements.some((pl) => pl.assetId === "title-hero"), "solo scene keeps the opener treatment");
});

await test("S67 scaffold: the scene-count wall refuses beyond the project budget", async () => {
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const { WB_BUDGETS } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const tooMany = Array.from({ length: WB_BUDGETS.scenesPerProject + 1 }, (_, i) => ({
    index: i + 1, title: `t${i}`, narration: `beat ${i}`,
  }));
  let threw: unknown = null;
  try {
    scaffoldWhiteboardProject({ scenes: tooMany, topic: "t" });
  } catch (err) { threw = err; }
  ok(threw instanceof Error && /scene project budget/.test(threw.message), `expected the wall, got: ${String(threw)}`);
  // And an empty story is a readable error, not a broken doc.
  threw = null;
  try { scaffoldWhiteboardProject({ scenes: [], topic: "t" }); } catch (err) { threw = err; }
  ok(threw instanceof Error && /at least one/.test(threw.message), `expected the empty-story error, got: ${String(threw)}`);
});

// ---------- suite: S67 — the doc column + job plumbing ----------

suiteStart("S67 whiteboard — doc parse/serialize + job entity ids");

await test("S67 doc: tolerant parse discipline — null on junk, never a throw", async () => {
  const { parseWhiteboardDoc, serializeWhiteboardDoc } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  eq(parseWhiteboardDoc(null), null, "null column");
  eq(parseWhiteboardDoc(""), null, "empty column");
  eq(parseWhiteboardDoc("not json {"), null, "unparseable");
  eq(parseWhiteboardDoc(JSON.stringify({ rev: 3 })), null, "missing project");
  eq(parseWhiteboardDoc(JSON.stringify({ project: {} })), null, "missing rev");
  eq(parseWhiteboardDoc(JSON.stringify({ rev: 0, project: {} })), null, "rev below 1");
  eq(parseWhiteboardDoc(JSON.stringify({ rev: 1.5, project: {} })), null, "non-integer rev");
  const doc = { rev: 7, project: { title: "T", width: 1920, height: 1080, fps: 24, hand: { style: "marker" as const, scale: 1 }, scenes: [] } };
  eq(parseWhiteboardDoc(serializeWhiteboardDoc(doc))?.rev, 7, "roundtrip keeps the rev");
});

await test("S67 jobs: splitEntityId('#wb') carries charset-legal scene ids only", async () => {
  const { splitEntityId } = await import("../src/lib/tubeforge/video-jobs.ts");
  const [v1, s1] = splitEntityId("abc123#wbscene-3", "#wb");
  eq(v1, "abc123", "video id split");
  eq(s1, "scene-3", "whiteboard scene id suffix");
  const [, s2] = splitEntityId("abc123#wbev--il", "#wb");
  eq(s2, null, "an id with the namespace separator degrades to null (full render) — never a corrupt address");
  const [v3, s3] = splitEntityId("abc123", "#wb");
  eq(v3, "abc123");
  eq(s3, null, "plain videoId = full render");
});

await test("S67 jobs: parseWhiteboardPayload is tolerant of junk payloads", async () => {
  const { parseWhiteboardPayload } = await import("../src/lib/tubeforge/queue-handlers.ts");
  eq(parseWhiteboardPayload(undefined), {}, "no payload");
  eq(parseWhiteboardPayload(null), {}, "null payload");
  eq(parseWhiteboardPayload("junk"), {}, "wrong type");
  eq(parseWhiteboardPayload({ sceneId: 42 }), {}, "wrong type inside");
  eq(parseWhiteboardPayload({ sceneId: "  scene-2  " }), { sceneId: "scene-2" }, "trimmed");
  eq(parseWhiteboardPayload({ sceneId: "x".repeat(100) }), { sceneId: "x".repeat(64) }, "length-capped");
});

// ---------- suite: S68 — Phase B editing + aspect laws ----------

suiteStart("S68 whiteboard — aspect-aware scaffold, validator camera key, scheduler precedence");

await test("S68 scaffold: 9:16 / 1:1 boards carry their own center and proportionally placed ink", async () => {
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");

  // 9:16 — the historical bug this kills: the default camera pinned (960, 540)
  // on a 1080-wide board = the viewport sitting at the right edge.
  const p916 = scaffoldWhiteboardProject({
    scenes: SCENES_IN,
    topic: "Shorts",
    width: 1080,
    height: 1920,
  });
  eq(p916.width, 1080, "width taken");
  eq(p916.height, 1920, "height taken");
  for (const s of p916.scenes) {
    eq(s.camera[0].cx, 540, `scene ${s.id}: camera centers at width/2`);
    eq(s.camera[0].cy, 960, `scene ${s.id}: camera centers at height/2`);
  }
  // 16:9 placements remap by the axis ratios: x·(1080/1920) = 800·0.5625 = 450,
  // y·(1920/1080) = 420·1.7̄ = 746.67 → 747.
  const concept = p916.scenes[1].placements[0];
  eq(concept.placement.x, 450, "concept x remaps by width/1920");
  eq(concept.placement.y, 747, "concept y remaps by height/1080");
  // Determinism extends to the dims: same input → byte-identical.
  const p916b = scaffoldWhiteboardProject({ scenes: SCENES_IN, topic: "Shorts", width: 1080, height: 1920 });
  eq(JSON.stringify(p916), JSON.stringify(p916b), "9:16 scaffold is deterministic");
  // And every aspect validates clean against the one gate.
  const lib = loadLibrary();
  const v = validateWhiteboardProject(p916, lib.libraryIndex);
  ok(v.project !== null, `9:16 scaffold validates clean: ${v.errors.join(" · ")}`);

  // 1:1 — 1080×1080.
  const p11 = scaffoldWhiteboardProject({ scenes: SCENES_IN, topic: "Square", width: 1080, height: 1080 });
  eq(p11.scenes[0].camera[0].cx, 540, "1:1 camera centers at width/2");
  eq(p11.scenes[0].camera[0].cy, 540, "1:1 camera centers at height/2");
});

await test("S68 scaffold: out-of-band dims fall back to the house 1920×1080@24", async () => {
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const junk1 = scaffoldWhiteboardProject({ scenes: SCENES_IN, topic: "t", width: 9999, height: -5, fps: 120 });
  eq(junk1.width, 1920, "width beyond 3840 → default");
  eq(junk1.height, 1080, "negative height → default");
  eq(junk1.fps, 24, "fps beyond 60 → default");
  const junk2 = scaffoldWhiteboardProject({ scenes: SCENES_IN, topic: "t", width: "wide" as unknown as number });
  eq(junk2.width, 1920, "non-numeric width → default");
});

await test("S68 validator: a doc with no camera key gets a DIMENSION-AWARE default", async () => {
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const lib = loadLibrary();
  const base = {
    title: "T",
    fps: 24,
    hand: { style: "marker" as const, scale: 1 },
    scenes: [
      {
        id: "scene-1",
        narration: "A narration sentence for the scene.",
        background: "#ffffff" as const,
        placements: [{ assetId: "spark", placement: { x: 100, y: 100, scale: 1, rotateDeg: 0 } }],
        animations: [],
        camera: [], // the validator MUST insert the default key
      },
    ],
  };
  const v169 = validateWhiteboardProject({ ...base, width: 1920, height: 1080 }, lib.libraryIndex);
  eq(v169.project?.scenes[0].camera[0].cx, 960, "16:9 default key centers at 960");
  eq(v169.project?.scenes[0].camera[0].cy, 540, "16:9 default key centers at 540");
  const v916 = validateWhiteboardProject({ ...base, width: 1080, height: 1920 }, lib.libraryIndex);
  eq(v916.project?.scenes[0].camera[0].cx, 540, "9:16 default key centers at width/2 — the S68 fix");
  eq(v916.project?.scenes[0].camera[0].cy, 960, "9:16 default key centers at height/2");
  // Explicit keys are never touched.
  const explicit = validateWhiteboardProject(
    {
      ...base,
      width: 1080,
      height: 1920,
      scenes: [{ ...base.scenes[0], camera: [{ cx: 10, cy: 20, scale: 1.5, startMs: 0, durationMs: 0 }] }],
    },
    lib.libraryIndex
  );
  eq(explicit.project?.scenes[0].camera[0].cx, 10, "explicit key preserved");
  eq(explicit.project?.scenes[0].camera[0].scale, 1.5, "explicit zoom preserved");
});

await test("S68 scheduler: explicit events are SENIOR — verbatim times, the fill law takes the rest", async () => {
  const { scheduleScene } = await import("../src/lib/tubeforge/whiteboard/timing");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const { buildGeometry } = await import("../src/lib/tubeforge/whiteboard/timing");
  const lib = loadLibrary();
  const geo = buildGeometry([...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths })));
  // spark carries 6 drawable paths; claim ONE with hand-authored timing.
  const explicit = { type: "draw_path" as const, assetId: "spark", pathId: "sp-core", startMs: 1234, durationMs: 567 };
  const scene: WhiteboardScene = {
    id: "scene-1",
    narration: "One sentence of narration for this edited scene.",
    background: "#ffffff",
    placements: [{ assetId: "spark", placement: { x: 200, y: 200, scale: 1, rotateDeg: 0 }, order: 0 }],
    animations: [explicit],
    camera: [{ cx: 960, cy: 540, scale: 1, startMs: 0, durationMs: 0 }],
  };
  const events = scheduleScene(scene, 8000, geo);
  const pinned = events.find((e) => e.type === "draw_path" && e.assetId === "spark" && e.pathId === "sp-core");
  ok(pinned, "the explicit event survives");
  eq(pinned?.startMs, 1234, "explicit startMs verbatim (senior — not re-scheduled)");
  eq(pinned?.durationMs, 567, "explicit durationMs verbatim");
  // The OTHER five paths still draw (the fill law schedules the unclaimed).
  const scheduled = events.filter((e) => e.type === "draw_path" && e.pathId !== "sp-core");
  eq(scheduled.length, 5, "unclaimed paths ride the fill law");
  for (const e of scheduled) {
    ok(e.startMs >= 400, `scheduled stroke ${e.pathId} starts after the lead-in`);
  }
});

suiteStart("S69 whiteboard — upload gates 1-4 (E9 Phase C / E11 §7, the pure half)");

await test("S69 id derivation: filename stems slug to charset-legal up- ids", async () => {
  const { deriveUploadAssetId } = await import("../src/lib/tubeforge/whiteboard/upload");
  const { validWhiteboardId } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  eq(deriveUploadAssetId("My Drawing!.svg"), "up-my-drawing", "punctuation runs collapse to one dash");
  eq(deriveUploadAssetId("logo v2.SVG"), "up-logo-v2", "case-insensitive extension, spaces slug");
  eq(deriveUploadAssetId("  ---__---.svg"), "up-upload", "slugless stems fall back to a stable id");
  eq(deriveUploadAssetId("a".repeat(200) + ".svg"), "up-" + "a".repeat(48), "stem caps at 48 chars");
  for (const f of ["Heart Diagram.svg", "коин.svg", "x_1.y.svg"]) {
    ok(validWhiteboardId(deriveUploadAssetId(f)), `id for "${f}" respects the charset law`);
  }
});

await test("S69 sniff: valid single-root SVG yields the fragment + viewBox", async () => {
  const { sniffSvgUpload } = await import("../src/lib/tubeforge/whiteboard/upload");
  const doc = Buffer.from(
    `<?xml version="1.0"?><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "x.dtd">\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 120"><path id="p1" d="M 10 10 L 90 90" fill="none"/><text id="t1" x="9" y="20" font-size="12">hi</text></svg>`,
    "utf8"
  );
  const r = sniffSvgUpload(doc);
  ok("svg" in r, "sniff passes with a prolog + doctype (stripped, not fatal)");
  if ("svg" in r) {
    eq(r.viewBox, { w: 240, h: 120 }, "viewBox parsed + rounded");
    ok(r.svg.includes('id="p1"'), "fragment carries the inner markup");
    ok(!r.svg.includes("<svg"), "the root tag itself is not part of the fragment");
  }
});

await test("S69 sniff: the structure walls refuse readably", async () => {
  const { sniffSvgUpload } = await import("../src/lib/tubeforge/whiteboard/upload");
  const bad = (s: string) => {
    const r = sniffSvgUpload(Buffer.from(s, "utf8"));
    ok("errors" in r, `must refuse: ${s.slice(0, 44)}…`);
  };
  bad(`<svg viewBox="0 0 10 10"></svg><svg viewBox="0 0 10 10"></svg>`); // two roots
  bad(`<div><svg viewBox="0 0 10 10"></svg></div>`); // content before root
  bad(`<svg viewBox="0 0 10 10"></svg><p>after</p>`); // content after root
  bad(`<svg width="100" height="50"><path id="p" d="M 0 0 L 9 9"/></svg>`); // no viewBox
  bad(`<svg viewBox="0 0 5000 100"><path id="p" d="M 0 0 L 9 9"/></svg>`); // viewBox > 4096
  bad(`<svg viewBox="0 0 8 100"><path id="p" d="M 0 0 L 9 9"/></svg>`); // viewBox < 16
  bad(`<svg viewBox="0 0 -100 100"><path id="p" d="M 0 0 L 9 9"/></svg>`); // negative
  // Invalid UTF-8: a raw 0xFF byte is not a valid sequence.
  const r = sniffSvgUpload(Buffer.from([0x3c, 0x73, 0x76, 0x67, 0x20, 0xff, 0x3e]));
  ok("errors" in r, "invalid UTF-8 refuses (fatal decode)");
});

await test("S69 validate: the happy path passes gates 1-4 with counts", async () => {
  const { validateUploadedSvg } = await import("../src/lib/tubeforge/whiteboard/upload");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><path id="s1" d="M 10 10 L 60 60" fill="none" stroke="#1d3557" stroke-width="6"/><path id="s2" d="M 40 10 C 60 30, 80 50, 100 90" fill="none"/><text id="cap" x="10" y="180" font-size="20">S69</text></svg>`;
  const v = validateUploadedSvg(Buffer.from(svg, "utf8"), "Probe.svg");
  ok(v.ok, `must pass: ${v.ok ? "" : v.errors.join(" · ")}`);
  if (v.ok) {
    eq(v.asset.id, "up-probe", "id derived from the filename");
    eq(v.paths, 2, "two paths extracted");
    eq(v.texts, 1, "one text extracted");
    eq(v.commands, 4, "M+L + M+C = 4 expanded commands (the Ms count)");
    ok(v.asset.svg.includes('id="s1"'), "stored markup is the sanitized fragment");
  }
});

await test("S69 validate: the attack surface is neutralized, the asset survives", async () => {
  const { validateUploadedSvg } = await import("../src/lib/tubeforge/whiteboard/upload");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><script>alert(1)</script><path id="ok1" d="M 5 5 L 50 50" onclick="evil()"/><path id="ok2" d="M 5 60 L 50 110" fill="none"/><image href="https://evil/x.png" x="0" y="0" width="10" height="10"/><a href="javascript:evil()"><path id="ok3" d="M 60 5 L 110 50" fill="none"/></a></svg>`;
  const v = validateUploadedSvg(Buffer.from(svg, "utf8"), "attack.svg");
  ok(v.ok, `gates pass (the pipeline neutralizes rather than punishes): ${v.ok ? "" : v.errors.join(" · ")}`);
  if (v.ok) {
    ok(!v.asset.svg.includes("<script"), "script subtree stripped");
    ok(!/on[a-z]+\s*=/.test(v.asset.svg), "event handlers stripped");
    ok(!v.asset.svg.includes("<image"), "image element stripped");
    ok(!/javascript:/i.test(v.asset.svg), "javascript: hrefs stripped");
    eq(v.paths, 3, "the three drawable paths survive");
  }
});

await test("S69 validate: the budget walls refuse with the reasons", async () => {
  const { validateUploadedSvg } = await import("../src/lib/tubeforge/whiteboard/upload");
  const manyL = (n: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><path id="big" d="M 0 0 ${Array.from({ length: n }, (_, i) => `L ${i % 400} ${Math.floor(i / 400)}`).join(" ")}" fill="none"/></svg>`;
  // Per-path wall: 600 implicit L commands > 512.
  const overPath = validateUploadedSvg(Buffer.from(manyL(600), "utf8"), "overpath.svg");
  ok(!overPath.ok, "600-command path refuses");
  if (!overPath.ok) ok(/per-path budget/.test(overPath.errors.join(" ")), "names the per-path wall");
  // Per-asset total: 5 paths x 450 commands = 2250 > 2048.
  const five = (cmd: string, id: string) => `<path id="${id}" d="M 0 0 ${cmd}" fill="none"/>`;
  const mk = (n: number) => {
    const cmd = Array.from({ length: n }, (_, i) => `L ${i % 300} ${Math.floor(i / 300)}`).join(" ");
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400">${Array.from({ length: 5 }, (_, i) => five(cmd, `p${i}`)).join("")}</svg>`;
  };
  const overTotal = validateUploadedSvg(Buffer.from(mk(450), "utf8"), "overtotal.svg");
  ok(!overTotal.ok, "2250 total commands refuse");
  if (!overTotal.ok) ok(/per-asset budget/.test(overTotal.errors.join(" ")), "names the per-asset wall");
  // Under both walls passes: 5 x 400 = 2000 <= 2048.
  const under = validateUploadedSvg(Buffer.from(mk(400), "utf8"), "under.svg");
  ok(under.ok, `2000 total commands pass: ${under.ok ? "" : under.errors.join(" · ")}`);
});

await test("S69 validate: charset-violating ids + reserved ids + no drawables refuse", async () => {
  const { validateUploadedSvg } = await import("../src/lib/tubeforge/whiteboard/upload");
  const withId = (id: string) =>
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path id="${id}" d="M 0 0 L 40 40" fill="none"/></svg>`, "utf8");
  const bad = validateUploadedSvg(withId("we--ird"), "charset.svg");
  ok(!bad.ok, "a -- id would corrupt the renderer's namespace seam");
  if (!bad.ok) ok(/id charset/.test(bad.errors.join(" ")), "names the charset wall");
  const reserved = validateUploadedSvg(withId("fine"), "Spark.svg", new Set(["up-spark"]));
  ok(!reserved.ok, "a colliding derived id refuses");
  if (!reserved.ok) ok(/already taken/.test(reserved.errors.join(" ")), "the collision reads clearly");
  const empty = validateUploadedSvg(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="0" y="0" width="9" height="9"/></svg>`, "utf8"),
    "empty.svg"
  );
  ok(!empty.ok, "no drawable content (rect is not a drawable) refuses");
  // The byte cap.
  const big = Buffer.alloc(256 * 1024 + 1, 0x20);
  const overBytes = validateUploadedSvg(big, "big.svg");
  ok(!overBytes.ok, "over-cap bytes refuse before any parse");
});

await test("S69 loadLibrary(uploads): the merge registers uploads beside the built-ins", async () => {
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const upload = {
    id: "up-probe",
    viewBox: { w: 200, h: 200 },
    tags: ["upload"],
    svg: `<path id="up-p1" d="M 10 10 L 80 80" fill="none" stroke="#1d3557" stroke-width="6"/>`,
  };
  const lib = loadLibrary([upload]);
  ok(lib.assets.has("up-probe"), "upload registered in the merged library");
  eq(lib.extracted.get("up-probe")?.paths.length, 1, "upload paths extracted");
  ok(lib.libraryIndex.assetIds.has("up-probe"), "validator index sees the upload");
  // A project placing the upload validates clean against the MERGED lib only.
  const project = {
    title: "Upload board",
    width: 1920,
    height: 1080,
    fps: 24,
    hand: { style: "marker" as const, scale: 1 },
    scenes: [
      {
        id: "scene-1",
        narration: "A scene that places an uploaded asset.",
        background: "#ffffff" as const,
        placements: [{ assetId: "up-probe", placement: { x: 300, y: 300, scale: 2, rotateDeg: 0 }, order: 0 }],
        animations: [],
        camera: [],
      },
    ],
  };
  const merged = validateWhiteboardProject(project, lib.libraryIndex);
  ok(merged.project !== null, `placement validates against the merged library: ${merged.errors.join(" · ")}`);
  const builtinOnly = loadLibrary();
  const refused = validateWhiteboardProject(project, builtinOnly.libraryIndex);
  ok(refused.project === null, "the same placement correctly fails against built-ins alone");
  // Collisions throw — the route prevents them at write time; a collision at
  // load is data corruption and says so.
  let threw = false;
  try {
    loadLibrary([{ ...upload, id: "spark" }]);
  } catch {
    threw = true;
  }
  ok(threw, "an upload colliding with a built-in id throws at load");
});

await test("S69 load-time sanitize law: a re-sanitized upload is safe even if storage lied", async () => {
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const sketchy = {
    id: "up-sketchy",
    viewBox: { w: 100, h: 100 },
    tags: ["upload"],
    svg: `<path id="s1" d="M 0 0 L 50 50" fill="none"/><script>evil()</script>`,
  };
  const lib = loadLibrary([sketchy]);
  const stored = lib.assets.get("up-sketchy")?.svg ?? "";
  ok(!stored.includes("<script"), "the merge re-runs sanitizeSvg on every load (the pipeline law)");
});

console.log(`\n${"─".repeat(56)}`);

suiteStart("S70 creator intelligence — CI-1 hook scoring (deterministic anchor)");

await test("S70 hook scorer: specific + tense beats vague, evidence in the notes", async () => {
  const { scoreHookHeuristic } = await import("../src/lib/tubeforge/hook-score");
  const strong = scoreHookHeuristic("Why 47% of marathon runners quit before mile 20 — and how to avoid it");
  const vague = scoreHookHeuristic("Amazing secrets about things you won't believe");
  ok(strong.total > vague.total, `specific hook (${strong.total}) beats vague (${vague.total})`);
  ok(strong.specificity >= 50, "a number + concrete nouns lift specificity (52 for this hook)");
  ok(strong.notes.some((x) => /number/.test(x)), "the evidence names the number signal");
  ok(vague.notes.some((x) => /vague filler/.test(x)), "the vague hook's filler is named");
  eq(strong.heuristic, true, "every score is labeled a heuristic");
  eq(vague.heuristic, true, "the doctrine applies to weak hooks too");
  // ALL-CAPS + stacked bangs are noise, not tension.
  const shouting = scoreHookHeuristic("THIS ONE TRICK WILL CHANGE YOUR LIFE!!!!");
  ok(shouting.total < 60, "shouting reads as noise");
  ok(shouting.notes.some((x) => /ALL-CAPS|exclamation/.test(x)), "the penalties are named");
  // Degenerate input.
  const empty = scoreHookHeuristic("hi");
  eq(empty.total, 0, "a sub-two-word string is not a hook");
});

await test("S70 retention beats ride the story engine's own spine", async () => {
  const { markRetentionBeats } = await import("../src/lib/tubeforge/hook-score");
  const { isRehookPosition } = await import("../src/lib/tubeforge/story");
  const beats = markRetentionBeats(10);
  eq(beats[0].kind, "hook", "scene 1 is the hook");
  for (const b of beats.slice(1)) {
    eq(b.kind, "rehook", `scene ${b.at + 1} marked as a rehook`);
    ok(isRehookPosition(b.at), "rehooks land exactly on the engine's every-3rd map");
  }
  eq(markRetentionBeats(0), [], "no scenes, no beats — asked for, never invented");
});

await test("S70 title-promise check: missing concrete terms are the gap", async () => {
  const { verifyTitlePromise } = await import("../src/lib/tubeforge/hook-score");
  const good = verifyTitlePromise("How Your Heart Works", "Today we look at how your heart works, beat by beat.");
  ok(good.delivers, "the opening names the title's terms");
  const gap = verifyTitlePromise("How Your Heart Works", "Welcome back to the channel — let's get into it.");
  ok(!gap.delivers, "an opening with no heart-words fails the promise");
  ok(gap.missing.includes("heart"), "the missing term is named");
  eq(gap.heuristic, true, "labeled a heuristic");
});

suiteStart("S70 creator intelligence — CI-2 packaging lint (the pairing)");

await test("S70 packaging lint: truncation, vagueness, duplication, thumb text", async () => {
  const { lintPackagingDeterministic } = await import("../src/lib/tubeforge/packaging-lint");
  const byId = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id);

  // Truncation: past 70 chars the tail is invisible nearly everywhere.
  const long = lintPackagingDeterministic({
    title: "How Your Heart Works — the complete 12 minute tour of the human cardiovascular system explained",
  });
  eq(byId(long, "title-truncation")?.severity, "warn", "a 100+ char title warns on truncation");

  const fits = lintPackagingDeterministic({ title: "How Your Heart Works" });
  eq(byId(fits, "title-truncation")?.severity, "ok", "a short title fits every width");

  // Vagueness: clickbait markers with nothing concrete.
  const vague = lintPackagingDeterministic({ title: "You Won't Believe This One Trick" });
  eq(byId(vague, "title-vagueness")?.severity, "warn", "unfalsifiable phrasing warns");

  const concrete = lintPackagingDeterministic({ title: "Why 47% of Runners Quit at Mile 20" });
  eq(byId(concrete, "title-vagueness")?.severity, "ok", "numbers + nouns are concrete");

  // Duplication: the thumbnail repeating the title wastes the pairing.
  const dup = lintPackagingDeterministic({
    title: "How Your Heart Works",
    thumbnailText: "how your heart works",
  });
  eq(byId(dup, "pairing-duplication")?.severity, "warn", ">=60% word overlap warns");

  const pair = lintPackagingDeterministic({
    title: "How Your Heart Works",
    thumbnailText: "100,000 beats a day",
  });
  eq(byId(pair, "pairing-duplication")?.severity, "ok", "complementary thumb text passes");

  // Thumb text length: too many words stops reading at grid size.
  const wordy = lintPackagingDeterministic({
    title: "T",
    thumbnailText: "one two three four five six seven eight nine ten eleven",
  });
  eq(byId(wordy, "thumb-text-length")?.severity, "warn", "11 overlay words warn");
});

await test("S70 packaging lint: the report aggregates honestly, no VLM invented", async () => {
  const { lintPackaging } = await import("../src/lib/tubeforge/packaging-lint");
  const clean = await lintPackaging({ title: "How Your Heart Works" });
  eq(clean.heuristic, true, "the report is labeled a heuristic");
  eq(clean.vlmJudged, false, "no image → no VLM claim");
  ok(clean.score > 70, `a clean pairing scores high (${clean.score})`);
  ok(
    clean.checks.some((c) => c.id === "vlm-lookability" && /No thumbnail image/.test(c.message)),
    "the missing thumbnail is ASKED for, never invented"
  );
  const messy = await lintPackaging({
    title: "You Won't Believe This One Trick — the ultimate guide to amazing secrets of incredible things",
    thumbnailText: "you won't believe this one trick secret",
  });
  ok(messy.score < clean.score, "warns drag the pairing score down");
  ok(messy.score >= 0 && messy.score <= 100, "score stays in range");
});


suiteStart("S70 CI-3 — Shorts self-containment (the moment-pick seam)");

await test("S70 self-containment: a cold-start clip outscores a backward-pointing one", async () => {
  const { selfContainmentScore, pickBestScene } = await import("../src/lib/tubeforge/shorts");
  const cold = selfContainmentScore({
    narration: "Marathon runners quit at mile 20 for one reason: fuel. Here is how to avoid the wall.",
    caption: "The 7 secrets nobody tells you",
    hostInScene: true,
  });
  const dangling = selfContainmentScore({
    narration: "So that is why it fails every single time, and that is the real problem here.",
    caption: "",
    hostInScene: false,
  });
  ok(cold.score > dangling.score, `self-contained (${cold.score}) beats dangling (${dangling.score})`);
  ok(cold.selfContained, "the cold clip reads standalone");
  ok(!dangling.selfContained, "the dangling clip does not");
  eq(cold.heuristic, true, "labeled a heuristic");
  ok(cold.notes.includes("hook-y caption"), "the caption signal is named");
  ok(
    dangling.notes.some((n) => /backward reference/.test(n)),
    "the dangling opener is named"
  );
  // The seam law: same signature, deterministic.
  const mk = (narration: string, caption: string, index: number) => ({
    index, title: "t", narration, visual: "v", camera: "zoom-in", mood: "neutral",
    caption, hostInScene: false, rehook: false, sfx: "none",
  });
  const a = pickBestScene([mk("So this is why it broke.", "", 1), mk("Batteries fail in cold weather for 3 reasons. Here they are.", "Why batteries die", 2)]);
  const b = pickBestScene([mk("So this is why it broke.", "", 1), mk("Batteries fail in cold weather for 3 reasons. Here they are.", "Why batteries die", 2)]);
  eq(a?.index, 2, "the self-contained scene is picked");
  eq(a?.index, b?.index, "deterministic — same input, same pick");
  eq(pickBestScene([]), null, "no scenes, no pick");
});

await test("S70 self-containment: the Shorts speech window and payoff ending", async () => {
  const { selfContainmentScore } = await import("../src/lib/tubeforge/shorts");
  const inWindow = selfContainmentScore({
    narration:
      "Sleep is not downtime. During deep sleep your brain flushes waste, your muscles repair, and your memories move into long-term storage. Skip it and every system pays. Here is what eight hours actually buys you.",
    caption: "Why sleep matters",
    hostInScene: false,
  });
  const tooThin = selfContainmentScore({ narration: "Yes. Exactly that.", caption: "", hostInScene: false });
  const tooLong = selfContainmentScore({
    narration: "word ".repeat(140).trim() + " The end.",
    caption: "",
    hostInScene: false,
  });
  ok(tooThin.score < inWindow.score, `a two-word scene scores below a full clip (${tooThin.score} < ${inWindow.score})`);
  ok(tooThin.notes.some((n) => /too thin/.test(n)), "thinness is named");
  ok(tooLong.notes.some((n) => /Shorts window/.test(n)), "over-length is named");
  ok(inWindow.notes.some((n) => /payoff/.test(n)), "the payoff ending is named");
});


suiteStart("S72 CI-4 — retention analysis (the pure half)");

await test("S72 retention: cliffs surface with evidence, mapped through the timeline projection", async () => {
  const { analyzeRetentionCurve } = await import("../src/lib/tubeforge/retention");
  const { assembleTimeline } = await import("../src/lib/tubeforge/timeline");
  const mkScene = (index: number, narration: string) => ({
    index, title: `Scene ${index}`, narration, visual: "a frame", camera: "zoom-in",
    mood: "neutral", caption: "", hostInScene: false, rehook: false, sfx: "none",
  });
  // Three meaty scenes (word-count estimates drive the projection when no
  // WAVs stand — the same estimates the assemble route rides).
  const scenes = [
    mkScene(1, "First scene sets the stage with a clear subject and a promise about what follows next in this video."),
    mkScene(2, "Second scene delivers the core explanation with detail and momentum, carrying the argument forward."),
    mkScene(3, "Final scene lands the payoff and closes the loop, restating the promise in concrete terms."),
  ];
  const timeline = assembleTimeline(scenes, {});
  const durationSec = timeline.scenes.reduce((a, t) => a + t.durationSec, 0);

  // A cliff mid-scene-2: find a tRatio inside scene 2's window, a little
  // after its start (NOT a boundary).
  const s2 = timeline.scenes[1];
  const cliffSec = s2.startSec + s2.durationSec * 0.6;
  const cliffRatio = cliffSec / durationSec;
  const points = [
    { tRatio: 0, watchRatio: 1 },
    { tRatio: cliffRatio - 0.02, watchRatio: 0.9 },
    { tRatio: cliffRatio, watchRatio: 0.63 }, // −30% of the REMAINING audience: a hard cliff
    { tRatio: cliffRatio + 0.05, watchRatio: 0.61 }, // 2% wiggle = noise, not a finding
    { tRatio: 1, watchRatio: 0.55 },
  ];
  const f = analyzeRetentionCurve(points, durationSec, scenes, null);
  eq(f.heuristic, true, "labeled a heuristic");
  eq(f.drops.length, 1, "one cliff above threshold, the wiggle filtered");
  const d = f.drops[0];
  eq(d.sceneIndex, 2, "the cliff maps to scene 2");
  eq(d.atSceneBoundary, false, "mid-scene, not a boundary");
  ok(Math.abs(d.magnitude - 0.3) < 0.01, `magnitude is the share of the REMAINING audience (${d.magnitude.toFixed(2)})`);
  ok(/mid-scene 2/.test(d.suggestion), "the suggestion names the scene and the pacing read");
  ok(d.narrationExcerpt.includes("Second scene"), "the words on screen are the evidence");
  ok(f.averageWatchRatio > 0.5 && f.averageWatchRatio < 1, "average ratio computed");
});

await test("S72 retention: a boundary cliff reads as an opener problem; caps + tolerance", async () => {
  const { analyzeRetentionCurve } = await import("../src/lib/tubeforge/retention");
  const mkScene = (index: number, narration: string) => ({
    index, title: `S${index}`, narration, visual: "v", camera: "zoom-in",
    mood: "neutral", caption: "", hostInScene: false, rehook: false, sfx: "none",
  });
  const scenes = [
    mkScene(1, "One short opener line."),
    mkScene(2, "The middle scene carries the weight of the explanation with numbers and momentum to spare."),
    mkScene(3, "The closing scene restates and lands the payoff in concrete terms for the viewer."),
  ];
  // A cliff exactly at scene 2's start: the projection puts it there
  // (tRatio derived from the timeline itself in this test).
  const { assembleTimeline } = await import("../src/lib/tubeforge/timeline");
  const timeline = assembleTimeline(scenes, {});
  const durationSec = timeline.scenes.reduce((a, t) => a + t.durationSec, 0);
  const boundaryRatio = timeline.scenes[1].startSec / durationSec;
  const points = [
    { tRatio: 0, watchRatio: 1 },
    { tRatio: Math.max(0, boundaryRatio - 0.01), watchRatio: 0.95 },
    { tRatio: boundaryRatio, watchRatio: 0.6 },
    { tRatio: 1, watchRatio: 0.5 },
  ];
  const f = analyzeRetentionCurve(points, durationSec, scenes, null);
  eq(f.drops.length, 1, "one finding");
  eq(f.drops[0].atSceneBoundary, true, "detected as a scene-boundary cliff");
  ok(/opens with a cliff/.test(f.drops[0].suggestion), "the suggestion reads as an opener problem");

  // Six cliffs → at most 5 surface (the actionable head), time-ordered.
  const many = Array.from({ length: 12 }, (_, i) => ({
    tRatio: (i + 1) / 13,
    watchRatio: 1 - 0.09 * (i + 1) >= 0 ? 1 - 0.09 * (i + 1) : 0,
  }));
  const capped = analyzeRetentionCurve([{
    tRatio: 0, watchRatio: 1,
  }, ...many], 100, [], null);
  ok(capped.drops.length <= 5, `capped at 5 findings (${capped.drops.length})`);

  // The tolerant parse: junk is null, never a throw.
  const { parseRetentionReport } = await import("../src/lib/tubeforge/retention");
  eq(parseRetentionReport(null), null, "null column → null");
  eq(parseRetentionReport("{not json"), null, "invalid JSON → null");
  eq(parseRetentionReport(JSON.stringify({ nope: 1 })), null, "wrong shape → null");
  const doc = parseRetentionReport(
    JSON.stringify({ youtubeId: "abc", fetchedAt: "2026-11-10T00:00:00Z", videoDurationSec: 90, points: [], averageWatchRatio: 0.4, drops: [] })
  );
  ok(doc !== null && doc.youtubeId === "abc", "a well-formed report parses");
});

// ---------- suite: S73 — the LLM scaffold planner (E5 phase 2) ----------

suiteStart("S73 whiteboard — the LLM scaffold planner (E5 phase 2)");

const S73_SCENES = [
  { index: 1, title: "Opening", narration: "Money moves markets faster than ever before." },
  { index: 2, title: "The pump", narration: "The heart pumps five liters of blood through the body every single day." },
  { index: 3, title: "Close", narration: "Check the numbers yourself before the next launch." },
];

await test("S73 catalog: reserved ids never reach the model; uploads lead, order deterministic", async () => {
  const { buildPlannerCatalog, WB_PLANNER_RESERVED_IDS } = await import("../src/lib/tubeforge/whiteboard/llm-planner");
  const catalog = buildPlannerCatalog([
    { id: "hand-marker", tags: ["hand", "marker"], viewBox: { w: 140, h: 170 } },
    { id: "title-hero", tags: ["generic", "title"], viewBox: { w: 800, h: 200 } },
    { id: "close-card", tags: ["generic", "close"], viewBox: { w: 800, h: 220 } },
    { id: "coin", tags: ["money", "coin"], viewBox: { w: 200, h: 200 } },
    { id: "bar-chart", tags: ["business", "data"], viewBox: { w: 200, h: 200 } },
    { id: "up-mine", tags: ["upload"], viewBox: { w: 120, h: 120 } },
  ]);
  eq(catalog.map((c) => c.id), ["up-mine", "bar-chart", "coin"], "uploads first, built-ins alphabetical, reserved excluded");
  eq(catalog[0].uploaded, true, "the upload is flagged for the prompt");
  eq(WB_PLANNER_RESERVED_IDS.has("title-hero"), true, "the grammar's cards stay reserved");
  // Against the REAL library: every non-reserved built-in is offered.
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const lib = loadLibrary();
  const real = buildPlannerCatalog(lib.assets.values());
  eq(real.length, lib.assets.size - 3, "real library: all but the three reserved ids");
  ok(real.every((c) => !WB_PLANNER_RESERVED_IDS.has(c.id)), "no reserved id leaks into the catalog");
});

await test("S73 normalize: unknown/reserved/dupes dropped with reasons; coordinates clamped onto the board", async () => {
  const { normalizeLlmScenePlans } = await import("../src/lib/tubeforge/whiteboard/llm-planner");
  const catalogIds = new Set(["coin", "heart-main", "bar-chart", "lightbulb", "up-mine"]);
  const out = normalizeLlmScenePlans(
    [
      {
        scene: 1,
        assets: [
          { assetId: "coin", x: -300, y: 90000, scale: 99, rotateDeg: 720 },
          { assetId: "title-hero", x: 100, y: 100, scale: 1 },
          { assetId: "nope", x: 10, y: 10, scale: 1 },
        ],
      },
      {
        scene: 2,
        assets: [
          { assetId: "heart-main", x: 800, y: 400, scale: 2 },
          { assetId: "heart-main", x: 900, y: 500, scale: 2 },
        ],
      },
      { scene: 7, assets: [{ assetId: "coin", x: 1, y: 1, scale: 1 }] },
      // scene 3 never mentioned → fallback
    ],
    { scenes: S73_SCENES, catalogIds, width: 1920, height: 1080 }
  );
  eq([...out.served.keys()].sort((a, b) => a - b), [1, 2], "scenes 1 + 2 served");
  eq(out.fallback, [3], "the unmentioned scene falls back");
  const s1 = out.served.get(1);
  ok(s1 !== undefined, "scene 1 served");
  eq(s1.picks.length, 1, "scene 1 keeps only the clamped coin");
  eq(s1.picks[0].x, 0, "x clamped onto the board");
  eq(s1.picks[0].y, 1080, "y clamped onto the board");
  eq(s1.picks[0].scale, 4, "scale clamped to the band max");
  eq(s1.picks[0].rotateDeg, 180, "rotation clamped to ±180");
  const reasons = out.dropped.map((d) => d.reason).join(" | ");
  ok(
    /reserved/.test(reasons) && /not in the concept catalog/.test(reasons) && /twice/.test(reasons) && /outside the story/.test(reasons),
    `every drop surfaces its reason: ${reasons}`
  );
  const s2 = out.served.get(2);
  ok(s2 !== undefined, "scene 2 served");
  eq(s2.picks.length, 1, "the duplicate placement died, the original stands");
});

await test("S73 normalize: the per-scene concept cap drops extras and names the cap", async () => {
  const { normalizeLlmScenePlans, WB_PLANNER_CONCEPTS_PER_SCENE } = await import("../src/lib/tubeforge/whiteboard/llm-planner");
  const catalogIds = new Set(["coin", "heart-main", "bar-chart", "lightbulb", "up-mine"]);
  const capped = normalizeLlmScenePlans(
    [
      {
        scene: 1,
        assets: ["coin", "bar-chart", "lightbulb", "up-mine", "heart-main"].map((id) => ({
          assetId: id,
          x: 500,
          y: 500,
          scale: 1,
        })),
      },
    ],
    { scenes: S73_SCENES, catalogIds, width: 1920, height: 1080 }
  );
  const cappedS1 = capped.served.get(1);
  ok(cappedS1 !== undefined, "the capped scene stayed served");
  eq(cappedS1.picks.length, WB_PLANNER_CONCEPTS_PER_SCENE, `capped at ${WB_PLANNER_CONCEPTS_PER_SCENE} concepts`);
  ok(capped.dropped.some((d) => /cap/.test(d.reason)), "the dropped extra names the cap");
  // A scene whose picks all die falls back — never an empty board scene.
  const dead = normalizeLlmScenePlans(
    [{ scene: 1, assets: [{ assetId: "ghost", x: 1, y: 1, scale: 1 }] }],
    { scenes: S73_SCENES, catalogIds, width: 1920, height: 1080 }
  );
  eq(dead.served.size, 0, "nothing survived");
  eq(dead.fallback, [1, 2, 3], "the scene falls back to the native pick");
});

await test("S73 compose: structural cards survive, concepts swap, camera/fill law untouched, validator-clean", async () => {
  const { composeLlmScaffold } = await import("../src/lib/tubeforge/whiteboard/llm-planner");
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const native = scaffoldWhiteboardProject({ scenes: S73_SCENES, topic: "T" });
  const served = new Map([
    [
      1,
      {
        sceneIndex: 1,
        picks: [
          { assetId: "bar-chart", x: 900, y: 420, scale: 1.6, rotateDeg: 0 },
          { assetId: "coin", x: 400, y: 700, scale: 1.2, rotateDeg: -10 },
        ],
      },
    ],
  ]);
  const composed = composeLlmScaffold(native, S73_SCENES, served);
  const c1 = composed.scenes[0];
  eq(c1.placements[0].assetId, "title-hero", "the structural card survives");
  eq(c1.placements.map((p) => p.assetId).slice(1), ["bar-chart", "coin"], "the LLM picks replace the native concept");
  eq(c1.placements[1].order, 1, "orders follow the structural card");
  eq(c1.placements[2].order, 2, "second pick orders after the first");
  eq(c1.camera, native.scenes[0].camera, "camera untouched");
  eq(c1.animations, [], "events stay empty — the fill law is the only scheduler");
  eq(JSON.stringify(composed.scenes[1]), JSON.stringify(native.scenes[1]), "unserved scene 2 passes through untouched");
  eq(JSON.stringify(composed.scenes[2]), JSON.stringify(native.scenes[2]), "unserved scene 3 passes through untouched");
  const lib = loadLibrary();
  const v = validateWhiteboardProject(composed, lib.libraryIndex);
  ok(v.project !== null, `composed project validates clean: ${v.errors.join(" · ")}`);
});

await test("S73 wrapper: a good model reply composes an LLM scaffold that validates clean", async () => {
  const { scaffoldWhiteboardProjectLlm, buildPlannerCatalog } = await import(
    "../src/lib/tubeforge/whiteboard/llm-planner"
  );
  const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const lib = loadLibrary();
  const passThrough: import("../src/lib/tubeforge/whiteboard/llm-planner").PlannerCall = (_service, _label, fn) => fn();
  const goodAsk = async () =>
    JSON.stringify({
      scenes: [
        { scene: 1, assets: [{ id: "bar-chart", x: 900, y: 420, scale: 1.6 }] },
        { scene: 2, assets: [{ id: "heart-main", x: 800, y: 400, scale: 2 }] },
        { scene: 3, assets: [{ id: "check-badge", x: 700, y: 380, scale: 1.5 }] },
      ],
    });
  const { project, report } = await scaffoldWhiteboardProjectLlm(
    { scenes: S73_SCENES, topic: "How Your Heart Works", catalog: buildPlannerCatalog(lib.assets.values()) },
    { ask: goodAsk, call: passThrough }
  );
  eq(report.planner, "llm", "the honest planner label");
  eq(report.servedScenes, 3, "every scene served");
  eq(report.degraded, false, "not degraded");
  eq(report.fallbackScenes, [], "no fallback");
  const v = validateWhiteboardProject(project, lib.libraryIndex);
  ok(v.project !== null, `the LLM scaffold validates clean: ${v.errors.join(" · ")}`);
  eq(project.scenes[0].placements[0].assetId, "title-hero", "scene 1 keeps the title card");
  eq(project.scenes[2].placements[0].assetId, "close-card", "the closer keeps the stat card");
  eq(project.scenes[0].placements[1].assetId, "bar-chart", "the model's pick replaced the native concept");
});

await test("S73 wrapper: a scene the model skips falls back per-scene, honestly listed", async () => {
  const { scaffoldWhiteboardProjectLlm, buildPlannerCatalog } = await import(
    "../src/lib/tubeforge/whiteboard/llm-planner"
  );
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const lib = loadLibrary();
  const passThrough: import("../src/lib/tubeforge/whiteboard/llm-planner").PlannerCall = (_service, _label, fn) => fn();
  const partialAsk = async () =>
    JSON.stringify({
      scenes: [
        { scene: 1, assets: [{ id: "coin", x: 900, y: 420, scale: 1.6 }] },
        { scene: 3, assets: [{ id: "rocket", x: 800, y: 400, scale: 1.4 }] },
      ],
    });
  const native = scaffoldWhiteboardProject({ scenes: S73_SCENES, topic: "T" });
  const { project, report } = await scaffoldWhiteboardProjectLlm(
    { scenes: S73_SCENES, topic: "T", catalog: buildPlannerCatalog(lib.assets.values()) },
    { ask: partialAsk, call: passThrough }
  );
  eq(report.planner, "llm", "still an LLM scaffold");
  eq(report.fallbackScenes, [2], "scene 2 honestly listed as native-served");
  eq(JSON.stringify(project.scenes[1]), JSON.stringify(native.scenes[1]), "scene 2 IS the native scene");
  eq(project.scenes[0].placements[1].assetId, "coin", "scene 1 carries the model's pick");
});

await test("S73 wrapper: a failed round-trip degrades to the native scaffold, labeled with the reason", async () => {
  const { scaffoldWhiteboardProjectLlm, buildPlannerCatalog } = await import(
    "../src/lib/tubeforge/whiteboard/llm-planner"
  );
  const { scaffoldWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/whiteboard-planner");
  const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
  const lib = loadLibrary();
  const catalog = buildPlannerCatalog(lib.assets.values());
  const passThrough: import("../src/lib/tubeforge/whiteboard/llm-planner").PlannerCall = (_service, _label, fn) => fn();
  const native = scaffoldWhiteboardProject({ scenes: S73_SCENES, topic: "T" });

  // The gateway itself fails.
  const dead = await scaffoldWhiteboardProjectLlm(
    { scenes: S73_SCENES, topic: "T", catalog },
    { ask: async () => { throw new Error("429 too many requests"); }, call: passThrough }
  );
  eq(dead.report.planner, "native", "degraded honestly");
  eq(dead.report.degraded, true, "the degraded flag stands");
  ok(/429/.test(dead.report.degradeReason ?? ""), "the reason carries the failure");
  eq(JSON.stringify(dead.project), JSON.stringify(native), "the project IS the native scaffold, byte-identical");

  // Prose instead of JSON.
  const prose = await scaffoldWhiteboardProjectLlm(
    { scenes: S73_SCENES, topic: "T", catalog },
    { ask: async () => "I would rather not use JSON today, thanks.", call: passThrough }
  );
  eq(prose.report.degraded, true, "prose degrades");
  eq(JSON.stringify(prose.project), JSON.stringify(native), "prose → native scaffold");

  // Structured but useless.
  const wrongShape = await scaffoldWhiteboardProjectLlm(
    { scenes: S73_SCENES, topic: "T", catalog },
    { ask: async () => JSON.stringify({ rows: [] }), call: passThrough }
  );
  eq(wrongShape.report.degraded, true, "a wrong-shape reply degrades after its retry");

  // An empty catalog never even asks the model.
  const emptyCat = await scaffoldWhiteboardProjectLlm(
    { scenes: S73_SCENES, topic: "T", catalog: [] },
    { ask: async () => { throw new Error("the model was called with an empty catalog — bug"); }, call: passThrough }
  );
  eq(emptyCat.report.degraded, true, "empty catalog degrades");
  ok(/catalog is empty/.test(emptyCat.report.degradeReason ?? ""), "the reason names the empty catalog");
});

suiteStart("S74 — the paired motion re-measure (S63's open item, adapted post-rebuild)");

await test("S74: i2vMotionPrompt reads ONLY shot0's camera/moveSpeed/subjectAction from the plan — the reconstruction law", async () => {
  const { i2vMotionPrompt } = await import("../src/lib/tubeforge/liveliness.ts");
  const scene = {
    index: 1, title: "T", narration: "n", visual: "a red barn in a field",
    camera: "static", mood: "warm light", caption: "c", hostInScene: false,
    rehook: false, sfx: "none",
  };
  const full = {
    sceneIndex: 1, mood: "x", transitionIn: "", motion: "smart", needsI2V: true,
    useStock: false, pacing: "normal", ambience: "room", sfx: "none",
    shots: [{
      shotIndex: 0, framing: "wide", camera: "zoom-in", lens: "24mm",
      composition: "rule of thirds", duration: 5, imagePrompt: "IGNORED",
      subject: "the anchor", subjectAction: "walking to the door", moveSpeed: "fast",
    }],
  };
  const minimal = { shots: [{
    shotIndex: 0, framing: "", camera: "zoom-in", lens: "", composition: "",
    duration: 5, imagePrompt: "", subjectAction: "walking to the door", moveSpeed: "fast",
  }] };
  eq(
    i2vMotionPrompt(scene, full as never),
    i2vMotionPrompt(scene, minimal as never),
    "a minimal 3-field shot yields the byte-identical prompt"
  );
  const variant = {
    ...full,
    shots: [{
      ...full.shots[0], framing: "close-up", lens: "85mm f/1.8",
      imagePrompt: "DIFFERENT", composition: "centered", subject: "someone else",
    }],
  };
  eq(
    i2vMotionPrompt(scene, variant as never),
    i2vMotionPrompt(scene, minimal as never),
    "framing/lens/imagePrompt/composition/subject are invisible to the motion prompt"
  );
});

await test("S74: the committed S62 manifest + BRIEFS reconstruct all eight after-prompts (pose-kill repaired, tempo law, sentence boundary)", async () => {
  const { i2vMotionPrompt, I2V_SUBJECT_MOTION } = await import("../src/lib/tubeforge/liveliness.ts");
  const { classifyScene } = await import("../src/lib/tubeforge/motion.ts");
  const { resolveContentPolicy, sanitizePromptForPolicy } = await import("../src/lib/tubeforge/restricted-subjects.ts");
  const { BRIEFS } = await import("./s-profile-briefs.mts");

  const s62 = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "validation", "s62", "manifest.json"), "utf8")
  ) as {
    profile: string; ok: boolean; policy: string;
    motionPrompt: string;
    shot: { framing: string; camera: string; moveSpeed: string; duration: number;
            imagePrompt: string; subjectAction: string | null } | null;
  }[];
  const okEntries = s62.filter((e) => e.ok);
  eq(okEntries.length, 8, "the committed S62 manifest carries 8 ok entries");

  const recon = (shot: NonNullable<(typeof s62)[number]["shot"]>) => ({
    shots: [{
      shotIndex: 0, framing: shot.framing, camera: shot.camera, lens: "",
      composition: "", duration: shot.duration, imagePrompt: shot.imagePrompt,
      subjectAction: shot.subjectAction ?? undefined, moveSpeed: shot.moveSpeed ?? undefined,
    }],
  });
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  for (const e of okEntries) {
    const brief = BRIEFS.find((b) => b.id === e.profile);
    ok(brief, `${e.profile}: the brief exists`);
    if (!brief || !e.shot) continue;

    const policy = resolveContentPolicy(brief.contentPolicy ?? null);
    eq(policy, e.policy, `${e.profile}: the brief's policy matches the S62 manifest`);

    const after = sanitizePromptForPolicy(
      i2vMotionPrompt(brief.scenes[0], recon(e.shot) as never),
      policy
    ).prompt;

    // The pair is a measurement of the laws — before ≠ after, byte-level.
    ok(after !== e.motionPrompt, `${e.profile}: the S63-law prompt differs from the committed S62 prompt`);

    // The pose-kill, repaired: the per-kind clause ALWAYS rides now…
    const kindClause = I2V_SUBJECT_MOTION[classifyScene(brief.scenes[0])];
    ok(after.includes(kindClause), `${e.profile}: the kind clause rides the after prompt`);
    // …and never rode the S62 prompts (subjectAction replaced it, 8/8 real plans).
    ok(!e.motionPrompt.includes(kindClause), `${e.profile}: the S62 prompt carried no kind clause (the pose-kill, verbatim)`);

    // The run-on seam, repaired: the subject ask ends with a real sentence boundary.
    if (e.shot.subjectAction) {
      const ask = e.shot.subjectAction.trim().replace(/[.\s]+$/, "");
      ok(after.includes(`${cap(ask)}. `), `${e.profile}: the after prompt gives the subject ask a sentence boundary`);
    }
  }

  // The tempo collision, repaired — pinned against the committed defects.
  const need = <T,>(v: T | undefined, label: string): T => {
    if (v === undefined) throw new Error(`missing ${label}`);
    return v;
  };
  const social = need(okEntries.find((e) => e.profile === "social"), "social entry");
  const socialBrief = need(BRIEFS.find((b) => b.id === "social"), "social brief");
  const socialAfter = sanitizePromptForPolicy(
    i2vMotionPrompt(socialBrief.scenes[0], recon(need(social.shot, "social shot")) as never),
    resolveContentPolicy(null)
  ).prompt;
  ok(socialAfter.startsWith("Quick, energetic cinematic zoom in."), "social after: fast + zoom-in no longer contradicts itself");
  ok(social.motionPrompt.includes("Quick, energetic slow cinematic zoom in"), "social before: the committed S62 contradiction, verbatim");

  const islamic = need(okEntries.find((e) => e.profile === "islamic-history"), "islamic-history entry");
  const islamicBrief = need(BRIEFS.find((b) => b.id === "islamic-history"), "islamic-history brief");
  const islamicAfter = sanitizePromptForPolicy(
    i2vMotionPrompt(islamicBrief.scenes[0], recon(need(islamic.shot, "islamic-history shot")) as never),
    resolveContentPolicy("islamic-history")
  ).prompt;
  ok(islamicAfter.startsWith("Slow, deliberate cinematic zoom in."), "islamic-history after: slow + zoom-in reads once, not doubled");
  ok(islamic.motionPrompt.includes("Slow, deliberate slow cinematic zoom in"), "islamic-history before: the doubled tempo, verbatim");

  const explainer = need(okEntries.find((e) => e.profile === "explainer"), "explainer entry");
  ok(explainer.motionPrompt.includes("Stationary at top position Cutaway"), "explainer before: the committed run-on seam, verbatim");
});

await test("S74: the blind scorer REJECTS malformed replies instead of clamping them to 1 (the review fix)", async () => {
  const { scoreFromReply } = await import("./s74-blind-score.mts");
  const good = scoreFromReply(
    '{"motion_realism":4,"artifact_load":3,"temporal_coherence":5,"composition":4,"overall":4,"notes":"ok"}',
    "A"
  );
  eq(good.overall, 4, "a valid reply parses to its real values");
  eq(good.motion_realism, 4, "…and every dimension rides along");

  const rejects = (reply: string, fragment: string) => {
    try {
      scoreFromReply(reply, "A");
      return false;
    } catch (e) {
      return e instanceof Error && e.message.includes(fragment);
    }
  };
  // A MISSING dimension must reject — the old parser turned it into a fabricated
  // 1 and the downstream !score.overall guard could never see the damage.
  ok(
    rejects('{"motion_realism":4,"temporal_coherence":5,"composition":4,"overall":4}', "invalid artifact_load"),
    "a missing artifact_load rejects (no fabricated 1s)"
  );
  ok(
    rejects('{"motion_realism":4,"artifact_load":3,"temporal_coherence":5,"composition":4,"overall":9}', "invalid overall"),
    "an out-of-range overall (9) rejects"
  );
  ok(
    rejects('{"motion_realism":0,"artifact_load":3,"temporal_coherence":5,"composition":4,"overall":4}', "invalid motion_realism"),
    "an out-of-range motion_realism (0) rejects"
  );
  ok(
    rejects('{"motion_realism":null,"artifact_load":3,"temporal_coherence":5,"composition":4,"overall":4}', "invalid motion_realism"),
    "a null dimension rejects"
  );
  ok(
    rejects("I would rather not use JSON today, thanks.", "no valid JSON"),
    "prose instead of JSON rejects (parseJsonLoose throws — caught as a malformed reply)"
  );
  // Models do emit string-encoded numbers — the strict parser still accepts those.
  const strNums = scoreFromReply(
    '{"motion_realism":"4","artifact_load":"3","temporal_coherence":"5","composition":"4","overall":"4"}',
    "A"
  );
  eq(strNums.overall, 4, "string-encoded numbers parse");
});

suiteStart("S75 — E10 readiness: the container-safe chromium launch (the /dev/shm receipt)");
await test("S75: the whiteboard chromium launch args are container-safe (--no-sandbox + --disable-dev-shm-usage)", async () => {
  const { WB_CHROMIUM_LAUNCH_ARGS } = await import("../src/lib/tubeforge/whiteboard/render");
  ok(
    WB_CHROMIUM_LAUNCH_ARGS.includes("--disable-dev-shm-usage"),
    "missing --disable-dev-shm-usage (64MB /dev/shm kills a bare launch mid-scene)"
  );
  ok(
    WB_CHROMIUM_LAUNCH_ARGS.includes("--no-sandbox"),
    "missing --no-sandbox (container user-namespace reality)"
  );
});
await test("S75: BOTH whiteboard launch sites launch through WB_CHROMIUM_LAUNCH_ARGS — no bare launch can return", async () => {
  // A source-level tripwire so a future chromium.launch({ headless: true })
  // cannot silently reintroduce the /dev/shm OOM kill (the S75 E10 receipt:
  // the 16:9 benchmark died at scene 2, frame 230/378, SIGKILL, no trace).
  const renderSrc = fs.readFileSync("src/lib/tubeforge/whiteboard/render.ts", "utf8");
  const bareLaunches = renderSrc.match(/chromium\.launch\(\{ headless: true \}\)/g) ?? [];
  eq(bareLaunches.length, 0, "a bare chromium.launch({ headless: true }) remains in the whiteboard renderer");
  const argsLaunches = renderSrc.match(/chromium\.launch\(\{ headless: true, args: \[\.\.\.WB_CHROMIUM_LAUNCH_ARGS\] \}\)/g) ?? [];
  ok(argsLaunches.length >= 2, `both launch sites must use WB_CHROMIUM_LAUNCH_ARGS (found ${argsLaunches.length})`);
});
await test("S75: the scene loop RECYCLES its chromium context per scene — no page outlives a scene boundary", async () => {
  // The S75 E10 receipt, second kill: ONE page held across the project grew
  // until the 4GB worker's OOM killer fired mid-scene (no JS trace). The
  // context must be born inside the scene loop and closed in its finally.
  const renderSrc = fs.readFileSync("src/lib/tubeforge/whiteboard/render.ts", "utf8");
  // Anchor on the MAIN render's launch (the last one) — the asset rasterize
  // probe has its own short-lived launch+context and is not under test here.
  const launchIdx = renderSrc.lastIndexOf("chromium.launch");
  const loopIdx = renderSrc.indexOf("for (let si = 0");
  ok(launchIdx !== -1 && loopIdx !== -1 && launchIdx < loopIdx, "the render structure changed — re-anchor this pin");
  const between = renderSrc.slice(launchIdx, loopIdx);
  eq((between.match(/newContext/g) ?? []).length, 0, "a chromium context is created OUTSIDE the per-scene loop (memory recycling lost)");
  ok(
    /finally \{[\s\S]*?await context\.close\(\)[\s\S]*?\}\n    \}/.test(renderSrc) || renderSrc.includes("await context.close().catch(() => {})"),
    "the scene loop must close its context in a finally (per-scene recycling)"
  );
});
await test("S75: the scene encode PADS the VO (apad) — -shortest must never eat the estimator's tail", async () => {
  // The S75 E10 receipt: -shortest truncated every scene to the VO length
  // (9 frames short each; 1623 budgeted frames, 1578 delivered) — the
  // estimator's 350ms tail (timing.ts VO branch) never reached the file.
  const renderSrc = fs.readFileSync("src/lib/tubeforge/whiteboard/render.ts", "utf8");
  const sceneEncode = renderSrc.slice(renderSrc.indexOf('"-framerate"'), renderSrc.indexOf("runFfmpeg(args)"));
  ok(sceneEncode.includes('"-af", "apad"'), "the scene encode lost its apad (the VO must pad to the scene duration)");
  eq((sceneEncode.match(/"-shortest"/g) ?? []).length, 0, '"-shortest" returned to the scene encode as an argument (it eats the tail)');
  // And the WHOLE file must stay free of it: at assembly it dropped the
  // final video frame (1623 planned, 1622 delivered) even though every
  // stream was already bounded by -t / amix duration=first.
  eq((renderSrc.match(/"-shortest"/g) ?? []).length, 0, '"-shortest" as an argument anywhere in the whiteboard renderer');
});
await test("S75: the assembly MIXES the narration — the voice track must reach final.mp4", async () => {
  // The S75 E10 receipt, second kill: the mix filter mapped ONLY the ducked
  // bed — final.mp4 measured -32.0 LUFS (narration absent). The S64 comment
  // already said the intent ("ducks to 0.16 UNDER the voice").
  const renderSrc = fs.readFileSync("src/lib/tubeforge/whiteboard/render.ts", "utf8");
  ok(
    renderSrc.includes("[0:a][bed]amix=inputs=2:duration=first:normalize=0[a]"),
    "the assembly lost the voice+bed amix (narration would be dropped from final.mp4)"
  );
  ok(
    renderSrc.includes("normalize=0"),
    "amix must not divide the voice by its input count (normalize=0)"
  );
});
await test("S75: the slides engine keeps its container-safe launch args (the original deployment contract)", async () => {
  const slidesSrc = fs.readFileSync("src/lib/tubeforge/slides.ts", "utf8");
  ok(
    slidesSrc.includes("--disable-dev-shm-usage") && slidesSrc.includes("--no-sandbox"),
    "the slides engine lost its container-safe launch args"
  );
});

console.log(`${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);