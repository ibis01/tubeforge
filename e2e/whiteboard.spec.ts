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
    // a ~4s scene took ~8s warm; a COLD dev server (CI) spends its first
    // minute compiling routes, so the window is generous and the test clock
    // is raised to fit it).
    //
    // NOTE the DTO field: VideoDTO exposes `previewUrl` (null until the
    // preview exists) — there is no `hasPreview` boolean on the wire (the
    // DB flag is serialize-internal; polling a nonexistent field was the
    // original draft's bug, caught by the local driver run 2026-11-09).
    //
    // NOTE the ERROR field: this video row is SHARED with the story-lane
    // script job the create route auto-starts, and on CI (no AI config)
    // that job fails fast and permanently ~10s in — its error text rides
    // the same `video.error` the whiteboard render's success path CLEARS.
    // Throwing on any error sighting raced that poison (the first CI run's
    // failure: the preview actually landed seconds later); poll previewUrl
    // only and attach the last seen error to the expect message instead —
    // a genuinely failed render still fails here, with its error text.
    test.setTimeout(240_000);
    let previewUrl: string | null = null;
    let lastError: string | null = null;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const dto = await request.get(`/api/videos/${videoId}`, { headers: { cookie } });
      if (!dto.ok()) continue;
      const body = (await dto.json()) as { video?: { previewUrl?: string | null; error?: string | null } };
      lastError = body.video?.error ?? lastError;
      if (body.video?.previewUrl) {
        previewUrl = body.video.previewUrl;
        break;
      }
    }
    expect(previewUrl, `the scene preview must land within the poll window (last video.error: ${lastError})`).toBe(
      `/api/videos/${videoId}/mp4?variant=preview`
    );

    // 8c. S69 lane-attribution contract: this video row is SHARED with the
    //     story-lane script job the create route auto-starts, and on CI (no
    //     AI config) that job fails fast and permanently — historically
    //     poisoning this same video.error field mid-render (the first S68
    //     CI round's race). S69's fix: a whiteboard-mode video's script-lane
    //     failure NEVER writes video.error (Activity + row status carry it;
    //     the render lane owns the badge) — so once the preview has landed,
    //     the badge MUST be clean, deterministically, whatever the script
    //     job's timing.
    const dtoEnd = await request.get(`/api/videos/${videoId}`, { headers: { cookie } });
    const endBody = (await dtoEnd.json()) as { video?: { error?: string | null } };
    eq_(endBody.video?.error ?? null, null, "video.error stays clean on a whiteboard video (S69 lane attribution)");

    // 8b. The artifact SERVES — the preview URL answers with video bytes
    //     (a DB flag without a servable file would be a lying badge).
    const mp4 = await request.get(`/api/videos/${videoId}/mp4?variant=preview`, {
      headers: { cookie },
    });
    expect(mp4.status()).toBe(200);
    expect((mp4.headers()["content-type"] ?? "")).toContain("video/");

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

  test("S69 — upload gates → palette merge → render with the uploaded asset → delete", async ({ request }) => {
    const email = `s69-${RUN}@tubeforge.test`;
    const { cookie, verificationUrl } = await register(request, email);
    if (verificationUrl) {
      const v = await request.get(verificationUrl);
      expect(v.status()).toBeLessThan(300);
    }

    const createRes = await request.post("/api/videos", {
      headers: { cookie },
      data: {
        topic: `S69 upload probe ${RUN}`,
        niche: "Motivation",
        format: "story",
        renderMode: "whiteboard",
      },
    });
    expect(createRes.status()).toBeLessThan(300);
    const videoId = ((await createRes.json()) as { video: { id: string } }).video.id;

    // 1. The gate rejections read clearly.
    const noViewBox = await request.post(`/api/videos/${videoId}/whiteboard/asset`, {
      headers: { cookie },
      multipart: {
        file: {
          name: "novb.svg",
          mimeType: "image/svg+xml",
          buffer: Buffer.from(`<svg width="100" height="50"><path id="p" d="M 0 0 L 9 9"/></svg>`),
        },
      },
    });
    expect(noViewBox.status()).toBe(400);
    expect(((await noViewBox.json()) as { errors?: string[] }).errors?.join(" ")).toMatch(/viewBox/);

    const overCap = await request.post(`/api/videos/${videoId}/whiteboard/asset`, {
      headers: { cookie },
      multipart: {
        file: {
          name: "big.svg",
          mimeType: "image/svg+xml",
          buffer: Buffer.alloc(256 * 1024 + 16, 0x20),
        },
      },
    });
    expect(overCap.status()).toBe(413);

    // 2. A hostile-but-recoverable file: the script subtree is stripped,
    //    the drawable survives (the pipeline neutralizes, not punishes).
    const hostile = await request.post(`/api/videos/${videoId}/whiteboard/asset`, {
      headers: { cookie },
      multipart: {
        file: {
          name: "s69 probe.svg",
          mimeType: "image/svg+xml",
          buffer: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">` +
              `<script>alert(1)</script>` +
              `<path id="hp1" d="M 20 160 L 100 30 L 180 160 Z" fill="none" stroke="#1d3557" stroke-width="6" stroke-linejoin="round"/>` +
              `<path id="hp2" d="M 70 160 L 100 110 L 130 160" fill="none" stroke="#e63946" stroke-width="6" stroke-linejoin="round"/>` +
              `</svg>`
          ),
        },
      },
    });
    expect(hostile.status(), "gates 1-5 pass (script stripped), raster probe real").toBe(201);
    const up = (await hostile.json()) as { assetId: string; bytes: number; probeMs: number };
    expect(up.assetId).toBe("up-s69-probe");
    expect(up.probeMs).toBeGreaterThan(0);

    // 3. The palette merge: GET lists the upload WITH its sanitized svg.
    const get1 = await request.get(`/api/videos/${videoId}/whiteboard`, { headers: { cookie } });
    expect(get1.status()).toBe(200);
    const d1 = (await get1.json()) as {
      library: { id: string; uploaded?: boolean; svg?: string; paths?: string[] }[];
    };
    const entry = d1.library.find((a) => a.id === "up-s69-probe");
    expect(entry?.uploaded).toBe(true);
    expect(entry?.svg).toBeTruthy();
    expect(entry?.svg).not.toContain("<script");
    expect(entry?.paths).toEqual(["hp1", "hp2"]);

    // 4. PUT a doc PLACING the upload (rev 1), then render a scene preview
    //    through it — the merged library must validate + RENDER the upload.
    const project = handAuthoredProject("S69 upload board");
    project.scenes[0].placements = [
      { assetId: "up-s69-probe", placement: { x: 760, y: 320, scale: 2, rotateDeg: 0 }, order: 0 },
    ];
    const put1 = await request.put(`/api/videos/${videoId}/whiteboard`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { project },
    });
    expect(put1.status()).toBeLessThan(300);

    const renderRes = await request.post(`/api/videos/${videoId}/whiteboard/render`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { sceneId: "scene-1" },
    });
    expect([200, 202]).toContain(renderRes.status());

    test.setTimeout(240_000);
    let previewUrl: string | null = null;
    let lastError: string | null = null;
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const dto = await request.get(`/api/videos/${videoId}`, { headers: { cookie } });
      if (!dto.ok()) continue;
      const body = (await dto.json()) as { video?: { previewUrl?: string | null; error?: string | null } };
      lastError = body.video?.error ?? lastError;
      if (body.video?.previewUrl) {
        previewUrl = body.video.previewUrl;
        break;
      }
    }
    expect(previewUrl, `a render PLACING the upload must land (last video.error: ${lastError})`).toBe(
      `/api/videos/${videoId}/mp4?variant=preview`
    );
    const mp4 = await request.get(`/api/videos/${videoId}/mp4?variant=preview`, { headers: { cookie } });
    expect(mp4.status()).toBe(200);
    expect((mp4.headers()["content-type"] ?? "")).toContain("video/");

    // 5. The delete reference guard: still placed → 409 naming the scene.
    const delRefused = await request.delete(`/api/videos/${videoId}/whiteboard/asset?assetId=up-s69-probe`, {
      headers: { cookie },
    });
    expect(delRefused.status()).toBe(409);
    expect(((await delRefused.json()) as { error?: string }).error).toMatch(/scene-1/);

    // 6. Unplace → delete → the palette loses it and the object is gone.
    const cleared = handAuthoredProject("S69 upload board");
    const put2 = await request.put(`/api/videos/${videoId}/whiteboard`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { project: cleared, rev: 1 },
    });
    expect(put2.status()).toBeLessThan(300);
    const del = await request.delete(`/api/videos/${videoId}/whiteboard/asset?assetId=up-s69-probe`, {
      headers: { cookie },
    });
    expect(del.status()).toBe(200);
    expect(((await del.json()) as { verified?: boolean }).verified).toBe(true);
    const get2 = await request.get(`/api/videos/${videoId}/whiteboard`, { headers: { cookie } });
    const d2 = (await get2.json()) as { library: { id: string; uploaded?: boolean }[] };
    expect(d2.library.find((a) => a.id === "up-s69-probe")).toBeUndefined();
  });
});

