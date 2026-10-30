// Stock b-roll — real footage from Pexels + Pixabay, matched per scene.
// MoneyPrinterTurbo's hallmark footage source, done TubeForge-style:
//   • queries are derived deterministically from each scene's visual prompt
//     AND its narration (zero LLM cost), tried against both providers
//   • clips are scored (HD, landscape, duration fit) and the best is kept
//   • every downloaded clip is RELEVANCE-CHECKED: one frame goes to the VLM
//     and clips showing an unrelated subject are rejected (next candidate is
//     tried instead) — the classic "market crash → grocery market" failure
//   • the clip downloads into the video dir as stock-XX.mp4 and the Scene
//     gains a `stock` ref — the render compositor picks it up automatically
//     and falls back to Smart Motion art for scenes without a match.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { db } from "@/lib/db";
import { videoDir } from "./ai";
import { relevanceCheck } from "./quality";
import { sceneQueries } from "./stock-query";
import type { Scene, StockRef } from "./types";

const execFileAsync = promisify(execFile);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UPLOAD_ROOT = path.join(process.cwd(), "uploads");

/** Where users get a free key. */
export const KEY_URLS = {
  pexels: "https://www.pexels.com/api/",
  pixabay: "https://pixabay.com/api/docs/#api_key",
};

// ---------- Keys ----------

async function readKey(name: "stock.pexelsKey" | "stock.pixabayKey"): Promise<string> {
  const row = await db.setting.findUnique({ where: { key: name } });
  return row?.value?.trim() ?? "";
}

export async function readStockKeys(): Promise<{ pexels: string; pixabay: string }> {
  const [pexels, pixabay] = await Promise.all([
    readKey("stock.pexelsKey"),
    readKey("stock.pixabayKey"),
  ]);
  return { pexels, pixabay };
}

export async function saveStockKey(
  name: "stock.pexelsKey" | "stock.pixabayKey",
  value: string
): Promise<void> {
  const trimmed = value.trim();
  if (!trimmed) {
    await db.setting.deleteMany({ where: { key: name } });
    return;
  }
  await db.setting.upsert({
    where: { key: name },
    update: { value: trimmed },
    create: { key: name, value: trimmed },
  });
}

export function maskStockKey(key: string): string {
  if (!key) return "";
  if (key.length <= 10) return `${key.slice(0, 2)}…`;
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

// ---------- Search (raw provider calls) ----------

export interface StockCandidate {
  source: "pexels" | "pixabay";
  /** Direct downloadable video file URL (mp4). */
  url: string;
  width: number;
  height: number;
  durationSec: number;
  author: string;
  pageUrl: string;
}

async function fetchJson(url: string, headers: Record<string, string>, timeoutMs = 20000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403)
        throw new Error("invalid API key (check it in Settings → Stock footage)");
      if (res.status === 429) throw new Error("rate limited — try again in a minute");
      throw new Error(`HTTP ${res.status}${body ? `: ${body.slice(0, 160)}` : ""}`);
    }
    return await res.json();
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError")
      throw new Error("provider timed out");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Pexels Video API — https://www.pexels.com/api/documentation/#videos */
async function pexelsSearch(query: string, key: string): Promise<StockCandidate[]> {
  const url =
    `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}` +
    `&orientation=landscape&size=medium&per_page=15`;
  const data = (await fetchJson(url, { Authorization: key })) as {
    videos?: {
      id: number;
      duration: number;
      width: number;
      height: number;
      url?: string;
      user?: { name?: string; url?: string };
      video_files?: { link?: string; width?: number; height?: number; file_type?: string; quality?: string }[];
    }[];
  };

  const out: StockCandidate[] = [];
  for (const v of data.videos ?? []) {
    // Prefer the largest landscape mp4 file for this video.
    const files = (v.video_files ?? [])
      .filter((f) => f.file_type === "video/mp4" && (f.width ?? 0) >= 1280 && (f.width ?? 0) > (f.height ?? 1))
      .sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
    const best = files[0];
    if (!best?.link) continue;
    out.push({
      source: "pexels",
      url: best.link,
      width: best.width ?? v.width ?? 0,
      height: best.height ?? v.height ?? 0,
      durationSec: v.duration ?? 0,
      author: v.user?.name?.trim() || "Pexels creator",
      pageUrl: v.url || "https://www.pexels.com/videos/",
    });
  }
  return out;
}

