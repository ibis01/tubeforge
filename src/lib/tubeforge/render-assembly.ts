// render-assembly.ts — S117 / Stage 6 of Scene-Level Editing & Repair:
// final assembly from approved revisions + the render manifest
// (docs/design/scene-level-editing-reconciliation.md §9, Stage 6).
//
// THE EXIT CRITERION (the proposal's own): the final video cannot be
// published from stale or unapproved assets. Two halves:
//
//   1. ASSEMBLY — a FINAL render consumes, per scene, the latest APPROVED
//      revision's content; a draft edit NEVER leaks into a final. When a
//      scene carries history but nothing is approved, the render falls back
//      to the v1 BASELINE (the backfill for first-touch edits — the last
//      pre-draft state; the genesis for epochs/structural mints — the state
//      the mutator itself committed). A scene without history renders the
//      row content (nothing else exists). Scene previews and boundary pairs
//      deliberately do NOT consume the assembly — they are LOOKS at the
//      working draft, exactly where drafts belong.
//
//   2. THE MANIFEST — final.mp4's assembly is recorded on the video row
//      (Video.renderManifest): per scene, the sceneId, the source label and
//      the revisionVersion actually consumed. renderStaleness compares the
//      manifest against the CURRENT assembly source per scene: any newer
//      revision, any new approval (an approval changes the source even
//      without an edit — the operator asked for v2 in the final), any
//      scene-list change ⇒ the standing final is STALE by comparison. The
//      export/publish ship gates refuse a stale or unprovable final (409),
//      extending the existing QC ship-gate seam.
//
// THE LAWS:
//   - THE UNION SLICE, restored at the CURRENT position: a revision
//     snapshots { scene, docScene }; assembly restores BOTH halves, with the
//     index renormalized to the row's current positional index (the
//     rollback precedent — content moves, position is the timeline's).
//   - THE MANIFEST IS A COMPARISON KEY, not a history: it records what the
//     render consumed; staleness is always computed live against the
//     current sources, never stored (a stored staleness flag could drift).
//   - UNKNOWN IS NOT FRESH: a video with revision history and no manifest
//     (a pre-S117 final) cannot prove its assembly — the gates refuse with
//     "re-render". A video with NO history has nothing to be stale against
//     (the row is the only truth) — fresh.

import type { Video } from "@prisma/client";
import { db } from "./tenant-db";
import { parseScenes } from "./story";
import { parseTimeline, serializeTimeline } from "./timeline";
import type { TimelineScene } from "./timeline";
import type { Scene } from "./types";
import { parseRevisionContent } from "./scene-revisions";

// ---------- shapes ----------

/** Where one scene's rendered content came from. */
export type AssemblySource = "approved" | "baseline" | "row";

export interface AssemblyEntry {
  /** The row's positional index at render time. */
  sceneIndex: number;
  /** The stable scene id (null = the scene predates revision tracking). */
  sceneId: string | null;
  source: AssemblySource;
  /** The revisionVersion consumed (null only for the row source). */
  revisionVersion: number | null;
  /** W6 — the board policy mode the render consumed for this scene
   *  ("clean" | "continuous"). ADDITIVE observability on the manifest:
   *  the staleness comparison ignores it (a comparison key would make a
   *  board flip silently "fresh" — board changes invalidate rendered
   *  artifacts through the doc-edit sweep instead). */
  boardMode?: string;
}

/** The effective render inputs + the per-scene record. */
export interface RenderAssembly {
  /** The scenes a FINAL render consumes (revision content swapped in,
   *  indices renormalized to the row's). */
  scenes: Scene[];
  /** The timeline doc a FINAL render consumes (revision doc-scenes swapped
   *  in), serialized; null = the video's own (absent) doc. */
  timeline: string | null;
  entries: AssemblyEntry[];
  /** Whether any scene renders from a revision (false = the row verbatim —
   *  the fast path every never-edited video takes). */
  changed: boolean;
}

/** The manifest stored on the row (schema 1). */
export interface RenderManifest {
  schema: 1;
  renderedAt: string;
  mode: string;
  entries: AssemblyEntry[];
}

export type RenderStaleness =
  | { status: "fresh" }
  | { status: "stale"; reasons: string[] }
  | { status: "unknown"; reason: string };

