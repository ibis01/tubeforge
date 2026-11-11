// S94 (ROADMAP #13) — the 3D renderer: three.js WebGL 2.0 under the
// sandbox's SwiftShader headless chromium, through the SAME chromium
// pipeline the Whiteboard engine proves (the E10 launch args, the
// route-abort security line, per-frame screenshots, ffmpeg encode).
// Blender stays the recorded tail — an offline Blender exporter would
// emit the SAME scene3d contract.
//
// Security line 1 (the whiteboard's, verbatim posture): the renderer page
// has NO network — every route aborts. three.js injects as a blob-URL
// module import from the dependency's own source (node_modules ships in
// production builds — no CDN, ever).
//
// The frame clock is the contract's: fps × durationSec frames, rendered
// at cameraAt(keyframes, f/frames) — the pure path the pins hold. The
// encoded clip is an ORDINARY video file: the composition plan reads it
// as a video-kind clip exactly like stock footage — the shared timeline
// consumption the §4.C-5 future-engine assertion pattern proves in the
// smoke.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { log } from "./log";
import { WB_CHROMIUM_LAUNCH_ARGS } from "./whiteboard/render";
import { cameraAt, type Scene3D } from "./scene3d";

const renderLog = log.child({ mod: "render3d" });
const execFileAsync = promisify(execFile);

const THREE_BUILD = path.join(process.cwd(), "node_modules", "three", "build");
const THREE_MODULE_PATH = path.join(THREE_BUILD, "three.module.js");
const THREE_CORE_PATH = path.join(THREE_BUILD, "three.core.js");

async function runFfmpeg(args: string[]): Promise<void> {
  await execFileAsync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", ...args],
    { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }
  );
}

/** The renderer page: a canvas + the three module source, no network.
 *  r187's three.module.js imports "./three.core.js" — BOTH sources are
 *  injected, the core as its own blob URL, the specifier rewritten to it
 *  (a blob URL has no base, so the relative specifier could never resolve). */
function pageHtml(width: number, height: number, threeSource: string, threeCoreSource: string, sceneJson: string): string {
  // Harden the injected sources: a literal `</script>` (or any `<`) inside
  // the stringified source would terminate the inline script early — the
  // classic injection hazard, escaped the standard way.
  const js = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c");
  return `<!doctype html><html><body style="margin:0">
<canvas id="stage" width="${width}" height="${height}"></canvas>
<script>
  window.__SCENE_JSON__ = ${js(sceneJson)};
  window.__ERROR__ = null;
  window.addEventListener("error", (e) => { window.__ERROR__ = String(e.message || e); });
  window.addEventListener("unhandledrejection", (e) => { window.__ERROR__ = String(e.reason || e); });
</script>
<script type="module">
  try {
    const coreSrc = ${js(threeCoreSource)};
    const coreUrl = URL.createObjectURL(new Blob([coreSrc], { type: "text/javascript" }));
    const threeSrc = ${js(threeSource)}.replaceAll("./three.core.js", coreUrl);
    const blob = new Blob([threeSrc], { type: "text/javascript" });
    const THREE = await import(URL.createObjectURL(blob));
  const doc = JSON.parse(window.__SCENE_JSON__);
  const canvas = document.getElementById("stage");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(${width}, ${height}, false);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(doc.background);
  const camera = new THREE.PerspectiveCamera(doc.camera.fov, ${width} / ${height}, 0.1, 100);
  for (const o of doc.objects) {
    let mesh = null;
    if (o.kind === "box") mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1));
    else if (o.kind === "sphere") mesh = new THREE.Mesh(new THREE.SphereGeometry(0.5, 32, 16));
    else if (o.kind === "plane") mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1));
    if (!mesh) continue;
    const m = new THREE.MeshStandardMaterial({
      color: o.material.color,
      metalness: o.material.metalness ?? 0,
      roughness: o.material.roughness ?? 0.6,
      opacity: o.material.opacity ?? 1,
      transparent: (o.material.opacity ?? 1) < 1,
    });
    mesh.material = m;
    mesh.position.set(...o.position);
    if (o.rotation) mesh.rotation.set(...o.rotation);
    if (o.scale) mesh.scale.set(...o.scale);
    mesh.name = o.id;
    scene.add(mesh);
  }
  for (const l of doc.lights) {
    if (l.kind === "ambient") {
      scene.add(new THREE.AmbientLight(new THREE.Color(l.color), l.intensity));
    } else {
      const d = new THREE.DirectionalLight(new THREE.Color(l.color), l.intensity);
      const dir = l.direction ?? [0, 1, 0];
      d.position.set(dir[0] * 10, dir[1] * 10, dir[2] * 10);
      scene.add(d);
    }
  }
  window.__CAMERA__ = (position, lookAt) => {
    camera.position.set(...position);
    camera.lookAt(...lookAt);
    renderer.render(scene, camera);
  };
  window.__READY__ = true;
  } catch (e) {
    window.__ERROR__ = String(e && e.message ? e.message : e);
  }
</script>
</body></html>`;
}

