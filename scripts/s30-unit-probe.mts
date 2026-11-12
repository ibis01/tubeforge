// S30 unit probe — the origin-trust resolver's full decision matrix.
//
// The phone screenshots pinned the bug: the preview deployment's proxy
// rewrites the Host header, so the Stage-2 CSRF guard (origin === host)
// rejected EVERY cookie-authenticated mutation from the signed-in preview
// browser — surfacing in the UI as "AI Script + Metadata failed" and
// "Scan failed", both "Cross-origin request rejected". The AI itself was
// never reached: steps 1–3 of Auto-Pilot are client-side, and the first
// real API call died at the front door.
//
// This probe pins the resolver that replaces the inline check:
//   A. parseAllowedOrigins — the env knob's parsing law
//   B. the explicit allow-list — exact host, full origin, and the SUFFIX
//      entry (".space-z.ai") with its lookalike traps
//   C. X-Forwarded-Host — opt-in trust, chain-aware, never a partial match
//   D. the Host fallback — the direct-connection default (Stage-2 law)
//   E. rejection hygiene — garbage origins, empty inputs, port mismatches
//
// Run: node --import tsx scripts/s30-unit-probe.mts

import {
  originHostTrusted,
  parseAllowedOrigins,
} from "../src/lib/tubeforge/origin-trust";

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "✓" : "✗"} ${name}${ok || detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  if (ok) pass++; else fail++;
};

const decide = (o: {
  origin: string;
  host?: string | null;
  forwardedHost?: string | null;
  allowedOrigins?: string[];
  trustForwardedHost?: boolean;
}) =>
  originHostTrusted({
    host: null,
    forwardedHost: null,
    allowedOrigins: [],
    trustForwardedHost: false,
    ...o,
  });

// ---- A. parseAllowedOrigins ----
{
  check("A.1 comma list with spaces parses clean", JSON.stringify(parseAllowedOrigins(" a.com , b.com ")) === JSON.stringify(["a.com", "b.com"]), parseAllowedOrigins(" a.com , b.com "));
  check("A.2 undefined / empty / separator-only → empty list", parseAllowedOrigins(undefined).length === 0 && parseAllowedOrigins("").length === 0 && parseAllowedOrigins(" , ,").length === 0);
}

// ---- B. the explicit allow-list ----
{
  const list = ["preview-x.space-z.ai:3000", "https://studio.example.com", ".space-z.ai"];
  check("B.1 exact host entry matches (case-insensitive)", decide({ origin: "https://Preview-X.Space-Z.ai:3000", host: "something-else", allowedOrigins: list }).ok);
  check("B.2 a different host does NOT match the exact entry", !decide({ origin: "https://preview-y.space-z.ai:3000", host: null, allowedOrigins: ["preview-x.space-z.ai:3000"] }).ok);
  check("B.3 full-origin entry matches by host", decide({ origin: "https://studio.example.com", host: null, allowedOrigins: list }).ok);
  check("B.4 a malformed full-origin entry is skipped, not fatal", decide({ origin: "https://b.com", host: null, allowedOrigins: ["http://", "b.com"] }).ok);

  // The suffix law — the S30 headline.
  check("B.5 suffix entry matches a subdomain", decide({ origin: "https://preview-abc.space-z.ai", host: "localhost:3000", allowedOrigins: [".space-z.ai"] }).via === "allow-suffix");
  check("B.6 suffix entry matches the bare domain itself", decide({ origin: "https://space-z.ai", host: "localhost:3000", allowedOrigins: [".space-z.ai"] }).ok);
  check("B.7 '*.domain' spelling behaves identically", decide({ origin: "https://preview-abc.space-z.ai", host: null, allowedOrigins: ["*.space-z.ai"] }).ok);
  check("B.8 deep subdomains match (multi-label)", decide({ origin: "https://a.b.space-z.ai", host: null, allowedOrigins: [".space-z.ai"] }).ok);
  // The lookalike traps — the dot is load-bearing.
  check("B.9 hyphen lookalike rejected (evil-space-z.ai)", !decide({ origin: "https://evil-space-z.ai", host: null, allowedOrigins: [".space-z.ai"] }).ok);
  check("B.10 suffix-in-path lookalike rejected (space-z.ai.attacker.com)", !decide({ origin: "https://space-z.ai.attacker.com", host: null, allowedOrigins: [".space-z.ai"] }).ok);
  check("B.11 trailing-dot lookalike rejected (x.space-z.ai.evil)", !decide({ origin: "https://x.space-z.ai.evil", host: null, allowedOrigins: [".space-z.ai"] }).ok);
  check("B.12 a suffix must be a real domain ('.ai' alone never matches)", !decide({ origin: "https://anything.ai", host: null, allowedOrigins: [".ai"] }).ok && !decide({ origin: "https://anything.attacker.com", host: null, allowedOrigins: [".ai"] }).ok);
  check("B.13 unlisted domain rejected even when other entries exist", !decide({ origin: "https://app.other-z.ai", host: null, allowedOrigins: ["preview-x.space-z.ai:3000", ".space-z.ai"] }).ok);
}

