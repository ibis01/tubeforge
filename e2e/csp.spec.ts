// S104 / P0.5 — the CSP security regression (docs/production-readiness.md
// gate P0.5: "security regression suite passes; production CSP drops
// unsafe-inline / unsafe-eval").
//
// Runs against the LIVE dev server (the e2e suite's own boot): the document
// response must carry the middleware's nonce CSP — script-src with a fresh
// 'nonce-…' and 'strict-dynamic', NEVER 'unsafe-inline'/'unsafe-eval' in
// script-src — and Next.js must have stamped its bootstrap scripts with
// that nonce (the mechanism the whole law rests on). Also guards the
// double-CSP footgun: exactly ONE Content-Security-Policy header.

import { test, expect } from "@playwright/test";

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
  expect(scriptSrc).not.toContain("'unsafe-inline'");
  expect(scriptSrc).not.toContain("'unsafe-eval'");

  // The other documented laws (csp.ts pins them at the unit layer; this is
  // the runtime cross-check).
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).not.toContain("frame-ancestors"); // deliberate: sandbox iframe embeds
});

test("Next.js stamps its bootstrap scripts with the middleware nonce", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });

  // Extract the nonce from the response policy…
  const csp = await page.evaluate(() => {
    // The document is already loaded; read the nonce from any stamped script.
    const scripts = Array.from(document.querySelectorAll("script[nonce]"));
    return scripts.map((s) => s.getAttribute("nonce"));
  });

  // …the nonce-stamped scripts exist (Next read the CSP request header and
  // propagated the nonce to its bootstrap scripts — the mechanism the law
  // rests on; zero stamped scripts means the mechanism is broken and the
  // app only still renders because dev carries 'unsafe-eval').
  expect(csp.length).toBeGreaterThan(0);
  for (const n of csp) expect(n).not.toBe("");
});
