// scene-qc.ts — S116 / Stage 5 of Scene-Level Editing & Repair: the
// scene-scoped QC battery + boundary-pair validation
// (docs/design/scene-level-editing-reconciliation.md §9, Stage 5).
//
// THE EXIT CRITERION (the proposal's own): repaired scenes are CHECKED
// before approval. This module is the check: a re-run of the whole-file
// battery's probes scoped to ONE scene, plus the boundary-pair lens the
// whole-file battery could never express (cut-alignment generalized from
// the file to the seam), with the verdict stored ON the revision it judged
// — and approval gated on a PASSING verdict for the head's own version.
//
// THE S79 DOCTRINE, generalized: the targeted re-check re-judged ONE scene
// after a repaint (visual-consistency.ts) because a repaint obsoleted every
// verdict that judged the OLD art — and nothing else. The scene recheck
// applies the same scope honesty to the media battery: an edit to scene N
// obsoletes scene N's verdicts and its two seams' verdicts; every other
// scene's standing evidence is NOT re-judged (no double spend, no re-render
// of the world for a one-scene fix — the §8.3 cost law, now in QC form).
//
// THE LAWS (each test-pinned):
//
//   1. NEVER SILENTLY CLEAN. Every probe carries the battery's three-state
//      status; "unmeasured" (no preview rendered, probe crashed, no
//      timeline to align against) is NOT a pass. The report passes only
//      when every check AND every seam verdict actually ran and passed.
//
//   2. THE VERDICT IS TIED TO A REVISION. The report records the
//      revisionVersion it judged; approval compares that number to the
//      head's version. A newer draft makes the standing verdict stale BY
//      COMPARISON — the stored report is never mutated (the annotation
//      law: content and verdict are both immutable once written; a fresh
//      recheck OVERWRITES the head's annotation column with a fresh
//      verdict for the head's own version, which is the column's contract).
//
//   3. THE SEAM IS MEASURED, NOT ASSUMED. The boundary lens renders nothing
//      itself: it reads the standing boundary-pair artifact
//      (scene-boundary-NN.mp4, the Stage-5 render lane) and aligns the
//      DETECTED cut against the seam the timeline math says the pair's
//      stitcher placed — durations derived through the SAME exported fold
//      the render used (resolveSceneDuration), never a private copy. No
//      pair rendered → the seam reads "unmeasured" with the exact command
//      that would render it.
//
//   4. A CUT SEAM MUST APPEAR; A BLEND SEAM NEED NOT. The T-55.2 evidence:
//      a clean crossfade can score under the scene-change threshold —
//      absence at a blend is not a defect. A cut that never lands in the
//      pixels is a swallowed seam and fails. A detection near the seam that
//      the seam does not explain (inside the neighbourhood, outside the
//      window) is a stray and fails. Detections deeper inside either
//      scene's interior belong to the full battery (with its shot-join
//      windows) — the boundary lens owns the JOIN, which is what a scene
//      edit changes.
//
//   5. NO SILENT PAID CALLS. The ffmpeg probes are local and free. The one
//      paid surface — the S49 restricted-visual scan — runs ONLY under a
//      restricted content policy (the render path's own applicability law)
//      and only because a human clicked the recheck button; it rides
//      aiCall's metering exactly like the QC re-run's scan.
//
//   6. APPROVAL IS A STATUS FLIP, NOTHING MORE. Approving a revision
//      writes status "approved" (the ladder the schema has carried since
//      S112) — content, version, parent, provenance untouched. An approved
//      head is never superseded (law 1 of scene-revisions.ts); approval is
//      idempotent (approving an approved head is a no-op ok).

import type { Video } from "@prisma/client";
import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { parseScenes } from "./story";
import { parseTimeline, docSceneSettings } from "./timeline";
import { headRevision, headSummary } from "./scene-revisions";
import { artifactStaleness } from "./scene-artifacts";
import { qcCheck, analyzePass, ffprobeJson, parseSrt } from "./qc";
import type { QcCheck, QcStatus } from "./qc";
import { measureLoudness, detectStaticRuns, staticRunsDetail, LUFS_PASS_WINDOW, LRA_WARN, MIX_TARGETS } from "./audiomix";
import { detectSceneCuts, detectFlicker, detectStutter, CUT_TOL_SEC, STUTTER_LIMITS } from "./render-qc";
import {
  transitionOffsetsMulti,
  sanitizeTransitionStyle,
  resolveTransition,
  TRANSITION_IDS,
  type TransitionSettings,
  type TransitionStyle,
} from "./transitions";
import { runRestrictedVisualScan, resolveContentPolicy } from "./restricted-subjects";
import * as storage from "./storage";
import { probeDuration, resolveSceneDuration } from "./render";
import { setJobProgress } from "./jobs";
import { splitEntityId } from "./video-jobs";
import { log } from "./log";
import fs from "node:fs";

const recheckLog = log.child({ mod: "scene-qc" });

