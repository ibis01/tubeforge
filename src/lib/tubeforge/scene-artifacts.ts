// scene-artifacts.ts — S113 / Stage 2: the per-scene artifact registry
// (docs/design/scene-level-editing-reconciliation.md §3, requirement C).
//
// Before this file, generation was a black hole for provenance: the composed
// prompt (visual + topic-world + style + director addendum + appearance
// clauses) was used and discarded; the seed was deterministic but nothing
// recorded which prompt+seed+model produced which scene-XX.png; cost rows
// existed (UsageRecord) but floated free of scenes. The ONLY provenance-rich
// artifact reference was StockRef (S89).
//
// THE LIFECYCLE:
//   pending  — registered BEFORE the paid call, so aiCall's attribution can
//              link the UsageRecord (and accumulate cost) onto the row.
//   ready    — the artifact landed; inputHash + prompt + bytes finalized.
//   failed   — the generation threw; the row stays as the cost record of a
//              failed attempt (cost may be > 0: retries bill).
//   stale    — swept by a dependency-invalidating edit (scene-deps.ts) or
//              superseded by a new input at the same key. History stays.
//
// UNIQUE (videoId, storageKey, inputHash): same inputs at the same key are
// the same artifact (idempotent re-registration — crash recovery re-runs are
// not duplicate rows); a NEW input at the same key supersedes prior rows.
//
// All writes are best-effort by design: a registry failure must NEVER block
// or fail a generation that already produced pixels — provenance is a trust
// layer, not a pipeline dependency. Every helper therefore returns null on
// failure and logs.

import crypto from "node:crypto";
import type { Video } from "@prisma/client";
import { db } from "./tenant-db";
import { parseScenes } from "./story";
import { headRevision } from "./scene-revisions";
import { log } from "./log";

const artifactLog = log.child({ mod: "scene-artifacts" });

export type SceneArtifactKind = "image" | "video" | "audio" | "preview";

/** What an aiCall produced, when the call was scene-scoped — the bridge
 *  columns on UsageRecord (billing.ts threads this through). */
export interface CallAttribution {
  videoId: string;
  sceneIndex?: number;
  artifactId?: string;
}

export interface RegisterArtifactInput {
  /** The video row (or its minimal shape) — tenancy + the scenes JSON for
   *  the stable sceneId + head revision lookup. */
  video: Pick<Video, "id" | "organizationId" | "scenes">;
  sceneIndex: number;
  type: SceneArtifactKind;
  /** Full storage key including the videoId prefix. */
  storageKey: string;
  /** The generation input — hashed into inputHash (prompt+seed for images,
   *  text+voice+speed for reads, image-hash+motion for clips, the doc slice
   *  for whiteboard encodes). */
  input: string;
  /** The FULL composed prompt at generation time (what S111 found was
   *  discarded). For TTS this is the spoken text. */
  prompt?: string | null;
  provider?: string | null;
  model?: string | null;
  bytes?: number | null;
}

