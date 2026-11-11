// S82 — cross-video character identity (VCE Phase B slice 5).
//
// The identity dimension of the consistency engine judges ONE video's
// scenes against the cast's anchor. But a channel's cast character is a
// BRAND: the host of video 1 must still be the host of video 30. This
// module answers the org-level question — "is this character the SAME
// person in every video that casts them?" — under the same laws the
// per-video engine obeys (docs/design/s77-visual-consistency.md §0):
//
//   §0.2 propose, never auto-edit — this is an honest REPORT. Repairs
//        happen through each flagged video's existing storyboard
//        affordances; nothing here regenerates anything.
//   §0.3 fail open, never invent — an unreadable frame or a failed call
//        is recorded "unavailable" with the reason, never a passing
//        score, never a fabricated number.
//   §0.4 shared contracts — the one VLM call rides aiCall; frames and
//        the stored report go through the storage seam; execution runs
//        under the job registry (kind "identity", entity = character).
//
// The judgement: ONE batched call — the character's reference set (the
// same refs the per-video continuity pass judges against: portrait +
// up to 3 library references) plus ONE frame per video (the character's
// latest painted host scene), at most CROSS_VIDEO_MAX videos, newest
// first. Outfits are explicitly DISCLAIMED (they legitimately change
// between videos — the per-video appearance dimension owns them); art
// style is disclaimed (the style dimension owns it).

import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { aiCall } from "./budget";
import { llmVision } from "./llm";
import { parseJsonLoose } from "./ai";
import { parseScenes, sceneImageFile } from "./story";
import { readPortrait } from "./characters";
import { verdictFromScore, type DimVerdict } from "./visual-consistency";
import { errorText } from "./redact";
import * as storage from "./storage";
import { log } from "./log";

const ciLog = log.child({ mod: "character-identity" });

/** One video's depiction of the character — the frame is the character's
 *  LATEST painted host scene in that video (null = nothing painted). */
export interface CrossVideoEntry {
  videoId: string;
  title: string;
  /** ISO date — the sort key (newest video first). */
  updatedAt: string;
  frameKey: string | null;
}

/** A batch entry — an entry that HAS a frame to judge. */
export type FramedCrossVideoEntry = CrossVideoEntry & { frameKey: string };

/** One video's verdict row in the report. */
export interface CrossVideoRow {
  videoId: string;
  title: string;
  frameKey: string;
  score: number | null; // null = unavailable, the reason rides `issues`
  verdict: DimVerdict;
  issues: string[];
}

export interface CrossVideoIdentityReport {
  schema: 1;
  characterId: string;
  characterName: string;
  checkedAt: string;
  /** Min-across the scored rows, honest zero (the character's library is
   *  as consistent as its worst video — the VCE math, inherited). */
  overall: number;
  videos: CrossVideoRow[];
  skipped: { videoId: string; title: string; reason: string }[];
  engine: { ran: boolean; unavailable: string[] };
}

/** The batch cap — one VLM call judges at most this many videos' frames
 *  (the style pass's batch-of-6 law, inherited). */
export const CROSS_VIDEO_MAX = 6;

/** Where the report persists (the character's storage namespace, beside
 *  the portrait and library references). PURE. */
export function crossVideoReportKey(characterId: string): string {
  return `characters/${characterId}/cross-video-identity.json`;
}

/** Build the judgement batch: videos WITH a painted host scene, newest
 *  first, capped at `max`; everything else is reported skipped with the
 *  honest reason. PURE — the runner only feeds it entries. */
export function buildCrossVideoBatch(
  entries: CrossVideoEntry[],
  max = CROSS_VIDEO_MAX
): {
  batch: FramedCrossVideoEntry[];
  skipped: { videoId: string; title: string; reason: string }[];
} {
  const skipped: { videoId: string; title: string; reason: string }[] = [];
  for (const e of entries) {
    if (!e.frameKey)
      skipped.push({
        videoId: e.videoId,
        title: e.title,
        reason: "no painted host scene — the character never appears in painted art here",
      });
  }
  const framed = entries
    .filter((e): e is FramedCrossVideoEntry => Boolean(e.frameKey))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  const batch = framed.slice(0, max);
  for (const e of framed.slice(max)) {
    skipped.push({
      videoId: e.videoId,
      title: e.title,
      reason: `beyond the ${max}-video cap — the newest videos are judged first`,
    });
  }
  return { batch, skipped };
}

/** The judge's charter. Clothing and art style are BOTH disclaimed —
 *  outfits legitimately change between videos (the per-video appearance
 *  dimension owns them) and rendering style is the style dimension's
 *  business. Only the PERSON is on trial. */
export const CROSS_VIDEO_SYSTEM = `You are an identity-continuity judge for a content channel's cast character. You see the character's reference images (when provided) followed by ONE generated frame from each of several DIFFERENT videos that all cast the same character, newest video first. Judge ONLY identity continuity: is this the SAME person in every frame and versus the references — face, hairstyle, apparent age, build. Ignore clothing and accessories — outfits legitimately change between videos. Ignore art style, lighting, framing and background — style is judged elsewhere.

Respond with STRICT JSON only: {"frames":[{"score":<0-100>,"issues":["<short human-readable issue>"]}]} — exactly one entry per frame, in order; score 100 means that frame depicts the same person as the references; list concrete mismatches (empty arrays when none).`;

