// studio-restore.mjs — undo ANY leftover razor splits on the S1 fixture:
// fragments are the row scenes with indices beyond the original set (the
// razor mints fresh indices, never renumbering). Each fragment run that
// directly follows a scene is re-joined onto it (the razor's word split is
// lossless: parent + fragments in row order == the original narration).
//   1. delete every fragment via the clip-op API (highest index first)
//   2. PATCH each parent's narration back to the concatenation
//   3. POST /voiceover — resume semantics re-read ONLY the parents whose
//      WAV the PATCH invalidated
//   4. POST /assemble — rebuild the doc
import { chromium } from "playwright";

const VIDEO = "cmw084tkl0009mcl90xrpwefq";
const log = (...a) => console.log("[restore]", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await (await browser.newContext()).newPage();

await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(4000);
const email = page.getByLabel("Email");
if (await email.count()) {
  await email.fill("ibismuh@yahoo.com");
  await page.locator('form input[type="password"]').first().fill("StudioS1-2026");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForTimeout(5000);
}

const api = (path, opts) =>
  page.evaluate(async ({ path, opts }) => {
    const r = await fetch(path, opts);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* raw */ }
    return { status: r.status, body, text: text.slice(0, 200) };
  }, { path, opts });

// --- 0. inspect ---
const row = await api(`/api/videos/${VIDEO}`);
const scenes = row.body?.video?.scenes ?? row.body?.scenes ?? null;
if (!scenes) throw new Error("could not read scenes: " + row.text);
const maxOriginal = 12; // the fixture's canonical scene set is 1..12
const fragments = scenes.filter((s) => s.index > maxOriginal);
log("row order:", scenes.map((s) => s.index).join(" "), "| fragments:", fragments.map((s) => s.index).join(" ") || "none");

if (fragments.length === 0) {
  log("nothing to restore");
  await browser.close();
  process.exit(0);
}

// Parent narration = parent + every fragment directly after it in row order.
const order = scenes.map((s) => s.index);
const rejoins = [];
for (let i = 0; i < order.length; i++) {
  const idx = order[i];
  if (idx > maxOriginal) continue; // a fragment, not a parent
  const parts = [scenes[i].narration.trim()];
  let j = i + 1;
  while (j < order.length && order[j] > maxOriginal) {
    parts.push(scenes[j].narration.trim());
    j++;
  }
  if (parts.length > 1) {
    rejoins.push({ index: idx, narration: parts.join(" ") });
    log(`scene ${idx} will be re-joined from ${parts.length} parts (${parts.join(" ").split(/\s+/).length} words)`);
  }
  i = j - 1;
}

// --- 1. delete fragments, highest index first ---
for (const f of [...fragments].sort((a, b) => b.index - a.index)) {
  const del = await api(`/api/videos/${VIDEO}/studio/clip`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "delete", sceneIndex: f.index }),
  });
  log(`delete s${f.index} ->`, del.status, del.body?.activity ?? del.text);
  if (del.status !== 200) throw new Error(`delete of scene ${f.index} failed`);
  await sleep(400);
}

// --- 2. rejoin narrations ---
for (const r of rejoins) {
  const patch = await api(`/api/videos/${VIDEO}/scenes`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ index: r.index, narration: r.narration }),
  });
  log(`PATCH s${r.index} ->`, patch.status);
  if (patch.status !== 200) throw new Error(`PATCH of scene ${r.index} failed`);
}

// --- 3. re-voice (only the rejoined scenes lack WAVs) ---
const vo = await api(`/api/videos/${VIDEO}/voiceover`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
log("POST voiceover ->", vo.status);
if (vo.status !== 202 && vo.status !== 200) throw new Error("voiceover enqueue failed");

// Poll the JOB SNAPSHOT (status is a stored field and can be stale), plus
// hasVoiceover — the row flags flip when the job's DB update lands.
let settled = false;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  const v = await api(`/api/videos/${VIDEO}`);
  const vid = v.body?.video ?? v.body;
  const gen = v.body?.generating ?? {};
  const anyJob = Object.values(gen).some(Boolean);
  if (i % 5 === 0)
    log(`poll ${i}: status=${vid?.status} hasVoiceover=${vid?.hasVoiceover} jobs=${JSON.stringify(gen)}`);
  if (!anyJob && vid?.hasVoiceover === true) { settled = true; break; }
  // If the job never even started (no jobs seen) but hasVoiceover already
  // true and audioDuration present, it finished within the first poll.
  if (!anyJob && i > 2 && vid?.hasVoiceover === true) { settled = true; break; }
}
log("voiceover settled:", settled);
if (!settled) throw new Error("voiceover job did not settle");

// --- 4. re-assemble ---
await sleep(1500);
const asm = await api(`/api/videos/${VIDEO}/assemble`, { method: "POST" });
const tl = asm.body?.timeline;
log("POST assemble ->", asm.status);
if (tl) {
  log("doc:", tl.sceneCount, "scenes,", tl.totalDurationSec.toFixed(1) + "s");
  const wavs = asm.body?.wavDurations ?? {};
  const mismatch = tl.scenes.filter((s) => wavs[s.index] && Math.abs(s.durationSec - (wavs[s.index] + 1.2)) > 0.05);
  log("wav-true windows:", mismatch.length === 0 ? "ALL ✓" : `${mismatch.length} mismatched: ` + mismatch.map((s) => s.index).join(","));
}

await browser.close();
log("DONE — fixture restored");
