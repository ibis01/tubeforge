#!/usr/bin/env node
/**
 * P5 — the production profiles battery + the five-subject benchmark fill
 * pins (the benchmark stage's law set).
 *
 *   node --import tsx scripts/test-whiteboard-profiles.mts
 *
 * The pins:
 *   1. PROFILE ROSTER — the five ids, each meta complete, the classic
 *      recipe IS the house baseline shape (marker/scale1/clean/white/no
 *      sfx), every recipe field maps onto a knob the pipeline already
 *      reads (no new grammar).
 *   2. APPLIER — pure (input never mutated, deterministic), absent/null/
 *      unknown id = byte-identical project, the recipe bakes (hand, sfx,
 *      paper, board defaults), AUTHORED choices survive (a non-default
 *      paper, an explicit board policy), the stamp rides.
 *   3. VALIDATOR — a profiled project passes; an unknown profile id is a
 *      validation ERROR naming the roster; an absent profile parses to an
 *      absent field (byte-identity with the pre-P5 shape).
 *   4. SCAFFOLD — profileId bakes through the native scaffold AND survives
 *      regeneration shape (hand/paper/board on the scaffolded doc);
 *      absent profileId = byte-identical legacy scaffold.
 *   5. SUBJECT FILL — the five slots are ACTIVE with five scenarios each;
 *      the subject builders are deterministic, in-canvas, and validate
 *      against the real library; every subject's clock is the W1 clock
 *      (38.0 s); the sample/seam plans are inside the spans.
 *   6. I.8 LAN — the islamic-history slot carries its policy id; its
 *      builder refuses out-of-allowlist assets; its authored narrations
 *      pass scanRestrictedSubjects clean; the allowlist covers every
 *      asset the set actually places.
 *   7. W1 FREEZE — buildBenchmarkProject's canonical JSON hashes are the
 *      pinned bytes (recompute ONLY through the freeze procedure: edit →
 *      re-derive → update pins → receipts diffed in the worklog).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ISLAMIC_SUBJECT_ASSET_ALLOWLIST,
  SUBJECT_IDS,
  W1_ASPECT_IDS,
  W1_SUBJECT_SLOTS,
  buildBenchmarkProject,
  buildSubjectBenchmarkProject,
  subjectSamplePlan,
  subjectSeamPlan,
  subjectSpans,
  subjectTotalDurationMs,
} from "../src/lib/tubeforge/whiteboard/benchmark-scenarios";
import {
  WHITEBOARD_PROFILES,
  WHITEBOARD_PROFILE_IDS,
  WB_DEFAULT_SCENE_BACKGROUND,
  applyWhiteboardProfile,
  resolveWhiteboardProfile,
} from "../src/lib/tubeforge/whiteboard/profiles";
import { scaffoldWhiteboardProject, type ScaffoldSceneInput } from "../src/lib/tubeforge/whiteboard/whiteboard-planner";
import { loadLibrary } from "../src/lib/tubeforge/whiteboard/assets";
import { validateWhiteboardProject, type WhiteboardProject } from "../src/lib/tubeforge/whiteboard/storyboard";
import { scanRestrictedSubjects } from "../src/lib/tubeforge/restricted-subjects";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    fail++;
    const msg = e instanceof Error ? e.message : String(e);
    fails.push(`${name}: ${msg.split("\n")[0].slice(0, 220)}`);
    console.log(`  FAIL ${name} — ${msg.split("\n")[0].slice(0, 220)}`);
  }
}

const jsonOf = (p: unknown): string => JSON.stringify(p);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

// A small deterministic test project (two scenes, authored defaults only).
function baseProject(): WhiteboardProject {
  return {
    title: "pin base",
    width: 1920,
    height: 1080,
    fps: 24,
    hand: { style: "marker", scale: 1 },
    scenes: [
      { id: "s1", narration: "one", durationMs: 4000, background: "#ffffff", placements: [], animations: [], camera: [] },
      { id: "s2", narration: "two", durationMs: 4000, background: "#ffffff", placements: [], animations: [], camera: [] },
    ],
  };
}

const SCENE_INPUTS: ScaffoldSceneInput[] = [
  { index: 0, headline: "How a bridge holds", narration: "The deck leans on the cables.", durationMs: 5000 },
  { index: 1, headline: "Follow the load", narration: "Cables lean on towers, towers lean on rock.", durationMs: 5000 },
];

console.log("\n== 1. PROFILE ROSTER ==");
check("five profiles exist with complete meta", () => {
  assert.equal(WHITEBOARD_PROFILE_IDS.length, 5);
  for (const id of WHITEBOARD_PROFILE_IDS) {
    const meta = WHITEBOARD_PROFILES[id];
    assert.ok(meta.label.length > 0, `${id} label`);
    assert.ok(meta.description.length > 20, `${id} description`);
    assert.ok(meta.recipe.hand, `${id} hand`);
    assert.ok(["marker", "pencil", "chalk"].includes(meta.recipe.hand.style), `${id} hand style`);
    assert.ok(meta.recipe.hand.scale >= 0.2 && meta.recipe.hand.scale <= 4, `${id} hand scale`);
    if (meta.recipe.sceneBackground !== undefined) {
      assert.ok(["#ffffff", "#f8f5ee"].includes(meta.recipe.sceneBackground), `${id} paper is a house paper`);
    }
    if (meta.recipe.board !== undefined) {
      assert.ok(["clean", "continuous"].includes(meta.recipe.board.mode), `${id} board mode`);
    }
  }
});
check("classic recipe IS the house baseline shape", () => {
  const r = WHITEBOARD_PROFILES["classic-whiteboard"].recipe;
  assert.equal(r.hand.style, "marker");
  assert.equal(r.hand.scale, 1);
  assert.equal(r.hand.side, undefined);
  assert.equal(r.sfxOn, false);
  assert.equal(r.sceneBackground, "#ffffff");
  assert.deepEqual(r.board, { mode: "clean" });
});
check("resolveWhiteboardProfile: known ids resolve, unknown/absent are null", () => {
  assert.equal(resolveWhiteboardProfile("storytelling")?.id, "storytelling");
  assert.equal(resolveWhiteboardProfile("no-such-profile"), null);
  assert.equal(resolveWhiteboardProfile(undefined), null);
  assert.equal(resolveWhiteboardProfile(null), null);
  assert.equal(resolveWhiteboardProfile(""), null);
});

console.log("\n== 2. APPLIER ==");
check("absent/null/unknown id returns the project byte-identical", () => {
  for (const id of [undefined, null, "", "no-such-profile"]) {
    const p = baseProject();
    const out = applyWhiteboardProfile(p, id);
    assert.equal(jsonOf(out.project), jsonOf(p), `id=${String(id)}`);
    assert.equal(out.report.applied, null, `id=${String(id)}`);
  }
});
check("apply is PURE: input never mutated, output deterministic", () => {
  const p = baseProject();
  const before = jsonOf(p);
  const a = applyWhiteboardProfile(p, "storytelling");
  const b = applyWhiteboardProfile(p, "storytelling");
  assert.equal(jsonOf(p), before, "input untouched");
  assert.equal(jsonOf(a.project), jsonOf(b.project), "two applies deep-equal");
});
check("storytelling bakes hand, sfx, paper and continuous board + stamp", () => {
  const p = baseProject();
  const { project: out, report } = applyWhiteboardProfile(p, "storytelling");
  assert.equal(out.profile, "storytelling");
  assert.equal(out.hand.style, "pencil");
  assert.equal(out.hand.scale, 1.05);
  assert.equal(out.sfxOn, true);
  assert.equal(out.scenes.every((s) => s.background === "#f8f5ee"), true);
  assert.equal(out.scenes.every((s) => s.board?.mode === "continuous" && s.board?.exit === "keep"), true);
  assert.deepEqual(report.backgroundsChanged.sort(), ["s1", "s2"]);
  assert.equal(report.handChanged, true);
  assert.equal(report.sfxChanged, true);
});
check("AUTHORED choices survive: non-default paper and explicit board never overridden", () => {
  const p = baseProject();
  p.scenes[0].background = "#f8f5ee"; // id "s1" — cream, authored
  p.scenes[1].board = { mode: "continuous", exit: "fade" }; // id "s2" — authored
  const { project: out, report } = applyWhiteboardProfile(p, "modern-motion");
  // s1's cream paper is authored → the white recipe does NOT touch it.
  assert.equal(out.scenes[0].background, "#f8f5ee");
  // s2's explicit board survives the pan-away default.
  assert.deepEqual(out.scenes[2 - 1].board, { mode: "continuous", exit: "fade" });
  // s2's DEFAULT-white paper rides the recipe's own white (no change).
  assert.equal(out.scenes[1].background, "#ffffff");
  // The reports speak the truth: no background changed at all (s1 authored,
  // s2 recipe-white == default-white); only the unauthored s1 board got the
  // modern-motion default.
  assert.deepEqual(report.backgroundsChanged, []);
  assert.deepEqual(report.boardPoliciesChanged, ["s1"]);
  assert.deepEqual(out.scenes[0].board, { mode: "clean", exit: "pan-away" });
});
check("modern-motion bakes pan-away exits and the bolder pen", () => {
  const { project: out } = applyWhiteboardProfile(baseProject(), "modern-motion");
  assert.equal(out.hand.scale, 1.2);
  assert.equal(out.sfxOn, false, "modern-motion pins audio off (its own recipe)");
  assert.equal(out.scenes.every((s) => s.board?.exit === "pan-away"), true);
});

console.log("\n== 3. VALIDATOR ==");
const lib = loadLibrary();
check("a profiled project validates; the stamp round-trips", () => {
  const { project } = applyWhiteboardProfile(baseProject(), "technical-engineering");
  const v = validateWhiteboardProject(JSON.parse(jsonOf(project)), lib.libraryIndex);
  assert.ok(v.project, `errors: ${v.errors.join(" · ")}`);
  assert.equal(v.project?.profile, "technical-engineering");
});
check("an unknown profile id is a validation ERROR naming the roster", () => {
  const p = JSON.parse(jsonOf(baseProject()));
  p.profile = "vaporwave";
  const v = validateWhiteboardProject(p, lib.libraryIndex);
  assert.equal(v.project, null);
  assert.ok(v.errors.some((e) => e.includes("vaporwave") && e.includes("classic-whiteboard")));
});

console.log("\n== 4. SCAFFOLD ==");
check("profileId bakes through the native scaffold", () => {
  const p = scaffoldWhiteboardProject({ scenes: SCENE_INPUTS, topic: "Bridges", profileId: "storytelling" });
  assert.equal(p.profile, "storytelling");
  assert.equal(p.hand.style, "pencil");
  assert.equal(p.sfxOn, true);
  assert.equal(p.scenes.every((s) => s.board?.mode === "continuous"), true);
});
check("absent profileId = the legacy scaffold (no stamp, house defaults)", () => {
  const p = scaffoldWhiteboardProject({ scenes: SCENE_INPUTS, topic: "Bridges" });
  assert.equal(p.profile, undefined);
  assert.equal(p.hand.style, "marker");
  assert.equal(p.hand.scale, 1);
  assert.equal(p.sfxOn, undefined);
  assert.equal(p.scenes.every((s) => s.board === undefined), true);
});
check("an unknown scaffold profileId applies nothing (honest no-op)", () => {
  const p = scaffoldWhiteboardProject({ scenes: SCENE_INPUTS, topic: "Bridges", profileId: "no-such" });
  assert.equal(p.profile, undefined);
  assert.equal(p.hand.style, "marker");
});

console.log("\n== 5. SUBJECT FILL ==");
check("the five slots are ACTIVE with five scenarios each", () => {
  assert.equal(W1_SUBJECT_SLOTS.length, 5);
  for (const slot of W1_SUBJECT_SLOTS) {
    assert.equal(slot.status, "active", slot.id);
    assert.equal(slot.scenarioIds.length, 5, slot.id);
    assert.ok(slot.topic.length > 0 && !slot.topic.includes("placeholder"), slot.id);
  }
});
check("subject builders are deterministic, in-canvas, and validate", () => {
  for (const subject of ["science", ...SUBJECT_IDS] as const) {
    for (const aspect of W1_ASPECT_IDS) {
      const a = buildSubjectBenchmarkProject(subject, aspect);
      const b = buildSubjectBenchmarkProject(subject, aspect);
      assert.equal(jsonOf(a), jsonOf(b), `${subject}/${aspect} determinism`);
      const { width, height } = a;
      for (const s of a.scenes) {
        for (const pl of s.placements) {
          assert.ok(pl.placement.x >= 0 && pl.placement.y >= 0, `${subject}/${aspect}/${s.id} origin`);
          assert.ok(pl.placement.x + pl.placement.scale * 200 <= width + 1, `${subject}/${aspect}/${s.id} fits width`);
          assert.ok(pl.placement.y + pl.placement.scale * 200 <= height + 1, `${subject}/${aspect}/${s.id} fits height`);
        }
      }
      const v = validateWhiteboardProject(JSON.parse(jsonOf(a)), lib.libraryIndex);
      assert.ok(v.project, `${subject}/${aspect} validation: ${v.errors.join(" · ")}`);
    }
  }
});
check("every subject's clock is the W1 clock (38.0s) and the plans sit inside the spans", () => {
  for (const subject of ["science", ...SUBJECT_IDS] as const) {
    assert.equal(subjectTotalDurationMs(subject), 38000, subject);
    const spans = subjectSpans(subject);
    assert.equal(spans.length, 5, subject);
    for (const s of subjectSamplePlan(subject)) {
      const span = spans.find((x) => x.id === s.id);
      assert.ok(span, `${subject}/${s.id} sample span`);
      assert.ok(s.tSec * 1000 >= span.startMs && s.tSec * 1000 < span.endMs, `${subject}/${s.id} sample in span`);
    }
    const seams = subjectSeamPlan(subject);
    assert.equal(seams.length, 4, subject);
    for (const seam of seams) {
      const outSpan = spans.find((x) => x.id === seam.between[0]);
      const inSpan = spans.find((x) => x.id === seam.between[1]);
      assert.ok(outSpan && inSpan, `${subject} seam endpoints`);
      assert.ok(Math.abs(seam.firstTSec * 1000 - outSpan.endMs) < 1, `${subject} seam first-frame lands on the cut`);
    }
  }
});

console.log("\n== 6. I.8 LANE ==");
check("the islamic-history slot carries its policy id", () => {
  const slot = W1_SUBJECT_SLOTS.find((s) => s.id === "islamic-history");
  assert.equal(slot?.policyId, "islamic-history");
});
check("the islamic builder refuses out-of-allowlist assets (I.8 as data)", () => {
  const placed = new Set(
    buildSubjectBenchmarkProject("islamic-history", "16:9").scenes.flatMap((s) => s.placements.map((p) => p.assetId))
  );
  for (const a of placed) assert.ok(ISLAMIC_SUBJECT_ASSET_ALLOWLIST.includes(a), `${a} allowlisted`);
  assert.ok(placed.size >= 6, "the set actually exercises the allowlist");
});
check("the islamic narrations pass scanRestrictedSubjects clean", () => {
  const scenes = buildSubjectBenchmarkProject("islamic-history", "16:9").scenes;
  for (const s of scenes) {
    const hits = scanRestrictedSubjects(s.narration, "islamic-history");
    assert.deepEqual(hits, [], `${s.id}: ${hits.map((h) => h.alias).join(",")}`);
  }
});
check("the other four subjects' narrations are policy-neutral under islamic-history", () => {
  // The standard-policy subjects are not scanned in production; this pin
  // documents that their TEXT also happens to be clean under the islamic
  // detector — a fact, not a law (the LAW rides the slot's policy id).
  for (const subject of ["engineering", "business", "general-education"] as const) {
    for (const s of buildSubjectBenchmarkProject(subject, "16:9").scenes) {
      assert.deepEqual(scanRestrictedSubjects(s.narration, "islamic-history"), [], `${subject}/${s.id}`);
    }
  }
});

console.log("\n== 7. W1 FREEZE ==");
check("the frozen W1 project hashes are the pinned bytes", () => {
  // 2026-11-19 freeze — the five-subject fill landed BESIDE this set
  // without touching it. Recompute ONLY via the freeze procedure.
  const PINNED: Record<string, string> = {
    "16:9": "488237559e75adaa407fc7c42921f0b5ec91798f81f74e7c81c44b2cfacf7efa",
    "9:16": "674ea3db98d437e6ac7dd750072f50103d3a95f2de4b7801f0d2a474b1155df8",
    "1:1": "c745ea6042419d100978bb116f6470434753ea311788b38ae12e9a6f6af3e871",
  };
  for (const aspect of W1_ASPECT_IDS) {
    const got = sha(jsonOf(buildBenchmarkProject(aspect)));
    assert.equal(got, PINNED[aspect], `${aspect} project JSON hash`);
  }
});
check("the default background constant is the house white", () => {
  assert.equal(WB_DEFAULT_SCENE_BACKGROUND, "#ffffff");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("ALL CHECKS FAILED:\n" + fails.map((f) => `  - ${f}`).join("\n"));
  process.exit(1);
}
console.log("ALL CHECKS PASS");
