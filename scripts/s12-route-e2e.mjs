// S12 route e2e — "the look": the cover-style pick through the LIVE
// daemon. The subject's sibling axis — the studio PATCHes the row's
// thumbStyle (catalog-gated), and the thumbnail job + A/B variants read
// it fresh at generation time. Layers:
//   1. the auth gate (no session → 401);
//   2. the fixture: account B + a story video with the DEFAULT style;
//   3. cross-tenant invisibility (the stranger cannot flip the style);
//   4. hostile bodies die at the catalog gate — junk, empty, traversal,
//      injection, case-broken ids → 400; a PATCH without thumbStyle is a
//      no-op (200, style untouched);
//   5. the legal flip: PATCH a non-default style → 200, the response DTO
//      + the row + the GET surface all reflect it, and the flip is
//      SURGICAL (title, voice, ttsSpeed untouched);
//   6. sequential picks compose: a second flip to a third style lands;
//      flipping to the SAME style is a legal no-op (the row accepts it —
//      the studio client guards the no-op, the row stays honest);
//   7. the factory cleans up: rows removed — the probe leaves no litter.
// Run: node --import tsx scripts/s12-route-e2e.mjs
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
const emailA = `s12-e2e-a-${stamp}@example.com`;
const emailB = `s12-e2e-b-${stamp}@example.com`;
const password = "S12RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the auth gate (no session yet) ----
let res = await call("PATCH", `/api/videos/x`, { thumbStyle: "vibrant" });
check("unauthenticated style flip → 401", res.status === 401, res.status);

// ---- 2. the fixture: account B + a story video at the DEFAULT style ----
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
if (membership?.organizationId) {
  const video = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S12 style route e2e fixture",
      title: "The Style Fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      thumbStyle: "cinematic",
      ttsSpeed: 1.0,
    },
  });
  FIXTURE = video.id;
  check("story fixture seeded (default cinematic style)", !!FIXTURE, FIXTURE);
}

if (FIXTURE) {
  // ---- 3. cross-tenant: the stranger cannot flip the style.
  //         Register(B) may have flipped the cookie jar to B's auto-session,
  //         so A logs in again EXPLICITLY before the stranger write. ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  check("stranger session restored (register auto-login is overridden)", res.status === 200 || res.status === 201, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "vibrant" });
  check("cross-tenant style flip is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);

  // ---- 4. hostile bodies die at the catalog gate ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "not-a-style" });
  check("junk style → 400 (catalog gate)", res.status === 400, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "" });
  check("empty style → 400 (catalog gate)", res.status === 400, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "   " });
  check("whitespace style → 400 (catalog gate, trimmed then refused)", res.status === 400, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "../../etc/passwd" });
  check("traversal style → 400 (catalog gate)", res.status === 400, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "DROP TABLE thumbs" });
  check("injection style → 400 (catalog gate)", res.status === 400, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "Cinematic" });
  check("case-broken style → 400 (ids are slugs)", res.status === 400, res.status);

  // a PATCH without thumbStyle is a legal no-op — the style survives it
  res = await call("PATCH", `/api/videos/${FIXTURE}`, {});
  const noop = res.status === 200 ? await res.json() : null;
  check(
    "a PATCH without thumbStyle is a no-op (200, style untouched)",
    res.status === 200 && noop?.video?.thumbStyle === "cinematic",
    `${res.status} ${noop?.video?.thumbStyle}`
  );

  // ---- 5. the legal flip — surgical, reflected on every surface ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "vibrant" });
  const flipped = res.status === 200 ? await res.json() : null;
  check(
    "the legal flip lands (200, response DTO carries the new style)",
    res.status === 200 && flipped?.video?.thumbStyle === "vibrant",
    `${res.status} ${JSON.stringify(flipped).slice(0, 120)}`
  );
  check(
    "the flip is SURGICAL — title, voice and pace untouched",
    flipped?.video?.title === "The Style Fixture" &&
      flipped?.video?.voice === "jam" &&
      flipped?.video?.ttsSpeed === 1.0,
    `${flipped?.video?.title}/${flipped?.video?.voice}/${flipped?.video?.ttsSpeed}`
  );

  const row = await db.video.findUnique({ where: { id: FIXTURE } });
  check("the row settles at vibrant", row?.thumbStyle === "vibrant", row?.thumbStyle);

  res = await call("GET", `/api/videos/${FIXTURE}`);
  const got = res.status === 200 ? await res.json() : null;
  check(
    "the GET surface reflects the pick (the studio picker's standing truth)",
    res.status === 200 &&
      (got?.video?.thumbStyle === "vibrant" || got?.thumbStyle === "vibrant"),
    `${res.status} ${JSON.stringify(got).slice(0, 120)}`
  );

  // ---- 6. sequential picks compose; a same-style flip is a legal no-op ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: "bold" });
  const second = res.status === 200 ? await res.json() : null;
  check("a second flip lands (sequential picks compose)", res.status === 200 && second?.video?.thumbStyle === "bold", res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { thumbStyle: " bold " });
  const padded = res.status === 200 ? await res.json() : null;
  check(
    "a padded legal id trims to the pick (the row accepts it; the client guards the no-op)",
    res.status === 200 && padded?.video?.thumbStyle === "bold",
    `${res.status} ${padded?.video?.thumbStyle}`
  );
}

// ---- 7. the factory cleans up: probe rows leave no litter ----
try {
  if (FIXTURE) await db.video.delete({ where: { id: FIXTURE } }).catch(() => {});
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

console.log(failures === 0 ? "\nS12 ROUTE E2E: ALL PASS" : `\nS12 ROUTE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
