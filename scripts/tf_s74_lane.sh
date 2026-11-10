#!/usr/bin/env bash
# tf_s74_lane.sh — paced supervisor for the S74 paired re-measure.
#
# The 2026-11-10 lane receipt: back-to-back i2v submissions 429 (the pilot's
# naturally-spaced pair went through clean), and short-backoff retries dig
# the hole deeper. This supervisor runs each profile as its own invocation
# (--pace-ms=150000 spaces every video submission), UNTRIED profiles first
# and the throttle-burned retries last (their windows get an hour+ to clear).
# Idempotent: healthy profiles are skipped by the manifest check.
set -uo pipefail
cd /home/z/my-project

ORDER=(advertisement animation podcast islamic-history narrative documentary explainer)
for p in "${ORDER[@]}"; do
  echo ""
  echo "===== [supervisor] profile: $p ====="
  if node --import tsx scripts/s74-paired-remeasure.mts --profile "$p" --pace-ms=150000; then
    echo "[supervisor] $p OK"
  else
    echo "[supervisor] $p FAILED — moving on (rerun this profile later)"
  fi
  echo "[supervisor] pacing 120s before the next profile…"
  sleep 120
done

echo ""
echo "===== [supervisor] final status ====="
node --import tsx scripts/s74-paired-remeasure.mts --status
echo "[supervisor] lane complete"
