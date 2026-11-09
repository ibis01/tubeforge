#!/usr/bin/env bash
# tf_s66_ci_watch.sh — watch the GitHub Actions run(s) on the pushed head
# SHA until they complete (the s58 discipline). The token lifts the API
# rate limit; it is read from the environment only and never stored.
#
# Usage:  TF_TOKEN=<same pat> bash scripts/tf_s66_ci_watch.sh [sha]
set -uo pipefail
cd /home/z/my-project

REPO="ibis01/tubeforge"
SHA="${1:-$(git rev-parse main)}"
[ -n "${TF_TOKEN:-}" ] || { echo "!! TF_TOKEN not set"; exit 3; }

echo "watching CI on $SHA (timeout 20 min)…"
TF_PAT="$TF_TOKEN" exec node scripts/tf-ci-poll.mjs "$REPO" "$SHA" 1200
