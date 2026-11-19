// S123 (G1) P3 — the graphics engine renderer: chromium rasterizes, FFmpeg
// assembles — and every frame's state comes from the PURE frame truth
// (frame.ts frameAt) through the ONE applier (compose.ts
// APPLY_GRAPHICS_FRAME_FN), never from CSS animation (the determinism law,
// the wb-page.ts seam mirrored: one compose, one applier, two callers).
//
// Per scene: compose the validated scene into the page-sized SVG skeleton
// (composeGraphicsScene), then per frame apply the frame state (channels,
// bar lengths, counter values, stroke-dash draws, grow/wipe geometry) and
// screenshot. Scenes encode from the frame sequence (+ narration VO when
// present — the S76 loudness contract normalized at the engine boundary,
// the whiteboard's normalizeVoSlot REUSED, never a private copy), then the
// concat + the house music bed produce the final MP4.
//
// THE CLOCK (the doc law — "the doc clock IS the timeline", compose.ts —
// S152 amendment: the doc clock holds the narration):
// scene durations come from graphicsSceneDurationsMs (explicit durationMs >
// the MEASURED narration + the VO tail > the house 2.6-wps estimate — ONE
// clock model, the whiteboard lane's precedence mirrored) and frames come
// from framePlanWindows at doc.fps — the SAME derivation the preflight wall
// (R-1) and the tracks projection read, so budget, contract and delivered
// frames agree by construction. The measured map (WAV header math on the
// standing scene WAVs, the render's own voFiles) threads through EVERY
// clock reader — the wall, the tracks, frameAt, the QC lenses — so an
// unplanned scene EXTENDS to hold its narration instead of truncating it
// mid-sentence at the 2.6-wps boundary (the S76-era apad law still pads a
// SHORT slot; an EXPLICIT durationMs still owns the boundary — the
// author's cut, judged by the QC battery's narration-sync check). Per-frame time enters frameAt as the
// GLOBAL doc clock (sceneCursorMs + the frame's scene-local offset) so the
// render reads the exact truth the editor reads — scene resolution and the
// scene-local motion evaluation stay one function call apart (the R-6 law).
//
// Security posture (whiteboard parity): chromium launches with ALL network
// routes aborted — the page can only ever render the markup compose.ts
// wrote into it (sanitizeSvg first, HTML-escape second, in the composer);
// this network abort is the second line. Per-scene context recycling: ONE
// page held across the project grew until the 4GB worker's OOM killer
// fired (the S75 E10 receipt) — a fresh context per scene hands chromium's
// memory back at every scene boundary; the browser itself is reused.
import { createHash } from "crypto";
import fs from "node:fs";
import path from "node:path";

// The container-safe launch args + the VO loudness contract — the
// whiteboard engine's exported seams, reused verbatim (the S113
// no-private-copies law extended to the engine plumbing).
import { WB_CHROMIUM_LAUNCH_ARGS, normalizeVoSlot } from "../whiteboard/render";
import { runProcess } from "../proc";
import { framePlanWindows } from "../anim/clock";
import { planFromTracks, type CompositionPlan } from "../composition-plan";
import type { TimelineTrack } from "../timeline";
// S165 — the ready-gate named diagnostics: every awaited pipeline step
// carries a gate name + budget (page-load / compose / apply / screenshot /
// encode / probe), so a wedged render names WHICH gate is stuck.
import { withRenderGate } from "../render-gates";
// S165 — the static-frame dedup decision law (the kenburns/holds lane):
// the pure scan + the PSNR reading law; the render below walks it.
import {
  dedupDecision,
  dedupSpotFrame,
  findStaticStretches,
  parsePsnrSummary,
  type StaticStretch,
} from "./static-dedup";
import { APPLY_GRAPHICS_FRAME_FN, composeGraphicsScene, graphicsFrameApplierKey, graphicsFramePayload } from "./compose";
import { graphicsEventList, type GraphicsEventSlot } from "./events";
// B4-4 — the sfx events become sound: the catalog kinds + the synthesized
// wav cache (ensureSfx renders once, then every render reuses the file).
import { ensureSfx } from "../sfx";
import { SFX_KINDS } from "../types";
import { frameAt, graphicsSceneDurationsMs } from "./frame";
import { assertGraphicsBudget } from "./preflight";
// S163 Phase B — the native transition engine: the plan, the compositor
// and the page seam ride the PURE module; this file only orchestrates.
import {
  APPLY_TRANSITION_FRAME_FN,
  compositeTransitionFrame,
  planNativeTransitions,
  transitionCompositorPage,
  type NativeTransitionPlan,
  type NativeTransitionType,
} from "./transitions";
import { graphicsTracks } from "./tracks";
import { writeGraphicsDoc, type GraphicsDoc } from "./types";
import { wavDurationSec } from "../wav";

async function runFfmpeg(args: string[], gateDetail?: string): Promise<void> {
  // The zombie-aware runner (proc.ts) — the engine doctrine (the S154
  // consistency fix): after Playwright has lived in this process, bun
  // intermittently stops reaping children; runProcess decides completion
  // itself so a hung reaper can't stall a scene encode. S165: the runner
  // rides the encode gate — a wedged encode names the scene/window/assembly
  // that wedged instead of a bare runner timeout.
  await withRenderGate(
    { engine: "graphics", gate: "encode", detail: gateDetail },
    () => runProcess("ffmpeg", args, { timeoutMs: 10 * 60 * 1000, label: "graphics-encode" }),
  );
}

/** S165 — the dedup spot check's PSNR between two JPEG rasters, through
 *  the same zombie-aware runner. Returns the summary's average PSNR in dB
 *  (Infinity for identical frames) or null when the tool failed or printed
 *  nothing parseable — the caller falls back per-frame on null (fail-closed,
 *  never a vacuous pass). */
async function psnrJpegFiles(fileA: string, fileB: string): Promise<number | null> {
  try {
    const res = await runProcess(
      "ffmpeg",
      ["-hide_banner", "-i", fileA, "-i", fileB, "-filter_complex", "[0:v][1:v]psnr", "-f", "null", "-"],
      { timeoutMs: 60_000, label: "graphics-dedup-psnr" },
    );
    return parsePsnrSummary(res.stderr);
  } catch {
    return null;
  }
}

/** S165 — render ONE static stretch (the dedup lane's workhorse): shoot the
 *  anchor frame once, PSNR spot-check the stretch's middle frame against it
 *  through the real raster, and on a pass write the anchor's bytes for the
 *  whole run; on a fail (or an unmeasurable PSNR) re-shoot every remaining
 *  frame per-frame — fail-closed. The spot file lives OUTSIDE the frames dir
 *  (the image2 sequence must see exactly f%05d.jpg) and is always cleaned.
 *  Returns the next frame index the caller continues from (st.end + 1),
 *  plus the screenshot accounting for the honest receipt. */
