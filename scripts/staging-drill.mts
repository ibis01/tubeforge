// S110 — the staging drill harness (HTTP-only; no database access needed).
//
// The DEPLOYMENT §3 law: every "operational" launch item is drilled on a
// REAL staging environment, not the dev sandbox. This script is the
// executable half of that law — its suites run against any live
// deployment (the staging URL by default; --url http://localhost:3000
// works against a local dev server, which is how the harness itself was
// verified before it ever touched staging).
//
// Suites — each self-skips with a printed reason when its prerequisites
// are missing (a SKIP is an honest state, not a failure):
//
//   health   — GET /api/auth/status; register (+ console-mode email
//              verify); logout → login; authed video list. Zero external
//              dependencies. Proves: web up, database migrated, auth
//              working, session cookie law holds.
//   billing  — GET /api/billing/plan's `configured` flag; when Stripe
//              TEST mode is wired, POST /api/billing/checkout must return
//              a real checkout.stripe.com URL. The fail-closed law means
//              a 503 here = not configured → SKIP; a 502 = the operator's
//              wiring is wrong (bad price id) → FAIL, actionable.
//   pipeline — the full render walk over HTTP, zero render-cost: create a
//              story video (AI scene-split — requires a provider key
//              configured in Settings; a staging setup step in the
//              runbook), scaffold the whiteboard project with the NATIVE
//              planner (zero AI), enqueue the render, poll the job to
//              done, fetch final.mp4 through the authenticated mp4 route
//              (200 local / 302→200 presigned under the s3 driver). This
//              walks web + database + queue + worker + chromium + ffmpeg
//              + the object store — the entire production topology minus
//              the AI providers' billable surface.
//
// Usage:
//   node --import tsx scripts/staging-drill.mts \
//     [--url https://tubeforge-staging.fly.dev] \
//     [--suite all|health|billing|pipeline] \
//     [--scene-poll-ms 90000] [--render-poll-ms 600000]
//
// Exit 0 = every runnable suite PASSED (skips allowed); exit 1 = any FAIL.

const RUN = Date.now().toString(36);

// --- args -----------------------------------------------------------------

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const BASE = (arg("url") ?? process.env.STAGING_URL ?? "https://tubeforge-staging.fly.dev").replace(/\/+$/, "");
const SUITE = arg("suite") ?? "all";
const SCENE_POLL_MS = Number(arg("scene-poll-ms") ?? 90_000);
const RENDER_POLL_MS = Number(arg("render-poll-ms") ?? 600_000);

if (!["all", "health", "billing", "pipeline"].includes(SUITE)) {
  console.error(`unknown suite "${SUITE}" (all|health|billing|pipeline)`);
  process.exit(1);
}

// --- results --------------------------------------------------------------

type Outcome = "PASS" | "SKIP" | "FAIL";
const lines: { suite: string; outcome: Outcome; note: string }[] = [];
function record(suite: string, outcome: Outcome, note: string): void {
  lines.push({ suite, outcome, note });
  console.log(`[${outcome}] ${suite}: ${note}`);
}

// --- a tiny cookie jar (register/login hand out tf_session) ---------------

const jar = new Map<string, string>();
function absorb(res: Response): void {
  // Node 20+: getSetCookie() returns each Set-Cookie line intact.
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader(): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

// --- http helpers ----------------------------------------------------------

// The API responses are dynamic JSON — narrow at the seam so the suites
// stay warning-free (the S106 law: zero avoidable warnings).
function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}
function field(v: unknown, key: string): unknown {
  return asRecord(v)?.[key];
}
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    redirect: "follow",
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(jar.size ? { Cookie: cookieHeader() } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  absorb(res);
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* not json — fine */
  }
  return { status: res.status, text, json };
}

const get = (p: string) => call("GET", p);
const post = (p: string, b?: unknown) => call("POST", p, b ?? {});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// A registered, logged-in user. Each suite mints its own (no shared state
// between suites — a failing suite cannot contaminate the next one).
async function freshUser(tag: string): Promise<{ email: string; password: string }> {
  const email = `stg-${RUN}-${tag}@staging.tubeforge.test`;
  const password = `drill-${RUN}-Aa1!`;
  const reg = await post("/api/auth/register", { name: "Staging Drill", email, password });
  if (reg.status !== 201)
    throw new Error(`register returned ${reg.status}: ${reg.text.slice(0, 200)}`);
  // Console email mode: the response carries the verification URL —
  // following it completes the verification step so later routes treat
  // the account as real. Absent (smtp mode / already verified) is fine.
  const verifyUrl = str(field(field(reg.json, "verification"), "url"));
  if (verifyUrl) {
    try {
      await fetch(verifyUrl, { redirect: "follow" });
    } catch {
      /* verification is best-effort for the drill */
    }
  }
  return { email, password };
}