/** A stray this close to the seam's explanation window is a seam defect
 * (the join landing off-time, or a broken stitch at the join). Detections
 * further inside either scene's interior are the full battery's verdict —
 * with its shot-join windows — not this lens's. */
export const SEAM_NEIGHBORHOOD_SEC = 1.2;

// ---------- shapes ----------

/** What the pair's stitcher was told: where the seam sits on the pair's
 * blended clock, its style, and the window inside which any detection is
 * explained. Derived from the SAME durations + settings the render used. */
export interface SeamExpectation {
  afterScene: number;
  boundaryTime: number;
  style: TransitionStyle;
  durationSec: number;
  window: [number, number];
}

/** One seam's verdict inside a recheck report. `media` records what the
 * verdict was measured against: "boundary-preview" (the pair artifact) or
 * "none" (nothing standing — unmeasured, with the exact render command). */
export interface SeamVerdict {
  afterScene: number;
  status: QcStatus;
  media: "boundary-preview" | "none";
  value: string;
  detail?: string;
}

/** The report stored on the revision (schema 1). */
export interface SceneRecheckReport {
  schema: 1;
  scope: "scene";
  sceneIndex: number;
  sceneId: string | null;
  /** The head revision this verdict judged — the approval comparison key. */
  revisionVersion: number | null;
  /** The preview artifact the media checks measured, and its staleness
   * against the head at check time (the display-the-producing-version law). */
  builtFromPreview: { revisionVersion: number | null; staleness: "current" | "stale" | "unknown" } | null;
  checkedAt: string;
  passed: boolean;
  checks: QcCheck[];
  seams: SeamVerdict[];
}

// ---------- pure: the seam lens (unit-pinned) ----------

/** Where the seam between two rendered scenes sits on the pair's blended
 * clock — transitionOffsetsMulti is the stitcher's own math, so the
 * expectation can never disagree with where the pair was cut. Pure. */
export function seamExpectation(
  durationsSec: [number, number],
  setting: TransitionSettings,
  afterScene: number
): SeamExpectation {
  const offsets = transitionOffsetsMulti(durationsSec, [setting]);
  const boundaryTime = offsets[0] ?? 0;
  const style = sanitizeTransitionStyle(setting.style);
  const durationSec = style === "cut" ? 0 : Math.max(setting.durationSec, 0);
  const window: [number, number] =
    style === "cut"
      ? [boundaryTime - CUT_TOL_SEC, boundaryTime + CUT_TOL_SEC]
      : [Math.max(boundaryTime - 0.3, 0), boundaryTime + durationSec + 0.3];
  return { afterScene, boundaryTime, style, durationSec, window };
}

export interface SeamAlignment {
  status: "pass" | "fail";
  unexpected: number[];
  missing: boolean;
}

/** THE SEAM LAW (law 4). Pure — pinned with synthetic detections.
 * Explanation mirrors the whole-file lens exactly, seam-local: a CUT seam
 * explains detections within tol of the boundary (the cut window IS the
 * tolerance band — no double tolerance); a BLEND seam explains detections
 * inside its window ± tol (the window carries the fade's own ±0.3 padding). */
export function alignSeam(
  detected: number[],
  exp: SeamExpectation,
  tolSec: number = CUT_TOL_SEC
): SeamAlignment {
  const nearBoundary = detected.some((t) => Math.abs(t - exp.boundaryTime) <= tolSec);
  const explained =
    exp.style === "cut"
      ? (t: number): boolean => Math.abs(t - exp.boundaryTime) <= tolSec
      : (t: number): boolean => t >= exp.window[0] - tolSec && t <= exp.window[1] + tolSec;
  const neighborhood: [number, number] = [
    exp.window[0] - SEAM_NEIGHBORHOOD_SEC,
    exp.window[1] + SEAM_NEIGHBORHOOD_SEC,
  ];
  const unexpected = detected.filter(
    (t) => !explained(t) && t >= neighborhood[0] && t <= neighborhood[1]
  );
  const missing = exp.style === "cut" && !nearBoundary;
  return {
    status: missing || unexpected.length > 0 ? "fail" : "pass",
    unexpected,
    missing,
  };
}

// ---------- pure: the scene-sliced caption lens (unit-pinned) ----------

export interface SceneCueSlice {
  start: number;
  end: number;
}

/** Scene-scoped caption timing (law 1's honest slice of the whole-file
 * captions check): the cues intersecting the scene's doc window must be
 * monotonic, non-overlapping, and — with a 1 s seam grace — contained in
 * it; a scene with narration must own at least one cue. Pure. */
