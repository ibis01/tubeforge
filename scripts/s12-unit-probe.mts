// S12 unit probe — "the look": the cover-style contract through REAL
// modules. The subject's sibling axis — S9 picked WHICH moment the cover
// depicts; this picks WHAT the art looks like. Layers:
//   1. PURE — the catalog law: ids are unique slugs, labels + prompts are
//      non-empty, "cinematic" leads (the pre-S12 default every legacy row
//      already carries).
//   2. PURE — the variants law: pickVariantStyles puts the row style FIRST
//      (the A/B set compares styles with the pick leading), an unknown id
//      falls back to the default, no dupes, count respected.
//   3. PURE — the resolution law (the exact expression generateThumbnail
//      runs before any I/O): every catalog id resolves to its OWN prompt;
//      junk, empty or foreign ids resolve to the default's prompt — never
//      a crash, never undefined.
//   4. DB-backed — a real row with a non-default style serializes through
//      serializeVideo with thumbStyle intact (the DTO surface the studio
//      control and the create-form prefill read), and the PATCH catalog
//      gate's membership law (the same THUMB_STYLES the route imports)
//      refuses every junk id while admitting every legal one.
// Run: node --import tsx scripts/s12-unit-probe.mts
import { THUMB_STYLES } from "../src/lib/tubeforge/types";
import { pickVariantStyles } from "../src/lib/tubeforge/ai";
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
  "the catalog: ids are unique slugs, labels + prompts non-empty, cinematic leads (the legacy default)",
  (() => {
    const ids = THUMB_STYLES.map((t) => t.id);
    return (
      THUMB_STYLES.length >= 4 &&
      new Set(ids).size === ids.length &&
      THUMB_STYLES.every(
        (t) =>
          /^[a-z0-9-]+$/.test(t.id) &&
          t.label.trim().length > 0 &&
          t.prompt.trim().length > 20
      ) &&
      THUMB_STYLES[0].id === "cinematic"
    );
  })()
);

check(
  "the catalog: every legacy create-form default is still legal (a flip never strands a row)",
  ["cinematic", "bold", "dark", "vibrant"].every((id) =>
    THUMB_STYLES.some((t) => t.id === id)
  )
);

// =====================================================================
// 2. the variants law — the A/B set leads with the row style
// =====================================================================
check(
  "pickVariantStyles: the picked style leads the set, fill follows catalog order, no dupes",
  (() => {
    const ids = THUMB_STYLES.map((t) => t.id);
    const picks = ids
      .slice(0, 3)
      .map((id) => pickVariantStyles(id, 3));
    return (
      picks.every((set, i) => set[0] === ids[i]) &&
      picks.every((set) => new Set(set).size === set.length && set.length === 3) &&
      // the fill after the pick walks the catalog from the top
      JSON.stringify(picks[0]) === JSON.stringify(ids.slice(0, 3)) &&
      picks[1][1] === ids[0] // "bold" pick → cinematic fills second
    );
  })()
);

check(
  "pickVariantStyles: an unknown row style falls back to the default lead — never a crash, never a dupe",
  (() => {
    const junk = pickVariantStyles("not-a-style", 3);
    const empty = pickVariantStyles("", 3);
    return (
      junk[0] === "cinematic" &&
      empty[0] === "cinematic" &&
      new Set(junk).size === junk.length &&
      junk.length === 3 &&
      empty.length === 3
    );
  })()
);

check(
  "pickVariantStyles: the count is respected and never exceeds the catalog",
  pickVariantStyles(THUMB_STYLES[0].id, 2).length === 2 &&
    pickVariantStyles("junk", THUMB_STYLES.length + 5).length === THUMB_STYLES.length
);

// =====================================================================
// 3. the resolution law — the exact expression generateThumbnail runs
//    (THUMB_STYLES.find(s => s.id === style)?.prompt ?? THUMB_STYLES[0].prompt)
// =====================================================================
const resolve = (style: string) =>
  THUMB_STYLES.find((s) => s.id === style)?.prompt ?? THUMB_STYLES[0].prompt;

check(
  "the resolution law: every catalog id resolves to its OWN prompt",
  THUMB_STYLES.every((t) => resolve(t.id) === t.prompt)
);

check(
  "the resolution law: junk, empty, foreign and case-broken ids resolve to the DEFAULT's prompt — never undefined, never a crash",
  (() => {
    const def = THUMB_STYLES[0].prompt;
    return (
      resolve("not-a-style") === def &&
      resolve("") === def &&
      resolve("../../etc/passwd") === def &&
      resolve("DROP TABLE thumbs") === def &&
      resolve("Cinematic") === def && // case-broken — ids are slugs
      resolve("cinematic ") === def && // untrimmed junk — the PATCH trims first
      typeof resolve("x") === "string"
    );
  })()
);

// =====================================================================
// 4. DB-backed — the DTO round-trip + the PATCH catalog gate's law
// =====================================================================
const MARK = crypto.randomBytes(4).toString("hex");
const raw = new PrismaClient();

try {
  const org = await raw.organization.create({
    data: { name: `s12 ${MARK}`, slug: `s12-${MARK}` },
  });
  const styleUnderTest = THUMB_STYLES[THUMB_STYLES.length - 1].id; // the LAST style — never the default
  const video = await raw.video.create({
    data: {
      organizationId: org.id,
      topic: `S12 style probe ${MARK}`,
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      thumbStyle: styleUnderTest,
    },
  });

  const dto = await serializeVideo(video);
  check(
    "serializeVideo: a row's style rides the DTO (the surface the studio picker + create prefill read)",
    dto.thumbStyle === styleUnderTest && styleUnderTest !== "cinematic",
    `${dto.thumbStyle} vs ${styleUnderTest}`
  );

  // The PATCH catalog gate — the same membership law the route runs
  // (style = body.thumbStyle.trim(); THUMB_STYLES.some(t => t.id === style)):
  // every legal id admits, every junk id refuses. Pinned here so a catalog
  // edit can't silently strand the route's gate.
  const gate = (s: string) =>
    THUMB_STYLES.some((t) => t.id === (typeof s === "string" ? s.trim() : ""));
  check(
    "the PATCH catalog gate: every catalog id admits, junk/empty/injection refuse",
    THUMB_STYLES.every((t) => gate(t.id)) &&
      !gate("not-a-style") &&
      !gate("") &&
      !gate("   ") &&
      !gate("../../etc/passwd") &&
      !gate("DROP TABLE thumbs") &&
      gate(" cinematic ") // the route TRIMS before the gate — padded legal ids admit
  );

  await raw.video.delete({ where: { id: video.id } }).catch(() => {});
  await raw.organization.delete({ where: { id: org.id } }).catch(() => {});
} finally {
  await raw.$disconnect();
}

// wrap-up
console.log(failures === 0 ? "\nS12 UNIT PROBE: ALL PASS" : `\nS12 UNIT PROBE: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