// ---- C. X-Forwarded-Host ----
//
// Note (S38): the hostnames used here are deliberately NOT
// `preview-*.space-z.ai`, because the S38 built-in default (D-bis) fires
// BEFORE X-Forwarded-Host in the precedence chain — using a preview host
// here would make the test pass for the wrong reason (D-bis.11 nails that
// interaction). These cases use `studio.example.com` so they actually
// exercise the X-Forwarded-Host path.
{
  check("C.1 trusted + first chain entry matches → allowed", decide({ origin: "https://studio.example.com", host: "internal:3000", forwardedHost: "studio.example.com, internal:3000", allowedOrigins: [], trustForwardedHost: true }).via === "forwarded-host");
  check("C.2 the knob OFF means the header is ignored", !decide({ origin: "https://studio.example.com", host: "internal:3000", forwardedHost: "studio.example.com", allowedOrigins: [], trustForwardedHost: false }).ok);
  check("C.3 forwarded host differing from origin → still rejected", !decide({ origin: "https://evil.com", host: "internal:3000", forwardedHost: "evil-lookalike.com", allowedOrigins: [], trustForwardedHost: true }).ok);
  check("C.4 an empty forwardedHost is never trusted", !decide({ origin: "https://x.com", host: null, forwardedHost: "  ", allowedOrigins: [], trustForwardedHost: true }).ok);
}

// ---- D. the Host fallback (Stage-2 law preserved) ----
{
  check("D.1 origin === request host → allowed (direct connections)", decide({ origin: "https://localhost:3000", host: "localhost:3000", allowedOrigins: [] }).via === "request-host");
  check("D.2 case-insensitive host comparison", decide({ origin: "https://LOCALhost:3000", host: "localHOST:3000", allowedOrigins: [] }).ok);
  check("D.3 port mismatch is a different origin (localhost ≠ localhost:3000)", !decide({ origin: "https://localhost:3000", host: "localhost", allowedOrigins: [] }).ok);
  check("D.4 allow-list wins before the host check, host mismatch and all", decide({ origin: "https://preview-x.space-z.ai", host: "localhost:3000", allowedOrigins: [".space-z.ai"] }).ok);
}

