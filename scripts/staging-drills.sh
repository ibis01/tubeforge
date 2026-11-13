#!/usr/bin/env bash
# S110 — the staging drill orchestrator (runbook: docs/runbooks/staging.md §4).
#
# Runs everything that can be automated against a live staging deployment,
# then prints the exact operator-step drills (worker recovery, YouTube
# smoke, Stripe webhook trigger, backup/restore) with their commands.
#
# Usage:
#   STAGING_URL=https://tubeforge-staging.fly.dev bash scripts/staging-drills.sh
#   STAGING_URL=… bash scripts/staging-drills.sh --suite pipeline   # one suite
#   STAGING_URL=… bash scripts/staging-drills.sh --skip-load        # no k6
#
# Exit code = the drill harness's exit code (0 = no FAILs; SKIPs allowed).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

URL="${STAGING_URL:-https://tubeforge-staging.fly.dev}"
APP="${TUBEFORGE_STAGING_APP:-tubeforge-staging}"

DRILL_ARGS=(--url "$URL")
if [ "${1:-}" = "--suite" ] && [ -n "${2:-}" ]; then
  DRILL_ARGS+=(--suite "$2")
fi

echo "== staging drills — $URL =="
echo

# --- 1. the harness suites (health · billing · pipeline) ---------------------

node --import tsx scripts/staging-drill.mts "${DRILL_ARGS[@]}"
DRILL_EXIT=$?

# --- 2. the k6 load run (scripts/load-test.js — the register/login/create ----
#        hot paths under 20 VUs; skips with a note when k6 is absent)
if [ "${SKIP_LOAD:-}" != "1" ] && [ "${1:-}" != "--skip-load" ]; then
  echo
  if command -v k6 >/dev/null 2>&1; then
    echo "== k6 load run (20 VUs, ~2 min) =="
    k6 run -e BASE_URL="$URL" scripts/load-test.js || DRILL_EXIT=1
  else
    echo "[SKIP] k6 not installed — the load drill is the §4.2 step (https://k6.io/docs/get-started/installation/)"
  fi
fi

# --- 3. the operator-step drills (printed with exact commands) ---------------

cat <<EOF

== operator-step drills (runbook §4 has the full sequences) ==

worker recovery (§4.4 — proves the S100 lease/reaper law on the real platform):
  1. start a pipeline render:  node --import tsx scripts/staging-drill.mts --url $URL --suite pipeline
  2. mid-render, restart the worker process group:
       fly machines restart --app $APP --process-group worker
  3. the render must still land (hasVideo + final.mp4) — the reaper bumps
     the fencing token and a fresh worker reclaims the lease.

YouTube test-channel smoke (§4.5):
  sign in → Settings → YouTube → connect the TEST channel → publish one
  drill video → verify it lands as unlisted on the test channel.

Stripe webhook rehearsal (§4.3, needs the Stripe CLI):
  stripe listen --forward-to $URL/api/billing/webhook
  stripe trigger checkout.session.completed
  → the billing plan on the drill user's account must upgrade.

backup/restore (§4.6 — the Postgres edition of the CI drill):
  TUBEFORGE_DB_URL=<the Neon branch URL> npm run db:backup:pg
  → restore the dump into a scratch Neon branch, verify row counts.
EOF

echo
echo "== drills complete — exit $DRILL_EXIT (0 = no FAILs) =="
exit "$DRILL_EXIT"
