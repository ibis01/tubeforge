import { makeReferenceHandlers } from "@/lib/tubeforge/reference-routes";
import { db } from "@/lib/tubeforge/tenant-db";
import { WORLD_REFERENCE_CAP } from "@/lib/tubeforge/references";

/**
 * S51 — prop reference photos: the writer for `Prop.referenceImages`. Props
 * ride the storyboard PROMPT clause (they are held/worn set dressing, not
 * the set), so these references serve the human's library + future VLM
 * passes rather than the edit seed.
 */
const handlers = makeReferenceHandlers({
  noun: "prop",
  prefixFor: (id) => `props/${id}`,
  cap: WORLD_REFERENCE_CAP,
  stage: "world",
  find: (id) => db.prop.findUnique({ where: { id } }),
  saveKeys: (id, keys) =>
    db.prop.update({
      where: { id },
      data: { referenceImages: JSON.stringify(keys) },
    }),
});

export const GET = handlers.list;
export const POST = handlers.add;
export const DELETE = handlers.remove;
