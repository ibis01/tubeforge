#!/usr/bin/env node
/**
 * whiteboard:render-sample.mjs — render the E2 sample 60s 1080p MP4.
 *
 *   node --import tsx scripts/render-sample-whiteboard.mts
 *   (also wired into package.json as `npm run whiteboard:sample`)
 *
 * Produces download/whiteboard-sample.mp4 — the working 60-second 1080p MP4
 * that satisfies plan §15 ("the first engineering milestone is a working
 * 60-second VideoScribe-style MP4").
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { buildSampleProject, renderProject } from "../src/lib/tubeforge/whiteboard";

const OUT_DIR = join(process.cwd(), "download");
const OUT_PATH = join(OUT_DIR, "whiteboard-sample.mp4");

mkdirSync(OUT_DIR, { recursive: true });

const project = buildSampleProject();
console.log(`Rendering "${project.title}" — ${project.scenes.length} scenes, 60s @ ${project.settings.fps}fps, ${project.settings.width}×${project.settings.height}...`);

const result = await renderProject(project, {
  outPath: OUT_PATH,
  quality: "final",
  onProgress: (current, total, label) => {
    if (current % 60 === 0 || current === total) {
      const pct = ((current / total) * 100).toFixed(1);
      console.log(`  [${pct}%] ${label}`);
    }
  },
});

console.log("\n" + "=".repeat(60));
console.log("Render complete:");
console.log(`  path:        ${result.outPath}`);
console.log(`  size:        ${(result.bytes / 1024).toFixed(1)} KB`);
console.log(`  frames:      ${result.frameCount}`);
console.log(`  duration:    ${result.durationSec.toFixed(2)}s`);
console.log(`  resolution:  ${result.width}×${result.height} @ ${result.fps}fps`);
console.log(`  sha256:      ${result.sha256}`);
console.log("=".repeat(60));
