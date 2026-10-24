// Full Auto-Pilot E2E: script -> paced async voiceover -> async thumbnail.
const BASE = "http://localhost:3000/api/videos";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const t0 = Date.now();
const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${m}`);

// Stage 1: script (synchronous, ~5s)
log("creating video (script stage)...");
const createRes = await fetch(BASE, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    topic: "Why the Great Library of Alexandria still shapes the modern world",
    niche: "History",
    tone: "informative",
    length: "short",
    voice: "tongtong",
    ttsSpeed: 1.0,
    thumbStyle: "cinematic",
    channelId: null,
  }),
});
const createData = await createRes.json();
if (!createRes.ok) throw new Error(`script failed: ${createData.error}`);
const id = createData.video.id;
log(`✓ script ready — "${createData.video.title}" (id=${id})`);

async function getVideo() {
  return fetch(`${BASE}/${id}`, { cache: "no-store" }).then((r) => r.json());
}

async function runStage(stage, doneField, timeoutMs = 420000) {
  const s0 = Date.now();
  const res = await fetch(`${BASE}/${id}/${stage}`, { method: "POST" });
  if (res.status !== 202) throw new Error(`${stage} POST -> ${res.status}`);
  log(`✓ ${stage} job accepted (202 in ${Date.now() - s0}ms), polling...`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { video, generating } = await getVideo();
    if (video[doneField]) {
      log(`✓ ${stage} done in ${Math.round((Date.now() - s0) / 1000)}s`);
      return;
    }
    if (video.error) throw new Error(`${stage} failed: ${video.error}`);
    if (Date.now() > deadline) throw new Error(`${stage} poll timeout`);
    await sleep(3000);
  }
}

await runStage("voiceover", "hasVoiceover");
await runStage("thumbnail", "hasThumbnail");

const { video } = await getVideo();
log(`FINAL: status=${video.status} | ${video.audioDuration}s audio | error=${video.error ?? "none"}`);
console.log(video.status === "ready" ? "🚀 FULL AUTO-PILOT E2E PASSED" : "❌ FAILED");
