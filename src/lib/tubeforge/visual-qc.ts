// S53 — advanced visual QC: the two VLM-judged lenses the battery grew.
//
// The S51 continuity benchmark's residual finding — the recurring subject's
// hair hue drifts warm/golden under warm scene lighting against the anchor's
// silver, "a color-under-lighting drift, not identity drift" — had nowhere to
// land on the QC report. This module gives it (and its general class) a
// check: `subject-continuity`, a post-render VLM judgment over frames
// sampled evenly from final.mp4, with the threshold the S51 finding inherits
// (SUBJECT_CONSISTENCY_FLOOR). Its sibling `text-artifacts` hunts the classic
// AI-imagery defect: gibberish pseudo-text, garbled signage and watermarks —
// with deliberate burned captions explicitly excluded (this production burns
// captions on purpose; a lens that flags them would cry wolf on every video).
//
// Both scans follow the S49 L4 seam's laws exactly:
//   - NEVER THROW: a crashed probe/VLM/parse reports "unmeasured" — the
//     battery's "never read as clean" contract. (Both checks are REPORT
//     severity, so an unmeasured scan advises rather than holds; the human
//     still sees the unmeasured state, never a silent pass.)
//   - The caller decides applicability: the check rides the report when
//     (and only when) the caller ran the scan — subject-continuity needs a
//     recurring cast with an identity anchor, text-artifacts needs nothing.
//   - The judge answers STRICT JSON at temperature 0; parseJsonLoose recovers
//     prose-wrapped variance, and anything still unparsable is "unmeasured".

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
// The shared outcome shape + frame sampler
// ---------------------------------------------------------------------------

export interface VisualScanOutcome {
  status: "pass" | "fail" | "unmeasured";
  value: string;
  detail?: string;
}

/** How many frames each scan samples from the rendered file (the S49 L4
 * sampling density — enough for a judgment, cheap enough for every render). */
export const VISUAL_SCAN_FRAMES = 8;

/** Even sampling: N frames spread across the file, read into memory as
 * base64 JPEG payloads in presentation order; [] = the probe could not
 * run. NEVER THROWS (callers translate empty into "unmeasured"). The
 * payloads are read BEFORE the temp dir is cleaned — the caller never
 * touches the filesystem, so there is no window where frames vanish. */
export async function sampleFramesEvenly(
  mp4Path: string,
  durationSec: number,
  count: number
): Promise<string[]> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-visualqc-"));
  try {
    const dur = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : 1;
    const fps = Math.min(count / dur, 1);
    await execFileAsync("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", mp4Path,
      "-vf", `fps=${fps.toFixed(4)}`,
      "-frames:v", String(count),
      "-q:v", "3",
      path.join(tmp, "f%02d.jpg"),
    ]);
    return fs
      .readdirSync(tmp)
      .filter((f) => f.endsWith(".jpg"))
      .sort()
      .map((f) => fs.readFileSync(path.join(tmp, f)).toString("base64"));
  } catch {
    return [];
  } finally {
    // The payloads live in memory now; the temp files are dead weight.
    // Best-effort — a stuck temp dir must never fail the scan.
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 2 });
  }
}

/** Build the multimodal parts (text intro + numbered frames) the judges
 * read — from the sampler's base64 payloads. */
function frameParts(payloads: string[], intro: string): unknown[] {
  const parts: unknown[] = [{ type: "text", text: intro }];
  for (let i = 0; i < payloads.length; i++) {
    parts.push({ type: "text", text: `Frame ${i + 1}:` });
    parts.push({
      type: "image_url",
      image_url: { url: `data:image/jpeg;base64,${payloads[i]}` },
    });
  }
  return parts;
}

// ---------------------------------------------------------------------------
// subject-continuity — the S51 finding's threshold check
// ---------------------------------------------------------------------------

export const SUBJECT_CONSISTENCY_FLOOR = 70;

/** The VLM judge's system prompt. The lighting law is the S51 finding made
 * explicit: hue shifts caused by scene lighting are NOTES, not drift — only
 * changes to the identity-defining features themselves count. */
