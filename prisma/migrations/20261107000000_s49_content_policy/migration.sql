-- S49 — Islamic visual protection: the ONE content-policy column both S48+S49
-- needed (the joint schema design, docs/design/s48-s49-schema.md §1).
-- null/absent = "standard" (today's behavior); "islamic-history" activates the
-- layered restricted-subject enforcement (script compose rules, director
-- overlay + plan sanitization, image-prompt substitution + negative clause,
-- restricted-visual QC gate).
ALTER TABLE "Video" ADD COLUMN "contentPolicy" TEXT;
