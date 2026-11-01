// Next.js server bootstrap hook (Stage 3, T-3.5).
//
// register() runs ONCE per server process start (dev + production, nodejs
// runtime only). This is where the durable queue comes alive in the web
// process: handlers registered, claim loop started. Import cycles are
// avoided precisely because jobs.ts never imports the handler registry.

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const { registerDefaultHandlers } = await import("./lib/tubeforge/queue-handlers");
  const { initQueue } = await import("./lib/tubeforge/queue");

  registerDefaultHandlers();
  initQueue("web"); // starts the claim loop (TUBEFORGE_NO_CLAIM=1 → enqueue-only)

  const { log } = await import("./lib/tubeforge/log");
  log.info("queue initialized", {
    role: "web",
    noClaim: process.env.TUBEFORGE_NO_CLAIM === "1",
    pid: process.pid,
  });
}
