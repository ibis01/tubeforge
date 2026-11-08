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
//   * S57/T-57.1: request correlation — middleware stamps x-request-id on
//     every /api/* request; `requestLog(request)` binds it onto a child so
//     every line a route handler emits carries the same `req` value the
//     failing client can quote from its response header.

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

  writeLine(level, text);
}

/**
 * The sink — runtime-portable on purpose (S57/T-57.2): Node writes the JSON
 * line to stdout/stderr (pino's destination convention, level 40/50 → stderr);
 * where `process` has no std streams (an edge-runtime bundle, the browser)
 * the console is the only sink and receives the SAME JSON line. One logging
 * law everywhere — middleware.ts can import this module without breaking
 * its no-node:* constraint, and a client bundle degrades instead of crashing.
 */
function writeLine(level: LogLevel, text: string): void {
  const stderr = LEVELS[level] >= 40;
  const streams = typeof process === "undefined" ? undefined : process;
  const sink = stderr ? streams?.stderr : streams?.stdout;
  if (sink && typeof sink.write === "function") {
    sink.write(text + "\n");
    return;
  }
  // The fallback sink IS this logger; every other src/ console site is
  // frozen out by T-57.3's error rule.
  // eslint-disable-next-line no-console
  (stderr ? console.error : console.log)(text);
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
 * S57/T-57.1 — the request correlation header. middleware.ts stamps a fresh
 * value (crypto.randomUUID) on every /api/* request and echoes it on every
 * response, error responses included; an operator holding a failing
 * response can grep the centralized log for the exact lines that served it.
 */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * The id middleware stamped on this request, or null when nothing did
 * (direct calls, the worker, tests). Structural on purpose — NextRequest,
 * Request and test doubles all satisfy it, keeping this module free of
 * next/server imports (the offline unit suite's law). Inbound ids are read
 * here but never trusted for STAMPING — middleware always overwrites.
 */
export function requestIdFrom(request: { headers: { get(name: string): string | null } }): string | null {
  const id = request.headers.get(REQUEST_ID_HEADER);
  return id && id.length > 0 && id.length <= 128 ? id : null;
}

/**
 * A child logger bound to the current request's id — P0-7's wiring.
 * `const rlog = requestLog(request, { mod: "videos:render" })` and every
 * line from that handler carries `req`; nested children inherit it.
 */
export function requestLog(
  request: { headers: { get(name: string): string | null } },
  bindings: Record<string, unknown> = {},
): Logger {
  const req = requestIdFrom(request);
  return log.child({ ...(req ? { req } : {}), ...bindings });
}

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
