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

import type { WhiteboardAsset } from "./assets";
import { loadLibrary } from "./assets";
import { LUFS_PASS_WINDOW, measureLoudness, normalizationFilter } from "../audiomix";
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
  scheduleScene,
  WB_RENDER_FRAME_BUDGET,
  type FrameState,
} from "./timing";
// S87 slice 3 — the engine EMITS the timeline contract: the frame plan maps
// onto whiteboard-kind clips, and the render loop + assembly read the SAME
// frame-quantized clock the tracks carry (one derivation, pinned equal —
// peer at the engine level, unified at the contract level).
import { framePlanClock, whiteboardTracks } from "./tracks";
import { planFromTracks, type CompositionPlan } from "../composition-plan";
import type { TimelineTrack } from "../timeline";
import type { WhiteboardProject } from "./storyboard";

const execFileP = promisify(execFile);

/**
 * S76 — the VO-slot loudness contract, enforced at the engine boundary.
 *
 * The QC gate measures the final program at the house delivery target
 * (−16 LUFS, pass window LUFS_PASS_WINDOW). E10's battery passed because
 * its synthetic slots were normalized at CREATION, while the production
 * voiceover path (generateSceneVoiceovers) ships RAW TTS WAVs — the S76
 * real-TTS smoke measured a narration-only render outside the window and
 * QC failed it correctly. This engine is its own finishing chain (no
 * audiomix stage runs after renderWhiteboard), so the contract lands
 * HERE: every VO slot is measured and, when it sits outside the delivery
 * window, linear two-pass normalized to the house targets — the same
 * chain every other render kind applies at its finishing stage. In-window
 * slots pass through untouched (no double processing). Linear mode
 * preserves duration, so the frame-budget pre-flight probes the
 * normalized slot with unchanged timing. Exported for the unit pin.
 */
