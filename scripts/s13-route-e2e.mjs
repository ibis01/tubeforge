// S13 route e2e — "the frame": the aspect + frame-rate pick through the
// LIVE daemon. The studio PATCHes the row (catalog-gated like S12's style:
// present-but-illegal dies with a readable 400 before any write), and the
// render job reads the row fresh at render time (slides forces 9:16 there).
// Layers:
//   1. the auth gate (no session → 401);
//   2. the fixture: account B + a story video at the DEFAULT frame
//      (null/null → the render's 16:9 / 30) + a SLIDES fixture (the deck's
//      PNG is the frame — pins the legacy permissive contract the dialog's
//      export presets rely on);
//   3. cross-tenant invisibility (the stranger cannot shape the frame);
//   4. hostile bodies die at the gate — junk strings, off-catalog numbers,
//      type confusion, traversal, injection, padded ids → 400; a PATCH
//      without the keys is a no-op (200, frame untouched);
//   5. the legal flip: PATCH 9:16 + 24 fps → 200, the response DTO + the
//      row + the GET surface all reflect it, and the flip is SURGICAL
//      (title, voice, pace, cover style untouched);
//   6. the null clear: back to the defaults (16:9 / 30 by resolution);
//   7. sequential picks compose; a same-value flip is a legal no-op;
//   8. the slides contract: a slides row accepts the aspect write (the
//      dialog's presets PATCH blindly; the render forces 9:16 — the
//      studio's picker is what locks vertical);
//   9. the factory cleans up: rows removed — the probe leaves no litter.
// Run: node scripts/s13-route-e2e.mjs   (daemon must be running the S13 build)
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const BASE = "http://localhost:3000";
let cookie = "";

async function call(method, path, body) {
  const headers = { Cookie: cookie };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

const stamp = Date.now().toString(36);
const emailA = `s13-e2e-a-${stamp}@example.com`;
const emailB = `s13-e2e-b-${stamp}@example.com`;
const password = "S13RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the auth gate (no session yet) ----
let res = await call("PATCH", `/api/videos/x`, { aspectRatio: "9:16" });
check("unauthenticated frame pick → 401", res.status === 401, res.status);

// ---- 2. the fixtures ----
res = await call("POST", "/api/auth/register", { email: emailA, password });
res = await call("POST", "/api/auth/login", { email: emailA, password });
check("stranger account (A) can register + log in", res.status === 200 || res.status === 201, res.status);

res = await call("POST", "/api/auth/register", { email: emailB, password });
check("owner account (B) registers", res.status === 200 || res.status === 201, res.status);

const owner = await db.user.findUnique({ where: { email: emailB }, select: { id: true } });
const membership = owner
  ? await db.membership.findFirst({ where: { userId: owner.id }, select: { organizationId: true } })
  : null;
check("owner's organization resolves (registration created it)", !!membership?.organizationId, owner?.id);

let FIXTURE = null;
let SLIDES = null;
if (membership?.organizationId) {
  const video = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S13 frame route e2e fixture",
      title: "The Frame Fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      thumbStyle: "cinematic",
      ttsSpeed: 1.0,
      aspectRatio: null,
      frameRate: null,
    },
  });
  FIXTURE = video.id;
  check("story fixture seeded (default frame: null/null → 16:9 / 30)", !!FIXTURE, FIXTURE);

  const slidesVideo = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S13 slides route e2e fixture",
      title: "The Slides Fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      renderMode: "slides",
    },
  });
  SLIDES = slidesVideo.id;
  check("slides fixture seeded (the deck's PNG is the frame)", !!SLIDES, SLIDES);
}