// A tiny local expect-helper (Playwright's expect(x).toBe works too; this
// keeps the failure message in the runner's native form).
function eq_(actual: unknown, expected: unknown, msg: string): void {
  expect(actual, msg).toBe(expected);
}

// S73 — the LLM scaffold planner (E5 phase 2), the CI-lane contract. The
// model half is gateway-dependent and stays sandbox-verified (the live
// probe: scripts/s73-llm-planner-probe.mts); the pure halves (catalog,
// normalization, composition, honest degradation) are unit-pinned. What CI
// can prove here is the gate ORDER: the metered planner never fires on a
// video that would refuse anyway — the no-scenes gate stands in front of
// any planner choice, and an unknown planner value is the native default.
test.describe("S73 — the LLM scaffold planner (CI-lane contracts)", () => {
  test("the planner flag never bypasses the honest gates", async ({ request }) => {
    const email = `s73-${RUN}@tubeforge.test`;
    const { cookie, verificationUrl } = await register(request, email);
    if (verificationUrl) {
      const v = await request.get(verificationUrl);
      expect(v.status()).toBeLessThan(300);
    }

    const createRes = await request.post("/api/videos", {
      headers: { cookie },
      data: {
        topic: `S73 planner probe ${RUN}`,
        niche: "Science",
        format: "story",
        renderMode: "whiteboard",
      },
    });
    expect(createRes.status()).toBeLessThan(300);
    const videoId = ((await createRes.json()) as { video: { id: string } }).video.id;

    // The story script job cannot run in CI (no gateway) → no scenes → the
    // scaffold's honest 400 must fire BEFORE any metered LLM work.
    const llmRes = await request.post(`/api/videos/${videoId}/whiteboard/scaffold`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { planner: "llm" },
    });
    expect(llmRes.status()).toBe(400);
    expect(((await llmRes.json()) as { error?: string }).error).toMatch(/no scenes/i);

    // An unknown planner value is the native default — same honest gate,
    // never a 500 on a string the route does not know.
    const junkRes = await request.post(`/api/videos/${videoId}/whiteboard/scaffold`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { planner: "quantum" },
    });
    expect(junkRes.status()).toBe(400);
    expect(((await junkRes.json()) as { error?: string }).error).toMatch(/no scenes/i);
  });
});