export function checkSceneCues(
  cues: SceneCueSlice[],
  window: [number, number],
  hasNarration: boolean
): { status: QcStatus; value: string; detail?: string } {
  const GRACE = 1.0;
  const inside = cues.filter((c) => c.end > window[0] && c.start < window[1]);
  if (inside.length === 0)
    return hasNarration
      ? {
          status: "fail",
          value: "no cues in the scene's window",
          detail: `window ${window[0].toFixed(1)}–${window[1].toFixed(1)}s — the scene's words are not captioned`,
        }
      : { status: "pass", value: "no narration, no cues due" };
  let monotonic = true;
  for (let i = 1; i < inside.length; i++) {
    if (inside[i].start < inside[i - 1].start - 0.01 || inside[i].start < inside[i - 1].end - 0.01) {
      monotonic = false;
      break;
    }
  }
  if (!monotonic)
    return { status: "fail", value: `${inside.length} cues, overlapping or out of order` };
  const contained = inside.every(
    (c) => c.start >= window[0] - GRACE && c.end <= window[1] + GRACE
  );
  if (!contained)
    return {
      status: "fail",
      value: `${inside.length} cues, some cross the seam beyond ${GRACE.toFixed(0)}s grace`,
      detail: "a cue crossing the boundary drifts into the neighbour's window — caption timing defect at scene scope",
    };
  return { status: "pass", value: `${inside.length} cues in order, inside the window` };
}

// ---------- pure: the verdict + approval gate (unit-pinned) ----------

/** Law 1: the report is clean only when EVERY check and EVERY seam verdict
 * ran AND passed — an unmeasured anything keeps it red for a human. Pure. */
export function recheckVerdictPassed(checks: QcCheck[], seams: SeamVerdict[]): boolean {
  return (
    checks.length > 0 &&
    checks.every((c) => c.status === "pass") &&
    seams.every((s) => s.status === "pass")
  );
}

export type SceneApprovalBlock =
  | {
      ok: false;
      reason: "no-history" | "no-verdict" | "stale-verdict" | "verdict-failed";
      message: string;
    }
  | { ok: true; already: boolean };

/** THE APPROVAL GATE (the stage's exit criterion, pure): a revision may be
 * approved only when a recheck verdict exists, judged the HEAD's OWN
 * version, and passed. Approving an already-approved head is an idempotent
 * ok (no second write, no error). */
export function approvalBlocker(
  head: { version: number; status: string } | null,
  verdict: SceneRecheckReport | null
): SceneApprovalBlock {
  if (!head)
    return {
      ok: false,
      reason: "no-history",
      message: "Scene has no revision history — nothing to approve",
    };
  if (head.status === "approved") return { ok: true, already: true };
  if (!verdict)
    return {
      ok: false,
      reason: "no-verdict",
      message: `Scene v${head.version} has no recheck verdict — run the recheck first`,
    };
  if (verdict.revisionVersion !== head.version)
    return {
      ok: false,
      reason: "stale-verdict",
      message: `The verdict judged v${verdict.revisionVersion}, the head is v${head.version} — re-run the recheck`,
    };
  if (!verdict.passed) {
    const flagged = [...verdict.checks, ...verdict.seams].filter((x) => x.status !== "pass").length;
    return {
      ok: false,
      reason: "verdict-failed",
      message: `The recheck flagged ${flagged} item(s) — fix them and re-run before approving`,
    };
  }
  return { ok: true, already: false };
}

/** Tolerant parse of a stored verdict — schema 1 only, nothing fabricated:
 * corrupt/foreign JSON reads as null (approval then refuses for lack of a
 * verdict, never approves on a guess). */
export function parseRecheckReport(json: string | null | undefined): SceneRecheckReport | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.schema !== 1 || obj.scope !== "scene" || !Array.isArray(obj.checks) || !Array.isArray(obj.seams))
    return null;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const checks = (obj.checks as Record<string, unknown>[]).map((c) => ({
    id: String(c.id ?? ""),
    label: String(c.label ?? ""),
    status: (["pass", "fail", "unmeasured"].includes(String(c.status))
      ? String(c.status)
      : "unmeasured") as QcStatus,
    pass: c.status === "pass",
    value: String(c.value ?? ""),
    ...(c.detail !== undefined && c.detail !== null ? { detail: String(c.detail) } : {}),
  }));
  const seams = (obj.seams as Record<string, unknown>[]).map((s) => ({
    afterScene: num(s.afterScene) ?? 0,
    status: (["pass", "fail", "unmeasured"].includes(String(s.status))
      ? String(s.status)
      : "unmeasured") as QcStatus,
    media: (s.media === "boundary-preview" ? "boundary-preview" : "none") as "boundary-preview" | "none",
    value: String(s.value ?? ""),
    ...(s.detail !== undefined && s.detail !== null ? { detail: String(s.detail) } : {}),
  }));
  return {
    schema: 1,
    scope: "scene",
    sceneIndex: num(obj.sceneIndex) ?? 0,
    sceneId: typeof obj.sceneId === "string" ? obj.sceneId : null,
    revisionVersion: num(obj.revisionVersion),
    builtFromPreview:
      obj.builtFromPreview && typeof obj.builtFromPreview === "object"
        ? {
            revisionVersion: num((obj.builtFromPreview as Record<string, unknown>).revisionVersion),
            staleness: (["current", "stale", "unknown"].includes(
              String((obj.builtFromPreview as Record<string, unknown>).staleness)
            )
              ? String((obj.builtFromPreview as Record<string, unknown>).staleness)
              : "unknown") as "current" | "stale" | "unknown",
          }
        : null,
    checkedAt: typeof obj.checkedAt === "string" ? obj.checkedAt : new Date(0).toISOString(),
    passed: obj.passed === true,
    checks,
    seams,
  };
}

