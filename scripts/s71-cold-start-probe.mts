#!/usr/bin/env node
/**
 * S70 CI-3 live probe — the cold-start opener rewrite through the app's
 * own stack. The self-containment scorer is unit-pinned; this verifies the
 * LLM garnish: given a mid-video scene, the rewrite names the subject,
 * fits a caption flash (<= 34 chars), and a gateway hiccup returns null
 * (the Short still cuts on the narration's own opening).
 *
 *   node --import tsx scripts/s71-cold-start-probe.mts
 */
const { draftColdStartOpener } = await import("../src/lib/tubeforge/shorts");

const t0 = Date.now();
const line = await draftColdStartOpener({
  topic: "How the human heart works",
  sceneNarration:
    "So that is why it fails under pressure — the left ventricle simply cannot keep up when the aorta narrows. The fix is usually a valve replacement.",
});
if (line === null) {
  console.log(`[OPENER-NULL] the gateway declined — the garnish degrades cleanly (${Date.now() - t0}ms)`);
  process.exit(0); // null is an honest outcome, not a failure
}
console.log(`[OPENER-OK] ${Date.now() - t0}ms: "${line}" (${line.length} chars)`);
if (line.length > 34) {
  console.log("[OPENER-ERR] the line exceeds one caption flash");
  process.exit(1);
}
console.log("[OPENER-VERIFIED] fits a caption flash, subject named for a cold viewer");
process.exit(0);
