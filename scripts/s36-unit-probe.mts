#!/usr/bin/env node
/**
 * S36 probe — render QC lenses, the property space the unit tests sample.
 *
 *   node --import tsx scripts/s36-unit-probe.mts
 *
 * Pure — no DB, no ffmpeg, no AI, no network. Safe to run anywhere. (The
 * shells themselves were live-calibrated against ffmpeg 7.1.5 during the
 * build: white/black 2.5 Hz pumping, a red/blue hard cut at 3.0 s, a
 * setpts-clamped 59-duplicate stutter.mkv, and a 0.5 s xfade that the
 * blend window correctly explains. This probe pins the pure cores around
 * those calibrated points.)
 *
 * What it proves beyond test-unit.mts:
 *   1. flicker magnitude boundary — swings at/below magMin never pump,
 *      the gap budget (maxGapSamples) actually bounds run length, and one
 *      contiguous pump records exactly one event (run-end semantics);
 *   2. stutter edge space — empty/single inputs, the dupRunMin boundary
 *      (7 links stay clean, 8 flag), float-noise pts jitter;
 *   3. alignCuts tolerance edges — detections just inside ±tol explain,
 *      one frame past is stray, window edges inclusive with tol baked in;
 *   4. expectedCutsForTimeline against the slides-native all-cut grammar
 *      and a four-scene mixed catalog (offsets = the render's own math).
 */

import {
  flickerEventsFromLuma,
  stutterFromPts,
  alignCuts,
  expectedCutsForTimeline,
  FLICKER_SAMPLE,
  STUTTER_LIMITS,
  CUT_TOL_SEC,
} from "../src/lib/tubeforge/render-qc.ts";
import type { ExpectedCuts } from "../src/lib/tubeforge/render-qc.ts";
import type { TransitionSettings } from "../src/lib/tubeforge/transitions.ts";

