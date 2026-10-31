// Custom-script analysis — runs the pasted script through the LLM BEFORE the
// video is created, returning a structured verdict the UI can show with an
// Approve / Edit choice.
//
// Why: when a user pastes their own script, Auto-Pilot skips AI generation.
// That's the whole point. But a raw paste can be too long for a 3-minute
// YouTube short, off-tone for the chosen niche, full of unspokenable symbols
// that wreck TTS, or contain sensitive / unmonetizable material. Running the
// script through the engine first catches those issues up front instead of
// burning a 30-minute render pipeline on text that would fail at the end.
//
// The analysis is provider-agnostic — it uses the same LLM configured in
// Settings → AI Providers (zai gateway or any OpenAI-compatible endpoint).
// The model is asked for a strict JSON response; we parse defensively so a
// misbehaving model can never hard-crash the flow.

import { llmChat } from "./llm";

export type ScriptVerdict = "approved" | "needs_revision" | "rejected";

export interface ScriptIssue {
  /** severity ordering: blocker > warning > note */
  severity: "blocker" | "warning" | "note";
  category:
    | "length"
    | "structure"
    | "tone"
    | "readability"
    | "sensitive"
    | "monetization"
    | "tts_feasibility"
    | "brand_fit"
    | "other";
  message: string;
  /** Optional suggested fix — the UI shows this next to the issue. */
  suggestion?: string;
}

export interface ScriptAnalysis {
  verdict: ScriptVerdict;
  /** 0-100. ≥80 = approved, 50-79 = needs_revision, <50 = rejected. */
  score: number;
  /** One-line summary the UI shows at the top of the report. */
  summary: string;
  /** Estimated speaking time at ~150 wpm (the standard narration pace). */
  estimatedDurationSec: number;
  wordCount: number;
  /** Strengths — short bullets, max 3. */
  strengths: string[];
  /** Weaknesses + blockers — what to fix. */
  issues: ScriptIssue[];
  /** Concrete recommendations — what to do next. */
  recommendations: string[];
  /** Whether the engine believes this script can move forward as-is. */
  canApproveAnyway: boolean;
  /** ISO timestamp */
  analyzedAt: string;
  /** Wall-clock time the analysis took, in ms (useful for the UI). */
  durationMs: number;
  /** Raw model output kept for debugging — never shown to the user. */
  _raw?: string;
}

const SYSTEM_PROMPT = `You are TubeForge's script-analysis engine. You evaluate a YouTube narration script before it is approved for production. You are NOT rewriting the script — only auditing it.

Evaluate against these criteria, all of them:
- length: matches the target duration (≈150 wpm narration pace). A 3-minute short = ~450 words.
- structure: clear hook (first 5 seconds), body, payoff. No wall-of-text paragraphs.
- tone: matches the channel niche and the selected tone (motivational, informative, dramatic, casual, etc.)
- readability: reads aloud naturally. Avoids tongue-twisters, weird symbols, ALL-CAPS shouting, unpronounceable jargon.
- tts_feasibility: no URLs, no raw Markdown, no emoji storms, no special chars that wreck TTS (★, →, |, etc.)
- sensitive: no hate speech, no harassment, no graphic violence, no sexual content, no dangerous-activity instructions.
- monetization: avoid heavy profanity, brand-name attacks, copyrighted lyrics, or content that triggers YouTube's limited-monetization flag.
- brand_fit: the script fits a "faceless YouTube automation" channel — no on-camera references, no "as you can see behind me" lines.

Respond with a single JSON object and nothing else. No prose. No markdown fences. Strictly:

{
  "verdict": "approved" | "needs_revision" | "rejected",
  "score": <0-100 integer>,
  "summary": "<one-sentence summary, ≤140 chars>",
  "strengths": ["<short bullet>", "<short bullet>"],
  "issues": [
    {
      "severity": "blocker" | "warning" | "note",
      "category": "length" | "structure" | "tone" | "readability" | "sensitive" | "monetization" | "tts_feasibility" | "brand_fit" | "other",
      "message": "<what's wrong>",
      "suggestion": "<how to fix, or null>"
    }
  ],
  "recommendations": ["<short actionable recommendation>"]
}

Rules:
- verdict "approved" requires zero blockers and score ≥ 80.
- verdict "needs_revision" has at least one warning or 1+ blockers that are easy to fix.
- verdict "rejected" has a blocker that can't be fixed with a small edit (sensitive content, severe mismatch).
- Never recommend rewriting the whole script — suggest targeted edits only.
- If the script is empty or under 10 words, reject with score 0.`;

