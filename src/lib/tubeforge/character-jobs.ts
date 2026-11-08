// Character-stage background job bodies (Stage 3 close-out).
//
// Same contract as video-jobs.ts: one implementation per job kind, shared by
// the route closure (in-process) and the durable queue's crash-recovery
// handler. Both stages derive EVERYTHING from the character row, so no
// payload is needed — a restart resumes with the current appearance/anchor.

import { db } from "./tenant-db";
import { assertCtx } from "./tenant";
import { errorText } from "@/lib/tubeforge/redact";
import { generateCharacterPortrait, generateCharacterPoses } from "./characters";
import { log } from "./log";

// S57/T-57.2 — the module's logger (the old [portrait-job]/[poses-job]
// prefixes became bindings).
const charJobsLog = log.child({ mod: "character-jobs" });

/** Generate the character's reference portrait. */
export async function runPortraitJob(characterId: string): Promise<void> {
  const ctx = assertCtx("runPortraitJob");
  const character = await db.character.findUnique({ where: { id: characterId } });
  if (!character) return; // deleted while queued — end quietly

  try {
    const result = await generateCharacterPortrait({
      characterId,
      name: character.name,
      appearance: character.appearance,
      identityAnchor: character.identityAnchor,
      artStyle: character.artStyle,
      referenceImages: character.referenceImages,
    });
    await db.character.update({
      where: { id: characterId },
      data: { hasPortrait: true },
    });
    await db.activity.create({
      data: {
        organizationId: character.organizationId,
        userId: ctx.userId,
        stage: "character",
        message: `Reference portrait generated for ${character.name} (${Math.round(
          result.fileBytes / 1024
        )} KB)`,
      },
    });
  } catch (err) {
    // Characters have no error column — the job row carries the failure for
    // the client (serializeCharacter reads the in-memory map + Job history).
    charJobsLog.error("portrait job failed", { characterId, err: errorText(err, "portrait failed") });
    throw err;
  }
}

/** Generate the identity-locked consistency sheet (poses). */
export async function runPosesJob(characterId: string): Promise<void> {
  const ctx = assertCtx("runPosesJob");
  const character = await db.character.findUnique({ where: { id: characterId } });
  if (!character) return;

  try {
    const result = await generateCharacterPoses({
      characterId,
      identityAnchor: character.identityAnchor,
    });
    await db.activity.create({
      data: {
        organizationId: character.organizationId,
        userId: ctx.userId,
        stage: "character",
        message: `Consistency sheet complete for ${character.name} — ${result.generated.length} identity-locked poses`,
      },
    });
  } catch (err) {
    charJobsLog.error("poses job failed", { characterId, err: errorText(err, "poses failed") });
    throw err;
  }
}
