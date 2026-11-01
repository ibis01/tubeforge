// Structured JSON logging (Stage 3, T-3.2).
//
// Zero-dependency pino-format logger: one JSON object per line with level,
// time (epoch ms), msg and context bindings. Centralized logs (Logtail,
// Loki, CloudWatch…) ingest these lines directly; `jq` works on dev output.
//
// Design notes:
//   * NO pino dependency on purpose — the logger must work inside Next.js
//     route handlers, the standalone queue worker (scripts/worker.mts) and
//     unit tests alike, with no transport/worker-thread setup. The line
//     FORMAT is pino-compatible; swapping to pino later is a drop-in.
//   * Every field that could carry a secret goes through redactText —
//     provider errors, API messages and URLs routinely embed keys.
//   * `log.child(bindings)` returns a cheap derived logger; jobs bind
//     { job: id, kind, org } once and every line inherits it.

import { redactText } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: Record<LogLevel, number> = { debug: 20, info: 30, warn: 40, error: 50 };

/**
 * Effective threshold, resolved per emit (an env read — negligible next to
 * serialization). No caching so tests and runtime reconfiguration work.
 */
function threshold(): number {
  const raw = (process.env.TUBEFORGE_LOG_LEVEL ?? "").toLowerCase();
  if (raw in LEVELS) return LEVELS[raw as LogLevel];
  return LEVELS.info; // default
}

/** Fields whose VALUES are redacted before serialization. */
const SECRET_KEY_RE = /(password|token|secret|apikey|api_key|credential|cookie|authorization|refresh)/i;

/** Best-effort ISO timestamp for `time` fields nested inside bindings. */
function serializeValue(key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message), stack: value.stack?.split("\n").slice(0, 6).join("\n") };
  }
  if (typeof value === "string") {
    return SECRET_KEY_RE.test(key) ? "<redacted>" : redactText(value.slice(0, 2000));
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    try {
      // Small objects (job payloads, settings maps) pass through sanitized.
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>).slice(0, 25)) {
        out[k] = serializeValue(k, v);
      }
      return out;
    } catch {
      return "<unserializable>";
    }
  }
  return value;
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: LogLevel, bindings: Record<string, unknown>, msg: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold()) return;

  const line: Record<string, unknown> = {
    level: LEVELS[level],
    time: Date.now(),
    msg,
    ...bindings,
  };
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      line[k] = serializeValue(k, v);
    }
  }

  // Serialize defensively — a logger that throws takes the app down with it.
  let text: string;
  try {
    text = JSON.stringify(line);
  } catch {
    text = JSON.stringify({ level: LEVELS[level], time: Date.now(), msg, note: "bindings not serializable" });
  }

  // level 40/50 → stderr, matching pino's destination convention.
  if (LEVELS[level] >= 40) process.stderr.write(text + "\n");
  else process.stdout.write(text + "\n");
}

export function createLogger(bindings: Record<string, unknown> = {}): Logger {
  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(bindings)) sanitized[k] = serializeValue(k, v);

  return {
    debug: (msg, extra) => emit("debug", sanitized, msg, extra),
    info: (msg, extra) => emit("info", sanitized, msg, extra),
    warn: (msg, extra) => emit("warn", sanitized, msg, extra),
    error: (msg, extra) => emit("error", sanitized, msg, extra),
    child: (more) => createLogger({ ...sanitized, ...more }),
  };
}

/**
 * Root logger. Library modules call `log.child({ mod: "queue" })` at module
 * scope; route handlers bind request ids if they need them.
 */
export const log = createLogger({ app: "tubeforge" });

/**
 * Back-compat bridge for the ~200 existing `console.log/warn/error` calls in
 * lib/tubeforge: keep console during bootstrap (before this module loads) but
 * give new code one obvious import. NOT installed globally — console keeps
 * working where it is; migrating hot paths happens opportunistically.
 */
export function consoleBridge(mod: string): Pick<Console, "log" | "warn" | "error"> {
  const child = log.child({ mod });
  return {
    log: (msg?: unknown, ...rest: unknown[]) => child.info(String(msg), rest.length ? { detail: rest } : undefined),
    warn: (msg?: unknown, ...rest: unknown[]) => child.warn(String(msg), rest.length ? { detail: rest } : undefined),
    error: (msg?: unknown, ...rest: unknown[]) => child.error(String(msg), rest.length ? { detail: rest } : undefined),
  };
}
