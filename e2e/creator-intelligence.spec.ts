import { expect, test, type APIRequestContext } from "@playwright/test";

// S70 — Creator Intelligence CI-1/CI-2, the CI-lane contracts. The LLM
// halves (panel generation + judge, the VLM lookability pass) are
// gateway-dependent and stay sandbox-verified (the live probe:
// scripts/s70-hook-panel-probe.mts — green 2026-11-10, judged=true, five
// distinct formula families). What CI pins here is what CI can prove
// without a gateway: the PURE halves and the route contracts —
//
//   CI-1 score mode  — the deterministic hook scorer + the retention beats
//                      (the story engine's own rehook spine) + the
//                      title-promise check, every score labeled a heuristic.
//   CI-2 lint        — the title+thumbnail pairing lint (truncation,
//                      duplication, vagueness) on the publish surface.
//
// The custom-script create path needs no AI: the video stands immediately.

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const PASSWORD = "s70-creator-int-123";
const accounts: string[] = [];

async function register(
  request: APIRequestContext,
  email: string
): Promise<{ cookie: string; verificationUrl?: string }> {
  accounts.push(email);
  const res = await request.post("/api/auth/register", {
    data: { name: "S70 Probe", email, password: PASSWORD },
  });
  expect(res.status(), "registration must succeed").toBe(201);
  const d = (await res.json()) as { verification?: { url?: string } };
  const setCookie = res.headers()["set-cookie"];
  expect(setCookie).toBeTruthy();
  const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie)?.split(";")[0] ?? "";
  expect(cookie.startsWith("tf_session=")).toBe(true);
  return { cookie, verificationUrl: d.verification?.url };
}

test.describe("S70 — creator intelligence (CI-lane contracts)", () => {
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

  test("CI-1 score mode + CI-2 pairing lint — pure halves, heuristic-labeled", async ({ request }) => {
    const email = `s70-${RUN}@tubeforge.test`;
    const { cookie, verificationUrl } = await register(request, email);
    if (verificationUrl) {
      const v = await request.get(verificationUrl);
      expect(v.status()).toBeLessThan(300);
    }

    // A classic video with a custom script — no AI lane involved.
    const createRes = await request.post("/api/videos", {
      headers: { cookie },
      data: {
        // The topic doubles as the video's title (custom-script path): its
        // concrete terms appear in the script's opening line, so the
        // title-promise check must read delivers=true.
        topic: "How Your Heart Works",
        niche: "Science",
        format: "script",
        script:
          "Your heart works harder than you think — about one hundred thousand beats a day. In this video we look at how the human heart works, chamber by chamber.",
        approved: true,
      },
    });
    expect(createRes.status()).toBeLessThan(300);
    const videoId = ((await createRes.json()) as { video: { id: string } }).video.id;

    // ---- CI-1 score mode: the deterministic scorer, beats, title promise ----
    const scoreRes = await request.post(`/api/videos/${videoId}/script/hook-panel`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { mode: "score", hook: "Why 47% of marathon runners quit before mile 20 — and how to avoid it" },
    });
    expect(scoreRes.status()).toBe(200);
    const s = (await scoreRes.json()) as {
      mode: string;
      score: { total: number; specificity: number; tension: number; promise: number; notes: string[]; heuristic: boolean };
      titlePromise: { delivers: boolean; missing: string[]; heuristic: boolean };
      beats: { at: number; kind: string }[];
      heuristic: boolean;
    };
    expect(s.mode).toBe("score");
    expect(s.score.heuristic).toBe(true);
    expect(s.score.total).toBeGreaterThan(30);
    expect(s.score.notes.length).toBeGreaterThan(0);
    expect(s.heuristic).toBe(true);
    // The opening names the title's topic words → the promise delivers.
    expect(s.titlePromise.heuristic).toBe(true);
    expect(s.titlePromise.delivers).toBe(true);
    // A classic (non-scene) video carries no scene beats — asked for, never invented.
    expect(Array.isArray(s.beats)).toBe(true);

    // A vague hook scores lower — the deterministic anchor discriminates.
    const vagueRes = await request.post(`/api/videos/${videoId}/script/hook-panel`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { mode: "score", hook: "Amazing secrets about things" },
    });
    const v = (await vagueRes.json()) as { score: { total: number } };
    expect(v.score.total).toBeLessThan(s.score.total);

    // ---- CI-2: the pairing lint on the publish surface ----
    const lintRes = await request.post(`/api/videos/${videoId}/publish/packaging-lint`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: {
        title: "You Won't Believe This One Trick — the ultimate guide to amazing secrets",
        thumbnailText: "you won't believe this one trick",
      },
    });
    expect(lintRes.status()).toBe(200);
    const lint = (await lintRes.json()) as {
      report: {
        score: number;
        vlmJudged: boolean;
        heuristic: boolean;
        checks: { id: string; severity: string; message: string }[];
      };
      heuristic: boolean;
    };
    expect(lint.report.heuristic).toBe(true);
    expect(lint.heuristic).toBe(true);
    // No thumbnail stands on this video → no VLM claim.
    expect(lint.report.vlmJudged).toBe(false);
    const ids = lint.report.checks.map((c) => c.id);
    expect(ids).toContain("title-truncation");
    expect(ids).toContain("pairing-duplication");
    // The messy pairing warns on truncation + duplication + vagueness.
    const warns = lint.report.checks.filter((c) => c.severity === "warn").map((c) => c.id);
    expect(warns).toContain("title-truncation");
    expect(warns).toContain("pairing-duplication");
    expect(lint.report.score).toBeLessThan(100);

    // The clean pairing scores higher.
    const cleanRes = await request.post(`/api/videos/${videoId}/publish/packaging-lint`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { title: "How Your Heart Works" },
    });
    const clean = (await cleanRes.json()) as { report: { score: number } };
    expect(clean.report.score).toBeGreaterThan(lint.report.score);

    // Score mode without a hook is a readable 400 (not a 500).
    const noHook = await request.post(`/api/videos/${videoId}/script/hook-panel`, {
      headers: { cookie, "Content-Type": "application/json" },
      data: { mode: "score", hook: "" },
    });
    expect(noHook.status()).toBe(400);

    // ---- CI-4: retention needs a published video — the honest refusal ----
    const retRes = await request.post(`/api/videos/${videoId}/retention`, {
      headers: { cookie },
      data: {},
    });
    expect(retRes.status()).toBe(409);
    expect(((await retRes.json()) as { error?: string }).error).toMatch(/not published/i);
    const retGet = await request.get(`/api/videos/${videoId}/retention`, { headers: { cookie } });
    expect(retGet.status()).toBe(200);
    expect(((await retGet.json()) as { report: unknown }).report).toBeNull();
  });
});
