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
//   L4 verify   — runRestrictedVisualScan: frames sampled from the rendered
//                 final.mp4, VLM-judged, emitted as the QC check
//                 "restricted-visual"
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
// L4 — the restricted visual scan (frames from the rendered file, VLM-judged).
// ---------------------------------------------------------------------------

/** The VLM judge's system prompt. */
export const RESTRICTED_VISUAL_SYSTEM = `You are a visual-content compliance checker for an Islamic-history video production. You will see sampled frames from a rendered video. The production's content policy forbids DEPICTING revered religious figures — the Prophet Muhammad, his family, the Companions, the prophets, the angels, or God — as faces, figures, silhouettes or symbolic light-bodies.

Report a violation ONLY when a frame presents a human face or figure AS a revered religious figure — for example a haloed or light-crowned central figure, a figure the composition venerates, an angel with wings, or a figure clearly standing in for a named prophet. Ordinary anonymous people (a merchant, a scribe's hands, a distant crowd with indistinct faces), calligraphy, architecture, artifacts and landscapes are NOT violations.

Respond with STRICT JSON only: {"depicted": true|false, "frames": [<1-based frame numbers showing the violation>], "note": "<one short sentence>"} — "depicted" false with empty frames when every frame complies.`;

export interface RestrictedScanOutcome {
  status: "pass" | "fail" | "unmeasured";
  value: string;
  detail?: string;
}

/** How many frames the scan samples from the rendered file. */
export const RESTRICTED_SCAN_FRAMES = 8;

/**
 * L4 — sample frames evenly across the rendered final.mp4 and ask the VLM
 * whether any depicts a restricted figure. NEVER THROWS: a failed scan
 * reports "unmeasured" (which the QC gate treats as blocking — fail-closed,
 * never silently clean). Returns the outcome for the QC battery to emit.
 */
export async function runRestrictedVisualScan(opts: {
  mp4Path: string;
  durationSec: number;
}): Promise<RestrictedScanOutcome> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-restricted-"));
  try {
    const dur = Number.isFinite(opts.durationSec) && opts.durationSec > 0 ? opts.durationSec : 1;
    // Even sampling: a frame every dur/N seconds, capped at N frames.
    const fps = Math.min(RESTRICTED_SCAN_FRAMES / dur, 1);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", opts.mp4Path,
      "-vf", `fps=${fps.toFixed(4)}`,
      "-frames:v", String(RESTRICTED_SCAN_FRAMES),
      "-q:v", "3",
      path.join(tmp, "f%02d.jpg"),
    ]);
    const files = fs
      .readdirSync(tmp)
      .filter((f) => f.endsWith(".jpg"))
      .sort();
    if (files.length === 0) {
      return { status: "unmeasured", value: "no frames sampled", detail: "ffmpeg produced no frames — the scan could not run" };
    }
    const parts: unknown[] = [
      {
        type: "text",
        text: `These are ${files.length} frames sampled evenly across a ${dur.toFixed(1)}s Islamic-history video. Check the content policy.`,
      },
    ];
    for (let i = 0; i < files.length; i++) {
      parts.push({ type: "text", text: `Frame ${i + 1}:` });
      parts.push({
        type: "image_url",
        image_url: { url: `data:image/jpeg;base64,${fs.readFileSync(path.join(tmp, files[i])).toString("base64")}` },
      });
    }
    const raw = await aiCall("llm", "restricted-visual VLM scan", () =>
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
    const depicted = parsed?.depicted === true;
    const frames = Array.isArray(parsed?.frames)
      ? (parsed.frames as unknown[]).filter((n) => typeof n === "number").slice(0, 8)
      : [];
    const note = typeof parsed?.note === "string" ? parsed.note.slice(0, 200) : "";
    if (depicted) {
      return {
        status: "fail",
        value: `restricted figure depicted in ${frames.length || 1} frame(s)`,
        detail: `${frames.length ? `frames: ${frames.join(", ")}` : "unspecified frames"}${note ? ` — ${note}` : ""}`,
      };
    }
    return {
      status: "pass",
      value: `${files.length} frame(s) compliant`,
      detail: note || undefined,
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
