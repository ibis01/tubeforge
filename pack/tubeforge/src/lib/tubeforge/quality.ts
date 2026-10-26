// VLM quality gate (Phase 3 — robustness).
//
// Generated art occasionally comes out with garbled text, deformed faces or
// AI artifacts. Before an image becomes the public-facing thumbnail (or a
// storyboard scene that feeds an expensive i2v render), a vision model
// inspects it and — below the configured threshold — the image is re-rolled
// once, keeping whichever attempt scored better.
//
// The gate ALWAYS fails open: if the VLM check itself errors, the original
// image passes untouched (gates must never break the pipeline).

import fs from "fs";
import { db } from "@/lib/db";
import { getZAI, parseJsonLoose } from "./ai";
import { getVisionModel } from "./zai-config";
import { aiCall } from "./budget";

export type GateKind = "thumbnail" | "scene";

export interface QualityReport {
  checked: boolean; // did the VLM actually inspect the image?
  score: number | null; // final score (0-10) when checked
  issues: string[];
  summary: string | null;
  rerolled: boolean; // was a second attempt generated?
  previousScore: number | null; // first-attempt score when re-rolled
}

/** Read gate settings (mode + threshold) with a short cache. */
async function getGateConfig(): Promise<{ mode: string; threshold: number }> {
  try {
    const rows = await db.setting.findMany({
      where: { key: { in: ["qualityGate", "qualityThreshold"] } },
    });
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const mode = (map.get("qualityGate") ?? "thumbnails") || "off";
    const raw = Number(map.get("qualityThreshold") ?? 6);
    return { mode, threshold: Number.isFinite(raw) ? Math.min(9, Math.max(1, raw)) : 6 };
  } catch {
    return { mode: "thumbnails", threshold: 6 };
  }
}

const MODE_COVERS: Record<GateKind, string[]> = {
  thumbnail: ["thumbnails", "all"],
  scene: ["all"],
};

/** Run a single VLM inspection on a local PNG. Returns score 0-10 + issues. */
async function inspectImage(
  imagePath: string,
  context: string
): Promise<{ score: number; issues: string[]; summary: string }> {
  const zai = await getZAI();
  const dataUrl = `data:image/png;base64,${fs.readFileSync(imagePath).toString("base64")}`;
  const model = await getVisionModel();

  const completion = await aiCall("llm", "quality gate VLM", () =>
    // The SDK type marks `model` as required, but the gateway injects its
    // default vision model when omitted — keep that behavior when no override
    // is stored, hence the cast.
    zai.chat.completions.createVision({
      ...(model ? { model } : {}),
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `You are a strict quality inspector for AI-generated YouTube artwork. Context: ${context}.

Rate this image 0-10 for upload readiness. Deduct heavily for:
- garbled text, random letters, or nonsense words baked into the art
- deformed faces, hands, or limbs; fused or duplicated subjects
- obvious AI artifacts, watermarks, or frames around the image
- blank / nearly-solid images, or a composition that misses the described subject entirely

Respond with STRICT JSON only:
{"score": <integer 0-10>, "issues": [<short strings, empty if perfect>], "summary": "<one sentence>"}`,
            },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
      thinking: { type: "disabled" },
    } as Parameters<typeof zai.chat.completions.createVision>[0])
  );

  const raw = completion.choices[0]?.message?.content ?? "";
  const parsed = parseJsonLoose(raw);
  const score = Number(parsed.score);
  if (!Number.isFinite(score))
    throw new Error("Quality inspector returned no score");
  return {
    score: Math.max(0, Math.min(10, Math.round(score))),
    issues: Array.isArray(parsed.issues)
      ? parsed.issues.map((i) => String(i)).slice(0, 5)
      : [],
    summary: String(parsed.summary ?? "").slice(0, 200),
  };
}

