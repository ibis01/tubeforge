// The CSRF origin-trust resolver (S30) — "the wire-up".
//
// The preview deployment serves the app at https://preview-<bot-id>.space-z.ai
// behind a proxy that REWRITES the Host header on the way in. The Stage-2
// CSRF guard compared the browser's Origin against that rewritten Host, so
// every cookie-authenticated mutation from the signed-in preview browser
// died at the front door with 403 "Cross-origin request rejected" — the
// phone screenshots showed it as "AI Script + Metadata failed" and
// "Scan failed": the first real API call was the one the guard killed.
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
//   2. BUILTIN PREVIEW TRUST (S38, 2026-11-06 UTC) — the Z.ai chat-bot
//      preview deployment pattern `preview-*.space-z.ai` is always trusted
//      WITHOUT operator env config, because (a) it is OUR infrastructure
//      (Z.ai's own preview platform), (b) chat-bot preview deployments
//      cannot have TUBEFORGE_ALLOWED_ORIGINS provisioned out-of-band, and
//      (c) without this default the entire Auto-Pilot pipeline is
//      unreachable from the preview — Step 1 (AI Script + Metadata) dies
//      at the CSRF door before the z SDK is ever reached. The pattern is
//      deliberately narrow (the literal `preview-` prefix + the literal
//      `space-z.ai` suffix) so an unrelated Z.ai subdomain or a lookalike
//      can never ride it. Cookie SameSite is the first CSRF line of
//      defense; this is the second, scoped to the operator's own platform.
//   3. X-Forwarded-Host — ONLY when TUBEFORGE_TRUST_FORWARDED_HOST=1, for
//      deployments whose proxy provably overwrites the header (a client-
//      spoofable X-Forwarded-Host must never be trusted blind). The first
//      chain entry is the original Host the proxy received.
//   4. The request's own Host header — direct connections, no proxy. The
//      Stage-2 default.
//
// Edge-safe by construction: URL parsing and string comparison only — no
// node:* imports, no DB, no fs (the middleware's own law).

export type OriginTrustVia =
  | "allow-exact"
  | "allow-origin"
  | "allow-suffix"
  | "builtin-preview"
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

/**
 * Built-in preview-deployment trust (S38, 2026-11-06 UTC) — the Z.ai chat-bot
 * preview platform serves every deployment at `preview-<id>.space-z.ai`, and
 * chat-bot preview deployments cannot have TUBEFORGE_ALLOWED_ORIGINS
 * provisioned out-of-band. Without an unconditional trust here, every
 * cookie-authenticated mutation from the signed-in preview browser dies at
 * the CSRF door — the proxy rewrites Host on the way in, so the request-host
 * check fails, and the operator allow-list is empty.
 *
 * The pattern is deliberately tight: literal `preview-` prefix, then one or
 * more label chars (UUIDs, slugs, bot-ids), then the literal `.space-z.ai`
 * suffix. An unrelated Z.ai subdomain, a hyphen lookalike, or a deeper
 * attacker host can never ride it — the regex anchors to end-of-string and
 * requires the `preview-` prefix to start the first label.
 *
 * Cookie SameSite is the first CSRF line of defense; this is the second,
 * scoped to the operator's own platform so the deployed preview can actually
 * exercise the z SDK wiring S37 landed.
 */
const BUILTIN_PREVIEW_HOST_RE = /^preview-[a-z0-9][a-z0-9-]*\.space-z\.ai$/i;

function isBuiltinTrustedPreviewHost(host: string): boolean {
  // host is already lowercased by originHostOf before we get here, but the
  // /i flag keeps the regex honest if a caller forgets.
  return BUILTIN_PREVIEW_HOST_RE.test(host);
}

export function originHostTrusted(input: OriginTrustInput): OriginTrustDecision {
  const originHost = originHostOf(input.origin);
  if (!originHost) return { ok: false, via: "rejected" };

  // 1. explicit allow-list (operator-configurable; always wins so a stricter
  //    operator canNOT be silently bypassed by the built-in default)
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

  // 2. built-in Z.ai preview-deployment trust (S38) — see isBuiltinTrustedPreviewHost.
  if (isBuiltinTrustedPreviewHost(originHost))
    return { ok: true, via: "builtin-preview" };

  // 3. the proxy-preserved original Host (opt-in — see module header)
  if (input.trustForwardedHost && input.forwardedHost) {
    const first = input.forwardedHost.split(",")[0].trim().toLowerCase();
    if (first && first === originHost) return { ok: true, via: "forwarded-host" };
  }

  // 4. the request's own Host (direct connections)
  if (input.host && input.host.toLowerCase() === originHost)
    return { ok: true, via: "request-host" };

  return { ok: false, via: "rejected" };
}
