// S70 — Creator Intelligence CI-2: Packaging Intelligence.
//
// From the decision record (docs/audits/creator-intelligence-record.md §3):
// lint title + thumbnail as ONE pairing — truncation at render width,
// duplication (the title says what the thumb shows — wasted surface), and
// vagueness — deterministic checks plus an optional VLM lookability pass.
// Runs on publish-suggest output and user edits alike; the publish form
// gains a lint badge.
//
// Doctrine (adopted from the record): every score is a HEURISTIC
// (`heuristic: true`), never a predicted CTR; missing data is asked for
// (the thumbnail-text check degrades to "provide the overlay text" rather
// than inventing an opinion); PROPSES, never blocks — the lint reports,
// the human decides (the publish gate stays exactly as it is).
//
// Layering: the deterministic battery is PURE (unit-pinned); the VLM pass
// rides the llm.ts seam (llmVision) through budget.ts's aiCall choke
// point, and every number it emits is labeled a heuristic.
import { aiCall } from "./budget";
import { llmVision } from "./llm";
import { parseJsonLoose } from "./ai";

// ---------------------------------------------------------------------------
// The deterministic pairing lint
// ---------------------------------------------------------------------------

export type LintSeverity = "ok" | "warn" | "error";

export interface PackagingCheck {
  id: string;
  severity: LintSeverity;
  /** The finding in plain words, with the evidence. */
  message: string;
}

export interface PackagingLintReport {
  /** 0-100 pairing health — a heuristic blend of the checks below. */
  score: number;
  checks: PackagingCheck[];
  /** True when the VLM lookability pass contributed. */
  vlmJudged: boolean;
  vlmVerdict?: string;
  heuristic: true;
}

/** Title render-width truncation: YouTube truncates titles between ~55
 *  chars (mobile grid) and ~70 chars (desktop sidebar). Past 70 the tail
 *  is invisible nearly everywhere — the pairing must land its meaning in
 *  the visible prefix. */
const TITLE_SOFT_TRUNC = 60;
const TITLE_HARD_TRUNC = 70;
/** Thumbnail overlay text: at grid size, > 8 words stops being readable. */
const THUMB_TEXT_WORDS = 8;
/** Word-overlap ratio above which title and thumbnail say the same thing. */
const DUPLICATION_RATIO = 0.6;