async function logActivity(
  videoId: string,
  message: string,
  level: "info" | "error" = "info"
) {
  try {
    await db.activity.create({
      data: { videoId, stage: "quality", level, message },
    });
  } catch {
    /* activity logging must never break the gate */
  }
}

/**
 * Generate an image through the quality gate.
 *
 * 1. run `generate()` (writes the image file at `imagePath`)
 * 2. if the gate covers this kind, inspect the image with the VLM
 * 3. score below threshold → back the image up, re-roll once, re-inspect
 * 4. keep whichever attempt scored better; log the outcome to the activity feed
 *
 * If the gate is disabled for this kind, or the inspector errors, the image
 * passes untouched — `generate()` runs exactly once.
 */
export async function runQualityGate(opts: {
  kind: GateKind;
  videoId: string;
  imagePath: string;
  context: string;
  generate: () => Promise<unknown>;
}): Promise<QualityReport> {
  const cfg = await getGateConfig();
  const covered = MODE_COVERS[opts.kind].includes(cfg.mode);

  await opts.generate();
  if (!covered) return { checked: false, score: null, issues: [], summary: null, rerolled: false, previousScore: null };

  let first: { score: number; issues: string[]; summary: string };
  try {
    first = await inspectImage(opts.imagePath, opts.context);
  } catch (err) {
    const message = err instanceof Error ? err.message : "VLM inspection failed";
    console.warn(`[quality] inspection failed, passing through: ${message}`);
    await logActivity(opts.videoId, `Quality check skipped — inspector unavailable (${message})`, "error");
    return { checked: false, score: null, issues: [], summary: null, rerolled: false, previousScore: null };
  }

  if (first.score >= cfg.threshold) {
    await logActivity(
      opts.videoId,
      `Quality gate passed — ${opts.kind} scored ${first.score}/10${first.summary ? ` (${first.summary})` : ""}`
    );
    return { checked: true, score: first.score, issues: first.issues, summary: first.summary, rerolled: false, previousScore: null };
  }

  // Below threshold — one re-roll, keep the better attempt.
  const backup = `${opts.imagePath}.gate.bak`;
  try {
    fs.copyFileSync(opts.imagePath, backup);
    await opts.generate();

    let second: { score: number; issues: string[]; summary: string };
    try {
      second = await inspectImage(opts.imagePath, opts.context);
    } catch {
      // Inspector died on the re-roll — keep the first (known) attempt.
      second = { score: -1, issues: [], summary: "re-roll uninspected" };
    }

    if (second.score < first.score) {
      // The re-roll came out worse — restore the original.
      fs.copyFileSync(backup, opts.imagePath);
      fs.rmSync(backup, { force: true });
      await logActivity(
        opts.videoId,
        `Quality gate: ${opts.kind} scored ${first.score}/10 (${first.issues.join("; ") || "below threshold"}) — re-rolled but kept the better original`,
        "error"
      );
      return { checked: true, score: first.score, issues: first.issues, summary: first.summary, rerolled: true, previousScore: first.score };
    }

    fs.rmSync(backup, { force: true });
    await logActivity(
      opts.videoId,
      `Quality gate re-roll improved ${opts.kind}: ${first.score}/10 → ${second.score}/10${second.summary ? ` (${second.summary})` : ""}`
    );
    return { checked: true, score: second.score, issues: second.issues, summary: second.summary, rerolled: true, previousScore: first.score };
  } catch (err) {
    // Re-roll generation itself failed — restore the original and pass it.
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, opts.imagePath);
      fs.rmSync(backup, { force: true });
    }
    const message = err instanceof Error ? err.message : "re-roll failed";
    console.warn(`[quality] re-roll failed, keeping original: ${message}`);
    await logActivity(
      opts.videoId,
      `Quality gate: re-roll failed (${message}) — kept the original ${opts.kind} (scored ${first.score}/10)`,
      "error"
    );
    return { checked: true, score: first.score, issues: first.issues, summary: first.summary, rerolled: false, previousScore: first.score };
  }
}