export async function normalizeVoSlot(
  srcPath: string,
  normDir: string,
  sceneId: string,
): Promise<string> {
  const measurement = await measureLoudness(srcPath);
  if (
    measurement &&
    measurement.integratedLUFS >= LUFS_PASS_WINDOW[0] &&
    measurement.integratedLUFS <= LUFS_PASS_WINDOW[1]
  ) {
    return srcPath;
  }
  fs.mkdirSync(normDir, { recursive: true });
  const outPath = path.join(normDir, `vo-${sceneId}-norm.wav`);
  await execFileP(
    "ffmpeg",
    [
      "-y", "-v", "error",
      "-i", srcPath,
      "-af", normalizationFilter(measurement),
      "-c:a", "pcm_s16le",
      outPath,
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  );
  return outPath;
}

/**
 * The container-safe chromium launch args (the slides deployment contract,
 * now inherited by the whiteboard engine — the S75 E10 receipt: on a 4GB
 * container with the 64MB /dev/shm, a bare launch is SIGKILLed mid-scene
 * by the OOM killer when chromium's shared memory outgrows /dev/shm;
 * --disable-dev-shm-usage moves those segments to /tmp. --no-sandbox is
 * the container user-namespace reality). BOTH whiteboard launch sites
 * (the asset rasterize probe + the main render) MUST launch through these.
 */
export const WB_CHROMIUM_LAUNCH_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"] as const;

export interface RenderWhiteboardOptions {
  outDir: string;
  /** Real narration audio per scene id (absolute or cwd-relative path). */
  voFiles?: Map<string, string>;
  /** Music bed path (FLAC/WAV); mixed at -16 dB under the final assembly. */
  musicPath?: string;
  onProgress?: (label: string, fraction: number) => void;
  /** S69 (E9 Phase C): the video's UPLOADED assets, merged into the library
   *  by the same loadLibrary the built-ins ride — the render sees exactly
   *  what the editor validated against (one merge law, both sides). */
  uploadedAssets?: WhiteboardAsset[];
}

export interface SceneRenderResult {
  sceneId: string;
  durationMs: number;
  frames: number;
  file: string;
}

/** The contract artifacts a whiteboard render now returns alongside the
 * files: the engine-authored tracks (the frame plan in the universal
 * grammar) and the composition plan read BACK from them through the same
 * planFromTracks every engine-lane consumer uses — the two-clock pin
 * (plan ≡ delivered frames) is enforced below, and slices 4–5 consume
 * these (the legacy collapse + the acceptance battery). */
export interface WhiteboardRenderResult {
  scenes: SceneRenderResult[];
  file: string;
  /** The frame plan as contract tracks (visual/audio/subtitle). */
  tracks: TimelineTrack[];
  /** The composition plan derived FROM those tracks (origin "tracks"). */
  plan: CompositionPlan;
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

// -------------------------------------------------------------------------
// S69 (E9 Phase C / E11 §7 gate 5) — rasterize-before-trust.
//
// Pathological-but-valid markup can parse fine and explode raster time
// (the design's exact example). The probe is the SAME renderer, not a
// separate validator: the sanitized fragment goes into a network-aborted
// chromium context at the asset's own viewBox and must produce pixels
// inside the wall-clock budget, or the upload dies with a readable error.
// -------------------------------------------------------------------------

export interface AssetRasterProbeResult {
  ok: boolean;
  ms: number;
  error?: string;
}

/** Gate 5 — rasterize a (sanitized) uploaded asset standalone under a
 * wall-clock budget (default 5 s, design §7.5). NEVER throws — the route
 * turns a not-ok into a 400 with this error. */
export async function probeAssetRasterization(
  asset: WhiteboardAsset,
  budgetMs = 5_000
): Promise<AssetRasterProbeResult> {
  const t0 = Date.now();
  // The handle lives on a holder object — a plain `let` gets flow-narrowed
  // to its null initializer across the closure boundary (TS cannot see the
  // assignment run), and the finally's close would read as `never`.
  const holder: { browser?: import("playwright").Browser } = {};
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), budgetMs));
  const work = (async (): Promise<AssetRasterProbeResult> => {
    const { chromium } = await import("playwright");
    holder.browser = await chromium.launch({ headless: true, args: [...WB_CHROMIUM_LAUNCH_ARGS] });
    const context = await holder.browser.newContext({
      viewport: { width: 512, height: 512 },
      deviceScaleFactor: 1,
    });
    // Security line 2, verbatim: the probe page has no network, period.
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const html =
      `<!doctype html><html><body style="margin:0">` +
      `<svg id="probe" xmlns="http://www.w3.org/2000/svg" width="512" height="512" ` +
      `viewBox="0 0 ${asset.viewBox.w} ${asset.viewBox.h}">` +
      `<g>${asset.svg}</g></svg></body></html>`;
    await page.setContent(html, { waitUntil: "load" });
    // Force the raster: a screenshot must come back with real pixels.
    const shot = await page.screenshot({ type: "jpeg", quality: 60 });
    if (shot.length < 64) return { ok: false, ms: Date.now() - t0, error: "the probe rasterized to nothing" };
    return { ok: true, ms: Date.now() - t0 };
  })();
  try {
    const winner = await Promise.race([work, timer]);
    if (winner === "timeout")
      return {
        ok: false,
        ms: Date.now() - t0,
        error: `rasterizing this SVG exceeded the ${Math.round(budgetMs / 1000)}s budget — simplify the paths (fewer points, shallower nesting)`,
      };
    return winner;
  } catch (err) {
    return {
      ok: false,
      ms: Date.now() - t0,
      error: `the raster probe failed: ${err instanceof Error ? err.message.slice(0, 160) : String(err).slice(0, 160)}`,
    };
  } finally {
    // The race's loser must not leak a browser process: close either way.
    await holder.browser?.close().catch(() => {});
  }
}