/** Parse the judge's reply — index-aligned with the frames sent. A frame
 *  with a missing/non-numeric score stays NULL (never a fabricated 50);
 *  scores clamp to 0–100 and round; issues filter to strings, cap 6.
 *  PURE. */
export function parseCrossVideoVerdict(
  text: string,
  count: number
): ({ score: number; verdict: Exclude<DimVerdict, "unavailable">; issues: string[] } | null)[] {
  const out: ({ score: number; verdict: Exclude<DimVerdict, "unavailable">; issues: string[] } | null)[] =
    Array.from({ length: count }, () => null);
  let parsed: Record<string, unknown>;
  try {
    parsed = parseJsonLoose(text);
  } catch {
    return out; // a malformed reply marks every frame unavailable — never a score
  }
  const frames = parsed.frames;
  if (!Array.isArray(frames)) return out;
  for (let i = 0; i < Math.min(count, frames.length); i++) {
    const f = frames[i];
    if (!f || typeof f !== "object") continue;
    const scoreNum = Number((f as Record<string, unknown>).score);
    if (!Number.isFinite(scoreNum)) continue; // honest null, never 50
    const score = Math.round(Math.min(100, Math.max(0, scoreNum)));
    const rawIssues = (f as Record<string, unknown>).issues;
    const issues = Array.isArray(rawIssues)
      ? rawIssues.filter((x): x is string => typeof x === "string").slice(0, 6)
      : [];
    out[i] = { score, verdict: verdictFromScore(score), issues };
  }
  return out;
}

/** The overall score — min-across the SCORED rows, honest zero when
 *  nothing scored. PURE (the VCE math, inherited). */
export function crossVideoOverall(
  rows: { score: number | null }[]
): number {
  const scored = rows
    .map((r) => r.score)
    .filter((s): s is number => s !== null);
  if (scored.length === 0) return 0;
  return Math.min(...scored);
}

/** Parse the STORED report (the GET surface). Null for null/corrupt
 *  JSON — never a half-invented envelope. PURE. */
export function parseCrossVideoReport(
  json: string | null | undefined
): CrossVideoIdentityReport | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || (raw as Record<string, unknown>).schema !== 1) {
    return null;
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.videos) || typeof obj.characterId !== "string") return null;
  return {
    schema: 1,
    characterId: obj.characterId,
    characterName: typeof obj.characterName === "string" ? obj.characterName : "",
    checkedAt: typeof obj.checkedAt === "string" ? obj.checkedAt : new Date(0).toISOString(),
    overall: Number.isFinite(Number(obj.overall)) ? Number(obj.overall) : 0,
    videos: (obj.videos as Record<string, unknown>[]).map((v) => ({
      videoId: String(v.videoId),
      title: String(v.title ?? ""),
      frameKey: String(v.frameKey ?? ""),
      score: v.score === null || v.score === undefined ? null : Number(v.score),
      verdict: (v.verdict ?? "unavailable") as DimVerdict,
      issues: Array.isArray(v.issues) ? (v.issues as string[]) : [],
    })),
    skipped: Array.isArray(obj.skipped)
      ? (obj.skipped as Record<string, unknown>[]).map((s) => ({
          videoId: String(s.videoId),
          title: String(s.title ?? ""),
          reason: String(s.reason ?? ""),
        }))
      : [],
    engine: {
      ran: Boolean((obj.engine as Record<string, unknown> | undefined)?.ran),
      unavailable: Array.isArray((obj.engine as Record<string, unknown> | undefined)?.unavailable)
        ? ((obj.engine as Record<string, unknown>).unavailable as string[])
        : [],
    },
  };
}

/** Run the cross-video identity check for one character. Job body — runs
 *  under ctx (kind "identity", entity = the character). One batched VLM
 *  call, fail-open per frame; the report persists beside the portrait and
 *  an Activity row lands for org-level visibility. */
