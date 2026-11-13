import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { parseScenes, serializeScenes } from "@/lib/tubeforge/story";
import { CAMERAS, sanitizeSceneStyle } from "@/lib/tubeforge/types";
import { parseTimeline, serializeTimeline, guardTimelineOverwrite } from "@/lib/tubeforge/timeline";
import {
  commitSceneChanges,
  RevisionConflict,
} from "@/lib/tubeforge/scene-revisions";
import { planSceneInvalidation, sweepInvalidArtifacts } from "@/lib/tubeforge/scene-deps";

type Ctx = { params: Promise<{ id: string }> };

/**
 * PATCH — Scene Studio text edits for ONE scene (index-keyed).
 * Body: { index, visual?, mood?, caption?, camera?, style?, narration?,
 *         expectedSceneVersion? }
 *
 * Text-only edits keep the storyboard image and any rendered MP4 valid —
 * EXCEPT narration: the spoken audio is keyed off the old narration text, so
 * a narration edit drops the voiceover + renders (Stage 4a, T-4.4), exactly
 * like a classic script edit does. The response reports `invalidated` so the
 * client can refresh the video DTO's stage flags.
 *
 * S112 — Scene-Level Editing, Stage 1: every PATCH lands as an immutable
 * SceneRevision (the union slice — row scene + timeline doc scene). First
 * touch records the pre-edit state as v1 (backfill), so even the very first
 * edit has a rollback target. `expectedSceneVersion` (optional during the
 * transition; the UI adopts it in Stage 7) is the optimistic-concurrency
 * gate: the version the client based its edit on. Mismatch → 409 + the
 * current head (the whiteboard conflict precedent) — concurrent edits
 * conflict loudly, they never silently overwrite.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter(); // tenant scope: handler + spawned job closures

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video)
    return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json(
      { error: "Not a scene-based video — scene editing applies to scene-format videos" },
      { status: 400 }
    );

  const body = await req.json().catch(() => null);
  const index = Number(body?.index);
  if (!Number.isInteger(index) || index < 1)
    return NextResponse.json({ error: "A valid scene index is required" }, { status: 400 });

  // S112 — expectedSceneVersion: absent = legacy last-write-wins client
  // (still recorded as a revision, just not conflict-checked); 0 = "no
  // revisions yet"; N = "I based this edit on vN".
  let expectedSceneVersion: number | null = null;
  if (body?.expectedSceneVersion !== undefined) {
    expectedSceneVersion = Number(body.expectedSceneVersion);
    if (!Number.isInteger(expectedSceneVersion) || expectedSceneVersion < 0)
      return NextResponse.json(
        { error: "expectedSceneVersion must be a non-negative integer (0 = no revisions yet)" },
        { status: 400 }
      );
  }

  // S112 — the BEFORE snapshot: parseScenes returns fresh objects, but the
  // edit below mutates them in place, so the revision diff needs an
  // independent pre-edit copy (a shared reference would diff against itself).
  const beforeScenes = parseScenes(video.scenes);
  const scenes = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === index);
  if (!scene)
    return NextResponse.json({ error: `Scene ${index} does not exist` }, { status: 404 });

  // Field-by-field validation — every present field must earn its way in.
  let changed = false;
  let narrationChanged = false;
  let captionChanged = false;

  if (body?.narration !== undefined) {
    const narration = String(body.narration).trim();
    if (narration.length < 3)
      return NextResponse.json({ error: "The narration needs at least 3 characters" }, { status: 400 });
    if (narration.length > 3000)
      return NextResponse.json({ error: "Narration too long — keep it under 3000 characters" }, { status: 400 });
    if (narration !== scene.narration) {
      scene.narration = narration;
      changed = true;
      narrationChanged = true;
    }
  }
  if (body?.visual !== undefined) {
    const visual = String(body.visual).trim();
    if (visual.length < 3)
      return NextResponse.json({ error: "The visual prompt needs at least 3 characters" }, { status: 400 });
    if (visual.length > 1200)
      return NextResponse.json({ error: "Visual prompt too long — keep it under 1200 characters" }, { status: 400 });
    scene.visual = visual;
    changed = true;
  }
  if (body?.mood !== undefined) {
    const mood = String(body.mood).trim().slice(0, 200);
    scene.mood = mood;
    changed = true;
  }
  if (body?.caption !== undefined) {
    const caption = String(body.caption).trim().slice(0, 60);
    if (caption !== scene.caption) {
      scene.caption = caption;
      // S43 — a human touched this line: the render treats it as THE caption
      // for this scene (one whole-scene cue) instead of narration chunks.
      scene.captionUser = true;
      captionChanged = true;
    }
    changed = true;
  }
  if (body?.camera !== undefined) {
    const camera = String(body.camera);
    if (!CAMERAS.some((c) => c.id === camera))
      return NextResponse.json({ error: `Unknown camera move "${camera}"` }, { status: 400 });
    scene.camera = camera;
    changed = true;
  }
  if (body?.style !== undefined) {
    scene.style = sanitizeSceneStyle(body.style);
    changed = true;
  }

  if (!changed)
    return NextResponse.json({ error: "Nothing to update — send at least one scene field" }, { status: 400 });

  const updated = scenes.map((s) => (s.index === index ? scene : s));

  // S43 — write the caption through to the saved timeline doc TOO: the render
  // reads caption overrides from the doc (S2 chain), and the Timeline Studio
  // displays doc captions. Without this, a Scene Studio caption edit sat on
  // the row while the render kept the doc's stale snapshot — the "edited the
  // caption, nothing changed" trap. Matched by scene INDEX inside the doc;
  // absent/misaligned docs are skipped (the row flag still carries the edit).
  const beforeDoc = parseTimeline(video.timeline);
  let afterDoc = beforeDoc;
  if (captionChanged) {
    // S87 slice 1 — the overwrite guard first: an unknown-stamp stored doc
    // is a newer build's doc, so the doc write below is skipped (a v2
    // emission must never land over it — six write paths, one law). The
    // row's caption flag above already carries the edit; this route's
    // human-facing write is unconditional either way.
    const guard = guardTimelineOverwrite(video.timeline);
    const doc = guard.blocked ? null : beforeDoc;
    const docScene = doc?.scenes.find((s) => s.index === index) ?? null;
    if (doc && docScene) {
      docScene.caption = scene.caption
        ? {
            text: scene.caption,
            startSec: docScene.caption?.startSec ?? docScene.startSec,
            endSec: docScene.caption?.endSec ?? docScene.endSec,
          }
        : null;
      afterDoc = doc;
      await db.video.update({
        where: { id },
        data: { timeline: serializeTimeline(doc) },
      });
    }
  }

  // A narration change makes the spoken audio stale — drop voiceover +
  // renders the same way the classic script edit does (T-4.4). S113: the
  // sweep is now driven by the DECLARATIVE dependency map (scene-deps.ts) —
  // the field set names what changed, the map decides exactly which of this
  // scene's artifacts and which video-level renders die. Same keys as the
  // S112 regex sweep, one source of truth for every lane (PATCH, rollback,
  // and Stage 3+'s preview staleness).
  let invalidated = false;
  const rowUpdate: Record<string, unknown> = {};
  const changedFields: ("narration" | "caption")[] = [
    ...(narrationChanged ? (["narration"] as const) : []),
    ...(captionChanged ? (["caption"] as const) : []),
  ];
  if (changedFields.length > 0) {
    const plan = planSceneInvalidation(id, index, changedFields);
    const worthSweeping =
      (narrationChanged && video.hasVoiceover) ||
      (captionChanged && (video.hasVideo || video.hasShort));
    if (worthSweeping) {
      // S43 — a caption edit keeps all audio current: the map says only the
      // video-level renders die (no re-TTS, cheap re-render). A narration
      // edit additionally drops this scene's WAV + clip and the merged
      // voiceover (the old read) — every OTHER scene's audio survives.
      const { removed } = await sweepInvalidArtifacts(id, plan);
      invalidated = removed.length > 0;
    }
    if (narrationChanged && video.hasVoiceover) {
      Object.assign(rowUpdate, {
        hasVoiceover: false,
        audioDuration: null,
        voiceSource: "tts",
        voiceLabel: null,
        hasVideo: false,
        hasShort: false,
        shortDuration: null,
        shortScene: null,
      });
    } else if (captionChanged) {
      Object.assign(rowUpdate, {
        hasVideo: false,
        hasShort: false,
        shortDuration: null,
        shortScene: null,
      });
    }
  }

  // S112 — one transaction: the row write (scenes + flags) + the immutable
  // revision (with the before-state backfill on first touch).
  let commit;
  try {
    commit = await commitSceneChanges({
      video,
      beforeScenes,
      beforeDoc,
      afterScenes: updated,
      afterDoc,
      kind: "edit",
      origin: "scenes-patch",
      userId: auth.ctx.userId,
      rowUpdate,
      expectedVersion: expectedSceneVersion,
      expectedSceneIndex: index,
    });
  } catch (err) {
    if (err instanceof RevisionConflict)
      return NextResponse.json(
        {
          error: err.message,
          ...(err.current ? { current: err.current } : {}),
        },
        { status: 409 }
      );
    throw err;
  }

  const revision = commit.created[commit.created.length - 1];

  return NextResponse.json({
    scene: (await serializeScenes(id, commit.scenes)).find((s) => s.index === index) ?? null,
    invalidated,
    captionsEdited: captionChanged,
    revision: revision
      ? {
          sceneId: revision.sceneId,
          version: revision.version,
          status: revision.status,
          changeKind: revision.changeKind,
          origin: revision.origin,
        }
      : null,
  });
}
