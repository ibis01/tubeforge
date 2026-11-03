// POST /api/videos/[id]/studio/assist — the Timeline Studio's AI assist (S3).
//
// The editor's second pair of eyes: one LLM pass over the SAVED timeline doc
// (the client flushes pending edits first, same contract as the clip ops)
// that returns SUGGESTIONS in the studio's existing vocabulary — transition
// ids from the catalog, grade presets, title text, or freeform pacing notes.
//
// Honesty contract:
//   • the model NEVER writes the doc. Suggestions apply only through the
//     studio's own edit callbacks (the same paths a human click takes);
//   • every suggestion is sanitized against the catalogs server-side —
//     unknown transition ids, grade keys and overlong strings are dropped,
//     never silently coerced;
//   • suggestions are capped (12) and deduped per (scene, kind);
//   • notes are informational only — the UI renders no apply button for them.
//
// The transport is chatComplete (per-capability provider settings — the same
// provider the Director uses) through aiCall for budget accounting.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/tubeforge/tenant-db";
import { requireUser } from "@/lib/tubeforge/tenant";
import { aiCall } from "@/lib/tubeforge/budget";
import { chatComplete } from "@/lib/tubeforge/providers/chat";
import { parseJsonLoose } from "@/lib/tubeforge/ai";
import { parseTimeline } from "@/lib/tubeforge/timeline";
import { parseScenes } from "@/lib/tubeforge/story";
import { TRANSITIONS, TRANSITION_IDS } from "@/lib/tubeforge/transitions";
import { GRADE_PRESETS } from "@/lib/tubeforge/studio-doc";

type Ctx = { params: Promise<{ id: string }> };

export interface AssistSuggestion {
  sceneIndex: number;
  kind: "transition" | "grade" | "title" | "note";
  value: string;
  reason: string;
}

const MAX_SUGGESTIONS = 12;