// ---------- pure: the manifest ----------

/** Tolerant parse — schema 1 only; corrupt/foreign JSON reads null (the
 * gates then refuse for lack of proof, never approve on a guess). */
export function parseRenderManifest(json: string | null | undefined): RenderManifest | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== 1 || !Array.isArray(obj.entries)) return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const entries = (obj.entries as Record<string, unknown>[]).map((e) => ({
    sceneIndex: num(e.sceneIndex) ?? 0,
    sceneId: typeof e.sceneId === "string" ? e.sceneId : null,
    source: (["approved", "baseline", "row"].includes(String(e.source))
      ? String(e.source)
      : "row") as AssemblySource,
    revisionVersion: num(e.revisionVersion),
    // W6 — additive, tolerant: old manifests (and old writers) carry no
    // boardMode; absent reads undefined, never a guess.
    boardMode: typeof e.boardMode === "string" ? e.boardMode : undefined,
  }));
  return {
    schema: 1,
    renderedAt: typeof obj.renderedAt === "string" ? obj.renderedAt : new Date(0).toISOString(),
    mode: typeof obj.mode === "string" ? obj.mode : "",
    entries,
  };
}

/**
 * THE STALENESS LAW, pure: compare a manifest against the CURRENT assembly
 * sources. Stale when —
 *   - the scene LIST changed (a manifest sceneId vanished — an epoch or a
 *     deletion renumbered the world; a row scene with history is missing
 *     from the manifest — history began after the render);
 *   - a scene's current source version differs from the manifest's (a newer
 *     draft made the baseline obsolete; an approval promoted a version the
 *     final was not assembled from; a rollback appended a new head).
 * Row-sourced scenes (no history) can only go stale by GAINING history,
 * which the missing-from-manifest rule catches (a scene whose history began
 * after the render renders as row in the manifest but has sources now).
 */
export function compareManifest(
  manifest: RenderManifest,
  current: AssemblyEntry[]
): { stale: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const currentBySceneId = new Map(
    current.filter((e) => e.sceneId).map((e) => [e.sceneId as string, e])
  );
  const currentByIndex = new Map(current.map((e) => [e.sceneIndex, e]));
  const manifestSceneIds = new Set(
    manifest.entries.filter((e) => e.sceneId).map((e) => e.sceneId as string)
  );

  for (const m of manifest.entries) {
    // A null sceneId (a scene that predated tracking at render time) still
    // identifies its scene BY POSITION — the edit that mints its id keeps
    // the position, so the comparison survives the mint.
    const c = m.sceneId
      ? currentBySceneId.get(m.sceneId) ?? null
      : currentByIndex.get(m.sceneIndex) ?? null;
    if (!c) {
      reasons.push(
        `Scene ${m.sceneIndex} (${m.sceneId ?? "no id"}) is no longer in the video — the scene list changed since the render`
      );
      continue;
    }
    if (c.source !== m.source || c.revisionVersion !== m.revisionVersion) {
      const from = m.source === "row" ? "the row content" : `${m.source} v${m.revisionVersion}`;
      const to = c.source === "row" ? "the row content" : `${c.source} v${c.revisionVersion}`;
      reasons.push(`Scene ${c.sceneIndex} moved from ${from} to ${to} since the render`);
    }
  }
  for (const c of current) {
    if (c.source !== "row" && c.sceneId && !manifestSceneIds.has(c.sceneId)) {
      reasons.push(
        `Scene ${c.sceneIndex} gained revision history after the render (now ${c.source} v${c.revisionVersion})`
      );
    }
  }
  return { stale: reasons.length > 0, reasons };
}

// ---------- the assembly ----------

/**
 * Resolve what a FINAL render consumes per scene. One revision query for
 * the whole video (the epoch scan's own pattern); everything else is pure
 * folding. `changed` false means the row verbatim — callers skip the swap.
 */
