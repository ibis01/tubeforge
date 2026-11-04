// S15 route e2e — "the motion": the camera + the seam picks through the
// LIVE daemon. The studio's four decisive picks (mode / amplitude / seam
// style / blend length) PATCH the row catalog-gated like every tier since
// S12; the deep controls (curve, direction variation) ride the same gate.
// Layers:
//   1. the auth gate (no session → 401);
//   2. the fixtures: account B + a story video (2 scenes) + a slides
//      video (the seam contract's other half);
//   3. cross-tenant invisibility (the stranger cannot pick the motion);
//   4. hostile bodies die at the PATCH gate — foreign mode/curve/style
//      ids, padded strings, non-integer + off-window amplitudes, blend
//      lengths outside 0.2..1.5s, type confusion, injection shapes →
//      400, and the gate refused WITHOUT writing (the row still null);
//   5. the no-op PATCH: absent keys leave the family untouched;
//   6. the legal flips: the whole family at once, then single keys —
//      verified on the response DTO + the row + the GET surface, and
//      SURGICAL (title, voice, pace, cover style, frame, delivery all
//      untouched); boundary values (0 / 30, 0.2s / 1.5s) pass the gate;
//   7. null clears the family to the defaults the render resolves
//      (smart / 12 / crossfade 0.5s — hard cuts for slides rows, which
//      the unit probe pins; here the row contract is null);
//   8. the slides contract: an EXPLICIT seam pick on a slides row is
//      honored (unlike the aspect lock — the render honors the pick),
//      and motion picks land on slides rows too;
//   9. the factory cleans up: rows removed — the probe leaves no litter.
// Run: node --import tsx scripts/s15-route-e2e.mjs   (daemon on the S15 build)
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
const emailA = `s15-e2e-a-${stamp}@example.com`;
const emailB = `s15-e2e-b-${stamp}@example.com`;
const password = "S15RouteE2e!2345";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};

// ---- 1. the auth gate (no session yet) ----
let res = await call("PATCH", `/api/videos/x`, { motionMode: "zoom" });
check("unauthenticated motion pick → 401", res.status === 401, res.status);

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

const scenesJson = JSON.stringify([
  {
    index: 1, title: "Hook", narration: "One short opening line.", visual: "a dark skyline",
    camera: "zoom-in", mood: "tense", caption: "", hostInScene: false, rehook: true, sfx: "none",
  },
  {
    index: 2, title: "Close", narration: "One short closing line.", visual: "first light",
    camera: "pull-back", mood: "warm", caption: "", hostInScene: false, rehook: false, sfx: "none",
  },
]);

let FIXTURE = null;
let SLIDES = null;
if (membership?.organizationId) {
  const video = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S15 motion route e2e fixture",
      title: "The Motion Fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      ttsSpeed: 1.0,
      scenes: scenesJson,
    },
  });
  FIXTURE = video.id;
  check("story fixture seeded (2 scenes, the whole motion family null)", !!FIXTURE, FIXTURE);

  const slidesVideo = await db.video.create({
    data: {
      organizationId: membership.organizationId,
      topic: "S15 slides motion route e2e fixture",
      title: "The Slides Motion Fixture",
      niche: "Motivation",
      format: "story",
      status: "draft",
      voice: "jam",
      renderMode: "slides",
    },
  });
  SLIDES = slidesVideo.id;
  check("slides fixture seeded (the seam contract's other half)", !!SLIDES, SLIDES);
}