async function renderDedupedStretch(args: {
  page: import("playwright").Page;
  framesDir: string;
  outDir: string;
  sceneTag: string;
  width: number;
  height: number;
  payloadKeys: readonly string[];
  stretch: StaticStretch;
}): Promise<{ next: number; screenshots: number; reused: number }> {
  const { page, payloadKeys, stretch: st } = args;
  const framePath = (f: number): string =>
    path.join(args.framesDir, `f${String(f).padStart(5, "0")}.jpg`);
  const shoot = async (f: number, target?: string): Promise<Buffer> => {
    await withRenderGate(
      { engine: "graphics", gate: "apply", detail: `${args.sceneTag} frame ${f}` },
      () => page.evaluate(`(${APPLY_GRAPHICS_FRAME_FN})(${payloadKeys[f]})`),
    );
    return withRenderGate(
      { engine: "graphics", gate: "screenshot", detail: `${args.sceneTag} frame ${f}` },
      () =>
        page.screenshot({
          ...(target ? { path: target } : {}),
          type: "jpeg",
          quality: 92,
          clip: { x: 0, y: 0, width: args.width, height: args.height },
        }),
    );
  };

  // The anchor — the ONE frame this stretch rasters for itself.
  const anchorShot = await shoot(st.start, framePath(st.start));
  let screenshots = 1;
  const mid = dedupSpotFrame(st);
  const spotPath = path.join(args.outDir, `dedup-spot-${st.start}-${mid}.jpg`);
  try {
    // The spot check — a REAL raster through the real applier, compared
    // against the anchor at the pixel level. Identical pixels PSNR to
    // Infinity; anything that actually moved lands far below the floor.
    await shoot(mid, spotPath);
    screenshots++;
    const psnr = await psnrJpegFiles(framePath(st.start), spotPath);
    if (dedupDecision(psnr) === "reuse") {
      // Reuse: the anchor's bytes stand for every other frame of the run —
      // the image2 sequence reads the same file count at the same framerate,
      // so the delivered clock never moves (the two-clock law).
      for (let f = st.start + 1; f <= st.end; f++) {
        fs.writeFileSync(framePath(f), anchorShot);
      }
      return { next: st.end + 1, screenshots, reused: st.end - st.start };
    }
    // Fail-closed: a PSNR below the floor (or an unmeasurable run) falls
    // back to per-frame rendering for the whole stretch.
    for (let f = st.start + 1; f <= st.end; f++) {
      await shoot(f, framePath(f));
      screenshots++;
    }
    return { next: st.end + 1, screenshots, reused: 0 };
  } finally {
    fs.rmSync(spotPath, { force: true });
  }
}

export interface RenderGraphicsOptions {
  outDir: string;
  /** Real narration audio per scene id (absolute or cwd-relative path). */
  voFiles?: Map<string, string>;
  /** Music bed path (FLAC/WAV); mixed at the house gains under the final assembly. */
  musicPath?: string;
  onProgress?: (label: string, fraction: number) => void;
  /** The LOOK-RATE lever (labelled drafts only, closed set {1, 2}): step 2
   *  renders every OTHER frame — at its EXACT doc-clock time, through the
   *  same frame truth and applier — and encodes at doc.fps/2 (12 or 15).
   *  The program duration is UNCHANGED (every encode stays bounded to the
   *  final's delivered seconds), so the look spans exactly the program it
   *  previews; only its temporal sampling halves (the whiteboard preview
   *  precedent: a look rides its own surface/rate law, 720p/24 regardless
   *  of the project). The P5 acceptance-7 probe records why: the 0.5×
   *  surface lever alone measured ~1.4× on the proof rig — the pipeline's
   *  fixed costs dominate a short program — and the look-rate closes the
   *  ≥ 2× criterion honestly. FINAL renders never step (1, by absence). */
  frameStep?: 1 | 2;
  /** S126 — the RESOLVED import assets (the import store's one seam):
   *  assetKey → data URIs (sheet = [strip], sequence = [f0..fN]). A doc
   *  that references an import the caller did not resolve REFUSES
   *  fail-closed (the G1-IMP lens's enforcement half — a silently missing
   *  sprite is the exact lie the lane exists to catch). */
  spriteAssets?: Map<string, string[]>;
  /** S132 (PAE-4) — resume an INTERRUPTED render: encoded scenes (per the
   *  outDir's render-manifest.json, the doc fingerprint matching, and the
   *  scene files still on disk) skip chromium + encode and rejoin the
   *  assembly. FAIL-CLOSED: a fingerprint mismatch (the doc, the VO/music
   *  inputs, the frame step, or the sprite assets changed) refuses — a
   *  resumed render that mixes two renders' scenes would ship a lie. A
   *  completed render deletes its manifest: resume applies only to an
   *  INTERRUPTED run. */
  resume?: boolean;
  /** S165 — the static-frame dedup lane (the kenburns/holds throughput):
   *  hold stretches — runs of frames whose applier payloads serialize
   *  identically — shoot their anchor frame once, PSNR spot-check it
   *  against the real raster, and reuse the anchor's bytes across the run.
   *  The delivered clock, the frames-dir shape and the encode args never
   *  move (the two-clock law holds by construction); only the chromium
   *  screenshot count drops. A PSNR below the floor (or unmeasurable)
   *  falls back to per-frame rendering — fail-closed. Default ON; `false`
   *  restores the per-frame loop verbatim (the benchmark's off arm). */
  staticFrameDedup?: boolean;
}

export interface GraphicsSceneRenderResult {
  sceneId: string;
  durationMs: number;
  frames: number;
  file: string;
  /** S165 — the dedup receipt, present only when the scene carried at
   *  least one deduped stretch: `reusedFrames` = delivered frames that
   *  rode the anchor's bytes (the clock is unchanged — frames stays the
   *  delivered count), `screenshotsTaken` = chromium rasters the scene
   *  actually paid for. Absent on a fully per-frame scene (the additive
   *  seam law). */
  dedup?: { reusedFrames: number; screenshotsTaken: number };
}

/** S163 Phase B — one rendered transition window (an additive result
 *  field: absent on a legacy doc's render, present only when the doc
 *  opted in). `frames` is the window's delivered frame count; `type` the
 *  designed beat. The window file joins the concat list at its boundary. */