/** Grade preset name for a scene's current grade (exact match only). */
function gradePresetName(grade: unknown): string | null {
  if (!grade || typeof grade !== "object") return null;
  for (const [name, preset] of Object.entries(GRADE_PRESETS)) {
    const g = grade as Record<string, number>;
    if (
      Math.abs((g.brightness ?? 1) - preset.brightness) < 0.005 &&
      Math.abs((g.contrast ?? 1) - preset.contrast) < 0.005 &&
      Math.abs((g.saturation ?? 1) - preset.saturation) < 0.005 &&
      Math.abs((g.temperature ?? 0) - preset.temperature) < 0.005 &&
      Math.abs((g.vignette ?? 0) - preset.vignette) < 0.005
    )
      return name;
  }
  return null;
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireUser(req);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  auth.enter();

  const { id } = await ctx.params;
  const video = await db.video.findUnique({ where: { id } });
  if (!video) return NextResponse.json({ error: "Video not found" }, { status: 404 });
  if (video.format !== "story")
    return NextResponse.json({ error: "AI assist is for scene-format videos" }, { status: 400 });

  const doc = parseTimeline(video.timeline);
  if (!doc || doc.scenes.length === 0)
    return NextResponse.json(
      { error: "Assemble the timeline first — the assist reads the saved doc" },
      { status: 400 }
    );

  // The row's scenes carry the narration; the doc carries the creative state.
  const rows = parseScenes(video.scenes);
  const byIdx = new Map(rows.map((s) => [s.index, s]));

  const sceneLines = doc.scenes
    .map((s, i) => {
      const row = byIdx.get(s.index);
      const narration = (row?.narration ?? s.narration ?? "").trim();
      const grade = gradePresetName(s.grade);
      const title = s.titleOverlay ? `"${s.titleOverlay.text.slice(0, 40)}"` : "none";
      const speed = s.speed ? `${s.speed.toFixed(2)}x` : "normal";
      const chroma = s.chroma ? "keyed" : "—";
      const pip = s.pip ? "logo" : "—";
      return [
        `Scene ${s.index} (position ${i + 1}): "${s.title || `Scene ${s.index}`}"`,
        `  visual: ${(s.visual || row?.visual || "—").slice(0, 90)}`,
        `  narration (${narration.split(/\s+/).filter(Boolean).length} words): ${narration.slice(0, 160)}${narration.length > 160 ? "…" : ""}`,
        `  duration: ${s.durationSec.toFixed(1)}s · transition in: ${s.transitionIn ?? "cut"} · grade: ${grade ?? (s.grade ? "custom" : "default")} · title: ${title} · speed: ${speed} · chroma: ${chroma} · pip: ${pip}`,
      ].join("\n");
    })
    .join("\n");

  const transitionIds = TRANSITIONS.map((t) => t.id).join(", ");
  const gradeKeys = Object.keys(GRADE_PRESETS).join(", ");

  const raw = await aiCall("llm", "studio assist", () =>
    chatComplete({
      system:
        "You are a senior video editor reviewing a finished rough cut. You have strong instincts about pacing, scene seams, color mood and on-screen titles. You always respond with STRICT JSON only — no markdown, no commentary.",
      user: `Review this timeline and suggest precise, tasteful improvements.

VIDEO: "${video.title}" — topic: ${video.topic ?? "—"} · tone: ${video.tone ?? "—"} · niche: ${video.niche ?? "—"}

TIMELINE:
${sceneLines}

VOCABULARY (suggestions MUST use these exact values):
- transitions: ${transitionIds}
- grade presets: ${gradeKeys}

Return JSON with exactly this shape:
{
  "suggestions": [
    {
      "sceneIndex": <the scene index, a number from the timeline>,
      "kind": "transition" | "grade" | "title" | "note",
      "value": "<a transition id from the vocabulary, a grade preset key, a title text (max 60 chars, no quotes), or empty for notes>",
      "reason": "<one sentence, editor-to-editor: why this improves the cut>"
    }
  ]
}

Rules: at most ${MAX_SUGGESTIONS} suggestions, the BEST ones — never one per scene by default. Suggest a transition only where the seam deserves it (mood shifts, reveals), a grade only where the visual mood clearly calls for one, a title ONLY for scenes that have none, and use "note" for pacing observations (a scene that drags, a read that should speed up). No suggestion may repeat the scene's current state.`,
    })
  );

  const parsed = parseJsonLoose(raw);
  const list = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  // Sanitize against the catalogs — the model suggests, the studio's own
  // vocabulary decides. Unknown values are dropped, never coerced.
  const seen = new Set<string>();
  const suggestions: AssistSuggestion[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object" || suggestions.length >= MAX_SUGGESTIONS) continue;
    const s = item as Record<string, unknown>;
    const sceneIndex = Number(s.sceneIndex);
    if (!Number.isInteger(sceneIndex) || !doc.scenes.some((d) => d.index === sceneIndex)) continue;
    const kind = String(s.kind ?? "");
    const value = typeof s.value === "string" ? s.value.trim() : "";
    const reason = (typeof s.reason === "string" ? s.reason.trim() : "").slice(0, 200);
    const dedupe = `${sceneIndex}:${kind}`;
    if (seen.has(dedupe)) continue;
    if (kind === "transition") {
      if (!TRANSITION_IDS.has(value as never)) continue;
      const current = doc.scenes.find((d) => d.index === sceneIndex)?.transitionIn ?? "cut";
      if (value === current) continue;
    } else if (kind === "grade") {
      if (!Object.prototype.hasOwnProperty.call(GRADE_PRESETS, value)) continue;
    } else if (kind === "title") {
      if (!value || value.length > 60) continue;
      if (doc.scenes.find((d) => d.index === sceneIndex)?.titleOverlay) continue;
    } else if (kind === "note") {
      if (!value && !reason) continue;
    } else {
      continue;
    }
    seen.add(dedupe);
    suggestions.push({
      sceneIndex,
      kind: kind as AssistSuggestion["kind"],
      value: value.slice(0, 60),
      reason,
    });
  }

  return NextResponse.json({ suggestions });
}
