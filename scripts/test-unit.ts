#!/usr/bin/env bun
/**
 * TubeForge unit + regression suite — audio mixer, QC gate, music mood logic.
 *
 *   bun scripts/test-unit.ts          (also wired into `bun run check`)
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
import fs from "fs";
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

// ---------- summary ----------

console.log(`\n${"─".repeat(56)}`);
console.log(`${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
