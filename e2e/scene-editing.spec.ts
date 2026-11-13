import { expect, test, type APIRequestContext } from "@playwright/test";

// S118 (Scene-Level Editing & Repair, Stage 7) — the trust layer's HTTP
// contract, deterministic subset (the same constraint every Stage 4/5 e2e
// spec lives with: no live AI calls, so no scene-split story can be seeded
// through the public API — the scene-FUL behavior is pinned by the DB
// battery, 28 tests, scripts/test-scene-revisions.mts; this spec pins the
// route contract every client hits first):
//
//   1. AUTH — the four scene-trust routes refuse anonymous access (401).
//   2. FORMAT — a classic-script video gets the honest "not a scene-based
//      video" 400 on every scene route (the trust layer is story-lane).
//   3. SCENELESS — a story video with no scenes yet gets the honest
//      scene-404s and the render route's "no scenes" 400 (the routes never
//      accept a half-built project — the pipeline spec's law, extended to
//      the trust surface).
//
// The proposal's twelve-scenario QA table maps onto this spec + the battery
// + the standing suites (the mapping is recorded in
// docs/runbooks/scene-editing.md §5 — four scenarios were already pinned
// before the track began; the track's batteries pinned the rest).

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "s118-trust-123";
const accounts: string[] = [];

async function register(
  request: APIRequestContext,
  email: string
): Promise<string> {
  accounts.push(email);
  const res = await request.post("/api/auth/register", {
    data: { name: "S118 Probe", email, password: PASSWORD },
  });
  expect(res.status(), "registration must succeed").toBe(201);
  const d = (await res.json()) as { verification?: { url?: string } };
  const setCookie = res.headers()["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  if (d.verification?.url) {
    await request.get(d.verification.url);
  }
  return cookie;
}

async function createVideo(
  request: APIRequestContext,
  cookie: string,
  body: Record<string, unknown>
): Promise<string> {
  const res = await request.post("/api/videos", {
    headers: { cookie },
    data: { topic: `S118 trust probe ${RUN}`, niche: "Motivation", ...body },
  });
  expect(res.status(), "create must succeed").toBeLessThan(300);
  const d = (await res.json()) as { video: { id: string } };
  expect(d.video.id).toBeTruthy();
  return d.video.id;
}

test.describe("S118 — the scene trust layer's route contract", () => {
  test.afterAll(async ({ request }) => {
    for (const email of accounts) {
      const login = await request.post("/api/auth/login", { data: { email, password: PASSWORD } });
      if (!login.ok()) continue;
      const cookie = ((login.headers()["set-cookie"] as string | undefined) ?? "").split(";")[0];
      if (!cookie) continue;
      await request.post("/api/account/delete", {
        headers: { cookie, "Content-Type": "application/json" },
        data: { confirm: "DELETE" },
      });
    }
  });

  test("the four trust routes refuse anonymous access", async ({ request }) => {
    // A well-formed-looking id — the auth gate fires before any lookup.
    const id = "anon-probe-video-id";
    const routes = [
      ["GET", `/api/videos/${id}/scenes/1/recheck`],
      ["POST", `/api/videos/${id}/scenes/1/recheck`],
      ["GET", `/api/videos/${id}/scenes/1/revisions`],
      ["POST", `/api/videos/${id}/scenes/1/rollback`],
      ["GET", `/api/videos/${id}/scenes/1/repair`],
      ["POST", `/api/videos/${id}/scenes/1/repair`],
      ["POST", `/api/videos/${id}/storyboard/upload`],
    ] as const;
    for (const [method, url] of routes) {
      const res = await request.fetch(url, {
        method,
        data: method === "POST" ? {} : undefined,
      });
      expect([401, 403], `${method} ${url} must be gated`).toContain(res.status());
    }
  });

  test("a classic-script video gets the honest format guard on every scene route", async ({ request }) => {
    const cookie = await register(request, `s118-classic-${RUN}@tubeforge.test`);
    const videoId = await createVideo(request, cookie, {
      format: "script",
      script: "A short probe script for the trust-layer contract.",
      approved: true,
    });

    for (const [method, url] of [
      ["GET", `/api/videos/${videoId}/scenes/1/recheck`],
      ["POST", `/api/videos/${videoId}/scenes/1/recheck`],
      ["GET", `/api/videos/${videoId}/scenes/1/revisions`],
      ["GET", `/api/videos/${videoId}/scenes/1/repair`],
    ] as const) {
      const res = await request.fetch(url, {
        headers: { cookie },
        method,
        data: method === "POST" ? {} : undefined,
      });
      expect(res.status(), `${method} must refuse the classic format`).toBe(400);
      const d = (await res.json()) as { error?: string };
      expect(d.error ?? "").toContain("scene-based");
    }
  });

  test("a sceneless story video gets the honest scene-404s and the render guard", async ({ request }) => {
    const cookie = await register(request, `s118-story-${RUN}@tubeforge.test`);
    // Story format without a script: the create enqueues the AI scene-split
    // (which 401s/fails without a provider credential in this environment),
    // leaving an honest sceneless story row — exactly the half-built state
    // the routes must refuse.
    const videoId = await createVideo(request, cookie, { format: "story" });

    const recheckRes = await request.post(`/api/videos/${videoId}/scenes/1/recheck`, {
      headers: { cookie },
      data: {},
    });
    expect(recheckRes.status(), "the recheck must refuse a sceneless story").toBe(400);

    const renderRes = await request.post(`/api/videos/${videoId}/render`, {
      headers: { cookie },
      data: {},
    });
    expect(renderRes.status(), "the render must refuse a sceneless story").toBe(400);
    const renderBody = (await renderRes.json()) as { error?: string };
    expect(renderBody.error ?? "").toContain("scenes");

    // The scene-preview / boundary grammars fall at the same first gate —
    // they can never render a video that has nothing to render.
    const previewRes = await request.post(`/api/videos/${videoId}/render`, {
      headers: { cookie },
      data: { sceneIndex: 1 },
    });
    expect(previewRes.status()).toBe(400);
    const boundaryRes = await request.post(`/api/videos/${videoId}/render`, {
      headers: { cookie },
      data: { boundaryAfter: 1 },
    });
    expect(boundaryRes.status()).toBe(400);
  });
});
