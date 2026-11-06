// S41 visual probe — the video-detail dialog grid blowout.
//
// Reproduces the "card not rendering well" report mechanically: opens the
// video detail dialog for a story video (Timeline Studio mounted), then
// measures whether the dialog's content column stays inside its frame.
//
// The root cause this probe pins:
//   • ui/dialog.tsx DialogContent is a CSS `grid` (single AUTO track);
//   • the Timeline Studio header toolbar is one NOWRAP flex row holding
//     ~2,400px of fixed-width selects (S6..S15 each added a group);
//   • grid auto tracks size to the min-content of their widest item → the
//     whole dialog (thumbnail img.w-full, every card, the preset row)
//     stretches to the toolbar's width and clips at the 672px frame.
//
// Usage: node --import tsx scripts/s41-visual-probe.mts [--label before|after]
// Prereqs: dev server on :3000, a minted session token in /tmp/tf-session.txt.
import { chromium } from "playwright";
import fs from "fs";

const label = process.argv.includes("--label")
  ? process.argv[process.argv.indexOf("--label") + 1]
  : "probe";
const token = fs.readFileSync("/tmp/tf-session.txt", "utf8").trim();

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
await ctx.addCookies([
  { name: "tf_session", value: token, url: "http://localhost:3000" },
]);
const page = await ctx.newPage();

await page.goto("http://localhost:3000/", { waitUntil: "networkidle" });
// The SPA lands on the dashboard; navigate to the Library first.
await page.click('button:has-text("Library"), [role="button"]:has-text("Library")');
await page.waitForSelector('button[aria-label^="Open details for"]', { timeout: 20_000 });

// Open the first story video's detail dialog.
await page.click('button[aria-label^="Open details for"]');
await page.waitForSelector('[data-slot="dialog-content"]', { timeout: 10_000 });
// The Video tab is the default for videos with a voiceover; wait for the
// Timeline Studio header to mount (canAssemble gate passed).
await page.waitForSelector("text=Timeline Studio", { timeout: 15_000 });
// Let the assemble GET + lane render settle.
await page.waitForTimeout(1500);

// NOTE: passed as a STRING — tsx's __name wrapper breaks function serialization.
const m = await page.evaluate<string, ReturnType<typeof JSON.parse>>(`
(() => {
  const dlg = document.querySelector('[data-slot="dialog-content"]');
  const cs = getComputedStyle(dlg);
  const dlgRect = dlg.getBoundingClientRect();
  const header = dlg.querySelector("header");
  const toolbar = header ? header.querySelector("div.ml-auto") : null;
  const img = dlg.querySelector("img.w-full");
  const presetButtons = [...dlg.querySelectorAll("button")]
    .filter((b) => /YouTube 1080p|Cinematic master|Reels \\/ TikTok|Shorts 60|Square social|Clean draft/.test(b.textContent ?? ""));
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.right <= dlgRect.right + 1;
  };
  return {
    dialog: {
      display: cs.display,
      gridTemplateColumns: cs.gridTemplateColumns,
      clientWidth: dlg.clientWidth,
      scrollWidth: dlg.scrollWidth,
      overflowX: cs.overflowX,
      hasHorizontalScrollbar: dlg.scrollWidth > dlg.clientWidth + 1,
    },
    toolbar: toolbar ? {
      className: toolbar.className,
      clientWidth: toolbar.clientWidth,
      scrollWidth: toolbar.scrollWidth,
      rowsApprox: Math.max(1, Math.round(toolbar.getBoundingClientRect().height / 40)),
    } : null,
    headerWraps: header ? getComputedStyle(header).flexWrap : null,
    heroImgWidth: img ? Math.round(img.getBoundingClientRect().width) : null,
    presets: {
      total: presetButtons.length,
      visibleInsideFrame: presetButtons.filter((b) => visible(b)).length,
    },
  };
})()`);

console.log(JSON.stringify(m, null, 2));

// Screenshot the dialog region for the before/after evidence wall — the
// VIEWPORT crop (not an element shot: the blown-out element is 3,195px wide
// and an element capture would clip past the viewport anyway).
const dlgBox = await page.evaluate(`(() => {
  const r = document.querySelector('[data-slot="dialog-content"]').getBoundingClientRect();
  return { x: Math.max(0, r.x), y: Math.max(0, r.y),
           width: Math.min(r.width, window.innerWidth - Math.max(0, r.x)),
           height: Math.min(r.height, window.innerHeight - Math.max(0, r.y)) };
})()`);
await page.screenshot({ path: `/tmp/tf-s41-${label}.png`, clip: dlgBox });
console.log(`screenshot → /tmp/tf-s41-${label}.png`);

const pass =
  !m.dialog.hasHorizontalScrollbar &&
  m.presets.total === m.presets.visibleInsideFrame;

console.log(pass ? "PROBE PASS (desktop) — dialog frame contains its content" : "PROBE FAIL (desktop) — content overflows the dialog frame");

// ---- Mobile leg: the same dialog at phone width (375px) — the wrapped
// toolbar must not blow the frame out there either. ----
const mctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
await mctx.addCookies([
  { name: "tf_session", value: token, url: "http://localhost:3000" },
]);
const mpage = await mctx.newPage();
await mpage.goto("http://localhost:3000/", { waitUntil: "networkidle" });
// On phones the sidebar collapses to a Sheet — open it first, then click
// Library INSIDE the mobile nav (the desktop sidebar clone stays hidden).
await mpage.click('[aria-label="Open navigation menu"]');
// Scope INSIDE the Sheet — a hidden desktop sidebar clone shares the same
// nav aria-label and would swallow the click.
await mpage.click('[data-slot="sheet-content"] nav button:has-text("Library")');
await mpage.waitForSelector('button[aria-label^="Open details for"]', { timeout: 20_000 });
await mpage.click('button[aria-label^="Open details for"]');
await mpage.waitForSelector("text=Timeline Studio", { timeout: 15_000 });
await mpage.waitForTimeout(1200);
const mm = await mpage.evaluate(`(() => {
  const dlg = document.querySelector('[data-slot="dialog-content"]');
  return { clientWidth: dlg.clientWidth, scrollWidth: dlg.scrollWidth,
           overflow: dlg.scrollWidth > dlg.clientWidth + 1 };
})()`);
console.log("mobile:", JSON.stringify(mm));
const mobilePass = !mm.overflow;
await mpage.screenshot({ path: `/tmp/tf-s41-${label}-mobile.png` });
console.log(mobilePass ? "PROBE PASS (mobile)" : "PROBE FAIL (mobile)");

await browser.close();
process.exit(pass && mobilePass ? 0 : 1);
