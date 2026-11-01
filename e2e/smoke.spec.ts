import { expect, test } from "@playwright/test";

// Stage 2 smoke suite — the studio shell renders end to end under the new
// default-deny auth model (ARCHITECTURE §6.3): every /api route answers 401
// without a session, /api/auth/status stays public for the gate, and the
// security headers from Stage 1 are still present.

test.describe("studio shell", () => {
  test("root page renders the app shell", async ({ page }) => {
    await page.goto("/");
    // The studio is a single-page app — the sidebar shell or the account
    // gate must mount; both indicate the app booted.
    await expect(page.locator("body")).toBeVisible();
    await expect(page).toHaveTitle(/TubeForge/i);
  });

  test("default-deny: /api refuses unauthenticated callers (Stage 2)", async ({ request }) => {
    const res = await request.get("/api");
    expect(res.status()).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/Authentication required/i);
  });

  test("auth status endpoint is public", async ({ request }) => {
    const res = await request.get("/api/auth/status");
    expect(res.ok()).toBeTruthy();
    const d = (await res.json()) as { configured?: boolean; authenticated?: boolean };
    expect(d.authenticated).toBe(false); // fresh request context, no cookie
  });

  test("security headers are present (T-1.6)", async ({ request }) => {
    const res = await request.get("/api/auth/status");
    expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    expect(res.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(res.headers()["content-security-policy"]).toContain("default-src 'self'");
  });
});
