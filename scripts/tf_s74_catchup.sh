#!/usr/bin/env bash
# tf_s74_catchup.sh — the S74 catch-up pass: silence, then a rotating canary.
#
# 2026-11-10 receipt: after ~6 video generations the account entered a hard
# throttle window (identical shape to the S63 outage) — patient retries (6/12
# min backoffs) did not penetrate. The S63 discipline: silence is the only
# thing that moves the window; hammering extends it. So: 75 min of FULL
# gateway silence, then try ONE profile as the canary. If the canary lands,
# the window is open — run the remaining profiles with 5-min pacing. If not,
# another 45 min of silence and a DIFFERENT canary (max 3 cycles). Any
# profile that still fails is left for the record's resumption protocol.
set -uo pipefail
cd /home/z/my-project

FAILED=(narrative documentary explainer podcast islamic-history)

echo "[catchup] gateway silence: 75 min ($(date -u +%H:%M:%S) UTC)"
sleep 4500

for cycle in 1 2 3; do
  CANARY="${FAILED[0]}"
  echo ""
  echo "===== [catchup] cycle $cycle — canary: $CANARY ($(date -u +%H:%M:%S) UTC) ====="
  if node --import tsx scripts/s74-paired-remeasure.mts --profile "$CANARY" --pace-ms=300000; then
    echo "[catchup] canary $CANARY landed — the window is open; running the rest"
    for p in "${FAILED[@]:1}"; do
      echo ""
      echo "===== [catchup] profile: $p ====="
      if node --import tsx scripts/s74-paired-remeasure.mts --profile "$p" --pace-ms=300000; then
        echo "[catchup] $p OK"
      else
        echo "[catchup] $p FAILED — leaving it for the resumption protocol"
      fi
      echo "[catchup] pacing 180s…"
      sleep 180
    done
    break
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
echo "[catchup] done"
