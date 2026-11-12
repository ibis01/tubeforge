// S104 / P0.5 — the Content-Security-Policy law (docs/production-readiness.md,
// gate P0.5: "production CSP drops unsafe-inline / unsafe-eval").
//
// The old policy (next.config.ts, Stage 1) shipped
// `script-src 'self' 'unsafe-inline' 'unsafe-eval'` — both holes the audit
// named. A static next.config header cannot carry a per-request nonce, so
// the policy moved into middleware (see src/middleware.ts): every request
// gets a FRESH nonce, the CSP is set on the REQUEST headers (Next.js reads
// it there and stamps its own bootstrap scripts with the nonce — the
// documented mechanism) and on the response.
//
// The law, directive by directive:
//   script-src  'self' 'nonce-…' 'strict-dynamic'   — production. NO
//               unsafe-inline (dead under strict-dynamic anyway, but it is
//               not even present: the exit criterion is textual), NO
//               unsafe-eval. 'strict-dynamic' lets nonce-stamped bootstrap
//               scripts load the framework's own chunks while an XSS
//               payload gains nothing.
//   dev adds 'unsafe-eval' — react-refresh/HMR needs it; never unsafe-inline.
//   style-src   'self' 'unsafe-inline'              — the one documented
//               exception: React's style={} attributes and Next's injected
//               <style> elements cannot carry nonces without breaking every
//               styled component. Style injection is an XSS nuisance, not a
//               script-execution primitive (no JS runs).
//   img-src     'self' data: blob: https:           — AI images arrive as
//               data:/blob:/remote URLs (unchanged from Stage 1).
//   media-src   'self' blob: https:                 — video/audio playback.
//   connect-src 'self' https:                        — fetch/XHR/websocket.
//   font-src    'self' data:  ·  worker-src 'self' blob:  ·  manifest-src 'self'
//   object-src  'none' · base-uri 'self' · form-action 'self'
//   frame-ancestors  — DELIBERATELY ABSENT: the studio is previewed inside
//               cross-origin sandbox iframes; a blanket deny breaks those
//               embeds (the Stage-1 decision stands; X-Frame-Options is
//               likewise omitted). Pinned so nobody "fixes" it blind.
//
// PURE — no imports, no clock, no runtime: the header string is fully
// deterministic for a given nonce, so the security regression suite can pin
// the exact contract byte-for-byte.

export function buildCsp(nonce: string, opts: { dev?: boolean } = {}): string {
  const dev = opts.dev ?? process.env.NODE_ENV !== "production";
  const scriptSrc = dev
    ? `'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-eval'` // HMR/react-refresh need eval; inline stays dead
    : `'self' 'nonce-${nonce}' 'strict-dynamic'`;
  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // The documented exception (see the header): style attributes + injected
    // <style> elements cannot carry nonces without breaking every component.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
