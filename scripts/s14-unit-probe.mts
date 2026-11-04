// S14 unit probe — "the delivery": the grade the render encodes at and the
// form captions ship in, through REAL modules. Two export decisions held
// captive by the dialog's preset row — the grade readable only by the job
// (aligned doc) but writable only through a preset click; the burn written
// onto the row and honored by NOBODY through HTTP (the route's definite
// pre-resolution shadowed the job's row fallback). Layers:
//   1. PURE — the grade chain (the REAL resolveDeliveryQuality the render
//      route calls): body > doc pick > standard; junk falls through at
//      every slot.
//   2. PURE — the burn chain (the REAL resolveBurnSubtitles): a boolean
//      body wins even when false (an explicit "no burn" is a decision),
//      the row pick second, the format default last (video modes burn,
//      slides doesn't — the deck's headlines carry the words).
//   3. PURE — the encode law: the three tiers map to DISTINCT, ORDERED
//      x264 settings (a "high" master must never encode looser than a
//      draft), and the studio's doc-pick shape passes the doc contract
//      (quality is the ONE required renderPrefs key — junk quality kills
//      the whole renderPrefs, so a junk pick can never ride a saved doc).
//   4. PURE — the PATCH burn gate's law (the same membership predicate the
//      route runs): booleans + null admit, junk refuses.
//   5. DB-backed — a real row's burnCaptions rides serializeVideo both set
//      and cleared (the DTO surface the studio toggle reads).
// Run: node --import tsx scripts/s14-unit-probe.mts
import {
  resolveDeliveryQuality,
  resolveBurnSubtitles,
  sanitizeRenderPrefs,
  QUALITY_ENCODING,
  type ExportQuality,
} from "../src/lib/tubeforge/studio-doc";
import { serializeVideo } from "../src/lib/tubeforge/serialize";
import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// =====================================================================
// 1. the grade chain — resolveDeliveryQuality
// =====================================================================
check(
  "the grade chain: a body override wins over the doc pick",
  resolveDeliveryQuality("draft", { quality: "high" }) === "draft" &&
    resolveDeliveryQuality("high", { quality: "standard" }) === "high"
);

check(
  "the grade chain: no body → the doc's standing pick (the dialog-captive pick now has one resolver)",
  resolveDeliveryQuality(undefined, { quality: "high" }) === "high" &&
    resolveDeliveryQuality(null, { quality: "draft" }) === "draft"
);

check(
  "the grade chain: neither → standard (the pre-S14 default)",
  resolveDeliveryQuality(undefined, null) === "standard" &&
    resolveDeliveryQuality(undefined, undefined) === "standard" &&
    resolveDeliveryQuality(undefined, {}) === "standard"
);

check(
  "the grade chain: junk is not a pick — it falls through at every slot",
  resolveDeliveryQuality("ultra", { quality: "high" }) === "high" && // body junk
    resolveDeliveryQuality(2, { quality: "high" }) === "high" && // type confusion
    resolveDeliveryQuality(true, null) === "standard" && // junk body + no doc
    resolveDeliveryQuality(undefined, { quality: "extreme" as unknown as ExportQuality }) === "standard" // doc junk
);

// =====================================================================
// 2. the burn chain — resolveBurnSubtitles
// =====================================================================
check(
  "the burn chain: a boolean body wins even when false — an explicit no-burn is a decision, not an absence",
  resolveBurnSubtitles(false, true, "kenburns") === false &&
    resolveBurnSubtitles(true, false, "slides") === true
);

check(
  "the burn chain: no body → the row's standing pick (the pick the route used to shadow)",
  resolveBurnSubtitles(undefined, false, "kenburns") === false &&
    resolveBurnSubtitles(null, true, "slides") === true
);

check(
  "the burn chain: neither → the format default (burned for video modes, off for slides)",
  resolveBurnSubtitles(undefined, null, "kenburns") === true &&
    resolveBurnSubtitles(undefined, null, "animated") === true &&
    resolveBurnSubtitles(undefined, null, "stock") === true &&
    resolveBurnSubtitles(undefined, null, "slides") === false &&
    resolveBurnSubtitles(undefined, undefined, "slides") === false
);

