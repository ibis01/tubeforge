import { defineConfig, devices } from "@playwright/test";

// Stage 1 (task T-1.17): Playwright was already a runtime dependency (the
// keynote-slides renderer needs Chromium), but no test harness existed. This
// wires a minimal browser smoke suite; Stage 7 grows it into the full
// cross-tenant isolation + mobile responsiveness battery.
//
// Run: npm run test:e2e   (starts its own dev server on :3000)

export default defineConfig({
  testDir: "./e2e",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: process.env.BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // S68 — the suite is one IP making a studio-load of writes (register +
    // create + PUT + render across 27 tests in under two minutes), which
    // brushes the middleware's per-IP WRITE_LIMIT (90/min) — whichever spec
    // crosses a window boundary ate a 429 (the flake the first full-suite
    // runs showed, alternating victims by file order). The harness is a
    // trusted single-tenant load, so its OWN server raises the ceilings;
    // production defaults are untouched.
    env: {
      ...process.env,
      TUBEFORGE_RATE_WRITE: "10000",
      TUBEFORGE_RATE_READ: "100000",
    },
  },
});