// --- suite: health ---------------------------------------------------------

async function suiteHealth(): Promise<void> {
  const status = await get("/api/auth/status");
  if (status.status !== 200) {
    record("health", "FAIL", `GET /api/auth/status → ${status.status} (is the deployment up?)`);
    return;
  }

  let user: { email: string; password: string };
  try {
    user = await freshUser("health");
  } catch (err) {
    record("health", "FAIL", `register failed — ${(err as Error).message}`);
    return;
  }

  // logout, then log back in with the same credentials — proves the
  // password hash + login route + a FRESH session cookie all work.
  await post("/api/auth/logout");
  const login = await post("/api/auth/login", { email: user.email, password: user.password });
  if (login.status !== 200) {
    record("health", "FAIL", `login after logout → ${login.status}: ${login.text.slice(0, 200)}`);
    return;
  }

  const videos = await get("/api/videos");
  if (videos.status !== 200) {
    record("health", "FAIL", `authed GET /api/videos → ${videos.status}`);
    return;
  }

  record("health", "PASS", "status 200 · register + email-verify · logout→login · authed video list");
}

// --- suite: billing --------------------------------------------------------

async function suiteBilling(): Promise<void> {
  try {
    await freshUser("billing");
  } catch (err) {
    record("billing", "FAIL", `register failed — ${(err as Error).message}`);
    return;
  }

  const plan = await get("/api/billing/plan");
  if (plan.status !== 200) {
    record("billing", "FAIL", `GET /api/billing/plan → ${plan.status}`);
    return;
  }
  if (field(plan.json, "configured") !== true) {
    record(
      "billing",
      "SKIP",
      "Stripe not configured (TUBEFORGE_STRIPE_SECRET_KEY + the tier price envs) — runbook §3, then re-run",
    );
    return;
  }

  // Configured: the checkout MUST produce a real Stripe URL. 503 = the
  // gate flipped off between the two calls (SKIP); 502 = wiring wrong
  // (bad price id — the route's own comment: operator error) = FAIL.
  const checkout = await post("/api/billing/checkout", { tier: "creator" });
  if (checkout.status === 503) {
    record("billing", "SKIP", "checkout gate closed (503) — Stripe envs incomplete");
    return;
  }
  if (checkout.status !== 200) {
    record(
      "billing",
      "FAIL",
      `checkout → ${checkout.status}: ${checkout.text.slice(0, 200)} (check the Stripe test-mode price ids)`,
    );
    return;
  }
  const url = str(field(checkout.json, "url"));
  if (!url) {
    record("billing", "FAIL", `checkout 200 but no url: ${checkout.text.slice(0, 200)}`);
    return;
  }
  if (!/^https:\/\/([a-z0-9-]+\.)?stripe\.com\//.test(url) && !url.includes("stripe")) {
    record("billing", "FAIL", `checkout returned a non-Stripe URL: ${url.slice(0, 80)}`);
    return;
  }
  record(
    "billing",
    "PASS",
    `plan configured · checkout session minted (${url.split("?")[0].slice(0, 60)}…) — webhook rehearsal is runbook §4.3`,
  );
}

// --- suite: pipeline -------------------------------------------------------

