#!/usr/bin/env node
/**
 * S70 CI-1 live probe — the hook panel's LLM half through the app's own
 * stack (budget → llm.ts → zai gateway), exactly the way the gateway
 * quota probe rides it. The deterministic half is unit-pinned; this probe
 * verifies the GENERATION + JUDGE round-trip on the live gateway:
 *   - the panel returns 2-8 candidates from distinct formula families
 *   - every candidate carries the deterministic anchor + heuristic label
 *   - the judge contributes when it cooperates (judged: true/false — both
 *     honest outcomes; a 429 must NOT fail the probe, only mark judged:false
 *     when the generator itself succeeded)
 * Exit 0 = the panel is live-verifiable; 1 = the LLM half failed.
 *
 *   node --import tsx scripts/s70-hook-panel-probe.mts
 */
const { generateHookPanel } = await import("../src/lib/tubeforge/hook-score");

const t0 = Date.now();
try {
  const panel = await generateHookPanel({
    topic: "How the human heart actually works",
    niche: "Science",
    tone: "Curious and clear",
    scriptExcerpt:
      "Your heart beats about 100,000 times a day, pushing five liters of blood through a system of vessels that would circle the earth twice. Yet most people never learn why the left side is thicker than the right.",
    candidates: 5,
  });
  const families = new Set(panel.candidates.map((c) => c.formula));
  console.log(`[PANEL-OK] ${panel.candidates.length} candidates in ${Date.now() - t0}ms (judged=${panel.judged})`);
  for (const c of panel.candidates) {
    console.log(
      `  ${String(c.panelScore).padStart(3)} (det ${c.score.total}, judge ${c.judgeScore ?? "—"}) [${c.formula}] ${c.text}`
    );
  }
  if (panel.candidates.length < 2) throw new Error("fewer than 2 usable candidates");
  if (families.size < 2) throw new Error("candidates share one formula family");
  if (panel.candidates.some((c) => c.score.heuristic !== true)) throw new Error("a score lost its heuristic label");
  const ranked = [...panel.candidates].sort((a, b) => b.panelScore - a.panelScore);
  if (panel.winner?.text !== ranked[0].text) throw new Error("the winner is not the top-ranked candidate");
  console.log(`[PANEL-VERIFIED] distinct families (${families.size}), winner = top rank, heuristic labels intact`);
  process.exit(0);
} catch (err) {
  console.log(`[PANEL-ERR] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
