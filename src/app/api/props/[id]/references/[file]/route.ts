import { makeReferenceHandlers } from "@/lib/tubeforge/reference-routes";
import { db } from "@/lib/tubeforge/tenant-db";
import { WORLD_REFERENCE_CAP } from "@/lib/tubeforge/references";

/** S51 — serve one prop reference PNG (`ref-<n>.png`). */
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

export const GET = handlers.serve;
