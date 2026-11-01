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

// Stage 4b premium-UX smoke (T-4.14) — pins the five new surfaces:
//
//   • Voice Studio renders the catalog and pronunciations roundtrip through
//     the real route (add via UI → GET, remove via UI → GET)
//   • Cast roster shows identity readiness and the studio shows "Cast in"
//   • the detail dialog's clone tab deep-links into the Voice Studio
//   • the Research workspace renders its scan rail and empty state
//
// Still no live AI calls — character creation and the pronunciation route are
// deterministic; the research toolbar and analytics niche block are verified
// in the live browser pass instead (they need seeded scan/stats data).
test.describe("Stage 4b premium UX", () => {
  test("voice studio: catalog renders and pronunciations roundtrip (T-4.10/T-4.11)", async ({ page, request }) => {
    const cookie = await register(request);
    await page.context().addCookies([
      { name: "tf_session", value: cookie.split("=")[1], url: "http://localhost:3000" },
    ]);
    await page.goto("/");
    await page.waitForSelector("nav[aria-label='Main navigation']");

    // The tenth surface: nav entry, page heading, catalog grid.
    await page.getByRole("navigation", { name: "Main navigation" }).getByText("Voice Studio").click();
    await expect(page.getByRole("heading", { name: "Voice Studio" })).toBeVisible();
    await expect(page.getByText("Narration voices", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Audition" }).first()).toBeVisible();

    // Pronunciation: add via the UI → persisted server-side.
    await page.getByPlaceholder("Word or phrase (e.g. colonel)").fill("colonel");
    await page.getByPlaceholder("Say it as (e.g. kernel)").fill("kernel");
    await page.getByRole("button", { name: /^Add$/ }).click();
    await expect(page.getByText("colonel", { exact: true })).toBeVisible();
    const saved = await request.get("/api/voices/pronunciations", { headers: { cookie } });
    const savedBody = (await saved.json()) as { entries: { from: string; to: string }[] };
    expect(savedBody.entries).toEqual([{ from: "colonel", to: "kernel" }]);

    // Remove via the chip × → the map is empty again.
    await page.getByRole("button", { name: "Remove colonel" }).click();
    await expect(page.getByText("colonel", { exact: true })).toBeHidden();
    const cleared = await request.get("/api/voices/pronunciations", { headers: { cookie } });
    const clearedBody = (await cleared.json()) as { entries: unknown[] };
    expect(clearedBody.entries).toEqual([]);
  });

  test("cast: roster readiness + the Cast-in section (T-4.9)", async ({ page, request }) => {
    const cookie = await register(request);
    await page.context().addCookies([
      { name: "tf_session", value: cookie.split("=")[1], url: "http://localhost:3000" },
    ]);

    // A character with a complete persona but no art (deterministic — no AI).
    const created = await request.post("/api/characters", {
      headers: { cookie },
      data: {
        name: "Professor Vex",
        role: "Skeptical science storyteller",
        personality: "Wry, curious, allergic to hype.",
        appearance: "Silver-haired, round glasses, dark cardigan.",
        voice: "jam",
        artStyle: "cinematic",
      },
    });
    expect(created.status()).toBe(201);

    await page.goto("/");
    await page.waitForSelector("nav[aria-label='Main navigation']");
    await page.getByRole("navigation", { name: "Main navigation" }).getByText("Cast").click();

    // Roster card + identity readiness chips (Bible done, art not yet).
    await expect(page.getByText("Professor Vex")).toBeVisible();
    await expect(page.getByText("Bible", { exact: true })).toBeVisible();
    await expect(page.getByText("0/3 poses")).toBeVisible();
    await expect(page.getByText("Portrait", { exact: true })).toBeVisible();

    // Open the studio → the Cast-in section explains itself while empty.
    await page.getByText("Professor Vex").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(page.getByText("Cast in")).toBeVisible();
    await expect(page.getByText(/assign this character in Create/)).toBeVisible();
  });

  test("detail dialog: clone tab deep-links to the Voice Studio (T-4.10)", async ({ page, request }) => {
    const cookie = await register(request);
    await page.context().addCookies([
      { name: "tf_session", value: cookie.split("=")[1], url: "http://localhost:3000" },
    ]);

    const classic = await request.post("/api/videos", {
      headers: { cookie },
      data: {
        topic: `Clone link probe ${RUN}`,
        format: "script",
        script: "A narration that exists so the dialog opens on the Package tab.",
        approved: true,
      },
    });
    expect(classic.status()).toBeLessThan(300);

    await page.goto("/");
    await page.waitForSelector("nav[aria-label='Main navigation']");
    await page.getByRole("navigation", { name: "Main navigation" }).getByText("Library").click();
    await page.getByText(`Clone link probe ${RUN}`).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // Package tab → voice panel → clone tab → the deep-link navigates.
    await page.getByRole("button", { name: /Change the voice/ }).click();
    await page.getByRole("button", { name: "Clone", exact: true }).click();
    await page.getByText("Manage & clone voices in the Voice Studio").click();
    await expect(page.getByRole("heading", { name: "Voice Studio" })).toBeVisible();
  });

  test("research: scan rail and empty state render (T-4.8)", async ({ page, request }) => {
    const cookie = await register(request);
    await page.context().addCookies([
      { name: "tf_session", value: cookie.split("=")[1], url: "http://localhost:3000" },
    ]);
    await page.goto("/");
    await page.waitForSelector("nav[aria-label='Main navigation']");

    await page.getByRole("navigation", { name: "Main navigation" }).getByText("Topic Radar").click();
    await expect(page.getByRole("heading", { name: "Topic Radar" })).toBeVisible();
    await expect(page.getByText("Scan a niche")).toBeVisible();
    await expect(page.getByText("Run Topic Radar")).toBeVisible();
    await expect(page.getByText("No scans yet")).toBeVisible();
    // The niche pulse rail renders only with sessions — a fresh account has
    // none, so the empty state (not the pulse) must show.
    await expect(page.getByText("Niche pulse")).toBeHidden();
  });
});
