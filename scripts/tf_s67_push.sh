#!/usr/bin/env bash
# tf_s67_push.sh — one-shot S67 landing gate: push main (2 commits: the
# whiteboard reconciliation + the queue-suite kind pin) to origin and verify.
# CREDENTIAL-SAFE (the 2026-11-10 review fix, the pattern scripts/tf-push.sh
# documents in full): the PAT lives only in the TF_TOKEN environment
# variable; git auth rides a one-shot GIT_ASKPASS helper whose body contains
# no secret; every git command uses the plain https URL — the token never
# appears in a process argument, a URL, or on disk.
#
# Usage:  TF_TOKEN=<workflow-scoped-PAT> bash scripts/tf_s67_push.sh
set -uo pipefail

# Portable repo root — resolved from THIS script's location, never hardcoded.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

REPO="ibis01/tubeforge"
PLAIN_URL="https://github.com/${REPO}.git"
EXPECTED_REMOTE="7644690f39527c07fcc251a9f3234d04294e7f19"   # s67 feat+fix head
TIP="$(git rev-parse main)"

[ -n "${TF_TOKEN:-}" ] || { echo "!! TF_TOKEN not set — nothing to do"; exit 1; }
ASKPASS="$(mktemp)"
cat > "$ASKPASS" <<'HELPER'
#!/bin/sh
case "$1" in
  Username*) printf '%s\n' "${TF_PUSH_USER:-x-access-token}" ;;
  *)         printf '%s\n' "${TF_TOKEN:?askpass invoked without TF_TOKEN}" ;;
esac
HELPER
chmod 700 "$ASKPASS"
trap 'rm -f "$ASKPASS"; unset TF_TOKEN' EXIT
export GIT_ASKPASS="$ASKPASS"
export GIT_TERMINAL_PROMPT=0

echo "[1/4] preflight"
echo "      local tip  = $TIP"
echo "      outgoing   = $(git rev-list --count origin/main..main) commits (origin/main..main)"
REMOTE_SHA="$(git ls-remote "$PLAIN_URL" refs/heads/main 2>/dev/null | awk '{print $1}')"
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

echo "[3/4] push main:main (credential-safe askpass — plain URL)"
git push "$PLAIN_URL" main:main || { echo "!! push rejected"; exit 1; }

echo "[4/4] verify"
FINAL="$(git ls-remote "$PLAIN_URL" refs/heads/main 2>/dev/null | awk '{print $1}')"
[ "$FINAL" = "$TIP" ] || { echo "!! remote main = $FINAL (expected $TIP)"; exit 1; }
echo "OK — origin/main = $FINAL"
echo "next: TF_TOKEN=<same pat> bash scripts/tf_s66_ci_watch.sh   (CI on $FINAL)"
