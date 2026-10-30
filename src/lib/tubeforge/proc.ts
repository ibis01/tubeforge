// Zombie-aware process runner — the ffmpeg/ffprobe workhorse.
//
// Why this exists (the 07:46 post-mortem): under bun, after Playwright's
// Chromium has lived in the same process, the runtime intermittently stops
// reaping exec'd children — ffmpeg finishes its encode (file written, stats
// printed), becomes a ZOMBIE with PPID=bun, and the `close`/`exit` events
// never fire, so execFile's promise hangs forever and the render stalls.
//
// The fix: spawn with stdout/stderr captured to temp FILES (no stream EOF
// dependency) and decide completion ourselves:
//   1. the `exit` event — the happy path (runtime reaping works);
//   2. a /proc poll — if the child's state is `Z` (zombie: finished, unreaped)
//      or /proc/<pid> is gone, the process is DEFINITELY done; resolve
//      without waiting for the runtime to notice.
// Exit code is only available on path 1. On the zombie path we classify
// success/failure from stderr (ffmpeg failure signatures are loud and
// consistent) and let downstream parse errors catch anything else.

import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

export interface RunResult {
  stdout: string;
  /** Raw stdout bytes — binary outputs (rawvideo etc.) must read this. */
  stdoutBuf: Buffer;
  stderr: string;
  /** null when resolved via the zombie poll (exit code held by the un-reaping parent). */
  code: number | null;
  via: "exit" | "zombie-poll";
}

const FAILURE_RE =
  /\b(Error|Conversion failed|Invalid data|Unable to|No such file|Permission denied|Failed to|matches no streams|Killed|out of memory|Cannot allocate)\b/i;

function procState(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // Field 3 (state) — but comm can contain spaces, so parse after the last ')'.
    const after = stat.slice(stat.lastIndexOf(")") + 2);
    return after.split(" ")[0] ?? null;
  } catch {
    return null; // /proc entry gone — process fully reaped or never existed
  }
}

export function runProcess(
  bin: string,
  args: string[],
  opts: { timeoutMs: number; label?: string }
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const outTmp = path.join(os.tmpdir(), `tf-run-${stamp}.out`);
    const errTmp = path.join(os.tmpdir(), `tf-run-${stamp}.err`);
    let settled = false;

    const cleanup = () => {
      fs.rmSync(outTmp, { force: true });
      fs.rmSync(errTmp, { force: true });
    };

    const readBack = (): { stdout: string; stdoutBuf: Buffer; stderr: string } => {
      let stdoutBuf = Buffer.alloc(0);
      let stderr = "";
      try { stdoutBuf = fs.readFileSync(outTmp); } catch { /* none */ }
      try { stderr = fs.readFileSync(errTmp, "utf8"); } catch { /* none */ }
      // Keep buffers bounded — the callers' maxBuffer contract.
      return {
        stdoutBuf: stdoutBuf.subarray(0, 128 * 1024 * 1024),
        stdout: stdoutBuf.subarray(0, 32 * 1024 * 1024).toString("utf8"),
        stderr: stderr.slice(0, 16 * 1024 * 1024),
      };
    };

    let child;
    try {
      const outFd = fs.openSync(outTmp, "w");
      const errFd = fs.openSync(errTmp, "w");
      child = spawn(bin, args, { stdio: ["ignore", outFd, errFd] });
      fs.closeSync(outFd);
      fs.closeSync(errFd);
    } catch (err) {
      cleanup();
      reject(err);
      return;
    }
    if (!child.pid) {
      cleanup();
      reject(new Error(`${bin} failed to spawn`));
      return;
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      const { stderr } = readBack();
      cleanup();
      reject(new Error(`${bin} timed out after ${Math.round(opts.timeoutMs / 1000)}s — ${stderr.slice(-300)}`));
    }, opts.timeoutMs);

    const finish = (code: number | null, via: RunResult["via"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { stdout, stdoutBuf, stderr } = readBack();
      cleanup();
      const failed = (code !== null && code !== 0) || (code === null && FAILURE_RE.test(stderr));
      if (failed) {
        const lines = stderr.replace(/\r/g, "\n").split("\n").filter((l) => l.trim().length > 0);
        const tail = lines.slice(-5).join(" | ").slice(-500);
        reject(new Error(`${bin} failed: ${tail}`));
        return;
      }
      resolve({ stdout, stdoutBuf, stderr, code, via });
    };

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(err);
    });
    child.on("exit", (code) => finish(code, "exit"));

    // Zombie watchdog — the bun-unreaped-children workaround.
    const poll = setInterval(() => {
      if (settled) { clearInterval(poll); return; }
      const state = procState(child.pid);
      if (state === "Z" || state === null) {
        clearInterval(poll);
        // Give the runtime a beat to deliver the real exit event + code.
        setTimeout(() => finish(null, "zombie-poll"), 400);
      }
    }, 250);
    // Stop the watchdog when the timeout fires (finish() already settled).
    child.on("exit", () => clearInterval(poll));
  });
}
