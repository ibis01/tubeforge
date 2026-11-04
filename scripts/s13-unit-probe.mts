// S13 unit probe — "the frame": the picture's shape + smoothness contract
// through REAL modules. The last render-frame decisions that lived outside
// the studio (aspect + fps rode the dialog's export presets or the row
// defaults; the studio's preview geometry + timecodes followed them
// read-only). Layers:
//   1. PURE — the catalog law: the shared members (types.ts) are unique,
//      labels non-empty, and the render's fallback defaults (16:9 / 30) are
//      members — a flip can never strand a row outside the catalog.
//   2. PURE — the gate law: the exact membership predicate the PATCH route
//      runs (present-but-illegal dies with a 400 before any write; null
//      clears; absent untouched) — pinned so a catalog edit can't silently
//      strand the route's gate.
//   3. PURE — the preview's resolution law (previewSettingsFrom): null/junk
//      falls back to 16:9 / 30, every legal member passes through — the
//      studio preview never shows a frame the render wouldn't draw.
//   4. PURE — the timecode law (formatTimecode): the frames column re-counts
//      with the fps — the studio's honesty surface for a frame-rate pick.
//   5. DB-backed — a real row with 9:16 + 24 set serializes through
//      serializeVideo with both intact (the DTO surface the studio pickers
//      read), and a null row serializes null (the default reads as default).
// Run: node --import tsx scripts/s13-unit-probe.mts
import {
  RENDER_ASPECTS,
  RENDER_FRAME_RATES,
  RENDER_ASPECT_IDS,
  RENDER_FPS,
} from "../src/lib/tubeforge/types";
import { previewSettingsFrom, formatTimecode } from "../src/lib/tubeforge/preview-lanes";
import { serializeVideo } from "../src/lib/tubeforge/serialize";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// =====================================================================
// 1. the catalog law
// =====================================================================
check(
  "the catalog: aspect ids unique + well-formed, fps unique ints, labels non-empty",
  (() => {
    const aIds = RENDER_ASPECTS.map((a) => a.id);
    return (
      RENDER_ASPECTS.length === 3 &&
      new Set(aIds).size === aIds.length &&
      RENDER_ASPECTS.every((a) => /^\d+:\d+$/.test(a.id) && a.label.trim().length > 0) &&
      RENDER_FRAME_RATES.length === 3 &&
      new Set(RENDER_FPS).size === RENDER_FPS.length &&
      RENDER_FRAME_RATES.every((r) => Number.isInteger(r.fps) && r.fps > 0 && r.label.trim().length > 0)
    );
  })()
);

check(
  "the catalog: the render's fallback defaults (16:9 / 30) are members — null is never a stranger",
  RENDER_ASPECT_IDS.includes("16:9") && RENDER_FPS.includes(30)
);

check(
  "the catalog: every export preset's aspect + fps is a member (the dialog and the studio speak one law)",
  // the presets' members, pinned from studio-doc's EXPORT_PRESETS
  (["16:9", "9:16", "1:1"] as const).every((a) => (RENDER_ASPECT_IDS as readonly string[]).includes(a)) &&
    ([24, 30, 60] as const).every((f) => (RENDER_FPS as readonly number[]).includes(f))
);

// =====================================================================
// 2. the gate law — the exact predicate the PATCH route runs
// =====================================================================
// (mirrors route.ts: present-but-illegal → 400; null → clear; absent →
// untouched; the membership lists ARE the shared catalog)
const aspectGate = (v: unknown) =>
  v === null ||
  (typeof v === "string" && (RENDER_ASPECT_IDS as readonly string[]).includes(v));
const fpsGate = (v: unknown) =>
  v === null ||
  (typeof v === "number" && Number.isInteger(v) && (RENDER_FPS as readonly number[]).includes(v));

check(
  "the PATCH gate: every catalog member + null admits (null = clear to default)",
  RENDER_ASPECTS.every((a) => aspectGate(a.id)) &&
    aspectGate(null) &&
    RENDER_FRAME_RATES.every((r) => fpsGate(r.fps)) &&
    fpsGate(null)
);