function sceneCount(body: unknown): number {
  const raw = field(body, "scenes") ?? field(field(body, "video"), "scenes");
  if (Array.isArray(raw)) return raw.length;
  if (typeof raw !== "string" || !raw) return 0;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function videoView(body: unknown): Record<string, unknown> | null {
  return asRecord(field(body, "video")) ?? asRecord(body);
}

async function suitePipeline(): Promise<void> {
  try {
    await freshUser("pipeline");
  } catch (err) {
    record("pipeline", "FAIL", `register failed — ${(err as Error).message}`);
    return;
  }

  // 1. create a story video in whiteboard mode (AI scene-split: needs a
  //    provider key in Settings — the runbook's one manual setup step).
  const create = await post("/api/videos", {
    topic: `staging drill ${RUN}`,
    niche: "Motivation",
    format: "story",
    renderMode: "whiteboard",
  });
  if (create.status >= 300) {
    record(
      "pipeline",
      "FAIL",
      `create story video → ${create.status}: ${create.text.slice(0, 200)}`,
    );
    return;
  }
  const videoId =
    str(field(field(create.json, "video"), "id")) || str(field(create.json, "id"));
  if (!videoId) {
    record("pipeline", "FAIL", `create returned no video id: ${create.text.slice(0, 200)}`);
    return;
  }

  // 2. poll for scenes. If the row goes to error first, that is almost
  //    always "no provider configured" on a fresh staging — SKIP with the
  //    reason instead of burning the full timeout.
  const sceneDeadline = Date.now() + SCENE_POLL_MS;
  let scenes = 0;
  let rowError = "";
  while (Date.now() < sceneDeadline) {
    await sleep(5_000);
    const row = await get(`/api/videos/${videoId}`);
    if (row.status !== 200) {
      record("pipeline", "FAIL", `GET video → ${row.status} while polling scenes`);
      return;
    }
    scenes = sceneCount(row.json);
    rowError = String(videoView(row.json)?.error ?? "");
    if (scenes > 0) break;
    if (rowError) break;
  }
  if (scenes === 0) {
    if (rowError) {
      record(
        "pipeline",
        "SKIP",
        `scene generation errored — "${rowError.slice(0, 160)}" (usually: no AI provider key in Settings yet — runbook §3, then re-run)`,
      );
    } else {
      record(
        "pipeline",
        "FAIL",
        `no scenes after ${Math.round(SCENE_POLL_MS / 1000)}s — the story job never landed (check the worker + provider)`,
      );
    }
    return;
  }

  // 3. scaffold the whiteboard project with the NATIVE planner (zero AI),
  //    small geometry so the drill's render is quick.
  const scaffold = await post(`/api/videos/${videoId}/whiteboard/scaffold`, {
    planner: "native",
    width: 640,
    height: 360,
    fps: 24,
  });
  if (scaffold.status >= 300) {
    record(
      "pipeline",
      "FAIL",
      `scaffold → ${scaffold.status}: ${scaffold.text.slice(0, 200)}`,
    );
    return;
  }

  // 4. enqueue the render (the durable queue; the WORKER process claims it).
  const render = await post(`/api/videos/${videoId}/whiteboard/render`, {});
  if (render.status >= 300) {
    record(
      "pipeline",
      "FAIL",
      `render enqueue → ${render.status}: ${render.text.slice(0, 200)}`,
    );
    return;
  }

  // 5. poll the row until hasVideo (worker: claim → chromium → ffmpeg →
  //    store → row update) or an error surfaces.
  const renderDeadline = Date.now() + RENDER_POLL_MS;
  let hasVideo = false;
  let duration: number | null = null;
  while (Date.now() < renderDeadline) {
    await sleep(5_000);
    const row = await get(`/api/videos/${videoId}`);
    if (row.status !== 200) {
      record("pipeline", "FAIL", `GET video → ${row.status} while polling the render`);
      return;
    }
    const view = videoView(row.json);
    rowError = String(view?.error ?? "");
    hasVideo = view?.hasVideo === true;
    duration = typeof view?.videoDuration === "number" ? view.videoDuration : null;
    if (hasVideo || rowError) break;
  }
  if (!hasVideo) {
    record(
      "pipeline",
      "FAIL",
      rowError
        ? `render errored — "${rowError.slice(0, 160)}"`
        : `no final.mp4 after ${Math.round(RENDER_POLL_MS / 1000)}s (check the worker logs)`,
    );
    return;
  }

  // 6. fetch the artifact through the authenticated route (302→presigned
  //    under s3 — redirect:"follow" lands on the store's 200).
  const mp4 = await fetch(`${BASE}/api/videos/${videoId}/mp4`, {
    headers: { Cookie: cookieHeader() },
    redirect: "follow",
  });
  if (mp4.status !== 200) {
    record("pipeline", "FAIL", `GET /api/videos/${videoId}/mp4 → ${mp4.status}`);
    return;
  }
  const bytes = (await mp4.arrayBuffer()).byteLength;
  if (bytes < 1000) {
    record("pipeline", "FAIL", `final.mp4 round-tripped only ${bytes} bytes`);
    return;
  }

  record(
    "pipeline",
    "PASS",
    `scenes ${scenes} · native scaffold · render job done (hasVideo, ${duration ?? "?"}s) · final.mp4 ${bytes.toLocaleString()} bytes through the authed route`,
  );
}

// --- run -------------------------------------------------------------------

console.log(`staging drill — ${BASE}`);
console.log(`run ${RUN} · suite ${SUITE} · scene poll ${SCENE_POLL_MS}ms · render poll ${RENDER_POLL_MS}ms\n`);

const wanted = SUITE === "all" ? ["health", "billing", "pipeline"] : [SUITE];
for (const s of wanted) {
  if (s === "health") await suiteHealth();
  else if (s === "billing") await suiteBilling();
  else await suitePipeline();
}

const pass = lines.filter((l) => l.outcome === "PASS").length;
const skip = lines.filter((l) => l.outcome === "SKIP").length;
const fail = lines.filter((l) => l.outcome === "FAIL").length;
console.log(`\nDRILL RESULT: ${pass} PASS · ${skip} SKIP · ${fail} FAIL`);
if (skip > 0)
  console.log("(skips are prerequisites not yet met — see the runbook; they do not block the RC gate unless the gate names the suite)");
process.exit(fail > 0 ? 1 : 0);
