// Stock b-roll — real footage matched per scene, S89 shape (ROADMAP #8):
//   • SOURCES — the adapter contract (stock-index.ts): Pexels + Pixabay are
//     the first two adapters; a future source is a one-file addition
//   • INDEX — all of a scene's queries gather into ONE deduped candidate
//     pool (source:id keyed), instead of per-query fragments
//   • RANK — stock-ranker.ts scores the pool: license floor, duration fit,
//     resolution, aspect, tag semantics, and the cross-scene duplicate
//     penalty (a clip used on another scene ranks last, never silently
//     repeated as a first choice)
//   • VERIFY — stock-verify.ts samples MULTIPLE interior frames per
//     downloaded clip (sequential, early-exit), measures motion
//     deterministically, and combines the verdict fail-open-but-RECORDED:
//     the ref carries a verification record; verdict "pass" requires ≥2
//     passing frames, anything less is stamped "unverified", never silent
//   • the clip downloads into the video dir as stock-XX.mp4 and the Scene
//     gains a `stock` ref — the render compositor picks it up automatically
//     and falls back to Smart Motion art for scenes without a match.
//
// This module keeps: the per-user encrypted keys, the query override, the
// incremental crash-resumable orchestration, and the compat `searchAll`
// (the Settings key tester).

import { db } from "./tenant-db";
import * as storage from "./storage";
import { sceneQueries, contentWords } from "./stock-query";
import {
  buildSceneIndex,
  clipKey,
  configuredSources,
  STOCK_SOURCES,
  type SceneIndexEntry,
  type StockCandidate,
} from "./stock-index";
import { rankCandidates } from "./stock-ranker";
import { verifyClip } from "./stock-verify";
import type { Scene, StockRef } from "./types";
import { currentCtx } from "./tenant";
import { log } from "./log";
import { commitSceneChanges, ensureSceneIdsInPlace } from "./scene-revisions";
import { parseTimeline } from "./timeline";
import {
  deleteProviderCredential,
  getProviderCredential,
  upsertProviderCredential,
} from "./settings";

