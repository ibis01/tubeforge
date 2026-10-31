import type { NextConfig } from "next";

// Security headers (Stage 1, task T-1.6 in TASKS.md).
//
// Deliberate omissions, revisited in Stage 4a once the production origin is
// fixed:
//   - X-Frame-Options / CSP frame-ancestors: the studio is previewed inside
//     cross-origin sandbox iframes; a blanket DENY would break those embeds.
//   - COEP require-corp: would break any cross-origin subresource lacking
//     CORP headers (risky until the media pipeline is fully CDN-backed).
// CSP keeps 'unsafe-inline'/'unsafe-eval' — Next 16 needs both for its inline
// bootstrap and dev overlay; Stage 4a tightens this with nonces.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
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

const securityHeaders = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
  // HSTS is a no-op over plain http (localhost/previews) and enforced once TLS
  // terminates in front of the standalone server.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const nextConfig: NextConfig = {
  output: "standalone",
  // Strict TypeScript is enforced: `npm run typecheck` and the build both fail
  // on compiler errors. (ignoreBuildErrors was removed 2025-10 per the security
  // audit — all previously-suppressed errors were fixed at the source.)
  reactStrictMode: true,
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
