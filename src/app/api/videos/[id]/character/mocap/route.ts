import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { StorageQuotaError } from "@/lib/tubeforge/storage";
import * as storage from "@/lib/tubeforge/storage";
import { invalidateRenderedArtifacts } from "@/lib/tubeforge/render";
import { parseScenes } from "@/lib/tubeforge/story";
import { estimateNarrationSec } from "@/lib/tubeforge/timeline";
import { parseBvh, buildMocapTimeline } from "@/lib/tubeforge/characters/bvh";
import { RIG_BUDGETS } from "@/lib/tubeforge/characters/rig2d";

type Ctx = { params: Promise<{ id: string }> };

// S125-ext (K1-ext) — the FreeMoCap sidecar's admission route: a BVH capture
// uploads, parses through the CLEAN-ROOM adapter (our parser, the documented
// interchange format — no AGPL linkage), converts to inline-joint pose rows
// for the video's cast scenes, and lands as AUTHORED motion data at
// {videoId}/character/mocap.json (keyed `scene-<n>`). The render hook
// consumes an authored timeline SENIOR to the compiled gesture beats (the
// ladder: authored mocap > compiled beats > S93 breath > auto KB).
//
// The data-protocol boundary (the reception record §2.6): this route parses
// the user's BVH file — FreeMoCap's runtime is never imported, consulted,
// or linked; the BVH format is a public interchange spec.
//
// The compile wall applies: the converter strides to ≤ RIG_BUDGETS
// .timelineRows rows per scene; a capture the scene clock cannot hold
// refuses honestly.

const MOCAP_KEY = (videoId: string) => `${videoId}/character/mocap.json`;

interface MocapFile {
  [sceneKey: string]: unknown;
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  try {
    const buf = await storage.get(MOCAP_KEY(id));
    const body = JSON.parse(buf.toString("utf8")) as MocapFile;
    return NextResponse.json({ scenes: Object.keys(body), hasMocap: true });
  } catch {
    return NextResponse.json({ scenes: [], hasMocap: false });
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("multipart/form-data"))
    return NextResponse.json({ error: "Send the BVH as multipart/form-data with a 'file' field and a 'sceneIndex'" }, { status: 400 });
  const form = await req.formData().catch(() => null);
  if (!form) return NextResponse.json({ error: "Unreadable multipart body" }, { status: 400 });

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return NextResponse.json({ error: "Attach the .bvh capture in the 'file' field" }, { status: 400 });
  if (file.size > 12 * 1024 * 1024)
    return NextResponse.json({ error: `The capture is ${Math.round(file.size / 1024 / 1024)} MB — the cap is 12 MB` }, { status: 413 });

