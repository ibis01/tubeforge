// Scene → stock-search query derivation. Pure string logic — DB-free and
// I/O-free so the offline unit suite can regression-test it without loading
// providers (see scripts/test-unit.ts, "stock queries" suite).

import type { Scene } from "./types";

const STOP_WORDS = new Set(
  ("a an the and or but of in on at to for with from by as is are was were be been being this that these those " +
    "his her its their our your my one two very more most much many some any no not into onto over under above " +
    "below through during before after while then than so such only own same too also just about against between " +
    "it he she they we you i who whom which what where when why how all each few other another both each own " +
    "scene shot view frame close wide angle lens camera looking showing depicts shows standing sitting walking " +
    "setting place time day night action wearing holds holding dramatic cinematic")
    .split(" ")
);

/** Content words of a phrase, longest-first, deduped. */
export function contentWords(text: string, limit: number): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)]
    .sort((a, b) => b.length - a.length)
    .slice(0, limit);
}

/**
 * 2-4 search queries for a scene, most-specific first:
 *   1. the visual prompt's subject words (nouns dominate: "lighthouse cliff storm waves")
 *   2. the narration's content words — the SPOKEN text carries the concrete
 *      subject and specifics ("wall street crash October") that art-direction
 *      prose sometimes omits
 *   3. the scene title words
 *   4. a two-word tightening of query 1 (broadens the net)
 */
export function sceneQueries(scene: Scene): string[] {
  const queries: string[] = [];
  const fromVisual = contentWords(scene.visual, 4);
  if (fromVisual.length >= 2) queries.push(fromVisual.join(" "));
  const fromNarration = contentWords(scene.narration, 5);
  if (fromNarration.length >= 2) queries.push(fromNarration.join(" "));
  const fromTitle = contentWords(scene.title, 3);
  if (fromTitle.length >= 2) queries.push(fromTitle.join(" "));
  if (fromVisual.length >= 3) queries.push(fromVisual.slice(0, 2).join(" "));
  return [...new Set(queries)].slice(0, 4);
}