// ---------- keys ----------

const pad2 = (n: number) => String(n).padStart(2, "0");

export function scenePreviewKey(videoId: string, sceneIndex: number): string {
  return `${videoId}/scene-preview-${pad2(sceneIndex)}.mp4`;
}

export function sceneBoundaryKey(videoId: string, afterScene: number): string {
  return `${videoId}/scene-boundary-${pad2(afterScene)}.mp4`;
}

// ---------- the battery ----------

/** The seams a scene owns: the seam BEFORE it (afterScene = index−1, when
 * the scene is not the first) and the seam AFTER it (afterScene = index,
 * when the scene is not the last). Pure. */
export function seamsOfScene(sceneIndex: number, sceneCount: number): number[] {
  const out: number[] = [];
  if (sceneIndex > 1 && sceneIndex <= sceneCount) out.push(sceneIndex - 1);
  if (sceneIndex >= 1 && sceneIndex < sceneCount) out.push(sceneIndex);
  return out;
}

/** The seam's effective setting — EXACTLY the read renderVideo's stitcher
 * does: the incoming scene's doc transitionIn over the video-level default
 * (resolveTransition is the one shared law). */
function seamSetting(video: Video, timelineDocScenes: { transitionIn: string | null }[] | null, incomingPos: number): TransitionSettings {
  const def = resolveTransition(video, video.renderMode);
  const docStyle = timelineDocScenes?.[incomingPos]?.transitionIn ?? null;
  return {
    style:
      docStyle != null && TRANSITION_IDS.has(docStyle as never)
        ? sanitizeTransitionStyle(docStyle)
        : def.style,
    durationSec: def.durationSec,
  };
}

/**
 * Run the scene-scoped recheck. Never throws for missing media — every
 * absent input lands as an honest "unmeasured" with its reason (law 1).
 * The verdict is persisted onto the head revision's `recheck` column
 * (annotation; content untouched) and returned. A scene with no revision
 * history still checks (revisionVersion null) but stores nothing — there
 * is no revision to annotate; approval refuses on no-history anyway.
 */
