// studio-smoke.mjs — full S1 interaction test against the Timeline Studio.
//
// Covers: studio mount, ruler scrubbing (exact, density from the LIVE doc),
// keyboard transport, clip selection, the razor guard (playhead in the tail
// padding → local toast, NO network 400), a real server-side split (re-voices
// both halves), the two-step delete, and a RESTORATIVE tail that puts the
// fixture video back exactly as it was (PATCH the original narration back,
// re-voice — the resume semantics re-read ONLY the edited scene — re-assemble).
//
// If a run dies mid-way and leaves the fixture split, run studio-restore.mjs.
//
// Zero page errors is part of the pass condition.
import { chromium } from "playwright";

const VIDEO = "cmw084tkl0009mcl90xrpwefq";
const log = (...a) => console.log("[smoke]", ...a);
const SHOT = (n) => `/tmp/render/studio-${n}.png`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1680, height: 1050 } });
const page = await ctx.newPage();
let errors = 0;
page.on("pageerror", (e) => { errors++; log("PAGEERROR", String(e).slice(0, 500)); });
page.on("console", (m) => {
  if (m.type() === "error") { errors++; log("console.error", m.text().slice(0, 300)); }
});
// The split's network truth — a silent client-side refusal must be visible.
page.on("request", (r) => { if (r.url().includes("/studio/clip")) log(">> POST", r.url().split("/").pop(), "(scene-clip op)"); });
page.on("response", async (r) => {
  if (r.url().includes("/studio/clip")) log("<< clip op", r.status());
});

const toastTexts = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll('[data-radix-collection-item], li[data-state], [role="status"]'))
      .map((n) => (n.textContent ?? "").slice(0, 140))
      .filter(Boolean)
  );

const api = (path, opts) =>
  page.evaluate(async ({ path, opts }) => {
    const r = await fetch(path, opts);
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* raw */ }
    return { status: r.status, body, text: text.slice(0, 300) };
  }, { path, opts });

const docState = async () => {
  const d = await api(`/api/videos/${VIDEO}/assemble`);
  const tl = d.body?.timeline;
  return tl
    ? { sceneCount: tl.sceneCount, total: tl.totalDurationSec, scenes: tl.scenes, wavs: d.body?.wavDurations ?? {} }
    : null;
};

const sceneCount = async () => (await docState())?.sceneCount ?? -1;

const timecode = () =>
  page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("span")).find((s) =>
      /\d+[\d:;.,]*\s*\/\s*\d/.test(s.textContent ?? "") && (s.textContent ?? "").length < 40
    );
    return el ? el.textContent.trim() : null;
  });

const studioOpen = () =>
  page.evaluate(() => document.body.innerText.includes("Timeline Studio"));

/** Click the ruler at time t (seconds) — density measured from the LIVE doc's
 *  total, so scrubbing is exact no matter how the fixture's edits changed it. */
const scrubTo = async (t, total) => {
  const density = await page.evaluate((total) => {
    const r = document.querySelector('[aria-label="Playhead position"]');
    return r ? r.getBoundingClientRect().width / total : null;
  }, total);
  if (!density) throw new Error("ruler not found");
  await page.locator('[aria-label="Playhead position"]').click({
    position: { x: Math.max(2, t * density), y: 14 },
  });
  await page.waitForTimeout(400);
};

