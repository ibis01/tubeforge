// S49 — Islamic visual protection: the restricted-subjects policy.
//
// DOCTRINE (docs/design/s48-s49-schema.md §3): in "islamic-history" content
// policy mode, TubeForge must NEVER paint a face (or figure) of the restricted
// subjects — the Prophet Muhammad ﷺ first, then the Ten Promised Paradise, the
// Prophet's family, the Quranic prophets, the angels, and God. Enforcement is
// SYSTEM-LEVEL and LAYERED, because no single layer is trusted alone:
//
//   L1 compose  — story.ts script pass: policy rules in the VISUAL RULES so
//                 scenes are composed AROUND restricted subjects from the start
//   L2 direct   — director.ts pass: policy overlay in the system prompt + the
//                 persisted plan's shot prompts sanitized, with a visible
//                 activity note, BEFORE the human approves
//   L3 paint    — story.ts generateSceneImage + shots.ts ensureShotImages: the
//                 last line before pixels — sentence-level substitution + the
//                 hard negative clause (+ ImageRequest.negativePrompt where the
//                 provider supports one)
//   L4 verify   — runRestrictedVisualScan: a DENSE frame grid from the
//                 rendered final.mp4 — a local face-detection tripwire plus
//                 batched VLM judgment — emitted as the QC check
//                 "restricted-visual" (S55 T-55.4; the S49 8-frame even
//                 sample could not see between its samples)
//   L5 gate     — qc-policy.ts: severity BLOCK — fail OR unmeasured holds
//                 export/publish like every other blocking check; the existing
//                 audited human override remains the escape hatch
//
// The ASYMMETRIC-RISK RULE governs false positives: over-matching costs a
// substituted composition (visible, human-reviewable); under-matching costs
// exactly the harm this policy exists to prevent. Depicting the mushaf,
// mosques, calligraphy and anonymous distant crowds remains allowed.
//
// Pure policy vocabulary + detector: no fs/db imports below the scan section.

import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { aiCall } from "./budget";
import { llmVision } from "./llm";
import { parseJsonLoose } from "./ai";
import { errorText } from "./redact";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Policy ids + resolver
// ---------------------------------------------------------------------------

export type ContentPolicyId = "standard" | "islamic-history";

export const CONTENT_POLICY_IDS: readonly ContentPolicyId[] = [
  "standard",
  "islamic-history",
];

export interface ContentPolicy {
  id: ContentPolicyId;
  label: string;
  description: string;
}

export const CONTENT_POLICIES: Record<ContentPolicyId, ContentPolicy> = {
  standard: {
    id: "standard",
    label: "Standard",
    description: "No subject restrictions (today's behavior).",
  },
  "islamic-history": {
    id: "islamic-history",
    label: "Islamic history",
    description:
      "No facial or bodily depiction of the Prophet Muhammad ﷺ, his family, the Ten Companions promised Paradise, the Quranic prophets, the angels, or God — compose around them with calligraphy, architecture, artifacts, light and landscape. Verified visually before export.",
  },
};

/** Snap anything to a real policy id; unknown/absent/garbage → "standard"
 * (the fail-open direction is safe: restrictions never silently ACTIVATE,
 * and activation is a deliberate human choice recorded on the video row). */
export function resolveContentPolicy(raw: string | null | undefined): ContentPolicyId {
  return (raw ?? "").trim().toLowerCase() === "islamic-history"
    ? "islamic-history"
    : "standard";
}

// ---------------------------------------------------------------------------
// The restricted-subject registry (islamic-history)
// ---------------------------------------------------------------------------

export interface RestrictedEntry {
  /** Canonical label for human-facing notes. */
  id: string;
  /** Lowercase match phrases; matched on word boundaries, case-insensitive. */
  aliases: string[];
  /** One-line composition guidance for the substitution/overlay. */
  note: string;
}

