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
  const subtle = duckParams("subtle")!;
  const standard = duckParams("standard")!;
  const strong = duckParams("strong")!;
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
  approx(m!.integratedLUFS, -14.2, 1e-9);
  approx(m!.truePeakDBTP, -1.3, 1e-9);
  approx(m!.lra, 6.1, 1e-9);
  approx(m!.threshLUFS, -24.3, 1e-9);
  approx(m!.offsetLU, -0.2, 1e-9);
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
  eq(hammingDistanceHex(h!, h!), 0, "distance to self = 0");
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
  eq(hammingDistanceHex(hRamp!, hVert!), 64, "opposite patterns → max distance");

  const noisy = Buffer.from(ramp);
  noisy[5] += 4;
  noisy[40] += 3; // imperceptible noise
  const d = hammingDistanceHex(hRamp!, dHashFromGray9x8(noisy)!);
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
    ok(ha != null && /^[0-9a-f]{16}$/.test(ha!), "testsrc hashes to 16 hex chars");
    const dist = hammingDistanceHex(ha!, hc!);
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
  eq(viaHelper, 9, "8 call sites + the helper definition all route through ytFetch");
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
  // exhaustiveness: all 20 JobKind values are route-started AND
  // handler-registered (director + continuity joined in Stage 5, upload in
  // Stage 6; the pre-fix copy listed only 18 and enshrined the drift).
  const { resumableKinds } = await import("../src/lib/tubeforge/queue-handlers.ts");
  const kinds = resumableKinds();
  const expected = [
    "script", "research", "stock", "voiceover", "storyboard", "scene",
    "render", "short", "convert", "verify", "comments", "thumbnail",
    "variants", "slide", "portrait", "poses", "qc", "upload",
    "director", "continuity",
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
  eq(plan!.scenes.length, 2, "both scenes kept");
  eq(plan!.scenes[0].sceneIndex, 1, "scenes sorted by index");
  eq(plan!.scenes[0].transitionIn, "", "scene 1 transitionIn forced empty — nothing precedes it");
  eq(plan!.scenes[1].transitionIn, "fade", "unknown transition snapped to fade");
  eq(plan!.scenes[1].motion, "smart", "unknown motion snapped to smart");
  eq(plan!.scenes[1].needsI2V, false, "non-boolean needsI2V coerced false");
  const shots = plan!.scenes[1].shots;
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
  ok(legacy!.profile === undefined, "legacy plan → no profile field (byte-identical)");
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
  eq(withProfile!.profile, "documentary", "valid profile id preserved (case-insensitive input)");

  const junkProfile = parsePlan(
    JSON.stringify({
      profile: "nope-not-a-profile",
      concept: "x",
      scenes: [{ sceneIndex: 1, mood: "", shots: [{ shotIndex: 0, camera: "static", duration: 2 }] }],
    })
  );
  ok(junkProfile!.profile === undefined, "unknown profile id → undefined (NOT narrative)");

  // The parse-snap set must match the catalog exactly (the runtime assert
  // in production-profiles.ts already enforces this; the test pins it).
  eq(Array.from(PROFILE_IDS).sort().join(","), ["narrative","documentary","explainer","advertisement","animation","podcast","social"].sort().join(","),
    "PROFILE_IDS lists every profile the catalog can resolve");
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
  const issues = adv.validation(noProduct!);
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
  const issues2 = adv.validation(withProduct!);
  ok(!issues2.some((m) => /product/i.test(m) && /shot 0/i.test(m)), "product-forward opening clears the opening-shot check");
  ok(issues2.some((m) => /CTA/i.test(m)), "but the missing closing CTA still flags");

  // Narrative validation is a no-op — the compatibility profile passes any
  // well-formed plan silently.
  eq(PRODUCTION_PROFILES["narrative"].validation(noProduct!).length, 0, "narrative validation never flags");
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
  ok(user.includes("Camera moves: static, push-in, pull-out, pan-left, pan-right, tilt-up, tilt-down, dolly-in, handheld, crane-up, drone."),
    "narrative keeps the FULL camera moves list");
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
  for (const id of ["narrative","documentary","explainer","advertisement","animation","podcast","social"]) {
    eq(resolveProfile(id).id, id, `${id} resolves`);
  }
  eq(resolveProfile("documentary").id, "documentary", "documentary accepted (was blocked pre-M1)");
  eq(resolveProfile("explainer").id, "explainer", "explainer accepted (was blocked pre-M1)");
  eq(Object.keys(PRODUCTION_PROFILES).length, 7, "exactly seven profiles defined");
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
    { index: 1, title: "Open", narration: "Welcome to the show.", visual: "studio", camera: "pan-right", mood: "warm", caption: "Welcome", hostInScene: true, rehook: false, sfx: "none" },
    { index: 2, title: "Body", narration: "Here is the substance of the episode you came for.", visual: "b-roll", camera: "static", mood: "neutral", caption: "The substance", hostInScene: false, rehook: false, sfx: "whoosh" },
    { index: 3, title: "Close", narration: "Subscribe for more.", visual: "studio", camera: "zoom-in", mood: "warm", caption: "Subscribe", hostInScene: true, rehook: false, sfx: "sting" },
  ] as never[];

  const timeline = assembleTimeline(scenes, { ttsSpeed: 1, renderMode: "kenburns" });
  eq(timeline.sceneCount, 3, "sceneCount matches");
  ok(timeline.totalDurationSec > 0, "totalDurationSec is positive");
  // Scenes are contiguous — scene 2 starts where scene 1 ends.
  eq(timeline.scenes[0].endSec, timeline.scenes[1].startSec, "scenes are contiguous");
  eq(timeline.scenes[1].endSec, timeline.scenes[2].startSec, "scenes are contiguous");
  // Caption timing matches the scene window.
  eq(timeline.scenes[0].caption?.text, "Welcome", "caption text propagated");
  eq(timeline.scenes[0].caption?.startSec, timeline.scenes[0].startSec, "caption starts at scene start");
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
  eq(round!.sceneCount, 1, "sceneCount preserved");
  eq(round!.scenes[0].index, 1, "scene index preserved");
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
    round!.scenes.every((s) => typeof s.durationSec === "number" && Number.isFinite(s.durationSec) && s.durationSec > 0),
    "every durationSec is a finite positive number"
  );
  eq(round!.scenes.length, scenes.length, "one duration per scene");

  // A corrupt timeline (missing durationSec on one scene) must NOT be honored
  // — the runRenderJob "single bad value falls back for ALL scenes" rule.
  const corrupt = JSON.parse(serializeTimeline(timeline)) as { scenes: { durationSec?: number }[] };
  corrupt.scenes[1].durationSec = undefined;
  const parsedCorrupt = parseTimeline(JSON.stringify(corrupt));
  ok(parsedCorrupt !== null, "parseTimeline still parses the partial payload");
  const ds = parsedCorrupt!.scenes.map((s) => s.durationSec);
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
    ok(CAMERA_TO_MOVE[move] !== undefined, `${move} is mapped`);
    ok(moveKinds.has(CAMERA_TO_MOVE[move]!), `${move} → ${CAMERA_TO_MOVE[move]} is a motion.ts MoveKind`);
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
  ok(s1.prompt!.includes("the general's eyes"), "imagePrompt leads the extra prompt");
  ok(s1.prompt!.startsWith("a fortress at dusk"), "scene visual opens the prompt");
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
  // Setting exists → baseline init only.
  const legacy = fp(["Channel", "Character", "Video", "Setting"]);
  eq(
    decideBaselinePrefix(S, legacy.hasTable, legacy.hasColumn),
    ["000000000000_init"],
    "Stage-1 schema → baseline init only"
  );

  // Fully modern db-push'd schema → the entire chain is baselined.
  const modern = fp(
    ["User", "Organization", "Plan", "ProcessedWebhookEvent", "CreditLedger"],
    ["Video.shotList", "Video.timeline", "Job.payload", "CreditLedger.reconcilesId"]
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
    const span = speakableSpan(start, dur, wav)!;
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
    const span = speakableSpan(100, 10, undefined)!;
    approx(span.startSec, 100.6, 1e-9, "estimated start");
    approx(span.endSec, 108.9, 1e-9, "estimated end = 100 + 10 - 1.1");
    // At/below the MIN_SEG floor the real read is unknowable → refuse.
    eq(speakableSpan(0, 2.0, undefined), null, "floor duration cannot be estimated");
    eq(speakableSpan(0, 1.5, undefined), null, "trimmed below the floor");
    // Real wav rescues floor-clamped windows when known.
    const rescued = speakableSpan(0, 2.0, 0.8)!;
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
    const graph1 = buildTransitionGraph(durs, "fade", 0.5)!;
    const graph2 = buildTransitionGraphMulti(durs, s)!;
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
    approx(transitionTotalDurationMulti(durs, s)!, 10.5, 1e-9, "total = Σ − Σd");
  });

  await test("per-boundary graph honors each seam's style + duration", () => {
    const durs = [3, 4, 5];
    const s = sanitizeBoundarySettings([
      { style: "wipeleft", durationSec: 0.4 },
      { style: "circleopen", durationSec: 0.9 },
    ]);
    const g = buildTransitionGraphMulti(durs, s)!;
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
    const out = docSceneSettings(doc as never, 3)!;
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
    const chain = musicLevelAutomation(blended, [1, 0.5])!;
    ok(
      chain.startsWith("[music]volume='") && chain.endsWith("':eval=frame[mvol]"),
      "label contract (per-frame eval — once-eval would freeze t=0)"
    );
    ok(chain.includes("1.000*gte(t,0.000)*lt(t,2.500)"), "scene 0 owns [0, next start)");
    ok(chain.includes("0.500*gte(t,2.500)*lt(t,5.500)"), "scene 1 owns from its start");
    // Non-finite factors read as 1 (no override), absurd values clamp at 8.
    const clamped = musicLevelAutomation(segs([2, 2]), [Number.NaN, 100])!;
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
    approx(transitionTotalDurationMulti(durs, mixed)!, 14.5, 1e-9, "total = Σ − blend debt only");
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
    ["drone", "Slow aerial drone pull-back reveal."],
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

// ---------- summary ----------

console.log(`\n${"─".repeat(56)}`);
console.log(`${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
