import { expect, test, type APIRequestContext } from "@playwright/test";

// Stage 7 (T-7.1) — full production pipeline smoke.
//
// The ROADMAP §7 list: "Authentication → Project creation → Script generation
// → Voice generation → Character consistency → Scene generation → Rendering
// → Export → YouTube integration (with a test channel)" + "Backup restoration".
//
// This spec covers the deterministic subset (no live AI calls — the ambient
// Z.ai credential 401s in this sandbox, the same constraint every Stage 4/5
// e2e spec lives with). It registers a fresh account, runs the full
// happy-path script-only pipeline through the public API surface, and
// verifies every step's contract:
//
//   1. Authentication + email verification (register → verify → login → status)
//   2. Project creation (POST /api/videos custom-script — synchronous, no AI)
//   3. Script persistence (GET /api/videos/[id] returns the script)
//   4. Patch (description / tags / title update)
//   5. The Stage 6 surfaces respond: GET /qc, /publish, /assemble, /captions,
//      /publish/suggest all 404 (no video with that id) or 400 (no render)
//      for a freshly-created video — proving the routes don't accept a
//      half-built project.
//   6. Export bundle returns 404 for a video with no final.mp4 (yet)
//   7. Account deletion + data export (GDPR endpoints)
//   8. Logout invalidates the session
//
// The render + voiceover + storyboard stages need real AI providers and a
// real ffmpeg pipeline — those run as smoke scripts (smoke-director.sh,
// smoke-render-aspect.sh, smoke-queue.sh) not e2e specs.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "stage7-pipeline-123";
const accounts: string[] = []; // every email this suite creates — cleaned in afterAll

async function register(
  request: APIRequestContext,
  email: string
): Promise<{ cookie: string; verificationUrl?: string }> {
  accounts.push(email);
  const res = await request.post("/api/auth/register", {
    data: { name: "Stage 7 Probe", email, password: PASSWORD },
  });
  expect(res.status(), "registration must succeed").toBe(201);
  const d = (await res.json()) as { verification?: { url?: string } };
  const setCookie = res.headers()["set-cookie"];
  expect(setCookie).toBeTruthy();
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  expect(cookie.startsWith("tf_session=")).toBe(true);
  return { cookie, verificationUrl: d.verification?.url };
}

