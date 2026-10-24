// Repair user videos stuck without thumbnails — via new async 202 API + polling.
const BASE = "http://localhost:3000/api/videos";
const TARGETS = ["cmvmk70cf000dritg5qjt0w52", "cmvmk9n0t000nritgz8bf1qno"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function repair(id) {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/${id}/thumbnail`, { method: "POST" });
  console.log(`[${id.slice(-6)}] POST thumbnail -> HTTP ${res.status} in ${Date.now() - t0}ms`);
  if (res.status !== 202) {
    const b = await res.json().catch(() => ({}));
    console.log(`  skipped: ${b.error ?? "unexpected"}`);
    return;
  }
  for (;;) {
    const { video } = await fetch(`${BASE}/${id}`, { cache: "no-store" }).then((r) => r.json());
    if (video.hasThumbnail) {
      console.log(`  ✓ ready: status=${video.status}, thumb ok (${Math.round((Date.now() - t0) / 1000)}s)`);
      return;
    }
    if (video.error) throw new Error(`[${id.slice(-6)}] failed: ${video.error}`);
    if (Date.now() - t0 > 360000) throw new Error(`[${id.slice(-6)}] timeout`);
    await sleep(4000);
  }
}

const results = await Promise.allSettled(TARGETS.map(repair));
results.forEach((r, i) => {
  if (r.status === "rejected") console.log(`✗ ${TARGETS[i].slice(-6)}: ${r.reason.message}`);
});
console.log(results.every((r) => r.status === "fulfilled") ? "✅ ALL REPAIRED" : "❌ some repairs failed");
