// App-level API integration test for Smart Motion — drives the LIVE server
// with a minted Bearer token (same HMAC scheme as auth-token.ts):
//   1. PATCH motion fields on an existing video -> echoed by the serializer
//   2. invalid values are clamped/ignored (no 500s, no junk in the DB)
//   3. nulls reset to defaults
//   4. scene DTOs expose the focal hint (legacy scenes -> "center")
//   5. render route accepts the motion-bearing payload (202 acceptance check
//      is skipped — no full render here; covered by test-motion.ts ffmpeg
//      renders and the shotchain suite)
// Run: bun scripts/test-motion-api.ts   (needs the dev server on :3000)

const BASE = "http://localhost:3000";
const fs = await import("fs");

// ---- mint a Bearer token (mirrors auth-token.ts) ----
const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
const secret = env.match(/TUBEFORGE_AUTH_SECRET=(.*)/)?.[1]?.trim();
if (!secret) {
  console.error("no TUBEFORGE_AUTH_SECRET in .env — auth disabled, run without token");
  process.exit(1);
}
const te = new TextEncoder();
const b64url = (bytes) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const key = await crypto.subtle.importKey("raw", te.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const body = b64url(te.encode(JSON.stringify({ s: "api", exp: Math.floor(Date.now() / 1000) + 600, jti: "motion-test" })));
const sig = await crypto.subtle.sign("HMAC", key, te.encode(body));
const TOKEN = `${body}.${b64url(new Uint8Array(sig))}`;

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TOKEN}`,
      ...(opts.headers ?? {}),
    },
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json };
};

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// 0. auth gate — opt-in: the test temporarily enables the lock (creating the
// password if none exists) so the 401 path is exercised, then restores the
// previous state. Bearer tokens are accepted either way.
const TEST_PW = "tf-motion-api-lock-42";
const s0 = await (await fetch(`${BASE}/api/auth/status`)).json();
let lockCookie: string | null = null;
let lockChanged = false;
if (!s0.gateEnabled && !s0.configured) {
  const en = await fetch(`${BASE}/api/auth/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: true, password: TEST_PW }),
  });
  lockCookie = en.headers.get("set-cookie")?.split(";")[0] ?? null;
  lockChanged = en.ok;
}
const gateOn = lockChanged || s0.gateEnabled;
const anon = await fetch(`${BASE}/api/stats`);
check(
  "auth gate enforced for anonymous",
  anon.status === (gateOn ? 401 : 200),
  `status ${anon.status} (gate ${gateOn ? "on" : "off"})`
);
const authed = await api("/api/stats");
check("bearer token accepted", authed.status === 200, `status ${authed.status}`);

// 1. find a story video
const list = await api("/api/videos");
const videos = list.json?.videos ?? [];
const story = videos.find((v) => v.format === "story") ?? videos[0];
if (!story) {
  console.error("no videos in DB — create one in the UI first");
  process.exit(1);
}
const vid = story.id;
console.log(`  using video ${vid} (${story.format})`);

// 2. PATCH motion overrides -> echoed
const patched = await api(`/api/videos/${vid}`, {
  method: "PATCH",
  body: JSON.stringify({ motionMode: "zoom", motionIntensity: 18, motionCurve: "linear", motionVary: false }),
});
check("PATCH motion fields accepted", patched.status === 200, `status ${patched.status}`);
check("serializer echoes motionMode=zoom", patched.json?.video?.motionMode === "zoom");
check("serializer echoes motionIntensity=18", patched.json?.video?.motionIntensity === 18);
check("serializer echoes motionCurve=linear", patched.json?.video?.motionCurve === "linear");
check("serializer echoes motionVary=false", patched.json?.video?.motionVary === false);

// 3. invalid values are ignored or clamped, never stored raw
const junk = await api(`/api/videos/${vid}`, {
  method: "PATCH",
  body: JSON.stringify({ motionMode: "spin-cycle", motionIntensity: 9000, motionCurve: "zigzag" }),
});
check("junk PATCH does not 500", junk.status === 200, `status ${junk.status}`);
check("invalid mode ignored (stays zoom)", junk.json?.video?.motionMode === "zoom");
check("intensity clamped to 30", junk.json?.video?.motionIntensity === 30);
check("invalid curve ignored (stays linear)", junk.json?.video?.motionCurve === "linear");

// 4. nulls reset to defaults
const reset = await api(`/api/videos/${vid}`, {
  method: "PATCH",
  body: JSON.stringify({ motionMode: null, motionIntensity: null, motionCurve: null, motionVary: null }),
});
check("nulls reset accepted", reset.status === 200);
check(
  "all motion fields null again (defaults apply at render)",
  reset.json?.video?.motionMode === null &&
    reset.json?.video?.motionIntensity === null &&
    reset.json?.video?.motionCurve === null &&
    reset.json?.video?.motionVary === null
);

// 5. scene DTOs carry the focal hint (legacy scenes -> "center") — the
//    storyboard endpoint is the SceneDTO producer (serializeScenes).
const board = await api(`/api/videos/${vid}/storyboard`);
const scenes = board.json?.scenes ?? [];
if (scenes.length > 0) {
  check(
    "scene DTOs expose focal (legacy default center)",
    scenes.every((s) => typeof s.focal === "string" && s.focal.length > 0),
    scenes.slice(0, 6).map((s) => s.focal).join(",") + (scenes.length > 6 ? ",…" : "")
  );
} else {
  console.log("  (video has no scenes — focal DTO check skipped)");
}

// 6. POST /api/videos validates motion fields (bad values ignored, no 500)
//    NOTE: does NOT complete creation — we only probe validation by sending
//    an empty topic which 400s before any LLM call.
const badCreate = await api("/api/videos", {
  method: "POST",
  body: JSON.stringify({ topic: "", motionMode: "off", motionIntensity: 12 }),
});
check("create validation still gates on topic", badCreate.status === 400, `status ${badCreate.status}`);

// restore: undo the temporary lock the test enabled (never leave state behind)
if (lockChanged) {
  await fetch(`${BASE}/api/auth/lock`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(lockCookie ? { Cookie: lockCookie } : {}) },
    body: JSON.stringify({ enabled: false, clearPassword: true }),
  });
  const after = await (await fetch(`${BASE}/api/auth/status`)).json();
  check("lock state restored (off, password cleared)", after.gateEnabled === false && after.configured === false);
}

console.log(`\n${fail === 0 ? "OK" : "FAIL"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
