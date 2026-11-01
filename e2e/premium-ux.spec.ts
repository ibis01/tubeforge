import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Stage 4a premium-UX smoke (T-4.7) — pins the new interaction surfaces:
//
//   • ⌘K command palette opens, filters, and navigates
//   • the Create guided brief advances step-by-step with gating + draft save
//   • the classic Script tab autosaves edits through PATCH /api/videos/[id]
//
// Registers fresh accounts (same pattern as isolation.spec.ts). No live AI
// calls — the classic editor probe uses the synchronous custom-script path.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "premium-ux-123";
let seq = 0;

async function register(request: APIRequestContext): Promise<string> {
  seq += 1;
  const email = `ux-${RUN}-${seq}@tubeforge.test`;
  const res = await request.post("/api/auth/register", {
    data: { name: "UX Probe", email, password: PASSWORD },
  });
  expect(res.status()).toBe(201);
  const d = (await res.json()) as { verification?: { url?: string } };
  if (d.verification?.url) await request.get(d.verification.url);
  const setCookie = res.headers()["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  expect(cookie.startsWith("tf_session=")).toBe(true);
  return cookie;
}

test.describe("Stage 4a premium UX", () => {
  test("⌘K palette: open, filter, navigate (T-4.1)", async ({ page }) => {
    const cookie = await register(page.request as unknown as APIRequestContext);
    await page.context().addCookies([
      { name: "tf_session", value: cookie.split("=")[1], url: "http://localhost:3000" },
    ]);
    await page.goto("/");
    await page.waitForSelector("nav[aria-label='Main navigation']");

    // Palette opens on mod+K…
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
    // …filters by keyword…
    await page.getByLabel("Command palette search").fill("library");
    await expect(page.getByRole("button", { name: /Library Video queue/ })).toBeVisible();
    // …and Enter navigates.
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Video Library" })).toBeVisible();
  });

  test("guided brief: steps gate and the draft survives a reload (T-4.3)", async ({ page }) => {
    const cookie = await register(page.request as unknown as APIRequestContext);
    await page.context().addCookies([
      { name: "tf_session", value: cookie.split("=")[1], url: "http://localhost:3000" },
    ]);
    await page.goto("/");
    await page.waitForSelector("nav[aria-label='Main navigation']");
    await page.getByRole("navigation", { name: "Main navigation" }).getByText("Create").click();

    // Step 1: Next is disabled until a topic exists.
    const next = page.getByRole("button", { name: /Next: Format/ });
    await expect(next).toBeDisabled();
    await page.getByLabel("Video topic").fill("The secret economy of container ships");
    await expect(next).toBeEnabled();
    await next.click();

    // Step rail shows progress; the draft lands in localStorage.
    await expect(page.getByText("step 2 of 4")).toBeVisible();
    await page.waitForTimeout(1200); // debounce (700ms) + margin
    const draft = await page.evaluate(() => localStorage.getItem("tubeforge:create-draft"));
    expect(draft).toContain("container ships");

    // Reload + return to Create → banner + topic restored.
    await page.reload();
    await page.waitForSelector("nav[aria-label='Main navigation']");
    await page.getByRole("navigation", { name: "Main navigation" }).getByText("Create").click();
    await expect(page.getByText("Brief draft restored from your last visit.")).toBeVisible();
    await expect(page.getByLabel("Video topic")).toHaveValue(/container ships/);
  });

  test("script tab: classic editor autosaves through PATCH (T-4.4)", async ({ page, request }) => {
    const cookie = await register(request);
    await page.context().addCookies([
      { name: "tf_session", value: cookie.split("=")[1], url: "http://localhost:3000" },
    ]);

    // Classic-format video with a custom script (synchronous, no AI calls).
    const classic = await request.post("/api/videos", {
      headers: { cookie },
      data: {
        topic: `Classic probe ${RUN}`,
        format: "script",
        script: "Original narration. It exists so the editor has text to change.",
        approved: true,
      },
    });
    expect(classic.status()).toBeLessThan(300);
    const classicBody = (await classic.json()) as { video: { id: string } };
    const classicVideoId = classicBody.video.id;

    // Open the video's detail dialog through the Library.
    await page.goto("/");
    await page.waitForSelector("nav[aria-label='Main navigation']");
    await page.getByRole("navigation", { name: "Main navigation" }).getByText("Library").click();
    await page.getByText(`Classic probe ${RUN}`).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Classic format has Package + Script tabs.
    await page.getByRole("tab", { name: "Script" }).click();
    const editor = page.getByLabel("Script editor");
    await expect(editor).toHaveValue(/Original narration/);

    // Edit + autosave (1s debounce) → the text persists server-side.
    await editor.fill("Edited narration. The autosave path proves the Script tab writes through.");
    await page.waitForTimeout(2200);
    const after = await request.get(`/api/videos/${classicVideoId}`, { headers: { cookie } });
    const afterBody = (await after.json()) as { video: { script: string } };
    expect(afterBody.video.script).toContain("Edited narration");
  });
});
