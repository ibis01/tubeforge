import { expect, test, type APIRequestContext } from "@playwright/test";

// S68 — the Whiteboard Studio end-to-end (the authenticated workflow the
// audit's next-milestone list asked for). Drives the REAL product surface
// through its API contract, on the dev server the playwright config boots:
//
//   auth → story video in whiteboard mode → the doc workflow (GET / PUT /
//   rev conflict / verbatim validation errors) → the scaffold's honest
//   no-scenes gate → a REAL scene-preview render through the in-process
//   claim loop (chromium 720p + ffmpeg → whiteboard/preview-<id>.mp4,
//   hasPreview) → the cross-mode refusal for a classic video.
//
// The story format's AI scene-splitting needs the generation gateway, so the
// scaffold-from-story path stays covered by the unit suite (the planner's
// determinism/rule-table/wall contracts) + the sandbox proofs; here the doc
// is hand-authored through the same validated PUT any editor save uses —
// the exact contract Phase B's Studio writes.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "s68-whiteboard-123";
const accounts: string[] = [];

async function register(
  request: APIRequestContext,
  email: string
): Promise<{ cookie: string; verificationUrl?: string }> {
  accounts.push(email);
  const res = await request.post("/api/auth/register", {
    data: { name: "S68 Probe", email, password: PASSWORD },
  });
  expect(res.status(), "registration must succeed").toBe(201);
  const d = (await res.json()) as { verification?: { url?: string } };
  const setCookie = res.headers()["set-cookie"];
  expect(setCookie).toBeTruthy();
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  expect(cookie.startsWith("tf_session=")).toBe(true);
  return { cookie, verificationUrl: d.verification?.url };
}

// A minimal validator-clean project: two scenes, library assets placed,
// EMPTY animation lists (the engine's fill law schedules the draws), default
// camera keys. Exactly what a Phase B save looks like for a fresh board.
function handAuthoredProject(title: string) {
  return {
    title,
    width: 1920,
    height: 1080,
    fps: 24,
    hand: { style: "marker", scale: 1 },
    scenes: [
      {
        id: "scene-1",
        narration: "A short preview beat for the render probe.",
        background: "#ffffff",
        placements: [
          { assetId: "spark", placement: { x: 760, y: 360, scale: 2, rotateDeg: 0 }, order: 0 },
        ],
        animations: [],
        camera: [{ cx: 960, cy: 540, scale: 1, startMs: 0, durationMs: 0 }],
      },
      {
        id: "scene-2",
        narration: "The second beat closes the probe.",
        background: "#f8f5ee",
        placements: [
          { assetId: "heart-main", placement: { x: 800, y: 340, scale: 2, rotateDeg: 0 }, order: 0 },
        ],
        animations: [],
        camera: [{ cx: 960, cy: 540, scale: 1, startMs: 0, durationMs: 0 }],
      },
    ],
  };
}

