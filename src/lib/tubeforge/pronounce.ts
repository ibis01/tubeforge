// Per-user pronunciation overrides (Stage 4b, T-4.11).
//
// A word→say-as map applied at the single TTS synthesis choke point
// (providers/tts.ts ttsSynthesize), so every flow inherits it: the classic
// full-script voiceover, per-scene story narration, cloned voices and the
// ▶ picker previews. Longest match wins ("Colonel Sanders" before "Colonel");
// matching is case-insensitive on word boundaries.
//
// Storage: one UserSetting row (key voice.pronunciations) holding a JSON
// array of { from, to }. The dedicated /api/voices/pronunciations route owns
// validation; nothing else reads or writes this key.

import { getUserSetting, setUserSetting } from "./settings";
import { currentCtx } from "./tenant";

export const PRONUNCIATION_KEY = "voice.pronunciations";
export const MAX_PRONUNCIATIONS = 100;

export interface PronunciationEntry {
  from: string;
  to: string;
}

/** TTL cache — synthesis happens per scene/per chunk; one DB read per render
 *  would be wasteful. 30s, cross-process safe (worst case: another process's
 *  worker picks a fresh map half a minute later). */
const CACHE_TTL_MS = 30_000;
const cache = new Map<string, { at: number; pairs: [string, string][] }>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest "from" first so multi-word entries win over their prefixes. */
export function sortPairs(entries: PronunciationEntry[]): [string, string][] {
  return entries
    .filter((e) => e.from && e.to)
    .map((e) => [e.from, e.to] as [string, string])
    .sort((a, b) => b[0].length - a[0].length);
}

/** Parse + shape-check the stored JSON (corrupt rows degrade to empty). */
export function parseStoredPronunciations(raw: string | null): PronunciationEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: PronunciationEntry[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue;
      const from = String((item as { from?: unknown }).from ?? "").trim();
      const to = String((item as { to?: unknown }).to ?? "").trim();
      if (from && to && from.length <= 60 && to.length <= 200) out.push({ from, to });
    }
    return out.slice(0, MAX_PRONUNCIATIONS);
  } catch {
    return [];
  }
}

/** Load the acting user's pairs. FAILS OPEN: a settings hiccup (or a null
 *  tenant context, e.g. exotic boot paths) must never break synthesis —
 *  the narration just renders without substitutions. */
export async function loadPronunciations(): Promise<[string, string][]> {
  try {
    const ctx = currentCtx();
    const cacheKey = ctx ? `${ctx.organizationId}:${ctx.userId ?? "-"}` : "-";
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.pairs;

    const pairs = sortPairs(parseStoredPronunciations(await getUserSetting(PRONUNCIATION_KEY)));
    cache.set(cacheKey, { at: Date.now(), pairs });
    return pairs;
  } catch {
    return [];
  }
}

/** Call after a save so the SAME process picks the new map immediately
 *  (other processes rely on the TTL). */
export function invalidatePronunciations(): void {
  cache.clear();
}

/** Save the validated list (the route normalizes before calling). */
export async function savePronunciations(entries: PronunciationEntry[]): Promise<void> {
  await setUserSetting(PRONUNCIATION_KEY, JSON.stringify(entries.slice(0, MAX_PRONUNCIATIONS)));
  invalidatePronunciations();
}

/** Apply the map to a piece of narration text. Word-boundary, case-insensitive;
 *  longest "from" first. The replacement is typed exactly as the user wrote it. */
export function applyPronunciations(
  text: string,
  pairs: [string, string][]
): string {
  if (!pairs.length || !text) return text;
  let out = text;
  for (const [from, to] of pairs) {
    if (!from) continue;
    try {
      out = out.replace(new RegExp(`\\b${escapeRegExp(from)}\\b`, "gi"), to);
    } catch {
      /* a pathological entry must never break synthesis */
    }
  }
  return out;
}