export async function runSceneRecheck(
  videoId: string,
  sceneIndex: number,
  opts: { triggered?: string } = {}
): Promise<SceneRecheckReport> {
  assertCtx("runSceneRecheck");
  const video = await db.video.findUnique({ where: { id: videoId } });
  if (!video) throw new Error("Video not found");
  if (video.format !== "story") throw new Error("Not a scene-based video");
  const scenes = parseScenes(video.scenes);
  const scene = scenes.find((s) => s.index === sceneIndex);
  if (!scene) throw new Error(`Scene ${sceneIndex} does not exist`);

  const head = scene.id ? await headRevision(videoId, scene.id) : null;
  const headVersion = head?.version ?? null;
  const checks: QcCheck[] = [];
  const triggered = opts.triggered ?? "manual";

  // ---- the media: the standing scene preview (S114's lane) ----
  const previewKey = scenePreviewKey(videoId, sceneIndex);
  const previewStat = await storage.stat(previewKey).catch(() => null);
  const previewArtifact = await db.sceneArtifact
    .findFirst({
      where: { videoId, storageKey: previewKey, type: "preview" },
      orderBy: { createdAt: "desc" },
    })
    .catch(() => null);
  const staleness: "current" | "stale" | "unknown" = previewArtifact
    ? artifactStaleness(previewArtifact, headVersion)
    : "unknown";

  // Law: display the producing version — the freshness check IS a check row.
  checks.push(
    qcCheck(
      "preview-freshness",
      "Preview built from the current revision",
      staleness === "current" ? "pass" : staleness === "unknown" ? "unmeasured" : "fail",
      staleness === "current"
        ? `built from v${previewArtifact?.revisionVersion ?? "?"}`
        : staleness === "unknown"
          ? previewStat
            ? "provenance unknown (pre-tracking preview)"
            : "no scene preview rendered"
          : `built from v${previewArtifact?.revisionVersion ?? "?"}, head is v${headVersion ?? "?"}`,
      previewStat
        ? undefined
        : `POST /api/videos/${videoId}/render with {"sceneIndex": ${sceneIndex}} renders the preview, then re-run the recheck`
    )
  );

  // The doc + its per-scene settings/windows. EVERY doc read below is
  // gated on the ONE alignment condition the render uses (a stale doc must
  // never reach the expectation partially — the boundary job passes the
  // doc's slice only when aligned, so an unaligned doc means the render
  // ignored it and the expectation must too).
  const timeline = parseTimeline(video.timeline);
  const docAligned = timeline != null && timeline.scenes.length === scenes.length;
  const docSettings = docAligned ? docSceneSettings(timeline, scenes.length) : null;
  const pos = scenes.findIndex((s) => s.index === sceneIndex);
  const docWindow: [number, number] | null =
    docAligned && pos >= 0
      ? (() => {
          const ds = timeline.scenes[pos];
          return ds && Number.isFinite(ds.startSec) && Number.isFinite(ds.endSec)
            ? [ds.startSec, ds.endSec]
            : null;
        })()
      : null;

  // THE TIMING SPLIT (law 3, stated once): the scene preview's timing is
  // WAV-DERIVED (the S114 lane passes no sceneDurationsSec — narration is
  // the scene's clock), so the duration expectation mirrors EXACTLY those
  // inputs through the shared fold. The doc's timing truth (trims, holds)
  // is judged where it lives: at the SEAM, by the boundary lane, which
  // DOES consume the doc's durations. Each expectation mirrors its own
  // media's render inputs — never a blended fabrication of the two.
  let expectedDuration: number | null = null;
  if (previewStat) {
    try {
      const wavPath = await storage.materialize(`${videoId}/scene-${pad2(sceneIndex)}.wav`);
      const wavDur = await probeDuration(wavPath);
      expectedDuration = resolveSceneDuration(wavDur, Number.NaN, Number.NaN);
    } catch {
      expectedDuration = null;
    }
  }

  if (previewStat) {
    const mp4Path = await storage.materialize(previewKey);

    // 1) Playability + geometry + duration.
    let duration = 0;
    let dimensions: { width?: number; height?: number } | null = null;
    try {
      const info = await ffprobeJson(mp4Path);
      const hasVideo = Boolean(
        info.streams?.some((s) => s.codec_type === "video" && s.codec_name === "h264")
      );
      const hasAudio = Boolean(
        info.streams?.some((s) => s.codec_type === "audio" && s.codec_name === "aac")
      );
      const probed = Number(info.format?.duration ?? 0);
      if (Number.isFinite(probed) && probed > 0) duration = probed;
      dimensions = info.streams?.find((s) => s.codec_type === "video") ?? null;
      checks.push(
        qcCheck(
          "playable",
          "Preview plays as a valid MP4 (H.264 video + AAC audio)",
          hasVideo && hasAudio ? "pass" : "fail",
          hasVideo && hasAudio
            ? `${duration.toFixed(1)}s readable`
            : "stream missing"
        )
      );
    } catch (err) {
      checks.push(
        qcCheck("playable", "Preview plays as a valid MP4", "fail", "ffprobe failed", String(err).slice(0, 200))
      );
    }

    if (expectedDuration != null && duration > 0) {
      const drift = duration - expectedDuration;
      const tolerance = Math.max(2, expectedDuration * 0.2);
      checks.push(
        qcCheck(
          "duration",
          "Preview length matches the scene's render timing",
          drift >= -1 && drift <= tolerance ? "pass" : "fail",
          `preview ${duration.toFixed(1)}s vs expected ${expectedDuration.toFixed(1)}s`,
          `drift ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}s — the render's own fold (WAV + timeline) is the expectation`
        )
      );
    } else {
      checks.push(
        qcCheck(
          "duration",
          "Preview length matches the scene's render timing",
          "unmeasured",
          "no expectation derivable",
          "the scene WAV or the preview duration could not be probed"
        )
      );
    }

    if (dimensions?.width && dimensions?.height) {
      const ratio = dimensions.width / dimensions.height;
      const aspect = video.aspectRatio === "9:16" ? 9 / 16 : video.aspectRatio === "1:1" ? 1 : 16 / 9;
      const ok = Math.abs(ratio - aspect) <= 0.02;
      checks.push(
        qcCheck(
          "aspect",
          "Frame geometry matches the project (no squeeze/crop)",
          ok ? "pass" : "fail",
          `${dimensions.width}x${dimensions.height}`
        )
      );
    }

    // 2) The combined analysis pass — black + frozen + silence, the SAME
    // probe shell the whole-file battery runs (no private copies).
    const analysis = await analyzePass(mp4Path);
    const stderr = analysis.stderr;
    const analysisRan = analysis.ok;

    const blacks = [
      ...stderr.matchAll(/\[blackdetect[^\]]*\]\s*(?:lavfi\.blackdetect\.)?black_start:\s*(\d+(?:\.\d+)?)/g),
    ].map((m) => Number(m[1]));
    checks.push(
      qcCheck(
        "black-frames",
        "No unexplained black frames",
        !analysisRan
          ? "unmeasured"
          : blacks.length === 0
            ? "pass"
            : "fail",
        !analysisRan ? "analysis failed" : blacks.length === 0 ? "none detected" : `${blacks.length} interval${blacks.length > 1 ? "s" : ""}`,
        !analysisRan
          ? "ffmpeg could not complete the scan — this check did not run"
          : blacks.slice(0, 4).map((s) => `at ${s}s`).join(", ")
      )
    );

    const freezes = [
      ...stderr.matchAll(/\[freezedetect[^\]]*\]\s*(?:lavfi\.freezedetect\.)?freeze_start:\s*(\d+(?:\.\d+)?)/g),
    ].map((m) => Number(m[1]));
    checks.push(
      qcCheck(
        "frozen-frames",
        "No frozen imagery (motion everywhere)",
        !analysisRan
          ? "unmeasured"
          : freezes.length === 0
            ? "pass"
            : "fail",
        !analysisRan ? "analysis failed" : freezes.length === 0 ? "none detected" : `${freezes.length} frozen run${freezes.length > 1 ? "s" : ""}`,
        !analysisRan
          ? "ffmpeg could not complete the scan — this check did not run"
          : freezes.slice(0, 4).map((s) => `at ${s}s`).join(", ")
      )
    );

    // 3) The loudness family — same windows, same tolerance story.
    const lm = await measureLoudness(mp4Path);
    checks.push(
      qcCheck(
        "loudness",
        `Broadcast loudness (${MIX_TARGETS.integratedLUFS} LUFS target)`,
        lm === null
          ? "unmeasured"
          : lm.integratedLUFS >= LUFS_PASS_WINDOW[0] && lm.integratedLUFS <= LUFS_PASS_WINDOW[1]
            ? "pass"
            : "fail",
        lm === null ? "not measured" : `${lm.integratedLUFS.toFixed(1)} LUFS`,
        lm === null ? "loudness analysis failed" : `window ${LUFS_PASS_WINDOW[0]}…${LUFS_PASS_WINDOW[1]} LUFS`
      )
    );
    checks.push(
      qcCheck(
        "true-peak",
        "True peak ≤ -1 dBTP (no clipping after encode)",
        lm === null ? "unmeasured" : lm.truePeakDBTP <= MIX_TARGETS.truePeakDBTP + 0.2 ? "pass" : "fail",
        lm === null ? "not measured" : `${lm.truePeakDBTP.toFixed(1)} dBTP`
      )
    );
    checks.push(
      qcCheck(
        "loudness-range",
        "Consistent volume (loudness range)",
        lm === null ? "unmeasured" : lm.lra <= LRA_WARN ? "pass" : "fail",
        lm === null ? "not measured" : `LRA ${lm.lra.toFixed(1)} LU`
      )
    );

    const silences = [
      ...stderr.matchAll(/\[silencedetect[^\]]*\]\s*(?:lavfi\.silencedetect\.)?silence_start:\s*(\d+(?:\.\d+)?)/g),
    ].map((m) => Number(m[1]))
      .filter((s) => s > 1 && s < duration - 2);
    checks.push(
      qcCheck(
        "dead-air",
        "No dead air (voice or music always present)",
        !analysisRan
          ? "unmeasured"
          : silences.length === 0
            ? "pass"
            : "fail",
        !analysisRan ? "analysis failed" : silences.length === 0 ? "none" : `${silences.length} silent run${silences.length > 1 ? "s" : ""}`,
        !analysisRan
          ? "ffmpeg could not complete the scan — this check did not run"
          : silences.slice(0, 4).map((s) => `at ${s.toFixed(1)}s`).join(", ")
      )
    );

    // 4) The pacing + timing lenses (sampled scan, flicker, stutter) — the
    // plan-rhythm lens stays project-scope (it judges runs ACROSS scenes).
    const staticPass = await detectStaticRuns(mp4Path);
    checks.push(
      qcCheck(
        "static-shots",
        "Visual pacing — no long static stretches",
        !staticPass.measured ? "unmeasured" : staticPass.runs.length === 0 ? "pass" : "fail",
        !staticPass.measured ? "not measured" : staticPass.runs.length === 0 ? "visual change throughout" : `${staticPass.runs.length} static run${staticPass.runs.length > 1 ? "s" : ""}`,
        !staticPass.measured ? "visual-change scan failed — this check did not run" : staticRunsDetail(staticPass.runs)
      )
    );

    const flick = await detectFlicker(mp4Path);
    checks.push(
      qcCheck(
        "flicker",
        "Steady brightness (no flicker or pumping)",
        !flick.measured ? "unmeasured" : flick.events.length === 0 ? "pass" : "fail",
        !flick.measured ? "not measured" : flick.events.length === 0 ? "none detected" : `${flick.events.length} pumping run${flick.events.length > 1 ? "s" : ""}`,
        !flick.measured ? "luma-sampling probe failed — this check did not run" : undefined
      )
    );

    const fps = video.frameRate === 24 || video.frameRate === 60 ? video.frameRate : 30;
    const stut = await detectStutter(mp4Path, fps);
    const stutterBad = stut.dupRuns.length > 0 || stut.gaps.length >= STUTTER_LIMITS.gapCountMin;
    checks.push(
      qcCheck(
        "stutter",
        "Even frame timing (no stutter)",
        !stut.measured ? "unmeasured" : stutterBad ? "fail" : "pass",
        !stut.measured ? "not measured" : stutterBad ? `${stut.dupRuns.length} duplicate-frame run(s), ${stut.gaps.length} gap(s)` : "even timing throughout"
      )
    );

    // 5) Scene-sliced captions — the standing SRT (when one stands) sliced
    // to the scene's doc window. The whole-file battery's own precedent
    // (qc.ts: "when an SRT ships alongside") is the law here: NO standing
    // SRT → the check is NOT EMITTED (post-edit the SRT is swept; the scene
    // preview's burned captions are the pixels to eyeball) — an absent
    // input is not a measurement that failed to run, and never-silently-
    // clean governs checks that COULD run, not inputs that do not exist.
    if (docWindow) {
      const srtPath = await storage.materialize(`${videoId}/subtitles.srt`).catch(() => null);
      if (srtPath && fs.existsSync(srtPath)) {
        try {
          const cues = parseSrt(fs.readFileSync(srtPath, "utf8"));
          const r = checkSceneCues(cues, docWindow, Boolean(scene.narration?.trim()));
          checks.push(
            qcCheck("captions", "Scene captions timed to the scene's window", r.status, r.value, r.detail)
          );
        } catch {
          checks.push(qcCheck("captions", "Scene captions timed to the scene's window", "unmeasured", "SRT unreadable"));
        }
      }
    }

    // 6) S49 at scene scope — the restricted-visual chain holds for the
    // scene segment exactly as it holds for the file (law 5: policy-gated,
    // human-clicked, aiCall-metered).
    if (resolveContentPolicy(video.contentPolicy) === "islamic-history") {
      const scan = await runRestrictedVisualScan({
        mp4Path,
        durationSec: duration > 0 ? duration : 1,
      });
      checks.push(
        qcCheck(
          "restricted-visual",
          "No depiction of restricted religious figures (content policy)",
          scan.status,
          scan.value,
          scan.detail
        )
      );
    }
  } else {
    // No preview standing — the freshness row ABOVE already carries the
    // whole story (unmeasured + the exact render command). Emitting a dozen
    // more unmeasured rows would be noise, not honesty: the report is short,
    // red, and actionable. (The seam verdicts below still land — they are
    // their own lane.)
  }

  // ---- the seams (law 3): the boundary-pair lens ----
  const seams: SeamVerdict[] = [];
  for (const afterScene of seamsOfScene(sceneIndex, scenes.length)) {
    const key = sceneBoundaryKey(videoId, afterScene);
    const stat = await storage.stat(key).catch(() => null);
    if (!stat) {
      seams.push({
        afterScene,
        status: "unmeasured",
        media: "none",
        value: "boundary pair not rendered",
        detail: `POST /api/videos/${videoId}/render with {"boundaryAfter": ${afterScene}} renders scenes ${afterScene}+${afterScene + 1} with their seam, then re-run the recheck`,
      });
      continue;
    }
    // The pair's expected durations — the render's own fold over the pair's
    // WAVs + the doc's picks (the boundary job passes the doc's slice, so
    // this IS what the stitcher consumed).
    const positions = [afterScene - 1, afterScene]; // 0-based positions of the pair
    const pairDurations: [number, number] | null = await (async () => {
      try {
        const durs: number[] = [];
        for (const p of positions) {
          const idx = scenes[p]?.index;
          if (idx == null) return null;
          const wavPath = await storage.materialize(`${videoId}/scene-${pad2(idx)}.wav`);
          const wavDur = await probeDuration(wavPath);
          const docDur = docAligned ? timeline.scenes[p]?.durationSec : undefined;
          durs.push(
            resolveSceneDuration(
              wavDur,
              typeof docDur === "number" && Number.isFinite(docDur) && docDur > 0 ? docDur : Number.NaN,
              docSettings?.[p]?.speed ?? Number.NaN
            )
          );
        }
        return [durs[0], durs[1]];
      } catch {
        return null;
      }
    })();
    if (!pairDurations) {
      seams.push({
        afterScene,
        status: "unmeasured",
        media: "boundary-preview",
        value: "pair timing not derivable",
        detail: "a scene WAV of the pair is missing — regenerate the voiceover",
      });
      continue;
    }
    const setting = seamSetting(video, docSettings, positions[1]);
    const exp = seamExpectation(pairDurations, setting, afterScene);
    const mp4Path = await storage.materialize(key);
    const detected = await detectSceneCuts(mp4Path);
    if (!detected.measured) {
      seams.push({
        afterScene,
        status: "unmeasured",
        media: "boundary-preview",
        value: "scene-change probe failed",
        detail: "the boundary file could not be decoded — re-render the pair",
      });
      continue;
    }
    const aligned = alignSeam(detected.cuts, exp);
    const parts: string[] = [];
    if (aligned.missing) parts.push(`timeline cut missing at ${exp.boundaryTime.toFixed(1)}s`);
    for (const t of aligned.unexpected.slice(0, 3))
      parts.push(`stray cut at ${t.toFixed(1)}s (seam expected at ${exp.boundaryTime.toFixed(1)}s)`);
    seams.push({
      afterScene,
      status: aligned.status,
      media: "boundary-preview",
      value:
        aligned.status === "pass"
          ? exp.style === "cut"
            ? `cut in place at ${exp.boundaryTime.toFixed(1)}s`
            : `blend window clean at ${exp.boundaryTime.toFixed(1)}s`
          : parts.join(", ") || "seam misaligned",
      detail:
        exp.style === "cut"
          ? `seam ${afterScene}|${afterScene + 1} is a hard cut at ${exp.boundaryTime.toFixed(1)}s (pair ${pairDurations[0].toFixed(1)}s + ${pairDurations[1].toFixed(1)}s)`
          : `seam ${afterScene}|${afterScene + 1} blends ${exp.durationSec.toFixed(1)}s from ${exp.boundaryTime.toFixed(1)}s`,
    });
  }

  const report: SceneRecheckReport = {
    schema: 1,
    scope: "scene",
    sceneIndex,
    sceneId: scene.id ?? null,
    revisionVersion: headVersion,
    builtFromPreview: previewStat
      ? {
          revisionVersion: previewArtifact?.revisionVersion ?? null,
          staleness,
        }
      : null,
    checkedAt: new Date().toISOString(),
    passed: recheckVerdictPassed(checks, seams),
    checks,
    seams,
  };

  // Persist the verdict onto the head revision (the annotation column).
  // Content is never touched (law 2); a fresh recheck of the same head
  // overwrites the annotation with a fresher checkedAt — that IS the
  // column's contract (the verdict of record for this revision).
  if (head) {
    await db.sceneRevision.update({
      where: { id: head.id },
      data: { recheck: JSON.stringify(report) },
    });
    await db.activity
      .create({
        data: {
          organizationId: video.organizationId,
          videoId,
          stage: "qc",
          message: report.passed
            ? `Scene ${sceneIndex} recheck clean — v${head.version} is approvable (${report.checks.length} checks, ${report.seams.length} seam(s))`
            : `Scene ${sceneIndex} recheck flagged ${[...report.checks, ...report.seams].filter((x) => x.status !== "pass").length} item(s) on v${head.version}`,
        },
      })
      .catch(() => {});
  } else {
    recheckLog.info("scene recheck ran without revision history — verdict returned, nothing stored", {
      videoId,
      sceneIndex,
      triggered,
    });
  }

  return report;
}