  const sceneIndex = Number(form.get("sceneIndex"));
  const scenes = video.format === "story" ? parseScenes(video.scenes) : [];
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1 || sceneIndex > scenes.length)
    return NextResponse.json({ error: `sceneIndex must be 1..${scenes.length}` }, { status: 400 });
  const scene = scenes[sceneIndex - 1];
  if (!scene.hostInScene)
    return NextResponse.json({ error: "Scene is not a cast scene — mocap rides the native rig's cast scenes only" }, { status: 400 });

  const text = await file.text();
  const parsed = parseBvh(text);
  if (!parsed.doc) {
    return NextResponse.json({ error: "The BVH failed the parse gates", errors: parsed.errors }, { status: 400 });
  }

  // The conversion lands on the shared timebase (the video's render clock,
  // capped at 30 — the D3 law) over the scene's own clock.
  const fps = (video.frameRate === 24 ? 24 : 30) as 24 | 30;
  // The scene clock: the house estimate (ONE clock rule — timeline.ts's
  // 2.6-wps narration model; VO-measured durations refine the render's own
  // clock, the authored rows clamp inside whatever the scene delivers).
  const durationMs = Math.max(400, Math.round(estimateNarrationSec(scene.narration) * 1000));
  // The rig slots come from the character's stored doc when present (a
  // rigless video still records the capture, but the mapping is honest
  // about what will consume it).
  const character = video.characterId
    ? await db.character.findUnique({ where: { id: video.characterId }, select: { rigDoc: true } })
    : null;
  let rigSlots: string[] = ["torso", "head", "arm-l", "arm-r"];
  if (character?.rigDoc) {
    try {
      const doc = JSON.parse(character.rigDoc) as { parts?: { slot?: string }[] };
      const slots = (doc.parts ?? []).map((p) => p.slot).filter((s): s is string => Boolean(s));
      if (slots.length > 0) rigSlots = slots;
    } catch {
      // junk rigDoc — the default slot set stands
    }
  }
  const { timeline, mapped, skipped } = buildMocapTimeline({
    bvh: parsed.doc,
    rigSlots,
    durationMs,
    fps,
  });
  if (timeline.rows.length === 0) {
    return NextResponse.json(
      { error: "No BVH joint maps to a rig slot", errors: [`mapped none of ${parsed.doc.joints.length} joints`] },
      { status: 422 }
    );
  }

  // S136 — the binding check (blocker B1's refuse/report half): the
  // converter writes joints keyed by rig SLOT; the frame truth (poseAt)
  // bridges slots onto the parts that carry them. When the rig exists but
  // NO part carries a mapped slot (or the capture's slots), the capture
  // would silently move nothing — refuse here, with the honest parts list,
  // rather than land a statue that outranks the compiled beats.
  let boundParts = 0;
  let rigPartCount = 0;
  if (character?.rigDoc) {
    try {
      const doc = JSON.parse(character.rigDoc) as { parts?: { id?: string; slot?: string }[] };
      const parts = (doc.parts ?? []).filter((p): p is { id?: string; slot: string } => typeof p.slot === "string");
      rigPartCount = parts.length;
      const rowKeys = new Set<string>();
      for (const row of timeline.rows) for (const k of Object.keys(row.joints ?? {})) rowKeys.add(k);
      boundParts = parts.filter((p) => (p.id && rowKeys.has(p.id)) || rowKeys.has(p.slot)).length;
      if (rigPartCount > 0 && boundParts === 0) {
        return NextResponse.json(
          {
            error: `The capture maps slots ${[...rowKeys].sort().join(", ")} but no rig part carries them — nothing would move`,
            errors: [`the rig carries: ${parts.map((p) => p.slot).sort().join(", ")}`],
          },
          { status: 422 }
        );
      }
    } catch {
      // junk rigDoc — nothing to check against (the default slot set stands)
    }
  }

  // Merge into the authored-motion file (scene-keyed; last-write-wins per
  // scene — the house rule).
  let body: MocapFile = {};
  try {
    const existing = await storage.get(MOCAP_KEY(id));
    body = JSON.parse(existing.toString("utf8")) as MocapFile;
  } catch {
    body = {};
  }
  body[`scene-${sceneIndex}`] = timeline;
  const bytes = Buffer.from(JSON.stringify(body), "utf8");
  if (bytes.length > 4 * 1024 * 1024) {
    return NextResponse.json({ error: "The authored-motion file exceeded 4 MB — delete a scene's capture first" }, { status: 413 });
  }
  try {
    await storage.put(MOCAP_KEY(id), bytes);
  } catch (err) {
    if (err instanceof StorageQuotaError)
      return NextResponse.json({ error: err.message }, { status: 413 });
    throw err;
  }

  // S154 — the capture is a CONTENT change the render dedupe must see: the
  // S115 idempotency key derives from video.updatedAt + the option digest,
  // so a storage-only write was INVISIBLE to it — uploading a capture after
  // a render answered accepted:false and the upload appeared to do nothing.
  // The same discipline every doc edit rides: invalidate the rendered
  // artifacts + touch the row (the updatedAt bump re-arms the key).
  await invalidateRenderedArtifacts(id);
  await db.video.update({ where: { id }, data: { hasVideo: false, videoDuration: null } });
  await db.activity.create({
    data: {
      organizationId: video.organizationId,
      videoId: id,
      stage: "render",
      message: `Mocap captured for scene ${sceneIndex} — ${timeline.rows.length} pose rows, ${mapped} joints mapped (${boundParts} parts bound); render to see it move`,
    },
  });

  return NextResponse.json({
    ok: true,
    sceneKey: `scene-${sceneIndex}`,
    frames: parsed.doc.frames,
    frameTimeMs: parsed.doc.frameTimeMs,
    rows: timeline.rows.length,
    rowWall: RIG_BUDGETS.timelineRows,
    mapped,
    skipped,
    boundParts,
  });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });

  const sceneKey = req.nextUrl.searchParams.get("sceneKey")?.trim() ?? "";
  try {
    const existing = await storage.get(MOCAP_KEY(id));
    const body = JSON.parse(existing.toString("utf8")) as MocapFile;
    if (sceneKey) {
      if (!(sceneKey in body))
        return NextResponse.json({ error: `No authored motion for "${sceneKey}"` }, { status: 404 });
      delete body[sceneKey];
    } else {
      for (const k of Object.keys(body)) delete body[k];
    }
    if (Object.keys(body).length === 0) {
      await storage.remove(MOCAP_KEY(id)).catch(() => {});
    } else {
      await storage.put(MOCAP_KEY(id), Buffer.from(JSON.stringify(body), "utf8"));
    }
    // S154 — a capture removal is a content change too: the standing final
    // no longer reflects the video (the deleted scene reverts to compiled
    // beats) — the artifacts invalidate and the row re-arms the render key.
    await invalidateRenderedArtifacts(id);
    await db.video.update({ where: { id }, data: { hasVideo: false, videoDuration: null } });
    return NextResponse.json({ ok: true, scenes: Object.keys(body) });
  } catch {
    return NextResponse.json({ error: "No authored motion on this video" }, { status: 404 });
  }
}
