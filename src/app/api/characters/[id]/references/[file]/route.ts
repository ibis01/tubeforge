import { makeReferenceHandlers } from "@/lib/tubeforge/reference-routes";
import { db } from "@/lib/tubeforge/tenant-db";
import { CHARACTER_REFERENCE_CAP } from "@/lib/tubeforge/references";

/** S51 — serve one cast reference PNG (`ref-<n>.png`). */
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

export const GET = handlers.serve;
