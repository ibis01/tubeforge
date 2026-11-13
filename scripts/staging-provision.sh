#!/usr/bin/env bash
# S110 — the staging provisioner: DEPLOYMENT §3 made executable.
#
# One command, once the operator's accounts exist (runbook:
# docs/runbooks/staging.md §1-2). What it does, in order:
#   0. sources .env.staging (gitignored) if present, then preflights:
#      flyctl installed + authenticated, every required variable in hand.
#   1. generates FRESH TUBEFORGE_AUTH_SECRET / TUBEFORGE_ENCRYPTION_KEY
#      (staging never shares production secrets — the §3 law).
#   2. registers the app if it does not exist (fly launch --no-deploy
#      --copy-config), then sets every secret on it.
#   3. deploys with fly.staging.toml (same topology as production).
#   4. polls /api/auth/status until the deployment answers 200.
#   5. prints the remaining manual steps (Stripe webhook registration,
#      provider key for the pipeline drill) and the drill command.
#
# Usage:
#   bash scripts/staging-provision.sh             # provision + deploy + verify
#   bash scripts/staging-provision.sh --dry-run   # print the plan, execute nothing
#
# Required inputs (environment or .env.staging):
#   TUBEFORGE_STAGING_DB_URL                  Neon BRANCH connection string
#   TUBEFORGE_STAGING_S3_ENDPOINT             https://<account>.r2.cloudflarestorage.com
#   TUBEFORGE_STAGING_S3_BUCKET               the staging bucket
#   TUBEFORGE_STAGING_S3_ACCESS_KEY_ID        R2 S3 API token
#   TUBEFORGE_STAGING_S3_SECRET_ACCESS_KEY    R2 S3 API token
#   TUBEFORGE_STAGING_STRIPE_SECRET_KEY       TEST mode (sk_test_...)
#   TUBEFORGE_STAGING_STRIPE_PRICE_CREATOR    test-mode price id
#   TUBEFORGE_STAGING_STRIPE_PRICE_STUDIO     test-mode price id
# Optional:
#   TUBEFORGE_STAGING_YT_CLIENT_ID/_SECRET    YouTube test OAuth client
#   TUBEFORGE_STAGING_ZAI_KEY                 provider key for the pipeline drill
#   TUBEFORGE_STAGING_APP (default tubeforge-staging)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DRY_RUN=0
[ "${1:-}" = "--dry-run" ] && DRY_RUN=1

APP="${TUBEFORGE_STAGING_APP:-tubeforge-staging}"
URL="https://${APP}.fly.dev"

# --- 0. inputs --------------------------------------------------------------

if [ -f .env.staging ]; then
  # shellcheck disable=SC1091
  set -a; . ./.env.staging; set +a
fi

REQUIRED=(
  TUBEFORGE_STAGING_DB_URL
  TUBEFORGE_STAGING_S3_ENDPOINT
  TUBEFORGE_STAGING_S3_BUCKET
  TUBEFORGE_STAGING_S3_ACCESS_KEY_ID
  TUBEFORGE_STAGING_S3_SECRET_ACCESS_KEY
  TUBEFORGE_STAGING_STRIPE_SECRET_KEY
  TUBEFORGE_STAGING_STRIPE_PRICE_CREATOR
  TUBEFORGE_STAGING_STRIPE_PRICE_STUDIO
)
MISSING=0
for v in "${REQUIRED[@]}"; do
  if [ -z "${!v:-}" ]; then
    echo "[provision] MISSING: $v (set it in the environment or .env.staging — template: .env.staging.example)" >&2
    MISSING=1
  fi
done
[ "$MISSING" = 1 ] && exit 1

if [ "$DRY_RUN" = 0 ]; then
  command -v fly >/dev/null 2>&1 || { echo "[provision] flyctl is required (https://fly.io/docs/flyctl/install/)" >&2; exit 1; }
  fly auth whoami >/dev/null 2>&1 || { echo "[provision] not authenticated — run: fly auth login" >&2; exit 1; }
fi

run() {
  if [ "$DRY_RUN" = 1 ]; then
    echo "[dry-run] $*"
  else
    echo "[provision] $*"
    "$@"
  fi
}

# --- 1. fresh secrets (staging NEVER shares production secrets) -------------

AUTH_SECRET="$(openssl rand -hex 32)"
ENCRYPTION_KEY="$(openssl rand -hex 32)"

# --- 2. the app --------------------------------------------------------------

if [ "$DRY_RUN" = 0 ]; then
  if fly status -a "$APP" >/dev/null 2>&1; then
    echo "[provision] app $APP already exists — updating secrets + redeploying"
  else
    run fly launch --no-deploy --copy-config --name "$APP"
  fi
else
  echo "[dry-run] fly status -a $APP   (exists? else launch)"
