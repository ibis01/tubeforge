// Error redaction — the last line of defence before a provider's failure
// text is persisted or shown. ffmpeg, the OpenAI-compatible providers,
// Google's token endpoints, and the resumable-upload API can all echo
// credential-shaped strings back inside error messages: an invalid key in a
// URL, an Authorization header, an OAuth code= param, a refresh token, a
// local path. Everything a catch block wants to persist (video.error,
// Job.error, activity rows) or return to the browser flows through
// errorText() so those substrings never leave the server intact.
//
// Pure + dependency-free (no DB, no next/server) so the offline unit suite
// can regression-test it — same discipline as settings-public.ts.

const REDACTIONS: Array<
  [RegExp, string | ((substring: string, ...args: any[]) => string)]
> = [
  // Google API keys (AIza…) — also matches Firebase web keys.
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "<google-key>"],
  // OpenAI-style keys (sk-…), including provider-prefixed variants.
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "<api-key>"],
  // JWTs (three base64url segments) — Google id_tokens especially.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b/g, "<jwt>"],
  // Authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, "$1 <redacted>"],
  // Credential params inside URLs (query echoes only — the [?&] context
  // keeps ffmpeg's "exited with code=ENOSPC" diagnostics intact while
  // scrubbing ?code=… / &key=… / &access_token=… from OAuth redirects and
  // provider URLs that show up verbatim in fetch failures). The match
  // consumes name AND value; the replacement keeps the name for readability.
  [
    /[?&]((?:api_?key|access_?token|refresh_?token|id_?token|client_?secret|oauth_?code|code|token|secret))=[^&\s"'`<>;]{1,}/gi,
    (m, name: string) => `${m[0]}${name}=<redacted>`,
  ],
  // Generic long opaque tokens (base64url-ish, ≥48 chars) — catches
  // provider keys whose shape we don't know. cuid()/uuid row ids are far
  // shorter, so legit ids in messages survive.
  [/\b[A-Za-z0-9+/_-]{48,}={0,2}\b/g, "<token>"],
  // Long hex blobs (≥32) — digests, hashes, opaque ids.
  [/\b[0-9a-f]{32,}\b/gi, "<token>"],
  // Local filesystem paths from ffmpeg / stack traces.
  [/\/(?:home|Users|root|app|var|tmp)\/[^\s"'`<>,;)\]]+/g, "<path>"],
];

const MAX_LEN = 500;

/** Scrub credential-shaped substrings from free-form text. */
export function redactText(input: string): string {
  let out = input ?? "";
  for (const [re, replacement] of REDACTIONS) {
    out =
      typeof replacement === "function"
        ? out.replace(re, replacement)
        : out.replace(re, replacement);
  }
  // Secrets are scrubbed BEFORE truncating, so the tail is safe to keep —
  // and the tail is where the real diagnosis lives (ffmpeg/stack traces end
  // with their error line; the head is banners and progress spam).
  if (out.length > MAX_LEN) out = "…" + out.slice(-(MAX_LEN - 1));
  return out;
}

/**
 * Drop-in replacement for `err instanceof Error ? err.message : fallback` at
 * every catch site that persists or returns the message. Thrown strings are
 * redacted too; anything else falls back unchanged.
 */
export function errorText(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return redactText(err.message);
  if (typeof err === "string" && err) return redactText(err);
  return fallback;
}
