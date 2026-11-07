import { makeReferenceHandlers } from "@/lib/tubeforge/reference-routes";
import { db } from "@/lib/tubeforge/tenant-db";
import { CHARACTER_REFERENCE_CAP } from "@/lib/tubeforge/references";

/**
 * S51 — cast reference photos: the writer for `Character.referenceImages`
 * (the column runContinuityCheck has read since Stage 5). GET lists, POST
 * appends (multipart: file), DELETE removes one (?key=<storage key>).
 */
const handlers = makeReferenceHandlers({
  noun: "character",
  prefixFor: (id) => `characters/${id}`,
  cap: CHARACTER_REFERENCE_CAP,
  stage: "character",
  find: (id) => db.character.findUnique({ where: { id } }),
  saveKeys: (id, keys) =>
    db.character.update({
      where: { id },
      data: { referenceImages: JSON.stringify(keys) },
    }),
});

export const GET = handlers.list;
export const POST = handlers.add;
export const DELETE = handlers.remove;
