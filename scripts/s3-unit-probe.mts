// S3 unit probe — the doc-model contract through REAL modules (no HTTP):
// sanitizers vs hostile docs, docSceneSettings extraction, the revoice doc
// surgery, schema validation, and the quality ladder sanity.
// Run: node --import tsx scripts/s3-unit-probe.mts
import {
  sanitizeChroma,
  sanitizePip,
  sanitizeRenderPrefs,
  chromaFilterChain,
  pipOverlayFilter,
  EXPORT_PRESETS,
  QUALITY_ENCODING,
} from "../src/lib/tubeforge/studio-doc";
import {
  assembleTimeline,
  docSceneSettings,
  parseTimeline,
  serializeTimeline,
} from "../src/lib/tubeforge/timeline";
import { applyRevoiceToDoc } from "../src/lib/tubeforge/clip-ops";
import { assembleSaveSchema, clipOpSchema } from "../src/lib/tubeforge/validation";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// S58 — the named-fixture guard: a missing token/row/hold becomes a labeled
// error instead of a TypeError at the deref.
const req = <T,>(label: string, v: T | undefined | null): T => {
  if (v === undefined || v === null) throw new Error(`missing: ${label}`);
  return v;
};

// ---- hostile docs through the sanitizers ----
check(
  "sanitizeChroma rejects garbage, keeps legal values clamped",
  (() => {
    const junk = sanitizeChroma("nonsense" as never);
    const nullish = sanitizeChroma(null);
    const hostile = sanitizeChroma({ color: "javascript:alert(1)", similarity: 99, blend: -4, background: "#zzz" });
    const legal = sanitizeChroma({ color: "#00ff00", similarity: 0.2, blend: 0.05, background: "#101010" });
    return (
      junk === null &&
      nullish === null &&
      hostile !== null &&
      hostile.color === "#00FF00" && // fallback, not the injection
      hostile.similarity === 0.35 && // clamped to max
      hostile.blend === 0 &&
      hostile.background === "#000000" &&
      legal?.color === "#00FF00" &&
      legal?.similarity === 0.2
    );
  })()
);

check(
  "sanitizePip defaults a partial doc to a legal corner overlay",
  (() => {
    const p = sanitizePip({ pos: "middle-right" });
    const hostile = sanitizePip({ pos: "tl", size: 5, opacity: 0, margin: 9, border: "yes" });
    return (
      p?.pos === "br" && p.size === 0.18 && p.opacity === 1 && p.border === false && p.margin === 0.03 &&
      hostile?.size === 0.4 && hostile.opacity === 0.1 && hostile.margin === 0.08 && hostile.border === false
    );
  })()
);

// ---- the assembled doc → render extraction (the render's only entry) ----
const scenes = [
  { index: 1, title: "A", narration: "First scene words", visual: "a beach", caption: "", sfx: "none" },
  { index: 2, title: "B", narration: "Second scene more words here", visual: "a city", caption: "", sfx: "none" },
] as never;

const doc = assembleTimeline(scenes as never, {});
doc.scenes[0].chroma = req("sanitized chroma", sanitizeChroma({ color: "#00FF00" }));
doc.scenes[0].pip = req("sanitized pip", sanitizePip({ pos: "br" }));
doc.scenes[1].chroma = { color: "drop table", similarity: 0.5, blend: 1, background: "x" } as never; // hostile passthrough

const settings = docSceneSettings(doc, 2);
check(
  "docSceneSettings extracts S3 fields sanitized (hostile scene 2 reads as null chroma-fallback, not raw)",
  (() => {
    if (!settings) return false;
    const s1 = settings[0];
    const s2 = settings[1];
    return (
      s1.chroma?.color === "#00FF00" &&
      s1.pip?.pos === "br" &&
      // hostile chroma: every field clamped/normalized, no raw strings through
      s2.chroma !== null &&
      s2.chroma.color === "#00FF00" &&
      s2.chroma.similarity === 0.35 &&
      s2.chroma.blend === 0.2 &&
      s2.chroma.background === "#000000"
    );
  })(),
  settings?.[1]
);

// ---- renderPrefs survives the parse/serialize roundtrip ----
doc.renderPrefs = { quality: "high" };
const round = parseTimeline(serializeTimeline(doc));
check(
  "renderPrefs roundtrips through the doc column",
  round?.renderPrefs?.quality === "high"
);

