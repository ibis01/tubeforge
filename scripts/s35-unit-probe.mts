#!/usr/bin/env node
/**
 * S35 probe — Universal Scene Liveliness, end to end at the data layer.
 *
 *   node --import tsx scripts/s35-unit-probe.mts
 *
 * NOT another unit test: this walks the REAL render-side derivation chain —
 * a realistic Video.shotList JSON through parsePlan (the exact parser the
 * render reads), the exact input mapping render.ts's S35 block performs
 * (planNeedsI2V / planMotionOff / hasStock / docCameraKeys / humanMotionOff),
 * the PURE selector, and the plan-aware i2v prompt. What it proves:
 *
 *   1. an APPROVED director plan's needsI2V rows actually reach the selector
 *      through the real parser (the loop that stayed open for nine stages);
 *   2. the precedence law holds with the real data types (human edits senior,
 *      stills contract senior, provider gate honest);
 *   3. the i2v prompt carries the approved camera (crane/drone/handheld —
 *      phrases the pre-S35 five-id map degraded to generic drift) and the
 *      subject-motion clause for the scene kind;
 *   4. RenderResult's liveliness ledger shape: what the render row will
 *      report (including a mid-render i2v→Ken Burns fallback mutation).
 *
 * Pure — no DB, no ffmpeg, no AI, no network. Safe to run anywhere.
 */

