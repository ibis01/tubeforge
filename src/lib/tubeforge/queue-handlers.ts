// Durable queue handlers (Stage 3, T-3.5 + close-out).
//
// EVERY JobKind with work that can be rebuilt from DB state (+ the small JSON
// payload the enqueuing route stored on the row) registers here. A registered
// kind:
//   * survives a process crash — boot recovery flips its stale "running" row
//     back to "pending" and any process re-runs it via the handler;
//   * can be executed by the standalone worker (scripts/worker.mts), which
//     never saw the original request closure.
//
// After the Stage 3 close-out that is ALL kinds the routes actually start
// (only "upload" stays unregistered — YouTube publishing wiring is Stage 6
// and nothing enqueues it yet). The job bodies live in video-jobs.ts /
// character-jobs.ts / script-job.ts / research.ts so the route closures call
// the SAME function the handler does — one implementation, two entry points,
// no drift.
//
// Registration happens in src/instrumentation.ts (web server boot) and
// scripts/worker.mts (standalone worker) — never from jobs.ts, which keeps
// the import graph acyclic.

import fs from "fs";
import path from "path";
import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { registerJobHandler, handlerKinds } from "./queue";
import { runScriptJob } from "./script-job";
import { runResearchScan } from "./research";
import { parseScenes } from "./story";
import { fetchStockForScenes, sanitizeStockQuery } from "./stock";
import { isJobCancelled, setJobProgress, JobCancelledError, type JobKind } from "./jobs";
import { errorText } from "./redact";

import { videoDir } from "./ai";
import { remove } from "./storage";
import {
  runVoiceoverJob,
  runStoryboardJob,
  runSceneJob,
  runRenderJob,
  runShortJob,
  runConvertJob,
  runVerifyJob,
  runCommentsJob,
  runDirectorJob,
  runContinuityJob,
  runThumbnailJob,
  runVariantsJob,
  runSlideJob,
  runQcJob,
  runUploadJob,
  type PublishJobOptions,
  splitEntityId,
  type VoiceoverJobSource,
  type RenderJobOptions,
} from "./video-jobs";
import { runPortraitJob, runPosesJob } from "./character-jobs";

/** Renders become stale when the visual track changes (mirrors the stock route).
 *  Storage seam (T-3.7): final/preview die through the driver (s3-safe) —
 *  scene art and voiceover stay. Local scratch copies are removed too. */
async function invalidateRenders(videoId: string) {
  await remove(`${videoId}/final.mp4`).catch(() => {});
  await remove(`${videoId}/preview.mp4`).catch(() => {});
  const dir = videoDir(videoId);
  fs.rmSync(path.join(dir, "final.mp4"), { force: true });
  fs.rmSync(path.join(dir, "preview.mp4"), { force: true });
}

/**
 * The stock b-roll job body — extracted from POST /api/videos/[id]/stock
 * (Stage 3, T-3.5). Derives everything from the video row so a restart
 * resumes the fetch. `force` (from the job payload) survives the restart —
 * refresh semantics stay what the user clicked.
 */
export async function runStockRefresh(
  videoId: string,
  opts: { force?: boolean } = {}
): Promise<void> {
  const ctx = assertCtx("runStockRefresh");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return; // deleted while queued — end quietly
  if (video.format !== "story") return; // not a scene video (format changed)

  const scenes = parseScenes(video.scenes);
  if (scenes.length === 0) return;

  try {
    const result = await fetchStockForScenes({
      videoId,
      scenes,
      force: opts.force ?? false,
      shouldCancel: () => isJobCancelled(videoId, "stock"),
      onProgress: (current, total, label) => {
        if (isJobCancelled(videoId, "stock")) throw new Error("__CANCELLED__");
        setJobProgress(videoId, "stock", current, total, label);
      },
    });

    invalidateRenders(videoId);
    await db.video.update({
      where: { id: videoId },
      data: { hasVideo: false, videoDuration: null, error: null },
    });
    await db.activity.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "stock",
        message: `Stock b-roll — ${result.fetched} clip${result.fetched === 1 ? "" : "s"} downloaded, ${result.matched}/${scenes.length} scenes covered`,
      },
    });
  } catch (err) {
    if (err instanceof Error && err.message === "__CANCELLED__") {
      await db.video.update({ where: { id: videoId }, data: { error: null } });
      await db.activity
        .create({
          data: {
            organizationId: ctx.organizationId,
            userId: ctx.userId,
            videoId,
            stage: "stock",
            message: "Stock fetch cancelled — matched clips were kept",
          },
        })
        .catch(() => {});
      throw new JobCancelledError();
    }
    const message = errorText(err, "Stock fetch failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } }).catch(() => {});
    await db.activity
      .create({
        data: {
          organizationId: ctx.organizationId,
          userId: ctx.userId,
          videoId,
          stage: "stock",
          level: "error",
          message: `Stock fetch failed: ${message}`,
        },
      })
      .catch(() => {});
    throw err;
  }
}

