// End-to-end test: "Generate script" retry button backend.
//
// Simulates the exact user scenario: a video whose script generation FAILED at
// create time (status "failed", no script), then retries it via the new
// POST /api/videos/[id]/script endpoint — first against a still-broken provider
// (failure path), then against a local OpenAI-compatible stub (success path +
// re-roll), which exercises the exact same job/DB/cleanup wiring as any live
// provider. (The sandbox's internal GLM gateway is currently 429-storming —
// environmental, proven identical via the raw SDK — so the live zai call is
// not used here.)
//
// Usage: node scripts/test-script-regen.mjs   (dev server on :3000)

import http from "node:http";

const BASE = process.env.BASE ?? "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
  cond ? passed++ : failed++;
};

async function jfetch(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers ?? {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* no body */
  }
  return { status: res.status, body };
}

/** Poll GET /api/videos/[id] until the script job flag clears. */
async function pollScriptJob(id, timeoutMs = 4 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await jfetch(`/api/videos/${id}`);
    if (!body?.video) throw new Error("video vanished mid-poll");
    if (!body.generating?.script) return body.video;
    if (Date.now() > deadline) throw new Error("script job timed out");
    await sleep(2000);
  }
}

// ---------- Local OpenAI-compatible stub ----------
function scenePkg(version) {
  const n = (i) =>
    `${version} scene ${i}: the keeper climbs the spiral stairs, storm rattling the glass, and the lamp refuses to light.`;
  return {
    title: `The Last Signal (${version})`,
    description: `A ${version} mystery about the final night of a lighthouse keeper. #mystery #lighthouse`,
    tags: ["mystery", "lighthouse", "storm", "night", "keeper", "signal", "sea", "suspense", "story", "shorts"],
    scenes: [1, 2, 3, 4].map((i) => ({
      title: `Beat ${i}`,
      narration: n(i),
      visual: `a lone lighthouse keeper on a stormy night, beat ${i}, cinematic wide shot, cold sea spray`,
      camera: i % 2 ? "zoom-in" : "pan-left",
      mood: "teal shadows, cold moonlight, volumetric haze",
      caption: `The lamp went dark ${version} ${i}`,
      hostInScene: false,
    })),
  };
}