// =====================================================================
// 3. the encode law + the doc contract
// =====================================================================
check(
  "the encode law: three distinct tiers, ordered — a master never encodes looser than a draft (lower CRF = tighter)",
  (() => {
    const crf = (q: ExportQuality) => Number(QUALITY_ENCODING[q].crf);
    const d = crf("draft"), s = crf("standard"), h = crf("high");
    return (
      new Set([d, s, h]).size === 3 &&
      h < s && s < d &&
      QUALITY_ENCODING.draft.preset !== QUALITY_ENCODING.high.preset
    );
  })()
);

check(
  "the doc contract: the studio's grade pick passes sanitize with the pick intact",
  sanitizeRenderPrefs({ quality: "high" })?.quality === "high" &&
    sanitizeRenderPrefs({ quality: "standard", captionStyle: null })?.quality === "standard"
);

check(
  "the doc contract: junk quality kills the WHOLE renderPrefs — a junk pick can never ride a saved doc",
  sanitizeRenderPrefs({ quality: "ultra", captionStyle: "bold" }) === null &&
    sanitizeRenderPrefs({}) === null && // the required key, absent
    sanitizeRenderPrefs({ quality: 2 }) === null
);

// =====================================================================
// 4. the PATCH burn gate's law — the predicate the route runs
// =====================================================================
const burnGate = (v: unknown) =>
  v === null || typeof v === "boolean";

check(
  "the PATCH burn gate: booleans + null admit (null = the format default)",
  burnGate(true) && burnGate(false) && burnGate(null)
);

check(
  "the PATCH burn gate: junk dies — numbers, numeric strings, type confusion, injection shapes",
  !burnGate(1) &&
    !burnGate(0) &&
    !burnGate("true") &&
    !burnGate("false") &&
    !burnGate("") &&
    !burnGate("1") &&
    !burnGate([true]) &&
    !burnGate({ burn: true }) &&
    !burnGate("'; DROP TABLE videos;--")
);

// =====================================================================
// 5. DB-backed — the DTO round-trip
// =====================================================================
const MARK = crypto.randomBytes(4).toString("hex");
const raw = new PrismaClient();

try {
  const org = await raw.organization.create({
    data: { name: `s14 ${MARK}`, slug: `s14-${MARK}` },
  });
  // true — never the null default, so a pass can't ride a default
  const video = await raw.video.create({
    data: {
      organizationId: org.id,
      topic: `S14 delivery probe ${MARK}`,
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      burnCaptions: true,
    },
  });

  const dto = await serializeVideo(video);
  check(
    "serializeVideo: a row's burn pick rides the DTO (the surface the studio toggle reads)",
    dto.burnCaptions === true,
    dto.burnCaptions
  );

  const flipped = await raw.video.update({
    where: { id: video.id },
    data: { burnCaptions: false },
  });
  const dtoOff = await serializeVideo(flipped);
  check(
    "serializeVideo: the sidecar pick rides too (false is a pick, not an absence)",
    dtoOff.burnCaptions === false,
    dtoOff.burnCaptions
  );

  const cleared = await raw.video.update({
    where: { id: video.id },
    data: { burnCaptions: null },
  });
  const dtoNull = await serializeVideo(cleared);
  check(
    "serializeVideo: a cleared row reads null (the format default decides — the toggle shows the resolved truth)",
    dtoNull.burnCaptions === null,
    dtoNull.burnCaptions
  );

  await raw.video.delete({ where: { id: video.id } }).catch(() => {});
  await raw.organization.delete({ where: { id: org.id } }).catch(() => {});
} finally {
  await raw.$disconnect();
}

// wrap-up
console.log(failures === 0 ? "\nS14 UNIT PROBE: ALL PASS" : `\nS14 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
