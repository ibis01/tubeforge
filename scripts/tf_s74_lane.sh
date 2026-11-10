#!/usr/bin/env bash
# tf_s74_lane.sh — paced supervisor for the S74 paired re-measure.
#
# The 2026-11-10 lane receipt: back-to-back i2v submissions 429 (the pilot's
# naturally-spaced pair went through clean), and short-backoff retries dig
# the hole deeper. This supervisor runs each profile as its own invocation
# (--pace-ms=150000 spaces every video submission), UNTRIED profiles first
# and the throttle-burned retries last (their windows get an hour+ to clear).
# Idempotent: healthy profiles are skipped by the manifest check (the
# gitignored artifacts were lost to the 2026-11-10 sandbox rebuild, so all
# eight pairs re-run from zero — social leads: falsification-critical, and
# the one profile whose pair was observed landing clean under pacing).
#
# PROBE-FIRST (the one gateway-resumption policy, all entry points): the
# cheap llm probe gates every gateway-touching entry. A 429 window is
# waited out (tf_s74_catchup.sh) or left to the next resume (s74-resume.sh)
# — never hammered.
set -uo pipefail

# Portable repo root — resolved from THIS script's location, never hardcoded.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if ! node --import tsx scripts/gateway-quota-probe.mts > /tmp/s74-probe.log 2>&1; then
  echo "[supervisor] probe NOT green ($(tail -1 /tmp/s74-probe.log))"
  echo "[supervisor] the window is closed — no i2v submissions into a throttle."
  echo "[supervisor] use scripts/tf_s74_catchup.sh (silence + canary) or wait and re-run."
  exit 3
fi
echo "[supervisor] probe GREEN — opening the lane"

ORDER=(social explainer islamic-history advertisement animation podcast narrative documentary)
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
