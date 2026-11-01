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
import type { Scene } from "../src/lib/tubeforge/types";

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
  ok(f.includes("alimiter=limit=0.891:level=false"), f);
  ok(f.includes("aresample=48000"), f);
});

await test("normalizationFilter(m): linear two-pass with measurement + limiter + 48k", () => {
  const f = normalizationFilter(GOOD_MEASURE);
  ok(f.includes("measured_I=-14.20"), f);
  ok(f.includes("measured_TP=-1.30"), f);
  ok(f.includes("measured_LRA=6.10"), f);
  ok(f.includes("measured_thresh=-24.30"), f);
  ok(f.includes("offset=-0.20:linear=true"), f);
  ok(f.includes("alimiter=limit=0.891"), f);
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
  // SAFETY: this test process must NEVER claim real jobs from the live DB —
  // set before the first queue.ts import so its module state sees it.
  process.env.TUBEFORGE_NO_CLAIM = "1";
  const queue = await import("../src/lib/tubeforge/queue.ts");
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
  // in review); every one must be resumable after a crash. "upload" is the
  // ONLY kind without a handler — YouTube publishing wiring is Stage 6 and
  // nothing enqueues it yet.
  const { resumableKinds } = await import("../src/lib/tubeforge/queue-handlers.ts");
  const kinds = resumableKinds();
  const expected = [
    "script", "research", "stock", "voiceover", "storyboard", "scene",
    "render", "short", "convert", "verify", "comments", "thumbnail",
    "variants", "slide", "portrait", "poses",
  ];
  for (const k of expected) {
    ok(kinds.includes(k), `"${k}" is resumable`);
  }
  eq(kinds.length, expected.length, "no unexpected resumable kinds");
  ok(!kinds.includes("upload"), `"upload" (Stage 6) is not claimed by handlers`);
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

// ---------- summary ----------

console.log(`\n${"─".repeat(56)}`);
console.log(`${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
