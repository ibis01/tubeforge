// Shared fetch plumbing for the non-Z.ai provider adapters — URL joining,
// per-capability timeouts (Stage 3, D-09), and readable errors (status + body
// snippet) so users can debug 401s / wrong endpoints straight from the feed.

import { redactText } from "../redact";
import { log } from "../log";

// S57/T-57.2 — the module's logger (the old [http] prefix became a binding).
const httpLog = log.child({ mod: "http" });

/**
 * Per-capability timeout matrix (ms). Replaces the flat 5-minute universal
 * timeout the audit flagged (D-09): a YouTube metadata call should fail fast,
 * a CogVideoX generation may legitimately run 10 minutes.
 *
 * Every value is overridable via env: TUBEFORGE_TIMEOUT_<CAPABILITY> (ms),
 * e.g. TUBEFORGE_TIMEOUT_LLM=60000. Invalid env values fall back to the
 * default and warn once.
 */
export type ProviderCapability =
  | "llm" // chat completions (GLM etc.)
  | "tts" // speech synthesis
  | "image" // image generation
  | "video-gen" // image/video generation models
  | "vision" // image understanding
  | "asr" // transcription
  | "download" // binary result downloads (fal/Replicate/HF)
  | "youtube-api" // OAuth + Data API metadata calls — fail fast
  | "youtube-upload" // resumable video PUT — can legitimately take an hour
  | "generic"; // everything unclassified (300s — the old universal timeout)

const DEFAULT_TIMEOUT_MS: Record<ProviderCapability, number> = {
  llm: 120_000,
  tts: 180_000,
  image: 300_000,
  "video-gen": 600_000,
  vision: 120_000,
  asr: 180_000,
  download: 600_000,
  "youtube-api": 30_000,
  "youtube-upload": 3_600_000,
  generic: 300_000,
};

const g = globalThis as typeof globalThis & { __tfTimeouts?: Record<string, number>; __tfTimeoutWarned?: Set<string> };
const overrides = (g.__tfTimeouts ??= {});
const warned = (g.__tfTimeoutWarned ??= new Set());

export function timeoutFor(capability: ProviderCapability = "generic"): number {
  // Only valid env overrides are cached; defaults recompute so tests can
  // flip env vars without a stale cache.
  if (capability in overrides) return overrides[capability];
  const raw = process.env[`TUBEFORGE_TIMEOUT_${capability.toUpperCase().replace(/-/g, "_")}`];
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 1_000) {
    overrides[capability] = parsed;
    return parsed;
  }
  if (raw && !warned.has(capability)) {
    warned.add(capability);
    httpLog.warn("ignoring invalid TUBEFORGE_TIMEOUT (need >= 1000 ms)", { capability, raw });
  }
  return DEFAULT_TIMEOUT_MS[capability];
}

/** Test hook — forget cached env overrides. */
export function resetTimeoutOverrides(): void {
  for (const k of Object.keys(overrides)) delete overrides[k];
  warned.clear();
}

/** The matrix as a read-only snapshot (surfaced by GET /api/status diagnostics). */
export function timeoutMatrix(): Record<ProviderCapability, number> {
  return { ...DEFAULT_TIMEOUT_MS };
}

/**
 * Race a promise against a deadline. The bundled Z.ai SDK issues its own
 * fetches with no timeout — one hung image/vision call would otherwise
 * stall an entire background job (storyboard loop, quality gate) forever.
 * The losing call keeps running but its result is discarded; the budget.ts
 * retry layer re-attempts the work.
 */
export function withTimeout<T>(
  ms: number,
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s — will retry`)),
      ms
    );
    fn().then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

export function joinUrl(baseUrl: string, ...path: string[]): string {
  let url = baseUrl.trim().replace(/\/+$/, "");
  for (const p of path) url += `/${p.replace(/^\/+/, "")}`;
  return url;
}

/**
 * Local-first escape hatch (mirrors net-guard.ts): when TubeForge is
 * intentionally pointed at a self-hosted AI server (Ollama, LM Studio, …)
 * set TUBEFORGE_ALLOW_PRIVATE_HOSTS=1 in .env. Applies to PROVIDER calls
 * only — voice imports and media downloads stay locked to public hosts.
 */
export function allowPrivateProviderHosts(): boolean {
  return process.env.TUBEFORGE_ALLOW_PRIVATE_HOSTS === "1";
}

/**
 * URL stripped of credentials, query string and fragment, for safe display
 * inside error messages. Query strings routinely carry secrets
 * (?api_key=…, ?token=…) and errors end up in the activity feed and logs —
 * so only protocol + host + path are shown.
 */
export function sanitizeUrlForError(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 160);
  } catch {
    return "<unparsable url>";
  }
}

export class ProviderHttpError extends Error {
  constructor(
    public provider: string,
    public status: number,
    body: string
  ) {
    super(
      `${provider} request failed (HTTP ${status}): ${redactText(body).slice(0, 300)}`
    );
    this.name = "ProviderHttpError";
  }
}

export interface ProviderFetchOpts {
  /** Capability whose timeout applies (default "generic" — 300s). */
  capability?: ProviderCapability;
  /** Explicit override wins over the capability matrix. */
  timeoutMs?: number;
}

export async function providerFetch(
  provider: string,
  url: string,
  init: RequestInit,
  opts: ProviderFetchOpts = {}
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? timeoutFor(opts.capability);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        `${provider} request timed out after ${Math.round(timeoutMs / 1000)}s (${sanitizeUrlForError(url)})`
      );
    }
    throw new Error(
      redactText(
        `${provider} request failed: ${err instanceof Error ? err.message : String(err)} (${sanitizeUrlForError(url)})`
      )
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ProviderHttpError(provider, response.status, body);
  }
  return response;
}

export async function providerFetchJson<T>(
  provider: string,
  url: string,
  init: RequestInit,
  opts: ProviderFetchOpts = {}
): Promise<T> {
  const response = await providerFetch(provider, url, init, opts);
  return (await response.json()) as T;
}