const USER_PROMPT_TEMPLATE = (
  script: string,
  topic: string,
  niche: string,
  tone: string,
  length: string
) => `Analyze this YouTube narration script.

Topic: ${topic}
Channel niche: ${niche}
Selected tone: ${tone}
Target length preset: ${length}

Script to analyze:
"""
${script}
"""

Return only the JSON object.`;

/** Quick local pre-flight before calling the LLM — catches the obvious ones. */
function localPreflight(script: string): ScriptIssue[] {
  const issues: ScriptIssue[] = [];
  const trimmed = script.trim();

  if (!trimmed) {
    issues.push({
      severity: "blocker",
      category: "length",
      message: "Script is empty.",
      suggestion: "Paste a narration script before analyzing.",
    });
    return issues;
  }

  if (trimmed.length < 50) {
    issues.push({
      severity: "blocker",
      category: "length",
      message: `Script is very short (${trimmed.length} chars).`,
      suggestion: "A YouTube short needs at least 200-300 words to fill 1-2 minutes of narration.",
    });
  }

  if (trimmed.length > 30000) {
    issues.push({
      severity: "warning",
      category: "length",
      message: `Script is very long (${trimmed.length.toLocaleString()} chars).`,
      suggestion: "Long videos are fine but each render pass takes longer. Consider splitting into a series.",
    });
  }

  // TTS-hostile symbols
  const tts_unfriendly = trimmed.match(/[★→|•※‣▪◆◇►►]/g);
  if (tts_unfriendly && tts_unfriendly.length > 3) {
    issues.push({
      severity: "warning",
      category: "tts_feasibility",
      message: `Heavy use of TTS-hostile symbols (${tts_unfriendly.length} found: ${[...new Set(tts_unfriendly)].slice(0, 5).join(" ")}).`,
      suggestion: "Replace arrows / bullets with words like 'then' or use plain hyphens.",
    });
  }

  // ALL-CAPS shouting
  const caps_words = trimmed.match(/\b[A-Z]{6,}\b/g);
  if (caps_words && caps_words.length > 4) {
    issues.push({
      severity: "note",
      category: "readability",
      message: `${caps_words.length} words are ALL-CAPS — the narrator will shout them.`,
      suggestion: "Use italics or bold for emphasis instead of all-caps.",
    });
  }

  // URLs in the body — TTS reads them out loud and they sound bad
  if (/https?:\/\/\S+/i.test(trimmed)) {
    issues.push({
      severity: "warning",
      category: "tts_feasibility",
      message: "URLs detected in the script — TTS reads them aloud as letters.",
      suggestion: "Move URLs to the description, not the narration. Or rewrite as 'visit the link in the description'.",
    });
  }

  // Markdown headings
  if (/^#{1,6}\s/m.test(trimmed)) {
    issues.push({
      severity: "note",
      category: "tts_feasibility",
      message: "Markdown headings detected (#, ##, etc.) — TTS reads them as 'hash hash hash'.",
      suggestion: "Strip Markdown formatting before pasting. Plain text only.",
    });
  }

  return issues;
}

/** Parse the LLM JSON response defensively. */
function parseAnalysis(raw: string): Partial<ScriptAnalysis> {
  // First try direct parse, then extract the first {...} block as fallback.
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      // Try to extract the largest JSON object from the response.
      const match = s.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch {
          return null;
        }
      }
      return null;
    }
  };

  const parsed = tryParse(raw);
  if (!parsed || typeof parsed !== "object") return {};

  const p = parsed as Record<string, unknown>;
  const verdict = p.verdict as ScriptVerdict;
  if (!["approved", "needs_revision", "rejected"].includes(verdict)) return {};

  const issues = Array.isArray(p.issues)
    ? (p.issues as Record<string, unknown>[]).map((i) => ({
        severity: (["blocker", "warning", "note"].includes(i.severity as string)
          ? i.severity
          : "note") as ScriptIssue["severity"],
        category: (i.category as ScriptIssue["category"]) ?? "other",
        message: String(i.message ?? "").slice(0, 280),
        ...(i.suggestion ? { suggestion: String(i.suggestion).slice(0, 280) } : {}),
      }))
    : [];

  const strengths = Array.isArray(p.strengths)
    ? (p.strengths as unknown[]).map((s) => String(s).slice(0, 160)).slice(0, 3)
    : [];

  const recommendations = Array.isArray(p.recommendations)
    ? (p.recommendations as unknown[]).map((s) => String(s).slice(0, 200)).slice(0, 5)
    : [];

  return {
    verdict,
    score: Math.min(Math.max(Number(p.score) || 0, 0), 100),
    summary: String(p.summary ?? "").slice(0, 200),
    strengths,
    issues,
    recommendations,
  };
}

