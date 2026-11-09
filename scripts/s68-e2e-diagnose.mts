// s68-e2e-diagnose.mts — manual driver of the S68 whiteboard E2E workflow
// against a RUNNING dev server on :3000, with per-step timing, so the
// render's cold/warm cost is measured instead of guessed.
//
//   node --import tsx scripts/s68-e2e-diagnose.mts
import { PrismaClient } from "@prisma/client";

const BASE = "http://localhost:3000";
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const EMAIL = `s68-diag-${RUN}@tubeforge.test`;
const PASSWORD = "s68-whiteboard-123";
const t0 = Date.now();
const lap = (label: string) => `+${((Date.now() - t0) / 1000).toFixed(1)}s ${label}`;

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

let cookie = "";
async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie?.startsWith("tf_session=")) cookie = setCookie.split(";")[0];
  const json = (await res.json().catch(() => null)) as unknown;
  return { status: res.status, json };
}

const prisma = new PrismaClient();
async function jobRow(videoId: string) {
  const rows = await prisma.job.findMany({
    where: { entityId: videoId },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  return rows.map((r) => ({
    kind: r.kind,
    status: r.status,
    claimedBy: r.claimedBy,
    attempts: r.attempts,
    error: r.error,
    at: r.updatedAt.toISOString(),
  }));
}

async function main() {
  console.log(lap("driver start"));

  let r = await call("POST", "/api/auth/register", { name: "S68 Diag", email: EMAIL, password: PASSWORD });
  console.log(lap(`register → ${r.status}`));
  const vUrl = (r.json as { verification?: { url?: string } })?.verification?.url;
  if (vUrl) {
    const v = await call("GET", vUrl.replace(/^https?:\/\/[^/]+/, ""));
    console.log(lap(`verify → ${v.status}`));
  }

  r = await call("POST", "/api/videos", {
    topic: `S68 diag ${RUN}`,
    niche: "Motivation",
    format: "story",
    renderMode: "whiteboard",
  });
  const videoId = (r.json as { video?: { id?: string } })?.video?.id;
  console.log(lap(`create → ${r.status} id=${videoId}`));
  if (!videoId) throw new Error("no videoId");

  r = await call("GET", `/api/videos/${videoId}/whiteboard`);
  console.log(lap(`GET doc → ${r.status} (voMs=${JSON.stringify((r.json as { voMs?: object })?.voMs)})`));

  r = await call("POST", `/api/videos/${videoId}/whiteboard/scaffold`, {});
  console.log(lap(`scaffold gate → ${r.status} ${(r.json as { error?: string })?.error}`));

  r = await call("PUT", `/api/videos/${videoId}/whiteboard`, { project: handAuthoredProject("S68 diag") });
  console.log(lap(`PUT doc → ${r.status} rev=${(r.json as { rev?: number })?.rev}`));

  r = await call("POST", `/api/videos/${videoId}/whiteboard/render`, { sceneId: "scene-1" });
  console.log(lap(`render POST → ${r.status} ${JSON.stringify(r.json)}`));
  console.log(lap("jobs right after POST:"), JSON.stringify(await jobRow(videoId)));

  for (let i = 0; i < 150; i++) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await call("GET", `/api/videos/${videoId}`);
    const v = (r.json as { video?: { previewUrl?: string | null; error?: string | null } })?.video;
    if (v?.previewUrl) {
      console.log(lap(`previewUrl=${v.previewUrl} (error=${JSON.stringify(v.error)})`));
      console.log(lap("final jobs:"), JSON.stringify(await jobRow(videoId), null, 1));
      break;
    }
    if (v?.error) {
      console.log(lap(`video.error set: ${v.error}`));
      console.log(lap("jobs at failure:"), JSON.stringify(await jobRow(videoId), null, 1));
      break;
    }
    if (i % 5 === 4) console.log(lap(`…polling (previewUrl=${v?.previewUrl ?? "null"})`), JSON.stringify(await jobRow(videoId)));
    if (i === 149) {
      console.log(lap("TIMEOUT after 300s"));
      console.log(lap("jobs at timeout:"), JSON.stringify(await jobRow(videoId), null, 1));
    }
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(lap("driver crashed:"), err);
  process.exit(1);
});