export interface GraphicsWindowRenderResult {
  boundary: number;
  type: NativeTransitionType;
  frames: number;
  file: string;
}

/** The contract artifacts a graphics render returns alongside the files —
 *  the whiteboard shape mirrored (minus boardModes: the graphics doc has
 *  no board policy; the doc clock IS the timeline): the engine-authored
 *  tracks (the frame plan in the universal grammar, audio truth included)
 *  and the composition plan read BACK from them through the same
 *  planFromTracks every engine-lane consumer uses — the two-clock pin
 *  (plan ≡ delivered frames) is enforced below. */
export interface GraphicsRenderResult {
  scenes: GraphicsSceneRenderResult[];
  file: string;
  tracks: TimelineTrack[];
  plan: CompositionPlan;
  /** S131 — the doc's events projected onto the global doc clock (the
   *  event channel's one seam — the audio/QC consumers' fact source;
   *  cues are not clips, so they never ride the tracks). */
  events: GraphicsEventSlot[];
  /** S163 Phase B — the rendered transition windows in boundary order
   *  (absent ⇒ the legacy path ran untouched — the additive-seam law). */
  windows?: GraphicsWindowRenderResult[];
}

// ---------------------------------------------------------------------------
// S132 — the resume manifest: the interrupted render's record. ONE file in
// the outDir (render-manifest.json), written after every encoded scene so
// a crash loses at most the scene it was mid-rendering. The fingerprint
// pins EVERY input that shapes the scene files (the doc's strict write,
// the raw VO/music paths, the frame step, the sprite assets) — resume
// against different inputs refuses instead of mixing two renders.
// ---------------------------------------------------------------------------

const RENDER_MANIFEST_VERSION = 1;

interface RenderManifestScene {
  sceneId: string;
  index: number;
  status: "encoded" | "pending";
  file: string;
  frames: number;
}

interface RenderManifest {
  version: number;
  fingerprint: string;
  scenes: RenderManifestScene[];
}

function renderManifestPath(outDir: string): string {
  return path.join(outDir, "render-manifest.json");
}

/** The tolerant read (the house doc law): null on unreadable — junk JSON,
 *  a wrong version, structural nonsense. A corrupt manifest is treated as
 *  NO manifest: the render starts fresh rather than resuming from a lie.
 *  Exported for the unit pins (the io contract IS the recovery contract). */
export function readRenderManifest(outDir: string): RenderManifest | null {
  try {
    const raw = JSON.parse(fs.readFileSync(renderManifestPath(outDir), "utf8")) as RenderManifest;
    if (
      raw === null || typeof raw !== "object" || raw.version !== RENDER_MANIFEST_VERSION ||
      typeof raw.fingerprint !== "string" || !Array.isArray(raw.scenes)
    ) {
      return null;
    }
    return raw;
  } catch {
    return null;
  }
}

function writeRenderManifest(outDir: string, manifest: RenderManifest): void {
  fs.writeFileSync(renderManifestPath(outDir), JSON.stringify(manifest, null, 2) + "\n");
}
/** Exported for the unit pins alongside the read. */
export { writeRenderManifest, renderManifestPath };

/** The render fingerprint — sha256 over EVERY input that shapes the scene
 *  files: the doc's strict write (version-first, key-stable), the raw VO
 *  and music paths, the frame step, the sprite assets. Deterministic; a
 *  change in any of them refuses resume (fail-closed). Exported for the
 *  unit pins. */
