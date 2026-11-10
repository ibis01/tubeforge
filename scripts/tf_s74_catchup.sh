#!/usr/bin/env bash
# tf_s74_catchup.sh — the S74 catch-up pass: silence, then a rotating canary.
#
# 2026-11-10 receipt: after ~6 video generations the account entered a hard
# throttle window (identical shape to the S63 outage) — patient retries (6/12
# min backoffs) did not penetrate. The S63 discipline: silence is the only
# thing that moves the window; hammering extends it.
#
# PROBE-FIRST (the one gateway-resumption policy, all entry points):
#   - probe GREEN right now → nothing to wait out; the paced lane runs
#     immediately (tf_s74_lane.sh).
#   - probe 429 → 75 min of FULL gateway silence, then per cycle: probe
#     again BEFORE any canary submission (the canary is an expensive i2v
#     call; the probe is a cheap llm call — never spend the canary into a
#     closed window). Max 3 cycles; any profile that still fails is left
#     for the record's resumption protocol.
set -uo pipefail

# Portable repo root — resolved from THIS script's location, never hardcoded.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# All eight, falsification-critical first (the manifest skip makes any
# already-landed profile a cheap no-op).
FAILED=(social explainer islamic-history narrative documentary advertisement podcast animation)

if node --import tsx scripts/gateway-quota-probe.mts > /tmp/s74-probe.log 2>&1; then
  echo "[catchup] probe GREEN — the window is open; running the paced lane now"
  exec bash "$SCRIPT_DIR/tf_s74_lane.sh"
fi
echo "[catchup] probe NOT green ($(tail -1 /tmp/s74-probe.log)) — the silence discipline applies"

echo "[catchup] gateway silence: 75 min ($(date -u +%H:%M:%S) UTC)"
sleep 4500

for cycle in 1 2 3; do
  CANARY="${FAILED[0]}"
  echo ""
  echo "===== [catchup] cycle $cycle — canary: $CANARY ($(date -u +%H:%M:%S) UTC) ====="
  # Probe again before spending the canary — a 429 here rotates to the next
  # silence block instead of burning an i2v submission into a closed window.
  if ! node --import tsx scripts/gateway-quota-probe.mts > /tmp/s74-probe.log 2>&1; then
    echo "[catchup] cycle $cycle probe still throttled ($(tail -1 /tmp/s74-probe.log))"
    FAILED=("${FAILED[@]:1}" "$CANARY")
    if [ "$cycle" -lt 3 ]; then
      echo "[catchup] 45 more min of silence ($(date -u +%H:%M:%S) UTC)"
      sleep 2700
    fi
    continue
  fi
  if node --import tsx scripts/s74-paired-remeasure.mts --profile "$CANARY" --pace-ms=300000; then
    echo "[catchup] canary $CANARY landed — the window is open; running the rest"
    exec bash "$SCRIPT_DIR/tf_s74_lane.sh"
  fi
  # rotate: the failed canary goes to the END of the list
  FAILED=("${FAILED[@]:1}" "$CANARY")
  if [ "$cycle" -lt 3 ]; then
    echo "[catchup] canary failed — 45 more min of silence ($(date -u +%H:%M:%S) UTC)"
    sleep 2700
  fi
done

echo ""
echo "===== [catchup] final status ($(date -u +%H:%M:%S) UTC) ====="
node --import tsx scripts/s74-paired-remeasure.mts --status
echo "[catchup] done — profiles still failing are left for the resumption protocol"
