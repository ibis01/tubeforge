import { makeReferenceHandlers } from "@/lib/tubeforge/reference-routes";
import { db } from "@/lib/tubeforge/tenant-db";
import { WORLD_REFERENCE_CAP } from "@/lib/tubeforge/references";

/**
 * S51 — location reference photos: the writer for `Location.referenceImages`
 * (dead schema since the Stage 5 migration). Under an approved plan, a scene
 * naming this location seeds its storyboard edit with the newest reference.
 */
const handlers = makeReferenceHandlers({
  noun: "location",
  prefixFor: (id) => `locations/${id}`,
  cap: WORLD_REFERENCE_CAP,
  stage: "world",
  find: (id) => db.location.findUnique({ where: { id } }),
  saveKeys: (id, keys) =>
    db.location.update({
      where: { id },
      data: { referenceImages: JSON.stringify(keys) },
    }),
});

export const GET = handlers.list;
export const POST = handlers.add;
export const DELETE = handlers.remove;
