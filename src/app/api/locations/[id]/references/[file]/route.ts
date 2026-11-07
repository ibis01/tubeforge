import { makeReferenceHandlers } from "@/lib/tubeforge/reference-routes";
import { db } from "@/lib/tubeforge/tenant-db";
import { WORLD_REFERENCE_CAP } from "@/lib/tubeforge/references";

/** S51 — serve one location reference PNG (`ref-<n>.png`). */
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

export const GET = handlers.serve;