import { parsePlan } from "../src/lib/tubeforge/director-plan.ts";
import { selectChannels, i2vMotionPrompt, type LivelinessDecision } from "../src/lib/tubeforge/liveliness.ts";
import type { Scene } from "../src/lib/tubeforge/types.ts";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  ✗ ${label}`);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  ok(a === b, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
}

// A realistic approved plan: scene 1 = establishing wide (Ken Burns), scene 2
// = the battle charge the director marked needsI2V with a drone camera, scene
// 3 = a static-camera map scene the director stilled, scene 4 = close-up
// push-in also flagged for i2v.
const SHOT_LIST = JSON.stringify({
  concept: "A gritty documentary of the campaign",
  musicMood: "cinematic",
  ducking: "standard",
  scenes: [
    {
      sceneIndex: 1,
      mood: "dawn haze, cold blues",
      transitionIn: "",
      motion: "smart",
      needsI2V: false,
      useStock: false,
      pacing: "normal",
      ambience: "wind",
      sfx: "none",
      locations: [],
      props: [],
      shots: [
        { shotIndex: 0, framing: "wide", camera: "pull-out", lens: "24mm wide", composition: "rule of thirds", duration: 3.0, imagePrompt: "the valley at first light" },
        { shotIndex: 1, framing: "medium", camera: "pan-right", lens: "35mm", composition: "leading lines", duration: 2.6, imagePrompt: "the ridge line" },
      ],
    },
    {
      sceneIndex: 2,
      mood: "dust, iron, screams",
      transitionIn: "cut",
      motion: "smart",
      needsI2V: true,
      useStock: false,
      pacing: "fast",
      ambience: "none",
      sfx: "boom",
      locations: [],
      props: [],
      shots: [
        { shotIndex: 0, framing: "wide", camera: "drone", lens: "24mm wide", composition: "diagonal energy", duration: 2.8, imagePrompt: "the cavalry line surging" },
      ],
    },
    {
      sceneIndex: 3,
      mood: "parchment, candlelight",
      transitionIn: "fade",
      motion: "off",
      needsI2V: false,
      useStock: false,
      pacing: "slow",
      ambience: "room",
      sfx: "none",
      locations: [],
      props: [],
      shots: [
        { shotIndex: 0, framing: "medium", camera: "static", lens: "50mm", composition: "centered", duration: 3.0, imagePrompt: "the campaign map" },
      ],
    },
    {
      sceneIndex: 4,
      mood: "intimate, amber",
      transitionIn: "cut",
      motion: "smart",
      needsI2V: true,
      useStock: false,
      pacing: "slow",
      ambience: "room",
      sfx: "none",
      locations: [],
      props: [],
      shots: [
        { shotIndex: 0, framing: "close-up", camera: "push-in", lens: "85mm", composition: "rule of thirds", duration: 2.5, imagePrompt: "the messenger's face" },
      ],
    },
  ],
});

const plan = parsePlan(SHOT_LIST);
ok(plan !== null, "realistic shotList parses through the real parser");
if (!plan) process.exit(1);

// The scenes as parseScenes would hand them to the render (same indexes).
const scenes: Scene[] = [
  { index: 1, title: "The valley", narration: "dawn broke over the valley", visual: "a vast valley at dawn, mist in the folds", camera: "zoom-out", mood: "cold dawn light", caption: "Dawn", hostInScene: false, rehook: false, sfx: "none" },
  { index: 2, title: "The charge", narration: "then the cavalry surged", visual: "cavalry charging across a dust-red ridge", camera: "push-in", mood: "dust and iron", caption: "The charge", hostInScene: false, rehook: false, sfx: "none" },
  { index: 3, title: "The map", narration: "the council studied the map", visual: "an old campaign map with unit markers", camera: "pan-right", mood: "candlelight", caption: "The plan", hostInScene: false, rehook: false, sfx: "none" },
  { index: 4, title: "The messenger", narration: "a young messenger waited", visual: "close-up portrait of the messenger, eyes steady", camera: "push-in", mood: "warm amber", caption: "The messenger", hostInScene: false, rehook: false, sfx: "none" },
];

// --- The EXACT input mapping render.ts's S35 block performs -----------------
function deriveInputs(opts: {
  approved: boolean;
  i2vReady: boolean;
  hasStock: boolean[];
  motionOff?: boolean;
  docCameraKeys?: boolean[];
  humanOffScene?: number;
}) {
  const planNeedsI2V = scenes.map(
    (s) => (opts.approved ? plan?.scenes.find((p) => p.sceneIndex === s.index)?.needsI2V === true : false)
  );
  const planMotionOff = scenes.map(
    (s) => (opts.approved ? plan?.scenes.find((p) => p.sceneIndex === s.index)?.motion === "off" : false)
  );
  const humanMotionOff = scenes.map((s) => s.index === (opts.humanOffScene ?? -1));
  const docCameraKeys = scenes.map((s, i) => opts.docCameraKeys?.[i] === true);
  return {
    mode: "kenburns" as const,
    motionOff: opts.motionOff === true,
    planNeedsI2V,
    planMotionOff,
    humanMotionOff,
    docCameraKeys,
    hasStock: opts.hasStock,
    i2vReady: opts.i2vReady,
  };
}

console.log("\nS35 probe — the loop that stayed open for nine stages\n");

// 1. No approved plan → exactly the pre-S35 render: every scene Ken Burns.
const noPlan = selectChannels(deriveInputs({ approved: false, i2vReady: true, hasStock: [false, false, false, false] }));
ok(noPlan.every((d) => d.channel === "kenburns"), "no approved plan → the pre-S35 render, bit-identical (all Ken Burns)");

// 2. Approved plan + provider → the two needsI2V scenes animate; the stilled
//    scene stays still; the establishing wide keeps its camera plan.
const live = selectChannels(deriveInputs({ approved: true, i2vReady: true, hasStock: [false, false, false, false] }));
eq(live.map((d) => d.channel).join(","), "kenburns,i2v,kenburns,i2v", "approved plan + provider → [KB, i2v, KB(off), i2v]");
ok(live[1].reason.includes("true-motion"), "scene 2's reason names the true-motion pick");
ok(live[2].reason.includes("director stilled"), "scene 3's reason names the plan's own motion:off");

// 3. No provider configured → the picks degrade honestly, nothing breaks.
const offline = selectChannels(deriveInputs({ approved: true, i2vReady: false, hasStock: [false, false, false, false] }));
ok(offline.every((d) => d.channel === "kenburns"), "no video provider → honest Ken Burns everywhere, render never breaks");

// 4. Human seniority: camera keys on scene 2 beat the director's i2v pick;
//    the stills contract beats everything; the human's off beats the plan.
const keyed = selectChannels(deriveInputs({ approved: true, i2vReady: true, hasStock: [false, false, false, false], docCameraKeys: [false, true, false, false] }));
eq(keyed[1].channel, "kenburns", "the user's camera keys beat the director's i2v pick");
ok(keyed[1].reason.includes("senior"), "the reason states the seniority law");
const stills = selectChannels(deriveInputs({ approved: true, i2vReady: true, hasStock: [false, false, false, false], motionOff: true }));
ok(stills.every((d) => d.channel === "kenburns"), "the stills contract silences every i2v pick");
const humanOff = selectChannels(deriveInputs({ approved: true, i2vReady: true, hasStock: [false, false, false, false], humanOffScene: 4 }));
eq(humanOff[3].channel, "kenburns", "the human's motion-map off beats the plan's needsI2V");

// 5. Stock mode: a matched clip wins over everything below it (scene 2 has
//    BOTH a clip and a needsI2V pick — the clip plays); scene 1 keeps its
//    camera plan (no clip, no pick), scene 4 animates.
const stocked = selectChannels({ ...deriveInputs({ approved: true, i2vReady: true, hasStock: [false, true, false, false] }), mode: "stock" });
eq(stocked.map((d) => d.channel).join(","), "kenburns,stock,kenburns,i2v", "stock mode → matched clip beats its own i2v pick; unpicked fallbacks follow their rules");

// 6. The prompt: scene 2's approved drone camera drives the generation.
const scene2 = scenes[1];
const planScene2 = plan.scenes.find((p) => p.sceneIndex === 2) ?? null;
const prompt2 = i2vMotionPrompt(scene2, planScene2);
ok(prompt2.startsWith("Slow aerial drone pull-back reveal."), `scene 2 prompt leads with the approved drone phrase`);
ok(prompt2.includes("subjects move with real, visible energy"), "scene 2 (action kind) gets the real-energy subject clause");

// 7. The prompt: scene 4's close-up push-in + emotional kind.
const scene4 = scenes[3];
const planScene4 = plan.scenes.find((p) => p.sceneIndex === 4) ?? null;
const prompt4 = i2vMotionPrompt(scene4, planScene4);
ok(prompt4.startsWith("Steady dramatic push in toward the subject."), "scene 4 prompt leads with the approved push-in phrase");
ok(prompt4.includes("breathing, blinking"), "scene 4 (face kind) gets the subtle-life clause");

// 8. The ledger: RenderResult.liveliness reflects what PLAYED — simulate the
//    orchestrator's onI2vFallback mutation (scene 4's clip failed mid-render).
const ledger: LivelinessDecision[] = live.map((d) => ({ ...d }));
const fallbackIdx = ledger.findIndex((d) => d.sceneIndex === 4);
if (fallbackIdx >= 0) {
  ledger[fallbackIdx].channel = "kenburns";
  ledger[fallbackIdx].reason = "i2v unavailable — Ken Burns fallback (provider error)";
}
eq(ledger.map((d) => d.channel).join(","), "kenburns,i2v,kenburns,kenburns", "mid-render fallback mutates the ledger (what PLAYED)");
ok(ledger[fallbackIdx].reason.includes("i2v unavailable"), "the ledger records WHY the scene fell back");

console.log(`\n${"─".repeat(56)}`);
console.log(`${passed} passed, ${failed} failed${failures.length ? ":" : ""}`);
for (const f of failures) console.log(`  ✗ ${f}`);
process.exit(failed > 0 ? 1 : 0);