// ---- D-bis. the built-in Z.ai preview-deployment trust (S38) ----
//
// The chat-bot preview deployment URL is preview-<uuid>.space-z.ai and
// operators cannot set TUBEFORGE_ALLOWED_ORIGINS on it. The built-in default
// in origin-trust.ts trusts that pattern unconditionally — without it, the
// deployed preview's first POST dies at the CSRF door before the z SDK is
// ever reached (the screenshot pinned this in S38).
{
  // The headline: a bare preview-<id>.space-z.ai origin passes with NO env.
  check("D-bis.1 chat-bot preview host passes with empty allow-list", decide({ origin: "https://preview-chat-d1f49856-ffa4-4152-bc31-67d7394dda19.space-z.ai", host: "vercel-app.internal", allowedOrigins: [] }).via === "builtin-preview");
  // The real screenshot URL — long slug, UUID-shaped id.
  check("D-bis.2 the actual screenshot URL passes", decide({ origin: "https://preview-chat-d1f49856-ffa4-4152-bc31-67d7394dda19.space-z.ai", allowedOrigins: [] }).ok);
  // Operator's explicit allow-list still wins (the suffix entry returns
  // "allow-suffix", NOT "builtin-preview" — stricter operator config is
  // never silently bypassed by the built-in default).
  check("D-bis.3 operator suffix allow-list wins, not the built-in default", decide({ origin: "https://preview-abc.space-z.ai", allowedOrigins: [".space-z.ai"] }).via === "allow-suffix");
  // Operator exact host wins too.
  check("D-bis.4 operator exact host wins over built-in default", decide({ origin: "https://preview-abc.space-z.ai", allowedOrigins: ["preview-abc.space-z.ai"] }).via === "allow-exact");
  // The pattern is tight — these all REJECT despite containing "space-z.ai":
  //   · the bare domain (no preview- prefix)
  check("D-bis.5 bare space-z.ai (no preview- prefix) is NOT auto-trusted", !decide({ origin: "https://space-z.ai", allowedOrigins: [] }).ok);
  //   · a different subdomain under space-z.ai
  check("D-bis.6 unrelated subdomain under space-z.ai is NOT auto-trusted", !decide({ origin: "https://studio.space-z.ai", allowedOrigins: [] }).ok);
  //   · a hyphen lookalike
  check("D-bis.7 hyphen lookalike (evil-preview-.space-z.ai) rejected", !decide({ origin: "https://evil-preview-x.space-z.ai", allowedOrigins: [] }).ok);
  //   · preview- prefix but wrong base domain
  check("D-bis.8 preview- prefix on a different base domain rejected", !decide({ origin: "https://preview-abc.evil.com", allowedOrigins: [] }).ok);
  //   · a deeper attacker host with the pattern as a suffix
  check("D-bis.9 deeper-attacker lookalike (preview-x.space-z.ai.evil) rejected", !decide({ origin: "https://preview-x.space-z.ai.evil", allowedOrigins: [] }).ok);
  //   · a deeper attacker host on a different base
  check("D-bis.10 deeper-attacker lookalike (preview-x.space-z.ai.attacker.com) rejected", !decide({ origin: "https://preview-x.space-z.ai.attacker.com", allowedOrigins: [] }).ok);
  // The built-in default is happy to coexist with X-Forwarded-Host trust —
  // when both could fire, the built-in default wins because it's earlier in
  // the precedence chain (X-Forwarded-Host is opt-in and heavier; we want
  // the lighter path to win when both are available).
  check("D-bis.11 built-in default beats X-Forwarded-Host when both fire", decide({ origin: "https://preview-abc.space-z.ai", host: "vercel-app.internal", forwardedHost: "preview-abc.space-z.ai", allowedOrigins: [], trustForwardedHost: true }).via === "builtin-preview");
  // And beats the Host fallback too (which is the Stage-2 default).
  check("D-bis.12 built-in default beats the Host fallback when both fire", decide({ origin: "https://preview-abc.space-z.ai", host: "preview-abc.space-z.ai", allowedOrigins: [] }).via === "builtin-preview");
  // Case-insensitive: the URL host is lowercased before the regex test.
  check("D-bis.13 case-insensitive preview host passes", decide({ origin: "https://PREVIEW-ABC.SPACE-Z.AI", allowedOrigins: [] }).ok);
  // Origin path doesn't affect host extraction.
  check("D-bis.14 preview host with a path passes (host-only comparison)", decide({ origin: "https://preview-abc.space-z.ai/some/deep/path", allowedOrigins: [] }).ok);
}

// ---- E. rejection hygiene ----
{
  check("E.1 garbage origin (no scheme) rejected without throwing", !decide({ origin: "not a url", host: "not a url", allowedOrigins: [] }).ok);
  check("E.2 empty everything → rejected", !decide({ origin: "", host: null, allowedOrigins: [] }).ok);
  check("E.3 the decision names the rejection path", decide({ origin: "https://evil.com", host: null, allowedOrigins: [] }).via === "rejected");
  check("E.4 origin with a path still compares by host", decide({ origin: "https://preview-x.space-z.ai/some/path", host: null, allowedOrigins: [".space-z.ai"] }).ok);
}

console.log(fail === 0 ? `S30 UNIT PROBE: ALL PASS (${pass} passed)` : `S30 UNIT PROBE: ${fail} FAILED of ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
