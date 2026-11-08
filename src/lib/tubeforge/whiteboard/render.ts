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

import { HAND_TIP, loadLibrary, type WhiteboardAsset } from "./assets";
import {
  buildGeometry,
  estimateProjectFrames,
  frameAt,
  frameCount,
  scheduleScene,
  WB_RENDER_FRAME_BUDGET,
  type FrameState,
} from "./timing";
import type { WhiteboardProject, WhiteboardScene } from "./storyboard";

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

interface ComposedScene {
  html: string;
  /** "assetId::pathId" → browser element id. */
  pathEls: Map<string, string>;
  /** "assetId::text:textId" → browser element id. */
  textEls: Map<string, string>;
}

function composeScene(
  scene: WhiteboardScene,
  project: WhiteboardProject,
  assets: Map<string, WhiteboardAsset>
): ComposedScene {
  const pathEls = new Map<string, string>();
  const textEls = new Map<string, string>();
  let body = "";
  for (const pl of scene.placements) {
    const asset = assets.get(pl.assetId);
    if (!asset) continue;
    const gid = `g-${pl.assetId}`;
    // Namespace inner ids so page-level lookups stay unambiguous.
    const namespaced = asset.svg
      .replace(/id="([^"]+)"/g, (_m, id: string) => `id="${pl.assetId}--${id}"`)
      .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${pl.assetId}--${id})`);
    body += `<g id="${gid}" transform="translate(${pl.placement.x} ${pl.placement.y}) rotate(${pl.placement.rotateDeg}) scale(${pl.placement.scale})">${namespaced}</g>\n`;
    for (const m of namespaced.matchAll(/<path\b[^>]*id="([^"]+)"/g)) {
      pathEls.set(`${pl.assetId}::${m[1].split("--")[1]}`, m[1]);
    }
    for (const m of namespaced.matchAll(/<text\b[^>]*id="([^"]+)"/g)) {
      textEls.set(`${pl.assetId}::text:${m[1].split("--")[1]}`, m[1]);
    }
  }
  const bg = scene.background === "#f8f5ee" ? "#f8f5ee" : "#ffffff";
  // The whiteboard surface: a subtle dot grid. Craft AND engineering —
  // a 99%-blank canvas cannot produce full-frame motion (the S64 freeze
  // receipts: scene-start frames measured mean |Δluma| 0.3–0.6 against
  // the ~1.0 freezedetect noise floor), so the camera drift alone leaves
  // thin-ink stretches reading as frozen. The texture gives the drift
  // purchase on every pixel of the frame.
  const dotColor = scene.background === "#f8f5ee" ? "#e6dfcd" : "#dedede";
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:${bg};overflow:hidden}
    svg{display:block}
  </style></head><body>
  <svg id="board" width="${project.width}" height="${project.height}" viewBox="0 0 ${project.width} ${project.height}" xmlns="http://www.w3.org/2000/svg">
    <defs><pattern id="paper-dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="12" cy="12" r="1.7" fill="${dotColor}"/></pattern></defs>
    <g id="camera"><rect x="${-project.width}" y="${-project.height}" width="${project.width * 3}" height="${project.height * 3}" fill="${bg}"/>
    <rect x="${-project.width}" y="${-project.height}" width="${project.width * 3}" height="${project.height * 3}" fill="url(#paper-dots)"/>
${body}
    <g id="hand" style="display:none"><g id="hand-inner" transform="translate(${-HAND_TIP.x} ${-HAND_TIP.y})"><g id="hand-asset"></g></g></g>
    </g>
  </svg></body></html>`;
  return { html, pathEls, textEls };
}

// ---------------------------------------------------------------------------
// The per-frame applier (injected into the page; plain JSON in, DOM out)
// ---------------------------------------------------------------------------

export function framePayload(frame: FrameState, width: number, height: number): string {
  return JSON.stringify({
    draws: [...frame.draws.entries()],
    texts: [...frame.texts.entries()],
    colors: [...frame.colors.entries()],
    placements: [...frame.placements.entries()],
    hand: frame.hand,
    tMs: frame.tMs,
    width,
    height,
    camera: frame.camera,
  });
}

export const APPLY_FRAME_FN = `(payloadJson) => {
  const p = JSON.parse(payloadJson);
  const board = document.getElementById("board");
  const camera = document.getElementById("camera");
  // Frame-plan keys are "assetId::pathId" / "assetId::text:textId", but the
  // page's element ids are namespaced "assetId--pathId" — resolve through
  // the maps the setup pass registered (window.__wbDraw / __wbText). A
  // direct id lookup on the plan key would silently miss EVERY element
  // (the seam the S64 unit contracts + benchmark pixel forensics pin shut).
  const drawEl = (key) => {
    const id = window.__wbDraw && window.__wbDraw.get(key);
    return id ? document.getElementById(id) : null;
  };
  const textEl = (key) => {
    const id = window.__wbText && window.__wbText.get(key);
    return id ? document.getElementById(id) : null;
  };
  const tx = board.clientWidth / 2 - p.camera.cx * p.camera.scale;
  const ty = board.clientHeight / 2 - p.camera.cy * p.camera.scale;
  camera.setAttribute("transform", "translate(" + tx + " " + ty + ") scale(" + p.camera.scale + ")");
  for (const [assetId, pl] of p.placements) {
    const g = document.getElementById("g-" + assetId);
    if (g) g.setAttribute("transform", "translate(" + pl.x + " " + pl.y + ") rotate(" + pl.rotateDeg + ") scale(" + pl.scale + ")");
  }
  for (const [key, prog] of p.draws) {
    const el = drawEl(key);
    if (!el) continue;
    const L = Number(el.dataset.len || 0);
    el.setAttribute("stroke-dashoffset", String(Math.max(0, L * (1 - prog))));
    el.style.opacity = prog <= 0 ? "0" : "1";
  }
  for (const [key, prog] of p.texts) {
    const el = textEl(key);
    if (!el) continue;
    el.style.opacity = prog > 0 ? "1" : "0";
    if (prog <= 0) continue;
    const clipId = "clip-" + key.replace(/[^a-zA-Z0-9_-]/g, "_");
    let rect = document.getElementById(clipId);
    if (!rect) {
      const cp = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
      cp.id = clipId;
      rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      cp.appendChild(rect);
      document.getElementById("defs-root").appendChild(cp);
      el.setAttribute("clip-path", "url(#" + clipId + ")");
    }
    const bb = el.getBBox();
    rect.setAttribute("x", String(bb.x - 2));
    rect.setAttribute("y", String(bb.y - 2));
    rect.setAttribute("height", String(bb.height + 4));
    rect.setAttribute("width", String(Math.max(0, (bb.width + 4) * prog)));
  }
  for (const [key, prog] of p.colors) {
    // Explicit path key → that element; bare asset key → every path in the group.
    const targets = key.includes("::")
      ? [drawEl(key)].filter(Boolean)
      : Array.from(document.querySelectorAll("#g-" + key.replace(/[^a-zA-Z0-9_-]/g, "-") + " path"));
    for (const el of targets) el.style.fillOpacity = String(prog);
  }
  const hand = document.getElementById("hand");
  if (!p.hand.visible) {
    hand.style.display = "none";
  } else {
    hand.style.display = "";
    const wob = 5 * Math.sin(p.tMs / 210.0);
    const s = hand.dataset.scale || "1";
    hand.setAttribute("transform",
      "translate(" + p.hand.x + " " + p.hand.y + ") rotate(" + (-32 + wob) + ") scale(" + s + ")");
  }
  return true;
}`;

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