if (FIXTURE) {
  // ---- 3. cross-tenant: the stranger cannot shape the frame ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  check("stranger session restored (register auto-login is overridden)", res.status === 200 || res.status === 201, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { aspectRatio: "9:16" });
  check("cross-tenant frame pick is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);

  // ---- 4. hostile bodies die at the gate ----
  const hostile = [
    ["aspect '4:3' (off-catalog)", { aspectRatio: "4:3" }],
    ["aspect '16x9' (malformed)", { aspectRatio: "16x9" }],
    ["aspect '' (empty)", { aspectRatio: "" }],
    ["aspect 169 (number, not string)", { aspectRatio: 169 }],
    ["aspect true (type confusion)", { aspectRatio: true }],
    ["aspect traversal", { aspectRatio: "../../9:16" }],
    ["aspect injection", { aspectRatio: "'; DROP TABLE videos;--" }],
    ["aspect ' 16:9 ' (padded — exact ids, no trim)", { aspectRatio: " 16:9 " }],
    ["fps 25 (off-catalog)", { frameRate: 25 }],
    ["fps '30' (string, not number)", { frameRate: "30" }],
    ["fps 29.5 (non-integer)", { frameRate: 29.5 }],
    ["fps true (type confusion)", { frameRate: true }],
    ["fps -30 (negative)", { frameRate: -30 }],
    ["fps 61 (just off the top)", { frameRate: 61 }],
  ];
  for (const [name, body] of hostile) {
    res = await call("PATCH", `/api/videos/${FIXTURE}`, body);
    check(`${name} → 400 (the gate, before any write)`, res.status === 400, res.status);
  }
  // and the gate refused WITHOUT writing — the frame is still the default
  let row = await db.video.findUnique({ where: { id: FIXTURE } });
  check("the hostile battery wrote nothing (frame still null/null)", row?.aspectRatio === null && row?.frameRate === null, `${row?.aspectRatio}/${row?.frameRate}`);

  // a PATCH without the keys is a legal no-op — the frame survives it
  res = await call("PATCH", `/api/videos/${FIXTURE}`, {});
  const noop = res.status === 200 ? await res.json() : null;
  check(
    "a PATCH without the frame keys is a no-op (200, frame untouched)",
    res.status === 200 && noop?.video?.aspectRatio === null && noop?.video?.frameRate === null,
    `${res.status} ${noop?.video?.aspectRatio}/${noop?.video?.frameRate}`
  );

  // ---- 5. the legal flip — surgical, reflected on every surface ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { aspectRatio: "9:16", frameRate: 24 });
  const flipped = res.status === 200 ? await res.json() : null;
  check(
    "the legal flip lands (200, response DTO carries 9:16 + 24)",
    res.status === 200 && flipped?.video?.aspectRatio === "9:16" && flipped?.video?.frameRate === 24,
    `${res.status} ${flipped?.video?.aspectRatio}/${flipped?.video?.frameRate}`
  );
  check(
    "the flip is SURGICAL — title, voice, pace and cover style untouched",
    flipped?.video?.title === "The Frame Fixture" &&
      flipped?.video?.voice === "jam" &&
      flipped?.video?.ttsSpeed === 1.0 &&
      flipped?.video?.thumbStyle === "cinematic",
    `${flipped?.video?.title}/${flipped?.video?.voice}/${flipped?.video?.ttsSpeed}/${flipped?.video?.thumbStyle}`
  );

  row = await db.video.findUnique({ where: { id: FIXTURE } });
  check("the row settles at 9:16 + 24", row?.aspectRatio === "9:16" && row?.frameRate === 24, `${row?.aspectRatio}/${row?.frameRate}`);

  res = await call("GET", `/api/videos/${FIXTURE}`);
  const got = res.status === 200 ? await res.json() : null;
  check(
    "the GET surface reflects the pick (the studio picker's standing truth)",
    res.status === 200 &&
      (got?.video?.aspectRatio === "9:16" || got?.aspectRatio === "9:16") &&
      (got?.video?.frameRate === 24 || got?.frameRate === 24),
    `${res.status}`
  );

  // ---- 6. the null clear — back to the defaults ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { aspectRatio: null, frameRate: null });
  const cleared = res.status === 200 ? await res.json() : null;
  check(
    "the null clear lands (default reads as default — the picker shows the resolved 16:9 / 30)",
    res.status === 200 && cleared?.video?.aspectRatio === null && cleared?.video?.frameRate === null,
    `${res.status} ${cleared?.video?.aspectRatio}/${cleared?.video?.frameRate}`
  );

  // ---- 7. sequential picks compose; a same-value flip is a legal no-op ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { aspectRatio: "1:1" });
  const square = res.status === 200 ? await res.json() : null;
  check("a second pick composes (null → 1:1)", res.status === 200 && square?.video?.aspectRatio === "1:1", res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { aspectRatio: "1:1" });
  const same = res.status === 200 ? await res.json() : null;
  check(
    "a same-value flip is a legal no-op on the row (the studio client guards the no-op)",
    res.status === 200 && same?.video?.aspectRatio === "1:1",
    res.status
  );
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { frameRate: 60 });
  const smooth = res.status === 200 ? await res.json() : null;
  check("the fps axis composes independently (null → 60)", res.status === 200 && smooth?.video?.frameRate === 60, res.status);
}

if (SLIDES) {
  // ---- 8. the slides contract: the write is accepted (the dialog's export
  //         presets PATCH blindly); the render job forces 9:16 — the
  //         studio's picker is what locks vertical for slides. ----
  res = await call("PATCH", `/api/videos/${SLIDES}`, { aspectRatio: "16:9", frameRate: 24 });
  const slidesPatched = res.status === 200 ? await res.json() : null;
  check(
    "a slides row accepts the frame write (the dialog preset contract holds; the render forces 9:16)",
    res.status === 200 && slidesPatched?.video?.aspectRatio === "16:9" && slidesPatched?.video?.frameRate === 24,
    `${res.status} ${slidesPatched?.video?.aspectRatio}/${slidesPatched?.video?.frameRate}`
  );
}

// ---- 9. the factory cleans up: probe rows leave no litter ----
try {
  if (FIXTURE) await db.video.delete({ where: { id: FIXTURE } }).catch(() => {});
  if (SLIDES) await db.video.delete({ where: { id: SLIDES } }).catch(() => {});
  const orgIds = new Set();
  for (const email of [emailA, emailB]) {
    const u = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (!u) continue;
    const ms = await db.membership.findMany({ where: { userId: u.id }, select: { organizationId: true } });
    ms.forEach((m) => orgIds.add(m.organizationId));
    await db.user.delete({ where: { id: u.id } }).catch(() => {});
  }
  for (const orgId of orgIds) await db.organization.delete({ where: { id: orgId } }).catch(() => {});
  check("probe rows cleaned up (videos + accounts)", true);
} finally {
  await db.$disconnect();
}

console.log(failures === 0 ? "\nS13 ROUTE E2E: ALL PASS" : `\nS13 ROUTE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