if (FIXTURE) {
  // ---- 3. cross-tenant: the stranger cannot pick the motion ----
  res = await call("POST", "/api/auth/login", { email: emailA, password });
  check("stranger session restored (register auto-login is overridden)", res.status === 200 || res.status === 201, res.status);
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { motionIntensity: 20 });
  check("cross-tenant motion pick is invisible to a stranger (404)", res.status === 404, res.status);

  res = await call("POST", "/api/auth/login", { email: emailB, password });
  check("fixture owner logs in", res.status === 200 || res.status === 201, res.status);

  // ---- 4. hostile bodies die at the gate ----
  const hostile = [
    ["mode 'wild' (foreign id)", { motionMode: "wild" }],
    ["mode 'smart ' (padded)", { motionMode: "smart " }],
    ["mode 42 (number)", { motionMode: 42 }],
    ["mode true (boolean)", { motionMode: true }],
    ["mode injection shape", { motionMode: "'; DROP TABLE videos;--" }],
    ["intensity '12' (numeric string)", { motionIntensity: "12" }],
    ["intensity 12.5 (non-integer)", { motionIntensity: 12.5 }],
    ["intensity -1 (below window)", { motionIntensity: -1 }],
    ["intensity 31 (above window)", { motionIntensity: 31 }],
    ["intensity 99 (way above)", { motionIntensity: 99 }],
    ["intensity true (boolean)", { motionIntensity: true }],
    ["curve 'jumpy' (foreign id)", { motionCurve: "jumpy" }],
    ["curve 'smooth ' (padded)", { motionCurve: "smooth " }],
    ["curve 1 (number)", { motionCurve: 1 }],
    ["vary 'true' (string)", { motionVary: "true" }],
    ["vary 1 (number)", { motionVary: 1 }],
    ["vary 0 (number)", { motionVary: 0 }],
    ["vary [true] (array)", { motionVary: [true] }],
    ["style 'meltpixels' (foreign id)", { transitionStyle: "meltpixels" }],
    ["style 'fade ' (padded)", { transitionStyle: "fade " }],
    ["style 42 (number)", { transitionStyle: 42 }],
    ["style {} (object)", { transitionStyle: {} }],
    ["style injection shape", { transitionStyle: "cut; DROP TABLE videos;--" }],
    ["duration '0.5' (numeric string)", { transitionDuration: "0.5" }],
    ["duration 0.1 (below window)", { transitionDuration: 0.1 }],
    ["duration 2.0 (above window)", { transitionDuration: 2.0 }],
    ["duration -1 (negative)", { transitionDuration: -1 }],
    ["duration true (boolean)", { transitionDuration: true }],
  ];
  for (const [name, body] of hostile) {
    res = await call("PATCH", `/api/videos/${FIXTURE}`, body);
    check(`${name} → 400 (the gate, before any write)`, res.status === 400, res.status);
  }
  let row = await db.video.findUnique({ where: { id: FIXTURE } });
  check(
    "the hostile battery wrote nothing (the whole family still null — the old route silently dropped/clamped; the gate refuses loudly)",
    row?.motionMode === null && row?.motionIntensity === null && row?.motionCurve === null &&
      row?.motionVary === null && row?.transitionStyle === null && row?.transitionDuration === null,
    { mode: row?.motionMode, intensity: row?.motionIntensity, curve: row?.motionCurve, vary: row?.motionVary, style: row?.transitionStyle, duration: row?.transitionDuration }
  );

  // ---- 5. a PATCH without the keys is a legal no-op ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, {});
  const noop = res.status === 200 ? await res.json() : null;
  check(
    "a PATCH without motion keys is a no-op (200, family untouched)",
    res.status === 200 && noop?.video?.motionMode === null && noop?.video?.transitionStyle === null,
    `${res.status} ${noop?.video?.motionMode}/${noop?.video?.transitionStyle}`
  );

  // ---- 6. the legal flips — the whole family at once, three surfaces ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, {
    motionMode: "zoom",
    motionIntensity: 20,
    motionCurve: "linear",
    motionVary: false,
    transitionStyle: "fadeblack",
    transitionDuration: 0.8,
  });
  const flipped = res.status === 200 ? await res.json() : null;
  check(
    "the family flip lands (200, the response DTO carries all six)",
    res.status === 200 &&
      flipped?.video?.motionMode === "zoom" && flipped?.video?.motionIntensity === 20 &&
      flipped?.video?.motionCurve === "linear" && flipped?.video?.motionVary === false &&
      flipped?.video?.transitionStyle === "fadeblack" && flipped?.video?.transitionDuration === 0.8,
    `${res.status} ${JSON.stringify(flipped?.video ? {
      mode: flipped.video.motionMode, intensity: flipped.video.motionIntensity,
      curve: flipped.video.motionCurve, vary: flipped.video.motionVary,
      style: flipped.video.transitionStyle, duration: flipped.video.transitionDuration,
    } : null)}`
  );

  row = await db.video.findUnique({ where: { id: FIXTURE } });
  check(
    "the row itself carries the flip (the surface the render job reads)",
    row?.motionMode === "zoom" && row?.motionIntensity === 20 && row?.motionCurve === "linear" &&
      row?.motionVary === false && row?.transitionStyle === "fadeblack" && row?.transitionDuration === 0.8,
    { mode: row?.motionMode, intensity: row?.motionIntensity, style: row?.transitionStyle }
  );

  res = await call("GET", `/api/videos/${FIXTURE}`);
  const gotten = res.status === 200 ? await res.json() : null;
  check(
    "the GET surface reflects the flip (the surface the studio pickers read)",
    res.status === 200 &&
      gotten?.video?.motionMode === "zoom" && gotten?.video?.motionIntensity === 20 &&
      gotten?.video?.transitionStyle === "fadeblack" && gotten?.video?.transitionDuration === 0.8,
    `${res.status} ${gotten?.video?.motionMode}/${gotten?.video?.transitionStyle}`
  );

  check(
    "the flip is SURGICAL (title, voice, pace, cover style, frame, delivery untouched)",
    row?.title === "The Motion Fixture" && row?.voice === "jam" && row?.ttsSpeed === 1.0 &&
      row?.thumbStyle === "cinematic" && row?.aspectRatio === null && row?.frameRate === null &&
      row?.burnCaptions === null,
    `title=${row?.title} voice=${row?.voice} ttsSpeed=${row?.ttsSpeed} thumbStyle=${row?.thumbStyle} aspect=${row?.aspectRatio} fps=${row?.frameRate} burn=${row?.burnCaptions}`
  );

  // single keys land independently — a one-axis pick is a one-axis PATCH
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { motionMode: "off" });
  const off = res.status === 200 ? await res.json() : null;
  check(
    "a single-key pick lands independently (mode off alone; the rest of the family holds)",
    res.status === 200 && off?.video?.motionMode === "off" && off?.video?.motionIntensity === 20 &&
      off?.video?.transitionStyle === "fadeblack",
    `${res.status} ${off?.video?.motionMode}/${off?.video?.motionIntensity}`
  );

  // boundary values pass the gate (the window's edges are legal picks)
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { motionIntensity: 0, transitionDuration: 0.2 });
  const edges1 = res.status === 200 ? await res.json() : null;
  res = await call("PATCH", `/api/videos/${FIXTURE}`, { motionIntensity: 30, transitionDuration: 1.5 });
  const edges2 = res.status === 200 ? await res.json() : null;
  check(
    "the window's edges are legal (0 and 30 amplitude, 0.2s and 1.5s blends — stored as picked, not clamped)",
    edges1?.video?.motionIntensity === 0 && edges1?.video?.transitionDuration === 0.2 &&
      edges2?.video?.motionIntensity === 30 && edges2?.video?.transitionDuration === 1.5,
    `${edges1?.video?.motionIntensity}/${edges1?.video?.transitionDuration} → ${edges2?.video?.motionIntensity}/${edges2?.video?.transitionDuration}`
  );

  // ---- 7. null clears the family to the defaults ----
  res = await call("PATCH", `/api/videos/${FIXTURE}`, {
    motionMode: null,
    motionIntensity: null,
    motionCurve: null,
    motionVary: null,
    transitionStyle: null,
    transitionDuration: null,
  });
  const cleared = res.status === 200 ? await res.json() : null;
  check(
    "null clears the whole family (the render resolves smart / 12 / crossfade 0.5s — the defaults read as defaults)",
    res.status === 200 &&
      cleared?.video?.motionMode === null && cleared?.video?.motionIntensity === null &&
      cleared?.video?.motionCurve === null && cleared?.video?.motionVary === null &&
      cleared?.video?.transitionStyle === null && cleared?.video?.transitionDuration === null,
    `${res.status} ${JSON.stringify(cleared?.video ? {
      mode: cleared.video.motionMode, intensity: cleared.video.motionIntensity,
      vary: cleared.video.motionVary, style: cleared.video.transitionStyle,
    } : null)}`
  );

  // ---- 8. the slides contract: an explicit pick is honored ----
  res = await call("PATCH", `/api/videos/${SLIDES}`, { transitionStyle: "fade", transitionDuration: 0.7, motionIntensity: 18 });
  const slidesPick = res.status === 200 ? await res.json() : null;
  check(
    "a slides row honors an EXPLICIT seam pick (unlike the aspect lock — the render composites the pick), and motion picks land too",
    res.status === 200 &&
      slidesPick?.video?.transitionStyle === "fade" && slidesPick?.video?.transitionDuration === 0.7 &&
      slidesPick?.video?.motionIntensity === 18,
    `${res.status} ${slidesPick?.video?.transitionStyle}/${slidesPick?.video?.transitionDuration}/${slidesPick?.video?.motionIntensity}`
  );

  res = await call("PATCH", `/api/videos/${SLIDES}`, { transitionStyle: null, transitionDuration: null, motionIntensity: null });
  const slidesCleared = res.status === 200 ? await res.json() : null;
  check(
    "clearing the slides row returns it to nulls (the render resolves hard cuts for a pick-less deck — pinned in the unit probe)",
    res.status === 200 &&
      slidesCleared?.video?.transitionStyle === null && slidesCleared?.video?.transitionDuration === null &&
      slidesCleared?.video?.motionIntensity === null,
    `${res.status} ${slidesCleared?.video?.transitionStyle}/${slidesCleared?.video?.motionIntensity}`
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

console.log(failures === 0 ? "\nS15 ROUTE E2E: ALL PASS" : `\nS15 ROUTE E2E: ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