/** S4 — the per-scene stock job's payload: an optional user search phrase.
 *  Sanitized again on resume — a payload is data, never trusted. (Exported
 *  for the unit probe.) */
export function parseStockScenePayload(payload: unknown): { queryOverride?: string } {
  const rec = asRecord(payload);
  const raw = rec?.query;
  const cleaned = typeof raw === "string" ? sanitizeStockQuery(raw) : null;
  return cleaned ? { queryOverride: cleaned } : {};
}

/**
 * The PER-SCENE stock job body — extracted from POST /api/videos/[id]/stock/[n]
 * (Stage 3 close-out). entityId is "<videoId>#scene<N>"; always force-refreshes
 * that one scene's clip. Previously the shared "stock" handler passed the
 * composite id straight to runStockRefresh, whose findUnique came back null —
 * a crashed per-scene job resumed as a silent no-op. This dispatch fixes that.
 *
 * S4: opts.queryOverride searches the user's exact words instead of the
 * scene-derived queries (the studio inspector's "search with my own phrase").
 */
export async function runStockSceneJob(
  entityId: string,
  opts: { queryOverride?: string } = {}
): Promise<void> {
  const ctx = assertCtx("runStockSceneJob");
  const [videoId, suffix] = splitEntityId(entityId, "#scene");
  const sceneIndex = suffix !== null ? Number(suffix) : NaN;
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1)
    throw new Error("Stock scene job has no valid scene index");

  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) return;
  if (video.format !== "story") return;

  const scenes = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === sceneIndex);
  if (!scene) return; // scene vanished while queued — end quietly

  try {
    await fetchStockForScenes({
      videoId,
      scenes,
      force: true, // one scene — always refresh its clip
      onlyScene: sceneIndex,
      queryOverride: opts.queryOverride,
      shouldCancel: () => isJobCancelled(entityId, "stock"),
      onProgress: (current, total, label) =>
        setJobProgress(entityId, "stock", current, total, label),
    });
    invalidateRenders(videoId);
    await db.video.update({
      where: { id: videoId },
      data: { hasVideo: false, videoDuration: null, error: null },
    });
    await db.activity.create({
      data: {
        organizationId: ctx.organizationId,
        userId: ctx.userId,
        videoId,
        stage: "stock",
        message: `Scene ${sceneIndex} stock clip ${
          scene.stock ? "re-matched" : "matched"
        } — searched ${
          opts.queryOverride ? `“${opts.queryOverride}”` : "the scene's script"
        }`,
      },
    });
  } catch (err) {
    if (err instanceof JobCancelledError || (err instanceof Error && err.message === "__CANCELLED__"))
      throw new JobCancelledError();
    const message = errorText(err, "Stock refetch failed");
    await db.video.update({ where: { id: videoId }, data: { error: message } }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Payload parsers — tolerant decoding of Job.payload for the handler path.
// The enqueuing route wrote these; an older/corrupt row degrades to defaults
// instead of throwing (a resumed job with factory defaults still beats a dead
// one — and the route versions that added each field are years from mattering).

function asRecord(payload: unknown): Record<string, unknown> | null {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

function parseVoiceoverPayload(payload: unknown): { source?: VoiceoverJobSource | null } {
  const raw = asRecord(payload)?.source;
  const s = asRecord(raw);
  if (!s) return {};
  if (s.kind === "url" && typeof s.url === "string" && s.url.trim())
    return { source: { kind: "url", url: s.url.trim(), label: typeof s.label === "string" ? s.label : undefined } };
  if (s.kind === "upload" && typeof s.storageKey === "string" && typeof s.label === "string")
    return { source: { kind: "upload", storageKey: s.storageKey, label: s.label } };
  return {};
}

function parseScenePayload(payload: unknown): { sceneIndex?: number; instruction?: string } {
  const p = asRecord(payload);
  const out: { sceneIndex?: number; instruction?: string } = {};
  if (typeof p?.sceneIndex === "number" && Number.isInteger(p.sceneIndex) && p.sceneIndex >= 1)
    out.sceneIndex = p.sceneIndex;
  if (typeof p?.instruction === "string" && p.instruction.trim()) out.instruction = p.instruction;
  return out;
}

function parseRenderPayload(payload: unknown): RenderJobOptions {
  const p = asRecord(payload);
  if (!p) return {};
  const out: RenderJobOptions = {};
  if (p.mode === "kenburns" || p.mode === "animated" || p.mode === "stock" || p.mode === "slides")
    out.mode = p.mode;
  if (typeof p.subtitles === "boolean") out.subtitles = p.subtitles;
  if (typeof p.smartCaptions === "boolean") out.smartCaptions = p.smartCaptions;
  if (typeof p.music === "boolean") out.music = p.music;
  if (typeof p.sceneLimit === "number" && Number.isInteger(p.sceneLimit) && p.sceneLimit >= 1)
    out.sceneLimit = p.sceneLimit;
  // Stage 6 (T-6.8) — per-render aspect + frame-rate overrides survive a
  // crash so the resumed render keeps the SAME geometry the user picked.
  if (p.aspectRatio === "16:9" || p.aspectRatio === "9:16" || p.aspectRatio === "1:1")
    out.aspectRatio = p.aspectRatio;
  if (p.frameRate === 24 || p.frameRate === 30 || p.frameRate === 60)
    out.frameRate = p.frameRate;
  // S3 — delivery encode tier survives a crash resume.
  if (p.quality === "draft" || p.quality === "standard" || p.quality === "high")
    out.quality = p.quality;
  // Stage 6 (T-6.10) — per-scene duration overrides from the assembled
  // timeline (the route can pass them explicitly to disable timeline
  // consumption by sending []).
  if (Array.isArray(p.sceneDurationsSec)) {
    const arr = p.sceneDurationsSec.filter(
      (d): d is number => typeof d === "number" && Number.isFinite(d) && d > 0
    );
    if (arr.length === p.sceneDurationsSec.length) out.sceneDurationsSec = arr;
  }
  return out;
}

function parseShortPayload(payload: unknown): { sceneIndex?: number | null } {
  const p = asRecord(payload);
  if (typeof p?.sceneIndex === "number" && Number.isInteger(p.sceneIndex) && p.sceneIndex >= 1)
    return { sceneIndex: p.sceneIndex };
  return {};
}

/** T-6.3 — the publish options survive a crash so the resumed upload uses
 *  the SAME title/description/privacy the user picked. Strings are
 *  clamped to YouTube's API limits; junk shapes degrade to safe defaults
 *  (the route's own Zod schema is the strict gate; this is the tolerant
 *  resume path). */
function parsePublishPayload(payload: unknown): PublishJobOptions {
  const p = asRecord(payload);
  if (!p) {
    return { title: "", description: "", tags: [] };
  }
  const title = typeof p.title === "string" ? p.title.slice(0, 100) : "";
  const description = typeof p.description === "string" ? p.description.slice(0, 4900) : "";
  const tagsRaw = Array.isArray(p.tags) ? p.tags.filter((t): t is string => typeof t === "string") : [];
  const tags = tagsRaw.slice(0, 30).map((t) => t.slice(0, 80));
  const thumbnailStorageKey =
    typeof p.thumbnailStorageKey === "string" && p.thumbnailStorageKey.trim()
      ? p.thumbnailStorageKey.trim().slice(0, 256)
      : null;
  const privacyStatus =
    typeof p.privacyStatus === "string" && ["public", "unlisted", "private"].includes(p.privacyStatus)
      ? p.privacyStatus
      : undefined;
  const publishAt =
    typeof p.publishAt === "string" && p.publishAt.trim() ? p.publishAt.trim().slice(0, 40) : null;
  return { title, description, tags, thumbnailStorageKey, privacyStatus, publishAt };
}

// ---------------------------------------------------------------------------
// Registry

/**
 * Register every DB-derivable kind. Called once per process:
 *   web     — src/instrumentation.ts at server boot
 *   worker  — scripts/worker.mts entry
 *
 * script: runScriptJob re-reads the video row each round; the Topic-Radar
 * brief/extraKeywords captured by the original closure are lost on a restart
 * re-run — the documented degradation (see script-job.ts header). Everything
 * else re-derives from the row + Job.payload with no loss.
 */
export function registerDefaultHandlers(): void {
  // Script / research / stock — Stage 3 T-3.5 originals
  registerJobHandler("script", (videoId) => runScriptJob(videoId));
  registerJobHandler("research", (sessionId) => runResearchScan(sessionId));
  registerJobHandler("stock", (entityId, payload) => {
    // Composite entityId = the per-scene variant; plain videoId = full refresh.
    if (entityId.includes("#scene"))
      return runStockSceneJob(entityId, parseStockScenePayload(payload));
    const force = asRecord(payload)?.force;
    return runStockRefresh(entityId, { force: force === true });
  });

  // Video stages — Stage 3 close-out
  registerJobHandler("voiceover", (videoId, payload) =>
    runVoiceoverJob(videoId, parseVoiceoverPayload(payload))
  );
  registerJobHandler("storyboard", (videoId) => runStoryboardJob(videoId));
  registerJobHandler("scene", (entityId, payload) => runSceneJob(entityId, parseScenePayload(payload)));
  registerJobHandler("render", (videoId, payload) => runRenderJob(videoId, parseRenderPayload(payload)));
  registerJobHandler("short", (videoId, payload) => runShortJob(videoId, parseShortPayload(payload)));
  registerJobHandler("convert", (videoId) => runConvertJob(videoId));
  registerJobHandler("verify", (videoId) => runVerifyJob(videoId));
  registerJobHandler("comments", (videoId) => runCommentsJob(videoId));
  registerJobHandler("director", (videoId) => runDirectorJob(videoId));
  registerJobHandler("continuity", (videoId) => runContinuityJob(videoId));
  registerJobHandler("thumbnail", (videoId) => runThumbnailJob(videoId));
  registerJobHandler("variants", (videoId) => runVariantsJob(videoId));
  registerJobHandler("slide", (entityId) => runSlideJob(entityId));

  // Stage 6 — QC re-run + YouTube publish. The "upload" kind was the only
  // unregistered kind left after the Stage 3 close-out; it's now wired so a
  // crashed upload resumes with the SAME title/description/privacy the user
  // picked (parsePublishPayload tolerates a payload written by an older
  // route version — defaults are safe, never silent). QC re-run is bounded
  // ffmpeg work (≤ ~1 min for typical videos) and never re-renders.
  registerJobHandler("qc", (videoId) => runQcJob(videoId));
  registerJobHandler("upload", (videoId, payload) =>
    runUploadJob(videoId, parsePublishPayload(payload))
  );

  // Character stages — Stage 3 close-out
  registerJobHandler("portrait", (characterId) => runPortraitJob(characterId));
  registerJobHandler("poses", (characterId) => runPosesJob(characterId));
}

/** The kinds this build can resume after a crash — the live handler
 *  registry itself (boot recovery's reenqueueIfHandlerKind checks the same
 *  map), so this list can never drift from the registrations above.
 *
 *  History: this used to be a hand-maintained literal, and it drifted —
 *  "director" + "continuity" were registered in Stage 5 but never added
 *  here, and the unit contract test mirrored the same stale literal, so it
 *  stayed green while covering 18 of 20 route-started kinds. Production
 *  recovery was never wrong (it checks the registry); the TEST was. */
export function resumableKinds(): JobKind[] {
  registerDefaultHandlers(); // idempotent Map.set per kind — no-op after boot
  return handlerKinds();
}
