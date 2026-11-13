// scene-revisions.ts — S112 / Stage 1 of Scene-Level Editing & Repair:
// the revision foundation (docs/design/scene-level-editing-reconciliation.md).
//
// THE LAWS this file enforces:
//
//   1. APPEND-ONLY. A scene's history is a chain of immutable revisions.
//      No code path edits a revision's content; the only UPDATE is the
//      head→superseded status flip, which never touches content. Editing
//      never overwrites another revision and never destroys approved work —
//      an approved head stays approved (and addressable) even after newer
//      drafts land.
//
//   2. STABLE SCENE IDENTITY. Scenes inside Video.scenes are positional
//      (indices shift across structural ops and are rebuilt 1..N by epoch
//      regens). Every revision-writing mutator carries/mints Scene.id, and
//      revisions key on it — a sceneId's revision line is exactly one
//      content lineage, across any amount of reordering.
//
//   3. THE UNION SLICE. A scene's editable content lives in TWO documents:
//      the row's Scene and the timeline doc's TimelineScene. A revision
//      snapshots both (content = { scene, docScene }) — rollback of half a
//      scene would be a lie.
//
//   4. DIFF-DRIVEN HISTORY. Interactive mutators record revisions ONLY for
//      scenes whose union slice actually changed (a one-scene edit writes
//      one revision, not twelve). Whole-script regens and converts are
//      EPOCHS: every scene is new content with fresh ids, so every scene
//      gets a genesis revision and retired ids are never reused.
//
//   5. OPTIMISTIC CONCURRENCY, TWICE. The polite gate: an edit may carry
//      the version it was based on (expectedVersion) and conflicts loudly
//      (409 + current head) when the world moved on. The hard floor: the
//      (videoId, sceneId, version) unique index — two racing writers cannot
//      both mint the next version; the loser's transaction fails whole and
//      surfaces as the same conflict.
//
//   6. ROLLBACK IS A NEW REVISION. Restoring old content never deletes or
//      rewinds anything — it appends a revision whose content is the old
//      state. History is never erased (the proposal's requirement E).
//
// First-touch backfill: the FIRST interactive edit on a scene with no
// history records the PRE-EDIT state as v1 (changeKind "backfill", born
// superseded) so a rollback target exists from the very first edit.

import { Prisma } from "@prisma/client";
import type { SceneRevision, Video } from "@prisma/client";
import { db } from "./tenant-db";
import { currentCtx } from "./tenant";
import type { Scene } from "./types";
import { parseScenes } from "./story";
import type { AssembledTimeline, TimelineScene } from "./timeline";
import { parseTimeline, serializeTimeline } from "./timeline";
import { planSceneInvalidation, sweepInvalidArtifacts } from "./scene-deps";

// ---------- shapes ----------

export type SceneRevisionChangeKind = "edit" | "structural" | "epoch" | "rollback" | "backfill";

export const SCENE_REVISION_STATUSES = ["draft", "previewing", "needs_repair", "approved", "superseded"] as const;
export type SceneRevisionStatus = (typeof SCENE_REVISION_STATUSES)[number];

/** The union slice one revision snapshots (law 3). */
export interface SceneRevisionContent {
  scene: Scene;
  docScene: TimelineScene | null;
}

/** The 409 payload: what the client's stale copy diverged from. */
export interface RevisionHeadSummary {
  sceneId: string;
  version: number;
  status: string;
  changeKind: string;
  origin: string;
  createdAt: string;
}

export class RevisionConflict extends Error {
  current: RevisionHeadSummary | null;
  constructor(current: RevisionHeadSummary | null, message: string) {
    super(message);
    this.name = "RevisionConflict";
    this.current = current;
  }
}

/** Any client exposing the two delegates this module writes through — the
 *  tenant-scoped `db` itself or an interactive `tx` from its $transaction
 *  (the extension applies inside transactions too). */
type RevisionClient = Pick<typeof db, "sceneRevision" | "video">;

// ---------- pure: identity minting (unit-pinned) ----------

/** Mint a stable scene id: "s<index>", disambiguated "-2", "-3", … against
 *  the ids already claimed in this pass. Deterministic — same inputs, same
 *  ids — so a replayed op mints the same identities. */