export const ISLAMIC_HISTORY_REGISTRY: readonly RestrictedEntry[] = [
  {
    id: "the Prophet Muhammad ﷺ",
    aliases: [
      "muhammad", "muhammed", "mohammed", "mohammad", "muhamad", "mohamed",
      "rasulullah", "rasul allah", "rasool allah", "the messenger of allah",
      "the holy prophet", "the prophet muhammad", "the prophet", "the messenger",
      "seal of the prophets", "habibullah",
    ],
    note: "never depicted — not as a face, silhouette, light-figure or out-of-frame presence; compose around the MOMENT (the cave, the light, the setting)",
  },
  // The Ten promised Paradise (al-ʿashara al-mubashshara).
  { id: "Abu Bakr", aliases: ["abu bakr", "abu bakr al-siddiq", "al-siddiq"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Umar ibn al-Khattab", aliases: ["umar", "omar", "umar ibn al-khattab", "umar ibn khattab", "caliph umar"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Uthman ibn Affan", aliases: ["uthman", "usman", "uthman ibn affan"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Ali ibn Abi Talib", aliases: ["ali", "ali ibn abi talib", "ali ibn abu talib", "imam ali", "caliph ali"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Talha ibn Ubaydullah", aliases: ["talha", "talha ibn ubaydullah"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Zubayr ibn al-Awwam", aliases: ["zubayr", "al-zubayr", "zubayr ibn al-awwam"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Abd al-Rahman ibn Awf", aliases: ["abd al-rahman ibn awf", "abdul rahman ibn awf", "abdur rahman ibn awf"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Sa'd ibn Abi Waqqas", aliases: ["sa'd ibn abi waqqas", "saad ibn abi waqqas"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Sa'id ibn Zayd", aliases: ["sa'id ibn zayd", "saeed ibn zayd"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Abu Ubaydah ibn al-Jarrah", aliases: ["abu ubaydah", "abu ubaidah", "abu ubaydah ibn al-jarrah"], note: "not depicted — compose around the moment's setting and artifacts" },
  // The Prophet's family.
  { id: "Khadijah", aliases: ["khadijah", "khadija"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Fatimah", aliases: ["fatimah", "fatima", "fatimah al-zahra"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Aisha", aliases: ["aisha", "a'isha", "ayesha"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Hasan and Husayn", aliases: ["hasan", "husayn", "hussain", "imam hasan", "imam husayn", "ahl al-bayt", "the prophet's family", "the prophet's household"], note: "not depicted — compose around the moment's setting and artifacts" },
  // Angels (never depicted in mainstream Islamic media).
  { id: "the angels", aliases: ["jibril", "jibreel", "gabriel", "mikail", "mika'il", "michael", "israfil", "israfeel", "munkar", "nakir", "the angel of death", "angel malik", "the angels", "an angel", "archangel"], note: "never depicted — convey the divine through light, motion of the scene, and reverent atmosphere, never a figure" },
  // God.
  { id: "God (Allah)", aliases: ["allah", "god"], note: "never depicted or anthropomorphized — convey the divine through light and atmosphere only" },
  // The Quranic prophets (restricted as a class; conservative default).
  { id: "Adam", aliases: ["adam", "prophet adam"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Idris", aliases: ["idris", "prophet idris"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Nuh", aliases: ["nuh", "noah"], note: "not depicted — the ark, the flood, the mountain carry the story" },
  { id: "Hud", aliases: ["hud", "prophet hud"], note: "not depicted — the sandstorm and the pillars carry the story" },
  { id: "Salih", aliases: ["salih", "saleh"], note: "not depicted — the she-camel and the carved cliff dwellings carry the story" },
  { id: "Ibrahim", aliases: ["ibrahim", "abraham", "khalilullah"], note: "not depicted — the Kaaba he built, the fire, the unflinching faith carry the story" },
  { id: "Lut", aliases: ["lut", "prophet lut"], note: "not depicted — the cities and the judgment carry the story" },
  { id: "Ismail", aliases: ["ismail", "isma'il", "ishmael"], note: "not depicted — the well of Zamzam and the sacrifice's setting carry the story" },
  { id: "Ishaq", aliases: ["ishaq", "isaac"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Yaqub", aliases: ["yaqub", "ya'qub", "jacob"], note: "not depicted — the coat, the wells, the reunion's setting carry the story" },
  { id: "Yusuf", aliases: ["yusuf", "yousef", "joseph"], note: "not depicted — the well, the palace, the dream imagery carry the story" },
  { id: "Ayyub", aliases: ["ayyub", "prophet ayyub", "prophet job"], note: "not depicted — patience and recovery conveyed through setting and artifacts" },
  { id: "Shu'ayb", aliases: ["shu'ayb", "shuaib", "jethro"], note: "not depicted — the markets of Madyan and the mountain carry the story" },
  { id: "Musa", aliases: ["musa", "moses"], note: "not depicted — the staff, the sea, the mountain carry the story" },
  { id: "Harun", aliases: ["harun", "aaron"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Dawud", aliases: ["dawud", "david"], note: "not depicted — the sling, the psalms' calligraphy, the throne carry the story" },
  { id: "Sulayman", aliases: ["sulayman", "sulaiman", "solomon"], note: "not depicted — the ring, the throne, the wind and the jinn's works carry the story" },
  { id: "Ilyas", aliases: ["ilyas", "elijah"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "al-Yasa", aliases: ["al-yasa", "elyasa", "elisha"], note: "not depicted — compose around the moment's setting and artifacts" },
  { id: "Yunus", aliases: ["yunus", "jonah"], note: "not depicted — the whale, the deep, the shade of the gourd carry the story" },
  { id: "Zakariya", aliases: ["zakariya", "zachariah", "zechariah"], note: "not depicted — the prayer niche and the mihrab carry the story" },
  { id: "Yahya", aliases: ["yahya", "john the baptist"], note: "not depicted — the river and the wilderness carry the story" },
  { id: "Isa", aliases: ["isa", "jesus", "christ"], note: "not depicted — the cradle, the olives, the healing light carry the story" },
  // Collectives of revered figures (conservative default; the L1 rules steer
  // the script away from these compositions anyway).
  { id: "the Companions (collectively)", aliases: ["the companions", "the sahaba", "sahaba"], note: "not depicted as identifiable individuals — distant anonymous crowds only, or compose around the setting" },
];

// ---------------------------------------------------------------------------
// The detector — word-boundary, case-insensitive, one compiled regex.
// ---------------------------------------------------------------------------

export interface PolicyMatch {
  entry: string; // canonical id
  alias: string; // the phrase that hit
}

function compileAliases(entries: readonly RestrictedEntry[]): { re: RegExp; byAlias: Map<string, string> } {
  const byAlias = new Map<string, string>();
  const escaped: string[] = [];
  for (const e of entries) {
    for (const a of e.aliases) {
      if (byAlias.has(a)) continue; // first entry wins on shared aliases
      byAlias.set(a, e.id);
      escaped.push(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    }
  }
  // Longest-first alternation so "the prophet muhammad" beats "muhammad" and
  // "abu ubaydah ibn al-jarrah" beats "abu ubaydah" (the reported alias is
  // the most specific one that matched).
  escaped.sort((a, b) => b.length - a.length);
  // The trailing lookahead EXCLUDES possessives: "the Prophet's mosque",
  // "Muhammad's cloak" — a restricted name in possessive form names an
  // ARTIFACT or PLACE associated with the figure (mainstream Islamic media
  // paints those freely; our own alternative-composition library leans on
  // them), not the figure on screen. The person-depicting cases ("the Prophet
  // stands…", "Muhammad receives…") still match. Pixel-level verification
  // (L4) backstops anything a possessive phrasing smuggles through.
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(${escaped.join("|")})(?![\\p{L}\\p{N}]|['\u2019]s)`, "giu");
  return { re, byAlias };
}

const ISLAMIC_DETECT = compileAliases(ISLAMIC_HISTORY_REGISTRY);

/** Scan text for restricted-subject mentions under a policy. Pure, fast. */
export function scanRestrictedSubjects(
  text: string,
  policy: ContentPolicyId
): PolicyMatch[] {
  if (policy !== "islamic-history" || !text) return [];
  const hits: PolicyMatch[] = [];
  for (const m of text.matchAll(ISLAMIC_DETECT.re)) {
    const alias = m[1].toLowerCase();
    const entry = ISLAMIC_DETECT.byAlias.get(alias);
    if (entry && !hits.some((h) => h.entry === entry && h.alias === alias)) {
      hits.push({ entry, alias });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// The alternative-composition clause library (what replaces a restricted
// sentence). Deterministic per-sentence pick (hash) so consecutive sentences
// vary; every clause is person-free by construction.
// ---------------------------------------------------------------------------

export const ALTERNATIVE_COMPOSITIONS: readonly string[] = [
  "gilded Arabic calligraphy of the moment's key phrase on aged parchment, lamplight catching the gold leaf",
  "the quiet interior of a cave of light — bare stone, one shaft of dawn, no person present",
  "the Kaaba's black kiswah catching first light, the courtyard empty and still",
  "the Prophet's mosque at Medina — palm-trunk columns and a sunlit courtyard, empty of people",
  "a desert caravan cresting distant dunes under a rising moon, faces far and indistinct",
  "an open mushaf on a carved wooden rehal, a reed pen resting beside it in soft lamplight",
  "incense smoke rising through a beam of light in a quiet prayer hall",
  "weathered hands copying manuscript lines with a reed pen — no face visible",
  "the oasis seen from afar: palm groves silver in twilight, mud-brick walls glowing",
  "rain-washed cobblestones of an old souq at dawn, shutters closed, no one in sight",
  "a single oil lamp burning before an ornate mihrab, its niche of glazed tile",
  "the desert night sky wheeling over black dunes, stars sharp above the silence",
];

function hashPick(seed: string, count: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % count;
}

/** The hard negative clause appended to EVERY image prompt under the policy —
 * the belt under the L3 suspenders; providers that take a negative prompt
 * receive it as ImageRequest.negativePrompt too. */
export function policyNegativeClause(policy: ContentPolicyId): string {
  if (policy !== "islamic-history") return "";
  return (
    "Absolutely no depiction of the Prophet Muhammad, his family, the Companions, " +
    "the prophets, the angels, or God — no faces, figures, silhouettes or light-bodies " +
    "of revered religious figures anywhere in frame; the moment is conveyed through " +
    "architecture, calligraphy, artifacts, light and landscape only."
  );
}

export interface SanitizeResult {
  prompt: string;
  /** Every restricted mention found in the input (entry + the phrase). */
  matches: PolicyMatch[];
  /** How many sentences were substituted. */
  substituted: number;
}

/**
 * L3 — the last line before pixels. Sentences naming a restricted figure are
 * REPLACED by a deterministic alternative-composition clause (never merely
 * deleted — a hole where a person was described reads as an error); the hard
 * negative clause is appended to every in-policy prompt. Standard policy is
 * the identity transform. Pure.
 *
 * opts.appendNegative: set false for short metadata fields (e.g. a shot's
 * `subject`) that need the SUBSTITUTION but must not carry the full negative
 * clause — the clause rides the generation prompt, not every string.
 */
export function sanitizePromptForPolicy(
  prompt: string,
  policy: ContentPolicyId,
  opts: { appendNegative?: boolean } = {}
): SanitizeResult {
  const appendNegative = opts.appendNegative !== false;
  if (policy !== "islamic-history" || !prompt) {
    return { prompt, matches: [], substituted: 0 };
  }
  const matches = scanRestrictedSubjects(prompt, policy);
  const suffix = appendNegative ? ` ${policyNegativeClause(policy)}`.trim() : "";
  if (matches.length === 0) {
    return { prompt: `${prompt}${suffix ? ` ${suffix}` : ""}`.trim(), matches, substituted: 0 };
  }
  // Sentence split on terminal punctuation + whitespace. Prompt text is
  // simple prose; decimals ("f/1.8", "2.5s") never split because the period
  // is not followed by whitespace there.
  const sentences = prompt.split(/(?<=[.!?])\s+/);
  let substituted = 0;
  const out = sentences.map((s) => {
    if (scanRestrictedSubjects(s, policy).length === 0) return s;
    substituted += 1;
    return ALTERNATIVE_COMPOSITIONS[hashPick(s, ALTERNATIVE_COMPOSITIONS.length)];
  });
  return {
    prompt: `${out.join(" ")}${suffix ? ` ${suffix}` : ""}`.trim(),
    matches,
    substituted,
  };
}

// ---------------------------------------------------------------------------
// L1/L2 — the policy's prompt overlays.
// ---------------------------------------------------------------------------

/** Rules appended to the SCRIPT pass's VISUAL RULES (L1): compose around. */
export function policyVisualRules(policy: ContentPolicyId): string {
  if (policy !== "islamic-history") return "";
  return [
    "- ISLAMIC VISUAL PROTECTION (content policy): the visuals must NEVER place the Prophet Muhammad, his family, the Companions, the prophets, the angels, or God on screen — no faces, figures, silhouettes or symbolic light-bodies.",
    "- Compose AROUND these subjects instead: calligraphy, sacred architecture (the Kaaba, the Prophet's mosque, mihrabs), artifacts (the mushaf on its rehal, a reed pen, a mantle), light and atmosphere, landscape, or anonymous distant crowds whose faces are indistinct.",
    "- The NARRATION may name and honor them freely — only the visual field composes around; never let the visual description read as depicting them.",
  ].join("\n");
}

/** The director-pass system overlay (L2): the same doctrine, shot-level. */
export function policySystemOverlay(policy: ContentPolicyId): string {
  if (policy !== "islamic-history") return "";
  return [
    "CONTENT POLICY — ISLAMIC VISUAL PROTECTION: this production never depicts the Prophet Muhammad, his family, the Companions, the prophets, the angels, or God. No face, figure, silhouette or light-body of a revered religious figure may appear in any shot's imagePrompt or subject.",
    "Direct AROUND them: calligraphy, sacred architecture, artifacts, light, landscape, anonymous distant crowds. The shot list serves the story exactly as well without ever putting a revered figure on screen — the narration carries them.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// L4 — the restricted visual scan (S55 T-55.4: the dense rewrite).
//
// The S49 original sampled 8 frames evenly: a 60s render carried a 7.5s mean
// gap, so a 1-3s flash of a restricted figure between samples read "pass" —
// the audit's core safety point (sparse sampling cannot guarantee a brief
// violation between frames is caught). The scan now runs a three-stage
// funnel, fail-closed at every seam:
//
//   stage 1  dense grid    — one frame per 0.50s (2 fps), capped at 240, so
//                            the LOCAL machinery sees the whole timeline.
//                            Longer videos coarsen the interval honestly
//                            (240 frames max) and the coverage note says so.
//   stage 2  face tripwire — python3 + OpenCV haar cascades when the host
//                            has them (probed per scan): frames carrying a
//                            face ≥ RESTRICTED_FACE_MIN_AREA_FRAC of frame
//                            area force themselves + immediate neighbors
//                            into the judge set (top anchors by area). A
//                            missing detector DEGRADES resolution (noted in
//                            the detail), never the verdict — the judge
//                            still measures every frame it is shown. Faces
//                            are a tripwire, not a verdict: anonymous people
//                            are allowed content; the VLM decides reverence.
//   stage 3  VLM judge     — ≤ RESTRICTED_VLM_MAX_FRAMES frames in batches
//                            of RESTRICTED_VLM_BATCH, labeled with GLOBAL
//                            frame numbers + timestamps, temperature 0. The
//                            first failing batch short-circuits (a fail
//                            already blocks export — more calls buy nothing
//                            the human can use); any unreadable batch makes
//                            the whole scan unmeasured (fail-closed, never
//                            silently clean).
//
// The coverage is REPORTED (grid size, interval, tripwire hits, batches run)
// so the human reads the scan's actual resolution, not a bare "pass".
// ---------------------------------------------------------------------------

/** The VLM judge's system prompt. */
export const RESTRICTED_VISUAL_SYSTEM = `You are a visual-content compliance checker for an Islamic-history video production. You will see sampled frames from a rendered video. The production's content policy forbids DEPICTING revered religious figures — the Prophet Muhammad, his family, the Companions, the prophets, the angels, or God — as faces, figures, silhouettes or symbolic light-bodies.

Report a violation ONLY when a frame presents a human face or figure AS a revered religious figure — for example a haloed or light-crowned central figure, a figure the composition venerates, an angel with wings, or a figure clearly standing in for a named prophet. Ordinary anonymous people (a merchant, a scribe's hands, a distant crowd with indistinct faces), calligraphy, architecture, artifacts and landscapes are NOT violations.

Respond with STRICT JSON only: {"depicted": true|false, "frames": [<the frame numbers as labeled>], "note": "<one short sentence>"} — "depicted" false with empty frames when every frame complies.`;

export interface RestrictedScanOutcome {
  status: "pass" | "fail" | "unmeasured";
  value: string;
  detail?: string;
}

// ---- the dense-scan constants (unit-pinned via the pure planners below) ----

/** The local grid rate: one frame per 0.50s of timeline. */
export const RESTRICTED_DENSE_FPS = 2;
/** The grid cap — longer videos coarsen the interval (240 frames ≈ 2 min at
 * 0.50s), and the coverage note discloses the coarsened interval. */
export const RESTRICTED_DENSE_MAX_FRAMES = 240;
/** Frames per VLM call — the judge's reliable attention span (the S49 law). */
export const RESTRICTED_VLM_BATCH = 8;
/** Total frames the VLM judges (≤ ceil(48/8) = 6 calls per scan — bounded,
 * spend-honest; the dense grid below it is free). */
export const RESTRICTED_VLM_MAX_FRAMES = 48;
/** Face-tripwire anchors forced into the judge set (largest faces first). */
export const RESTRICTED_FACE_MAX_ANCHORS = 12;
/** A face at ≥1.5% of frame area is a real on-screen presence (mid-shot or
 * closer); distant anonymous crowds — allowed content — sit far below. */
export const RESTRICTED_FACE_MIN_AREA_FRAC = 0.015;

/** The dense-grid plan for a duration: the extraction fps + frame count,
 * coarsened at the cap. Pure (unit-pinned). */
export function planDenseGrid(durationSec: number): { fps: number; count: number } {
  const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1;
  const fps = Math.min(RESTRICTED_DENSE_FPS, RESTRICTED_DENSE_MAX_FRAMES / dur);
  const count = Math.max(1, Math.min(RESTRICTED_DENSE_MAX_FRAMES, Math.floor(dur * fps)));
  return { fps, count };
}

/** Which dense-grid frames (0-based indices) the VLM judges: the forced
 * (tripwire) frames keep their seats, an even grid fills the rest, and a
 * largest-gap top-up lands EXACTLY the cap (every seat is a chance to catch
 * a flash) whenever the grid has that many frames. Pure (unit-pinned). */
export function selectVlmFrames(
  denseCount: number,
  forced: readonly number[],
  max: number = RESTRICTED_VLM_MAX_FRAMES
): number[] {
  const n = Math.max(0, Math.floor(denseCount));
  if (n === 0) return [];
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const clean = [...new Set(forced)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < n)
    .sort((a, b) => a - b)
    .slice(0, max);
  const picks = new Set<number>(clean);
  const fill = Math.max(0, max - clean.length);
  if (fill === 1) {
    picks.add(Math.floor((n - 1) / 2));
  } else if (fill >= 2) {
    for (let k = 0; k < fill; k++) {
      picks.add(Math.round((k * (n - 1)) / (fill - 1)));
    }
  }
  // The top-up: even-grid points that collide with forced seats open gaps —
  // close them with the frame FARTHEST from everything already picked (ties
  // → the lower index), until the cap or the grid runs out. Deterministic.
  while (picks.size < max && picks.size < n) {
    let bestIdx = -1;
    let bestDist = -1;
    for (let i = 0; i < n; i++) {
      if (picks.has(i)) continue;
      let dist = Infinity;
      for (const p of picks) {
        const d = Math.abs(i - p);
        if (d < dist) dist = d;
      }
      if (dist > bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    if (bestIdx < 0 || bestDist <= 0) break;
    picks.add(bestIdx);
  }
  return [...picks].sort((a, b) => a - b);
}

/** One batch's judged outcome (global 1-based frame labels). */
export interface RestrictedBatchOutcome {
  status: "pass" | "fail" | "unmeasured";
  frames: number[];
  note: string;
}

/** The batch aggregation law (pure, unit-pinned): the first failing batch
 * wins (the scan short-circuits at the call site), any unreadable batch is
 * unmeasured — pass ONLY when every batch measured clean. */
export function restrictedVerdictFromBatches(
  batches: readonly RestrictedBatchOutcome[]
): { status: "pass" | "fail" | "unmeasured"; frames: number[]; note: string } {
  if (batches.length === 0) {
    return { status: "unmeasured", frames: [], note: "no batches judged" };
  }
  const failed = batches.find((b) => b.status === "fail");
  if (failed) return { status: "fail", frames: failed.frames, note: failed.note };
  const unmeasured = batches.find((b) => b.status === "unmeasured");
  if (unmeasured) return { status: "unmeasured", frames: [], note: unmeasured.note };
  const notes = [...new Set(batches.map((b) => b.note).filter(Boolean))];
  return { status: "pass", frames: [], note: notes.join(" · ").slice(0, 200) };
}

// ---- the face tripwire (python3 + OpenCV, probed per scan) ----

/** The tripwire script: prints ONE JSON line — {"available": false, …} when
 * the host has no cv2/cascades (degradation, not failure), else the frames
 * (0-based, file order) whose largest detected face covers ≥ minAreaFrac of
 * the frame. Frontal + profile cascades; the even grid backstops silhouettes
 * and light-bodies (haar sees faces only — the documented margin). Exported
 * so the unit suite judges the very bytes the scan writes. */
export const FACE_TRIPWIRE_PY = `
import json, os, sys
try:
    import cv2
except Exception as e:
    print(json.dumps({"available": False, "reason": "no cv2 (%s)" % type(e).__name__}))
    sys.exit(0)
d = sys.argv[1]
min_frac = float(sys.argv[2])
cascades = []
for name in ("haarcascade_frontalface_alt2.xml", "haarcascade_profileface.xml"):
    p = os.path.join(cv2.data.haarcascades, name)
    if os.path.exists(p):
        c = cv2.CascadeClassifier(p)
        if not c.empty():
            cascades.append(c)
if not cascades:
    print(json.dumps({"available": False, "reason": "cascade data missing"}))
    sys.exit(0)
files = sorted(f for f in os.listdir(d) if f.endswith(".jpg"))
hits, scanned = [], 0
for i, f in enumerate(files):
    img = cv2.imread(os.path.join(d, f), cv2.IMREAD_GRAYSCALE)
    if img is None:
        continue
    h, w = img.shape[:2]
    if w > 640:
        s = 640.0 / w
        img = cv2.resize(img, (640, max(1, int(round(h * s)))), interpolation=cv2.INTER_AREA)
    h, w = img.shape[:2]
    scanned += 1
    best = 0.0
    min_side = max(1, int(round((min_frac ** 0.5) * min(w, h))))
    for c in cascades:
        for (x, y, fw, fh) in c.detectMultiScale(img, scaleFactor=1.1, minNeighbors=5, minSize=(min_side, min_side)):
            best = max(best, (fw * fh) / float(w * h))
        if best >= min_frac:
            break
    if best >= min_frac:
        hits.append({"index": i, "areaFrac": round(best, 5)})
print(json.dumps({"available": True, "cv2": cv2.__version__, "scanned": scanned, "hits": hits}))
`;

interface FaceTripwireResult {
  available: boolean;
  reason?: string;
  cv2?: string;
  scanned: number;
  hits: { index: number; areaFrac: number }[];
}

/** Run the tripwire over an extracted frame dir. NEVER THROWS — a probe or
 * detector failure is "unavailable" (the scan degrades to grid-only).
 * Exported for the unit suite's real-detector controls and the T-55.5
 * acceptance probe; production callers go through runRestrictedVisualScan. */
export async function runFaceTripwire(
  scriptPath: string,
  framesDir: string,
  minAreaFrac: number
): Promise<FaceTripwireResult> {
  try {
    const { stdout } = await execFileAsync(
      "python3",
      [scriptPath, framesDir, String(minAreaFrac)],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
    );
    const parsed = JSON.parse(stdout.toString().trim().split("\n").pop() ?? "") as FaceTripwireResult;
    if (typeof parsed?.available !== "boolean") throw new Error("bad tripwire JSON");
    return {
      available: parsed.available,
      reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 120) : undefined,
      cv2: typeof parsed.cv2 === "string" ? parsed.cv2 : undefined,
      scanned: Number.isFinite(parsed.scanned) ? parsed.scanned : 0,
      hits: Array.isArray(parsed.hits)
        ? parsed.hits
            .filter((h) => Number.isInteger(h?.index) && Number.isFinite(h?.areaFrac))
            .map((h) => ({ index: h.index, areaFrac: h.areaFrac }))
        : [],
    };
  } catch (err) {
    return {
      available: false,
      reason: errorText(err, "face tripwire error").slice(0, 120),
      scanned: 0,
      hits: [],
    };
  }
}

/** Extract the dense grid as JPEGs (f0001.jpg… — file number = index + 1).
 * Returns the frame count actually written (0 on failure → unmeasured).
 * Exported for the T-55.4/T-55.5 evidence probes; production callers go
 * through runRestrictedVisualScan. */
export async function extractDenseGrid(
  mp4Path: string,
  framesDir: string,
  fps: number,
  count: number
): Promise<number> {
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-i", mp4Path,
    "-vf", `fps=${fps.toFixed(4)}`,
    "-frames:v", String(count),
    "-q:v", "3",
    path.join(framesDir, "f%04d.jpg"),
  ]);
  return fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).length;
}

const gridFile = (framesDir: string, index: number) =>
  path.join(framesDir, `f${String(index + 1).padStart(4, "0")}.jpg`);

/**
 * L4 — the dense restricted-visual scan: extract a dense grid, tripwire it
 * locally for faces, judge the selected frames in batches. NEVER THROWS: a
 * failed scan reports "unmeasured" (which the QC gate treats as blocking —
 * fail-closed, never silently clean). Returns the outcome for the QC
 * battery to emit.
 */
export async function runRestrictedVisualScan(opts: {
  mp4Path: string;
  durationSec: number;
}): Promise<RestrictedScanOutcome> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-restricted-"));
  const framesDir = path.join(tmp, "frames");
  const scriptPath = path.join(tmp, "tripwire.py");
  try {
    fs.mkdirSync(framesDir);
    fs.writeFileSync(scriptPath, FACE_TRIPWIRE_PY);
    const dur = Number.isFinite(opts.durationSec) && opts.durationSec > 0 ? opts.durationSec : 1;
    const { fps, count } = planDenseGrid(dur);
    const gridCount = await extractDenseGrid(opts.mp4Path, framesDir, fps, count);
    if (gridCount === 0) {
      return { status: "unmeasured", value: "no frames sampled", detail: "ffmpeg produced no frames — the scan could not run" };
    }
    // The honest grid stats (the coarsened interval at the cap included).
    const interval = 1 / fps;

    // Stage 2 — the face tripwire (optional machinery, probed per scan).
    const trip = await runFaceTripwire(scriptPath, framesDir, RESTRICTED_FACE_MIN_AREA_FRAC);
    let forced: number[] = [];
    if (trip.available && trip.hits.length > 0) {
      const anchors = [...trip.hits]
        .sort((a, b) => b.areaFrac - a.areaFrac || a.index - b.index)
        .slice(0, RESTRICTED_FACE_MAX_ANCHORS);
      const seats = new Set<number>();
      for (const a of anchors) {
        for (const d of [-1, 0, 1]) {
          const j = a.index + d;
          if (j >= 0 && j < gridCount) seats.add(j);
        }
      }
      forced = [...seats].sort((a, b) => a - b);
    }

    // Stage 3 — the batched VLM judgment over the selected frames.
    const selected = selectVlmFrames(gridCount, forced);
    if (selected.length === 0) {
      return { status: "unmeasured", value: "no frames selected", detail: "the frame selection came up empty — the scan could not run" };
    }
    const totalBatches = Math.ceil(selected.length / RESTRICTED_VLM_BATCH);
    const coverage =
      `grid ${gridCount} @${interval.toFixed(2)}s · ` +
      (trip.available
        ? `tripwire ${trip.hits.length} hit(s) → ${forced.length} forced${trip.cv2 ? ` (cv2 ${trip.cv2})` : ""}`
        : `tripwire unavailable${trip.reason ? ` (${trip.reason})` : ""}`) +
      ` · judged ${selected.length} ≈${(dur / selected.length).toFixed(2)}s apart`;
    const batches: RestrictedBatchOutcome[] = [];
    for (let b = 0; b < totalBatches; b++) {
      const slice = selected.slice(b * RESTRICTED_VLM_BATCH, (b + 1) * RESTRICTED_VLM_BATCH);
      const parts: unknown[] = [
        {
          type: "text",
          text:
            `These are ${slice.length} frames from different moments of a ${dur.toFixed(1)}s Islamic-history video ` +
            `(an even-coverage grid${forced.length > 0 ? " plus detector-flagged frames" : ""}). ` +
            `Check the content policy.`,
        },
      ];
      for (const idx of slice) {
        parts.push({ type: "text", text: `Frame ${idx + 1} (t=${(idx / fps).toFixed(2)}s):` });
        parts.push({
          type: "image_url",
          image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(gridFile(framesDir, idx)).toString("base64")}` },
        });
      }
      try {
        const raw = await aiCall("llm", `restricted-visual VLM scan (batch ${b + 1}/${totalBatches})`, () =>
          llmVision({
            messages: [
              { role: "system", content: RESTRICTED_VISUAL_SYSTEM },
              { role: "user", content: parts },
            ],
            temperature: 0,
          })
        );
        const parsed = parseJsonLoose(raw.choices?.[0]?.message?.content ?? "") as {
          depicted?: unknown;
          frames?: unknown;
          note?: unknown;
        };
        if (typeof parsed?.depicted !== "boolean") {
          batches.push({ status: "unmeasured", frames: [], note: `batch ${b + 1} verdict unreadable` });
          break;
        }
        const frames = Array.isArray(parsed?.frames)
          ? (parsed.frames as unknown[]).filter((n) => typeof n === "number").slice(0, RESTRICTED_VLM_BATCH)
          : [];
        const note = typeof parsed?.note === "string" ? parsed.note.slice(0, 200) : "";
        batches.push({ status: parsed.depicted ? "fail" : "pass", frames, note });
        if (parsed.depicted) break; // fail fast — the verdict already blocks export
      } catch (err) {
        batches.push({
          status: "unmeasured",
          frames: [],
          note: `batch ${b + 1} error: ${errorText(err, "restricted-visual scan error").slice(0, 120)}`,
        });
        break;
      }
    }
    const verdict = restrictedVerdictFromBatches(batches);
    const batchesRan = batches.length;
    if (verdict.status === "fail") {
      const where = verdict.frames
        .map((label) => {
          const idx = selected[label - 1]; // the judge echoed a global label
          return Number.isInteger(idx) ? `${label} (t=${(idx / fps).toFixed(2)}s)` : `${label}`;
        })
        .join(", ");
      return {
        status: "fail",
        value: `restricted figure depicted in ${verdict.frames.length || 1} frame(s)`,
        detail: `${where ? `frames: ${where}` : "unspecified frames"}${verdict.note ? ` — ${verdict.note}` : ""} · ${coverage} · ${batchesRan}/${totalBatches} batch(es)`,
      };
    }
    if (verdict.status === "unmeasured") {
      return {
        status: "unmeasured",
        value: "scan could not run",
        detail: `${verdict.note || "the VLM response did not parse into a verdict"} · ${coverage} · ${batchesRan}/${totalBatches} batch(es)`,
      };
    }
    return {
      status: "pass",
      value: `${selected.length} frame(s) compliant across ${batchesRan} batch(es)`,
      detail: [coverage, verdict.note].filter(Boolean).join(" · ").slice(0, 300) || undefined,
    };
  } catch (err) {
    return {
      status: "unmeasured",
      value: "scan could not run",
      detail: errorText(err, "restricted-visual scan error").slice(0, 200),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