export const SUBJECT_CONTINUITY_SYSTEM = `You are a continuity inspector for a rendered video that features a recurring on-screen subject. You will see frames sampled evenly across the final cut.

Judge whether the SAME subject appears with consistent identity-defining features across the frames where they appear: hair color and style, apparent age, facial structure, build, and defining wardrobe pieces.

LIGHTING IS NOT IDENTITY: hue shifts caused by scene lighting (e.g. silver hair reading warm-golden under golden-hour light, cool tones under moonlight) are NOT drift — record them in "notes" but do not let them lower the score or flip "consistent". Only changes to the features themselves (a different hair length or color once lighting is accounted for, a visibly different age, a different wardrobe piece) count as drift.

Some frames may not contain the subject at all (b-roll, establishing shots, objects) — ignore those frames entirely.

Respond with STRICT JSON only: {"subject_frames": [<1-based frame numbers where the subject appears>], "consistent": true|false, "score": <0-100 consistency of the subject's identity across their frames>, "notes": "<one short sentence>"} — when the subject appears in no frame at all, use {"subject_frames": [], "consistent": true, "score": 100, "notes": "<why>"}.`;

/** The pure threshold law (unit-pinned): the judge's parsed JSON becomes the
 * scan verdict. Lighting notes never flip the verdict; only `consistent` and
 * the score floor do. Unparsable/garbage judge output → "unmeasured". */
export function subjectVerdictFromJudge(j: unknown): {
  status: "pass" | "fail" | "unmeasured";
  score?: number;
} {
  if (typeof j !== "object" || j === null) return { status: "unmeasured" };
  const consistent = (j as { consistent?: unknown }).consistent;
  const rawScore = (j as { score?: unknown }).score;
  if (typeof consistent !== "boolean") return { status: "unmeasured" };
  const score =
    typeof rawScore === "number" && Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, rawScore))
      : undefined;
  // No subject in any frame: the judge's own verdict stands (a cast video
  // where every sampled frame missed the subject is a sampling artifact,
  // not a continuity pass/fail — "consistent: true, score: 100" by contract).
  if (score === undefined) return { status: "unmeasured" };
  return {
    status: consistent && score >= SUBJECT_CONSISTENCY_FLOOR ? "pass" : "fail",
    score,
  };
}

/** Run the subject-continuity scan on a rendered file. NEVER THROWS. */
export async function runSubjectContinuityScan(opts: {
  mp4Path: string;
  durationSec: number;
  characterName: string;
  anchor: string;
}): Promise<VisualScanOutcome> {
  try {
    const payloads = await sampleFramesEvenly(opts.mp4Path, opts.durationSec, VISUAL_SCAN_FRAMES);
    if (payloads.length === 0) {
      return {
        status: "unmeasured",
        value: "no frames sampled",
        detail: "ffmpeg produced no frames — the scan could not run",
      };
    }
    const raw = await aiCall("llm", "subject-continuity VLM scan", () =>
      llmVision({
        messages: [
          { role: "system", content: SUBJECT_CONTINUITY_SYSTEM },
          {
            role: "user",
            content: frameParts(
              payloads,
              `These are ${payloads.length} frames sampled evenly across a ${opts.durationSec.toFixed(1)}s video. The recurring subject is "${opts.characterName}", whose identity anchor reads: ${opts.anchor}. Judge their identity continuity.`
            ),
          },
        ],
        temperature: 0,
      })
    );
    const parsed = parseJsonLoose(raw.choices?.[0]?.message?.content ?? "") as {
      consistent?: unknown;
      score?: unknown;
      subject_frames?: unknown;
      notes?: unknown;
    };
    const verdict = subjectVerdictFromJudge(parsed);
    if (verdict.status === "unmeasured") {
      return {
        status: "unmeasured",
        value: "judge verdict unreadable",
        detail: "the VLM response did not parse into a consistency verdict",
      };
    }
    const frames = Array.isArray(parsed.subject_frames) ? parsed.subject_frames : [];
    const notes = typeof parsed.notes === "string" ? parsed.notes : "";
    return {
      status: verdict.status,
      value:
        verdict.status === "pass"
          ? `identity consistent across ${frames.length || "all"} subject frame(s) — ${verdict.score}/100`
          : `identity drift — ${verdict.score ?? "?"}/100 (below the ${SUBJECT_CONSISTENCY_FLOOR} floor)`,
      detail: [frames.length > 0 ? `subject in frame(s) ${frames.join(", ")}` : "", notes]
        .filter(Boolean)
        .join(" · ")
        .slice(0, 300) || undefined,
    };
  } catch (err) {
    return {
      status: "unmeasured",
      value: "scan could not run",
      detail: errorText(err, "visual QC scan error").slice(0, 200),
    };
  }
}

