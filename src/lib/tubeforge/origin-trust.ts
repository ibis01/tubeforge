// The CSRF origin-trust resolver (S30) — "the wire-up".
//
// The preview deployment serves the app at https://preview-<bot-id>.space-z.ai
// behind a proxy that REWRITES the Host header on the way in. The Stage-2
// CSRF guard compared the browser's Origin against that rewritten Host, so
// every cookie-authenticated mutation from the signed-in preview browser
// died at the front door with 403 "Cross-origin request rejected" — the
// phone screenshots showed it as "AI Script + Metadata failed" and
// "Scan failed": steps 1–3 are client-side (no API), and the FIRST real
// API call was the one the guard killed.
//
// This module centralizes the trust decision so the middleware stays thin
// and the rules are probe-able. Trust is decided in this order:
//
//   1. TUBEFORGE_ALLOWED_ORIGINS — explicit allow-list, one entry per
//      comma-separated value. Entries may be:
//        · a bare host ("preview-abc.space-z.ai:3000")       — exact match
//        · a full origin ("https://preview-abc.space-z.ai")  — host match
//        · a SUFFIX ("." or "*." + domain, e.g. ".space-z.ai") — the domain
//          itself and every subdomain under it. The dot is load-bearing:
//          ".space-z.ai" matches "preview-x.space-z.ai" but never
//          "evil-space-z.ai" or "space-z.ai.attacker.com".
//   2. X-Forwarded-Host — ONLY when TUBEFORGE_TRUST_FORWARDED_HOST=1, for
//      deployments whose proxy provably overwrites the header (a client-
//      spoofable X-Forwarded-Host must never be trusted blind). The first
//      chain entry is the original Host the proxy received.
//   3. The request's own Host header — direct connections, no proxy. The
//      Stage-2 default.
//
// Edge-safe by construction: URL parsing and string comparison only — no
// node:* imports, no DB, no fs (the middleware's own law).

export type OriginTrustVia =
  | "allow-exact"
  | "allow-origin"
  | "allow-suffix"
  | "forwarded-host"
  | "request-host"
  | "rejected";

export interface OriginTrustDecision {
  ok: boolean;
  /** How the decision was made — the rejection log names the inputs. */
  via: OriginTrustVia;
}

export interface OriginTrustInput {
  /** Raw Origin header value (callers only invoke this when present). */
  origin: string;
  /** Raw Host header value (null when absent). */
  host: string | null;
  /** Raw X-Forwarded-Host value (null when absent). */
  forwardedHost?: string | null;
  /** Parsed TUBEFORGE_ALLOWED_ORIGINS entries (see parseAllowedOrigins). */
  allowedOrigins: string[];
  /** TUBEFORGE_TRUST_FORWARDED_HOST === "1". Default false. */
  trustForwardedHost?: boolean;
}

/** Split the env knob into clean entries ("a, b" → ["a", "b"]). */
export function parseAllowedOrigins(raw: string | undefined | null): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The host part of an origin URL, lowercased; null when unparseable. */
function originHostOf(origin: string): string | null {
  try {
    return new URL(origin).host.toLowerCase();
  } catch {
    return null;
  }
}

/** Does `host` fall under the suffix entry `entry` (".dom" / "*.dom")?
 * The base domain itself and any dotted subdomain match; lookalikes with a
 * hyphen or a deeper attacker domain never do. */
function matchesSuffix(host: string, entry: string): boolean {
  const base = entry.replace(/^\*\./, "").replace(/^\./, "").toLowerCase();
  if (!base || !base.includes(".")) return false; // a suffix must be a domain
  return host === base || host.endsWith("." + base);
}

export function originHostTrusted(input: OriginTrustInput): OriginTrustDecision {
  const originHost = originHostOf(input.origin);
  if (!originHost) return { ok: false, via: "rejected" };

  // 1. explicit allow-list
  for (const entry of input.allowedOrigins) {
    if (entry.includes("://")) {
      try {
        if (new URL(entry).host.toLowerCase() === originHost)
          return { ok: true, via: "allow-origin" };
      } catch {
        /* malformed entry — skip it, keep policing the rest */
      }
    } else if (entry.startsWith("*.") || entry.startsWith(".")) {
      if (matchesSuffix(originHost, entry)) return { ok: true, via: "allow-suffix" };
    } else if (entry.toLowerCase() === originHost) {
      return { ok: true, via: "allow-exact" };
    }
  }

  // 2. the proxy-preserved original Host (opt-in — see module header)
  if (input.trustForwardedHost && input.forwardedHost) {
    const first = input.forwardedHost.split(",")[0].trim().toLowerCase();
    if (first && first === originHost) return { ok: true, via: "forwarded-host" };
  }

  // 3. the request's own Host (direct connections)
  if (input.host && input.host.toLowerCase() === originHost)
    return { ok: true, via: "request-host" };

  return { ok: false, via: "rejected" };
}
