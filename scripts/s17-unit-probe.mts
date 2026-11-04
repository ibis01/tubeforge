// S17 unit probe — "the ship": the publish contract through REAL modules.
// The dialog's old surface was a fossil (a 404ing /upload fetch + a fake
// PATCH that toasted "added to the upload queue" while nothing queued);
// the real machinery is POST /publish → publishSchema → runUploadJob.
// Layers:
//   1. PURE — the publish schema law (validation.ts publishSchema): the
//      title is required and YouTube-capped at 100; description defaults
//      empty; tags default empty and cap at 30 entries of ≤80 chars;
//      privacy is the YouTube enum; publishAt is a free string the job
//      forwards. Every panel field rides THIS schema — a hostiles body
//      dies before the route touches the row.
//   2. ROUTE — the ship surface modules import cleanly (publish + qc +
//      the PATCH gate) and expose the POST/GET handlers the client calls.
// Run: node --import tsx scripts/s17-unit-probe.mts

import { publishSchema } from "../src/lib/tubeforge/validation";

let failures = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures++;
};

// =====================================================================
// 1. the publish schema law
// =====================================================================
{
  // 1.1 the happy minimal body: title carries it, the rest defaults
  const ok = publishSchema.safeParse({ title: "A Ship Fixture" });
  check("1.1  a title-only body parses — description defaults to \"\"",
    ok.success && ok.data.description === "", ok.success ? ok.data : ok.error?.issues);
  check("1.2  tags default to []", ok.success && Array.isArray(ok.data.tags) && ok.data.tags.length === 0);
  check("1.3  thumbnailStorageKey/publishAt are optional (nullish)",
    ok.success && (ok.data.thumbnailStorageKey ?? null) === null && (ok.data.publishAt ?? null) === null);

  // 1.2 the title gates
  const noTitle = publishSchema.safeParse({ description: "no title" });
  check("1.4  a body without a title dies", !noTitle.success);
  const longTitle = publishSchema.safeParse({ title: "x".repeat(101) });
  const capTitle = publishSchema.safeParse({ title: "x".repeat(100) });
  check("1.5  a 101-char title dies, a 100-char title ships", !longTitle.success && capTitle.success);

  // 1.3 the tags gates
  const tooMany = publishSchema.safeParse({ title: "t", tags: Array.from({ length: 31 }, (_, i) => `t${i}`) });
  const exactMany = publishSchema.safeParse({ title: "t", tags: Array.from({ length: 30 }, (_, i) => `t${i}`) });
  check("1.6  31 tags die, 30 ship", !tooMany.success && exactMany.success);
  const longTag = publishSchema.safeParse({ title: "t", tags: ["x".repeat(81)] });
  check("1.7  an 81-char tag dies", !longTag.success);

  // 1.4 the privacy enum — the YouTube trio, nothing else
  for (const legal of ["public", "unlisted", "private"]) {
    check(`1.8  privacy "${legal}" ships`, publishSchema.safeParse({ title: "t", privacyStatus: legal }).success);
  }
  check("1.9  privacy \"friends-only\" dies", !publishSchema.safeParse({ title: "t", privacyStatus: "friends-only" }).success);
  check("1.10 privacy is optional (the account's default applies)",
    publishSchema.safeParse({ title: "t" }).success);

  // 1.5 trim + coercion edges
  const trimmed = publishSchema.safeParse({ title: "   padded   " });
  check("1.11 the title is trimmed (the route's `body.title ||` fallback sees the real value)",
    trimmed.success && trimmed.data.title === "padded");
}

// =====================================================================
// 2. the ship surface modules
// =====================================================================
{
  const pub = await import("../src/app/api/videos/[id]/publish/route");
  const qc = await import("../src/app/api/videos/[id]/qc/route");
  const patch = await import("../src/app/api/videos/[id]/route");
  check("2.1  the publish surface exposes GET + POST", typeof pub.GET === "function" && typeof pub.POST === "function");
  check("2.2  the qc surface exposes GET + POST", typeof qc.GET === "function" && typeof qc.POST === "function");
  check("2.3  the PATCH gate (the status-law surface) exposes PATCH", typeof patch.PATCH === "function");
}

console.log(failures === 0 ? "\nS17 unit probe: ALL PASS" : `\nS17 unit probe: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
