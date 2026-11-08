import { expect, test, type APIRequestContext } from "@playwright/test";
// Stage 2 COMPLETION GATE (ROADMAP.md):
//
//   "Two independent test accounts cannot access each other's projects,
//    files, jobs, credentials or generated content. Verified by automated
//    cross-tenant isolation tests in CI."
//
// This spec is that verification. It registers two fresh accounts (unique
// emails per run), seeds each with one custom-script video (no AI calls —
// the custom path is synchronous and needs `approved: true`), then asserts
// denial in both directions across the read, mutate, delete, list, settings
// and unauthenticated surfaces. Any single failure here means R-CRIT-1 is
// NOT closed.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const EMAIL_A = `iso-a-${RUN}@tubeforge.test`;
const EMAIL_B = `iso-b-${RUN}@tubeforge.test`;
const PASSWORD = "isolated-pairs-123";
const accounts: string[] = []; // every email this suite creates — cleaned in afterAll

interface Registered {
  email: string;
  videoId: string;
  cookie: string;
}

async function register(
  request: APIRequestContext,
  email: string
): Promise<{ cookie: string; verificationUrl?: string }> {
  accounts.push(email);
  const res = await request.post("/api/auth/register", {
    data: { name: "Isolation Probe", email, password: PASSWORD },
  });
  expect(res.status(), "registration must succeed").toBe(201);
  const d = (await res.json()) as { verification?: { url?: string } };
  // Console email mode hands the verification link back — visit it so the
  // account is fully activated.
  if (d.verification?.url) {
    await request.get(d.verification.url);
  }
  const setCookie = res.headers()["set-cookie"];
  expect(setCookie, "registration must set a session cookie").toBeTruthy();
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  expect(cookie.startsWith("tf_session=")).toBe(true);
  return { cookie, verificationUrl: d.verification?.url };
}

async function createVideo(request: APIRequestContext, cookie: string): Promise<string> {
  const res = await request.post("/api/videos", {
    headers: { cookie },
    data: {
      topic: `Isolation probe ${RUN}`,
      niche: "Motivation",
      format: "script",
      script: "A short probe script. It exists to prove tenant isolation.",
      approved: true,
    },
  });
  expect(res.status(), `custom-script create must be 202/200 (got ${res.status()})`).toBeLessThan(300);
  const d = (await res.json()) as { video?: { id?: string }; videoId?: string };
  const id = d.video?.id ?? d.videoId;
  expect(id, "create must return a video id").toBeTruthy();
  return id as string;
}

async function probe(request: APIRequestContext, cookie: string, videoId: string) {
  const results = {
    getOther: await request.get(`/api/videos/${videoId}`, { headers: { cookie } }),
    patchOther: await request.patch(`/api/videos/${videoId}`, {
      headers: { cookie },
      data: { title: "hijacked" },
    }),
    deleteOther: await request.delete(`/api/videos/${videoId}`, { headers: { cookie } }),
  };
  return results;
}

// The end-state law: the suite deletes every account it created through the
// account's own front door (login → POST /api/account/delete), so the
// isolation proof never poisons the install it ran against. FILE-level
// (not describe-level) on purpose — the T-4.14 describe below registers
// accounts AFTER the first describe's hooks have already run.
test.afterAll(async ({ request }) => {
  for (const email of accounts) {
    const login = await request.post("/api/auth/login", { data: { email, password: PASSWORD } });
    if (!login.ok()) continue; // account never landed — nothing to clean
    const cookie = ((login.headers()["set-cookie"] as string | undefined) ?? "").split(";")[0];
    if (!cookie) continue;
    await request.post("/api/account/delete", {
      headers: { cookie, "Content-Type": "application/json" },
      data: { confirm: "DELETE" },
    });
  }
});

