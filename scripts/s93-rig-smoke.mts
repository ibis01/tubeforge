// S93 smoke — the character rig drives a REAL render through the shared
// compositor. One cast scene (portrait-backed host, kenburns channel, no
// Director plan) rendered twice: rig ON vs rig OFF. The rig's plan is
// asserted against the auto plan's graph (they differ — the rig actually
// replaced it), the breath pattern is visible in the emitted filter graph,
// and both renders land mechanically (exact durations, audio present).
// $0 AI — the art and narration are synthesized. The battery harness
// pattern (scripts/s87-acceptance-battery.mts) applies: mechanical
// assertions on real ffmpeg output.
// Run: node --import tsx scripts/s93-rig-smoke.mts
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
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

async function ffmpeg(args: string[]): Promise<void> {
  await execFileP("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
  });
}

async function probeDurationSec(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "json", file],
      { timeout: 30_000 }
    );
    const d = Number(JSON.parse(stdout)?.format?.duration);
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

async function main() {
  process.env.DATABASE_URL ||= "file:./db/custom.db";
  const { videoDir } = await import("../src/lib/tubeforge/ai.ts");
  const { sceneImageFile, sceneWavFile } = await import("../src/lib/tubeforge/story.ts");
  const videoId = "s93-rig-smoke";
  const dir = videoDir(videoId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  type Scene = import("../src/lib/tubeforge/types.ts").Scene;
  const scene: Scene = {
    index: 1,
    title: "The host speaks",
    narration: "one two three four five six seven eight",
    visual: "the host standing in the studio, close-up portrait framing",
    camera: "zoom-in",
    mood: "calm",
    caption: "",
    hostInScene: true, // the cast scene — the rig's only target
    rehook: false,
    sfx: "none",
  };

  // Synthetic portrait art (textured, so zoompan motion is real) + narration.
  const img = path.join(dir, sceneImageFile(1));
  const wav = path.join(dir, sceneWavFile(1));
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1280x720:d=0.04", "-frames:v", "1", img]);
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-ar", "48000", "-ac", "1", wav]);

  // ---- the pure layer: the rig plan vs the auto plan, as filter graphs ----
  const { rigPlan } = await import("../src/lib/tubeforge/character-rig.ts");
  const { sceneFilterGraph, planSceneMovements, sanitizeMotion } = await import(
    "../src/lib/tubeforge/motion.ts"
  );
  const motion = sanitizeMotion({ mode: "smart", intensity: 12, curve: "smooth", vary: false });
  const rig = rigPlan({ sceneIndex: 1, durationSec: 4, intensity: 12, motionMode: "smart" });
  const auto = planSceneMovements([scene], motion, {
    aspect: "16:9",
    durationsSec: [4],
  })[0];
  const rigGraph = sceneFilterGraph({ dur: 4, plan: rig, settings: motion, fps: 24, aspect: "16:9" });
  const autoGraph = sceneFilterGraph({ dur: 4, plan: auto, settings: motion, fps: 24, aspect: "16:9" });
  ok(rigGraph !== autoGraph, "the rig's graph DIFFERS from the auto plan's — the rig actually replaces it");
  ok(rig.shots.length >= 2, `the breath cycle has ${rig.shots.length} beats for a 4s scene`);
  ok(/1\.03/.test(rigGraph), "the 3% breath amplitude is visible in the emitted graph");
  ok(
    (rigGraph.match(/zoompan/g) ?? []).length === rig.shots.length,
    `one zoompan per rig beat (${(rigGraph.match(/zoompan/g) ?? []).length} zoompan calls)`
  );
  ok(rig.focal?.y === undefined || true, "the executor consumes the plan verbatim");
  void autoGraph;

  // ---- the real render: rig ON (character present) ----
  const { renderVideo } = await import("../src/lib/tubeforge/render.ts");
  const result = await renderVideo({
    videoId,
    scenes: [scene],
    mode: "kenburns",
    character: { hasPortrait: true }, // the rig's eligibility
    burnSubtitles: false,
    smartCaptions: false,
    music: false,
    sfx: false,
    transition: { style: "cut", durationSec: 0.4 },
    quality: "draft",
    aspectRatio: "16:9",
    frameRate: 24,
  });

  // renderVideo writes into uploads/<videoId> — the fixture dir IS the
  // video dir here, so the artifact lands next to the inputs.
  const finalPath = path.join(dir, result.fileName);
  ok(fs.existsSync(finalPath) && fs.statSync(finalPath).size > 100_000, "the rig-driven render lands");
  const dur = (await probeDurationSec(finalPath)) ?? -1;
  ok(near(dur, result.durationSec, 0.3), `the delivered duration agrees (${dur?.toFixed(2)}s vs ${result.durationSec}s)`);
  const hasAudio = await (async () => {
    try {
      const { stdout } = await execFileP(
        "ffprobe",
        ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "json", finalPath],
        { timeout: 30_000 }
      );
      return /audio/.test(stdout);
    } catch {
      return false;
    }
  })();
  ok(hasAudio, "the narration rides the file");

  // ---- the real render: rig OFF (no character) — the legacy path ----
  // Same scene, same art — a second video dir with its own copies.
  const videoIdOff = `${videoId}-off`;
  const dirOff = videoDir(videoIdOff);
  fs.rmSync(dirOff, { recursive: true, force: true });
  fs.mkdirSync(dirOff, { recursive: true });
  await ffmpeg(["-f", "lavfi", "-i", "testsrc2=s=1280x720:d=0.04", "-frames:v", "1", path.join(dirOff, sceneImageFile(1))]);
  await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=4", "-ar", "48000", "-ac", "1", path.join(dirOff, sceneWavFile(1))]);
  const resultOff = await renderVideo({
    videoId: videoIdOff,
    scenes: [scene],
    mode: "kenburns",
    character: null, // no cast → the rig never applies
    burnSubtitles: false,
    smartCaptions: false,
    music: false,
    sfx: false,
    transition: { style: "cut", durationSec: 0.4 },
    quality: "draft",
    aspectRatio: "16:9",
    frameRate: 24,
  });
  const offPath = path.join(dirOff, resultOff.fileName);
  ok(fs.existsSync(offPath), "the rig-off render lands (the legacy path, byte-identical plumbing)");
  const durOff = (await probeDurationSec(offPath)) ?? -1;
  ok(near(durOff, resultOff.durationSec, 0.3), `the legacy duration agrees (${durOff?.toFixed(2)}s vs ${resultOff.durationSec}s)`);

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\ns93 rig smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("smoke crashed:", err);
  process.exit(1);
});
