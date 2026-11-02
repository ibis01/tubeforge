// Next.js server bootstrap hook (Stage 3, T-3.5).
//
// register() runs ONCE per server process start (dev + production, nodejs
// runtime only). This is where the durable queue comes alive in the web
// process: handlers registered, claim loop started. Import cycles are
// avoided precisely because jobs.ts never imports the handler registry.
//
// FAULT TOLERANCE (the Vercel registration incident): register() must NEVER
// reject. On serverless, ONE throwing import or init inside this hook kills
// the whole function at cold start — every route in the deployment then
// answers a bare 500 (observed live: register/login/status and even a
// next/server-only diagnostic route all failed while middleware-originated
// 401s kept working). The web process's job is serving requests; if the
// queue cannot boot (missing env, read-only fs, untraced dynamic import…)
// that must degrade the background jobs, not the entire app. The outcome is
// recorded on globalThis so /api/diag can report it remotely.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const g = globalThis as typeof globalThis & {
    __tfInstrumentation?: { ok: boolean; error?: string; at: string };
  };

  try {
    const { registerDefaultHandlers } = await import("./lib/tubeforge/queue-handlers");
    const { initQueue } = await import("./lib/tubeforge/queue");

    registerDefaultHandlers();
    initQueue("web"); // starts the claim loop (TUBEFORGE_NO_CLAIM=1 → enqueue-only)

    // Release holds orphaned by dead processes (best-effort, never throws,
    // timer is unref'd — see startStaleHoldSweeper).
    const { startStaleHoldSweeper } = await import("./lib/tubeforge/billing");
    startStaleHoldSweeper();

    const { log } = await import("./lib/tubeforge/log");
    log.info("queue initialized", {
      role: "web",
      noClaim: process.env.TUBEFORGE_NO_CLAIM === "1",
      pid: process.pid,
    });

    // Operator's shared voice server (self-hosted/sandbox): make sure the
    // Chatterbox server behind TUBEFORGE_SHARED_VOICE_URL is up. Fire-and-
    // forget + never fatal — a missing voice server only degrades cloning.
    if (process.env.TUBEFORGE_SPAWN_VOICE_SERVER === "1") {
      try {
        const { spawnSharedVoiceServer } = await import("./lib/tubeforge/spawn-voice-server");
        const result = await spawnSharedVoiceServer();
        log.info("shared voice server", { ...result });
      } catch (err) {
        console.error(
          "[instrumentation] voice server spawn hook failed (app continues):",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    g.__tfInstrumentation = { ok: true, at: new Date().toISOString() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const stackLines = ((err instanceof Error ? err.stack : "") ?? "")
      .split("\n")
      .slice(1, 4)
      .join(" | ")
      .slice(0, 300);
    g.__tfInstrumentation = {
      ok: false,
      error: `${message} :: ${stackLines}`,
      at: new Date().toISOString(),
    };
    // Loud but non-fatal — see the header comment.
    console.error("[instrumentation] queue boot FAILED (app continues without background jobs):", message);
  }
}
