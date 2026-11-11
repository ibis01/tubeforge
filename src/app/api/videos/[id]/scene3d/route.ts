import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { isJobRunning, startJob } from "@/lib/tubeforge/jobs";
import * as storage from "@/lib/tubeforge/storage";
import {
  parseScene3D,
  runScene3DJob,
  scaffoldScene3D,
  scene3dClipKey,
  serializeScene3D,
  type Scene3DAspect,
} from "@/lib/tubeforge/scene3d";

type Ctx = { params: Promise<{ id: string }> };

/**
 * S94 (ROADMAP #13) — the 3D scene surface.
 *
 * POST — scaffold the deterministic Scene3D doc for this video (the topic
 * seeds the arrangement) and enqueue the render. Body (all optional):
 * { aspect?: "16:9"|"9:16"|"1:1", durationSec?: number, fps?: 24|30|60 }.
 * A re-scaffold replaces the doc and re-renders — the render is
 * deterministic, so the same inputs produce the same clip.
 *
 * GET — the doc + render state; ?clip=1 streams the rendered MP4.
 *
 * DELETE — clear the doc + the clip (the shared-timeline asset dies
 * through the storage driver).
 */

const ASPECTS: Scene3DAspect[] = ["16:9", "9:16", "1:1"];

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    aspect?: string;
    durationSec?: number;
    fps?: number;
  };
  const aspect = ASPECTS.includes(body.aspect as Scene3DAspect) ? (body.aspect as Scene3DAspect) : "16:9";
  const fps = body.fps === 24 || body.fps === 60 ? body.fps : 30;
  const durationSec = Number.isFinite(Number(body.durationSec)) ? Number(body.durationSec) : 5;

  // The deterministic scaffold — the topic seeds the arrangement (the LLM
  // scene planner is the recorded tail; the scaffold is honest about being
  // a starting arrangement, not an art-directed one).
  const doc = scaffoldScene3D(video.topic, { aspect, fps, durationSec });
  await db.video.update({
    where: { id },
    data: { scene3d: serializeScene3D(doc), error: null },
  });

  const accepted = await startJob(id, "scene3d", () => runScene3DJob(id));
  return NextResponse.json(
    { accepted, generating: true, doc: JSON.parse(serializeScene3D(doc)) },
    { status: accepted ? 202 : 200 }
  );
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const url = new URL(req.url);
  if (url.searchParams.get("clip") === "1") {
    const key = scene3dClipKey(id);
    const exists = await storage.exists(key).catch(() => false);
    if (!exists)
      return NextResponse.json({ error: "No 3D clip rendered yet" }, { status: 404 });
    const buf = await storage.get(key);
    return new NextResponse(new Uint8Array(buf), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=60",
      },
    });
  }

  const doc = parseScene3D(video.scene3d);
  return NextResponse.json({
    generating: isJobRunning(id, "scene3d"),
    error: video.error,
    doc,
    hasClip: await storage.exists(scene3dClipKey(id)).catch(() => false),
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  await storage.remove(scene3dClipKey(id)).catch(() => {});
  await db.video.update({ where: { id }, data: { scene3d: null } });
  return NextResponse.json({ cleared: true });
}