export interface Scene3DRenderResult {
  file: string;
  frames: number;
  durationSec: number;
}

/**
 * Render one 3D scene doc to <outDir>/scene-3d.mp4. Throws a readable
 * error when the rasterizer cannot start (no chromium, no WebGL) — never
 * a silent fake. Progress rides the same checkpoint rhythm the render
 * pipeline reports.
 */
export async function renderScene3D(
  doc: Scene3D,
  opts: { outDir: string; onProgress?: (label: string, frac: number) => void; budgetMs?: number }
): Promise<Scene3DRenderResult> {
  const t0 = Date.now();
  const budgetMs = opts.budgetMs ?? 240_000;
  if (!fs.existsSync(THREE_MODULE_PATH) || !fs.existsSync(THREE_CORE_PATH))
    throw new Error("the 3D renderer needs the three dependency (node_modules/three missing)");

  const frames = Math.max(2, Math.round(doc.durationSec * doc.fps));
  const framesDir = path.join(opts.outDir, "3d-frames");
  fs.rmSync(framesDir, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true, args: [...WB_CHROMIUM_LAUNCH_ARGS, "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  const timer = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), budgetMs));
  const holder: { browser?: import("playwright").Browser } = {};
  const work = (async (): Promise<void> => {
    holder.browser = browser;
    const context = await browser.newContext({
      viewport: { width: doc.width, height: doc.height },
      deviceScaleFactor: 1,
    });
    // Security line 2, verbatim posture: the renderer page has no network.
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const threeSource = fs.readFileSync(THREE_MODULE_PATH, "utf8");
    const threeCoreSource = fs.readFileSync(THREE_CORE_PATH, "utf8");
    await page.setContent(
      pageHtml(doc.width, doc.height, threeSource, threeCoreSource, JSON.stringify(doc)),
      { waitUntil: "load" }
    );
    // The module script must have built the scene; the raster must exist.
    // A failure surfaces the page's own error — never a silent timeout.
    try {
      await page.waitForFunction("window.__READY__ === true", undefined, { timeout: 30_000 });
    } catch {
      const err = await page.evaluate(() =>
        (window as unknown as { __ERROR__: string | null }).__ERROR__
      );
      throw new Error(
        `the 3D renderer page failed to initialize${err ? `: ${err}` : " (no error recorded — check the WebGL deployment)"}`
      );
    }

    for (let f = 0; f < frames; f++) {
      const t = frames > 1 ? f / (frames - 1) : 0;
      const cam = cameraAt(doc.camera.keyframes, t);
      await page.evaluate(
        // The page declares window.__CAMERA__ in its module script; the
        // renderer drives it per frame (the pure cameraAt path).
        ({ position, lookAt }) =>
          (window as unknown as { __CAMERA__: (p: number[], l: number[]) => void }).__CAMERA__(position, lookAt),
        { position: cam.position, lookAt: cam.lookAt }
      );
      const shot = await page.screenshot({
        path: path.join(framesDir, `f${String(f).padStart(5, "0")}.jpg`),
        type: "jpeg",
        quality: 92,
        clip: { x: 0, y: 0, width: doc.width, height: doc.height },
      });
      if (f === 0 && shot.length < 4096)
        throw new Error("the 3D raster produced a blank frame — WebGL unavailable in this deployment");
      if (f % 30 === 0)
        opts.onProgress?.(`3D scene: frame ${f + 1}/${frames}`, (f + 1) / frames);
    }
  })();

  try {
    const winner = await Promise.race([work, timer]);
    if (winner === "timeout")
      throw new Error(`the 3D render exceeded the ${Math.round(budgetMs / 1000)}s frame budget`);
  } finally {
    await holder.browser?.close().catch(() => {});
  }

  // Encode: the frames → an ordinary video clip (no audio — the clip joins
  // the shared assembly like any footage, where narration/bed are mixed).
  const outFile = path.join(opts.outDir, "scene-3d.mp4");
  await runFfmpeg([
    "-y", "-framerate", String(doc.fps),
    "-i", path.join(framesDir, "f%05d.jpg"),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
    "-pix_fmt", "yuv420p",
    outFile,
  ]);
  fs.rmSync(framesDir, { recursive: true, force: true });

  const stat = fs.statSync(outFile);
  if (stat.size < 20_000)
    throw new Error("the 3D encode produced nothing usable — check the chromium raster");
  const durationSec = frames / doc.fps;
  renderLog.info("3D scene rendered", { frames, durationSec, ms: Date.now() - t0 });
  return { file: outFile, frames, durationSec };
}