function startStub(port) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits += 1;
      const version = hits === 1 ? "alpha" : "beta"; // 1st gen vs re-roll
      const content = JSON.stringify(scenePkg(version));
      const reply = () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: `stub-${hits}`,
            choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
            usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
          })
        );
      };
      // Keep the job in-flight long enough for the 409-dedupe probe to land
      // (a sub-millisecond stub can finish the whole job before the dup POST).
      setTimeout(reply, 600);
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function main() {
  console.log(`\n=== script-regen e2e @ ${BASE} ===\n`);

  // ---- 0. Precondition: chat provider must be zai (clean state to break/restore)
  const s0 = await jfetch("/api/settings/ai");
  const chat0 = s0.body?.capabilities?.chat;
  if (chat0?.provider !== "zai") {
    console.error(`ABORT: chat provider is "${chat0?.provider}" (expected "zai") — restore it first`);
    process.exit(1);
  }
  const restoreModel = chat0.model || "glm-4.5-flash";
  console.log(`precondition ok — chat on zai / ${restoreModel}\n`);

  // ---- 1. Break the chat provider (unreachable endpoint)
  const brk = await jfetch("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({
      capability: "chat",
      provider: "openai",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "test-bogus",
      model: "test-bogus",
    }),
  });
  ok(brk.status === 200, "1. break chat provider (openai → dead endpoint)");

  // ---- 2. Create a video → script generation must FAIL (user's scenario)
  const created = await jfetch("/api/videos", {
    method: "POST",
    body: JSON.stringify({
      topic: "Regen test: the lighthouse keeper's last signal",
      niche: "Mystery",
      tone: "mysterious",
      length: "short",
      format: "story",
    }),
  });
  const videoId = created.body?.video?.id;
  ok(created.status === 500, "2a. create fails with broken provider (HTTP 500)");
  ok(Boolean(videoId), "2b. failed video still created (id present)");
  ok(created.body?.video?.status === "failed", "2c. video status = failed");
  ok(!created.body?.video?.script, "2d. no script on the failed video");
  ok(Boolean(created.body?.error), `2e. error surfaced: ${String(created.body?.error).slice(0, 70)}…`);
  console.log(`   video: ${videoId}\n`);

  // ---- 3. Retry via the NEW endpoint with the provider STILL broken → job runs, records failure
  const r1 = await jfetch(`/api/videos/${videoId}/script`, { method: "POST" });
  ok(r1.status === 202, "3a. POST /script returns 202 (job accepted)");
  const failedVideo = await pollScriptJob(videoId);
  ok(failedVideo.status === "failed", "3b. still-broken retry → status stays failed");
  ok(Boolean(failedVideo.error), `3c. retry error recorded: ${String(failedVideo.error).slice(0, 70)}…`);

  // ---- 4. Point chat at the local stub and retry for real (success path)
  const STUB_PORT = 3971;
  const stub = await startStub(STUB_PORT);
  const stubCfg = await jfetch("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({
      capability: "chat",
      provider: "openai",
      baseUrl: `http://127.0.0.1:${STUB_PORT}/v1`,
      apiKey: "stub-key",
      model: "stub-model",
    }),
  });
  ok(stubCfg.status === 200, "4a. chat provider pointed at local stub");

  const r2 = await jfetch(`/api/videos/${videoId}/script`, { method: "POST" });
  ok(r2.status === 202, "5a. retry POST accepted (202)");

  const dup = await jfetch(`/api/videos/${videoId}/script`, { method: "POST" });
  ok(dup.status === 409, `5b. concurrent POST deduped (409, got ${dup.status})`);

  console.log("   polling script job…");
  const done = await pollScriptJob(videoId);
  ok(Boolean(done.script), `5c. script written (${done.wordCount} words)`);
  ok(done.status === "scripted", `5d. status = scripted (got "${done.status}")`);
  ok(!done.error, "5e. error cleared");
  ok((done.sceneCount ?? 0) > 0, `5f. scenes generated (${done.sceneCount})`);
  ok(Boolean(done.title), `5g. title: "${done.title}"`);
  ok(Array.isArray(done.scenes) && done.scenes.every((s) => s.narration && s.visual), "5h. scene payloads complete");
  const firstScript = done.script;

  // ---- 6. Re-roll an existing script (stub serves the "beta" take)
  await sleep(1500);
  const r3 = await jfetch(`/api/videos/${videoId}/script`, { method: "POST" });
  ok(r3.status === 202, "6a. re-roll POST accepted");
  const rerolled = await pollScriptJob(videoId);
  ok(Boolean(rerolled.script), `6b. re-roll completed (${rerolled.wordCount} words)`);
  ok(rerolled.status === "scripted", `6c. re-roll status scripted (got "${rerolled.status}")`);
  ok(rerolled.script !== firstScript, "6d. re-roll produced a fresh take (text differs)");
  ok(!rerolled.error, "6e. re-roll left no error");

  // ---- 7. Cleanup
  const del = await jfetch(`/api/videos/${videoId}`, { method: "DELETE" });
  ok(del.status === 200, "7. test video deleted");
  stub.close();

  // ---- 8. Settings really restored
  const restore = await jfetch("/api/settings/ai", {
    method: "PUT",
    body: JSON.stringify({
      capability: "chat",
      provider: "zai",
      model: restoreModel,
      baseUrl: "",
      apiKey: "",
    }),
  });
  const s9 = await jfetch("/api/settings/ai");
  const chat9 = s9.body?.capabilities?.chat;
  ok(restore.status === 200 && chat9?.provider === "zai" && chat9?.model === restoreModel, `8. settings clean (zai / ${chat9?.model})`);

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error("TEST CRASHED:", err);
  process.exit(1);
});
