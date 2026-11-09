// S64 — the Whiteboard Engine: the renderer. chromium rasterizes, FFmpeg
// assembles — and every frame's state comes from the PURE frame plan
// (timing.ts), never from CSS animation (the determinism law).
//
// Per scene: compose the sanitized asset markup into one page-sized SVG,
// then per frame apply the plan (dash offsets, text wipes, color reveals,
// placements, hand transform, camera transform) and screenshot. Scenes
// encode from the frame sequence (+ narration VO when present), then the
// concat + the house music bed produce the final MP4.
//
// Security posture: chromium launches with ALL network routes aborted —
// the page can only ever render the markup we wrote into it; the SVG
// sanitizer is the first line, this is the second.
import { execFile } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "util";

import { loadLibrary } from "./assets";
// S67 — the compose/applier seam lives in wb-page.ts (PURE), shared with the
// editor's playback canvas — the design §5 one-source law in both directions.
import {
  composeScene,
  framePayload,
  APPLY_FRAME_FN,
} from "./wb-page";
import {
  buildGeometry,
  estimateProjectFrames,
  frameAt,
  frameCount,
  scheduleScene,
  WB_RENDER_FRAME_BUDGET,
  type FrameState,
} from "./timing";
import type { WhiteboardProject } from "./storyboard";

const execFileP = promisify(execFile);

export interface RenderWhiteboardOptions {
  outDir: string;
  /** Real narration audio per scene id (absolute or cwd-relative path). */
  voFiles?: Map<string, string>;
  /** Music bed path (FLAC/WAV); mixed at -16 dB under the final assembly. */
  musicPath?: string;
  onProgress?: (label: string, fraction: number) => void;
}

export interface SceneRenderResult {
  sceneId: string;
  durationMs: number;
  frames: number;
  file: string;
}

// ---------------------------------------------------------------------------
// Scene composition (the page's SVG)
// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileP("ffmpeg", args, { maxBuffer: 32 * 1024 * 1024 }).catch((e) => {
    throw new Error(`ffmpeg failed: ${String(e.stderr ?? e.message).slice(-1200)}`);
  });
}

/** ffprobe a media file's duration (seconds). */
export async function probeDurationSec(file: string): Promise<number | null> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "json", file,
    ]);
    return Number(JSON.parse(stdout).format?.duration ?? NaN) || null;
  } catch {
    return null;
  }
}

