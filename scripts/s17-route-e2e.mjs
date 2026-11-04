// S17 route e2e — "the ship": the real publish machinery + the status law
// through the LIVE daemon. The dialog's fossil surface is dead (the 404ing
// /upload fetch, the fake PATCH that claimed a queue); the REAL routes get
// exercised the way the new panel drives them:
//   1. the auth gate (no session → 401 on the publish + qc surfaces);
//   2. fixtures: a throwaway account + a story video (hasVideo false);
//   3. the ship gate order: no render → 400 BEFORE anything else; a
//      DB-flipped hasVideo then exposes the connect gate → 400 (no
//      YouTubeAccount on the throwaway);
//   4. THE STATUS LAW: PATCH status:"published" → 400 ("not a status
//      write") — the fossil write is dead; the manual transitions
//      (draft → scripted → voiced → ready) still pass;
//   5. the GET surfaces: /publish answers publishing/connected/defaults,
//      /qc answers running/qcReport;
//   6. the qc gate: POST with no final.mp4 → 400 (nothing to measure);
//   7. cross-tenant: a stranger can neither see the ship status nor
//      trigger a QC re-run on the fixture (404);
//   8. cleanup: the throwaway account + fixture video are removed.
// The happy upload path needs a live connected channel (a real OAuth
// grant) — the route's gates + the durable job contract are the e2e-able
// surface here; runUploadJob's own flow is Stage-6-tested offline.
// Run: node scripts/s17-route-e2e.mjs   (daemon on the S17 build)
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
const emailA = `s17-e2e-a-${stamp}@example.com`;
const emailB = `s17-e2e-b-${stamp}@example.com`;
const password = "S17RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the auth gate ----
let res = await call("GET", "/api/videos/x/publish");
check("1.1  unauthenticated ship status → 401", res.status === 401, res.status);
res = await call("POST", "/api/videos/x/publish", { title: "t" });
check("1.2  unauthenticated publish → 401", res.status === 401, res.status);
res = await call("POST", "/api/videos/x/qc");
check("1.3  unauthenticated QC re-run → 401", res.status === 401, res.status);

// ---- 2. fixtures ----
await call("POST", "/api/auth/register", { email: emailA, password });
res = await call("POST", "/api/auth/login", { email: emailA, password });
check("2.1  stranger account (A) registers + logs in", res.status === 200 || res.status === 201, res.status);

await call("POST", "/api/auth/register", { email: emailB, password });
res = await call("POST", "/api/auth/login", { email: emailB, password });
check("2.2  owner account (B) registers + logs in", res.status === 200 || res.status === 201, res.status);

const owner = await db.user.findUnique({ where: { email: emailB }, select: { id: true } });
const membership = owner
  ? await db.membership.findFirst({ where: { userId: owner.id }, select: { organizationId: true } })
  : null;
check("2.3  owner's organization resolves", !!membership?.organizationId, owner?.id);

let FIXTURE = null;
if (membership?.organizationId) {
  const video = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S17 ship route e2e fixture",
      title: "The Ship Fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      ttsSpeed: 1.0,
    },
  });
  FIXTURE = video.id;
  check("2.4  story fixture seeded (hasVideo false — nothing rendered)", !!FIXTURE, FIXTURE);
}

if (FIXTURE) {
  // ---- 3. the ship gate order ----
  res = await call("POST", `/api/videos/${FIXTURE}/publish`, { title: "The Ship Fixture" });
  check("3.1  publish without a render → 400 (the render gate fires first)", res.status === 400, res.status);

  await db.video.update({ where: { id: FIXTURE }, data: { hasVideo: true } });
  res = await call("POST", `/api/videos/${FIXTURE}/publish`, { title: "The Ship Fixture" });
  check("3.2  publish with a render but no connected channel → 400", res.status === 400, res.status);

  // ---- 4. THE STATUS LAW ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { status: "published" });
  let body = await res.json().catch(() => ({}));
  check("4.1  PATCH status:\"published\" → 400 — the fossil write is dead",
    res.status === 400 && /not a status write/.test(body.error ?? ""), { status: res.status, error: body.error });

  const row = await db.video.findUnique({ where: { id: FIXTURE }, select: { status: true } });
  check("4.2  the refused write left the status untouched", row?.status === "draft", row?.status);

  for (const [i, s] of ["scripted", "voiced", "ready"].entries()) {
    res = await call("PATCH", `/api/videos/${FIXTURE}`, { status: s });
    check(`4.3  the manual transition → "${s}" still passes (${i + 1}/3)`, res.status === 200, res.status);
  }
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { status: "warp-speed" });
  check("4.4  a nonsense status still dies with 400", res.status === 400, res.status);

  // ---- 5. the GET surfaces (the panel's data) ----
  res = await call("GET", `/api/videos/${FIXTURE}/publish`);
  body = await res.json().catch(() => ({}));
  check("5.1  GET /publish answers the ship status shape",
    res.status === 200 && body.publishing === false && typeof body.connected === "boolean" &&
      typeof body.defaults === "object" && typeof body.defaults?.privacyStatus === "string",
    { status: res.status, keys: Object.keys(body) });

  res = await call("GET", `/api/videos/${FIXTURE}/qc`);
  body = await res.json().catch(() => ({}));
  check("5.2  GET /qc answers the gate surface (running false, no report)",
    res.status === 200 && body.running === false && body.qcReport === null, { status: res.status, body });

  // ---- 6. the qc gate ----
  res = await call("POST", `/api/videos/${FIXTURE}/qc`);
  check("6.1  QC re-run with no final.mp4 → 400", res.status === 400, res.status);

  // ---- 7. cross-tenant ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  check("7.1  stranger session restored", res.status === 200 || res.status === 201, res.status);
  res = await call("GET", `/api/videos/${FIXTURE}/publish`);
  check("7.2  the stranger cannot see the ship status (404)", res.status === 404, res.status);
  res = await call("POST", `/api/videos/${FIXTURE}/qc`);
  check("7.3  the stranger cannot trigger a QC re-run (404)", res.status === 404, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { status: "published" });
  check("7.4  the stranger cannot fake-publish either (404)", res.status === 404, res.status);
}

// ---- 8. cleanup ----
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
const leftover = await db.user.count({ where: { email: { in: [emailA, emailB] } } });
check("8.1  cleanup — throwaway accounts + fixture gone", leftover === 0, leftover);

await db.$disconnect();
console.log(failures === 0 ? "\nS17 route e2e: ALL PASS" : `\nS17 route e2e: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
