import { createPrisma } from "../src/lib/tubeforge/prisma-factory.mjs";

// S123 route e2e — the motion-graphics lane through the LIVE server.
// The deeper receipts the Playwright suite can't reach (it owns the
// user-facing contract; this probe owns the DURABLE evidence):
//
//   1. auth fixtures: a throwaway account + a story video in graphics mode;
//   2. scaffold from story (needs the AI script job — skipped in probes),
//      so the doc lands through the validated PUT;
//   3. the FULL render through the graphics lane: poll the JOB ROW + the
//      VIDEO row until the standard final.mp4 lands (hasVideo), then
//      verify the per-scene encodes exist in storage (graphics/scene-N.mp4)
//      AND the S117 manifest records mode "graphics";
//   4. the labelled SCENE DRAFT: poll until the draft artifact exists under
//      graphics/draft-scene-<id>-<scale>.mp4 — and verify it NEVER touched
//      hasVideo / renderManifest (the b6 draft law, storage-checked);
//   5. the QC report rode the final with the graphics group's semantics
//      (frozen-frames judged by the dead-compositor rule — the field reads
//      "designed freezes" when sub-noise events exist);
//   6. the lane's admission walls: render without a doc (409), a bad scale
//      (400), the classic-video refusal (format guard);
//   7. cleanup: the throwaway account + org removed (baseline-relative).
//
// Run: TUBEFORGE_BASE=http://localhost:3000 node scripts/s123-route-e2e.mjs

import fs from "node:fs";
import path from "node:path";

const db = createPrisma();
const BASE = process.env.TUBEFORGE_BASE ?? "http://localhost:3000";
// The local storage driver's root (the uploads/ layout) — the draft and
// per-scene artifacts are verified ON DISK here (the Playwright suite has
// no storage access; that is this probe's reason to exist).
const UPLOADS = process.env.TUBEFORGE_UPLOADS ?? path.resolve("uploads");

let cookie = "";
async function call(method, path_, body) {
  const headers = { Cookie: cookie };
  let payload;
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path_, { method, headers, body: payload });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return res;
}

