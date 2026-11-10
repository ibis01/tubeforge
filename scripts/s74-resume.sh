#!/usr/bin/env bash
# s74-resume.sh — self-contained S74 lane resume (the S63 resumption
# discipline, adapted to the paired design). Idempotent: safe to run at any
# time; it probes first, touches the gateway ONLY when green, and reports
# exactly where the lane stands.
#
#   bash scripts/s74-resume.sh
set -u

# Portable repo root — resolved from THIS script's location, never hardcoded.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

echo "=== s74-resume $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="

# A run lock: never two lanes writing validation/s74/manifest.json.
LOCK=/tmp/s74-lane.lock
if [ -e "$LOCK" ]; then
  PID=$(cat "$LOCK" 2>/dev/null || echo "")
  if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
    echo "lane already running (pid $PID) — nothing to do"
    exit 0
  fi
  rm -f "$LOCK"
fi

# 1. one-probe discipline: a green chat probe is the gate for ALL gateway work.
if node --import tsx scripts/gateway-quota-probe.mts > /tmp/s74-probe.log 2>&1; then
  echo "probe: GREEN ($(tail -1 /tmp/s74-probe.log))"
else
  echo "probe: NOT green — gateway still throttled ($(tail -1 /tmp/s74-probe.log))"
  echo "      do nothing, retry later (probing does not extend or clear the window)"
  exit 3
fi

# 2. resume the paired re-measure through the PACED supervisor (the one
#    gateway-resumption policy: probe-gated, --pace-ms between submissions;
#    the supervisor re-probes — harmless — and skips healthy profiles)
echo "$$" > "$LOCK"
trap 'rm -f "$LOCK"' EXIT
bash "$SCRIPT_DIR/tf_s74_lane.sh" >> /tmp/s74-lane.log 2>&1
RC=$?
if [ $RC -ne 0 ]; then
  echo "lane exited $RC — see /tmp/s74-lane.log"
  tail -5 /tmp/s74-lane.log
  exit $RC
fi

# 3. all 8 pairs landed → the blind scoring pass (16 vision calls)
node --import tsx scripts/s74-blind-score.mts >> /tmp/s74-blind.log 2>&1
RC=$?
if [ $RC -ne 0 ]; then
  echo "blind scoring exited $RC — see /tmp/s74-blind.log"
  tail -5 /tmp/s74-blind.log
  exit $RC
fi

# 4. report
echo "=== lane COMPLETE — status + scores ==="
node --import tsx scripts/s74-paired-remeasure.mts --status
tail -30 /tmp/s74-blind.log
