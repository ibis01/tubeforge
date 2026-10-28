// Shared AI-script background job with storm-round resilience.
//
// One script job = up to STORM_ROUNDS rounds. Each round runs the full
// generation (which already carries ~16.5 min of 429 backoff inside
// generateScriptPackage / generateSceneScriptPackage); between rounds we
// cool down and then start a FRESH backoff curve — fresh curves re-probe
// the gateway quickly, so short quota windows are caught instead of
// overslept by deep 8.5-minute backoffs.
//
// Cool-downs ESCALATE (3 → 6 → 10 → 15 → 20 min): early rounds catch short
// blips, later rounds settle into a slow heartbeat so a multi-hour quota
// storm gets probed gently instead of hammered (some gateways extend their
// window on every rejected request — hammering self-sustains the block).
//
// Total auto-patience ≈ 6 × 16.5 min backoff + 54 min cool-downs ≈ 2.5 hours
// of riding out sustained quota storms, while the video stays on
// "Writing script…" in the UI (no user action needed).

import { db } from "@/lib/db";
import { generateScriptPackage } from "./ai";
import { generateSceneScriptPackage } from "./story";
import { JobCancelledError, cancellableSleep, throwIfCancelled } from "./cancel";
import { errorText } from "@/lib/tubeforge/redact";

const STORM_ROUNDS = 6;
/** Escalating cool-down between storm rounds, in minutes (index = round-1). */
const ROUND_COOLDOWN_MIN = [3, 6, 10, 15, 20];

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;
/**
 * Run the AI script stage for a video as a background job body.
 * Handles classic narration AND scene-based story formats, mirrors
 * results into the Video record, and auto-retries across quota storms.
 */
export async function runScriptJob(videoId: string): Promise<void> {
  for (let round = 1; round <= STORM_ROUNDS; round++) {
    // Stop requested while queued/cooling — unwind before touching the DB.
    throwIfCancelled();

    // Fresh state each round — the user may tweak voice/format while waiting.
    const video = await db.video.findUnique({
      where: { id: videoId },
      include: { character: true },
    });

    // Video deleted while the job was queued/running — end quietly.
    if (!video) return;

    // Another run already finished the script (e.g. manual re-kick raced us).
    if (video.status === "scripted" && video.script) return;

    try {
      await db.video.update({
        where: { id: videoId },
        data: { status: "scripting", error: null },
      });

      if (video.format === "story") {
        const pkg = await generateSceneScriptPackage({
          topic: video.topic,
          niche: video.niche,
          tone: video.tone,
          length: video.length,
          character: video.character
            ? {
                name: video.character.name,
                personality: video.character.personality,
                identityAnchor: video.character.identityAnchor,
              }
            : null,
        });

        await db.video.update({
          where: { id: videoId },
          data: {
            title: pkg.title,
            script: pkg.script,
            description: pkg.description,
            tags: pkg.tags.join(", "),
            scenes: JSON.stringify(pkg.scenes),
            wordCount: wordCount(pkg.script),
            status: "scripted",
            error: null,
          },
        });

        await db.activity.create({
          data: {
            videoId,
            stage: "script",
            message: `Scene script written — "${pkg.title}" (${pkg.scenes.length} scenes, ${wordCount(pkg.script)} words)`,
          },
        });
      } else {
        const pkg = await generateScriptPackage({
          topic: video.topic,
          niche: video.niche,
          tone: video.tone,
          length: video.length,
        });

        await db.video.update({
          where: { id: videoId },
          data: {
            title: pkg.title,
            script: pkg.script,
            description: pkg.description,
            tags: pkg.tags.join(", "),
            wordCount: wordCount(pkg.script),
            status: "scripted",
            error: null,
          },
        });

        await db.activity.create({
          data: {
            videoId,
            stage: "script",
            message: `Script written by GLM — "${pkg.title}" (${wordCount(pkg.script)} words)`,
          },
        });
      }

      return; // landed
    } catch (err) {
      // User pressed Stop — land the video in a clean, re-kickable state and
      // let the cancellation bubble to the registry (row -> "cancelled").
      if (err instanceof JobCancelledError) {
        await db.activity
          .create({
            data: {
              videoId,
              stage: "script",
              message: "Script generation stopped by user",
            },
          })
          .catch(() => {});
        await db.video
          .update({ where: { id: videoId }, data: { status: "failed", error: "Cancelled by user" } })
          .catch(() => {});
        throw err;
      }

      const message =
        errorText(err, "Script generation failed");
      const rateLimited = /429|too many requests/i.test(message);

      if (rateLimited && round < STORM_ROUNDS) {
        const cooldownMin = ROUND_COOLDOWN_MIN[round - 1] ?? 20;
        console.warn(
          `[script-job] round ${round}/${STORM_ROUNDS} exhausted in a quota storm — cooling down ${cooldownMin} min, then retrying with a fresh backoff curve`
        );
        // Cancellable — a Stop press lands within 500ms mid-cool-down.
        await cancellableSleep(cooldownMin * 60_000);
        continue;
      }

      // Final round (or a non-rate-limit error) — surface the failure.
      await db.activity.create({
        data: {
          videoId,
          stage: "script",
          level: "error",
          message: `Script generation failed: ${message}`,
        },
      });
      // The video row may have been deleted mid-flight — tolerate that.
      await db.video
        .update({ where: { id: videoId }, data: { status: "failed", error: message } })
        .catch(() => {});
      throw err; // job registry marks the row "failed"
    }
  }
}
