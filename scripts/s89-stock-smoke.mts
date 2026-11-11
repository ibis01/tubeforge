// S89 smoke — the stock verification lane on REAL local artifacts: two
// synthesized 6s clips (moving testsrc2 vs a frozen steel-blue frame) go
// through the REAL probe → multi-frame extraction → motion measurement →
// verdict combination. The relevance gate is injected (deterministic), so
// the smoke isolates the deterministic layers exactly like the unit pins —
// but on real ffmpeg output, with real frame files, real YAVG parsing.
// Run: node --import tsx scripts/s89-stock-smoke.mts
import fs from "node:fs";
import path from "node:path";
import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFileCb);

let passed = 0;
let failed = 0;
function ok(cond: unknown, msg: string): asserts cond {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

async function main() {
  const dir = fs.mkdtempSync("/tmp/s89-stock-");
  const moving = path.join(dir, "moving.mp4");
  const frozen = path.join(dir, "static.mp4");

  // A moving clip (testsrc2 = animated patterns) and a STILL one: a single
  // constant frame for 6s — the "frozen frame in an mp4" shape the motion
  // measurement exists to catch (a still is the Smart Motion art lane's job).
  for (const [out, src] of [
    [moving, "testsrc2=s=1280x720:r=25:d=6"],
    [frozen, "color=c=steelblue:s=1280x720:r=25:d=6"],
  ] as const) {
    await execFileP("ffmpeg", [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", src,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-pix_fmt", "yuv420p",
      out,
    ]);
  }
  console.log("synthesized:", moving, "and", frozen);

  const { verifyClip, probeDuration } = await import("../src/lib/tubeforge/stock-verify.ts");
  const { MOTION_STATIC_MAX, rankCandidates } = await import("../src/lib/tubeforge/stock-ranker.ts");
  const { mergeIntoIndex } = await import("../src/lib/tubeforge/stock-index.ts");
  type SceneIndexEntry = import("../src/lib/tubeforge/stock-index.ts").SceneIndexEntry;
  type Scene = import("../src/lib/tubeforge/types.ts").Scene;

  const scene = {
    index: 1,
    title: "The storm arrives",
    narration: "Ocean waves crash against the rocky coast as the storm rolls in",
    visual: "ocean waves crashing on a rocky coast, dramatic sky",
    camera: "zoom-in",
    mood: "dramatic",
  } as unknown as Scene;

  // ---------- the real duration probe ----------
  const dur = await probeDuration(moving);
  ok(dur != null && Math.abs(dur - 6) < 0.3, `ffprobe reads the synthesized duration (${dur?.toFixed(2)}s ≈ 6)`);

  // ---------- an injected relevance gate, with a call counter ----------
  const gate = (pass: boolean | null) => {
    let calls = 0;
    return {
      calls: () => calls,
      fn: async () => {
        calls++;
        return { pass, score: pass === false ? 1 : pass === true ? 9 : null, summary: pass == null ? "gate unavailable" : "synthetic" };
      },
    };
  };

  // ---------- 1. relevant + moving → accepted with multi-frame evidence ----------
  const goodGate = gate(true);
  const good = await verifyClip({
    clipPath: moving,
    durationSec: 6,
    scene,
    relevance: goodGate.fn,
  });
  ok(good.pass === true, `moving + relevant → accepted (${good.reason})`);
  ok(good.framesPassed >= 2, "acceptance rests on ≥2 passing frames");
  ok(good.motionDelta != null && good.motionDelta > MOTION_STATIC_MAX, `real motion measured (YAVG ${good.motionDelta?.toFixed(2)} > ${MOTION_STATIC_MAX})`);
  ok(goodGate.calls() === 2, `early exit: 2 passes stopped the walk (${goodGate.calls()} gate calls, 3 frames extracted)`);

  // ---------- 2. unrelated content → rejected on the second failing frame ----------
  const badGate = gate(false);
  const bad = await verifyClip({
    clipPath: moving,
    durationSec: 6,
    scene,
    relevance: badGate.fn,
  });
  ok(bad.pass === false, `unrelated content → rejected (${bad.reason})`);
  ok(badGate.calls() === 2, "early exit: 2 fails stopped the walk (no third call)");

  // ---------- 3. THE STATIC CATCH: relevant verdicts, frozen frames ----------
  const stillGate = gate(true);
  const still = await verifyClip({
    clipPath: frozen,
    durationSec: 6,
    scene,
    relevance: stillGate.fn,
  });
  ok(still.pass === false, "THE STATIC CATCH: even a clip the gate loves is rejected when nothing moves");
  ok(/static/.test(still.reason), `the reason names it (${still.reason})`);
  ok(still.motionDelta != null && still.motionDelta < MOTION_STATIC_MAX, `frozen frames measure near zero (YAVG ${still.motionDelta?.toFixed(3)} < ${MOTION_STATIC_MAX})`);

  // ---------- 4. gate outage → fail-open, recorded unverified ----------
  const outageGate = gate(null);
  const outage = await verifyClip({
    clipPath: moving,
    durationSec: 6,
    scene,
    relevance: outageGate.fn,
  });
  ok(outage.pass === null, "gate outage → pass:null (fail-open, the clip is kept)");
  ok(/unverified|insufficient/.test(outage.reason), `the outcome says unverified (${outage.reason})`);
  ok(outageGate.calls() === 2, "the outage breaker stops after 2 unchecked frames");

  // ---------- 5. the ranker walk order on a mixed pool ----------
  const index = new Map<string, SceneIndexEntry>();
  mergeIntoIndex(index, "ocean waves", [
    { source: "pexels", id: "1", url: "u1", width: 1920, height: 1080, durationSec: 12, author: "a", pageUrl: "p", license: "Pexels License" },
    { source: "pexels", id: "2", url: "u2", width: 1920, height: 1080, durationSec: 12, author: "a", pageUrl: "p", license: "Pexels License" },
  ]);
  mergeIntoIndex(index, "storm coast", [
    { source: "pexels", id: "1", url: "u1", width: 1920, height: 1080, durationSec: 12, author: "a", pageUrl: "p", license: "Pexels License" },
    { source: "pexels", id: "3", url: "u3", width: 1920, height: 1080, durationSec: 12, author: "a", pageUrl: "p", license: "" }, // lawless
  ]);
  const ranked = rankCandidates([...index.values()], {
    sceneDurationSec: 10,
    usedClipKeys: new Set(["pexels:1"]),
    sceneTerms: [],
  });
  ok(ranked.length === 2, `the lawless candidate never ranks (${ranked.length} ranked of 3 merged)`);
  ok(ranked[0].entry.candidate.id === "2", "the fresh clip leads the walk");
  ok(ranked[1].entry.candidate.id === "1", "the already-used clip is the visible last resort");
  ok(index.get("pexels:1")?.matchedQueries.join("|") === "ocean waves|storm coast", "pexels:1 surfaced by BOTH queries (dedupe)");

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\ns89 stock smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