export async function runCrossVideoIdentityCheck(
  characterId: string
): Promise<CrossVideoIdentityReport> {
  const ctx = assertCtx("runCrossVideoIdentityCheck");
  const character = await db.character.findUnique({ where: { id: characterId } });
  if (!character) throw new Error("Character not found");
  const identity = character.identityAnchor || character.name;

  // The org's videos casting this character (tenant scope: the db seam
  // already carries the org; the where is belt-and-braces).
  const videos = await db.video.findMany({
    where: { characterId, organizationId: character.organizationId },
    select: { id: true, title: true, updatedAt: true, scenes: true },
    orderBy: { updatedAt: "desc" },
  });

  // One frame per video: the character's LATEST painted host scene,
  // scanned newest-scene-first (bounded: ≤ scene count per video).
  const entries: CrossVideoEntry[] = [];
  for (const v of videos) {
    const scenes = parseScenes(v.scenes);
    let frameKey: string | null = null;
    for (let i = scenes.length - 1; i >= 0; i--) {
      const s = scenes[i];
      if (!s.hostInScene) continue;
      const key = `${v.id}/${sceneImageFile(s.index)}`;
      const stat = await storage.stat(key).catch(() => null);
      if (stat) {
        frameKey = key;
        break;
      }
    }
    entries.push({
      videoId: v.id,
      title: v.title ?? "",
      updatedAt: v.updatedAt.toISOString(),
      frameKey,
    });
  }

  const { batch, skipped } = buildCrossVideoBatch(entries, CROSS_VIDEO_MAX);

  const unavailable: string[] = [];
  let rows: CrossVideoRow[] = [];
  let ran = false;

  if (batch.length === 0) {
    unavailable.push(
      videos.length === 0
        ? "no videos cast this character yet"
        : "no painted host scenes found in any video"
    );
  } else {
    // The reference set — the same refs the per-video continuity pass
    // judges against (portrait + up to 3 library references).
    const refBuffers: { name: string; base64: string }[] = [];
    let refKeys: string[] = [];
    try {
      const parsed = JSON.parse(character.referenceImages ?? "[]");
      refKeys = Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [];
    } catch {
      refKeys = [];
    }
    for (const key of refKeys.slice(0, 3)) {
      const buf = await storage.get(key).catch(() => null);
      if (buf) refBuffers.push({ name: key, base64: buf.toString("base64") });
    }
    const portrait = await readPortrait(characterId).catch(() => null);
    if (portrait) refBuffers.push({ name: "portrait", base64: portrait.toString("base64") });

    // Read every frame up front; a frame that vanishes between the stat
    // and the read is reported unavailable — honestly, never scored.
    const frameBufs: (Buffer | null)[] = [];
    for (const e of batch) {
      frameBufs.push(await storage.get(e.frameKey).catch(() => null));
    }

    const userParts: unknown[] = [
      { type: "text", text: `Character identity: ${identity}` },
    ];
    for (const ref of refBuffers) {
      userParts.push({ type: "text", text: `Reference image (${ref.name}):` });
      userParts.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${ref.base64}` },
      });
    }
    userParts.push({
      type: "text",
      text: `One generated frame from each of ${batch.length} different videos casting this character, newest video first:`,
    });
    for (let i = 0; i < batch.length; i++) {
      userParts.push({ type: "text", text: `Frame from "${batch[i].title}":` });
      userParts.push({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${frameBufs[i]?.toString("base64") ?? ""}` },
      });
    }

    try {
      const raw = await aiCall("llm", "cross-video identity VLM", () =>
        llmVision({
          messages: [
            { role: "system", content: CROSS_VIDEO_SYSTEM },
            { role: "user", content: userParts },
          ],
          temperature: 0.1,
        })
      );
      ran = true;
      const parsed = parseCrossVideoVerdict(
        raw.choices?.[0]?.message?.content ?? "",
        batch.length
      );
      rows = batch.map((e, i) => {
        const v = parsed[i];
        if (!frameBufs[i])
          return {
            videoId: e.videoId,
            title: e.title,
            frameKey: e.frameKey,
            score: null,
            verdict: "unavailable" as DimVerdict,
            issues: ["frame unreadable at check time"],
          };
        if (!v)
          return {
            videoId: e.videoId,
            title: e.title,
            frameKey: e.frameKey,
            score: null,
            verdict: "unavailable" as DimVerdict,
            issues: ["judge returned no verdict for this frame"],
          };
        return {
          videoId: e.videoId,
          title: e.title,
          frameKey: e.frameKey,
          score: v.score,
          verdict: v.verdict,
          issues: v.issues,
        };
      });
    } catch (err) {
      const why = `VLM call failed: ${errorText(err, "vision error").slice(0, 120)}`;
      unavailable.push(why);
      ciLog.warn("cross-video identity call failed — reporting unavailable", {
        characterId,
        err: errorText(err, "vision error"),
      });
      rows = batch.map((e) => ({
        videoId: e.videoId,
        title: e.title,
        frameKey: e.frameKey,
        score: null,
        verdict: "unavailable" as DimVerdict,
        issues: [why],
      }));
    }
  }

  const report: CrossVideoIdentityReport = {
    schema: 1,
    characterId,
    characterName: character.name,
    checkedAt: new Date().toISOString(),
    overall: crossVideoOverall(rows),
    videos: rows,
    skipped,
    engine: { ran, unavailable },
  };
  await storage.put(
    crossVideoReportKey(characterId),
    Buffer.from(JSON.stringify(report))
  );
  const scoredCount = rows.filter((r) => r.score !== null).length;
  await db.activity.create({
    data: {
      organizationId: character.organizationId,
      userId: ctx.userId,
      stage: "continuity",
      message: `Cross-video identity for ${character.name}: ${report.overall}% across ${scoredCount} scored video(s)${
        skipped.length > 0 ? `, ${skipped.length} skipped` : ""
      }`,
    },
  });
  return report;
}
