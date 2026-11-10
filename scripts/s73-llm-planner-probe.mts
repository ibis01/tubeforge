#!/usr/bin/env node
/**
 * S73 E5 phase-2 live probe — the LLM scaffold planner's model half through
 * the app's own stack (aiCallJson → budget → llm.ts → zai gateway), exactly
 * the way the S70 hook-panel probe rides it. The pure halves (catalog,
 * normalization, composition, degradation) are unit-pinned; this probe
 * verifies the LIVE round-trip on a heart-topic story:
 *   - the model's reply normalizes to at least one served scene
 *   - the composed project validates clean against the REAL library
 *   - the structural grammar survives (title-hero first, close-card last)
 *   - the report is honest (planner label, served/fallback counts, drops)
 * A partial fallback is an honest outcome (served >= 1); a degraded
 * round-trip is a FAILURE — the probe exists to prove the model half.
 * Exit 0 = the LLM planner is live-verifiable; 1 = the model half failed.
 *
 *   node --import tsx scripts/s73-llm-planner-probe.mts
 */
const { scaffoldWhiteboardProjectLlm, buildPlannerCatalog } = await import(
  "../src/lib/tubeforge/whiteboard/llm-planner"
);
const { loadLibrary } = await import("../src/lib/tubeforge/whiteboard/assets");
const { validateWhiteboardProject } = await import("../src/lib/tubeforge/whiteboard/storyboard");

const SCENES = [
  {
    index: 1,
    title: "Opening",
    narration:
      "Your heart beats about one hundred thousand times a day, pushing five liters of blood through vessels that would circle the earth twice.",
  },
  {
    index: 2,
    title: "The pump",
    narration:
      "The right side pushes blood to the lungs to collect oxygen; the thicker left side sends it out to the whole body.",
  },
  {
    index: 3,
    title: "The signal",
    narration:
      "An electrical pulse starts each beat, and the ecg line traces it — a tiny spark timing the most reliable pump you own.",
  },
  {
    index: 4,
    title: "Close",
    narration:
      "So the next time you feel your heart beat, remember: sixty to one hundred beats every minute, your whole life through.",
  },
];

const t0 = Date.now();
try {
  const lib = loadLibrary();
  const { project, report } = await scaffoldWhiteboardProjectLlm({
    scenes: SCENES,
    topic: "How Your Heart Works",
    catalog: buildPlannerCatalog(lib.assets.values()),
  });
  console.log(
    `[PLANNER-OK] planner=${report.planner} served=${report.servedScenes}/${SCENES.length} ` +
      `fallback=[${report.fallbackScenes.join(",")}] in ${Date.now() - t0}ms`
  );
  for (const s of project.scenes) {
    console.log(
      `  ${s.id}: ${s.placements
        .map((p) => `${p.assetId}@${p.placement.x},${p.placement.y}x${p.placement.scale}`)
        .join(" · ")}`
    );
  }
  for (const d of report.dropped) {
    console.log(`  dropped: scene ${d.scene} ${d.assetId} — ${d.reason}`);
  }

  if (report.planner !== "llm") throw new Error(`degraded: ${report.degradeReason ?? "unknown"}`);
  if (report.servedScenes < 1) throw new Error("no scene was served");

  const validated = validateWhiteboardProject(project, lib.libraryIndex);
  if (!validated.project) throw new Error(`composed project invalid: ${validated.errors.join(" · ")}`);

  if (!project.scenes[0].placements.some((p) => p.assetId === "title-hero"))
    throw new Error("scene 1 lost the title card");
  const last = project.scenes[project.scenes.length - 1];
  if (!last.placements.some((p) => p.assetId === "close-card"))
    throw new Error("the closer lost the stat card");

  const llmPicks = project.scenes.flatMap((s) =>
    s.placements.filter((p) => !["title-hero", "close-card", "hand-marker"].includes(p.assetId))
  );
  if (llmPicks.length === 0) throw new Error("no LLM concept pick survived");

  console.log(
    `[PLANNER-VERIFIED] validates clean, structural cards intact, ${llmPicks.length} concept picks placed by the model`
  );
  process.exit(0);
} catch (err) {
  console.log(`[PLANNER-ERR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
