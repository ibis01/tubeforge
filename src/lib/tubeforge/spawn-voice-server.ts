// Supervisor for the operator's shared voice server (self-hosted TubeForge).
//
// When the app boots with TUBEFORGE_SPAWN_VOICE_SERVER=1, this module makes
// sure the Chatterbox voice server (voice-server/voice_server.py) is running
// on the TUBEFORGE_SHARED_VOICE_URL endpoint: if its /health already answers,
// nothing happens (an external supervisor or a surviving process owns it);
// otherwise it is spawned detached, with logs appended to voice-server/server.log.
//
// Constraints honored:
//   * Only LOCAL (loopback) shared servers are spawned — a remote
//     TUBEFORGE_SHARED_VOICE_URL is somebody else's process.
//   * Never blocks the boot: spawn() is fire-and-forget; the model loads in
//     the background (~10-60 s) and callers poll /health or retry on 503.
//   * Never throws — instrumentation.register() must stay non-fatal.

import { spawn } from "child_process";
import fs from "fs";
import path from "path";

export interface SpawnResult {
  spawned: boolean;
  detail: string;
}

/** Is the voice server at `baseUrl` answering /health? */
async function voiceServerUp(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(2_500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Bring the shared voice server up if needed. NEVER throws. */
export async function spawnSharedVoiceServer(): Promise<SpawnResult> {
  const url = process.env.TUBEFORGE_SHARED_VOICE_URL?.trim();
  if (!url) return { spawned: false, detail: "TUBEFORGE_SHARED_VOICE_URL not set" };
  if (process.env.TUBEFORGE_SPAWN_VOICE_SERVER !== "1")
    return { spawned: false, detail: "spawn disabled (TUBEFORGE_SPAWN_VOICE_SERVER != 1)" };

  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { spawned: false, detail: `invalid TUBEFORGE_SHARED_VOICE_URL: ${url}` };
  }
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isLoopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!isLoopback)
    return { spawned: false, detail: "shared voice server is remote — nothing to spawn" };

  if (await voiceServerUp(url))
    return { spawned: false, detail: "voice server already up" };

  // Locate voice-server/ — explicit env wins; standalone server's cwd is
  // .next/standalone, so fall back to the project root beside it.
  const candidates = [
    process.env.TUBEFORGE_VOICE_SERVER_DIR?.trim(),
    path.join(process.cwd(), "voice-server"),
    path.resolve(process.cwd(), "..", "voice-server"),
  ].filter(Boolean) as string[];
  const dir = candidates.find((d) =>
    fs.existsSync(path.join(d, "voice_server.py")) &&
    fs.existsSync(path.join(d, ".venv", "bin", "python")),
  );
  if (!dir)
    return {
      spawned: false,
      detail: `voice-server not found (looked in ${candidates.join(", ")})`,
    };

  const port = target.port || "8931";
  const key = process.env.TUBEFORGE_SHARED_VOICE_KEY?.trim() || "";
  const model = process.env.TUBEFORGE_VOICE_SERVER_MODEL?.trim() || "chatterbox-turbo";
  const logFile = path.join(dir, "server.log");

  try {
    const out = fs.openSync(logFile, "a");
    const child = spawn(
      path.join(dir, ".venv", "bin", "python"),
      [
        path.join(dir, "voice_server.py"),
        "--model", model,
        "--host", host === "::1" ? "::1" : "127.0.0.1",
        "--port", port,
        ...(key ? ["--key", key] : []),
      ],
      {
        cwd: dir,
        detached: true,
        stdio: ["ignore", out, out],
        env: {
          ...process.env,
          // Persistent model cache inside the project dir (survives reboots).
          HF_HOME: path.join(dir, "hf-cache"),
          // glibc arena proliferation balloons python RSS on small boxes.
          MALLOC_ARENA_MAX: "2",
        },
      },
    );
    child.unref();
    return {
      spawned: true,
      detail: `voice server spawning (pid ${child.pid}, model ${model}, port ${port}, log ${logFile})`,
    };
  } catch (err) {
    return {
      spawned: false,
      detail: `spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Watchdog ────────────────────────────────────────────────────────────────
//
// The voice server runs on the same small box as the app; under memory
// pressure the kernel's OOM killer may take it down mid-synthesis. The
// watchdog re-runs the (idempotent) spawn check every 60 s — a dead server
// is restarted in ~1 minute without anyone noticing. Unref'd so it never
// holds the process open; only active when spawning is enabled.

const g = globalThis as typeof globalThis & { __tfVoiceWatchdog?: NodeJS.Timeout };

export function startVoiceServerWatchdog(): void {
  if (g.__tfVoiceWatchdog) return;
  const timer = setInterval(() => {
    spawnSharedVoiceServer().catch(() => {});
  }, 60_000);
  timer.unref();
  g.__tfVoiceWatchdog = timer;
}