/** Pixabay Video API — film = live-action footage (not animations). */
async function pixabaySearch(query: string, key: string): Promise<StockCandidate[]> {
  const url =
    `https://pixabay.com/api/videos/?key=${encodeURIComponent(key)}` +
    `&q=${encodeURIComponent(query)}&video_type=film&safesearch=true&per_page=24`;
  const data = (await fetchJson(url, {})) as {
    hits?: {
      pageURL?: string;
      duration: number;
      videos?: Record<string, { url?: string; width?: number; height?: number } | undefined>;
      user?: string;
    }[];
  };

  const out: StockCandidate[] = [];
  for (const hit of data.hits ?? []) {
    const entries = Object.values(hit.videos ?? {}).filter(
      (f): f is { url: string; width: number; height: number } =>
        Boolean(f?.url) && (f?.width ?? 0) >= 1280 && (f?.width ?? 0) > (f?.height ?? 1)
    );
    const best = entries.sort((a, b) => b.width - a.width)[0];
    if (!best) continue;
    out.push({
      source: "pixabay",
      url: best.url,
      width: best.width,
      height: best.height,
      durationSec: hit.duration ?? 0,
      author: hit.user?.trim() || "Pixabay creator",
      pageUrl: hit.pageURL || "https://pixabay.com/videos/",
    });
  }
  return out;
}

/**
 * One search round across the configured providers. Providers that fail
 * (bad key, rate limit, network) are skipped with a console note so a single
 * misconfigured source never blocks the other.
 */
export async function searchAll(query: string, keys: { pexels: string; pixabay: string }): Promise<StockCandidate[]> {
  const tasks: Promise<StockCandidate[]>[] = [];
  if (keys.pexels) tasks.push(pexelsSearch(query, keys.pexels).catch((e) => (console.warn(`[stock] pexels "${query}":`, e instanceof Error ? e.message : e), [])));
  if (keys.pixabay) tasks.push(pixabaySearch(query, keys.pixabay).catch((e) => (console.warn(`[stock] pixabay "${query}":`, e instanceof Error ? e.message : e), [])));
  if (tasks.length === 0) throw new Error("No stock provider is configured — add a free Pexels or Pixabay key in Settings → Stock footage");
  const results = await Promise.all(tasks);
  return results.flat();
}

// ---------- Scene → query derivation ----------
// The pure logic lives in stock-query.ts (unit-testable, DB-free).

/** Rough spoken duration of the scene's narration (a TTS refiner, not exact). */
function estimatedSceneDuration(scene: Scene): number {
  const words = scene.narration.split(/\s+/).filter(Boolean).length;
  return Math.max(4, words / 2.6);
}

/** Score a clip: HD landscape that covers the scene length wins. */
function scoreClip(c: StockCandidate, minDur: number): number {
  let score = 0;
  score += Math.min(c.width, 3840) / 100; // resolution up to 4K
  if (c.durationSec >= minDur) score += 60; // no looping needed
  else score += (c.durationSec / Math.max(minDur, 1)) * 30; // partial cover
  if (c.width >= 1920) score += 15;
  return score;
}

/**
 * VLM relevance check for a DOWNLOADED clip: extract one representative frame
 * and ask the vision model whether it shows the scene's required content.
 * pass === false → the caller rejects the clip and tries the next candidate.
 * Any failure (ffmpeg, VLM) resolves to pass: null — the clip is kept.
 */
async function clipFrameVerdict(
  videoId: string,
  scene: Scene
): Promise<{ pass: boolean | null; score: number | null; summary: string | null }> {
  const clipPath = path.join(videoDir(videoId), stockFile(scene.index));
  const framePath = path.join(videoDir(videoId), `stock-${String(scene.index).padStart(2, "0")}.frame.jpg`);
  try {
    await execFileAsync(
      "ffmpeg",
      [
        "-hide_banner", "-loglevel", "error",
        "-ss", "1", // settle past the opening fade-in most clips have
        "-i", clipPath,
        "-frames:v", "1",
        "-vf", "scale=640:-2",
        "-y", framePath,
      ],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }
    );
    if (!fs.existsSync(framePath) || fs.statSync(framePath).size < 1000)
      return { pass: null, score: null, summary: null };
    return await relevanceCheck(
      framePath,
      `stock b-roll for scene ${scene.index} "${scene.title}" of a story video — the clip must show: ${scene.visual} (mood: ${scene.mood}; narration at this moment: "${scene.narration.slice(0, 140)}")`
    );
  } catch {
    return { pass: null, score: null, summary: null };
  } finally {
    fs.rmSync(framePath, { force: true });
  }
}

/**
 * Find + download the best stock clip for one scene. Tries each query in
 * order until a usable candidate is found; downloaded clips must survive the
 * VLM relevance check. Returns null when nothing fits (the scene simply
 * keeps its Smart Motion art — never an error).
 */