// S57/T-57.2 — the module's logger (the old [stock] prefix became a binding).
const stockLog = log.child({ mod: "stock" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type { StockCandidate } from "./stock-index";

/** Where users get a free key (derived from the adapter registry). */
export const KEY_URLS: Record<"pexels" | "pixabay", string> = Object.fromEntries(
  STOCK_SOURCES.map((s) => [s.id, s.keyUrl])
) as Record<"pexels" | "pixabay", string>;

// ---------- Keys ----------
// Stage 2 — per-user, encrypted at rest (ProviderCredential, capability "stock").
// Was: global Setting rows stock.pexelsKey / stock.pixabayKey in plaintext.

type StockProvider = "pexels" | "pixabay";

function providerForName(name: "stock.pexelsKey" | "stock.pixabayKey"): StockProvider {
  return name === "stock.pexelsKey" ? "pexels" : "pixabay";
}

async function readKey(provider: StockProvider): Promise<string> {
  const cred = await getProviderCredential("stock", provider);
  return cred?.apiKey?.trim() ?? "";
}

export async function readStockKeys(): Promise<{ pexels: string; pixabay: string }> {
  const [pexels, pixabay] = await Promise.all([readKey("pexels"), readKey("pixabay")]);
  return { pexels, pixabay };
}

export async function saveStockKey(
  name: "stock.pexelsKey" | "stock.pixabayKey",
  value: string
): Promise<void> {
  const provider = providerForName(name);
  const trimmed = value.trim();
  const ctx = currentCtx();
  if (!ctx) throw new Error("saveStockKey requires an authenticated context");
  if (!trimmed) {
    await deleteProviderCredential(ctx.userId, "stock", provider);
    return;
  }
  await upsertProviderCredential(ctx.userId, "stock", provider, {
    apiKey: trimmed,
  });
}

export function maskStockKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// ---------- Search (compat surface over the adapter registry) ----------

/**
 * One search round across the configured providers (S89: the adapter
 * registry). Providers that fail (bad key, rate limit, network) are skipped
 * with a log note so a single misconfigured source never blocks the other.
 * Kept for the Settings key tester; the scene lane goes through
 * buildSceneIndex instead.
 */
export async function searchAll(
  query: string,
  keys: { pexels: string; pixabay: string }
): Promise<StockCandidate[]> {
  const sources = configuredSources(keys); // throws the pinned no-provider error
  const results = await Promise.all(
    sources.map((s) =>
      s.search(query, keys[s.id]).catch((e) => {
        stockLog.warn("stock search failed", {
          source: s.id,
          query,
          err: e instanceof Error ? e.message : e,
        });
        return [] as StockCandidate[];
      })
    )
  );
  return results.flat();
}

// ---------- Scene → query derivation ----------
// The pure logic lives in stock-query.ts (unit-testable, DB-free).

/** Sanitize a user-supplied stock search phrase (S4 per-scene re-pick).
 *
 *  The override replaces the scene-derived queries with the user's own
 *  words, so it must be safe to embed in a URL and short enough to stay a
 *  SEARCH rather than an essay. Returns null when nothing usable remains —
 *  the caller then falls back to the scene's derived queries. */
export function sanitizeStockQuery(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const cleaned = v
    .replace(/[\u0000-\u001f\u007f]/g, " ") // control chars → spaces
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120)
    .trim();
  return cleaned.length >= 2 ? cleaned : null;
}

/** Rough spoken duration of the scene's narration (a TTS refiner, not exact). */
function estimatedSceneDuration(scene: Scene): number {
  const words = scene.narration.split(/\s+/).filter(Boolean).length;
  return Math.max(4, words / 2.6);
}

/**
 * Find + download the best stock clip for one scene: index every query's
 * candidates, rank the pool, then walk the top 3 — downloaded clips must
 * survive the multi-frame verification gate. Returns null when nothing fits
 * (the scene simply keeps its Smart Motion art — never an error).
 */
async function fetchForScene(
  videoId: string,
  scene: Scene,
  keys: { pexels: string; pixabay: string },
  queries: string[],
  usedClipKeys: ReadonlySet<string>
): Promise<StockRef | null> {
  const minDur = estimatedSceneDuration(scene);
  const sceneTerms = contentWords(`${scene.visual} ${scene.narration}`, 8);

  let entries: SceneIndexEntry[] = [];
  try {
    entries = await buildSceneIndex({ queries, keys });
  } catch (err) {
    // Config errors surface on the first scene; per-scene they just
    // mean "no match this round" (the pre-S89 semantics, kept).
    if (err instanceof Error && /No stock provider/.test(err.message)) throw err;
    return null;
  }

  const ranked = rankCandidates(entries, {
    sceneDurationSec: minDur,
    usedClipKeys,
    sceneTerms,
  });

  for (const { entry } of ranked.slice(0, 3)) {
    const clip = entry.candidate;
    try {
      const ok = await downloadClip(videoId, scene.index, clip.url);
      if (!ok) continue;
      // Multi-frame verification. The storage seam provides the LOCAL path —
      // s3-safe (the pre-S89 gate read the local dir directly, a latent
      // break under the s3 driver).
      const verdict = await storage.withLocalFile(
        `${videoId}/${stockFile(scene.index)}`,
        (p) => verifyClip({ clipPath: p, durationSec: clip.durationSec, scene })
      );
      if (verdict.pass === false) {
        await storage.remove(`${videoId}/${stockFile(scene.index)}`);
        stockLog.warn("clip rejected", {
          scene: scene.index,
          reason: verdict.reason,
          scores: verdict.scores,
        });
        continue;
      }
      return {
        source: clip.source,
        file: stockFile(scene.index),
        query: entry.matchedQueries[0] ?? queries[0] ?? "",
        credit: `Footage by ${clip.author} (${clip.source === "pexels" ? "Pexels" : "Pixabay"})`,
        pageUrl: clip.pageUrl,
        durationSec: clip.durationSec,
        license: clip.license,
        providerId: clip.id,
        width: clip.width,
        height: clip.height,
        verification: {
          framesSampled: verdict.framesSampled,
          framesPassed: verdict.framesPassed,
          motionDelta: verdict.motionDelta,
          // The never-silent law: only multi-frame evidence makes "pass";
          // a fail-open accept is stamped unverified, visibly.
          verdict: verdict.pass === true ? "pass" : "unverified",
          summary: verdict.reason,
        },
      };
    } catch (err) {
      stockLog.warn("download failed for scene", { scene: scene.index, err: err instanceof Error ? err.message : err });
    }
  }
  return null;
}

/** Download + sanity-check one clip into the video dir. */
async function downloadClip(videoId: string, sceneIndex: number, url: string): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return false;
    const buf = Buffer.from(await res.arrayBuffer());
    // A real HD mp4 clip is megabytes; an error page or thumbnail is not.
    if (buf.length < 200_000) return false;
    // Storage seam (T-3.7): clip persists through the driver (quota + s3).
    await storage.put(`${videoId}/${stockFile(sceneIndex)}`, buf);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export function stockFile(index: number): string {
  return `stock-${String(index).padStart(2, "0")}.mp4`;
}

export async function readSceneStock(videoId: string, index: number): Promise<Buffer | null> {
  if (!Number.isInteger(index) || index < 1 || index > 99) return null;
  const key = `${videoId}/${stockFile(index)}`;
  if (!(await storage.exists(key))) return null;
  return storage.get(key);
}

// ---------- Video-level orchestration ----------

export interface StockRunResult {
  matched: number; // scenes that got (or already had) a clip
  fetched: number; // clips downloaded this run
  skipped: number; // scenes with no match — Smart Motion art covers them
}

/**
 * Fetch stock b-roll for every scene that still needs one (or all scenes
 * when `force`). Progress persists scene-by-scene, so an interrupted run
 * resumes where it stopped. S89: the run carries the cross-scene duplicate
 * set — clips placed on earlier scenes rank last for later ones.
 */
export async function fetchStockForScenes(opts: {
  videoId: string;
  scenes: Scene[];
  force?: boolean;
  shouldCancel?: () => boolean;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Per-scene override — used by the single-scene refetch endpoint. */
  onlyScene?: number;
  /** S4 — search with the user's exact words instead of the scene-derived
   *  queries (per-scene re-pick in the studio). No fallbacks: an override
   *  that finds nothing is an honest no-match. */
  queryOverride?: string;
}): Promise<StockRunResult> {
  const keys = await readStockKeys();
  let matched = 0;
  let fetched = 0;
  const missing: Scene[] = [];

  // S112 — identity up front: every scene the loop below touches gets its
  // stable id before the first incremental persist, so each commit's
  // revision diff keys on identity, not position.
  ensureSceneIdsInPlace(opts.scenes);
  const video = await db.video.findUnique({ where: { id: opts.videoId } });
  const beforeDoc = video ? parseTimeline(video.timeline) : null;
  let prevScenes = JSON.parse(JSON.stringify(opts.scenes)) as Scene[];

  // S89 — the duplicate ledger: every placed ref's clip key (legacy refs
  // without providerId contribute nothing — recorded, not guessed), joined
  // by every ref this run accepts.
  const usedClipKeys = new Set<string>();
  for (const s of opts.scenes)
    if (s.stock?.providerId) usedClipKeys.add(clipKey({ source: s.stock.source, id: s.stock.providerId }));

  for (const scene of opts.scenes) {
    // Storage seam (T-3.7): the probe goes through the driver (s3-safe).
    // The old local existsSync + size check only worked on the local disk.
    const hasFile =
      scene.stock != null && (await storage.exists(`${opts.videoId}/${scene.stock.file}`));
    if (hasFile) {
      matched++;
      if (!opts.force && opts.onlyScene == null) continue;
    }
    if (opts.onlyScene != null && scene.index !== opts.onlyScene) continue;
    missing.push(scene);
  }

  for (const [i, scene] of missing.entries()) {
    if (opts.shouldCancel?.()) throw new Error("__CANCELLED__");
    opts.onProgress?.(i, missing.length, `Searching footage for scene ${scene.index} (${i + 1}/${missing.length})`);

    const ref = await fetchForScene(
      opts.videoId,
      scene,
      keys,
      opts.queryOverride ? [opts.queryOverride] : sceneQueries(scene),
      usedClipKeys
    );
    opts.onProgress?.(i + 1, missing.length, ref ? `Scene ${scene.index} matched` : `Scene ${scene.index} — no match found`);

    if (ref) {
      scene.stock = ref;
      if (ref.providerId) usedClipKeys.add(clipKey({ source: ref.source, id: ref.providerId }));
      matched++;
      fetched++;
    } else if (opts.force || opts.onlyScene != null) {
      // A forced refetch that finds nothing clears the stale ref so the badge
      // doesn't claim footage that was replaced/removed.
      scene.stock = undefined;
    }

    // Persist incrementally so a crash mid-run keeps finished scenes.
    // S112 — each incremental persist IS the revision commit: the diff-driven
    // recorder writes exactly the scenes whose stock ref moved since the
    // previous commit (usually one), so an interrupted run's history matches
    // exactly the scenes that actually landed a clip.
    if (video) {
      await commitSceneChanges({
        video,
        beforeScenes: prevScenes,
        beforeDoc,
        afterScenes: opts.scenes,
        afterDoc: beforeDoc,
        kind: "edit",
        origin: opts.onlyScene != null ? "stock-repick" : "stock-match",
      });
      prevScenes = JSON.parse(JSON.stringify(opts.scenes)) as Scene[];
    } else {
      await db.video.update({ where: { id: opts.videoId }, data: { scenes: JSON.stringify(opts.scenes) } });
    }
    if (i < missing.length - 1) await sleep(1200); // pace both free APIs
  }

  return { matched, fetched, skipped: Math.max(opts.scenes.length - matched, 0) };
}

/** Remove all stock clips + refs (storyboard stays untouched).
 *  Stage 4a (T-4.0): clips are storage objects — removal goes through the
 *  driver (s3-safe, decrements the org quota).
 *  S112: the clear is a scene-content change per cleared scene — it lands as
 *  revisions (origin "stock-clear") in the same transaction as the row
 *  write, with the pre-clear state snapshotted BEFORE the loop mutates. */
export async function clearStock(videoId: string, scenes: Scene[]): Promise<number> {
  const beforeScenes = JSON.parse(JSON.stringify(scenes)) as Scene[];
  ensureSceneIdsInPlace(scenes);
  const video = await db.video.findUnique({ where: { id: videoId } });
  let cleared = 0;
  for (const scene of scenes) {
    if (scene.stock) {
      scene.stock = undefined;
      cleared++;
    }
    await storage.remove(`${videoId}/${stockFile(scene.index)}`).catch(() => {});
  }
  if (cleared > 0) {
    if (video) {
      await commitSceneChanges({
        video,
        beforeScenes,
        beforeDoc: parseTimeline(video.timeline),
        afterScenes: scenes,
        afterDoc: parseTimeline(video.timeline),
        kind: "edit",
        origin: "stock-clear",
      });
    } else {
      await db.video.update({ where: { id: videoId }, data: { scenes: JSON.stringify(scenes) } });
    }
  }
  return cleared;
}
