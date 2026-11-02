// Reproduce scene 5's motion plan + filter graph exactly as renderVideo does,
// then render a 3s probe with it to measure inter-frame motion.
import { planSceneMovements, sceneFilterGraph, sanitizeMotion } from "../src/lib/tubeforge/motion.ts";
import { parseScenes } from "../src/lib/tubeforge/story.ts";

// Motion settings as stored on the video row: smart/16
const motion = sanitizeMotion({ mode: "smart", intensity: 16 } as never);
const scenes = parseScenes(process.env.SCENES_JSON ?? "[]");
const scene = scenes.find((s: { index: number }) => s.index === 5);
if (!scene) throw new Error("scene 5 not found");
const dur = Number(process.env.SCENE_DUR ?? 13.3);

const plans = planSceneMovements([scene], motion, {
  aspect: "16:9",
  durationsSec: [dur],
});
const plan = plans[0];
console.log("scene type:", plan.sceneType, "| move:", plan.move, "| static:", plan.staticImage);
for (const s of plan.shots) {
  console.log(`  shot ${s.kind}: z ${s.zStart.toFixed(3)}→${s.zEnd.toFixed(3)} travel=${s.travel} sec=${s.sec}`);
}
const graph = sceneFilterGraph({ dur, plan, settings: motion, fps: 30, aspect: "16:9" });
console.log("\nGRAPH:\n" + graph);