check(
  "the PATCH gate: junk dies — wrong strings, off-catalog numbers, type confusion, traversal, injection",
  !aspectGate("4:3") &&
    !aspectGate("16x9") &&
    !aspectGate("landscape") &&
    !aspectGate("") &&
    !aspectGate("16:9 ") && // untrimmed — ids are exact
    !aspectGate(169) &&
    !aspectGate(true) &&
    !aspectGate("../9:16") &&
    !aspectGate("'; DROP TABLE videos;--") &&
    !fpsGate(25) &&
    !fpsGate("30") && // string, not number — type confusion refuses
    !fpsGate(29.5) && // non-integer
    !fpsGate(-30) &&
    !fpsGate(0) &&
    !fpsGate(61) &&
    !fpsGate(240) &&
    !fpsGate(true) &&
    !fpsGate([30])
);

// =====================================================================
// 3. the preview's resolution law — previewSettingsFrom
// =====================================================================
check(
  "previewSettingsFrom: every legal member passes through, null/junk falls back to 16:9 / 30",
  (() => {
    const pass = RENDER_ASPECTS.map((a) => previewSettingsFrom({ aspectRatio: a.id }).aspectRatio);
    const fpsPass = RENDER_FRAME_RATES.map((r) => previewSettingsFrom({ frameRate: r.fps }).frameRate);
    const def = previewSettingsFrom({ aspectRatio: null, frameRate: null });
    const junk = previewSettingsFrom({ aspectRatio: "4:3", frameRate: 48 });
    return (
      JSON.stringify(pass) === JSON.stringify(RENDER_ASPECT_IDS) &&
      JSON.stringify(fpsPass) === JSON.stringify(RENDER_FPS) &&
      def.aspectRatio === "16:9" &&
      def.frameRate === 30 &&
      junk.aspectRatio === "16:9" &&
      junk.frameRate === 30
    );
  })()
);

check(
  "previewSettingsFrom: absent fields read as the defaults (the studio's settings memo passes row nulls)",
  (() => {
    const s = previewSettingsFrom({});
    return s.aspectRatio === "16:9" && s.frameRate === 30;
  })()
);

// =====================================================================
// 4. the timecode law — formatTimecode re-counts with the fps
// =====================================================================
check(
  "formatTimecode: the frames column follows the fps (the studio's live honesty surface)",
  formatTimecode(1.5, 30) === "00:01.15" && // 45 frames → 1s + 15f
    formatTimecode(1, 24) === "00:01.00" && // 24 frames → exactly 1s
    formatTimecode(0.5, 60) === "00:00.30" && // 30 frames at 60fps = half a second
    formatTimecode(61.5, 30) === "01:01.15" && // minutes roll
    formatTimecode(0, 24) === "00:00.00" &&
    formatTimecode(-1, 30) === "00:00.00" // clamped, never negative
);

// =====================================================================
// 5. DB-backed — the DTO round-trip
// =====================================================================
const MARK = crypto.randomBytes(4).toString("hex");
const raw = new PrismaClient();

try {
  const org = await raw.organization.create({
    data: { name: `s13 ${MARK}`, slug: `s13-${MARK}` },
  });
  // 9:16 + 24 — never the defaults, so a pass can't ride a default
  const video = await raw.video.create({
    data: {
      organizationId: org.id,
      topic: `S13 frame probe ${MARK}`,
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      aspectRatio: "9:16",
      frameRate: 24,
    },
  });

  const dto = await serializeVideo(video);
  check(
    "serializeVideo: a row's frame rides the DTO (the surface the studio pickers read)",
    dto.aspectRatio === "9:16" && dto.frameRate === 24,
    { aspectRatio: dto.aspectRatio, frameRate: dto.frameRate }
  );

  const cleared = await raw.video.update({
    where: { id: video.id },
    data: { aspectRatio: null, frameRate: null },
  });
  const dtoNull = await serializeVideo(cleared);
  check(
    "serializeVideo: a cleared row reads null (default reads as default — the picker shows the resolved 16:9 / 30)",
    dtoNull.aspectRatio === null && dtoNull.frameRate === null,
    { aspectRatio: dtoNull.aspectRatio, frameRate: dtoNull.frameRate }
  );

  await raw.video.delete({ where: { id: video.id } }).catch(() => {});
  await raw.organization.delete({ where: { id: org.id } }).catch(() => {});
} finally {
  await raw.$disconnect();
}

// wrap-up
console.log(failures === 0 ? "\nS13 UNIT PROBE: ALL PASS" : `\nS13 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