// ---------- the job wrapper ----------

/** The durable job body (kind "scene-recheck"; entityId
 * "<videoId>#scene<N>" — the composite convention). Crash-resumed rows
 * re-run the battery idempotently: the verdict is a fresh measurement of
 * standing media, never a mutation of content. */
export async function runSceneRecheckJob(entityId: string): Promise<void> {
  assertCtx("runSceneRecheckJob");
  const [videoId, suffix] = splitEntityId(entityId, "#scene");
  const sceneIndex = suffix !== null ? Number(suffix) : NaN;
  if (!Number.isInteger(sceneIndex) || sceneIndex < 1)
    throw new Error("Scene recheck job has no valid scene index");
  setJobProgress(entityId, "scene-recheck", 0, 1, "Re-checking the scene");
  const report = await runSceneRecheck(videoId, sceneIndex, { triggered: "job" });
  setJobProgress(
    entityId,
    "scene-recheck",
    1,
    1,
    report.passed ? "Scene recheck passed" : "Scene recheck flagged issues"
  );
}

// ---------- the approve arm (law 6) ----------

export type ApproveRevisionResult =
  | { ok: false; status: number; message: string }
  | { ok: true; already: boolean; revision: ReturnType<typeof headSummary> };

/** APPROVE — the status flip the whole stage exists to gate. Requires a
 * PASSING verdict for the head's OWN version (approvalBlocker, pure);
 * writes status "approved" and nothing else. Idempotent on an approved
 * head. The Activity row records the human's call. */
