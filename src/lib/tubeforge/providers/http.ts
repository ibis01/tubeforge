// Shared fetch plumbing for the non-Z.ai provider adapters — URL joining,
// timeouts, and readable errors (status + body snippet) so users can debug
// 401s / wrong endpoints straight from the activity feed.

import { redactText } from "../redact";

const TIMEOUT_MS = 300_000; // 5 min — long LLM and image calls are normal

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

export async function providerFetch(
  provider: string,
  url: string,
  init: RequestInit
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      throw new Error(
        `${provider} request timed out after 5 minutes (${sanitizeUrlForError(url)})`
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
  init: RequestInit
): Promise<T> {
  const response = await providerFetch(provider, url, init);
  return (await response.json()) as T;
}
