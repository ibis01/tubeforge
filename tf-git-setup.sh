#!/usr/bin/env bash
# tf-git-setup.sh — prepare ~/tubeforge for GitHub and make the first push.
#
# Safe to re-run. What it does:
#   1. Fixes .gitignore footguns + appends a hygiene block
#      (secrets, SQLite db, renders, archives, IDE files excluded)
#   2. Creates .env.example (placeholders only) if missing
#   3. git init (branch: main) + commit
#      → HARD-REFUSES if .env*, *.db, *.sqlite*, *.tar ever get staged
#      → HARD-REFUSES if any staged file is larger than 5 MB
#   4. Pushes with the GitHub CLI if you are logged in,
#      otherwise prints the exact manual steps.
#
# Usage:  bash tf-git-setup.sh [repo-name]        (default repo name: tubeforge)
set -euo pipefail

command -v git >/dev/null 2>&1 || { echo "!! git is not installed (sudo apt install git)"; exit 1; }
DIR="${TUBEFORGE_DIR:-$HOME/tubeforge}"
REPO="${1:-tubeforge}"
cd "$DIR" 2>/dev/null || { echo "!! $DIR not found"; exit 1; }

echo "== TubeForge -> GitHub =="

# ---------- 1. .gitignore ----------
[ -f .gitignore ] || touch .gitignore
# footguns: bare 'test'/'prompt' patterns ignore ANY file with those names, anywhere
sed -i '/^test$/d; /^prompt$/d' .gitignore
# ignore db/uploads contents but keep the placeholder dirs in git
sed -i 's#^/db/$#/db/*\n!/db/.gitkeep#' .gitignore
sed -i 's#^/uploads/$#/uploads/*\n!/uploads/.gitkeep#' .gitignore
if ! grep -q '# --- tf-git-setup ---' .gitignore 2>/dev/null; then
  cat >> .gitignore <<'EOF'
# --- tf-git-setup ---
# keep the env template, never the real thing (the .env* rule above hides it)
!.env.example
# sqlite / archives
*.sqlite
*.sqlite3
*.tar
# local-only dirs
/upload/
/forensics/
# packaging artifacts
public/tubeforge-local.zip
public/tubeforge/
# editor / OS
.vscode/
.idea/
Thumbs.db
EOF
  echo "  [ok] .gitignore hardened"
fi
mkdir -p db uploads
touch db/.gitkeep uploads/.gitkeep

# ---------- 2. .env.example ----------
if [ ! -f .env.example ]; then
  cat > .env.example <<'EOF'
# TubeForge environment template — copy to .env and fill in your own values.
# Your real .env is gitignored and will never be pushed.

# SQLite database (created on first `prisma db push`)
DATABASE_URL=file:./db/custom.db

# Secret that signs auth tokens for the optional studio lock screen.
# Generate your own:  openssl rand -hex 32
TUBEFORGE_AUTH_SECRET=replace-with-openssl-rand-hex-32
EOF
  echo "  [ok] .env.example created"
fi

# ---------- 3. init / stage / gate / commit ----------
git config user.name  >/dev/null 2>&1 || git config user.name  "$(whoami)"
git config user.email >/dev/null 2>&1 || git config user.email "$(whoami)@users.noreply.github.com"

if [ ! -d .git ]; then
  git init -b main >/dev/null 2>&1 || git init >/dev/null
  echo "  [ok] git repository initialized"
fi

# re-run safety: drop known secrets/workspace dirs from the index if tracked before
for p in .env .env.local db uploads upload forensics download tool-results skills backups pack public/tubeforge-local.zip public/tubeforge; do
  git rm -r -q --cached "$p" >/dev/null 2>&1 || true
done

git add -A

# secret gate — refuse to commit anything that smells like a credential or archive
BAD=$(git diff --cached --name-only --diff-filter=ACMR \
      | grep -Ei '(^|/)\.env|(^|/)\.z-ai-config$|\.db(-journal)?$|\.sqlite?[0-9]*$|\.tar$' \
      | grep -vE '(^|/)\.env\.example$' || true)
if [ -n "$BAD" ]; then
  echo "!! REFUSING — potential secrets staged:"
  echo "$BAD"
  echo "   Add them to .gitignore, then re-run this script."
  exit 1
fi

# size gate — no accidental media/packages in the first commit
BIG=""
while IFS= read -r -d '' f; do
  [ -f "$f" ] || continue
  sz=$(stat -c%s "$f" 2>/dev/null || echo 0)
  [ "$sz" -gt 5242880 ] && BIG="${BIG}  ${f}  ($((sz/1024/1024)) MB)"$'\n'
done < <(git diff --cached --name-only --diff-filter=ACMR -z)
if [ -n "$BIG" ]; then
  echo "!! REFUSING — staged files larger than 5 MB:"
  printf '%s' "$BIG"
  exit 1
fi

if git diff --cached --quiet; then
  echo "  [ok] nothing new to commit"
else
  git commit -q -m "TubeForge: initial import (app source, pipeline libs, prisma schema, dev scripts)"
  echo "  [ok] commit $(git rev-parse --short HEAD) — $(git ls-files | wc -l) files tracked"
fi
git branch -M main 2>/dev/null || true

# ---------- 4. push ----------
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  echo "  -> GitHub CLI found — creating private repo '$REPO' and pushing..."
  if git remote get-url origin >/dev/null 2>&1; then
    git push -u origin main
  else
    gh repo create "$REPO" --private --source=. --remote=origin --push
  fi
  echo "[done] pushed — $(gh repo view --json url -q .url 2>/dev/null || echo 'check github.com')"
  echo "        want it public?  gh repo edit --visibility public"
else
  cat <<EOF
  [ok] local repo ready on branch 'main'. Final manual steps:

  1. Create an EMPTY repo at https://github.com/new
     name: $REPO   |   visibility: Private   |   add NO readme/license/gitignore
  2. Connect and push:
       git remote add origin https://github.com/<YOUR-USERNAME>/$REPO.git
       git push -u origin main
  3. When GitHub asks for a password, paste a Personal Access Token
     (github.com -> Settings -> Developer settings -> Personal access tokens).
     Account passwords no longer work for git push.
     Easier alternative:  sudo apt install gh && gh auth login   (then re-run this)

After the first push, future updates are just:
  git add -A && git commit -m "..." && git push
EOF
fi