fi

# --- 3. secrets + deploy -----------------------------------------------------

# Optional secrets ride along only when set (fly rejects empty values; the
# webhook secret arrives AFTER the endpoint is registered — see step 5).
OPT_SECRETS=()
[ -n "${TUBEFORGE_STAGING_STRIPE_WEBHOOK_SECRET:-}" ] &&
  OPT_SECRETS+=("TUBEFORGE_STRIPE_WEBHOOK_SECRET=$TUBEFORGE_STAGING_STRIPE_WEBHOOK_SECRET")
[ -n "${TUBEFORGE_STAGING_YT_CLIENT_ID:-}" ] &&
  OPT_SECRETS+=("TUBEFORGE_YT_CLIENT_ID=$TUBEFORGE_STAGING_YT_CLIENT_ID")
[ -n "${TUBEFORGE_STAGING_YT_CLIENT_SECRET:-}" ] &&
  OPT_SECRETS+=("TUBEFORGE_YT_CLIENT_SECRET=$TUBEFORGE_STAGING_YT_CLIENT_SECRET")
[ -n "${TUBEFORGE_STAGING_ZAI_KEY:-}" ] &&
  OPT_SECRETS+=("TUBEFORGE_ZAI_API_KEY=$TUBEFORGE_STAGING_ZAI_KEY")

run fly secrets set -a "$APP" \
  DATABASE_URL="$TUBEFORGE_STAGING_DB_URL" \
  TUBEFORGE_AUTH_SECRET="$AUTH_SECRET" \
  TUBEFORGE_ENCRYPTION_KEY="$ENCRYPTION_KEY" \
  TUBEFORGE_STORAGE_DRIVER=s3 \
  TUBEFORGE_S3_ENDPOINT="$TUBEFORGE_STAGING_S3_ENDPOINT" \
  TUBEFORGE_S3_BUCKET="$TUBEFORGE_STAGING_S3_BUCKET" \
  TUBEFORGE_S3_ACCESS_KEY_ID="$TUBEFORGE_STAGING_S3_ACCESS_KEY_ID" \
  TUBEFORGE_S3_SECRET_ACCESS_KEY="$TUBEFORGE_STAGING_S3_SECRET_ACCESS_KEY" \
  TUBEFORGE_S3_REGION=auto \
  TUBEFORGE_STRIPE_SECRET_KEY="$TUBEFORGE_STAGING_STRIPE_SECRET_KEY" \
  TUBEFORGE_STRIPE_PRICE_CREATOR="$TUBEFORGE_STAGING_STRIPE_PRICE_CREATOR" \
  TUBEFORGE_STRIPE_PRICE_STUDIO="$TUBEFORGE_STAGING_STRIPE_PRICE_STUDIO" \
  ${OPT_SECRETS:+${OPT_SECRETS[*]}}

run fly deploy -a "$APP" --config fly.staging.toml

# --- 4. health ---------------------------------------------------------------

if [ "$DRY_RUN" = 0 ]; then
  echo "[provision] polling $URL/api/auth/status …"
  DEADLINE=$((SECONDS + 300))
  while [ $SECONDS -lt $DEADLINE ]; do
    if curl -fsS "$URL/api/auth/status" >/dev/null 2>&1; then
      echo "[provision] HEALTHY: $URL/api/auth/status → 200"
      break
    fi
    sleep 10
  done
  if [ $SECONDS -ge $DEADLINE ]; then
    echo "[provision] ERROR: $URL never went healthy within 5 min — inspect: fly logs -a $APP" >&2
    exit 1
  fi
else
  echo "[dry-run] poll $URL/api/auth/status until 200 (5 min budget)"
fi

# --- 5. the manual steps the script cannot do --------------------------------

cat <<EOF

[provision] staging is up: $URL

Manual steps that finish the wiring (runbook §3):
  1. Stripe test-mode webhook → register an endpoint for
       $URL/api/billing/webhook
     in the Stripe dashboard (test mode), then put its signing secret in
     .env.staging as TUBEFORGE_STAGING_STRIPE_WEBHOOK_SECRET and re-run
     this script (secrets-only pass) or:
       fly secrets set -a $APP TUBEFORGE_STRIPE_WEBHOOK_SECRET=whsec_...
  2. Provider key for the pipeline drill (one Z.ai key is enough):
     sign in at $URL → Settings → AI Providers → paste + Test.
  3. Then run the drills:
       STAGING_URL=$URL bash scripts/staging-drills.sh

Reset to a clean slate any time (runbook §5):
  fly secrets set -a $APP TUBEFORGE_AUTH_SECRET="\$(openssl rand -hex 32)" \\
    TUBEFORGE_ENCRYPTION_KEY="\$(openssl rand -hex 32)"  # + a fresh Neon branch
EOF