export interface AnalyzeScriptInput {
  script: string;
  topic: string;
  niche: string;
  tone: string;
  length: string;
}

export async function analyzeScript(
  input: AnalyzeScriptInput
): Promise<ScriptAnalysis> {
  const t0 = Date.now();
  const script = input.script;
  const localIssues = localPreflight(script);
  const wordCount = script.trim() ? script.trim().split(/\s+/).filter(Boolean).length : 0;
  const estimatedDurationSec = Math.round((wordCount / 150) * 60);

  // Local blocker (empty / too short) → skip the LLM round-trip
  if (localIssues.some((i) => i.severity === "blocker")) {
    return {
      verdict: "rejected",
      score: 0,
      summary: "Script is empty or too short to analyze.",
      estimatedDurationSec,
      wordCount,
      strengths: [],
      issues: localIssues,
      recommendations: ["Paste at least 200-300 words before analyzing."],
      canApproveAnyway: false,
      analyzedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
    };
  }

  // LLM round-trip
  let raw = "";
  let parsed: Partial<ScriptAnalysis> = {};
  let llmError: string | null = null;

  try {
    const completion = await llmChat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: USER_PROMPT_TEMPLATE(
            script,
            input.topic || "(no topic)",
            input.niche,
            input.tone,
            input.length
          ),
        },
      ],
      temperature: 0.2,
    });
    raw = completion.choices?.[0]?.message?.content ?? "";
    parsed = parseAnalysis(raw);
  } catch (err) {
    llmError = err instanceof Error ? err.message : String(err);
  }

  // LLM failed or returned unparseable JSON → fall back to a local-only verdict
  if (!parsed.verdict) {
    // If we have only note-level local issues, let the user approve anyway.
    const hasWarning = localIssues.some((i) => i.severity === "warning");
    const hasBlocker = localIssues.some((i) => i.severity === "blocker");
    const fallbackVerdict: ScriptVerdict = hasBlocker
      ? "rejected"
      : hasWarning
      ? "needs_revision"
      : "approved";
    const fallbackScore = hasBlocker ? 30 : hasWarning ? 60 : 80;
    return {
      verdict: fallbackVerdict,
      score: fallbackScore,
      summary: llmError
        ? `Engine unavailable (${llmError.slice(0, 80)}). Showing local preflight only.`
        : "Engine returned an unparseable response. Showing local preflight only.",
      estimatedDurationSec,
      wordCount,
      strengths: [],
      issues: localIssues,
      recommendations: llmError
        ? ["Check Settings → AI Providers and try again."]
        : ["Re-analyze to retry the engine."],
      canApproveAnyway: !hasBlocker,
      analyzedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      ...(raw ? { _raw: raw } : {}),
    };
  }

  // Merge local preflight issues into the LLM issues (dedup by category+message)
  const seenKeys = new Set(parsed.issues!.map((i) => `${i.category}:${i.message.slice(0, 40)}`));
  const merged = [...parsed.issues!];
  for (const li of localIssues) {
    const key = `${li.category}:${li.message.slice(0, 40)}`;
    if (!seenKeys.has(key)) {
      merged.unshift(li); // local issues float to the top — they're deterministic
    }
  }

  const verdict = parsed.verdict!;
  return {
    verdict,
    score: parsed.score ?? 0,
    summary: parsed.summary ?? `Engine verdict: ${verdict}`,
    estimatedDurationSec,
    wordCount,
    strengths: parsed.strengths ?? [],
    issues: merged,
    recommendations: parsed.recommendations ?? [],
    canApproveAnyway: verdict !== "rejected",
    analyzedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    ...(raw ? { _raw: raw } : {}),
  };
}
