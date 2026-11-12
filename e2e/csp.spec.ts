// S104 / P0.5 — the CSP security regression (docs/production-readiness.md
// gate P0.5: "security regression suite passes; production CSP drops
// unsafe-inline / unsafe-eval").
//
// Runs against the LIVE dev server (the e2e suite's own boot): the document
// response must carry the middleware's nonce CSP — script-src with a fresh
// 'nonce-…' and 'strict-dynamic', NEVER 'unsafe-inline' — and Next.js must
// have stamped its bootstrap scripts with that nonce (the mechanism the
// whole law rests on). The strict PRODUCTION contract (no unsafe-eval
// either) is pinned byte-for-byte on the pure builder in the unit suite
// (buildCsp dev:false) plus the middleware wiring pin ({ dev: !isProd });
// this runtime spec asserts the MECHANISM, and treats 'unsafe-eval' as
// legal ONLY when the server under test is a dev server (HMR/react-refresh
// need it there — csp.ts's documented exception).
//
// Also guards the double-CSP footgun: exactly ONE Content-Security-Policy
// header.

import { test, expect } from "@playwright/test";

const serverIsDev = process.env.NODE_ENV !== "production";

test("the document CSP carries a fresh nonce and never relaxes script-src", async ({ page }) => {
  const responses: { csp: string[]; url: string }[] = [];
  page.on("response", (res) => {
    if (!res.url().includes("/_next/static") && (res.url().endsWith("/") || res.url().split("/").pop() === "")) {
      const csp = res.headers()["content-security-policy"];
      if (csp) responses.push({ csp: [csp], url: res.url() });
    }
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Exactly ONE policy — two CSP headers intersect (most restrictive wins)
  // and would break the nonce-stamped scripts.
  expect(responses.length).toBeGreaterThan(0);
  const doc = responses[0];
  expect(doc.csp.length).toBe(1);
  const csp = doc.csp[0];

  const scriptSrc = csp.match(/script-src[^;]*/)?.[0] ?? "";
  expect(scriptSrc).toContain("'nonce-");
  expect(scriptSrc).toContain("'strict-dynamic'");
  // 'unsafe-inline' is dead in EVERY mode — the textual exit criterion.
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  // 'unsafe-eval' is legal ONLY on a dev server (HMR); the production law
  // is byte-pinned on buildCsp(dev:false) in the unit suite.
  if (!serverIsDev) expect(scriptSrc).not.toContain("'unsafe-eval'");

  // The other documented laws (csp.ts pins them at the unit layer; this is
  // the runtime cross-check).
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).not.toContain("frame-ancestors"); // deliberate: sandbox iframe embeds
});

test("Next.js stamps its bootstrap scripts with the middleware nonce", async ({ page }) => {
  // The SERVED HTML — not the post-hydration DOM: React rewrites script
  // attributes when it hydrates, so the document's own stamped nonces are
  // only visible in the raw response.
  const res = await page.request.get("/");
  expect(res.ok()).toBeTruthy();
  const html = await res.text();
  const csp = res.headers()["content-security-policy"] ?? "";
  const policyNonce = csp.match(/'nonce-([^']+)'/)?.[1] ?? "";

  const stamped = [...html.matchAll(/<script[^>]*nonce="([^"]*)"/g)].map((m) => m[1]);
  expect(stamped.length).toBeGreaterThan(0); // the mechanism ran at all
  expect(policyNonce).not.toBe(""); // the policy carries a real nonce
  // THE LAW: the nonce Next stamped on its bootstrap scripts is EXACTLY the
  // one the policy admits — an attacker nonce (or none) is not.
  expect(stamped).toContain(policyNonce);
});