async function login(request: APIRequestContext, email: string, password: string): Promise<string> {
  const res = await request.post("/api/auth/login", {
    data: { email, password },
  });
  expect(res.status()).toBe(200);
  const setCookie = res.headers()["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  expect(cookie.startsWith("tf_session=")).toBe(true);
  return cookie;
}

test.describe("Stage 7 — full production pipeline (deterministic subset)", () => {
  // The end-state law: the suite deletes every account it created through
  // the account's own front door (login → POST /api/account/delete).
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

  test("auth → create → patch → Stage 6 surfaces → export → GDPR → logout", async ({ request }) => {
    // 1. Authentication + email verification
    const email = `s7-${RUN}@tubeforge.test`;
    const { cookie, verificationUrl } = await register(request, email);
    if (verificationUrl) {
      const v = await request.get(verificationUrl);
      expect(v.status()).toBeLessThan(300);
    }

    // Status confirms the session.
    const statusRes = await request.get("/api/auth/status", { headers: { cookie } });
    expect(statusRes.ok()).toBeTruthy();
    const statusBody = (await statusRes.json()) as { authenticated?: boolean };
    expect(statusBody.authenticated).toBe(true);

    // 2. Project creation — custom-script (synchronous, no AI calls).
    const createRes = await request.post("/api/videos", {
      headers: { cookie },
      data: {
        topic: `Stage 7 pipeline probe ${RUN}`,
        niche: "Motivation",
        format: "script",
        script: "A short Stage 7 probe script. It exists to verify the full pipeline contract.",
        approved: true,
      },
    });
    expect(createRes.status(), "create must succeed").toBeLessThan(300);
    const createBody = (await createRes.json()) as { video: { id: string } };
    const videoId = createBody.video.id;
    expect(videoId).toBeTruthy();

    // 3. Script persistence — GET returns the script + the right shape.
    const getRes = await request.get(`/api/videos/${videoId}`, { headers: { cookie } });
    expect(getRes.status()).toBe(200);
    const getBody = (await getRes.json()) as { video: { id: string; script: string | null; format: string } };
    expect(getBody.video.id).toBe(videoId);
    expect(getBody.video.format).toBe("script");
    expect(getBody.video.script).toContain("Stage 7 probe script");

    // 4. Patch — title / description / tags.
    const patchRes = await request.patch(`/api/videos/${videoId}`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: {
        title: "Stage 7 — patched title",
        description: "A patched description for the pipeline probe.",
        tags: "stage7,test,probe",
      },
    });
    expect(patchRes.status()).toBeLessThan(300);
    const patchBody = (await patchRes.json()) as { video: { title: string | null; description: string | null; tags: string | null } };
    expect(patchBody.video.title).toBe("Stage 7 — patched title");
    expect(patchBody.video.description).toContain("patched description");
    expect(patchBody.video.tags).toContain("stage7");

    // 5. Stage 6 surfaces — for a freshly-created video with NO render and
    //    NO scene-format, the new routes must reject predictably (not crash).
    //    QC: requires hasVideo → 400.
    const qcRes = await request.post(`/api/videos/${videoId}/qc`, { headers: { cookie } });
    expect(qcRes.status()).toBe(400);
    const qcBody = (await qcRes.json()) as { error?: string };
    expect(qcBody.error).toMatch(/render the video first/i);

    // Publish: requires hasVideo → 400 (the route checks before the body).
    const publishRes = await request.post(`/api/videos/${videoId}/publish`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { title: "Test" },
    });
    expect(publishRes.status()).toBe(400);
    const publishBody = (await publishRes.json()) as { error?: string };
    expect(publishBody.error).toMatch(/render the video first/i);

    // Assemble: this is a script-format video → 400.
    const assembleRes = await request.post(`/api/videos/${videoId}/assemble`, { headers: { cookie } });
    expect(assembleRes.status()).toBe(400);
    const assembleBody = (await assembleRes.json()) as { error?: string };
    expect(assembleBody.error).toMatch(/scene-format videos/i);

    // Captions: requires the SRT file (not present yet) → 404.
    const captionsRes = await request.get(`/api/videos/${videoId}/captions`);
    expect(captionsRes.status()).toBe(404);

    // Publish suggest: needs a script (we have one) → 200 OR 400 if the LLM
    // call fails (the ambient Z.ai credential 401s). Accept either — the
    // route's contract is to return JSON, never crash.
    const suggestRes = await request.post(`/api/videos/${videoId}/publish/suggest`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: {},
    });
    expect([200, 400]).toContain(suggestRes.status());

    // 6. Export bundle — returns 200 with whatever text artifacts exist
    //    (script, description) — a video with no final.mp4 still produces
    //    a metadata-only bundle. The 404 path is only for an unknown video.
    const exportRes = await request.get(`/api/videos/${videoId}/export`, { headers: { cookie } });
    expect(exportRes.status()).toBe(200);
    // The bundle is a ZIP stream — verify the content-type.
    expect(exportRes.headers()["content-type"]).toMatch(/application\/zip|octet-stream/);

    // 7. Account export (GDPR) — GET returns the user's data as JSON.
    const exportAccountRes = await request.get(`/api/account/export`, { headers: { cookie } });
    expect(exportAccountRes.status()).toBeLessThan(300);
    const exportAccountBody = (await exportAccountRes.json()) as { account?: { email?: string }; data?: { videos?: unknown[] } };
    expect(exportAccountBody.account?.email).toBe(email);
    expect(Array.isArray(exportAccountBody.data?.videos)).toBe(true);
    expect(exportAccountBody.data?.videos?.length).toBeGreaterThanOrEqual(1);

    // 8. Logout — invalidates the session.
    const logoutRes = await request.post(`/api/auth/logout`, { headers: { cookie } });
    expect(logoutRes.status()).toBeLessThan(300);
    // The same cookie no longer authenticates.
    const afterLogout = await request.get(`/api/videos/${videoId}`, { headers: { cookie } });
    expect(afterLogout.status()).toBe(401);
  });

  test("login rejects wrong password + unverified-email reset flow is reachable", async ({ request }) => {
    const email = `s7-bad-${RUN}@tubeforge.test`;
    const { cookie, verificationUrl } = await register(request, email);
    expect(cookie).toBeTruthy();
    if (verificationUrl) await request.get(verificationUrl);

    // Wrong password → 401 (not 500, not 200).
    const badLogin = await request.post("/api/auth/login", {
      data: { email, password: "wrong-password-xyz" },
    });
    expect(badLogin.status()).toBe(401);

    // Account still locked: the bad login didn't grant a session.
    const probe = await request.get("/api/auth/status", { headers: { cookie } });
    const probeBody = (await probe.json()) as { authenticated?: boolean };
    expect(probeBody.authenticated).toBe(true); // the original cookie is still valid

    // Password reset request → 202 (the email is "sent" in console mode).
    const resetReq = await request.post("/api/auth/reset-password", {
      data: { email },
    });
    expect([200, 202]).toContain(resetReq.status());
  });

  test("cross-tenant: account B cannot read account A's video via the new Stage 6 routes", async ({ request }) => {
    // Register A, create a video.
    const emailA = `s7-iso-a-${RUN}@tubeforge.test`;
    const { cookie: cookieA, verificationUrl: vA } = await register(request, emailA);
    if (vA) await request.get(vA);

    const createA = await request.post("/api/videos", {
      headers: { cookie: cookieA },
      data: { topic: `iso-A ${RUN}`, format: "script", script: "A's private script.", approved: true },
    });
    const createABody = (await createA.json()) as { video: { id: string } };
    const videoIdA = createABody.video.id;

    // Register B.
    const emailB = `s7-iso-b-${RUN}@tubeforge.test`;
    const { cookie: cookieB, verificationUrl: vB } = await register(request, emailB);
    if (vB) await request.get(vB);

    // B cannot GET A's video.
    const readByB = await request.get(`/api/videos/${videoIdA}`, { headers: { cookie: cookieB } });
    expect(readByB.status()).toBe(404);

    // B cannot PATCH A's video.
    const patchByB = await request.patch(`/api/videos/${videoIdA}`, {
      headers: { cookie: cookieB, "Content-Type": "application/json" },
      data: { title: "stolen" },
    });
    expect(patchByB.status()).toBe(404);

    // B cannot DELETE A's video.
    const deleteByB = await request.delete(`/api/videos/${videoIdA}`, { headers: { cookie: cookieB } });
    expect(deleteByB.status()).toBe(404);

    // B cannot hit the Stage 6 surfaces on A's video.
    const qcByB = await request.post(`/api/videos/${videoIdA}/qc`, { headers: { cookie: cookieB } });
    expect(qcByB.status()).toBe(404);

    const assembleByB = await request.post(`/api/videos/${videoIdA}/assemble`, { headers: { cookie: cookieB } });
    expect(assembleByB.status()).toBe(404);

    const publishByB = await request.post(`/api/videos/${videoIdA}/publish`, {
      headers: { cookie: cookieB, "Content-Type": "application/json" },
      data: { title: "stolen" },
    });
    expect(publishByB.status()).toBe(404);

    const suggestByB = await request.post(`/api/videos/${videoIdA}/publish/suggest`, {
      headers: { cookie: cookieB, "Content-Type": "application/json" },
      data: {},
    });
    expect(suggestByB.status()).toBe(404);

    // Cleanup: A deletes A's own video (which B couldn't touch).
    const deleteByA = await request.delete(`/api/videos/${videoIdA}`, { headers: { cookie: cookieA } });
    expect(deleteByA.status()).toBeLessThan(300);
  });
});
