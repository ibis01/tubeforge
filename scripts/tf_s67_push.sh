#!/usr/bin/env bash
# tf_s67_push.sh — one-shot S67 landing gate: push main (2 commits: the
# whiteboard reconciliation + the queue-suite kind pin) to origin and verify.
# The token is used inline only — never written to disk, never echoed, and
# dropped from the environment when the script exits.
#
# Usage:  TF_TOKEN=<workflow-scoped-PAT> bash scripts/tf_s67_push.sh
set -uo pipefail
cd /home/z/my-project

REPO="ibis01/tubeforge"
EXPECTED_REMOTE="7644690f39527c07fcc251a9f3234d04294e7f19"   # s67 feat+fix head
TIP="$(git rev-parse main)"

[ -n "${TF_TOKEN:-}" ] || { echo "!! TF_TOKEN not set — nothing to do"; exit 1; }
AUTH="https://${TF_TOKEN}@github.com/${REPO}.git"
trap 'unset TF_TOKEN' EXIT

echo "[1/4] preflight"
echo "      local tip  = $TIP"
echo "      outgoing   = $(git rev-list --count origin/main..main) commits (origin/main..main)"
REMOTE_SHA="$(git ls-remote "$AUTH" refs/heads/main | awk '{print $1}')"
echo "      remote main = ${REMOTE_SHA:-UNREACHABLE}"
[ "$REMOTE_SHA" = "$EXPECTED_REMOTE" ] || { echo "!! remote moved (expected ${EXPECTED_REMOTE:0:7}) — re-fetch and re-merge first"; exit 1; }

echo "[2/4] secret gate on the OUTGOING history"
if git log origin/main..main -p --no-color \
   | grep -qE "ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY|xox[baprs]-[0-9A-Za-z]{20}|sk_live_[A-Za-z0-9]{20,}"; then
  echo "!! token/key pattern in outgoing history — NOT pushing"; exit 1
fi
if git log origin/main..main -p --no-color -- .env .z-ai-config .env.local | grep -q .; then
  echo "!! outgoing history touches .env-class files — NOT pushing"; exit 1
fi
echo "      clean (0 token patterns, no .env blobs in any outgoing tree)"

echo "[3/4] push main:main"
git push "$AUTH" main:main || { echo "!! push rejected"; exit 1; }

echo "[4/4] verify"
FINAL="$(git ls-remote "$AUTH" refs/heads/main | awk '{print $1}')"
[ "$FINAL" = "$TIP" ] || { echo "!! remote main = $FINAL (expected $TIP)"; exit 1; }
echo "OK — origin/main = $FINAL"
echo "next: TF_TOKEN=<same pat> bash scripts/tf_s66_ci_watch.sh   (CI on $FINAL)"