export function mintSceneId(hint: number, taken: Set<string>): string {
  const base = `s${Math.max(1, Math.floor(hint))}`;
  if (!taken.has(base)) return base;
  for (let k = 2; ; k++) {
    const candidate = `${base}-${k}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Interactive mutators (patch / assemble / clip / voice / pace / stock):
 *  an after-scene whose INDEX matches a before-scene inherits that scene's
 *  id (indices are identity across these ops — minted fresh, never
 *  renumbered); new indices (a split's second half, a duplicate) mint fresh
 *  ids. Existing ids on after-scenes are kept as-is. */
export function carrySceneIds(before: Scene[], after: Scene[]): Scene[] {
  const idByIndex = new Map<number, string>();
  for (const s of before) if (s.id) idByIndex.set(s.index, s.id);
  const assigned = new Set<string>();
  for (const s of after) if (s.id) assigned.add(s.id);
  return after.map((s) => {
    if (s.id) return s;
    const inherited = idByIndex.get(s.index);
    if (inherited && !assigned.has(inherited)) {
      assigned.add(inherited);
      return { ...s, id: inherited };
    }
    const id = mintSceneId(s.index, assigned);
    assigned.add(id);
    return { ...s, id };
  });
}

/** Assign stable ids onto the array's OWN objects in place (minting for any
 *  scene missing one — never touching scenes that have one). For mutators
 *  that keep mutating the same object references afterwards (stock's
 *  incremental loop): identity lands once, up front, and every later commit
 *  carries it. Returns whether any id was minted. */
export function ensureSceneIdsInPlace(scenes: Scene[]): boolean {
  const carried = carrySceneIds(scenes, scenes);
  let minted = false;
  for (let i = 0; i < scenes.length; i++) {
    const id = carried[i].id;
    if (id && scenes[i].id !== id) {
      scenes[i].id = id;
      minted = true;
    }
  }
  return minted;
}

/** Epoch mutators (script regen / batch / convert): EVERY after-scene is new
 *  content, so every id is minted fresh — never inherited — avoiding every
 *  id the video has EVER used (current array + revision history) so a
 *  sceneId's revision line stays one lineage. */
export function mintFreshSceneIds(after: Scene[], takenIds: Iterable<string>): Scene[] {
  const taken = new Set(takenIds);
  return after.map((s) => {
    const id = mintSceneId(s.index, taken);
    taken.add(id);
    return { ...s, id };
  });
}

// ---------- pure: the union slice + diffing (unit-pinned) ----------

/** Stable JSON of a union slice — the STORED content serialization
 *  (undefined coerced to null so a parse round-trip can never fabricate a
 *  diff). Includes the scene id: the snapshot is also a provenance record
 *  of WHICH scene this content belonged to. */
export function contentJson(c: SceneRevisionContent): string {
  return JSON.stringify({ scene: c.scene ?? null, docScene: c.docScene ?? null });
}

/** The DIFF serialization: identical to contentJson except the scene's ID is
 *  STRIPPED — identity is not content. Without this, the id-minting pass on
 *  a legacy array (first touch) would count every scene as "changed" and
 *  write revisions for scenes nobody edited. */
function diffJson(c: SceneRevisionContent): string {
  if (!c.scene) return JSON.stringify({ scene: null, docScene: c.docScene ?? null });
  const { id: _identity, ...scene } = c.scene;
  return JSON.stringify({ scene, docScene: c.docScene ?? null });
}

export function parseRevisionContent(json: string): SceneRevisionContent | null {
  try {
    const v = JSON.parse(json) as { scene?: unknown; docScene?: unknown };
    if (!v || typeof v !== "object" || !v.scene || typeof v.scene !== "object")
      return null;
    return {
      scene: v.scene as Scene,
      docScene: (v.docScene as TimelineScene | null) ?? null,
    };
  } catch {
    return null;
  }
}

function docSceneOf(doc: AssembledTimeline | null, index: number): TimelineScene | null {
  return doc?.scenes.find((d) => d.index === index) ?? null;
}

/** The optimistic-concurrency gate (law 5, the polite half). expected 0 =
 *  "no revisions yet" — the first edit always passes; any other expected
 *  version must BE the head. Throws RevisionConflict (the caller maps it to
 *  409 + the current head, the whiteboard conflict precedent). */
export function checkExpectedVersion(
  expected: number,
  head: { version: number } | null
): void {
  const headVersion = head?.version ?? 0;
  if (expected !== headVersion) {
    throw new RevisionConflict(
      null,
      `Scene was edited concurrently — your copy is v${expected}, the current version is v${headVersion}. Reload and re-apply.`
    );
  }
}

// ---------- reads ----------

export function headSummary(row: SceneRevision): RevisionHeadSummary {
  return {
    sceneId: row.sceneId,
    version: row.version,
    status: row.status,
    changeKind: row.changeKind,
    origin: row.origin,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The current head revision of one scene (max version), or null when the
 *  scene has no history yet. */
export async function headRevision(videoId: string, sceneId: string): Promise<SceneRevision | null> {
  return db.sceneRevision.findFirst({
    where: { videoId, sceneId },
    orderBy: { version: "desc" },
  });
}

/** The latest APPROVED revision of one scene (Stage 6's render source), or
 *  null. Approved heads are never superseded (law 1), so this stays
 *  addressable no matter how many drafts land on top. */
export async function approvedRevision(videoId: string, sceneId: string): Promise<SceneRevision | null> {
  return db.sceneRevision.findFirst({
    where: { videoId, sceneId, status: "approved" },
    orderBy: { version: "desc" },
  });
}

/** Full revision list of one scene, newest first (the history panel's feed). */
export async function listRevisions(videoId: string, sceneId: string): Promise<SceneRevision[]> {
  return db.sceneRevision.findMany({
    where: { videoId, sceneId },
    orderBy: { version: "desc" },
  });
}

// ---------- the commit (laws 1–5, one transaction) ----------

export interface CommitSceneChangesInput {
  /** The video row as read BEFORE the mutation (before-state + tenancy). */
  video: Video;
  beforeScenes: Scene[];
  beforeDoc: AssembledTimeline | null;
  /** The mutated scenes array — ids NOT yet carried/minted (done here). */
  afterScenes: Scene[];
  afterDoc: AssembledTimeline | null;
  kind: "edit" | "structural" | "epoch" | "rollback";
  /** The mutator's name ("scenes-patch", "clip-split", "script-regen", …). */
  origin: string;
  userId?: string | null;
  note?: string | null;
  /** Single-scene optimistic concurrency: the head version the edit was
   *  based on. Mismatch → RevisionConflict BEFORE any write. */
  expectedVersion?: number | null;
  expectedSceneIndex?: number | null;
  /** Extra row columns updated in the SAME transaction (voice, ttsSpeed,
   *  flags, title, script, …). scenes + timeline are always written here. */
  rowUpdate?: Prisma.VideoUpdateInput;
  /** The serialized timeline doc to persist; undefined = leave the column. */
  timeline?: string | null;
}

export interface CommitSceneChangesResult {
  /** The after array WITH ids — exactly what was written to the row. */
  scenes: Scene[];
  /** New revisions written this commit (backfills excluded). */
  created: SceneRevision[];
  /** First-touch before-state rows written (the rollback floor). */
  backfills: SceneRevision[];
}

export async function commitSceneChanges(input: CommitSceneChangesInput): Promise<CommitSceneChangesResult> {
  const { video, beforeScenes, beforeDoc, afterDoc, origin } = input;
  const createdBy = input.userId ?? currentCtx()?.userId ?? null;

  // Identity: epochs mint fresh ids against the FULL historical set (an
  // epoch never resurrects a retired scene's identity); interactive kinds
  // carry ids by index.
  let after = input.afterScenes;
  if (input.kind === "epoch") {
    const historical = await db.sceneRevision.findMany({
      where: { videoId: video.id },
      select: { sceneId: true },
      distinct: ["sceneId"],
    });
    const taken = new Set<string>([
      ...beforeScenes.flatMap((s) => (s.id ? [s.id] : [])),
      ...historical.map((r) => r.sceneId),
    ]);
    after = mintFreshSceneIds(after, taken);
  } else {
    after = carrySceneIds(beforeScenes, after);
  }
  const scenesJson = JSON.stringify(after);

  // The polite concurrency gate — resolved before any write.
  if (input.expectedVersion != null) {
    const idx = input.expectedSceneIndex;
    if (idx == null)
      throw new Error("scene-revisions: expectedSceneIndex is required with expectedVersion");
    const scene = after.find((s) => s.index === idx);
    if (!scene?.id)
      throw new RevisionConflict(null, `Scene ${idx} does not exist — reload the video.`);
    const head = await headRevision(video.id, scene.id);
    try {
      checkExpectedVersion(input.expectedVersion, head);
    } catch (err) {
      if (err instanceof RevisionConflict && head) err.current = headSummary(head);
      throw err;
    }
  }

  // Diff-driven plan (law 4): which after-scenes get a revision row.
  const beforeByIndex = new Map(beforeScenes.map((s) => [s.index, s]));
  const plan: Array<{ scene: Scene; genesis: boolean }> = [];
  for (const s of after) {
    if (!s.id) continue; // unreachable — carry/mint guarantees ids
    if (input.kind === "epoch") {
      plan.push({ scene: s, genesis: true });
      continue;
    }
    const prior = beforeByIndex.get(s.index);
    if (!prior) {
      plan.push({ scene: s, genesis: true });
      continue;
    }
    const a = diffJson({ scene: prior, docScene: docSceneOf(beforeDoc, prior.index) });
    const b = diffJson({ scene: s, docScene: docSceneOf(afterDoc, s.index) });
    if (a !== b) plan.push({ scene: s, genesis: false });
  }

  const created: SceneRevision[] = [];
  const backfills: SceneRevision[] = [];

  try {
    await db.$transaction(async (tx: RevisionClient) => {
      await tx.video.update({
        where: { id: video.id },
        data: {
          ...(input.rowUpdate ?? {}),
          scenes: scenesJson,
          ...(input.timeline !== undefined ? { timeline: input.timeline } : {}),
        },
      });

      for (const item of plan) {
        const sceneId = item.scene.id as string;
        const head = await tx.sceneRevision.findFirst({
          where: { videoId: video.id, sceneId },
          orderBy: { version: "desc" },
        });

        // First touch: record the PRE-EDIT state as v1 so the first edit
        // already has a rollback target (born superseded — v2 lands in the
        // same transaction and is the head, parented on the backfill).
        let version = (head?.version ?? 0) + 1;
        let parentVersion = head?.version ?? null;
        if (!item.genesis && !head) {
          const prior = beforeByIndex.get(item.scene.index);
          if (prior) {
            const backfill = await tx.sceneRevision.create({
              data: {
                organizationId: video.organizationId,
                videoId: video.id,
                sceneId,
                version: 1,
                parentVersion: null,
                status: "superseded",
                changeKind: "backfill",
                origin: `${origin}:backfill`,
                content: contentJson({
                  scene: prior,
                  docScene: docSceneOf(beforeDoc, prior.index),
                }),
                note: "First-touch snapshot of the pre-edit state (recorded when revision tracking began)",
                createdBy,
              },
            });
            backfills.push(backfill);
            version = 2;
            parentVersion = backfill.version;
          }
        }

        // Law 1: an approved head is never superseded — it stays the
        // latest-Approved for render + rollback. Everything else retires.
        if (head && head.status !== "approved") {
          await tx.sceneRevision.update({
            where: { id: head.id },
            data: { status: "superseded" },
          });
        }

        created.push(
          await tx.sceneRevision.create({
            data: {
              organizationId: video.organizationId,
              videoId: video.id,
              sceneId,
              version,
              parentVersion,
              status: "draft",
              changeKind: input.kind,
              origin,
              content: contentJson({
                scene: item.scene,
                docScene: docSceneOf(afterDoc, item.scene.index),
              }),
              note: input.note ?? null,
              createdBy,
            },
          })
        );
      }
    });
  } catch (err) {
    // The hard floor (law 5): a racing writer minted the same version —
    // surface it as the same conflict the polite gate produces.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      throw new RevisionConflict(
        null,
        "Scene was edited concurrently — the change was recorded by another edit. Reload and re-apply."
      );
    }
    throw err;
  }

  return { scenes: after, created, backfills };
}

// ---------- rollback (law 6) ----------

export type RollbackResult =
  | { ok: false; reason: "no-scene" | "no-history" | "no-target" | "already-current"; message: string }
  | {
      ok: true;
      scene: Scene;
      scenes: Scene[];
      revision: SceneRevision;
      timeline: AssembledTimeline | null;
      narrationChanged: boolean;
      captionChanged: boolean;
      invalidated: boolean;
    };

/** Restore a previous revision's content as a NEW revision (law 6). The
 *  row's scene + (when the target carried a doc slice) the timeline doc's
 *  scene are restored together — the union slice, never half. Artifacts made
 *  stale by the restoration are swept with the same rules PATCH /scenes
 *  uses (narration change → the old read dies; caption change → renders
 *  die). Known limit, deliberate for Stage 1: the restored doc slice carries
 *  its ORIGINAL window times — Stage 5's boundary recheck is the seam
 *  checker for exactly this. */
export async function rollbackScene(input: {
  video: Video;
  sceneIndex: number;
  toVersion: number;
  userId?: string | null;
}): Promise<RollbackResult> {
  const { video, sceneIndex, toVersion } = input;
  const beforeScenes = parseScenes(video.scenes);
  const scene = beforeScenes.find((s) => s.index === sceneIndex);
  if (!scene)
    return { ok: false, reason: "no-scene", message: `Scene ${sceneIndex} does not exist` };
  if (!scene.id)
    return {
      ok: false,
      reason: "no-history",
      message: `Scene ${sceneIndex} has no revision history yet — edit it first`,
    };

  const target = await db.sceneRevision.findUnique({
    where: { videoId_sceneId_version: { videoId: video.id, sceneId: scene.id, version: toVersion } },
  });
  if (!target)
    return {
      ok: false,
      reason: "no-target",
      message: `Revision v${toVersion} of scene ${sceneIndex} does not exist`,
    };
  const content = parseRevisionContent(target.content);
  if (!content)
    return {
      ok: false,
      reason: "no-target",
      message: `Revision v${toVersion} of scene ${sceneIndex} is unreadable — it cannot be restored`,
    };

  const beforeDoc = parseTimeline(video.timeline);
  // Normalization-symmetric restore: the stored snapshot may predate the
  // current normalizer (or have been written by a caller passing raw
  // scenes) — round the restored scene through parseScenes so it compares
  // (and lands on the row) exactly like every freshly parsed scene.
  const restored: Scene =
    parseScenes(JSON.stringify([{ ...content.scene, index: scene.index, id: scene.id }]))[0] ??
    { ...content.scene, index: scene.index, id: scene.id };
  const afterScenes = beforeScenes.map((s) => (s.index === sceneIndex ? restored : s));

  // Restore the doc slice too — only when both the target carried one AND
  // the video has a doc for it to land in (a pre-assembly edit's rollback
  // has no doc half; the row half still restores).
  const restoredDocScene = content.docScene;
  const docChanged = restoredDocScene != null && beforeDoc != null;
  const afterDoc: AssembledTimeline | null = docChanged && beforeDoc
    ? {
        ...beforeDoc,
        scenes: beforeDoc.scenes.map((d) =>
          d.index === sceneIndex ? { ...restoredDocScene, index: sceneIndex } : d
        ),
      }
    : beforeDoc;

  const beforeSlice = diffJson({ scene, docScene: docSceneOf(beforeDoc, sceneIndex) });
  const afterSlice = diffJson({ scene: restored, docScene: docSceneOf(afterDoc, sceneIndex) });
  if (beforeSlice === afterSlice)
    return {
      ok: false,
      reason: "already-current",
      message: `Scene ${sceneIndex} is already at v${toVersion}'s content — nothing to restore`,
    };

  // Staleness sweeps — the DECLARATIVE dependency map (scene-deps.ts, S113):
  // the same rules PATCH /scenes applies, so a rollback can never leave
  // newer artifacts claiming older content.
  const narrationChanged = restored.narration !== scene.narration;
  const captionChanged = restored.caption !== scene.caption;
  let invalidated = false;
  const rowUpdate: Prisma.VideoUpdateInput = {};
  const changedFields: ("narration" | "caption")[] = [
    ...(narrationChanged ? (["narration"] as const) : []),
    ...(captionChanged ? (["caption"] as const) : []),
  ];
  if (changedFields.length > 0) {
    const plan = planSceneInvalidation(video.id, sceneIndex, changedFields);
    if (
      (narrationChanged && video.hasVoiceover) ||
      (captionChanged && (video.hasVideo || video.hasShort))
    ) {
      const { removed } = await sweepInvalidArtifacts(video.id, plan);
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

  const commit = await commitSceneChanges({
    video,
    beforeScenes,
    beforeDoc,
    afterScenes,
    afterDoc,
    kind: "rollback",
    origin: "scenes-rollback",
    userId: input.userId ?? null,
    note: `Rollback to v${toVersion}`,
    rowUpdate,
    timeline: docChanged ? serializeTimeline(afterDoc as AssembledTimeline) : undefined,
  });

  const revision = commit.created[commit.created.length - 1] ?? null;
  if (!revision)
    return {
      ok: false,
      reason: "already-current",
      message: `Scene ${sceneIndex} is already at v${toVersion}'s content — nothing to restore`,
    };

  return {
    ok: true,
    scene: restored,
    scenes: commit.scenes,
    revision,
    timeline: afterDoc,
    narrationChanged,
    captionChanged,
    invalidated,
  };
}