try {
  await page.goto("http://localhost:3000/", { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(4000);
  const email = page.getByLabel("Email");
  if (await email.count()) {
    await email.fill("ibismuh@yahoo.com");
    await page.locator('form input[type="password"]').first().fill("StudioS1-2026");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForTimeout(5000);
  }

  await page.getByRole("button", { name: /Hidden Empire of Container Ships/ }).first().click();
  await page.waitForTimeout(5000);
  if (!(await studioOpen())) throw new Error("studio did not mount");
  log("studio mounted ✓");

  // ---- 0. read the LIVE doc; pick the split target (longest speakable span) ----
  const doc0 = await docState();
  if (!doc0) throw new Error("no timeline doc — assemble first");
  const LEAD = 0.35, GUARD = 0.25; // mirrors preview-lanes.ts
  const spanOf = (s) => {
    const wav = doc0.wavs[s.index];
    if (!wav) return null;
    const start = s.startSec + LEAD + GUARD;
    const end = s.startSec + LEAD + wav - GUARD;
    return end > start ? { start, end } : null;
  };
  let target = null, targetSpan = null;
  for (const s of doc0.scenes) {
    const sp = spanOf(s);
    if (sp && (!targetSpan || sp.end - sp.start > targetSpan.end - targetSpan.start)) {
      target = s; targetSpan = sp;
    }
  }
  if (!target) throw new Error("no scene with a speakable span — fixture unhealthy");
  log(
    `target: scene ${target.index} "${target.title}" window ${target.startSec.toFixed(1)}–${target.endSec.toFixed(
      1
    )}s, span ${targetSpan.start.toFixed(1)}–${targetSpan.end.toFixed(1)}s, total ${doc0.total.toFixed(1)}s`
  );

  // Save the original narration for the restorative tail.
  const row = await api(`/api/videos/${VIDEO}`);
  const rowScenes = row.body?.video?.scenes ?? row.body?.scenes ?? [];
  const originalNarration = rowScenes.find((s) => s.index === target.index)?.narration;
  if (!originalNarration) throw new Error("could not read the target's narration from the row");

  // ---- 1. scrub: exact positions ----
  const tCheck = Math.min(doc0.total - 0.5, targetSpan.start + 1);
  await scrubTo(tCheck, doc0.total);
  const tc1 = await timecode();
  const okScrub = tc1 && Math.abs(parseTc(tc1) - tCheck) < 0.6;
  log(`scrub to ${tCheck.toFixed(1)}s -> ${tc1}`, okScrub ? "EXACT ✓" : "DRIFTED ✗");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(300);
  const tcArrow = await timecode();
  log("after 2×→:", tcArrow, tcArrow !== tc1 ? "STEPPED ✓" : "did NOT step ✗");
  await page.keyboard.press("Home");
  await page.waitForTimeout(300);
  log("after Home:", await timecode());
  await page.screenshot({ path: SHOT(1) });

  // ---- 2. guard probe: park in the TAIL PADDING, press S ----
  // 0.5s past the span's end is still inside the clip (tail is 1.1s wide for
  // fresh docs) — the server must never see this; the studio toasts locally.
  const tailPark = targetSpan.end + 0.5;
  if (tailPark < target.endSec) {
    await scrubTo(tailPark, doc0.total);
    await page.getByRole("button", { name: new RegExp(escapeRe(target.title)) }).first().click();
    await page.waitForTimeout(400);
    const beforeGuard = await sceneCount();
    await page.keyboard.press("s");
    await page.waitForTimeout(800);
    const guardToast = await page
      .getByText("Park the playhead inside the narration")
      .count()
      .catch(() => 0);
    const afterGuard = await sceneCount();
    log(
      `guard probe at ${tailPark.toFixed(1)}s (tail padding): toast=${guardToast > 0 ? "shown ✓" : "MISSING ✗"}, sceneCount ${beforeGuard}->${afterGuard}`,
      guardToast > 0 && beforeGuard === afterGuard ? "REFUSED LOCALLY ✓" : "FAILED ✗"
    );
    if (!(await studioOpen())) throw new Error("page died during the guard probe");
  } else {
    log("guard probe skipped — target's tail padding is too narrow");
  }

  // ---- 3. the real split: park mid-span, S, poll for +1 scene ----
  const mid = (targetSpan.start + targetSpan.end) / 2;
  await scrubTo(mid, doc0.total);
  log("playhead parked:", await timecode(), `(mid-span ${mid.toFixed(1)}s)`);
  const before = await sceneCount();
  log("sceneCount before split:", before);

  await page.keyboard.press("s");
  log("pressed S — split re-voices both halves (TTS); polling…");
  let after = -1;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(2000);
    after = await sceneCount();
    if (after === before + 1) break;
    // A local guard refusal would strand the poll forever — surface it.
    if (i === 5) {
      const t = await toastTexts();
      if (t.some((x) => x.includes("inside the narration")))
        log("SPLIT BLOCKED CLIENT-SIDE ✗ — guard toast:", JSON.stringify(t));
    }
  }
  log("sceneCount after split:", after, after === before + 1 ? "SPLIT ✓" : "SPLIT ✗");
  await page.screenshot({ path: SHOT(2) });
  if (after !== before + 1) throw new Error("split never landed");
  if (!(await studioOpen())) throw new Error("page died during the split");

  // ---- 4. delete the fresh second half (⌫ arm + confirm) ----
  await page.keyboard.press("Delete");
  await page.waitForTimeout(600);
  await page.keyboard.press("Delete");
  log("pressed ⌫ twice — polling for delete…");
  let back = -1;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    back = await sceneCount();
    if (back === before) break;
  }
  log("sceneCount after delete:", back, back === before ? "DELETE ✓" : "DELETE ✗");
  await page.screenshot({ path: SHOT(3) });

  // ---- 5. restorative tail: put the fixture back ----
  log("restoring the fixture (PATCH narration → re-voice ONE scene → re-assemble)…");
  const patch = await api(`/api/videos/${VIDEO}/scenes`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ index: target.index, narration: originalNarration }),
  });
  log("PATCH narration ->", patch.status);
  if (patch.status !== 200) throw new Error("restore PATCH failed");

  const vo = await api(`/api/videos/${VIDEO}/voiceover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  log("POST voiceover ->", vo.status);
  if (vo.status !== 202 && vo.status !== 200) throw new Error("restore voiceover failed");

  let status = "";
  let settled = false;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const v = await api(`/api/videos/${VIDEO}`);
    const vid = v.body?.video ?? v.body;
    status = vid?.status ?? "?";
    const gen = v.body?.generating ?? {};
    const anyJob = Object.values(gen).some(Boolean);
    if (!anyJob && vid?.hasVoiceover === true) { settled = true; break; }
  }
  log("voiceover settled:", settled, "(status " + status + ")");
  if (!settled) throw new Error("restore voiceover job did not settle");

  await sleep(1500);
  const asm = await api(`/api/videos/${VIDEO}/assemble`, { method: "POST" });
  const doc1 = asm.body?.timeline;
  log(
    "POST assemble ->", asm.status,
    doc1 ? `(${doc1.sceneCount} scenes, ${doc1.totalDurationSec.toFixed(1)}s)` : ""
  );
  const restoredDur = doc1?.scenes?.find((s) => s.index === target.index)?.durationSec;
  log(
    `target scene ${target.index} duration: ${target.durationSec.toFixed(1)}s -> ${restoredDur?.toFixed(1) ?? "?"}s`,
    restoredDur && Math.abs(restoredDur - target.durationSec) < 3 ? "≈ RESTORED ✓" : "changed (fresh read)"
  );

  log("pageerrors:", errors, errors === 0 ? "CLEAN ✓" : "DIRTY ✗");
  log("DONE", errors === 0 && back === before ? "— PASS" : "— FAIL");
  await browser.close();
} catch (e) {
  log("FAILED:", String(e).slice(0, 500));
  await page.screenshot({ path: SHOT("fail") }).catch(() => {});
  await browser.close();
}

function parseTc(tc) {
  // "MM:SS.cc / MM:SS.cc" — take the first half.
  const m = /(\d+):(\d+)[.,](\d+)/.exec(tc ?? "");
  if (!m) return -1;
  return Number(m[1]) * 60 + Number(m[2]) + Number(`0.${m[3]}`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
