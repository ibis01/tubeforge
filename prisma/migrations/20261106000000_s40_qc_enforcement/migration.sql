-- S40 — QC enforcement: the human override audit trail on Video.
--
-- The ship gate (qc-policy.ts) blocks export/publish while a blocking QC
-- finding stands. The only way through is a stamped, noted acceptance of
-- EXACTLY one report's findings: qcOverrideForCheckedAt anchors the
-- acceptance to the report's checkedAt, so the next report (re-render or
-- QC re-run) invalidates it automatically. Additive nullable columns —
-- existing rows (no override) are unaffected and gate on their standing
-- report alone.

ALTER TABLE "Video" ADD COLUMN "qcOverrideAt" TIMESTAMP(3);
ALTER TABLE "Video" ADD COLUMN "qcOverrideNote" TEXT;
ALTER TABLE "Video" ADD COLUMN "qcOverrideForCheckedAt" TEXT;
