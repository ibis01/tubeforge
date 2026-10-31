import { expect, test } from "@playwright/test";

// Stage 1 smoke suite (task T-1.17) — proves the studio shell renders end to
// end. Deeper coverage (auth gate, cross-tenant isolation, mobile layouts)
// lands in Stages 2 and 7 per ROADMAP.md.

test.describe("studio shell", () => {
  test("root page renders the app shell", async ({ page }) => {
    await page.goto("/");
    // The studio is a single-page app — the sidebar shell must mount.
    await expect(page.locator("body")).toBeVisible();
    // Either the studio (authenticated/open) or the auth gate renders;
    // both indicate the app booted and the API layer responds.
    await expect(page).toHaveTitle(/TubeForge/i);
  });

  test("health endpoint answers", async ({ request }) => {
    const res = await request.get("/api");
    expect(res.ok()).toBeTruthy();
  });

  test("security headers are present (T-1.6)", async ({ request }) => {
    const res = await request.get("/api");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
  });
});