let passed = 0;
const failures: string[] = [];
function ok(cond: unknown, msg: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}
function eq<T>(actual: T, expected: T, label = "value"): void {
  ok(Object.is(actual, expected), `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

console.log("S36 probe — flicker lens");

// 1a. delta-magnitude boundary: the detector thresholds SAMPLE-TO-SAMPLE
//     deltas, not amplitude — a sine of amplitude A at 8 Hz sampling has
//     max delta 2A·sin(π·2.5/8) ≈ 1.85·A. A=6 peaks under magMin (isolated
//     strong deltas are cuts/pops, correctly not pumping); A=12 puts nearly
//     every sample over the floor and the alternation accumulates.
{
  const quiet: number[] = [];
  for (let i = 0; i < 80; i++) {
    quiet.push(128 + 6 * Math.sin((2 * Math.PI * 2.5 * i) / FLICKER_SAMPLE.fps));
  }
  eq(flickerEventsFromLuma(quiet).length, 0, "sub-floor deltas never accumulate pumping");
  const loud: number[] = [];
  for (let i = 0; i < 80; i++) {
    loud.push(128 + 12 * Math.sin((2 * Math.PI * 2.5 * i) / FLICKER_SAMPLE.fps));
  }
  ok(flickerEventsFromLuma(loud).length >= 1, "sustained over-floor pumping flags");
}

// 1b. gap budget: TWO weak samples between strong deltas keep the run alive
//     (the block already ends at 128; one more makes the interlude), three end it
{
  const tolerant: number[] = [];
  const block = (sign: 1 | -1): number[] => [128, 128 + sign * 20, 128, 128 + -sign * 20, 128];
  for (let k = 0; k < 3; k++) tolerant.push(...block(k % 2 === 0 ? 1 : -1), 128);
  eq(flickerEventsFromLuma(tolerant).length, 1, "budgeted interludes keep ONE pumping episode");
  const broken: number[] = [];
  for (let k = 0; k < 6; k++) broken.push(...block(k % 2 === 0 ? 1 : -1), 128, 128, 128, 128, 128);
  ok(flickerEventsFromLuma(broken).length === 0, "3+ weak samples between strong deltas ends the run (rhythmic cuts, not flicker)");
}

// 1c. one contiguous pump = exactly one event, recorded at run-end — pumps
//     separated by silence stay separate episodes
{
  const luma: number[] = [];
  const pump = (): number[] => {
    const p: number[] = [];
    for (let i = 0; i < 12; i++) p.push(128 + (i % 2 === 0 ? 40 : 88));
    return p;
  };
  luma.push(...pump(), ...Array(40).fill(128), ...pump(), ...Array(40).fill(128), ...pump());
  const events = flickerEventsFromLuma(luma);
  eq(events.length, 3, "three separated pumps = three ledger events");
  ok(events[0].startSec < 1, "first event at the first pump");
  const lastPumpStart = (12 + 40 + 12 + 40) / FLICKER_SAMPLE.fps;
  ok(events[2].startSec > lastPumpStart - 1.5, "third event at the third pump");
  ok(events[0].alternations >= 8, `one episode accumulates its swings (got ${events[0].alternations})`);
}

console.log("S36 probe — stutter lens");

// 2a. degenerate inputs
{
  eq(stutterFromPts([], 30).dupRuns.length, 0, "empty pts → nothing");
  eq(stutterFromPts([0], 30).gaps.length, 0, "single pts → nothing");
  eq(stutterFromPts([0, 1], 0).dupRuns.length, 0, "invalid fps → nothing");
  eq(stutterFromPts([0, 1], NaN).gaps.length, 0, "NaN fps → nothing");
}

// 2b. dupRunMin boundary: 7 linked frames stay clean, 8 flag
{
  const base: number[] = [];
  for (let i = 0; i < 60; i++) base.push(i / 30);
  const with7 = [...base.slice(0, 20), base[19], base[19], base[19], base[19], base[19], base[19], ...base.slice(20)];
  eq(stutterFromPts(with7, 30).dupRuns.length, 0, "7-frame duplication run stays under the limit");
  const with8 = [...base.slice(0, 20), base[19], base[19], base[19], base[19], base[19], base[19], base[19], ...base.slice(20)];
  eq(stutterFromPts(with8, 30).dupRuns.length, 1, `8-frame run flags (limit ${STUTTER_LIMITS.dupRunMin})`);
}

// 2c. float jitter around the dup threshold: sub-2ms pts noise reads as
//     duplicated links, but a 3-frame run sits far under dupRunMin — clean
{
  const jittery = [0, 0.0009, 0.0018, 0.0333, 0.0342, 0.0666];
  const out = stutterFromPts(jittery, 30);
  eq(out.dupRuns.length, 0, `sub-limit jitter stays clean (limit ${STUTTER_LIMITS.dupRunMin})`);
  eq(out.gaps.length, 0, "jitter never reads as gaps");
}

console.log("S36 probe — cut-alignment lens");

// 3a. tolerance edges (0.01 inside/outside — the exact ±tol boundary is
//     floating-point unstable and not a contract)
{
  const exp: ExpectedCuts = { cuts: [4], windows: [] };
  eq(alignCuts([4 + CUT_TOL_SEC - 0.01], exp).unexpected.length, 0, "detection just inside +tol explains");
  eq(alignCuts([4 - CUT_TOL_SEC + 0.01], exp).unexpected.length, 0, "detection just inside −tol explains");
  eq(alignCuts([4 - CUT_TOL_SEC - 0.01], exp).unexpected.length, 1, "just past tol is stray");
}

// 3b. window edges are inclusive with tol baked in
{
  const exp: ExpectedCuts = { cuts: [], windows: [[2.2, 3.3]] };
  eq(alignCuts([2.2 - CUT_TOL_SEC], exp).unexpected.length, 0, "just below a window explains");
  eq(alignCuts([3.3 + CUT_TOL_SEC], exp).unexpected.length, 0, "just above a window explains");
  eq(alignCuts([3.3 + CUT_TOL_SEC + 0.05], exp).unexpected.length, 1, "beyond window+tol is stray");
}

// 3c. a hard cut the pixels DO show inside a blend window is not "missing"
//     (the expectation carries no cut there) — but a missing hard cut with
//     a NEARBY detection outside tol still fails
{
  const exp: ExpectedCuts = { cuts: [5], windows: [[2.2, 3.3]] };
  eq(alignCuts([2.8], exp).missing.length, 1, "blend detection does not excuse a hard cut elsewhere");
  eq(alignCuts([5.05, 2.8], exp).missing.length, 0, "hard cut found → no missing");
}

console.log("S36 probe — expectation builder");

// 4a. slides-native grammar: every boundary a hard cut
{
  const settings: TransitionSettings[] = [
    { style: "cut", durationSec: 0.5 },
    { style: "cut", durationSec: 0.5 },
    { style: "cut", durationSec: 0.5 },
  ];
  const exp = expectedCutsForTimeline([4, 3, 5, 2], settings);
  eq(exp.cuts.length, 3, "three cut boundaries");
  eq(exp.windows.length, 0, "no blend windows");
  ok(Math.abs(exp.cuts[0] - 4) < 1e-9 && Math.abs(exp.cuts[1] - 7) < 1e-9 && Math.abs(exp.cuts[2] - 12) < 1e-9,
    `cut offsets accumulate without debt (got ${exp.cuts.join(",")})`);
}

// 4b. four-scene mixed catalog: blends carry duration debt forward
{
  const settings: TransitionSettings[] = [
    { style: "fade", durationSec: 1.0 },
    { style: "cut", durationSec: 0.5 },
    { style: "wipeleft", durationSec: 0.8 },
  ];
  const exp = expectedCutsForTimeline([4, 3, 5, 2], settings);
  eq(exp.cuts.length, 1, "only the hard boundary expects a cut");
  ok(Math.abs(exp.cuts[0] - 6) < 1e-9, `cut at 4+3−1.0 = 6.0 (got ${exp.cuts[0]})`);
  eq(exp.windows.length, 2, "two blend windows");
  ok(Math.abs(exp.windows[0][0] - 2.7) < 1e-9, `fade window opens at 3.0−0.3 (got ${exp.windows[0][0]})`);
  // wipe boundary: acc = 4+3+5 = 12; the debt counts the fade AND the
  // wipe's own duration (the render's xfade offset formula — a blend
  // consumes its duration from the cumulative tail before its own seam)
  ok(Math.abs(exp.windows[1][0] - 9.9) < 1e-9, `wipe window opens at 10.2−0.3 (got ${exp.windows[1][0]})`);
  ok(Math.abs(exp.windows[1][1] - 11.3) < 1e-9, `wipe window closes at 10.2+0.8+0.3 (got ${exp.windows[1][1]})`);
}

// 4c. degenerate durations clamp at zero like the render's own math
{
  const exp = expectedCutsForTimeline([0.2, 3], [{ style: "cut", durationSec: 0.5 }]);
  ok(exp.cuts[0] >= 0, "offset never negative");
  eq(exp.cuts[0], 0.2, "sub-debt boundary floors at its natural position");
}

console.log("S36 probe — malformed stream tolerance");

// 5. parsers never throw on garbage; garbage yields empty (→ unmeasured upstream)
{
  const { parseYavgLog, parsePtsCsv, parseSceneCuts } = await import("../src/lib/tubeforge/render-qc.ts");
  eq(parseYavgLog("total garbage\nno metrics here").length, 0, "YAVG parser on garbage → []");
  eq(parsePtsCsv("N/A\n-1.5\n\nnone\n").length, 0, "pts parser drops N/A, negatives, blanks");
  eq(parseSceneCuts("[Parsed_showinfo_1 @ 0x0] no time here\nframe= 1 fps=0").length, 0, "showinfo parser skips pts_time-less lines");
}

// ---------- summary ----------

console.log(`\n${"─".repeat(56)}`);
console.log(`${passed} passed, ${failures.length} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failures.length > 0 ? 1 : 0);