async function fetchForScene(
  videoId: string,
  scene: Scene,
  keys: { pexels: string; pixabay: string },
  queries: string[]
): Promise<StockRef | null> {
  const minDur = estimatedSceneDuration(scene);

  for (const query of queries) {
    let candidates: StockCandidate[] = [];
    try {
      candidates = await searchAll(query, keys);
    } catch (err) {
      // Config/network errors surface on the first scene; per-scene they just
      // mean "no match this round".
      if (err instanceof Error && /No stock provider/.test(err.message)) throw err;
      continue;
    }

    const usable = candidates
      .filter((c) => c.width >= 1280 && c.height >= 720)
      .sort((a, b) => scoreClip(b, minDur) - scoreClip(a, minDur));

    for (const clip of usable.slice(0, 3)) {
      try {
        const ok = await downloadClip(videoId, scene.index, clip.url);
        if (!ok) continue;
        // Relevance gate — reject clips showing an unrelated subject and
        // fall through to the next candidate (fail-open on verdict: null).
        const verdict = await clipFrameVerdict(videoId, scene);
        if (verdict.pass === false) {
          fs.rmSync(path.join(videoDir(videoId), stockFile(scene.index)), { force: true });
          console.warn(
            `[stock] scene ${scene.index}: clip rejected — relevance ${verdict.score}/10 (${verdict.summary ?? "unrelated content"})`
          );
          continue;
        }
        return {
          source: clip.source,
          file: stockFile(scene.index),
          query,
          credit: `Footage by ${clip.author} (${clip.source === "pexels" ? "Pexels" : "Pixabay"})`,
          pageUrl: clip.pageUrl,
          durationSec: clip.durationSec,
        };
      } catch (err) {
        console.warn(`[stock] download failed for scene ${scene.index}:`, err instanceof Error ? err.message : err);
      }
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
    fs.writeFileSync(path.join(videoDir(videoId), stockFile(sceneIndex)), buf);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

export function stockFile(index: number): string {
  return `stock-${String(index).padStart(2, "0")}.mp4`;
}

export function readSceneStock(videoId: string, index: number): Buffer | null {
  if (!Number.isInteger(index) || index < 1 || index > 99) return null;
  const p = path.join(UPLOAD_ROOT, videoId, stockFile(index));
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p);
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
 * resumes where it stopped.
 */
export async function fetchStockForScenes(opts: {
  videoId: string;
  scenes: Scene[];
  force?: boolean;
  shouldCancel?: () => boolean;
  onProgress?: (done: number, total: number, label: string) => void;
  /** Per-scene override — used by the single-scene refetch endpoint. */
  onlyScene?: number;
}): Promise<StockRunResult> {
  const keys = await readStockKeys();
  const dir = videoDir(opts.videoId);
  let matched = 0;
  let fetched = 0;
  const missing: Scene[] = [];

  for (const scene of opts.scenes) {
    const hasFile =
      scene.stock != null &&
      fs.existsSync(path.join(dir, scene.stock.file)) &&
      fs.statSync(path.join(dir, scene.stock.file)).size > 200_000;
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

    const ref = await fetchForScene(opts.videoId, scene, keys, sceneQueries(scene));
    opts.onProgress?.(i + 1, missing.length, ref ? `Scene ${scene.index} matched` : `Scene ${scene.index} — no match found`);

    if (ref) {
      scene.stock = ref;
      matched++;
      fetched++;
    } else if (opts.force || opts.onlyScene != null) {
      // A forced refetch that finds nothing clears the stale ref so the badge
      // doesn't claim footage that was replaced/removed.
      scene.stock = undefined;
    }

    // Persist incrementally so a crash mid-run keeps finished scenes.
    await db.video.update({ where: { id: opts.videoId }, data: { scenes: JSON.stringify(opts.scenes) } });
    if (i < missing.length - 1) await sleep(1200); // pace both free APIs
  }

  return { matched, fetched, skipped: Math.max(opts.scenes.length - matched, 0) };
}

/** Remove all stock clips + refs (storyboard stays untouched). */
export async function clearStock(videoId: string, scenes: Scene[]): Promise<number> {
  const dir = videoDir(videoId);
  let cleared = 0;
  for (const scene of scenes) {
    if (scene.stock) {
      scene.stock = undefined;
      cleared++;
    }
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f === stockFile(scene.index)) fs.rmSync(path.join(dir, f), { force: true });
      }
    }
  }
  if (cleared > 0)
    await db.video.update({ where: { id: videoId }, data: { scenes: JSON.stringify(scenes) } });
  return cleared;
}
