// S67 — the whiteboard PAGE-SIDE seam, split out of render.ts so the editor
// can import it. Everything here is PURE string/DOM-contract code — no fs,
// no child_process, no playwright — which is exactly what makes the design
// §5 law enforceable in BOTH directions:
//
//   the renderer rasterizes frameAt() through THESE helpers; the editor
//   plays back frameAt() through THE SAME helpers. What the editor shows at
//   t=12.4s is what the MP4 contains at t=12.4s — there is no second
//   implementation to drift (the determinism law's consequence for UX).
//
// render.ts consumes this module server-side (chromium page.setContent +
// page.evaluate); wb-canvas.tsx consumes it client-side (srcdoc iframe +
// contentWindow.eval). One compose, one applier, two callers.
import { HAND_TIP, type WhiteboardAsset } from "./assets";
import type { CarriedInkPlan, FrameState } from "./timing";
import type { WhiteboardProject, WhiteboardScene } from "./storyboard";
import type { Placement } from "./svg";

export interface ComposedScene {
  html: string;
  /** "assetId::pathId" → browser element id. */
  pathEls: Map<string, string>;
  /** "assetId::text:textId" → browser element id. */
  textEls: Map<string, string>;
}

/** Render one placed asset into the page body + register its element ids
 *  (the namespacing seam shared by the scene's placements and — W6 — the
 *  carried ink, which uses the carried asset's REAL id: the validator
 *  forbids re-placing a carried asset, so the ids stay unambiguous). */
function renderPlacement(
  assetId: string,
  placement: Placement,
  asset: WhiteboardAsset,
  body: string[],
  pathEls: Map<string, string>,
  textEls: Map<string, string>
): void {
  const gid = `g-${assetId}`;
  // Namespace inner ids so page-level lookups stay unambiguous.
  const namespaced = asset.svg
    .replace(/id="([^"]+)"/g, (_m, id: string) => `id="${assetId}--${id}"`)
    .replace(/url\(#([^)]+)\)/g, (_m, id: string) => `url(#${assetId}--${id})`);
  body.push(`<g id="${gid}" transform="translate(${placement.x} ${placement.y}) rotate(${placement.rotateDeg}) scale(${placement.scale})">${namespaced}</g>`);
  for (const m of namespaced.matchAll(/<path\b[^>]*id="([^"]+)"/g)) {
    pathEls.set(`${assetId}::${m[1].split("--")[1]}`, m[1]);
  }
  for (const m of namespaced.matchAll(/<text\b[^>]*id="([^"]+)"/g)) {
    textEls.set(`${assetId}::text:${m[1].split("--")[1]}`, m[1]);
  }
}

export function composeScene(
  scene: WhiteboardScene,
  project: WhiteboardProject,
  assets: Map<string, WhiteboardAsset>,
  carried?: CarriedInkPlan | null
): ComposedScene {
  const pathEls = new Map<string, string>();
  const textEls = new Map<string, string>();
  const bodyParts: string[] = [];
  // W6 — carried ink renders FIRST (document order = z-order: the carried
  // layer sits UNDER the scene's own ink), through the same namespacing
  // and the same registration the scene's placements ride.
  if (carried) {
    for (const [assetId, pl] of carried.placements) {
      const asset = assets.get(assetId);
      if (!asset) continue;
      renderPlacement(assetId, pl, asset, bodyParts, pathEls, textEls);
    }
  }
  for (const pl of scene.placements) {
    const asset = assets.get(pl.assetId);
    if (!asset) continue;
    renderPlacement(pl.assetId, pl.placement, asset, bodyParts, pathEls, textEls);
  }
  const body = bodyParts.join("\n") + "\n";
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

export function framePayload(frame: FrameState, width: number, height: number): string {
  return JSON.stringify({
    draws: [...frame.draws.entries()],
    texts: [...frame.texts.entries()],
    colors: [...frame.colors.entries()],
    placements: [...frame.placements.entries()],
    carried: frame.carried
      ? { placements: [...frame.carried.placements.entries()], exit: frame.carried.exit }
      : null,
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
    // W1 baseline catch (the bug the harness was built to find): the old
    // code reused ONE variable for two different elements — the fresh
    // <rect> on the create path, but getElementById(clipId) on every
    // later frame, which returns the <clipPath> ITSELF. The width updates
    // then landed on the clipPath (a visual no-op) and the clip rect kept
    // its FIRST frame's sliver width forever: every whiteboard text after
    // its reveal's first frame was clipped to invisibility — editor
    // preview AND final MP4 alike (this function is the one-source law
    // both surfaces ride). The clip rect is now addressed THROUGH its
    // clipPath parent on every frame, so the reveal width actually grows.
    let clip = document.getElementById(clipId);
    if (!clip) {
      clip = document.createElementNS("http://www.w3.org/2000/svg", "clipPath");
      clip.id = clipId;
      clip.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "rect"));
      document.getElementById("defs-root").appendChild(clip);
      el.setAttribute("clip-path", "url(#" + clipId + ")");
    }
    const rect = clip.firstElementChild;
    if (!rect) continue;
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
  // W6 — the carried-ink layer: the carry plan owns these groups'
  // transforms (placements + the pan-away offset), the fade's group
  // opacity, and the erase's dashoffset override (applied LAST — after
  // the draw loop above set them drawn — so the ink visibly retreats).
  if (p.carried) {
    const ex = p.carried.exit;
    for (const [assetId, pl] of p.carried.placements) {
      const g = document.getElementById("g-" + assetId);
      if (!g) continue;
      g.setAttribute("transform",
        "translate(" + (pl.x + ex.dx) + " " + (pl.y + ex.dy) + ") rotate(" + pl.rotateDeg + ") scale(" + pl.scale + ")");
      g.style.opacity = String(ex.opacity);
      if (ex.erase > 0) {
        const paths = g.querySelectorAll("path");
        for (const el of paths) {
          const L = Number(el.dataset.len || 0);
          if (L > 0) el.setAttribute("stroke-dashoffset", String(L * ex.erase));
        }
      }
    }
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