test.describe("S68 — whiteboard studio end-to-end", () => {
  test.afterAll(async ({ request }) => {
    // The end-state law: every account this suite created is deleted through
    // the account's own front door.
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

  test("auth → whiteboard doc workflow → real scene-preview render", async ({ request }) => {
    const email = `s68-${RUN}@tubeforge.test`;
    const { cookie, verificationUrl } = await register(request, email);
    if (verificationUrl) {
      const v = await request.get(verificationUrl);
      expect(v.status()).toBeLessThan(300);
    }

    // 1. Story video created DIRECTLY in whiteboard mode (the create-route
    //    law: whiteboard needs format story — honored at the front door).
    const createRes = await request.post("/api/videos", {
      headers: { cookie },
      data: {
        topic: `S68 whiteboard probe ${RUN}`,
        niche: "Motivation",
        format: "story",
        renderMode: "whiteboard",
      },
    });
    expect(createRes.status(), "create must succeed").toBeLessThan(300);
    const videoId = ((await createRes.json()) as { video: { id: string } }).video.id;
    expect(videoId).toBeTruthy();

    // 2. GET — no doc yet, but the editor palette + budgets + voMs surface.
    const get1 = await request.get(`/api/videos/${videoId}/whiteboard`, { headers: { cookie } });
    expect(get1.status()).toBe(200);
    const d1 = (await get1.json()) as {
      project: unknown;
      rev: number;
      library: { id: string }[];
      voMs: Record<string, number>;
      budgets: Record<string, number>;
    };
    expect(d1.project).toBeNull();
    expect(d1.rev).toBe(0);
    expect(d1.library.length).toBeGreaterThanOrEqual(18);
    expect(d1.budgets.scenesPerProject).toBeGreaterThan(0);
    expect(d1.voMs).toEqual({});

    // 3. The scaffold's honest gate: story scenes need the AI script job
    //    (unavailable in e2e), so the native planner refuses READABLY.
    const scaffoldRes = await request.post(`/api/videos/${videoId}/whiteboard/scaffold`, {
      headers: { cookie },
      data: {},
    });
    expect(scaffoldRes.status()).toBe(400);
    expect(((await scaffoldRes.json()) as { error?: string }).error).toMatch(/no scenes/i);

    // 4. PUT — the hand-authored board lands as rev 1.
    const put1 = await request.put(`/api/videos/${videoId}/whiteboard`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { project: handAuthoredProject("S68 probe") },
    });
    expect(put1.status()).toBeLessThan(300);
    const p1 = (await put1.json()) as { rev: number };
    expect(p1.rev).toBe(1);

    // 5. GET round-trips the doc.
    const get2 = await request.get(`/api/videos/${videoId}/whiteboard`, { headers: { cookie } });
    const d2 = (await get2.json()) as { project: { title: string; scenes: { id: string }[] }; rev: number };
    expect(d2.rev).toBe(1);
    expect(d2.project?.title).toBe("S68 probe");
    expect(d2.project?.scenes.map((s) => s.id)).toEqual(["scene-1", "scene-2"]);

    // 6. Stale rev → 409 WITH the server's current doc (the advisory lock).
    const putStale = await request.put(`/api/videos/${videoId}/whiteboard`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { project: handAuthoredProject("Stale save"), rev: 0 },
    });
    expect(putStale.status()).toBe(409);
    const staleBody = (await putStale.json()) as { current?: { rev: number } };
    expect(staleBody.current?.rev).toBe(1);

    // 7. An unknown asset → 400 with the validator's verbatim error.
    const bad = handAuthoredProject("Bad");
    (bad.scenes[0].placements[0] as { assetId: string }).assetId = "no-such-asset";
    const putBad = await request.put(`/api/videos/${videoId}/whiteboard`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { project: bad, rev: 1 },
    });
    expect(putBad.status()).toBe(400);
    const badBody = (await putBad.json()) as { errors?: string[] };
    expect(badBody.errors?.join(" ")).toContain('unknown asset "no-such-asset"');

    // 8. THE RENDER — a real scene preview through the in-process claim
    //    loop: chromium 720p/24 + ffmpeg → whiteboard/preview-scene-1.mp4.
    const renderRes = await request.post(`/api/videos/${videoId}/whiteboard/render`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { sceneId: "scene-1" },
    });
    expect([200, 202]).toContain(renderRes.status());
    const rBody = (await renderRes.json()) as { accepted?: boolean; scope?: string };
    expect(rBody.accepted).not.toBe(false);
    expect(rBody.scope).toBe("preview");

    // Poll the DTO until the preview lands (bounded — the sandbox render of
    // a ~4s scene took ~8s wall; CI's runner gets a generous ceiling).
    let hasPreview = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const dto = await request.get(`/api/videos/${videoId}`, { headers: { cookie } });
      if (!dto.ok()) continue;
      const body = (await dto.json()) as { video?: { hasPreview?: boolean; error?: string | null } };
      if (body.video?.hasPreview) {
        hasPreview = true;
        break;
      }
      if (body.video?.error) throw new Error(`preview render failed: ${body.video.error}`);
    }
    expect(hasPreview, "the scene preview must land within the poll window").toBe(true);

    // 9. Cross-mode refusal — a classic (kenburns) video cannot render
    //    through the whiteboard lane (the peer-MODE law).
    const classic = await request.post("/api/videos", {
      headers: { cookie },
      data: {
        topic: `S68 classic probe ${RUN}`,
        niche: "Motivation",
        format: "script",
        script: "A short classic probe script for the refusal check.",
        approved: true,
      },
    });
    expect(classic.status()).toBeLessThan(300);
    const classicId = ((await classic.json()) as { video: { id: string } }).video.id;
    const refused = await request.post(`/api/videos/${classicId}/whiteboard/render`, {
      headers: { cookie },
      data: {},
    });
    expect(refused.status()).toBe(400); // format guard fires before the mode guard
    const refusedBody = (await refused.json()) as { error?: string };
    expect(refusedBody.error).toMatch(/not a scene-based video/i);
  });
});
