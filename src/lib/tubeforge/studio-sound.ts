// studio-sound.ts — S5: the studio's SOUND catalog — the per-scene choices
// the Timeline Studio's inspector now drives.
//
// S4 gave the studio the clip's face (art actions); S5 gives it ears and a
// voice in the sound design. Until now the per-scene SFX cue and ambience bed
// were Director/script picks the studio could only MIX (level sliders) — the
// kinds were read-only labels, and although the timeline doc carried
// `audio.sfx.kind` / `audio.ambient.kind`, the render read its kinds from the
// plan/row only. The studio's kind pick would have been a lie.
//
// This module is the one vocabulary both sides call, so they can never
// disagree (the S2/S3 choke-point doctrine):
//   • the STUDIO normalizes on load and writes through these sanitizers;
//   • the RENDER re-sanitizes at the extraction choke point (timeline.ts)
//     and resolves precedence with resolveSoundChoice;
//   • the audition ROUTE gates its `bank`/`kind` params with resolveSoundBank
//     + sanitizeSoundKind before any disk/ffmpeg work.
//
// PURE on purpose: no imports, no fs, no db — the client component and the
// server adapter both pull this file. The id lists below mirror the
// synthesizers' catalogs (types.ts SFX_KINDS / ambience.ts RECIPES); the S5
// unit probe pins the two sides to exact equality so they can never drift.

// ---------- catalogs ----------

export interface SoundChoice {
  /** The id persisted in the doc (audio.sfx.kind / audio.ambient.kind). */
  id: string;
  /** Short UI label. */
  label: string;
  /** One-line character note — what the sound reads as, in the mix. */
  note: string;
  /** The level the studio seeds when picking this sound from "none"
   *  (mirrors the render's own defaults — SFX_LEVEL / ambience 0.10). */
  defaultLevel: number;
}

/** Per-scene SFX cues (synthesized in sfx.ts — royalty-free by construction;
 *  every sound LOW and DARK, fast decay, never stepping on the narration). */
export const SFX_CATALOG: readonly SoundChoice[] = [
  { id: "whoosh", label: "Whoosh", note: "Airy pass-by — transitions, reveals of motion", defaultLevel: 0.35 },
  { id: "boom", label: "Boom", note: "Pitch-dropping body — openers and hard reveals", defaultLevel: 0.55 },
  { id: "riser", label: "Riser", note: "Tension climb into a cut or a payoff line", defaultLevel: 0.4 },
  { id: "sting", label: "Sting", note: "Cinematic braam — twists and rehooks", defaultLevel: 0.45 },
] as const;

/** Per-scene ambience beds (synthesized in ambience.ts — 60 s loops that sit
 *  UNDER the voice; nothing bright above ~1.2 kHz). */
export const AMBIENCE_CATALOG: readonly SoundChoice[] = [
  { id: "room", label: "Room tone", note: "Interior silence with a floor — interiors of every kind", defaultLevel: 0.1 },
  { id: "city", label: "City", note: "Distant traffic rumble, slowly surging", defaultLevel: 0.1 },
  { id: "rain", label: "Rain", note: "Steady interior rain-on-glass bed", defaultLevel: 0.1 },
  { id: "wind", label: "Wind", note: "Brown noise breathing — open, exposed places", defaultLevel: 0.1 },
  { id: "waves", label: "Waves", note: "Shoreline swells on a ~10 s period", defaultLevel: 0.1 },
  { id: "crowd", label: "Crowd", note: "Two out-of-phase layers — a crowd never breathes as one", defaultLevel: 0.1 },
  { id: "nature", label: "Nature", note: "Open air — a gentle low bed under an airy shelf", defaultLevel: 0.1 },
] as const;

export type SoundBank = "sfx" | "ambience";

/** The catalog a bank resolves to (the inspector and the audition route). */
export function soundCatalog(bank: SoundBank): readonly SoundChoice[] {
  return bank === "sfx" ? SFX_CATALOG : AMBIENCE_CATALOG;
}

/** The catalog entry for a persisted kind (null = unknown / "none"). */
export function soundChoice(
  kind: string | null | undefined,
  bank: SoundBank
): SoundChoice | null {
  if (typeof kind !== "string") return null;
  return soundCatalog(bank).find((c) => c.id === kind) ?? null;
}

// ---------- sanitizers (the doc boundary) ----------

/**
 * Accept anything a persisted doc (or a hostile client) may carry and return
 * either a clean catalog id or null. Null is "no override — the plan's pick
 * wins"; it is ALSO the honest rendering of the user's explicit "none" pick,
 * because the render's no-override path IS no sound. Whitespace and case are
 * normalized; the script LLM's "none"/"off"/"" spellings collapse to null.
 */
export function sanitizeSoundKind(value: unknown, catalog: readonly SoundChoice[]): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (!v || v === "none" || v === "off") return null;
  return catalog.some((c) => c.id === v) ? v : null;
}

/** SFX cue kind from a doc/plan/row value — catalog id or null. */
export function sanitizeSfxKind(value: unknown): string | null {
  return sanitizeSoundKind(value, SFX_CATALOG);
}

/** Ambience bed kind from a doc/plan/row value — catalog id or null. */
export function sanitizeAmbienceKind(value: unknown): string | null {
  return sanitizeSoundKind(value, AMBIENCE_CATALOG);
}

// ---------- precedence (the render's one rule) ----------

/**
 * The ONE precedence rule, shared by the render and pinned by the probe:
 * the studio's doc pick wins; null falls back to the plan's pick; null again
 * means "no sound" (the classic behavior). The plan kind is sanitized here
 * too — a plan row is data, never trusted (the S4 payload doctrine).
 */
export function resolveSoundChoice(
  docKind: unknown,
  fallbackKind: unknown,
  catalog: readonly SoundChoice[]
): string | null {
  const doc = sanitizeSoundKind(docKind, catalog);
  if (doc !== null) return doc;
  return sanitizeSoundKind(fallbackKind, catalog);
}

// ---------- request gate (the audition route's params) ----------

/**
 * The audition route's `bank` param — accept anything the query string may
 * carry; return the bank id or null (→ 400). Never let a hostile param pick
 * a path: the route maps the bank onto exactly one synthesizer.
 */
export function resolveSoundBank(value: unknown): SoundBank | null {
  if (value === "sfx" || value === "ambience") return value;
  return null;
}