export async function hashArtifactInput(input: string): Promise<string> {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

/** Resolve the stable sceneId + the current head revision for an artifact
 *  (best-effort: legacy scenes without ids record sceneId null, and a null
 *  head means the artifact predates revision tracking for that scene). */
async function resolveScene(
  video: Pick<Video, "id" | "scenes">,
  sceneIndex: number
): Promise<{ sceneId: string | null; revisionVersion: number | null }> {
  try {
    const scene = parseScenes(video.scenes).find((s) => s.index === sceneIndex);
    if (!scene?.id) return { sceneId: null, revisionVersion: null };
    const head = await headRevision(video.id, scene.id);
    return { sceneId: scene.id, revisionVersion: head?.version ?? null };
  } catch {
    return { sceneId: null, revisionVersion: null };
  }
}

/** Register (or re-register) an artifact. Idempotent on
 *  (videoId, storageKey, inputHash) — a re-run with the same inputs returns
 *  the standing row; a new input at the same key supersedes the prior rows
 *  (they go stale; history stays). */
export async function registerSceneArtifact(
  input: RegisterArtifactInput
): Promise<{ id: string } | null> {
  try {
    const inputHash = await hashArtifactInput(input.input);
    const { sceneId, revisionVersion } = await resolveScene(input.video, input.sceneIndex);
    // Supersede: any prior row at this key with a DIFFERENT input is no
    // longer what the key holds.
    await db.sceneArtifact.updateMany({
      where: { videoId: input.video.id, storageKey: input.storageKey },
      data: { status: "stale" },
    });
    const row = await db.sceneArtifact.upsert({
      where: {
        videoId_storageKey_inputHash: {
          videoId: input.video.id,
          storageKey: input.storageKey,
          inputHash,
        },
      },
      create: {
        organizationId: input.video.organizationId,
        videoId: input.video.id,
        sceneId,
        sceneIndex: input.sceneIndex,
        revisionVersion,
        type: input.type,
        storageKey: input.storageKey,
        inputHash,
        provider: input.provider ?? null,
        model: input.model ?? null,
        prompt: input.prompt ?? null,
        bytes: input.bytes ?? null,
        status: "ready",
      },
      update: {
        sceneId,
        revisionVersion,
        provider: input.provider ?? undefined,
        model: input.model ?? undefined,
        prompt: input.prompt ?? undefined,
        bytes: input.bytes ?? undefined,
        status: "ready",
      },
    });
    return { id: row.id };
  } catch (err) {
    artifactLog.warn("artifact registration failed (generation continues)", {
      videoId: input.video.id,
      sceneIndex: input.sceneIndex,
      type: input.type,
      err: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

/** The PENDING pre-registration: a row exists BEFORE the paid call so the
 *  UsageRecord bridge (attribution.artifactId) can accumulate cost onto it.
 *  Call finalizeSceneArtifact when the artifact lands (ready + final input),
 *  or failSceneArtifact when the generation threw. */
export async function beginSceneArtifact(
  input: Omit<RegisterArtifactInput, "input" | "bytes"> & { input?: string }
): Promise<CallAttribution | null> {
  try {
    const inputHash = await hashArtifactInput(input.input ?? `pending:${Date.now()}:${Math.random()}`);
    const { sceneId, revisionVersion } = await resolveScene(input.video, input.sceneIndex);
    const row = await db.sceneArtifact.create({
      data: {
        organizationId: input.video.organizationId,
        videoId: input.video.id,
        sceneId,
        sceneIndex: input.sceneIndex,
        revisionVersion,
        type: input.type,
        storageKey: input.storageKey,
        inputHash,
        provider: input.provider ?? null,
        model: input.model ?? null,
        prompt: input.prompt ?? null,
        status: "pending",
      },
    });
    return { videoId: input.video.id, sceneIndex: input.sceneIndex, artifactId: row.id };
  } catch (err) {
    artifactLog.warn("pending artifact registration failed (generation continues)", {
      videoId: input.video.id,
      sceneIndex: input.sceneIndex,
      err: err instanceof Error ? err.message : err,
    });
    return null;
  }
}

/** Finalize a pending artifact: the final input (re-rolls may have bumped
 *  seeds), the landed bytes, and the ready status. */
export async function finalizeSceneArtifact(
  attribution: CallAttribution | null,
  finalize: { input: string; prompt?: string | null; bytes?: number | null; provider?: string | null; model?: string | null }
): Promise<void> {
  if (!attribution?.artifactId) return;
  try {
    const inputHash = await hashArtifactInput(finalize.input);
    await db.sceneArtifact.update({
      where: { id: attribution.artifactId },
      data: {
        inputHash,
        status: "ready",
        prompt: finalize.prompt ?? undefined,
        bytes: finalize.bytes ?? undefined,
        provider: finalize.provider ?? undefined,
        model: finalize.model ?? undefined,
      },
    });
  } catch (err) {
    artifactLog.warn("artifact finalize failed", {
      artifactId: attribution.artifactId,
      err: err instanceof Error ? err.message : err,
    });
  }
}

/** A generation that threw: the row stays as the cost record of a failed
 *  attempt (its accumulated cost is real money). */
export async function failSceneArtifact(attribution: CallAttribution | null): Promise<void> {
  if (!attribution?.artifactId) return;
  try {
    await db.sceneArtifact.update({
      where: { id: attribution.artifactId },
      data: { status: "failed" },
    });
  } catch {
    // best-effort by design
  }
}

/** The cost bridge: called by budget.ts's recordAiUsage when a metered call
 *  carried attribution — accumulates the call's cost onto the artifact row
 *  (re-rolls sum, they don't overwrite). */
export async function accumulateArtifactCost(
  artifactId: string,
  costMicroUsd: number
): Promise<void> {
  try {
    const row = await db.sceneArtifact.findUnique({ where: { id: artifactId } });
    if (!row) return;
    await db.sceneArtifact.update({
      where: { id: artifactId },
      data: { costMicroUsd: row.costMicroUsd + costMicroUsd },
    });
  } catch {
    // best-effort by design
  }
}

/** The provenance feed for one scene (the history panel's artifacts tab +
 *  Stage 3's stale check: artifact.revisionVersion ≠ current head). */
export async function sceneArtifactsOf(
  videoId: string,
  sceneIndex: number
): Promise<Array<{ id: string; type: string; storageKey: string; status: string; inputHash: string; prompt: string | null; provider: string | null; model: string | null; costMicroUsd: number; revisionVersion: number | null; bytes: number | null; createdAt: Date }>> {
  return db.sceneArtifact.findMany({
    where: { videoId, sceneIndex },
    orderBy: { createdAt: "desc" },
  });
}
