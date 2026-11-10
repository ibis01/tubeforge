#!/usr/bin/env bash
# tf-push.sh — the REUSABLE, credential-safe landing gate (successor to the
# one-shot tf_s66/s67/s73_push.sh family).
#
# Credential handling (the 2026-11-10 review fix — execution-time safety,
# beyond what gitleaks can see):
#   - The PAT lives ONLY in the TF_TOKEN environment variable. It is NEVER
#     embedded in a URL, NEVER passed as a process argument (process args
#     are world-readable via /proc on shared systems and land in shell
#     history and tool logs), and NEVER written to disk.
#   - Git authentication rides a one-shot GIT_ASKPASS helper: a 0600 temp
#     file whose body contains NO secret — it only reads TF_TOKEN from the
#     inherited environment when git asks for a password. Git commands all
#     use the plain https://github.com/<repo>.git URL.
#   - GIT_TERMINAL_PROMPT=0: if the askpass path fails, git errors out
#     instead of hanging on a hidden prompt.
#   - The helper file is removed and TF_TOKEN unset on exit (trap).
#   - If the machine has a real credential helper configured (gh auth,
#     manager-core), git consults it FIRST — the PAT is then not needed
#     at all, which is the preferred production posture.
#
# Usage:
#   TF_TOKEN=<workflow-scoped-PAT> bash scripts/tf-push.sh [expected-remote-sha]
#
# The optional argument is the drift guard: the SHA origin/main must be at
# BEFORE the push (the one-shot gates pinned this; a reusable gate can
# capture it live when omitted — the guard then covers the script's own
# lifetime).
set -uo pipefail

# Portable repo root — resolved from THIS script's location, never hardcoded.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

REPO="ibis01/tubeforge"
PLAIN_URL="https://github.com/${REPO}.git"
TIP="$(git rev-parse main)"
BRANCH="main"

[ -n "${TF_TOKEN:-}" ] || { echo "!! TF_TOKEN not set — nothing to do"; exit 1; }

# ---- one-shot askpass helper (no secret in the file, no secret in args) ----
ASKPASS="$(mktemp)"
cat > "$ASKPASS" <<'HELPER'
#!/bin/sh
# Reads TF_TOKEN from the inherited environment. Prompt string arrives as $1.
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
if [ -n "${1:-}" ]; then
  [ "$REMOTE_SHA" = "$1" ] || { echo "!! remote moved (expected ${1:0:7}) — re-fetch and re-merge first"; exit 1; }
fi
# No arg → the drift guard is git's own push safety (a non-fast-forward
# push is rejected server-side); the live remote SHA above is still
# reported for the operator to eyeball.

echo "[2/4] secret gate on the OUTGOING history"
if git log origin/main..main -p --no-color \
   | grep -qE "ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|EC|OPENSSH) PRIVATE KEY|xox[baprs]-[0-9A-Za-z]{20}|sk_live_[A-Za-z0-9]{20,}"; then
  echo "!! token/key pattern in outgoing history — NOT pushing"; exit 1
fi
if git log origin/main..main -p --no-color -- .env .z-ai-config .env.local | grep -q .; then
  echo "!! outgoing history touches .env-class files — NOT pushing"; exit 1
fi
echo "      clean (0 token patterns, no .env blobs in any outgoing tree)"

echo "[3/4] push ${BRANCH}:${BRANCH} (credential-safe askpass — plain URL, no token in args)"
git push "$PLAIN_URL" "${BRANCH}:${BRANCH}" || { echo "!! push rejected"; exit 1; }

echo "[4/4] verify"
FINAL="$(git ls-remote "$PLAIN_URL" refs/heads/main 2>/dev/null | awk '{print $1}')"
[ "$FINAL" = "$TIP" ] || { echo "!! remote main = $FINAL (expected $TIP)"; exit 1; }
echo "OK — origin/${BRANCH} = $FINAL"
echo "next: TF_TOKEN=<same pat> bash scripts/tf_s66_ci_watch.sh $FINAL   (CI on $FINAL)"
