#!/usr/bin/env node
/**
 * Gateway quota probe (S63 outage resumption check).
 *
 * One tiny chat dispatch through the app's OWN stack (budget → chat provider
 * → zai-client → /etc/.z-ai-config → gateway), provider pinned to zai the
 * same way the S62/S63 validation lanes pin it (fresh sandbox DB ships the
 * capability unconfigured). The S63 outage was account-wide (video AND llm
 * 429), so an llm probe is the cheap honest signal: GREEN reply means the
 * window cleared and the S63 re-measure is safe to start; 429 means still
 * throttled; anything else is surfaced verbatim. No secrets printed.
 * Exit 0 on green, 1 on 429/quota, 2 on other errors.
 *
 *   node --import tsx scripts/gateway-quota-probe.mts
 */
const { aiCall } = await import("../src/lib/tubeforge/budget");
const { chatComplete } = await import("../src/lib/tubeforge/providers/chat");

const t0 = Date.now();
try {
  const out = await aiCall("llm", "gateway quota probe", () =>
    chatComplete(
      {
        system: "You are a quota probe. Reply with exactly: WIRED",
        user: "run",
      },
      { provider: "zai", model: "" }
    )
  );
  console.log(
    `[PROBE-GREEN] chat replied in ${Date.now() - t0}ms:`,
    JSON.stringify(String(out).slice(0, 40))
  );
  process.exit(0);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  const is429 = /429|too many|rate.?limit/i.test(msg);
  console.log(
    is429
      ? `[PROBE-429] still throttled (${Date.now() - t0}ms): ${msg.slice(0, 160)}`
      : `[PROBE-ERR] ${msg.slice(0, 300)}`
  );
  process.exit(is429 ? 1 : 2);
}
