// Standalone durable-queue worker (Stage 3, T-3.5).
//
//   npm run worker        (foreground)
//   npm run worker:daemon (background, logs to scripts/worker-daemon.log)
//
// Runs the SAME claim loop the web process runs (queue.ts), but claims ONLY
// handler-registered kinds (script / research / stock today) — the kinds
// whose work rebuilds entirely from DB state. Route closures (voiceover,
// render, …) still execute in the web process that created them.
//
// Deploy topology (SETUP.md §Production):
//   single box   — web only (loop runs in-process); this worker is optional
//                  extra capacity for the heavy AI stages
//   split        — web with TUBEFORGE_NO_CLAIM=1 (enqueue-only) + N workers
//                  (share the DB; same host so claim-liveness checks work)

async function main(): Promise<void> {
  const { registerDefaultHandlers } = await import("@/lib/tubeforge/queue-handlers");
  const { initQueue, queueWorkerId } = await import("@/lib/tubeforge/queue");
  const { ensureRecovered } = await import("@/lib/tubeforge/jobs");
  const { log } = await import("@/lib/tubeforge/log");

  registerDefaultHandlers();
  initQueue("worker");

  // Adopt orphaned rows from processes that died while we were down.
  await ensureRecovered();

  log.info("worker started", {
    workerId: queueWorkerId(),
    pid: process.pid,
    node: process.version,
  });

  // The queue tick timer is unref'd (it must not hold the web server open);
  // a worker is a dedicated process, so keep the event loop alive explicitly.
  const keepalive = setInterval(() => {}, 60_000);

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("worker shutting down", { signal });
    clearInterval(keepalive);
    // In-flight jobs finish or get re-enqueued by the next process's boot
    // recovery — no data loss either way. Exit when the loop drains (~1s).
    setTimeout(() => process.exit(0), 1_500);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
