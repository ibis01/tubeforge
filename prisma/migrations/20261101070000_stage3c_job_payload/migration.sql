-- Stage 3 close-out — durable job payload.
--
-- Adds Job.payload (TEXT, JSON-encoded request options). Write-once at
-- enqueue time by startJob(); parsed by the kind's crash-recovery handler
-- so a restarted process re-runs the job with the caller's original choices
-- (render mode, scene instruction, voiceover source pointer, …) instead of
-- factory defaults. Plain TEXT instead of JSONB so the SQLite mirror and
-- Postgres behave identically (no filtering is ever done on this column).

ALTER TABLE "Job" ADD COLUMN "payload" TEXT;
