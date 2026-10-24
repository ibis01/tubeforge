// E2E test: async voiceover + thumbnail via 202 + polling.
const ID = process.argv[2] || "cmvmjupoy0001ritgx1m4aytm";
const BASE = "http://localhost:3000/api/videos";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(stage) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/${ID}/${stage}`, { method: "POST" });
  const body = await res.json().catch(() => ({}));
  const ms = Date.now() - t0;
  console.log(`POST ${stage}: HTTP ${res.status} in ${ms}ms | accepted=${body.accepted}`);
  return { status: res.status, ms };
}

async function getVideo() {
  const res = await fetch(`${BASE}/${ID}`, { cache: "no-store" });
  return res.json();
}

async function pollUntil(check, label, timeoutMs = 360000) {
  const t0 = Date.now();
  for (;;) {
    const { video, generating } = await getVideo();
    if (check(video)) {
      console.log(`✓ ${label} after ${Math.round((Date.now() - t0) / 1000)}s (status=${video.status}, error=${video.error ?? "none"})`);
      return video;
    }
    if (video.error) throw new Error(`${label} FAILED: ${video.error}`);
    process.stdout.write(`  ...polling ${label} (${Math.round((Date.now() - t0) / 1000)}s) gen=${JSON.stringify(generating)}\r`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`${label} poll timeout`);
    await sleep(3000);
  }
}

console.log(`=== Testing async pipeline on video ${ID} ===`);

// 1. Voiceover: expect 202 fast (proxy-safe), then poll to completion
const vo = await post("voiceover");
if (vo.status !== 202 || vo.ms > 10000) throw new Error(`Voiceover POST not async! status=${vo.status} took ${vo.ms}ms`);

// 2. Immediate second POST — dedupe check (should also 202, no duplicate job)
const vo2 = await post("voiceover");

await pollUntil((v) => v.hasVoiceover, "voiceover generated");

// 3. Thumbnail: expect 202 fast, then poll
const th = await post("thumbnail");
if (th.status !== 202 || th.ms > 10000) throw new Error(`Thumbnail POST not async! status=${th.status} took ${th.ms}ms`);

await pollUntil((v) => v.hasThumbnail, "thumbnail generated");

const final = await getVideo();
console.log("\n=== RESULT ===");
console.log(`status=${final.video.status} | hasVoiceover=${final.video.hasVoiceover} | hasThumbnail=${final.video.hasThumbnail} | duration=${final.video.audioDuration}s | error=${final.video.error ?? "none"}`);
console.log(final.video.status === "ready" ? "✅ ALL GREEN — async pipeline works" : "❌ unexpected final status");