const save = assembleSaveSchema.safeParse({
  scenes: [{ index: 1, startSec: 0, endSec: 3, durationSec: 3 }],
  totalDurationSec: 3,
  renderPrefs: { quality: "draft" },
});
check("assembleSaveSchema accepts renderPrefs", save.success && (save.data as never as { renderPrefs: { quality: string } }).renderPrefs.quality === "draft");
check("assembleSaveSchema rejects an unknown tier", !assembleSaveSchema.safeParse({
  scenes: [{ index: 1, startSec: 0, endSec: 3, durationSec: 3 }],
  totalDurationSec: 3,
  renderPrefs: { quality: "ultra" },
}).success);

// ---- revoice doc surgery: windows recompute downstream ----
const revoiced = applyRevoiceToDoc(doc, 1, "A much longer replacement narration", 9.5);
check(
  "applyRevoiceToDoc updates narration + window and shifts the tail",
  (() => {
    const a = revoiced.scenes[0];
    const b = revoiced.scenes[1];
    return (
      a.narration === "A much longer replacement narration" &&
      a.durationSec === 9.5 &&
      Math.abs(b.startSec - 9.5) < 0.011 &&
      Math.abs(revoiced.totalDurationSec - (9.5 + b.durationSec)) < 0.011
    );
  })(),
  revoiced.scenes
);

// ---- clip op schema: revoice requires narration ----
check(
  "clipOpSchema: revoice demands non-empty narration; split still demands atSec",
  (() => {
    const noText = clipOpSchema.safeParse({ action: "revoice", sceneIndex: 1 });
    const withText = clipOpSchema.safeParse({ action: "revoice", sceneIndex: 1, narration: "new words" });
    const splitNoAt = clipOpSchema.safeParse({ action: "split", sceneIndex: 1 });
    const splitOk = clipOpSchema.safeParse({ action: "split", sceneIndex: 1, atSec: 2 });
    return !noText.success && withText.success && !splitNoAt.success && splitOk.success;
  })()
);

// ---- the filter builders: labels chain, long overlay variable names ----
const c = chromaFilterChain(req("sanitized chroma", sanitizeChroma({ color: "#00FF00" })), { w: 1920, h: 1080, dur: 4, fps: 30, grade: "eq=contrast=1.05" });
check(
  "chromaFilterChain: key → color bg → overlay → grade, [vc] tail",
  c.chain.includes("chromakey=0x00FF00") &&
    c.chain.includes("color=c=0x000000:s=1920x1080:r=30") &&
    c.chain.includes("overlay=0:0:shortest=1,eq=contrast=1.05") &&
    c.outLabel === "[vc]"
);
const p = pipOverlayFilter(req("sanitized pip", sanitizePip({ pos: "br" })), { pipInput: 4, frameW: 1920, frameH: 1080 });
check(
  "pipOverlayFilter: long variable names only (this ffmpeg drops w/W aliases), [vp] tail",
  p.chain.includes("main_w-overlay_w-") &&
    p.chain.includes("main_h-overlay_h-") &&
    !/\bw-W\b/.test(p.chain) &&
    p.outLabel === "[vp]"
);

// ---- catalogs ----
check(
  "export presets: six delivery targets, each maps to a legal encoding tier",
  EXPORT_PRESETS.length === 6 &&
    EXPORT_PRESETS.every((x) => QUALITY_ENCODING[x.quality] != null && [24, 30, 60].includes(x.fps))
);
check(
  "quality ladder: draft ≥ standard ≥ high compression (higher CRF = smaller)",
  Number(QUALITY_ENCODING.draft.crf) > Number(QUALITY_ENCODING.standard.crf) &&
    Number(QUALITY_ENCODING.standard.crf) > Number(QUALITY_ENCODING.high.crf)
);
check(
  "sanitizeRenderPrefs drops unknown tiers",
  sanitizeRenderPrefs({ quality: "ultra" }) === null && sanitizeRenderPrefs({ quality: "high" })?.quality === "high"
);

console.log(failures === 0 ? "\nS3 UNIT PROBE: ALL PASS" : `\nS3 UNIT PROBE: ${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