/** Render one whiteboard project to <outDir>/final.mp4. */
export async function renderWhiteboard(
  project: WhiteboardProject,
  opts: RenderWhiteboardOptions
): Promise<{ scenes: SceneRenderResult[]; file: string }> {
  // S65 (E1) pre-flight — the frame budget. Compute every scene's duration
  // the EXACT way the loop below will (explicit > VO-measured > narration
  // estimate, via the shared pure estimator), then refuse the project
  // BEFORE chromium launches: a 4GB worker must never learn about an
  // unbounded render from the OOM killer.
  const voMsBySceneId = new Map<string, number>();
  let anyVoAudio = false;
  for (const scene of project.scenes) {
    const voPath = opts.voFiles?.get(scene.id) ?? null;
    if (!voPath) continue;
    anyVoAudio = true;
    const voDurSec = await probeDurationSec(voPath);
    if (voDurSec !== null) voMsBySceneId.set(scene.id, voDurSec * 1000);
  }
  const { totalFrames, sceneMs } = estimateProjectFrames(project, voMsBySceneId);
  if (totalFrames > WB_RENDER_FRAME_BUDGET) {
    throw new Error(
      `whiteboard project exceeds the render frame budget: ${totalFrames} frames ` +
        `(~${(sceneMs.reduce((a, b) => a + b, 0) / 1000).toFixed(0)}s at ${project.fps}fps) ` +
        `against the ${WB_RENDER_FRAME_BUDGET}-frame wall (18 min at 24fps) — split the project or shorten scenes`
    );
  }

  const { chromium } = await import("playwright");
  const lib = loadLibrary();
  const geometry = buildGeometry(
    [...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths }))
  );
  const handAsset = lib.assets.get("hand-marker");
  if (!handAsset) throw new Error("hand-marker asset missing from the library");

  fs.mkdirSync(opts.outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: project.width, height: project.height },
    deviceScaleFactor: 1,
  });
  // Security line 2: the page has no network, period.
  await context.route("**/*", (route) => route.abort());
  const page = await context.newPage();
  const apply = async (frame: FrameState): Promise<void> => {
    await page.evaluate(`(${APPLY_FRAME_FN})(${JSON.stringify(framePayload(frame, project.width, project.height))})`);
  };

  const sceneFiles: SceneRenderResult[] = [];
  try {
    for (let si = 0; si < project.scenes.length; si++) {
      const scene = project.scenes[si];
      // Pre-flight already probed every VO and computed the durations the
      // estimator returned — reuse them so budget and render agree by
      // construction (never re-probe, never diverge).
      const durationMs = sceneMs[si];
      const events = scheduleScene(scene, durationMs, geometry);
      const frames = frameCount(durationMs, project.fps);

      opts.onProgress?.(`scene ${si + 1}/${project.scenes.length} ("${scene.id}"): composing`, si / project.scenes.length);
      const composed = composeScene(scene, project, lib.assets);
      await page.setContent(composed.html, { waitUntil: "load" });
      // Setup pass: defs root + the hand asset + dasharrays from OUR geometry
      // (the pure module owns the truth about every stroke length).
      await page.evaluate(
        ({ handSvg, handScale }) => {
          const board = document.getElementById("board");
          const handAssetEl = document.getElementById("hand-asset");
          const hand = document.getElementById("hand");
          if (!board || !handAssetEl || !hand) return;
          const defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
          defs.id = "defs-root";
          board.appendChild(defs);
          handAssetEl.innerHTML = handSvg;
          hand.setAttribute("data-scale", String(handScale));
        },
        { handSvg: handAsset.svg, handScale: project.hand.scale }
      );
      // Register the frame-plan-key → element-id maps the applier resolves
      // through (fresh per scene — setContent resets the JS context).
      await page.evaluate(
        ({ drawIndex, textIndex }) => {
          const w = window as unknown as {
            __wbDraw?: Map<string, string>;
            __wbText?: Map<string, string>;
          };
          w.__wbDraw = new Map(drawIndex);
          w.__wbText = new Map(textIndex);
        },
        { drawIndex: [...composed.pathEls], textIndex: [...composed.textEls] }
      );
      for (const [key, elId] of composed.pathEls) {
        const [assetId, pathId] = key.split("::");
        const segs = geometry.get(assetId)?.paths.get(pathId);
        if (!segs) continue;
        let len = 0;
        for (const g of segs) len += g.lengths[g.lengths.length - 1] ?? 0;
        await page.evaluate(
          ({ elId, len }) => {
            const el = document.getElementById(elId);
            if (!el) return;
            el.dataset.len = String(len);
            el.setAttribute("stroke-dasharray", `${len} ${len}`);
            el.setAttribute("stroke-dashoffset", String(len));
            el.style.opacity = "0";
          },
          { elId, len }
        );
      }
      for (const [, elId] of composed.textEls) {
        await page.evaluate((elId) => {
          const el = document.getElementById(elId);
          if (el) el.style.opacity = "0";
        }, elId);
      }

      const framesDir = path.join(opts.outDir, `scene-${si + 1}-frames`);
      fs.mkdirSync(framesDir, { recursive: true });
      for (let f = 0; f < frames; f++) {
        const tMs = (f / project.fps) * 1000;
        await apply(frameAt(project, scene, events, geometry, tMs));
        await page.screenshot({
          path: path.join(framesDir, `f${String(f).padStart(5, "0")}.jpg`),
          type: "jpeg",
          quality: 92,
          clip: { x: 0, y: 0, width: project.width, height: project.height },
        });
        if (f % 24 === 0) {
          opts.onProgress?.(
            `scene ${si + 1}/${project.scenes.length} ("${scene.id}"): frame ${f + 1}/${frames}`,
            (si + (f + 1) / frames) / project.scenes.length
          );
        }
      }

      // Encode the scene: frames (+ VO when present). Music joins at assembly.
      const voPath = opts.voFiles?.get(scene.id) ?? null;
      const sceneFile = path.join(opts.outDir, `scene-${si + 1}.mp4`);
      const durSec = frames / project.fps;
      const args: string[] = [
        "-y",
        "-framerate", String(project.fps),
        "-i", path.join(framesDir, "f%05d.jpg"),
      ];
      if (voPath) args.push("-i", voPath);
      args.push(
        "-filter_complex", "[0:v]format=yuv420p[v]",
        "-map", "[v]",
        ...(voPath ? ["-map", "1:a", "-c:a", "aac", "-b:a", "160k", "-shortest"] : []),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
        "-t", durSec.toFixed(3),
        sceneFile,
      );
      await runFfmpeg(args);
      fs.rmSync(framesDir, { recursive: true, force: true });
      sceneFiles.push({ sceneId: scene.id, durationMs, frames, file: sceneFile });
    }

    // Final assembly: concat + the music bed (or stream copy when silent).
    const finalFile = path.join(opts.outDir, "final.mp4");
    const totalSec = sceneFiles.reduce((a, s) => a + s.frames / project.fps, 0);
    const listFile = path.join(opts.outDir, "concat.txt");
    fs.writeFileSync(listFile, sceneFiles.map((s) => `file '${path.resolve(s.file)}'`).join("\n") + "\n");
    if (opts.musicPath) {
      // Bed gain: with narration the bed ducks to 0.16 under the voice; a
      // SOLO bed (no VO this run — the gateway outage) carries the program
      // at full level — the house finishing chain already loudnorm'd it to
      // −16 LUFS, so gain 1.0 lands exactly on the broadcast target (the
      // S64 receipt: a ducked solo bed measured −32.1 LUFS and failed).
      const bedGain = anyVoAudio ? 0.16 : 1.0;
      await runFfmpeg([
        "-y",
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-stream_loop", "-1", "-t", totalSec.toFixed(3), "-i", opts.musicPath,
        "-filter_complex", "[0:v]format=yuv420p[v];[1:a]volume=" + bedGain + ",afade=t=in:st=0:d=1.5,afade=t=out:st=" + Math.max(0, totalSec - 2).toFixed(3) + ":d=2[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
        "-c:a", "aac", "-b:a", "160k",
        "-shortest",
        finalFile,
      ]);
    } else {
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalFile]);
    }
    return { scenes: sceneFiles, file: finalFile };
  } finally {
    await browser.close();
  }
}
