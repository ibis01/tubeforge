import type { NextConfig } from "next";

// Security headers (Stage 1, task T-1.6 in TASKS.md).
//
// Deliberate omissions, revisited in Stage 4a once the production origin is
// fixed:
//   - X-Frame-Options / CSP frame-ancestors: the studio is previewed inside
//     cross-origin sandbox iframes; a blanket DENY would break those embeds.
//   - COEP require-corp: would break any cross-origin subresource lacking
//     CORP headers (risky until the media pipeline is fully CDN-backed).
//
// S104 / P0.5 — the CSP moved OUT of this file: a static header cannot carry
// a per-request nonce, so middleware now owns the policy entirely
// (src/middleware.ts + csp.ts — production script-src is 'self' 'nonce-…'
// 'strict-dynamic', NO unsafe-inline, NO unsafe-eval; style-src keeps its
// documented unsafe-inline exception). A static CSP here would ALSO apply
// (browsers intersect multiple policies = most restrictive wins) and break
// the nonce-stamped scripts. These headers keep applying to every route
// including the static assets the middleware matcher skips.

const securityHeaders = [
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
  // S105 addendum — the Docker production smoke caught the first real
  // deployment bug the gate exists for: `output: "standalone"` traces files
  // through nft, and the Prisma QUERY ENGINE binary
  // (node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node)
  // is loaded via a dynamic path the tracer misses — the standalone server
  // died at boot with "Prisma Client could not locate the Query Engine".
  // Trace the whole generated-client directory (engine + schema copy) into
  // every bundle; a few MB, and every standalone deployment carries the
  // engine its platform's generate produced.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/.prisma/client/**", "./node_modules/@prisma/client/**"],
  },
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