export async function approveSceneRevision(input: {
  video: Video;
  sceneIndex: number;
  userId?: string | null;
}): Promise<ApproveRevisionResult> {
  const scene = parseScenes(input.video.scenes).find((s) => s.index === input.sceneIndex);
  if (!scene)
    return { ok: false, status: 404, message: `Scene ${input.sceneIndex} does not exist` };
  if (!scene.id)
    return {
      ok: false,
      status: 409,
      message: "Scene has no revision history — nothing to approve",
    };
  const head = await headRevision(input.video.id, scene.id);
  if (!head)
    return {
      ok: false,
      status: 409,
      message: "Scene has no revision history — nothing to approve",
    };
  const verdict = parseRecheckReport(head.recheck);
  const block = approvalBlocker({ version: head.version, status: head.status }, verdict);
  if (!block.ok) return { ok: false, status: 409, message: block.message };
  if (!block.already) {
    await db.sceneRevision.update({
      where: { id: head.id },
      data: { status: "approved" },
    });
    await db.activity
      .create({
        data: {
          organizationId: input.video.organizationId,
          userId: input.userId ?? null,
          videoId: input.video.id,
          stage: "qc",
          message: `Scene ${input.sceneIndex} v${head.version} approved — recheck passed (${verdict?.checks.length ?? 0} checks, ${verdict?.seams.length ?? 0} seam(s) clean)`,
        },
      })
      .catch(() => {});
  }
  return { ok: true, already: block.already, revision: headSummary(head) };
}