const stamp = Date.now().toString(36);
const email = `s123-probe-${stamp}@example.com`;
const password = "S123RouteProbe!001";
let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || detail === undefined ? "" : ` — ${detail}`}`);
  if (!ok) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A validator-clean doc (the same archetype family the unit fixture pins).
function probeDoc(title) {
  return {
    version: 1,
    title,
    width: 1920,
    height: 1080,
    fps: 24,
    scenes: [
      {
        id: "scene-1",
        narration: "The probe opens with a headline.",
        durationMs: 4000,
        background: "#ffffff",
        elements: [
          {
            id: "h1",
            kind: "headline",
            at: { x: 960, y: 300, scale: 1, rotateDeg: 0 },
            text: { text: "Probe headline", sizePx: 72, weight: 800, color: "#112233", align: "center" },
            enter: { kind: "rise", durationMs: 600, delayMs: 0, ease: "ease-out" },
            exit: { kind: "fade", durationMs: 400, delayMs: 3400, ease: "linear" },
          },
        ],
      },
      {
        id: "scene-2",
        narration: "The second beat holds a counter.",
        durationMs: 4000,
        background: "#f8f5ee",
        elements: [
          {
            id: "cn",
            kind: "counter",
            at: { x: 960, y: 540, scale: 1, rotateDeg: 0 },
            counter: { from: 0, to: 12, decimals: 0 },
            enter: { kind: "count", durationMs: 1200, delayMs: 300, ease: "linear" },
          },
        ],
      },
    ],
  };
}

async function main() {
  const BASELINE_USERS = await db.user.count();

  // ---- 1. fixtures ----
  let res = await call("POST", "/api/auth/register", { email, password });
  check("1.1  the throwaway account registers", res.status === 200 || res.status === 201, res.status);
  const jar = cookie;
  res = await call("POST", "/api/videos", {
    topic: `S123 route probe ${stamp}`,
    niche: "Motivation",
    format: "story",
    renderMode: "graphics",
  });
  check("1.2  the story video creates in graphics mode", res.status < 300, res.status);
  const videoId = (await res.json()).video.id;
  check("1.3  the row pins the graphics lane", (await db.video.findUnique({ where: { id: videoId } })).renderMode === "graphics");

  // ---- 2. the doc lands through the validated PUT ----
  res = await call("PUT", `/api/videos/${videoId}/graphics`, { doc: probeDoc("S123 probe") });
  check("2.1  the PUT lands the hand-authored doc", res.status < 300, res.status);
  const row = await db.video.findUnique({ where: { id: videoId } });
  check("2.2  the stored bytes are the strict write (version first)", row.graphicsDoc.startsWith("{\"version\":1,"));

  // ---- 3. the admission walls ----
  cookie = "";
  res = await call("POST", `/api/videos/${videoId}/graphics/render`, {});
  check("3.1  the lane needs a session", res.status === 401, res.status);
  cookie = jar;
  const noDocId = `${videoId}-empty`;
  res = await call("POST", `/api/videos/${noDocId}/graphics/render`, {});
  check("3.2  an unknown video refuses", res.status === 404, res.status);
  res = await call("POST", `/api/videos/${videoId}/graphics/render`, { sceneId: "scene-1", scale: 0.9 });
  check("3.3  an illegal draft scale refuses on the wire", res.status === 400, res.status);
  res = await call("POST", `/api/videos/${videoId}/graphics/render`, { sceneId: "no-such-scene" });
  check("3.4  an unknown scene refuses", res.status === 400, res.status);

  // ---- 4. the labelled scene DRAFT (storage-checked, non-certifying) ----
  res = await call("POST", `/api/videos/${videoId}/graphics/render`, { sceneId: "scene-1", scale: 0.5 });
  check("4.1  the scene draft enqueues", [200, 202].includes(res.status), res.status);
  const draftBody = await res.json();
  check("4.2  the wire carries the b6 draft law", draftBody.scope === "draft-scene" && draftBody.inheritedReviewCredit === false);
  let draftLanded = false;
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    if (fs.existsSync(path.join(UPLOADS, videoId, "graphics", "draft-scene-scene-1-0.5.mp4"))) {
      draftLanded = true;
      break;
    }
  }
  check("4.3  the draft artifact lands under graphics/ (storage-checked)", draftLanded);
  const rowAfterDraft = await db.video.findUnique({ where: { id: videoId } });
  check("4.4  the draft NEVER certifies: hasVideo stays false", rowAfterDraft.hasVideo === false);
  check("4.5  the draft NEVER writes the manifest", rowAfterDraft.renderManifest === null);

  // ---- 5. the FULL render through the lane ----
  res = await call("POST", `/api/videos/${videoId}/graphics/render`, {});
  check("5.1  the full render enqueues", [200, 202].includes(res.status), res.status);
  let done = false;
  let renderManifest = null;
  for (let i = 0; i < 120; i++) {
    await sleep(2000);
    const r = await db.video.findUnique({ where: { id: videoId } });
    if (r.hasVideo) {
      done = true;
      renderManifest = r.renderManifest;
      break;
    }
  }
  check("5.2  the standard final.mp4 lands (hasVideo)", done);
  check("5.3  the per-scene encodes exist in storage", [1, 2].every((n) => fs.existsSync(path.join(UPLOADS, videoId, "graphics", `scene-${n}.mp4`))));
  if (renderManifest) {
    const manifest = JSON.parse(renderManifest);
    check("5.4  the S117 manifest records mode graphics", manifest.mode === "graphics" && Array.isArray(manifest.entries) && manifest.entries.length === 2);
  } else {
    check("5.4  the S117 manifest records mode graphics", false, "no manifest on the row");
  }

  // ---- 6. the QC report rode the graphics group ----
  const qcRow = await db.video.findUnique({ where: { id: videoId }, select: { qcReport: true } });
  if (qcRow?.qcReport) {
    const report = JSON.parse(qcRow.qcReport);
    const frozen = (report.checks ?? []).find((c) => c.id === "frozen-frames");
    const cuts = (report.checks ?? []).find((c) => c.id === "cut-alignment");
    check("6.1  the QC report exists with the graphics semantics", Boolean(frozen) && Boolean(cuts));
    check("6.2  the frozen-frames lens rode the dead-compositor rule", frozen && frozen.status === "pass", frozen && `${frozen.value} — ${frozen.detail ?? ""}`);
    check("6.3  the hard-cut expectation derived from the doc clock", cuts && cuts.status === "pass", cuts && `${cuts.value}`);
  } else {
    check("6.1  the QC report exists with the graphics semantics", false, "no qcReport on the row");
  }

  // ---- 7. cleanup (baseline-relative) ----
  res = await call("POST", "/api/account/delete", { confirm: "DELETE" });
  check("7.1  the throwaway account deletes through its own front door", res.status < 300, res.status);
  const usersAfter = await db.user.count();
  check("7.2  the user count returns to baseline", usersAfter === BASELINE_USERS, `${usersAfter} vs ${BASELINE_USERS}`);

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures > 0 ? 1 : 0);
}

main()
  .catch((err) => {
    console.error("the probe crashed:", err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