function words(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

const VAGUE_TITLE_MARKERS = /\b(secrets?|you won'?t believe|shocking|insane|crazy|this one trick|mind-?blowing|ultimate guide)\b/i;

/** The deterministic battery — the pairing lint's always-on core. */
export function lintPackagingDeterministic(opts: {
  title: string;
  /** The words overlaid on the thumbnail ("" when none / not provided). */
  thumbnailText?: string;
}): PackagingCheck[] {
  const checks: PackagingCheck[] = [];
  const title = opts.title.trim();

  // 1. Truncation at render width.
  if (title.length === 0) {
    checks.push({ id: "title-empty", severity: "error", message: "No title to lint." });
    return checks;
  }
  if (title.length > TITLE_HARD_TRUNC) {
    checks.push({
      id: "title-truncation",
      severity: "warn",
      message: `The title is ${title.length} chars — past ~${TITLE_HARD_TRUNC} the tail truncates on most surfaces; land the meaning in the first ${TITLE_SOFT_TRUNC}.`,
    });
  } else if (title.length > TITLE_SOFT_TRUNC) {
    checks.push({
      id: "title-truncation",
      severity: "ok",
      message: `${title.length} chars — fits desktop, may trim in the mobile grid (the first ${TITLE_SOFT_TRUNC} carry it).`,
    });
  } else {
    checks.push({ id: "title-truncation", severity: "ok", message: `${title.length} chars — fits every render width.` });
  }

  // 2. Vagueness — a title with no concrete term asks for a click while
  //    promising nothing in particular. "Concrete" = a digit or a long word
  //    OUTSIDE the clickbait vocabulary ("believe" is 7 letters and as
  //    specific as a wet sponge). Capitalization is NOT evidence — YouTube
  //    titles are title-case, so every word looks like a proper noun.
  const CLICKBAIT_VOCAB = new Set([
    "secrets", "believe", "shocking", "insane", "crazy", "trick", "blowing",
    "ultimate", "guide", "wont", "won't", "amazing", "incredible", "things",
  ]);
  const hasSpecific =
    /\d/.test(title) || words(title).some((w) => w.length > 6 && !CLICKBAIT_VOCAB.has(w));
  if (VAGUE_TITLE_MARKERS.test(title) && !hasSpecific) {
    checks.push({
      id: "title-vagueness",
      severity: "warn",
      message: "Clickbait-marker phrasing with no concrete noun or number — the promise is unfalsifiable (name the thing).",
    });
  } else {
    checks.push({ id: "title-vagueness", severity: "ok", message: "The title names something concrete." });
  }

  // 3. Duplication — title and thumbnail are TWO surfaces; when one merely
  //    repeats the other, the pairing wastes half its real estate.
  const thumbText = (opts.thumbnailText ?? "").trim();
  if (!thumbText) {
    checks.push({
      id: "pairing-duplication",
      severity: "ok",
      message: "No thumbnail overlay text provided — the title pairs with the image itself (add the overlay words for a full pairing lint).",
    });
  } else {
    const tWords = new Set(words(title));
    const thWords = words(thumbText);
    if (thWords.length === 0) {
      checks.push({ id: "pairing-duplication", severity: "ok", message: "Thumbnail text carries no meaningful words." });
    } else {
      const overlap = thWords.filter((w) => tWords.has(w)).length / thWords.length;
      if (overlap >= DUPLICATION_RATIO) {
        checks.push({
          id: "pairing-duplication",
          severity: "warn",
          message: `The thumbnail repeats the title (${Math.round(overlap * 100)}% word overlap) — use the image for what the title cannot say.`,
        });
      } else {
        checks.push({ id: "pairing-duplication", severity: "ok", message: `Title and thumbnail complement each other (${Math.round(overlap * 100)}% overlap).` });
      }
    }
    // 3b. Thumbnail text readability at grid size.
    const tw = thumbText.split(/\s+/).filter(Boolean).length;
    if (tw > THUMB_TEXT_WORDS) {
      checks.push({
        id: "thumb-text-length",
        severity: "warn",
        message: `${tw} words on the thumbnail — at grid size more than ~${THUMB_TEXT_WORDS} stops reading; cut to the core contrast.`,
      });
    } else {
      checks.push({ id: "thumb-text-length", severity: "ok", message: `${tw} overlay word${tw === 1 ? "" : "s"} — readable at grid size.` });
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// The VLM lookability pass (optional, heuristic-labeled)
// ---------------------------------------------------------------------------

const VLM_PROMPT = `You judge a YouTube THUMBNAIL as a packaging professional. Given the video title and the thumbnail image, output STRICT JSON:

{
  "lookability": <0-100 — would it stop a scroll at small size?>,
  "readable": <true/false — is the overlay text legible at grid size?>,
  "focal": "clear" | "cluttered",
  "verdict": "<=140 chars, one concrete observation"
}

Judge only what is visible. Never wrap the JSON in markdown fences. Never add commentary.`;

/** The full lint: deterministic battery always; the VLM pass when a
 *  thumbnail image is provided. PROPSES — the report informs the human,
 *  it never blocks the publish gate. */
export async function lintPackaging(opts: {
  title: string;
  thumbnailText?: string;
  /** The thumbnail as a data URL (data:image/…;base64,…) — optional. */
  thumbnailDataUrl?: string;
}): Promise<PackagingLintReport> {
  const checks = lintPackagingDeterministic(opts);

  let vlmJudged = false;
  let vlmVerdict: string | undefined;
  if (opts.thumbnailDataUrl) {
    try {
      const completion = await aiCall("llm", "packaging lint VLM", () =>
        llmVision({
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: `${VLM_PROMPT}\n\nVideo title: ${opts.title}\n\nJudge the thumbnail.` },
                { type: "image_url", image_url: { url: opts.thumbnailDataUrl } },
              ],
            },
          ],
          temperature: 0.2,
        })
      );
      const text = completion.choices?.[0]?.message?.content ?? "";
      const parsed = parseJsonLoose(text);
      const look = Number(parsed.lookability);
      const readable = parsed.readable === true;
      const focal = String(parsed.focal ?? "");
      const verdict = String(parsed.verdict ?? "").slice(0, 160);
      if (Number.isFinite(look) && look >= 0 && look <= 100 && verdict) {
        vlmJudged = true;
        vlmVerdict = verdict;
        checks.push({
          id: "vlm-lookability",
          severity: look >= 70 ? "ok" : look >= 45 ? "warn" : "error",
          message: `Lookability ${Math.round(look)}/100 — ${verdict}${focal === "cluttered" ? " (focal point reads cluttered)" : ""}${readable ? "" : " (overlay text not legible at size)"}`,
        });
      }
    } catch {
      /* the VLM pass is optional — a gateway hiccup leaves the deterministic report */
    }
  } else {
    checks.push({
      id: "vlm-lookability",
      severity: "ok",
      message: "No thumbnail image yet — generate one and lint again for the lookability pass.",
    });
  }

  // Score: start from 100, each warn −12, each error −30; the VLM verdict
  // blends at 30% when present (a heuristic blend, honestly labeled).
  let score = 100;
  for (const c of checks) {
    if (c.id === "vlm-lookability" && vlmJudged) continue; // blended below
    if (c.severity === "warn") score -= 12;
    if (c.severity === "error") score -= 30;
  }
  score = Math.max(0, Math.min(100, score));
  if (vlmJudged) {
    const look = Number(/Lookability (\d+)\/100/.exec(checks.find((c) => c.id === "vlm-lookability")?.message ?? "")?.[1] ?? NaN);
    if (Number.isFinite(look)) score = Math.round(score * 0.7 + look * 0.3);
  }

  return { score, checks, vlmJudged, vlmVerdict, heuristic: true };
}