// ---------------------------------------------------------------------------
// text-artifacts — the AI-imagery gibberish/watermark lens
// ---------------------------------------------------------------------------

/** The VLM judge's system prompt. The caption-exclusion law: this production
 * burns captions deliberately — flagging them would false-positive every
 * video. Only unintended pseudo-text in the IMAGE CONTENT counts. */
export const TEXT_ARTIFACT_SYSTEM = `You are a video quality inspector hunting for unintended text artifacts in AI-generated imagery. You will see frames sampled evenly across a rendered video.

Flag ONLY text that is clearly an ARTIFACT of generation: gibberish or garbled lettering, pseudo-text on signs/books/screens/labels that does not form real words, distorted or melted typography inside the image content, and watermarks or tool logos.

Do NOT flag: deliberate subtitle/caption overlays (typically typeset near the bottom of the frame — this production burns captions on purpose), intentional readable titles or signage that forms coherent words, incidental text that is too small or blurred to read at normal viewing distance.

Respond with STRICT JSON only: {"artifacts": true|false, "frames": [<1-based frame numbers showing artifacts>], "notes": "<one short sentence>"} — "artifacts" false with empty frames when every frame is clean.`;

/** Run the text-artifact scan on a rendered file. NEVER THROWS. */
export async function runTextArtifactScan(opts: {
  mp4Path: string;
  durationSec: number;
}): Promise<VisualScanOutcome> {
  try {
    const payloads = await sampleFramesEvenly(opts.mp4Path, opts.durationSec, VISUAL_SCAN_FRAMES);
    if (payloads.length === 0) {
      return {
        status: "unmeasured",
        value: "no frames sampled",
        detail: "ffmpeg produced no frames — the scan could not run",
      };
    }
    const raw = await aiCall("llm", "text-artifacts VLM scan", () =>
      llmVision({
        messages: [
          { role: "system", content: TEXT_ARTIFACT_SYSTEM },
          {
            role: "user",
            content: frameParts(
              payloads,
              `These are ${payloads.length} frames sampled evenly across a ${opts.durationSec.toFixed(1)}s rendered video. Hunt for text artifacts.`
            ),
          },
        ],
        temperature: 0,
      })
    );
    const parsed = parseJsonLoose(raw.choices?.[0]?.message?.content ?? "") as {
      artifacts?: unknown;
      frames?: unknown;
      notes?: unknown;
    };
    if (typeof parsed.artifacts !== "boolean") {
      return {
        status: "unmeasured",
        value: "judge verdict unreadable",
        detail: "the VLM response did not parse into an artifacts verdict",
      };
    }
    const frames = Array.isArray(parsed.frames) ? parsed.frames : [];
    const notes = typeof parsed.notes === "string" ? parsed.notes : "";
    return {
      status: parsed.artifacts ? "fail" : "pass",
      value: parsed.artifacts
        ? `artifact text in ${frames.length} frame(s)`
        : `${payloads.length} frame(s) clean of artifact text`,
      detail:
        [
          frames.length > 0 ? `frame(s) ${frames.join(", ")}` : "",
          notes,
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 300) || undefined,
    };
  } catch (err) {
    return {
      status: "unmeasured",
      value: "scan could not run",
      detail: errorText(err, "visual QC scan error").slice(0, 200),
    };
  }
}