/** Render one whiteboard project to <outDir>/final.mp4. */
export async function renderWhiteboard(
  project: WhiteboardProject,
  opts: RenderWhiteboardOptions
): Promise<WhiteboardRenderResult> {
  // S65 (E1) pre-flight — the frame budget. Compute every scene's duration
  // the EXACT way the loop below will (explicit > VO-measured > narration
  // estimate, via the shared pure estimator), then refuse the project
  // BEFORE chromium launches: a 4GB worker must never learn about an
  // unbounded render from the OOM killer.
  const voMsBySceneId = new Map<string, number>();
  const voResolved = new Map<string, string>();
  let anyVoAudio = false;
  const voNormDir = path.join(opts.outDir, "vo-norm");
  for (const scene of project.scenes) {
    const voRaw = opts.voFiles?.get(scene.id) ?? null;
    if (!voRaw) continue;
    anyVoAudio = true;
    const voPath = await normalizeVoSlot(voRaw, voNormDir, scene.id);
    voResolved.set(scene.id, voPath);
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

  // S87 slice 3 — COMPOSE THROUGH THE CONTRACT. The frame plan maps onto
  // whiteboard-kind clips (the universal grammar), and the plan is read
  // back from those tracks through the same planFromTracks the compositor
  // lane uses. The loop and the assembly below read the frame-quantized
  // clock the tracks carry — one derivation, so the delivered cut and the
  // contract projection cannot disagree (a null plan here is an engine
  // bug: we JUST derived the tracks from a validated project + the
  // estimator's clamped durations; it is not a user-fixable state).
  const clock = framePlanClock(sceneMs, project.fps);
  const tracks = whiteboardTracks(project, sceneMs, {
    voSceneIds: voResolved.keys(),
    musicOn: opts.musicPath != null,
  });
  const plan = planFromTracks({ tracks }, project.scenes.length);
  if (!plan) {
    throw new Error(
      "the whiteboard frame plan failed the timeline contract — an engine bug, not a project problem"
    );
  }

  const { chromium } = await import("playwright");
  const lib = loadLibrary(opts.uploadedAssets ?? []);
  const geometry = buildGeometry(
    [...lib.extracted.entries()].map(([id, ex]) => ({ id, paths: ex.paths }))
  );
  const handAsset = lib.assets.get("hand-marker");
  if (!handAsset) throw new Error("hand-marker asset missing from the library");

  fs.mkdirSync(opts.outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, args: [...WB_CHROMIUM_LAUNCH_ARGS] });

  const sceneFiles: SceneRenderResult[] = [];
  try {
    for (let si = 0; si < project.scenes.length; si++) {
      const scene = project.scenes[si];
      // Pre-flight already probed every VO and computed the durations the
      // estimator returned — reuse them so budget and render agree by
      // construction (never re-probe, never diverge). S87 slice 3: the
      // frames/delivered seconds come from the SHARED frame-quantized clock
      // (the same derivation the contract tracks carry) — the numbers are
      // identical to the old inline math by construction (frameCount), and
      // the clock is now the one source both the render and the contract
      // read.
      const durationMs = sceneMs[si];
      const events = scheduleScene(scene, durationMs, geometry);
      const frames = clock.scenes[si].frames;

      // Per-scene page recycling (the S75 E10 receipt): ONE page held across
      // the whole project grew until the 4GB worker's OOM killer fired —
      // two separate runs died mid-project (scene 2 frame 230/378, then
      // scene 4 frame 1/332) with no JS trace. A fresh context per scene
      // hands chromium's memory back at every scene boundary; the browser
      // itself (the expensive launch) is reused.
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
      try {
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
      // voResolved carries the LOUDNESS-CONTRACT slots — see normalizeVoSlot.
      const voPath = voResolved.get(scene.id) ?? null;
      const sceneFile = path.join(opts.outDir, `scene-${si + 1}.mp4`);
      const durSec = clock.scenes[si].deliveredSec;
      const args: string[] = [
        "-y",
        "-framerate", String(project.fps),
        "-i", path.join(framesDir, "f%05d.jpg"),
      ];
      if (voPath) args.push("-i", voPath);
      args.push(
        "-filter_complex", "[0:v]format=yuv420p[v]",
        "-map", "[v]",
        // apad (not -shortest): the VO must PAD to the scene duration so the
        // estimator's 350ms tail survives as the last stroke's hold. -shortest
        // truncated the video to the VO and ate the tail — the S75 E10
        // receipt: 1623 budgeted frames, 1578 delivered (every scene 9
        // frames short; the pre-flight frame budget lied by construction).
        ...(voPath ? ["-map", "1:a", "-c:a", "aac", "-b:a", "160k", "-af", "apad"] : []),
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
        "-t", durSec.toFixed(3),
        sceneFile,
      );
      await runFfmpeg(args);
      fs.rmSync(framesDir, { recursive: true, force: true });
      sceneFiles.push({ sceneId: scene.id, durationMs, frames, file: sceneFile });
      } finally {
        // The scene's chromium memory goes back to the OS here — the
        // recycling that keeps the 4GB worker alive across the project.
        await context.close().catch(() => {});
      }
    }

    // Final assembly: concat + the music bed (or stream copy when silent).
    // S87 slice 3 — the assembly total reads the shared clock (the exact
    // sum of delivered per-scene seconds) and the CONTRACT assert holds the
    // plan to it: if anyone ever edits the loop math away from the clock,
    // the render refuses here instead of shipping a desynced projection.
    const finalFile = path.join(opts.outDir, "final.mp4");
    const totalSec = clock.scenes.reduce((a, s) => a + s.deliveredSec, 0);
    if (Math.abs(plan.totalSec - Math.round(totalSec * 100) / 100) > 0.001) {
      throw new Error(
        "the whiteboard assembly clock diverged from the timeline contract — an engine bug, not a project problem"
      );
    }
    const listFile = path.join(opts.outDir, "concat.txt");
    fs.writeFileSync(listFile, sceneFiles.map((s) => `file '${path.resolve(s.file)}'`).join("\n") + "\n");
    if (opts.musicPath) {
      // Bed gain: with narration the bed ducks to 0.16 UNDER THE VOICE; a
      // SOLO bed (no VO this run — the gateway outage) carries the program
      // at full level — the house finishing chain already loudnorm'd it to
      // −16 LUFS, so gain 1.0 lands exactly on the broadcast target (the
      // S64 receipt: a ducked solo bed measured −32.1 LUFS and failed).
      //
      // S75 E10 receipt (the second kill): the mix filter mapped ONLY the
      // bed — the concatenated VO ([0:a]) never reached final.mp4, and a
      // narrated render measured −32.0 LUFS (the ducked bed alone). The
      // amix arm exists only when narration exists; normalize=0 keeps the
      // voice at its own level instead of amix's default ½ divider.
      const bedGain = anyVoAudio ? 0.16 : 1.0;
      const bedChain =
        "[1:a]volume=" + bedGain +
        ",afade=t=in:st=0:d=1.5" +
        ",afade=t=out:st=" + Math.max(0, totalSec - 2).toFixed(3) + ":d=2";
      await runFfmpeg([
        "-y",
        "-f", "concat", "-safe", "0", "-i", listFile,
        "-stream_loop", "-1", "-t", totalSec.toFixed(3), "-i", opts.musicPath,
        "-filter_complex",
          anyVoAudio
            ? "[0:v]format=yuv420p[v];" + bedChain + "[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[a]"
            : "[0:v]format=yuv420p[v];" + bedChain + "[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
        "-c:a", "aac", "-b:a", "160k",
        // No -shortest here (the S75 E10 receipt: it dropped the final video
        // frame at the assembly boundary — 1623 planned, 1622 delivered).
        // Every stream is already bounded: the bed by -t above, the mix by
        // amix duration=first, the video by the concat's own length.
        finalFile,
      ]);
    } else {
      await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", finalFile]);
    }
    return { scenes: sceneFiles, file: finalFile, tracks, plan };
  } finally {
    await browser.close();
  }
}