export function renderFingerprint(doc: GraphicsDoc, opts: RenderGraphicsOptions): string {
  const vo = [...(opts.voFiles?.entries() ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const sprites = [...(opts.spriteAssets?.entries() ?? [])].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash("sha256")
    .update(writeGraphicsDoc(doc))
    .update(JSON.stringify({ vo, music: opts.musicPath ?? null, frameStep: opts.frameStep ?? 1, sprites }))
    .digest("hex")
    .slice(0, 32);
}

/** S132 — the resume decision, PURE (file existence rides a predicate so
 *  the pins run without a filesystem). null ⇒ nothing to resume (a fresh
 *  start); a refusal ⇒ the fingerprint mismatch (fail-closed, the exact
 *  reason text); else the plan — the manifest plus the encoded-and-present
 *  scenes that skip chromium + encode and rejoin the assembly. Exported
 *  for the unit pins (the decision IS the contract). */
export function resumePlan(
  manifest: RenderManifest | null,
  fingerprint: string,
  fileExists: (p: string) => boolean,
): { refusal: string } | { plan: RenderManifest; resumable: Map<number, { file: string; frames: number }> } | null {
  if (manifest === null) return null;
  if (manifest.fingerprint !== fingerprint) {
    return {
      refusal:
        "the render inputs changed since the interrupted run (the doc, the VO/music inputs, the frame step or the sprite assets) — resume refuses rather than mixing two renders' scenes",
    };
  }
  const resumable = new Map<number, { file: string; frames: number }>();
  for (const s of manifest.scenes) {
    if (s.status === "encoded" && fileExists(s.file)) {
      resumable.set(s.index, { file: s.file, frames: s.frames });
    }
  }
  return { plan: manifest, resumable };
}

/** The scene clock's absolute start in ms — the EXACT running sum of the
 *  scene durations (the same arithmetic frame.ts sceneClocks performs
 *  internally), so the render's global frame time and frameAt's internal
 *  scene resolution can never disagree. Exported for the unit pins. */
export function sceneCursorMs(sceneMs: number[], index: number): number {
  let cursor = 0;
  for (let i = 0; i < index; i++) cursor += sceneMs[i];
  return cursor;
}

/** The per-scene encode args — the whiteboard encode law, mirrored: frames
 *  at doc.fps, yuv420p, VO (apad — the slot must PAD to the scene duration
 *  so the hold survives, never -shortest) or the anullsrc silent fill (the
 *  S87 slice-5 stream-homogeneity law: when ANY scene carries VO, EVERY
 *  scene file carries an audio stream, or the concat's amix seam matches
 *  no streams). -t bounds every stream to the DELIVERED seconds (the
 *  frame-quantized clock — the R-1 arithmetic the preflight wall checked).
 *  Exported for the unit pins (the arg list IS the contract). */
export function graphicsEncodeArgs(input: {
  framesDir: string;
  /** The encode's OWN rate — the final's doc.fps, or the look's
   *  doc.fps / frameStep (12 | 15). Never assumed from either. */
  fps: number;
  durSec: number;
  voPath: string | null;
  silentFill: boolean;
  sceneFile: string;
}): string[] {
  const args: string[] = [
    "-y",
    "-framerate", String(input.fps),
    "-i", path.join(input.framesDir, "f%05d.jpg"),
  ];
  if (input.voPath) args.push("-i", input.voPath);
  else if (input.silentFill) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push(
    "-filter_complex", "[0:v]format=yuv420p[v]",
    "-map", "[v]",
    ...((input.voPath || input.silentFill)
      ? ["-map", "1:a", "-c:a", "aac", "-b:a", "160k", "-af", "apad"]
      : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
    "-t", input.durSec.toFixed(3),
    input.sceneFile,
  );
  return args;
}

/** The final assembly args — the whiteboard assembly law, mirrored (minus
 *  the SFX layer, which v1 graphics does not carry): concat + the bed at
 *  the house gains (0.16 UNDER the voice, 1.0 solo — the S64 receipt), the
 *  amix arms normalize=0 (never amix's hidden ½ divider), every stream
 *  bounded (the bed by -t, the mix by duration=first, the video by the
 *  concat). No bed: stream copy (the concat is the whole program).
 *  Exported for the unit pins. */
export function graphicsAssemblyArgs(input: {
  listFile: string;
  finalFile: string;
  totalSec: number;
  musicPath: string | null;
  anyVoAudio: boolean;
  /** B4-4 — the S131 sfx events, resolved to wav paths + projected global
   *  times. ABSENT (or empty) ⇒ byte-identical args (the additive-seam law:
   *  every doc rendered so far — and every doc without sfx cues forever —
   *  encodes exactly as before). Present ⇒ each cue is adelayed to its
   *  projected time and amixed under the bed at a fixed gain (the recipes
   *  are already level-tuned; the mixer adds no per-cue polish). */
  sfxCues?: { path: string; tSec: number }[];
}): string[] {
  const cues = input.sfxCues ?? [];
  if (!input.musicPath) {
    // B4-4 — sfx can ride even a bed-less program: the concat (voice or a
    // generated silence anchor) + the delayed cues. duration=first rules by
    // the FIRST mix input — the VO (the program) or the silence (totalSec),
    // never by a short cue.
    if (cues.length > 0) {
      const sfxInputs = cues.flatMap((c) => ["-i", c.path]);
      const sfxChains = cues
        .map((c, i) => `[${i + 1}:a]adelay=${Math.round(c.tSec * 1000)}:all=1,volume=0.9[s${i}]`)
        .join(";");
      const sfxLabels = cues.map((_, i) => `[s${i}]`).join("");
      if (input.anyVoAudio) {
        return [
          "-y",
          "-f", "concat", "-safe", "0", "-i", input.listFile,
          ...sfxInputs,
          "-filter_complex",
            "[0:v]format=yuv420p[v];" + sfxChains + (sfxChains ? ";" : "") +
            "[0:a]" + sfxLabels + `amix=inputs=${cues.length + 1}:duration=first:normalize=0[a]`,
          "-map", "[v]", "-map", "[a]",
          input.finalFile,
        ];
      }
      return [
        "-y",
        "-f", "concat", "-safe", "0", "-i", input.listFile,
        ...sfxInputs,
        "-filter_complex",
          "[0:v]format=yuv420p[v];" +
          `anullsrc=r=48000:cl=stereo:d=${input.totalSec.toFixed(3)}[sil];` +
          sfxChains + (sfxChains ? ";" : "") +
          "[sil]" + sfxLabels + `amix=inputs=${cues.length + 1}:duration=first:normalize=0[a]`,
        "-map", "[v]", "-map", "[a]",
        input.finalFile,
      ];
    }
    return ["-y", "-f", "concat", "-safe", "0", "-i", input.listFile, "-c", "copy", input.finalFile];
  }
  const bedGain = input.anyVoAudio ? 0.16 : 1.0;
  const bedChain =
    "[1:a]volume=" + bedGain +
    ",afade=t=in:st=0:d=1.5" +
    ",afade=t=out:st=" + Math.max(0, input.totalSec - 2).toFixed(3) + ":d=2";
  // B4-4 — with a bed the cues join the SAME amix (voice? + bed + cues):
  // one mix, one duration anchor ([0:a] with VO — the program; [bed] without
  // VO — the looped, -t-bounded bed). No cues ⇒ the exact pre-B4 strings.
  if (cues.length > 0) {
    const sfxInputs = cues.flatMap((c) => ["-i", c.path]);
    const sfxChains = cues
      .map((c, i) => `[${i + 2}:a]adelay=${Math.round(c.tSec * 1000)}:all=1,volume=0.9[s${i}]`)
      .join(";");
    const headLabels = input.anyVoAudio ? "[0:a][bed]" : "[bed]";
    return [
      "-y",
      "-f", "concat", "-safe", "0", "-i", input.listFile,
      "-stream_loop", "-1", "-t", input.totalSec.toFixed(3), "-i", input.musicPath,
      ...sfxInputs,
      "-filter_complex",
        "[0:v]format=yuv420p[v];" + bedChain + "[bed];" + sfxChains + (sfxChains ? ";" : "") +
        headLabels + cues.map((_, i) => `[s${i}]`).join("") +
        `amix=inputs=${cues.length + (input.anyVoAudio ? 2 : 1)}:duration=first:normalize=0[a]`,
      "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
      "-c:a", "aac", "-b:a", "160k",
      input.finalFile,
    ];
  }
  return [
    "-y",
    "-f", "concat", "-safe", "0", "-i", input.listFile,
    "-stream_loop", "-1", "-t", input.totalSec.toFixed(3), "-i", input.musicPath,
    "-filter_complex",
      input.anyVoAudio
        ? "[0:v]format=yuv420p[v];" + bedChain + "[bed];[0:a][bed]amix=inputs=2:duration=first:normalize=0[a]"
        : "[0:v]format=yuv420p[v];" + bedChain + "[a]",
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
    "-c:a", "aac", "-b:a", "160k",
    input.finalFile,
  ];
}

/** S163 Phase B — the transition-window encode args. The SCENE law
 *  mirrored (graphicsEncodeArgs), with ONE addition: the OUTGOING scene's
 *  VO slot rides as input 1 OFFSET by the outgoing clip's delivered
 *  seconds (-ss) — the carved tail CONTINUES through the window (the
 *  audio law in transitions.ts: narration spanning the seam is never
 *  clipped mid-word), apad fills whatever the slot lacks, and -t bounds
 *  the output to the window's delivered seconds. Silent fill and the
 *  audio-less shape match the scene encoder exactly (the S87 slice-5
 *  stream-homogeneity law: the window file is concat-homogeneous with its
 *  neighbor scenes). Exported for the unit pins (the arg list IS the
 *  contract). */
export function graphicsWindowEncodeArgs(input: {
  framesDir: string;
  /** The window's OWN encode rate — the scene law (doc.fps, or the look's
   *  doc.fps / frameStep). Never assumed. */
  fps: number;
  /** The window's delivered seconds — the PLAN's number (frames ÷ doc.fps,
   *  derived once), never re-derived here. */
  durSec: number;
  /** The OUTGOING scene's VO slot (null when that scene is silent). */
  voPath: string | null;
  /** The outgoing clip's delivered seconds — the VO's -ss offset. */
  voOffsetSec: number;
  silentFill: boolean;
  windowFile: string;
}): string[] {
  const args: string[] = [
    "-y",
    "-framerate", String(input.fps),
    "-i", path.join(input.framesDir, "f%05d.jpg"),
  ];
  if (input.voPath) args.push("-ss", input.voOffsetSec.toFixed(3), "-i", input.voPath);
  else if (input.silentFill) args.push("-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo");
  args.push(
    "-filter_complex", "[0:v]format=yuv420p[v]",
    "-map", "[v]",
    ...((input.voPath || input.silentFill)
      ? ["-map", "1:a", "-c:a", "aac", "-b:a", "160k", "-af", "apad"]
      : []),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "19",
    "-t", input.durSec.toFixed(3),
    input.windowFile,
  );
  return args;
}

/** S163 Phase B — the concat order: each window file inserts exactly
 *  after its OUTGOING scene's file (entry b joins scene b and b+1).
 *  PURE; an empty/absent window map returns the scene files verbatim —
 *  the legacy concat list byte-identical (the additive-seam law).
 *  Exported for the unit pins. */
export function graphicsConcatEntries(
  sceneFiles: string[],
  windowFiles: ReadonlyMap<number, string>,
): string[] {
  const out: string[] = [];
  for (let i = 0; i < sceneFiles.length; i++) {
    const scene = sceneFiles[i];
    if (scene === undefined) continue;
    out.push(scene);
    const windowFile = windowFiles.get(i);
    if (windowFile !== undefined) out.push(windowFile);
  }
  return out;
}

/** The transition-window clip's file for a boundary — window-<b+1>.mp4,
 *  the scene-<n>.mp4 numbering mirrored. Exported for the unit pins. */
export function graphicsWindowFile(outDir: string, boundary: number): string {
  return path.join(outDir, `window-${boundary + 1}.mp4`);
}

/** Render one validated graphics doc to <outDir>/final.mp4. The caller
 *  passes the output of parseGraphicsDoc/validateGraphicsDoc — the doc IS
 *  the render input of record (the grammar gate ran at admission). */
export async function renderGraphics(
  doc: GraphicsDoc,
  opts: RenderGraphicsOptions
): Promise<GraphicsRenderResult> {
  // The VO slots FIRST (S152 — the measured-narration clock needs the
  // durations before the wall reads the clock): normalized at the engine
  // boundary (the S76 loudness contract — in-window slots pass through
  // untouched), probed via WAV header math BEFORE chromium so the encode
  // law knows every stream's shape up front, and the measured ms feed the
  // ONE clock rule below (an unplanned scene extends to its narration —
  // the whiteboard precedence, mirrored).
  const voResolved = new Map<string, string>();
  const voMsBySceneId = new Map<string, number>();
  let anyVoAudio = false;
  const voNormDir = path.join(opts.outDir, "vo-norm");
  for (const scene of doc.scenes) {
    const voRaw = opts.voFiles?.get(scene.id) ?? null;
    if (!voRaw) continue;
    anyVoAudio = true;
    const voPath = await normalizeVoSlot(voRaw, voNormDir, scene.id);
    voResolved.set(scene.id, voPath);
    try {
      const sec = wavDurationSec(fs.readFileSync(voPath));
      if (sec > 0) voMsBySceneId.set(scene.id, Math.round(sec * 1000));
    } catch {
      /* unreadable slot → the scene rides the estimate (the ladder floor) */
    }
  }

  // The preflight wall (the E0 audit §6 risk-4 receipt: 4GB workers
  // learn about unbounded renders from the OOM killer, never from this
  // renderer) — the DELIVERED frame arithmetic at doc.fps (R-1), on the
  // SAME measured clock the loop below delivers (S152), before
  // chromium launches.
  assertGraphicsBudget(doc, voMsBySceneId);

  // The clock — ONE derivation shared with the wall and the tracks.
  const sceneMs = graphicsSceneDurationsMs(doc, voMsBySceneId);
  const plan = framePlanWindows(sceneMs, doc.fps);

  // S87 slice 3 — COMPOSE THROUGH THE CONTRACT: the engine emits its
  // timeline tracks (visual + the P3 audio truth), and the plan is read
  // back from those tracks through the same planFromTracks the compositor
  // lane uses. The loop and the assembly below read the frame-quantized
  // clock the tracks carry — one derivation (a null plan here is an engine
  // bug: we JUST derived the tracks from a validated doc).
  const tracks = graphicsTracks(doc, {
    voSceneIds: voResolved.keys(),
    musicOn: opts.musicPath != null,
    voMsBySceneId,
  });
  const contractPlan = planFromTracks({ tracks }, doc.scenes.length);
  if (!contractPlan) {
    throw new Error(
      "the graphics frame plan failed the timeline contract — an engine bug, not a doc problem"
    );
  }

  const { chromium } = await import("playwright");
  fs.mkdirSync(opts.outDir, { recursive: true });

  // S163 Phase B — the native transition plan: the doc's opt-in specs
  // become the window plan through the ONE pure derivation (BEFORE
  // chromium — a structural refusal never spends the launch). The plan's
  // identity — Σ clips + Σ windows ≡ Σ legacy scene frames — is what the
  // two-clock assert below enforces on the DELIVERED files; absent specs
  // ⇒ null ⇒ the byte-identical legacy path.
  const nativePlan: NativeTransitionPlan | null = planNativeTransitions({
    scenes: plan.scenes,
    fps: doc.fps,
    specs: doc.nativeTransitions ?? [],
  });

  // S132 — the resume setup. The fingerprint pins every input that shapes
  // the scene files; a mismatch refuses (fail-closed) instead of mixing
  // two renders' scenes. Encoded scenes rejoin only when their FILE still
  // exists — a cleaned outDir simply re-renders.
  const fingerprint = renderFingerprint(doc, opts);
  let manifest: RenderManifest | null = null;
  const resumable = new Map<number, { file: string; frames: number }>();
  if (opts.resume === true) {
    const decision = resumePlan(readRenderManifest(opts.outDir), fingerprint, (p) => fs.existsSync(p));
    if (decision !== null && "refusal" in decision) throw new Error(decision.refusal);
    if (decision !== null) {
      manifest = decision.plan;
      for (const [i, r] of decision.resumable) resumable.set(i, r);
    }
  }
  // S145 — the Phase-3 drill's finding: the manifest must be written on the
  // FRESH path too. The resume gate above used to be the only writer, so a
  // FIRST-time render that crashed mid-program left no crash record — the
  // seam's own contract ("a crash loses at most the scene it was
  // mid-rendering") was dead for the exact scenario it exists for. The
  // manifest is recovery bookkeeping: it never shapes scene bytes (the
  // fingerprint pins those), and a COMPLETED render still deletes it below.
  if (manifest === null) {
    manifest = {
      version: RENDER_MANIFEST_VERSION,
      fingerprint,
      scenes: doc.scenes.map((scene, i) => ({
        sceneId: scene.id,
        index: i,
        status: "pending" as const,
        file: path.join(opts.outDir, `scene-${i + 1}.mp4`),
        frames: 0,
      })),
    };
    writeRenderManifest(opts.outDir, manifest);
  }

  // The look-rate (labelled drafts only — see RenderGraphicsOptions).
  const step = opts.frameStep === 2 ? 2 : 1;
  const effFps = doc.fps / step;
  const browser = await chromium.launch({ headless: true, args: [...WB_CHROMIUM_LAUNCH_ARGS] });

  const sceneFiles: GraphicsSceneRenderResult[] = [];
  try {
    for (let si = 0; si < doc.scenes.length; si++) {
      const scene = doc.scenes[si];
      // S163 Phase B — the DELIVERED clip: the outgoing scene's own window
      // carved from its tail (planNativeTransitions), or the legacy frames
      // untouched when the doc carries no specs (byte-identity).
      const clipFrames = nativePlan !== null ? nativePlan.sceneClipFrames[si] : plan.scenes[si].frames;
      const frames = Math.ceil(clipFrames / step);
      const durSec = nativePlan !== null ? nativePlan.sceneClipSec[si] : plan.scenes[si].deliveredSec;
      const durationMs = sceneMs[si];
      const cursorMs = sceneCursorMs(sceneMs, si);

      // S132 — the resume skip: an encoded scene whose file survived the
      // interruption rejoins the assembly untouched (chromium + encode
      // never run for it; the manifest is the record, the fingerprint the
      // guarantee its content matches this render's inputs).
      const resumed = resumable.get(si);
      if (resumed !== undefined) {
        opts.onProgress?.(
          `scene ${si + 1}/${doc.scenes.length} ("${scene.id}"): resumed (the encoded scene reused)`,
          si / doc.scenes.length,
        );
        sceneFiles.push({ sceneId: scene.id, durationMs, frames: resumed.frames, file: resumed.file });
        continue;
      }

      // Per-scene context recycling (the S75 E10 receipt) + security line 2.
      const context = await browser.newContext({
        viewport: { width: doc.width, height: doc.height },
        deviceScaleFactor: 1,
      });
      await context.route("**/*", (route) => route.abort());
      const page = await context.newPage();
      try {
        opts.onProgress?.(
          `scene ${si + 1}/${doc.scenes.length} ("${scene.id}"): composing`,
          si / doc.scenes.length
        );
        const composed = composeGraphicsScene(scene, doc, { spriteAssets: opts.spriteAssets });
        // S126 — fail-closed on unresolved imports: the compose records the
        // missing keys; the render refuses BEFORE any chromium work on
        // them (a silently missing sprite would ship a lie).
        if (composed.missingAssets.length > 0) {
          throw new Error(
            `unresolved sprite imports (${composed.missingAssets.join(", ")}) — resolve them through the import store before rendering`
          );
        }
        await withRenderGate(
          { engine: "graphics", gate: "page-load", detail: `scene ${si + 1} ("${scene.id}")` },
          () => page.setContent(composed.html, { waitUntil: "load" }),
        );

        const framesDir = path.join(opts.outDir, `scene-${si + 1}-frames`);
        fs.mkdirSync(framesDir, { recursive: true });
        // S165 — the static-frame dedup scan (the kenburns/holds lane).
        // Each delivered frame's applier input serializes to a key FIRST
        // (frame.ts is pure, so the scan is math only — no chromium time);
        // maximal equal-key runs are the static stretches. THE KEY IS THE
        // APPLIER'S EFFECTIVE INPUT (graphicsFrameApplierKey — elements +
        // camera, NOT the provenance sceneTMs/sceneId the applier never
        // reads): a hold's clock advances, its picture does not. Equal keys
        // ⇒ equal DOM ⇒ equal pixels by the idempotence law; the real-raster
        // PSNR spot check below still verifies it against the LIVE page.
        // payloadKeys (the full payload, clock included) stay the applier's
        // per-frame input — byte-identical to the pre-dedup render.
        const sceneTag = `scene ${si + 1} ("${scene.id}")`;
        const payloadKeys: string[] = new Array(frames);
        const applierKeys: string[] = new Array(frames);
        for (let f = 0; f < frames; f++) {
          // The GLOBAL doc clock — the exact truth the editor reads: scene
          // resolution + the scene-local motion evaluation stay one call
          // (the R-6 law), with no quantization drift (cursorMs is the
          // exact ms sum, not the frame-quantized boundary). A look-rate
          // (step 2) samples every OTHER frame at its exact doc time.
          const tMs = cursorMs + ((f * step) / doc.fps) * 1000;
          const frame = frameAt(doc, tMs, voMsBySceneId);
          payloadKeys[f] = JSON.stringify(graphicsFramePayload(frame));
          applierKeys[f] = graphicsFrameApplierKey(frame);
        }
        const stretches =
          opts.staticFrameDedup === false ? [] : findStaticStretches(applierKeys);
        let stretchIdx = 0;
        let dedupScreenshots = 0;
        let dedupReused = 0;
        for (let f = 0; f < frames; ) {
          const st = stretches[stretchIdx];
          if (st !== undefined && st.start === f) {
            // The dedup lane: anchor + PSNR spot check + reuse (or the
            // fail-closed per-frame fallback inside).
            const seg = await renderDedupedStretch({
              page,
              framesDir,
              outDir: opts.outDir,
              sceneTag,
              width: doc.width,
              height: doc.height,
              payloadKeys,
              stretch: st,
            });
            dedupScreenshots += seg.screenshots;
            dedupReused += seg.reused;
            if (seg.reused > 0) {
              opts.onProgress?.(
                `${sceneTag}: frame ${seg.next}/${frames} (dedup: ${seg.reused} frames reused from the anchor)`,
                (si + seg.next / frames) / doc.scenes.length,
              );
            }
            f = seg.next;
            stretchIdx++;
            continue;
          }
          // The per-frame lane (also the fallback for every non-stretch
          // frame): the payload STRING is double-encoded into a quoted
          // literal — the applier JSON.parses it inside the page
          // (the whiteboard's evaluate law verbatim; the exact SyntaxError
          // the P5 proof caught on its first run).
          await withRenderGate(
            { engine: "graphics", gate: "apply", detail: `${sceneTag} frame ${f}` },
            () => page.evaluate(`(${APPLY_GRAPHICS_FRAME_FN})(${payloadKeys[f]})`),
          );
          await withRenderGate(
            { engine: "graphics", gate: "screenshot", detail: `${sceneTag} frame ${f}` },
            () =>
              page.screenshot({
                path: path.join(framesDir, `f${String(f).padStart(5, "0")}.jpg`),
                type: "jpeg",
                quality: 92,
                clip: { x: 0, y: 0, width: doc.width, height: doc.height },
              }),
          );
          if (f % 24 === 0) {
            opts.onProgress?.(
              `${sceneTag}: frame ${f + 1}/${frames}`,
              (si + (f + 1) / frames) / doc.scenes.length,
            );
          }
          f++;
        }

        // Encode the scene: frames (+ VO when present). Music joins at
        // assembly. The S87 slice-5 law: every scene carries an audio
        // stream when ANY scene does.
        const voPath = voResolved.get(scene.id) ?? null;
        const silentFill = !voPath && anyVoAudio;
        const sceneFile = path.join(opts.outDir, `scene-${si + 1}.mp4`);
        await runFfmpeg(graphicsEncodeArgs({
          framesDir,
          fps: effFps,
          durSec,
          voPath,
          silentFill,
          sceneFile,
        }), `${sceneTag} encode`);
        fs.rmSync(framesDir, { recursive: true, force: true });
        sceneFiles.push({
          sceneId: scene.id,
          durationMs,
          frames,
          file: sceneFile,
          // S165 — the honest dedup receipt (absent when nothing reused).
          ...(dedupReused > 0 ? { dedup: { reusedFrames: dedupReused, screenshotsTaken: dedupScreenshots } } : {}),
        });
        // S132 — the manifest records the encoded scene the moment it
        // exists: a crash after this line loses at most the NEXT scene.
        if (manifest !== null) {
          const entry = manifest.scenes[si];
          if (entry !== undefined) {
            entry.status = "encoded";
            entry.frames = frames;
            entry.file = sceneFile;
            writeRenderManifest(opts.outDir, manifest);
          }
        }
      } finally {
        await context.close().catch(() => {});
      }
    }

    // S163 Phase B — the transition-window clips: one per boundary, each
    // rendered AFTER the scene loop (self-contained — it screenshots the
    // two scenes' seam snapshots from the compose, never from the encoded
    // files, so a resumed scene's window renders identically). The window
    // joins the concat list exactly after its outgoing scene's file.
    const windowFiles = new Map<number, string>();
    const windowResults: GraphicsWindowRenderResult[] = [];
    if (nativePlan !== null) {
      for (const win of nativePlan.windows) {
        const boundary = win.boundary;
        const outScene = doc.scenes[boundary];
        const inScene = doc.scenes[boundary + 1];
        if (outScene === undefined || inScene === undefined) {
          throw new Error(
            `the native transition window at boundary ${boundary} has no scene pair — an engine bug, not a doc problem`,
          );
        }
        const windowFile = graphicsWindowFile(opts.outDir, boundary);
        const framesDir = path.join(opts.outDir, `window-${boundary + 1}-frames`);
        opts.onProgress?.(
          `window ${boundary + 1}/${nativePlan.windows.length} ("${outScene.id}" → "${inScene.id}", ${win.spec.type}): composing`,
          boundary / Math.max(doc.scenes.length, 1),
        );
        // Per-window context recycling (the S75 E10 receipt, mirrored) +
        // security line 2: the page renders only what these strings carry.
        const context = await browser.newContext({
          viewport: { width: doc.width, height: doc.height },
          deviceScaleFactor: 1,
        });
        await context.route("**/*", (route) => route.abort());
        const page = await context.newPage();
        try {
          const surface = { width: doc.width, height: doc.height };
          const windowTag = `window ${boundary + 1} ("${outScene.id}" → "${inScene.id}", ${win.spec.type})`;
          const shot = async (target: typeof outScene, tMs: number): Promise<Buffer> => {
            const composed = composeGraphicsScene(target, doc, { spriteAssets: opts.spriteAssets });
            if (composed.missingAssets.length > 0) {
              throw new Error(
                `unresolved sprite imports (${composed.missingAssets.join(", ")}) — resolve them through the import store before rendering`,
              );
            }
            await withRenderGate(
              { engine: "graphics", gate: "page-load", detail: windowTag },
              () => page.setContent(composed.html, { waitUntil: "load" }),
            );
            const payload = graphicsFramePayload(frameAt(doc, tMs, voMsBySceneId));
            await withRenderGate(
              { engine: "graphics", gate: "apply", detail: windowTag },
              () => page.evaluate(`(${APPLY_GRAPHICS_FRAME_FN})(${JSON.stringify(payload)})`),
            );
            return withRenderGate(
              { engine: "graphics", gate: "screenshot", detail: windowTag },
              () => page.screenshot({ type: "jpeg", quality: 92, clip: { x: 0, y: 0, width: doc.width, height: doc.height } }),
            );
          };
          // The two SNAPSHOTS: the outgoing scene's final DELIVERED frame
          // (the frame its clip ends on — the window's p→0 limit continues
          // it exactly) and the incoming scene's first frame (the window's
          // p→1 limit hands off to it exactly). Exact doc-clock times.
          const outCursorMs = sceneCursorMs(sceneMs, boundary);
          const snapA = await shot(outScene, outCursorMs + ((nativePlan.sceneClipFrames[boundary] - 1) / doc.fps) * 1000);
          const snapB = await shot(inScene, sceneCursorMs(sceneMs, boundary + 1));
          await withRenderGate(
            { engine: "graphics", gate: "page-load", detail: `${windowTag} compositor page` },
            () =>
              page.setContent(
                transitionCompositorPage(doc.width, doc.height, `data:image/jpeg;base64,${snapA.toString("base64")}`, `data:image/jpeg;base64,${snapB.toString("base64")}`),
                { waitUntil: "load" },
              ),
          );
          // The compositor page's READY gate: the two seam images must be
          // decoded before frame 0 rasters (a pending decode would screenshot
          // a blank canvas).
          await withRenderGate(
            { engine: "graphics", gate: "compose", detail: `${windowTag} seam image decode` },
            () => page.evaluate("Promise.all([window.__timgA.decode(), window.__timgB.decode()]).then(() => true)"),
          );

          fs.mkdirSync(framesDir, { recursive: true });
          const windowFrames = Math.ceil(win.frames / step);
          for (let f = 0; f < windowFrames; f++) {
            // The OPEN-interval ramp: delivered frame k shows progress
            // (k+1)/(N+1) — the pure endpoints live in the neighbor clips,
            // so both seams are quantization-tight (the module's law). A
            // look-rate samples every OTHER delivered frame at its exact
            // progress (the scene loop's step law, mirrored).
            const k = f * step;
            const desc = compositeTransitionFrame(surface, surface, (k + 1) / (win.frames + 1), win.spec, surface);
            // The whiteboard's evaluate law verbatim (the P5 proof): the
            // applier takes the payload STRING and JSON.parses it inside the
            // page — the description is double-encoded into a quoted literal
            // here. Interpolating the raw JSON would pass an OBJECT where
            // the applier expects a string (the exact SyntaxError the P5
            // proof caught on its first run — and the live smoke caught
            // here).
            await withRenderGate(
              { engine: "graphics", gate: "apply", detail: `${windowTag} frame ${f}` },
              () => page.evaluate(`(${APPLY_TRANSITION_FRAME_FN})(${JSON.stringify(JSON.stringify(desc))})`),
            );
            await withRenderGate(
              { engine: "graphics", gate: "screenshot", detail: `${windowTag} frame ${f}` },
              () =>
                page.screenshot({
                  path: path.join(framesDir, `f${String(f).padStart(5, "0")}.jpg`),
                  type: "jpeg",
                  quality: 92,
                  clip: { x: 0, y: 0, width: doc.width, height: doc.height },
                }),
            );
            if (f % 24 === 0) {
              opts.onProgress?.(
                `window ${boundary + 1}/${nativePlan.windows.length} ("${outScene.id}" → "${inScene.id}", ${win.spec.type}): frame ${f + 1}/${windowFrames}`,
                (boundary + (f + 1) / windowFrames) / doc.scenes.length,
              );
            }
          }

          // Encode the window: frames + the OUTGOING scene's carved VO
          // tail (offset by the outgoing clip's seconds — narration spans
          // the seam), the silent fill when any scene carries audio, or no
          // audio stream at all (the concat homogeneity law, mirrored).
          const voPath = voResolved.get(outScene.id) ?? null;
          await runFfmpeg(graphicsWindowEncodeArgs({
            framesDir,
            fps: effFps,
            durSec: win.sec,
            voPath,
            voOffsetSec: nativePlan.sceneClipSec[boundary],
            silentFill: !voPath && anyVoAudio,
            windowFile,
          }), `${windowTag} encode`);
          fs.rmSync(framesDir, { recursive: true, force: true });
          windowFiles.set(boundary, windowFile);
          windowResults.push({ boundary, type: win.spec.type, frames: windowFrames, file: windowFile });
        } finally {
          await context.close().catch(() => {});
        }
      }
    }

    // Final assembly: the two-clock assert first (the whiteboard law — the
    // delivered Σ must equal the contract's total, or the render refuses
    // instead of shipping a desynced projection), then concat + bed. With
    // native transitions the delivered Σ reads the plan's identity (Σ clips
    // + Σ windows ≡ the doc clock); without them the legacy sum verbatim.
    const finalFile = path.join(opts.outDir, "final.mp4");
    const totalSec = nativePlan !== null
      ? nativePlan.totalSec
      : plan.scenes.reduce((a, s) => a + s.deliveredSec, 0);
    if (Math.abs(contractPlan.totalSec - Math.round(totalSec * 100) / 100) > 0.001) {
      throw new Error(
        "the graphics assembly clock diverged from the timeline contract — an engine bug, not a doc problem"
      );
    }
    const listFile = path.join(opts.outDir, "concat.txt");
    // The concat order: each window file inserts exactly after its
    // outgoing scene's file (graphicsConcatEntries; a legacy doc's list is
    // the scene files verbatim — byte-identity).
    const concatFiles = graphicsConcatEntries(sceneFiles.map((s) => s.file), windowFiles);
    fs.writeFileSync(listFile, concatFiles.map((f) => `file '${path.resolve(f)}'`).join("\n") + "\n");
    // B4-4 — the S131 seam's audio consumers finally read it: an `sfx` event
    // whose label names a catalog kind becomes a real synthesized sound at
    // its PROJECTED global time (graphicsEventList — the ONE clock truth).
    // A doc without sfx events (every doc so far) resolves NO cues ⇒ the
    // assembly args are byte-identical (the additive-seam law). Capped at 24
    // (a defensive ceiling; the validator already bounds events per scene).
    const sfxCues: { path: string; tSec: number }[] = [];
    for (const ev of graphicsEventList(doc, doc.fps, voMsBySceneId)) {
      if (sfxCues.length >= 24) break;
      if (ev.kind !== "sfx" || !ev.label) continue;
      if (!(SFX_KINDS as readonly string[]).includes(ev.label)) continue;
      const wav = await ensureSfx(ev.label);
      if (wav) sfxCues.push({ path: wav, tSec: ev.tSec });
    }
    await runFfmpeg(graphicsAssemblyArgs({
      listFile,
      finalFile,
      totalSec,
      musicPath: opts.musicPath ?? null,
      anyVoAudio,
      ...(sfxCues.length > 0 ? { sfxCues } : {}),
    }), "final assembly");
    // S132 — the render COMPLETED: the manifest's purpose (resuming an
    // interrupted run) is spent. Delete it so the next run starts fresh;
    // the scene mp4s stay (today's behavior).
    if (manifest !== null) fs.rmSync(renderManifestPath(opts.outDir), { force: true });
    return {
      scenes: sceneFiles,
      file: finalFile,
      tracks,
      plan: contractPlan,
      events: graphicsEventList(doc, doc.fps, voMsBySceneId),
      // S163 Phase B — additive only: a legacy doc's result carries no
      // windows key at all (the additive-seam law, the result shape too).
      ...(nativePlan !== null ? { windows: windowResults } : {}),
    };
  } finally {
    await browser.close();
  }
}
