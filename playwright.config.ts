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
  },
});