export async function resolveRenderAssembly(video: Video): Promise<RenderAssembly> {
  const rowScenes = parseScenes(video.scenes);
  const rowTimeline = parseTimeline(video.timeline);
  const aligned =
    rowTimeline != null && rowTimeline.scenes.length === rowScenes.length;

  const revisions = await db.sceneRevision
    .findMany({
      where: { videoId: video.id },
      select: { sceneId: true, version: true, status: true, content: true },
      orderBy: { version: "asc" },
    })
    .catch(() => []);

  // sceneId → { approved: the highest approved, first: the v1 baseline }
  const byScene = new Map<
    string,
    { approved: { version: number; content: string } | null; first: { version: number; content: string } }
  >();
  for (const r of revisions) {
    const slot = byScene.get(r.sceneId) ?? {
      approved: null as { version: number; content: string } | null,
      first: { version: r.version, content: r.content },
    };
    if (r.status === "approved" && (!slot.approved || r.version > slot.approved.version)) {
      slot.approved = { version: r.version, content: r.content };
    }
    byScene.set(r.sceneId, slot);
  }

  const entries: AssemblyEntry[] = [];
  let changed = false;
  const scenes: Scene[] = [];
  const docScenes: TimelineScene[] = aligned ? [...rowTimeline.scenes] : [];

  for (let i = 0; i < rowScenes.length; i++) {
    const rowScene = rowScenes[i];
    const slot = rowScene.id ? byScene.get(rowScene.id) : undefined;
    if (!slot) {
      // No history: the row content is the only truth.
      entries.push({ sceneIndex: rowScene.index, sceneId: rowScene.id ?? null, source: "row", revisionVersion: null });
      scenes.push(rowScene);
      continue;
    }
    const pick = slot.approved ?? slot.first;
    const source: AssemblySource = slot.approved ? "approved" : "baseline";
    const content = parseRevisionContent(pick.content);
    if (!content) {
      // Unreadable revision content: the row is the honest fallback (the
      // render must never crash on a corrupt row) — recorded as row-source.
      entries.push({ sceneIndex: rowScene.index, sceneId: rowScene.id ?? null, source: "row", revisionVersion: null });
      scenes.push(rowScene);
      changed = true;
      continue;
    }
    entries.push({
      sceneIndex: rowScene.index,
      sceneId: rowScene.id ?? null,
      source,
      revisionVersion: pick.version,
    });
    // The union slice, restored at the CURRENT position (the rollback
    // precedent: content moves, position is the timeline's).
    scenes.push({ ...content.scene, index: rowScene.index, id: rowScene.id });
    if (aligned && content.docScene && docScenes[i]) {
      docScenes[i] = { ...content.docScene, index: rowScene.index };
    }
    changed = true;
  }

  const timeline =
    changed && aligned && rowTimeline
      ? serializeTimeline({ ...rowTimeline, scenes: docScenes })
      : video.timeline ?? null;

  return { scenes, timeline, entries, changed };
}

/** Build the manifest a landed final render records. `boardModes` (W6)
 *  stamps each scene's board policy additively — a manifest written before
 *  W6 (or by another lane) stays field-absent, and the tolerant parse
 *  reads both shapes. */
export function manifestOf(
  assembly: RenderAssembly,
  mode: string,
  boardModes?: readonly string[]
): RenderManifest {
  const entries: AssemblyEntry[] = assembly.entries.map((e, i) =>
    boardModes && i < boardModes.length ? { ...e, boardMode: boardModes[i] } : e
  );
  return {
    schema: 1,
    renderedAt: new Date().toISOString(),
    mode,
    entries,
  };
}

// ---------- the staleness gate ----------

/**
 * The standing final's staleness, computed LIVE (never stored — a stored
 * flag could drift): fresh when the manifest's per-scene sources still ARE
 * the current assembly sources; stale with reasons when anything moved;
 * unknown when a video with revision history has no manifest (a pre-S117
 * final — provable only by re-rendering).
 */
export async function renderStaleness(video: Video): Promise<RenderStaleness> {
  const manifest = parseRenderManifest(video.renderManifest);
  if (!manifest) {
    const history = await db.sceneRevision
      .findFirst({ where: { videoId: video.id }, select: { id: true } })
      .catch(() => null);
    if (history) {
      return {
        status: "unknown",
        reason:
          "This final predates the render manifest (or its record was lost) while the video carries revision history — re-render to prove what the final was assembled from",
      };
    }
    return { status: "fresh" };
  }
  const assembly = await resolveRenderAssembly(video);
  const { stale, reasons } = compareManifest(manifest, assembly.entries);
  return stale ? { status: "stale", reasons } : { status: "fresh" };
}
