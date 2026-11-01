-- Stage 5 (module A) — research-with-sources.
--
-- Video.researchSources: JSON array of ResearchSource { url, name, host },
-- captured from the research idea the video was greenlit from (or attached
-- at create time). The Script tab links out to these — the fact-check
-- surface the Stage 4b Script tab deferred ("needs research-with-sources,
-- Stage 5+ server work"). Plain TEXT like every other JSON column.

ALTER TABLE "Video" ADD COLUMN "researchSources" TEXT;