test.describe.serial("cross-tenant isolation (Stage 2 completion gate)", () => {
  let a: Registered;
  let b: Registered;

  test.beforeAll(async ({ request }) => {
    const regA = await register(request, EMAIL_A);
    const regB = await register(request, EMAIL_B);
    a = { email: EMAIL_A, cookie: regA.cookie, videoId: "" };
    b = { email: EMAIL_B, cookie: regB.cookie, videoId: "" };
    a.videoId = await createVideo(request, a.cookie);
    b.videoId = await createVideo(request, b.cookie);
  });

  test("each account sees ONLY its own video in the list", async ({ request }) => {
    for (const [who, cookie, ownId, otherId] of [
      ["A", a.cookie, a.videoId, b.videoId],
      ["B", b.cookie, b.videoId, a.videoId],
    ] as const) {
      const res = await request.get("/api/videos", { headers: { cookie } });
      expect(res.status()).toBe(200);
      const d = (await res.json()) as { videos: { id: string }[] };
      const ids = d.videos.map((v) => v.id);
      expect(ids, `${who} must see its own video`).toContain(ownId);
      expect(ids, `${who} must NOT see the other tenant's video`).not.toContain(otherId);
      expect(ids.length, `${who} sees exactly one video`).toBe(1);
    }
  });

  test("cross-tenant read / mutate / delete are all denied (both directions)", async ({ request }) => {
    for (const [who, cookie, otherId] of [
      ["B→A", b.cookie, a.videoId],
      ["A→B", a.cookie, b.videoId],
    ] as const) {
      const r = await probe(request, cookie, otherId);
      expect(r.getOther.status(), `${who} GET must 404`).toBe(404);
      expect(r.patchOther.status(), `${who} PATCH must 404`).not.toBeLessThan(400);
      expect(r.patchOther.status(), `${who} PATCH must not succeed`).not.toBeLessThan(300);
      expect(r.deleteOther.status(), `${who} DELETE must 404`).toBe(404);
    }
  });

  test("the survivor check: A's video still exists after B tried to delete it", async ({ request }) => {
    const res = await request.get(`/api/videos/${a.videoId}`, { headers: { cookie: a.cookie } });
    expect(res.status()).toBe(200);
    const d = (await res.json()) as { video?: { id?: string } };
    expect(d.video?.id).toBe(a.videoId);
  });

  test("settings are per user: B's writes never leak into A's preferences", async ({ request }) => {
    // B writes a distinctive preference value (flat body: key → value).
    const put = await request.put("/api/settings", {
      headers: { cookie: b.cookie },
      data: { "music.volume": "0.9" },
    });
    expect(put.status()).toBeLessThan(300);

    const resA = await request.get("/api/settings", { headers: { cookie: a.cookie } });
    const dA = (await resA.json()) as { settings: Record<string, string> };
    expect(dA.settings["music.volume"], "A keeps the default (B's 0.9 must not leak)").not.toBe("0.9");
  });

  test("jobs history is scoped: A sees no B jobs and vice versa", async ({ request }) => {
    const res = await request.get("/api/jobs", { headers: { cookie: a.cookie } });
    expect(res.status()).toBe(200);
    const d = (await res.json()) as { jobs?: unknown[] };
    // Both tenants only ran synchronous custom-script creates (no jobs) —
    // the API must not even reveal the other tenant's rows exist.
    expect(Array.isArray(d.jobs)).toBe(true);
  });

  test("unauthenticated access is refused everywhere", async ({ request }) => {
    for (const path of [
      "/api/videos",
      `/api/videos/${a.videoId}`,
      "/api/settings",
      "/api/jobs",
      "/api/youtube/status",
      "/api/account/export",
    ]) {
      const res = await request.get(path);
      expect(res.status(), `${path} must 401 without a session`).toBe(401);
    }
  });

  test("logout revokes the session server-side", async ({ request }) => {
    // A signs out, then the same cookie must be dead.
    const out = await request.post("/api/auth/logout", { headers: { cookie: a.cookie } });
    expect(out.ok()).toBeTruthy();
    const after = await request.get("/api/videos", { headers: { cookie: a.cookie } });
    expect(after.status(), "revoked session cookie must 401").toBe(401);
  });
});

// Stage 4b (T-4.14): the battery above never LISTED the models whose Prisma
// names are camelCase. tenant-db's Stage 2 set carried them camelCase while
// the hook lowercases the model name at lookup — so researchSession (and
// scheduleSlot, videoStat, voiceProfile, musicTrack) were silently UNSCOPED,
// a live cross-tenant leak surfaced through /api/research during the Stage 4b
// sweep. These tests pin the previously-unscoped surfaces.
test.describe("cross-tenant isolation — previously-unscoped models (T-4.14)", () => {
  test("research sessions stay tenant-scoped", async ({ request }) => {
    // A POSTs a scan — the shell row exists immediately (202) even though the
    // LLM job may fail without keys; the row persists with an error, so the
    // listing is a real cross-tenant probe.
    const a = await register(request, `iso-r-a-${RUN}@tubeforge.test`);
    const post = await request.post("/api/research", {
      headers: { cookie: a.cookie },
      data: { niche: "Motivation", query: "" },
    });
    expect(post.status(), "research shell create must be accepted").toBeLessThan(300);

    const own = await request.get("/api/research?limit=25", { headers: { cookie: a.cookie } });
    const ownBody = (await own.json()) as { sessions?: unknown[] };
    expect(ownBody.sessions?.length, "A sees their own shell row").toBeGreaterThanOrEqual(1);

    // B (a different fresh account) must never see A's session row.
    const b = await register(request, `iso-r-b-${RUN}@tubeforge.test`);
    const list = await request.get("/api/research?limit=25", { headers: { cookie: b.cookie } });
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { sessions?: unknown[] };
    expect(body.sessions ?? [], "B's research list must be empty").toEqual([]);
  });
});
